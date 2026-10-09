-- ============================================================================
-- Identity (SIWE wallet challenges), historical NFT snapshot claims, burns, and verified X shares.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Wallet ownership challenges (EIP-4361 / SIWE): domain, URI and chain bound, expiring, consume-once.
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_challenges (
  nonce text primary key check (nonce ~ '^[A-Za-z0-9]{16,64}$'),
  user_id uuid not null,
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  chain_id int not null,
  domain text not null,
  uri text not null,
  message text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > issued_at and expires_at <= issued_at + interval '30 minutes')
);
create index if not exists wallet_challenges_user on public.wallet_challenges (user_id, issued_at desc);
alter table public.wallet_challenges enable row level security;
revoke all on public.wallet_challenges from public, anon, authenticated;
grant all on public.wallet_challenges to service_role;

alter table public.wallets
  add column if not exists verification_method text,
  add column if not exists verified_chain_id int,
  add column if not exists is_contract boolean not null default false;

-- Atomically consumes a challenge once. Returns the challenge or raises.
create or replace function public.consume_wallet_challenge(_nonce text, _user uuid)
returns public.wallet_challenges
language plpgsql
security definer
set search_path = ''
as $$
declare c public.wallet_challenges;
begin
  update public.wallet_challenges set consumed_at = now()
   where nonce = _nonce and user_id = _user and consumed_at is null and expires_at > now()
  returning * into c;
  if not found then raise exception 'This wallet signature request is invalid, expired or already used'; end if;
  return c;
end
$$;

-- Links a wallet whose control was just proven. Never moves a wallet between accounts.
create or replace function public.link_verified_wallet(_user uuid, _address text, _kind text, _method text, _chain_id int, _is_contract boolean)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare w public.wallets; addr text := lower(_address);
begin
  if addr !~ '^0x[0-9a-f]{40}$' then raise exception 'Bad wallet address'; end if;
  perform pg_advisory_xact_lock(hashtext('wallet:' || addr));
  select * into w from public.wallets where address = addr;
  if found then
    if w.user_id <> _user then raise exception 'This wallet is already linked to another account'; end if;
    update public.wallets set verification_method = coalesce(_method, verification_method), verified_chain_id = coalesce(_chain_id, verified_chain_id),
           is_contract = is_contract or coalesce(_is_contract, false),
           kind = case when _kind = 'privy' then 'privy' else kind end
     where id = w.id returning * into w;
    return w;
  end if;
  insert into public.wallets (user_id, address, kind, verification_method, verified_chain_id, is_contract, is_default)
  values (_user, addr, coalesce(_kind, 'external'), _method, _chain_id, coalesce(_is_contract, false),
          not exists (select 1 from public.wallets where user_id = _user and is_default))
  returning * into w;
  insert into public.audit_log (actor, action, details) values (_user, 'wallet.linked', jsonb_build_object('address', addr, 'method', _method, 'kind', _kind));
  return w;
end
$$;

-- ---------------------------------------------------------------------------
-- Historical NFT collections and snapshot claims
-- ---------------------------------------------------------------------------
create table if not exists public.nft_collections (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  edition text not null check (edition ~ '^[A-Za-z0-9_-]{1,20}$'),
  chain_id int not null,
  contract text not null check (contract ~ '^0x[0-9a-f]{40}$'),
  standard text not null default 'erc721' check (standard = 'erc721'),
  deploy_block bigint check (deploy_block is null or deploy_block >= 0),
  snapshot_block bigint check (snapshot_block is null or snapshot_block >= 0),
  snapshot_block_hash text check (snapshot_block_hash is null or snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
  status text not null default 'candidate' check (status in ('candidate', 'ready', 'retired')),
  indexed_through_block bigint,
  indexed_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (edition, chain_id, contract),
  constraint nft_collections_ready check (status <> 'ready' or (snapshot_block is not null and snapshot_block_hash is not null
                                         and deploy_block is not null and indexed_through_block >= snapshot_block and verified_by is not null))
);

-- Candidate only: must be confirmed as the intended 2025 collection, with a snapshot block and hash.
insert into public.nft_collections (label, edition, chain_id, contract, notes)
values ('ApeGames digital competition (CANDIDATE)', '2025', 33139, '0x8bb7b20291a9fa2f25705b8487194b410808c28b',
        'CANDIDATE — confirm this is the intended 2025 collection, then set deploy_block, snapshot_block and snapshot_block_hash.')
on conflict (edition, chain_id, contract) do nothing;

-- Owner of every token at the snapshot block, reconstructed from Transfer logs (works for
-- non-enumerable ERC-721 and any number of tokens per owner).
create table if not exists public.nft_snapshot_owners (
  collection_id uuid not null references public.nft_collections(id),
  token_id numeric(78, 0) not null check (token_id >= 0),
  owner text not null check (owner ~ '^0x[0-9a-f]{40}$'),
  last_transfer_block bigint not null,
  primary key (collection_id, token_id)
);
create index if not exists nft_snapshot_owners_owner on public.nft_snapshot_owners (collection_id, owner);

create table if not exists public.nft_snapshot_claims (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.nft_collections(id),
  edition text not null,
  chain_id int not null,
  contract text not null,
  token_id numeric(78, 0) not null,
  snapshot_block bigint not null,
  user_id uuid not null,
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  season_id uuid not null references public.seasons(id),
  status text not null default 'pending' check (status in ('pending', 'unavailable', 'verified', 'rejected')),
  verified_owner text,
  verified_block_hash text,
  attempts int not null default 0,
  last_error text,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  ledger_id bigint
);
-- Global one-time recognition per edition/chain/contract/token/snapshot (across wallets, users, seasons).
create unique index if not exists nft_snapshot_claims_once
  on public.nft_snapshot_claims (edition, chain_id, contract, token_id, snapshot_block) where status in ('pending', 'unavailable', 'verified');
create index if not exists nft_snapshot_claims_user on public.nft_snapshot_claims (user_id, season_id);
create index if not exists nft_snapshot_claims_open on public.nft_snapshot_claims (submitted_at) where status in ('pending', 'unavailable');

do $$
declare t text;
begin
  foreach t in array array['nft_collections', 'nft_snapshot_owners', 'nft_snapshot_claims'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant select on public.nft_collections, public.nft_snapshot_claims to authenticated;
drop policy if exists "collections read" on public.nft_collections;
create policy "collections read" on public.nft_collections for select to authenticated using (status <> 'retired' or public.is_admin());
drop policy if exists "claims own read" on public.nft_snapshot_claims;
create policy "claims own read" on public.nft_snapshot_claims for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- A collection's snapshot is frozen once any non-draft season references it.
create or replace function public.nft_collections_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.seasons s where s.status <> 'draft'
              and (s.snapshot_config -> 'collection_ids') ? old.id::text) then
    if new.chain_id <> old.chain_id or new.contract <> old.contract or new.edition <> old.edition
       or new.snapshot_block is distinct from old.snapshot_block or new.snapshot_block_hash is distinct from old.snapshot_block_hash
       or new.deploy_block is distinct from old.deploy_block or new.status <> old.status then
      raise exception 'Collection % is used by a live season; its snapshot is frozen', old.label;
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists nft_collections_guard on public.nft_collections;
create trigger nft_collections_guard before update on public.nft_collections
  for each row execute function public.nft_collections_guard();

-- Owners table is append-free once a collection is ready (indexing writes it before readiness).
create or replace function public.nft_snapshot_owners_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare st text;
begin
  select status into st from public.nft_collections where id = coalesce(new.collection_id, old.collection_id);
  if st = 'ready' then raise exception 'Snapshot owners are frozen for a ready collection'; end if;
  return coalesce(new, old);
end
$$;
drop trigger if exists nft_snapshot_owners_guard on public.nft_snapshot_owners;
create trigger nft_snapshot_owners_guard before insert or update or delete on public.nft_snapshot_owners
  for each row execute function public.nft_snapshot_owners_guard();

-- Player asks for recognition of tokens their verified wallets held at the snapshot.
create or replace function public.submit_snapshot_claims(_user uuid, _collection uuid, _tokens jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seasons := public.current_season();
  c public.nft_collections;
  t jsonb;
  created int := 0;
  skipped int := 0;
  v_wallet text;
  v_token numeric;
begin
  if s.id is null then raise exception 'No season is open for claims right now'; end if;
  if coalesce(s.rules #>> '{points,nft_snapshot_per_token}', '0') = '0' then raise exception 'This season does not award NFT snapshot points'; end if;
  if not ((s.snapshot_config -> 'collection_ids') ? _collection::text) then raise exception 'This collection is not part of the season snapshot'; end if;
  select * into c from public.nft_collections where id = _collection;
  if c.status <> 'ready' then raise exception 'Snapshot claims for this collection are not ready yet'; end if;
  if jsonb_typeof(_tokens) <> 'array' or jsonb_array_length(_tokens) > 500 then raise exception 'Send up to 500 tokens at a time'; end if;

  for t in select * from jsonb_array_elements(_tokens) loop
    v_wallet := lower(t ->> 'wallet');
    v_token := (t ->> 'token_id')::numeric;
    if v_token is null or v_token < 0 or v_token <> trunc(v_token) then raise exception 'Bad token id'; end if;
    if not exists (select 1 from public.wallets where user_id = _user and address = v_wallet) then
      raise exception 'Wallet % is not verified for this account', v_wallet;
    end if;
    begin
      insert into public.nft_snapshot_claims (collection_id, edition, chain_id, contract, token_id, snapshot_block, user_id, wallet_address, season_id)
      values (c.id, c.edition, c.chain_id, c.contract, v_token, c.snapshot_block, _user, v_wallet, s.id);
      created := created + 1;
    exception when unique_violation then
      skipped := skipped + 1;
    end;
  end loop;
  return jsonb_build_object('created', created, 'already_claimed', skipped);
end
$$;

-- Records the archive-RPC verification of one claim. `_unavailable` = the RPC could not answer
-- (outage, missing archive state): the claim stays open; it is NEVER decided from latest ownership.
create or replace function public.record_snapshot_verification(_claim uuid, _owner text, _block_hash text, _unavailable boolean, _error text)
returns public.nft_snapshot_claims
language plpgsql
security definer
set search_path = ''
as $$
declare
  cl public.nft_snapshot_claims;
  c public.nft_collections;
  s public.seasons;
  pts bigint;
  v_ledger bigint;
begin
  select * into cl from public.nft_snapshot_claims where id = _claim for update;
  if not found then raise exception 'Unknown claim'; end if;
  if cl.status in ('verified', 'rejected') then return cl; end if;
  select * into c from public.nft_collections where id = cl.collection_id;
  select * into s from public.seasons where id = cl.season_id;

  if _unavailable then
    update public.nft_snapshot_claims set status = 'unavailable', attempts = attempts + 1, last_error = left(_error, 500)
     where id = cl.id returning * into cl;
    return cl;
  end if;

  if lower(_block_hash) is distinct from c.snapshot_block_hash then
    update public.nft_snapshot_claims set status = 'unavailable', attempts = attempts + 1, last_error = 'Snapshot block hash mismatch (wrong chain or reorg)'
     where id = cl.id returning * into cl;
    perform public.raise_alert('snapshot_block_mismatch', c.id::text, 'critical', 'Archive RPC returned a different snapshot block hash',
      jsonb_build_object('expected', c.snapshot_block_hash, 'got', _block_hash));
    return cl;
  end if;

  if now() > s.ends_at + s.grace_period then
    update public.nft_snapshot_claims set status = 'rejected', decided_at = now(), last_error = 'Verification finished after the grace period'
     where id = cl.id returning * into cl;
    return cl;
  end if;

  -- The snapshot owner must be the claimed wallet, and that wallet must still be linked to this player.
  if lower(_owner) = cl.wallet_address and exists (select 1 from public.wallets where user_id = cl.user_id and address = cl.wallet_address) then
    pts := (s.rules #>> '{points,nft_snapshot_per_token}')::bigint;
    v_ledger := public.ledger_award(s.id, cl.user_id, 'nft_snapshot',
                                    format('%s:%s:%s:%s:%s', cl.edition, cl.chain_id, cl.contract, cl.token_id, cl.snapshot_block),
                                    'nft_snapshot', pts, s.rules_version, cl.submitted_at,
                                    jsonb_build_object('claim_id', cl.id, 'wallet', cl.wallet_address), null);
    update public.nft_snapshot_claims
       set status = 'verified', verified_owner = lower(_owner), verified_block_hash = lower(_block_hash), decided_at = now(),
           attempts = attempts + 1, last_error = null, ledger_id = v_ledger
     where id = cl.id returning * into cl;
  else
    update public.nft_snapshot_claims
       set status = 'rejected', verified_owner = lower(_owner), verified_block_hash = lower(_block_hash), decided_at = now(),
           attempts = attempts + 1, last_error = 'Wallet did not own this token at the snapshot'
     where id = cl.id returning * into cl;
  end if;
  return cl;
end
$$;

-- ---------------------------------------------------------------------------
-- Burns: namespaced by chain/contract/token and chain/tx/log; claim + credit + holding are atomic.
-- ---------------------------------------------------------------------------
alter table public.burn_claims
  add column if not exists chain_id int,
  add column if not exists contract text,
  add column if not exists log_index int,
  add column if not exists block_number bigint,
  add column if not exists block_hash text,
  add column if not exists from_address text,
  add column if not exists level_source text,
  add column if not exists credit_id uuid,
  add column if not exists evidence jsonb not null default '{}'::jsonb;

update public.burn_claims b
   set chain_id = coalesce(b.chain_id, (c.value ->> 'chain_id')::int),
       contract = coalesce(b.contract, lower(c.value ->> 'contract'))
  from public.app_config c
 where c.key = 'nft' and (b.chain_id is null or b.contract is null);

alter table public.burn_claims drop constraint if exists burn_claims_token_id_key;
alter table public.burn_claims drop constraint if exists burn_claims_tx_hash_key;
create unique index if not exists burn_claims_token_once on public.burn_claims (chain_id, contract, token_id);
create unique index if not exists burn_claims_log_once on public.burn_claims (chain_id, tx_hash, log_index) where log_index is not null;

create or replace function public.record_burn_claim(
  _user uuid, _chain_id int, _contract text, _token_id text, _tx_hash text, _log_index int, _block_number bigint,
  _block_hash text, _from text, _level int, _level_source text, _evidence jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_claim uuid; v_credits uuid[]; cfg jsonb;
begin
  select value into cfg from public.app_config where key = 'nft';
  if _level < coalesce((cfg ->> 'burn_min_level')::int, 4) then raise exception 'Only Level % and above NFTs are eligible', (cfg ->> 'burn_min_level'); end if;
  if not exists (select 1 from public.wallets where user_id = _user and address = lower(_from)) then
    raise exception 'The burning wallet is not verified for this account';
  end if;
  begin
    insert into public.burn_claims (user_id, token_id, tx_hash, level, chain_id, contract, log_index, block_number, block_hash, from_address, level_source, evidence)
    values (_user, _token_id, lower(_tx_hash), _level, _chain_id, lower(_contract), _log_index, _block_number, lower(_block_hash), lower(_from), _level_source, coalesce(_evidence, '{}'::jsonb))
    returning id into v_claim;
  exception when unique_violation then
    raise exception 'This NFT or burn transfer was already claimed';
  end;
  v_credits := public.issue_sponsored_credits(_user, 'burn', 1, 'burn:' || _chain_id || ':' || lower(_contract) || ':' || _token_id, null,
                                              jsonb_build_object('burn_claim_id', v_claim));
  update public.burn_claims set credit_id = v_credits[1] where id = v_claim;
  insert into public.nft_holdings (token_id, owner_address, user_id, level, burned, synced_at)
  values (_token_id, lower(coalesce(cfg ->> 'burn_address', '0x000000000000000000000000000000000000dead')), _user, _level, true, now())
  on conflict (token_id) do update set burned = true, owner_address = excluded.owner_address, synced_at = now();
  return jsonb_build_object('claim_id', v_claim, 'credit_id', v_credits[1]);
end
$$;

-- ---------------------------------------------------------------------------
-- X accounts and verified result shares
-- ---------------------------------------------------------------------------
create table if not exists public.x_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  x_user_id text check (x_user_id is null or x_user_id ~ '^[0-9]{1,25}$'),
  handle text not null check (handle ~ '^[A-Za-z0-9_]{1,15}$'),
  verification_method text not null check (verification_method in ('oauth', 'manual')),
  linked_at timestamptz not null default now(),
  verified_at timestamptz,
  unlinked_at timestamptz
);
create unique index if not exists x_accounts_one_per_user on public.x_accounts (user_id) where unlinked_at is null;
create unique index if not exists x_accounts_handle_once on public.x_accounts (lower(handle)) where unlinked_at is null;
create unique index if not exists x_accounts_xid_once on public.x_accounts (x_user_id) where unlinked_at is null and x_user_id is not null;

create table if not exists public.social_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  season_id uuid not null references public.seasons(id),
  spin_id uuid not null references public.spins(id),
  x_account_id uuid not null references public.x_accounts(id),
  platform text not null default 'x' check (platform = 'x'),
  post_id text not null unique check (post_id ~ '^[0-9]{1,25}$'),
  post_url text not null,
  author_x_user_id text,
  author_handle text,
  post_created_at timestamptz,
  submitted_at timestamptz not null default now(),
  award_day date not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'not_rewarded')),
  verifier text check (verifier in ('x_api', 'manual')),
  reviewer_id uuid,
  reviewed_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  decision_reason text,
  ledger_id bigint
);
create index if not exists social_shares_user_day on public.social_shares (user_id, award_day);
create index if not exists social_shares_pending on public.social_shares (submitted_at) where status = 'pending';

-- Slots are taken on approval and never released (a reversal does not reopen the day or the spin).
create table if not exists public.social_award_slots (
  user_id uuid not null,
  award_day date not null,
  slot int not null default 1,
  share_id uuid not null unique references public.social_shares(id),
  created_at timestamptz not null default now(),
  primary key (user_id, award_day, slot)
);
create table if not exists public.social_spin_slots (
  user_id uuid not null,
  spin_id uuid not null,
  share_id uuid not null unique references public.social_shares(id),
  created_at timestamptz not null default now(),
  primary key (user_id, spin_id)
);

do $$
declare t text;
begin
  foreach t in array array['x_accounts', 'social_shares', 'social_award_slots', 'social_spin_slots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant select on public.x_accounts, public.social_shares to authenticated;
drop policy if exists "x own read" on public.x_accounts;
create policy "x own read" on public.x_accounts for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "shares own read" on public.social_shares;
create policy "shares own read" on public.social_shares for select to authenticated using (user_id = auth.uid() or public.is_admin());

create or replace function public.normalize_x_post_url(_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare m text[];
begin
  m := regexp_match(btrim(_url), '^https://(?:www\.|mobile\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})/status(?:es)?/([0-9]{1,25})(?:[/?#].*)?$');
  if m is null then return null; end if;
  return m[2];
end
$$;

-- Links (or replaces) the player's X account. One active link per player and per X account; history kept.
create or replace function public.link_x_account(_user uuid, _handle text, _x_user_id text, _method text)
returns public.x_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare a public.x_accounts;
begin
  perform pg_advisory_xact_lock(hashtext('x-link:' || lower(_handle)));
  if exists (select 1 from public.x_accounts where unlinked_at is null and user_id <> _user
              and (lower(handle) = lower(_handle) or (x_user_id is not null and x_user_id = _x_user_id))) then
    raise exception 'That X account is linked to another player';
  end if;
  update public.x_accounts set unlinked_at = now() where user_id = _user and unlinked_at is null;
  insert into public.x_accounts (user_id, x_user_id, handle, verification_method, verified_at)
  values (_user, _x_user_id, _handle, _method, case when _method = 'oauth' then now() end)
  returning * into a;
  return a;
end
$$;

-- Player submits a post. Never rewards on submission: the post must be verified (API or manual review).
create or replace function public.submit_social_share(_user uuid, _post_url text, _spin uuid, _verifier text)
returns public.social_shares
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seasons := public.current_season();
  v_post text := public.normalize_x_post_url(_post_url);
  acct public.x_accounts;
  sp public.spins;
  today date := (now() at time zone 'UTC')::date;
  sh public.social_shares;
begin
  if _verifier not in ('x_api', 'manual') then raise exception 'X share verification is not configured'; end if;
  if s.id is null or coalesce(s.rules #>> '{points,x_share}', '0') = '0' or coalesce((s.rules #>> '{limits,x_shares_per_utc_day}')::int, 0) = 0 then
    raise exception 'Share rewards are not open right now';
  end if;
  if v_post is null then raise exception 'Paste the link to your post on x.com'; end if;
  select * into acct from public.x_accounts where user_id = _user and unlinked_at is null;
  if not found then raise exception 'Link your X account first'; end if;
  select * into sp from public.spins where id = _spin;
  if not found or sp.user_id <> _user or sp.status <> 'fulfilled' then raise exception 'Share one of your own completed spins'; end if;

  perform pg_advisory_xact_lock(hashtext('share-user:' || _user::text));
  if (select count(*) from public.social_shares where user_id = _user and submitted_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') >= 5 then
    raise exception 'You can submit up to 5 posts per day';
  end if;
  if (select count(*) from public.social_shares where user_id = _user and status = 'pending') >= 3 then
    raise exception 'You already have 3 posts waiting for review';
  end if;
  if (select count(*) from public.social_shares where status = 'pending') >= 500 then
    raise exception 'The review queue is full right now; try again later';
  end if;
  if exists (select 1 from public.social_spin_slots where user_id = _user and spin_id = _spin) then
    raise exception 'This spin already earned a share reward';
  end if;

  begin
    insert into public.social_shares (user_id, season_id, spin_id, x_account_id, post_id, post_url, award_day, verifier)
    values (_user, s.id, _spin, acct.id, v_post, 'https://x.com/i/status/' || v_post, today, _verifier)
    returning * into sh;
  exception when unique_violation then
    raise exception 'That post was already submitted';
  end;
  return sh;
end
$$;

-- Approve or reject a submitted post. Approval: author is the linked account, post made during the
-- season and before submission, slots free; slot + ledger + totals in one transaction.
create or replace function public.review_social_share(
  _share uuid, _approve boolean, _verifier text, _reviewer uuid, _author_x_user_id text, _author_handle text,
  _post_created_at timestamptz, _references_spin boolean, _evidence jsonb, _reason text)
returns public.social_shares
language plpgsql
security definer
set search_path = ''
as $$
declare
  sh public.social_shares;
  s public.seasons;
  acct public.x_accounts;
  pts bigint;
  cap int;
  slot_no int;
  v_ledger bigint;
  why text;
begin
  if _verifier = 'manual' and (_reviewer is null or not public.has_role(_reviewer, 'admin')) then raise exception 'Forbidden'; end if;
  select * into sh from public.social_shares where id = _share for update;
  if not found then raise exception 'Unknown share'; end if;
  if sh.status <> 'pending' then return sh; end if;
  select * into s from public.seasons where id = sh.season_id;
  select * into acct from public.x_accounts where id = sh.x_account_id;

  if not _approve then
    update public.social_shares set status = 'rejected', verifier = _verifier, reviewer_id = _reviewer, reviewed_at = now(),
           evidence = coalesce(_evidence, '{}'::jsonb), decision_reason = coalesce(_reason, 'Rejected')
     where id = sh.id returning * into sh;
    return sh;
  end if;

  why := case
    when not coalesce(_references_spin, false) then 'The post does not reference this spin'
    when acct.unlinked_at is not null and acct.unlinked_at < sh.submitted_at then 'The X account was unlinked'
    when (acct.x_user_id is not null and _author_x_user_id is distinct from acct.x_user_id)
         or (acct.x_user_id is null and lower(coalesce(_author_handle, '')) <> lower(acct.handle)) then 'The post author is not the linked X account'
    when _post_created_at is null then 'Post time unknown'
    when _post_created_at < s.starts_at or _post_created_at >= s.ends_at then 'The post was not made during the season'
    when _post_created_at > sh.submitted_at then 'The post is newer than the submission'
    when now() > s.ends_at + s.grace_period then 'Reviewed after the grace period'
    else null end;
  if why is not null then
    update public.social_shares set status = 'rejected', verifier = _verifier, reviewer_id = _reviewer, reviewed_at = now(),
           author_x_user_id = _author_x_user_id, author_handle = _author_handle, post_created_at = _post_created_at,
           evidence = coalesce(_evidence, '{}'::jsonb), decision_reason = why
     where id = sh.id returning * into sh;
    return sh;
  end if;

  cap := coalesce((s.rules #>> '{limits,x_shares_per_utc_day}')::int, 0);
  select coalesce(max(slot), 0) + 1 into slot_no from public.social_award_slots where user_id = sh.user_id and award_day = sh.award_day;
  if slot_no > cap then
    why := 'Daily share reward already earned';
  elsif exists (select 1 from public.social_spin_slots where user_id = sh.user_id and spin_id = sh.spin_id) then
    why := 'This spin already earned a share reward';
  end if;
  if why is not null then
    update public.social_shares set status = 'not_rewarded', verifier = _verifier, reviewer_id = _reviewer, reviewed_at = now(),
           author_x_user_id = _author_x_user_id, author_handle = _author_handle, post_created_at = _post_created_at,
           evidence = coalesce(_evidence, '{}'::jsonb), decision_reason = why
     where id = sh.id returning * into sh;
    return sh;
  end if;

  insert into public.social_award_slots (user_id, award_day, slot, share_id) values (sh.user_id, sh.award_day, slot_no, sh.id);
  insert into public.social_spin_slots (user_id, spin_id, share_id) values (sh.user_id, sh.spin_id, sh.id);
  pts := (s.rules #>> '{points,x_share}')::bigint;
  v_ledger := public.ledger_award(s.id, sh.user_id, 'x_share', sh.id::text, 'x_share', pts, s.rules_version, sh.submitted_at,
                                  jsonb_build_object('post_id', sh.post_id, 'spin_id', sh.spin_id), _reviewer);
  update public.social_shares set status = 'approved', verifier = _verifier, reviewer_id = _reviewer, reviewed_at = now(),
         author_x_user_id = _author_x_user_id, author_handle = _author_handle, post_created_at = _post_created_at,
         evidence = coalesce(_evidence, '{}'::jsonb), decision_reason = coalesce(_reason, 'Verified'), ledger_id = v_ledger
   where id = sh.id returning * into sh;
  return sh;
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.consume_wallet_challenge(text, uuid)',
    'public.link_verified_wallet(uuid, text, text, text, int, boolean)',
    'public.submit_snapshot_claims(uuid, uuid, jsonb)',
    'public.record_snapshot_verification(uuid, text, text, boolean, text)',
    'public.record_burn_claim(uuid, int, text, text, text, int, bigint, text, text, int, text, jsonb)',
    'public.link_x_account(uuid, text, text, text)',
    'public.submit_social_share(uuid, text, uuid, text)',
    'public.review_social_share(uuid, boolean, text, uuid, text, text, timestamptz, boolean, jsonb, text)',
    'public.nft_collections_guard()',
    'public.nft_snapshot_owners_guard()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function public.normalize_x_post_url(text) from public, anon;
