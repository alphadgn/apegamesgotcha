-- ============================================================================
-- Identity & security hardening (season leaderboard, part 1 of 7)
--
-- * No more "first person to register becomes admin". Existing admin rows are
--   kept as they are; new admins are granted deliberately (see the runbook).
-- * New profiles never get an email-derived name. Public leaderboards show only
--   a deliberately chosen alias/avatar and an opaque public id.
-- * Every write from the browser goes through the server (service role). The
--   API roles keep read access only where a row-level policy allows it.
-- * Mutating functions are revoked from PUBLIC, anon and authenticated; every
--   SECURITY DEFINER function pins search_path to '' and qualifies names.
-- * Wallet linking uses single-use, expiring, domain/URI/chain-bound SIWE
--   challenges that are consumed atomically.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Table privileges: browsers read through RLS, never write directly.
-- (Supabase grants ALL on new public tables to anon/authenticated by default.)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.prizes to anon;
-- Signed-out visitors read active prizes without calling has_role (which anon cannot execute).
drop policy if exists "prizes public read" on public.prizes;
drop policy if exists "prizes anon read" on public.prizes;
drop policy if exists "prizes player read" on public.prizes;
create policy "prizes anon read" on public.prizes for select to anon using (active);
create policy "prizes player read" on public.prizes for select to authenticated using (active or public.has_role(auth.uid(), 'admin'));
-- The guide chat stores the player's own messages (row policy restricts to auth.uid()).
grant insert on public.guide_messages to authenticated;

-- ---------------------------------------------------------------------------
-- Function privileges: nothing is callable by the API roles unless re-granted.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Roles: keep verified existing admins, stop bootstrapping new ones.
-- ---------------------------------------------------------------------------
alter table public.user_roles add column if not exists granted_at timestamptz;
alter table public.user_roles add column if not exists granted_by uuid;
alter table public.user_roles add column if not exists note text;
update public.user_roles set note = coalesce(note, 'retained at identity hardening migration')
where role = 'admin' and note is null;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_roles r where r.user_id = _user_id and r.role = _role)
$$;
revoke all on function public.has_role(uuid, public.app_role) from public, anon;
-- Row policies call has_role(auth.uid(), 'admin') on behalf of signed-in players.
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Profiles: private display name, public alias/avatar chosen on purpose.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists public_id uuid not null default gen_random_uuid();
alter table public.profiles add column if not exists public_alias text;
alter table public.profiles add column if not exists avatar_key text;
alter table public.profiles add column if not exists alias_updated_at timestamptz;
create unique index if not exists profiles_public_id_key on public.profiles (public_id);
create unique index if not exists profiles_public_alias_lower_key on public.profiles (lower(public_alias)) where public_alias is not null;
alter table public.profiles drop constraint if exists profiles_public_alias_format;
alter table public.profiles add constraint profiles_public_alias_format
  check (public_alias is null or public_alias ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{1,22}[A-Za-z0-9]$');
alter table public.profiles drop constraint if exists profiles_avatar_key_format;
alter table public.profiles add constraint profiles_avatar_key_format
  check (avatar_key is null or avatar_key ~ '^[a-z0-9-]{1,32}$');

drop policy if exists "profiles own update" on public.profiles;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Private display name only from an explicit name the sign-in provider gave us; never from the email.
  insert into public.profiles (id, display_name)
  values (new.id, nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role, granted_at, note)
  values (new.id, 'user', now(), 'default role')
  on conflict (user_id, role) do nothing;
  return new;
end
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.config_version_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.updated_at := now();
  end if;
  insert into public.app_config_history (key, value, version, changed_by)
  values (new.key, new.value, new.version, new.updated_by);
  return new;
end
$$;
revoke all on function public.config_version_trigger() from public, anon, authenticated;

-- Player-chosen public identity (server calls this after validating the session).
create or replace function public.set_public_profile(_user_id uuid, _alias text, _avatar_key text)
returns table (public_id uuid, public_alias text, avatar_key text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alias text := nullif(btrim(_alias), '');
  v_avatar text := nullif(btrim(_avatar_key), '');
begin
  if _user_id is null then raise exception 'user required'; end if;
  if v_alias is not null and v_alias !~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{1,22}[A-Za-z0-9]$' then
    raise exception 'Alias must be 3-24 letters, numbers, spaces, dots, dashes or underscores';
  end if;
  if v_avatar is not null and v_avatar !~ '^[a-z0-9-]{1,32}$' then raise exception 'Unknown avatar'; end if;
  if v_alias is not null and exists (
    select 1 from public.profiles p where lower(p.public_alias) = lower(v_alias) and p.id <> _user_id
  ) then
    raise exception 'That alias is taken';
  end if;
  insert into public.profiles (id) values (_user_id) on conflict (id) do nothing;
  update public.profiles p
     set public_alias = v_alias, avatar_key = v_avatar, alias_updated_at = now()
   where p.id = _user_id;
  insert into public.audit_log (actor, action, details)
  values (_user_id, 'profile.public_identity', jsonb_build_object('alias_set', v_alias is not null, 'avatar', v_avatar));
  return query select p.public_id, p.public_alias, p.avatar_key from public.profiles p where p.id = _user_id;
end
$$;
revoke all on function public.set_public_profile(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_public_profile(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Wallets: provenance of each verification, SIWE challenges.
-- ---------------------------------------------------------------------------
alter table public.wallets add column if not exists verification text;
alter table public.wallets add column if not exists chain_id int;
update public.wallets
   set verification = case when kind = 'privy' then 'privy' else 'legacy_personal_sign' end
 where verification is null;
alter table public.wallets alter column verification set default 'siwe';
alter table public.wallets alter column verification set not null;
alter table public.wallets drop constraint if exists wallets_verification_check;
alter table public.wallets add constraint wallets_verification_check
  check (verification in ('siwe', 'privy', 'legacy_personal_sign'));
alter table public.wallets drop constraint if exists wallets_address_format;
alter table public.wallets add constraint wallets_address_format check (address ~ '^0x[0-9a-f]{40}$') not valid;

create table if not exists public.wallet_challenges (
  nonce text primary key check (nonce ~ '^[A-Za-z0-9]{16,128}$'),
  user_id uuid not null,
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  chain_id int not null check (chain_id > 0),
  domain text not null,
  uri text not null,
  message text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > issued_at)
);
create index if not exists wallet_challenges_user_idx on public.wallet_challenges (user_id, issued_at desc);
revoke all on public.wallet_challenges from anon, authenticated;
grant all on public.wallet_challenges to service_role;
alter table public.wallet_challenges enable row level security;
-- No client policies: challenges are server-only.

create or replace function public.issue_wallet_challenge(
  _user_id uuid, _address text, _chain_id int, _domain text, _uri text, _nonce text, _message text, _ttl_seconds int default 600
)
returns public.wallet_challenges
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.wallet_challenges;
  v_open int;
begin
  if _user_id is null then raise exception 'user required'; end if;
  if lower(_address) !~ '^0x[0-9a-f]{40}$' then raise exception 'Invalid wallet address'; end if;
  if _ttl_seconds < 60 or _ttl_seconds > 1800 then raise exception 'Invalid challenge lifetime'; end if;
  if coalesce(btrim(_domain), '') = '' or coalesce(btrim(_uri), '') = '' then raise exception 'Domain and URI required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wallet_challenge:' || _user_id::text, 0));
  delete from public.wallet_challenges w where w.user_id = _user_id and (w.expires_at < now() - interval '1 day');
  select count(*) into v_open from public.wallet_challenges w
   where w.user_id = _user_id and w.consumed_at is null and w.expires_at > now();
  if v_open >= 5 then raise exception 'Too many open wallet signature requests. Wait a few minutes.'; end if;
  insert into public.wallet_challenges (nonce, user_id, address, chain_id, domain, uri, message, expires_at)
  values (_nonce, _user_id, lower(_address), _chain_id, _domain, _uri, _message, now() + make_interval(secs => _ttl_seconds))
  returning * into c;
  return c;
end
$$;
revoke all on function public.issue_wallet_challenge(uuid, text, int, text, text, text, text, int) from public, anon, authenticated;
grant execute on function public.issue_wallet_challenge(uuid, text, int, text, text, text, text, int) to service_role;

-- Internal: insert a verified wallet for a player; never moves a wallet between accounts.
create or replace function public._link_wallet(_user_id uuid, _address text, _kind text, _verification text, _chain_id int)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_addr text := lower(_address);
  w public.wallets;
begin
  if v_addr !~ '^0x[0-9a-f]{40}$' then raise exception 'Invalid wallet address'; end if;
  if _kind not in ('external', 'privy') then raise exception 'Invalid wallet kind'; end if;
  select * into w from public.wallets x where x.address = v_addr for update;
  if found then
    if w.user_id <> _user_id then
      raise exception 'Wallet already linked to another account' using errcode = 'P0409';
    end if;
    if _kind = 'privy' and w.kind <> 'privy' then
      update public.wallets x set kind = 'privy' where x.id = w.id returning * into w;
    end if;
    return w;
  end if;
  insert into public.wallets (user_id, address, kind, verification, chain_id, is_default)
  values (
    _user_id, v_addr, _kind, _verification, _chain_id,
    not exists (select 1 from public.wallets d where d.user_id = _user_id and d.is_default)
  )
  returning * into w;
  insert into public.audit_log (actor, action, details)
  values (_user_id, 'wallet.linked', jsonb_build_object('address', v_addr, 'kind', _kind, 'verification', _verification, 'chain_id', _chain_id));
  return w;
end
$$;
revoke all on function public._link_wallet(uuid, text, text, text, int) from public, anon, authenticated, service_role;

-- Consume a SIWE challenge exactly once and link the wallet in the same transaction.
-- The server verifies the signature (EOA or ERC-1271/6492 contract wallet) over the stored message first.
create or replace function public.link_wallet_with_challenge(_user_id uuid, _nonce text, _address text, _domain text, _chain_id int)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.wallet_challenges;
begin
  update public.wallet_challenges w
     set consumed_at = now()
   where w.nonce = _nonce
     and w.user_id = _user_id
     and w.consumed_at is null
     and w.expires_at > now()
  returning * into c;
  if not found then
    raise exception 'This signature request is expired or was already used. Request a new one.' using errcode = 'P0410';
  end if;
  if c.address <> lower(_address) then raise exception 'Signed by a different wallet than requested'; end if;
  if c.domain <> _domain then raise exception 'Signature request is for a different site'; end if;
  if c.chain_id <> _chain_id then raise exception 'Signature request is for a different chain'; end if;
  return public._link_wallet(_user_id, c.address, 'external', 'siwe', c.chain_id);
end
$$;
revoke all on function public.link_wallet_with_challenge(uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.link_wallet_with_challenge(uuid, text, text, text, int) to service_role;

-- Wallets Privy has verified for this Privy login (embedded or linked through Privy's own signature flow).
create or replace function public.link_privy_wallet(_user_id uuid, _address text, _kind text)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public._link_wallet(_user_id, _address, _kind, 'privy', null);
end
$$;
revoke all on function public.link_privy_wallet(uuid, text, text) from public, anon, authenticated;
grant execute on function public.link_privy_wallet(uuid, text, text) to service_role;

-- Privy login → player. A Privy login already attached to another player is a conflict, never a merge.
create or replace function public.link_privy_account(_user_id uuid, _privy_did text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_owner uuid;
begin
  if _privy_did !~ '^did:privy:[A-Za-z0-9]+$' then raise exception 'Invalid Privy id'; end if;
  select p.user_id into v_owner from public.privy_accounts p where p.privy_did = _privy_did for update;
  if found then
    if v_owner <> _user_id then
      raise exception 'That Privy login belongs to another player' using errcode = 'P0409';
    end if;
    return;
  end if;
  insert into public.privy_accounts (privy_did, user_id) values (_privy_did, _user_id);
  insert into public.audit_log (actor, action, details) values (_user_id, 'privy.linked', jsonb_build_object('privy', true));
end
$$;
revoke all on function public.link_privy_account(uuid, text) from public, anon, authenticated;
grant execute on function public.link_privy_account(uuid, text) to service_role;

create or replace function public.set_default_wallet(_user_id uuid, _address text)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare w public.wallets;
begin
  select * into w from public.wallets x where x.user_id = _user_id and x.address = lower(_address) for update;
  if not found then raise exception 'That wallet isn''t linked to your account'; end if;
  update public.wallets x set is_default = false where x.user_id = _user_id and x.is_default and x.id <> w.id;
  update public.wallets x set is_default = true where x.id = w.id returning * into w;
  insert into public.audit_log (actor, action, details) values (_user_id, 'wallet.default', jsonb_build_object('address', w.address));
  return w;
end
$$;
revoke all on function public.set_default_wallet(uuid, text) from public, anon, authenticated;
grant execute on function public.set_default_wallet(uuid, text) to service_role;

-- Old single-row nonce table is superseded by wallet_challenges.
revoke all on public.wallet_nonces from anon, authenticated;

-- Service-only helper that existed before: keep, but with a pinned search path.
revoke all on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;

-- Re-pin the purchase completion function (unchanged behaviour, hardened search path).
create or replace function public.complete_spin_purchase(_purchase_id uuid, _tx_hash text, _payer text)
returns public.spin_purchases
language plpgsql
security definer
set search_path = ''
as $$
declare p public.spin_purchases; i int;
begin
  if lower(_tx_hash) !~ '^0x[0-9a-f]{64}$' then raise exception 'Invalid transaction hash'; end if;
  if lower(_payer) !~ '^0x[0-9a-f]{40}$' then raise exception 'Invalid payer'; end if;
  select * into p from public.spin_purchases s where s.id = _purchase_id for update;
  if not found then raise exception 'Unknown purchase'; end if;
  if p.status = 'paid' then return p; end if;
  if exists (select 1 from public.spin_purchases s where s.tx_hash = lower(_tx_hash) and s.id <> _purchase_id) then
    raise exception 'This transaction was already used';
  end if;
  update public.spin_purchases s
     set status = 'paid', tx_hash = lower(_tx_hash), payer = lower(_payer), paid_at = now()
   where s.id = _purchase_id
  returning * into p;
  for i in 1..p.quantity loop
    insert into public.spin_credits (user_id, source, ref) values (p.user_id, 'purchase', p.id::text || ':' || i);
  end loop;
  return p;
end
$$;
revoke all on function public.complete_spin_purchase(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_spin_purchase(uuid, text, text) to service_role;
