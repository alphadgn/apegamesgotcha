-- ============================================================================
-- Historical NFT recognition and verified burns (season leaderboard, part 4 of 7)
--
-- * Live holdings (nft_holdings) stay for display and burn eligibility only.
-- * Historical recognition uses configured collections: chain, normalised
--   contract, edition, snapshot block + block hash, and verified readiness.
--   The ApeChain contract seeded below is only a CANDIDATE until confirmed.
-- * Snapshot owners come from reconstructed Transfer logs (works for
--   non-enumerable ERC-721 and any number of holdings), then each claim is
--   verified with ownerOf at the snapshot block through an archive RPC.
--   Outages leave claims pending; nothing ever falls back to latest ownership.
-- * A token is recognised once, globally (across wallets, players, seasons).
-- * Burns are keyed by chain/contract/token and chain/tx/log index, and the
--   claim, spin credit (funded from a sponsored budget) and holding update
--   happen in one transaction.
-- ============================================================================

create table if not exists public.nft_collections (
  id uuid primary key default gen_random_uuid(),
  chain_id int not null check (chain_id > 0),
  contract text not null check (contract ~ '^0x[0-9a-f]{40}$'),
  edition text not null check (length(btrim(edition)) between 1 and 40),
  name text not null,
  status text not null default 'candidate' check (status in ('candidate', 'verified', 'frozen', 'retired')),
  snapshot_block bigint check (snapshot_block > 0),
  snapshot_block_hash text check (snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
  index_from_block bigint not null default 0 check (index_from_block >= 0),
  index_cursor_block bigint,            -- last block whose Transfer logs are fully applied
  index_completed_at timestamptz,
  index_token_count int,
  verified_by uuid,
  verified_at timestamptz,
  verification_evidence text,
  frozen_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (chain_id, contract, edition),
  check (status = 'candidate' or status = 'retired' or (snapshot_block is not null and snapshot_block_hash is not null
         and index_completed_at is not null and verified_at is not null and verification_evidence is not null))
);

create or replace function public.nft_collections_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'candidate' then raise exception 'Only candidate collections can be deleted'; end if;
    return old;
  end if;
  if old.status = 'frozen' and new is distinct from old then
    raise exception 'Collection % is frozen (it was used by an activated season)', old.id;
  end if;
  if old.status in ('verified', 'frozen') and (
       new.chain_id <> old.chain_id or new.contract <> old.contract or new.edition <> old.edition
    or new.snapshot_block is distinct from old.snapshot_block or new.snapshot_block_hash is distinct from old.snapshot_block_hash
    or new.index_cursor_block is distinct from old.index_cursor_block) then
    raise exception 'Verified snapshot configuration is immutable; retire it and add a new one';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then raise exception 'Retired collections stay retired'; end if;
  return new;
end
$$;
drop trigger if exists nft_collections_guard on public.nft_collections;
create trigger nft_collections_guard before update or delete on public.nft_collections
for each row execute function public.nft_collections_guard();

-- Seed the existing contract as an unconfirmed candidate (no snapshot block invented).
insert into public.nft_collections (chain_id, contract, edition, name, notes)
values (33139, '0x8bb7b20291a9fa2f25705b8487194b410808c28b', '2025', 'ApeGames 2025 (candidate)',
        'CANDIDATE: confirm this is the intended 2025 collection, then set the snapshot block and its hash.')
on conflict (chain_id, contract, edition) do nothing;

create table if not exists public.season_collections (
  season_id uuid not null references public.seasons (id),
  collection_id uuid not null references public.nft_collections (id),
  primary key (season_id, collection_id)
);
create or replace function public.season_collections_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_status text;
begin
  select status into v_status from public.seasons where id = coalesce(new.season_id, old.season_id);
  if v_status <> 'draft' then raise exception 'Snapshot collections are frozen once the season is activated'; end if;
  return coalesce(new, old);
end
$$;
drop trigger if exists season_collections_guard on public.season_collections;
create trigger season_collections_guard before insert or update or delete on public.season_collections
for each row execute function public.season_collections_guard();

-- Owner of each token at the snapshot block, reconstructed from Transfer logs.
create table if not exists public.nft_snapshot_owners (
  collection_id uuid not null references public.nft_collections (id),
  token_id numeric(78, 0) not null check (token_id >= 0),
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  last_transfer_block bigint not null,
  last_transfer_log_index int not null,
  primary key (collection_id, token_id)
);
create index if not exists nft_snapshot_owners_owner_idx on public.nft_snapshot_owners (collection_id, owner_address);

create table if not exists public.nft_snapshot_claims (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.nft_collections (id),
  token_id numeric(78, 0) not null,
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  user_id uuid not null,
  season_id uuid not null references public.seasons (id),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected', 'unavailable')),
  requested_at timestamptz not null default now(),
  verified_at timestamptz,
  attempts int not null default 0,
  last_error text,
  rejected_reason text,
  evidence jsonb not null default '{}'::jsonb,
  ledger_id bigint
);
create unique index if not exists nft_snapshot_claims_one_live
  on public.nft_snapshot_claims (collection_id, token_id) where status in ('pending', 'verified', 'unavailable');
create index if not exists nft_snapshot_claims_user_idx on public.nft_snapshot_claims (user_id, season_id);
create index if not exists nft_snapshot_claims_open_idx on public.nft_snapshot_claims (season_id) where status in ('pending', 'unavailable');

revoke all on public.nft_collections, public.season_collections, public.nft_snapshot_owners, public.nft_snapshot_claims from anon;
revoke insert, update, delete, truncate on public.nft_collections, public.season_collections, public.nft_snapshot_owners, public.nft_snapshot_claims from authenticated;
grant select on public.nft_collections, public.season_collections, public.nft_snapshot_owners, public.nft_snapshot_claims to service_role;
revoke insert, update, delete, truncate on public.nft_snapshot_owners, public.nft_snapshot_claims from service_role;
grant insert, update, delete on public.nft_collections, public.season_collections to service_role;
alter table public.nft_collections enable row level security;
alter table public.season_collections enable row level security;
alter table public.nft_snapshot_owners enable row level security;
alter table public.nft_snapshot_claims enable row level security;
drop policy if exists "collections admin read" on public.nft_collections;
create policy "collections admin read" on public.nft_collections for select to authenticated using (public.has_role(auth.uid(), 'admin'));
drop policy if exists "season collections admin read" on public.season_collections;
create policy "season collections admin read" on public.season_collections for select to authenticated using (public.has_role(auth.uid(), 'admin'));
drop policy if exists "snapshot owners admin read" on public.nft_snapshot_owners;
create policy "snapshot owners admin read" on public.nft_snapshot_owners for select to authenticated using (public.has_role(auth.uid(), 'admin'));
drop policy if exists "snapshot claims own read" on public.nft_snapshot_claims;
create policy "snapshot claims own read" on public.nft_snapshot_claims for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- Indexing: apply one contiguous block range of Transfer logs (server reads the chain).
-- _rows: [{ "token_id": "123", "to": "0x…", "block": 100, "log_index": 3 }, …] in any order.
-- ---------------------------------------------------------------------------
create or replace function public.apply_snapshot_transfers(_collection_id uuid, _from_block bigint, _to_block bigint, _rows jsonb, _complete boolean)
returns public.nft_collections
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.nft_collections;
  v_expected bigint;
begin
  select * into c from public.nft_collections where id = _collection_id for update;
  if not found then raise exception 'Unknown collection'; end if;
  if c.status <> 'candidate' then raise exception 'Only candidate collections can be (re)indexed'; end if;
  if c.snapshot_block is null or c.snapshot_block_hash is null then raise exception 'Set the snapshot block and hash first'; end if;
  v_expected := coalesce(c.index_cursor_block + 1, c.index_from_block);
  if _from_block <> v_expected then raise exception 'Index ranges must be contiguous (expected %, got %)', v_expected, _from_block; end if;
  if _to_block < _from_block or _to_block > c.snapshot_block then raise exception 'Index range must end at or before the snapshot block'; end if;
  if _complete and _to_block <> c.snapshot_block then raise exception 'Indexing completes exactly at the snapshot block'; end if;

  insert into public.nft_snapshot_owners as o (collection_id, token_id, owner_address, last_transfer_block, last_transfer_log_index)
  select _collection_id, (r ->> 'token_id')::numeric, lower(r ->> 'to'), (r ->> 'block')::bigint, (r ->> 'log_index')::int
    from (
      select distinct on ((x ->> 'token_id')::numeric) x as r
        from jsonb_array_elements(coalesce(_rows, '[]'::jsonb)) x
       where (x ->> 'block')::bigint between _from_block and _to_block
       order by (x ->> 'token_id')::numeric, (x ->> 'block')::bigint desc, (x ->> 'log_index')::int desc
    ) latest
  on conflict (collection_id, token_id) do update
    set owner_address = excluded.owner_address,
        last_transfer_block = excluded.last_transfer_block,
        last_transfer_log_index = excluded.last_transfer_log_index
    where (excluded.last_transfer_block, excluded.last_transfer_log_index) > (o.last_transfer_block, o.last_transfer_log_index);

  update public.nft_collections x
     set index_cursor_block = _to_block,
         index_completed_at = case when _complete then now() else null end,
         index_token_count = (select count(*) from public.nft_snapshot_owners o where o.collection_id = _collection_id)
   where x.id = _collection_id
  returning * into c;
  return c;
end
$$;

create or replace function public.reset_snapshot_index(_collection_id uuid, _actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.nft_collections where id = _collection_id and status = 'candidate') then
    raise exception 'Only candidate collections can be re-indexed';
  end if;
  delete from public.nft_snapshot_owners where collection_id = _collection_id;
  update public.nft_collections set index_cursor_block = null, index_completed_at = null, index_token_count = null where id = _collection_id;
  insert into public.audit_log (actor, action, details) values (_actor, 'snapshot.index_reset', jsonb_build_object('collection_id', _collection_id));
end
$$;

-- Admin confirms a candidate (after checking the chain, contract, edition, block and hash).
create or replace function public.verify_nft_collection(_collection_id uuid, _evidence text, _actor uuid)
returns public.nft_collections
language plpgsql
security definer
set search_path = ''
as $$
declare c public.nft_collections;
begin
  if _actor is null or _evidence is null or length(btrim(_evidence)) < 10 then
    raise exception 'Record who verified this collection and how (at least 10 characters)';
  end if;
  select * into c from public.nft_collections where id = _collection_id for update;
  if c.status <> 'candidate' then raise exception 'Only candidates can be verified'; end if;
  if c.snapshot_block is null or c.snapshot_block_hash is null then raise exception 'Snapshot block and hash are required'; end if;
  if c.index_completed_at is null or c.index_cursor_block <> c.snapshot_block then raise exception 'Finish indexing up to the snapshot block first'; end if;
  update public.nft_collections set status = 'verified', verified_by = _actor, verified_at = now(), verification_evidence = btrim(_evidence)
   where id = _collection_id returning * into c;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'snapshot.collection_verified', jsonb_build_object('collection_id', c.id, 'chain_id', c.chain_id, 'contract', c.contract,
          'edition', c.edition, 'snapshot_block', c.snapshot_block, 'snapshot_block_hash', c.snapshot_block_hash));
  return c;
end
$$;

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------
-- Open claims for every snapshot token owned (at the snapshot) by one of the player's verified wallets.
create or replace function public.request_snapshot_claims(_user_id uuid, _season_id uuid)
returns setof public.nft_snapshot_claims
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons;
begin
  select * into s from public.seasons where id = _season_id for share;
  if not found or s.status <> 'active' then raise exception 'Snapshot claims open while the season is active'; end if;
  if now() < s.starts_at or now() >= s.ends_at then raise exception 'Snapshot claims are accepted only during the season'; end if;
  if coalesce((s.rules ->> 'nft_snapshot_points')::bigint, 0) = 0 then raise exception 'This season does not award NFT snapshot points'; end if;
  perform pg_advisory_xact_lock(hashtextextended('snapshot_claims:' || _user_id::text, 0));
  return query
    insert into public.nft_snapshot_claims (collection_id, token_id, owner_address, user_id, season_id)
    select o.collection_id, o.token_id, o.owner_address, _user_id, _season_id
      from public.season_collections sc
      join public.nft_collections c on c.id = sc.collection_id and c.status = 'frozen'
      join public.nft_snapshot_owners o on o.collection_id = c.id
      join public.wallets w on w.address = o.owner_address and w.user_id = _user_id
     where sc.season_id = _season_id
       and o.owner_address <> '0x0000000000000000000000000000000000000000'
    on conflict do nothing
    returning *;
end
$$;

-- Record the archive-RPC verification outcome for one claim (and award points when verified).
-- _outcome: 'verified' (ownerOf at snapshot == claimed owner), 'rejected' (different owner / not minted),
--           'unavailable' (archive RPC down, wrong chain, block hash mismatch: try again later).
create or replace function public.resolve_snapshot_claim(_claim_id uuid, _outcome text, _snapshot_owner text, _evidence jsonb, _error text)
returns public.nft_snapshot_claims
language plpgsql
security definer
set search_path = ''
as $$
declare
  cl public.nft_snapshot_claims;
  c public.nft_collections;
  s public.seasons;
  v_points bigint;
  v_ledger bigint;
begin
  select * into cl from public.nft_snapshot_claims where id = _claim_id for update;
  if not found then raise exception 'Unknown claim'; end if;
  if cl.status not in ('pending', 'unavailable') then return cl; end if;
  select * into c from public.nft_collections where id = cl.collection_id;
  select * into s from public.seasons where id = cl.season_id for share;

  if _outcome = 'unavailable' then
    update public.nft_snapshot_claims set status = 'unavailable', attempts = attempts + 1, last_error = left(coalesce(_error, 'unavailable'), 500),
           evidence = evidence || coalesce(_evidence, '{}'::jsonb)
     where id = cl.id returning * into cl;
    return cl;
  end if;
  if _outcome = 'rejected' then
    update public.nft_snapshot_claims set status = 'rejected', attempts = attempts + 1, rejected_reason = left(coalesce(_error, 'not the snapshot owner'), 500),
           evidence = evidence || coalesce(_evidence, '{}'::jsonb)
     where id = cl.id returning * into cl;
    return cl;
  end if;
  if _outcome <> 'verified' then raise exception 'Unknown outcome %', _outcome; end if;

  if c.status <> 'frozen' then raise exception 'Collection is not frozen for a season'; end if;
  if lower(coalesce(_snapshot_owner, '')) <> cl.owner_address then
    raise exception 'Snapshot owner does not match the claim; record it as rejected';
  end if;
  if (_evidence ->> 'chain_id')::int is distinct from c.chain_id
     or lower(_evidence ->> 'block_hash') is distinct from c.snapshot_block_hash
     or (_evidence ->> 'block_number')::bigint is distinct from c.snapshot_block then
    raise exception 'Verification evidence must come from the snapshot block on the configured chain';
  end if;
  if not exists (select 1 from public.wallets w where w.address = cl.owner_address and w.user_id = cl.user_id) then
    raise exception 'The snapshot owner wallet is no longer linked to this player';
  end if;
  if s.status not in ('active', 'settling') or cl.requested_at >= s.ends_at then
    raise exception 'Season is closed to new recognition';
  end if;
  v_points := coalesce((s.rules ->> 'nft_snapshot_points')::bigint, 0);
  v_ledger := public._award_points(s.id, cl.user_id, 'nft_snapshot', c.id::text || ':' || cl.token_id::text, 'nft_snapshot', v_points,
                                   s.rule_version_id, now(),
                                   jsonb_build_object('chain_id', c.chain_id, 'contract', c.contract, 'edition', c.edition,
                                                      'token_id', cl.token_id::text, 'snapshot_block', c.snapshot_block), null);
  update public.nft_snapshot_claims set status = 'verified', verified_at = now(), attempts = attempts + 1, ledger_id = v_ledger,
         last_error = null, evidence = evidence || coalesce(_evidence, '{}'::jsonb)
   where id = cl.id returning * into cl;
  return cl;
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.apply_snapshot_transfers(uuid, bigint, bigint, jsonb, boolean)', 'public.reset_snapshot_index(uuid, uuid)',
    'public.verify_nft_collection(uuid, text, uuid)', 'public.request_snapshot_claims(uuid, uuid)',
    'public.resolve_snapshot_claim(uuid, text, text, jsonb, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Burns
-- ---------------------------------------------------------------------------
alter table public.burn_claims
  add column if not exists chain_id int,
  add column if not exists contract text,
  add column if not exists log_index int,
  add column if not exists from_address text,
  add column if not exists to_address text,
  add column if not exists block_number bigint,
  add column if not exists block_hash text,
  add column if not exists confirmations int,
  add column if not exists level_source text,
  add column if not exists credit_id uuid,
  add column if not exists evidence jsonb not null default '{}'::jsonb;
update public.burn_claims b
   set chain_id = coalesce(b.chain_id, (select (value ->> 'chain_id')::int from public.app_config where key = 'nft'), 33139),
       contract = coalesce(b.contract, lower((select value ->> 'contract' from public.app_config where key = 'nft')), '0x8bb7b20291a9fa2f25705b8487194b410808c28b'),
       level_source = coalesce(b.level_source, 'legacy')
 where b.chain_id is null or b.contract is null or b.level_source is null;
alter table public.burn_claims alter column chain_id set not null, alter column contract set not null;
alter table public.burn_claims drop constraint if exists burn_claims_token_id_key;
alter table public.burn_claims drop constraint if exists burn_claims_tx_hash_key;
create unique index if not exists burn_claims_token_key on public.burn_claims (chain_id, contract, token_id);
create unique index if not exists burn_claims_log_key on public.burn_claims (chain_id, tx_hash, log_index);
revoke insert, update, delete, truncate on public.burn_claims from service_role, authenticated, anon;
grant select on public.burn_claims to service_role;
revoke insert, update, delete, truncate on public.nft_holdings from authenticated, anon;

-- Atomic: claim + funded spin credit + holding marked burned. The server has already verified the
-- receipt on the configured chain (success, finalized depth, canonical block hash, Transfer log).
create or replace function public.record_burn_claim(
  _user_id uuid, _chain_id int, _contract text, _token_id text, _tx_hash text, _log_index int, _from text, _to text,
  _level int, _level_source text, _block_number bigint, _block_hash text, _confirmations int, _evidence jsonb
)
returns public.burn_claims
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg jsonb;
  b public.burn_claims;
  v_credit uuid;
  v_contract text := lower(_contract);
  v_min_conf int;
begin
  select value into cfg from public.app_config where key = 'nft';
  if (cfg ->> 'chain_id')::int is distinct from _chain_id then raise exception 'Wrong chain for burns'; end if;
  if lower(cfg ->> 'contract') is distinct from v_contract then raise exception 'Not the ApeGames NFT contract'; end if;
  if lower(_to) not in (lower(cfg ->> 'burn_address'), '0x0000000000000000000000000000000000000000') then raise exception 'Not sent to the burn address'; end if;
  if _token_id !~ '^[0-9]{1,78}$' or lower(_tx_hash) !~ '^0x[0-9a-f]{64}$' or _log_index is null or _log_index < 0 then raise exception 'Invalid burn reference'; end if;
  if lower(_block_hash) !~ '^0x[0-9a-f]{64}$' then raise exception 'Invalid block hash'; end if;
  v_min_conf := coalesce((cfg ->> 'burn_min_confirmations')::int, 12);
  if _confirmations < v_min_conf then raise exception 'Burn is not final yet (% of % confirmations)', _confirmations, v_min_conf; end if;
  if not exists (select 1 from public.wallets w where w.user_id = _user_id and w.address = lower(_from)) then
    raise exception 'The NFT was not burned from one of your linked wallets';
  end if;
  if _level is null or _level < coalesce((cfg ->> 'burn_min_level')::int, 4) then
    raise exception 'Only Level %+ NFTs are eligible', coalesce((cfg ->> 'burn_min_level')::int, 4);
  end if;
  if _level_source not in ('admin_override', 'pre_burn_metadata', 'synced_holding') then raise exception 'Untrusted level source'; end if;

  begin
    insert into public.burn_claims (user_id, token_id, tx_hash, level, chain_id, contract, log_index, from_address, to_address,
                                    block_number, block_hash, confirmations, level_source, evidence)
    values (_user_id, _token_id, lower(_tx_hash), _level, _chain_id, v_contract, _log_index, lower(_from), lower(_to),
            _block_number, lower(_block_hash), _confirmations, _level_source, coalesce(_evidence, '{}'::jsonb))
    returning * into b;
  exception when unique_violation then
    raise exception 'This NFT or burn was already claimed' using errcode = 'P0409';
  end;
  insert into public.spin_credits (user_id, source, ref)
  values (_user_id, 'burn', _chain_id::text || ':' || v_contract || ':' || _token_id)
  returning id into v_credit;
  perform public._reserve_sponsored_credit(v_credit, 'burn');
  update public.burn_claims set credit_id = v_credit where id = b.id returning * into b;
  insert into public.nft_holdings (token_id, owner_address, user_id, level, burned, synced_at)
  values (_token_id, lower(_to), _user_id, _level, true, now())
  on conflict (token_id) do update set owner_address = excluded.owner_address, burned = true, synced_at = now();
  insert into public.audit_log (actor, action, details)
  values (_user_id, 'nft.burned', jsonb_build_object('chain_id', _chain_id, 'contract', v_contract, 'token_id', _token_id,
          'tx', lower(_tx_hash), 'log_index', _log_index, 'level', _level, 'level_source', _level_source));
  return b;
end
$$;
revoke all on function public.record_burn_claim(uuid, int, text, text, text, int, text, text, int, text, bigint, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.record_burn_claim(uuid, int, text, text, text, int, text, text, int, text, bigint, text, int, jsonb) to service_role;

-- Live holdings sync (display / burn eligibility only — never points).
create or replace function public.sync_live_holdings(_user_id uuid, _rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_count int;
begin
  insert into public.nft_holdings as h (token_id, owner_address, user_id, level, synced_at)
  select r ->> 'token_id', lower(r ->> 'owner'), _user_id, nullif(r ->> 'level', '')::int, now()
    from jsonb_array_elements(coalesce(_rows, '[]'::jsonb)) r
    join public.wallets w on w.address = lower(r ->> 'owner') and w.user_id = _user_id
   where (r ->> 'token_id') ~ '^[0-9]{1,78}$'
  on conflict (token_id) do update
    set owner_address = excluded.owner_address, user_id = excluded.user_id,
        level = coalesce(h.level, excluded.level), synced_at = now()
    where not h.burned;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke all on function public.sync_live_holdings(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sync_live_holdings(uuid, jsonb) to service_role;

create or replace function public.set_holding_level_override(_token_id text, _level int, _actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.nft_holdings set level_override = _level where token_id = _token_id;
  if not found then raise exception 'Token not synced yet'; end if;
  insert into public.audit_log (actor, action, details) values (_actor, 'nft.level_override', jsonb_build_object('token_id', _token_id, 'level', _level));
end
$$;
revoke all on function public.set_holding_level_override(text, int, uuid) from public, anon, authenticated;
grant execute on function public.set_holding_level_override(text, int, uuid) to service_role;
revoke insert, update, delete, truncate on public.nft_holdings from service_role;
grant select on public.nft_holdings to service_role;

update public.app_config set value = value || '{"burn_min_confirmations": 12}'::jsonb
 where key = 'nft' and not (value ? 'burn_min_confirmations');
