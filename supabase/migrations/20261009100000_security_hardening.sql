-- ============================================================================
-- Security hardening (forward-only)
--
--  * Admin checks go through public.is_admin() (uses auth.uid(); no arbitrary user lookups).
--  * The "first registrant becomes admin" bootstrap is removed. Existing verified admins stay.
--  * Display names are no longer derived from email addresses. Public rankings use an opaque
--    public_id plus an alias/avatar the player chose explicitly.
--  * Players can only READ their own rows; every mutation goes through the server (service_role).
--  * SECURITY DEFINER functions pin search_path = '' and use schema-qualified names.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Role checks
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin'::public.app_role
  )
$$;
-- anon may evaluate it inside RLS policies; it is always false without a signed-in user.
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

-- has_role(user, role) can probe any user's roles, so only the server may call it now.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_roles r where r.user_id = _user_id and r.role = _role)
$$;
revoke all on function public.has_role(uuid, public.app_role) from public, anon, authenticated;
grant execute on function public.has_role(uuid, public.app_role) to service_role;

-- ---------------------------------------------------------------------------
-- Profiles: private display name, explicit public alias/avatar, opaque public id
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists public_id text,
  add column if not exists public_alias text,
  add column if not exists avatar_key text,
  add column if not exists public_profile_updated_at timestamptz;

update public.profiles
   set public_id = 'ape_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
 where public_id is null;

alter table public.profiles
  alter column public_id set default ('ape_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  alter column public_id set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_public_id_key') then
    alter table public.profiles add constraint profiles_public_id_key unique (public_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_public_alias_format') then
    alter table public.profiles add constraint profiles_public_alias_format
      check (public_alias is null or (char_length(public_alias) between 3 and 24 and public_alias ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]*[A-Za-z0-9]$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_avatar_key_format') then
    alter table public.profiles add constraint profiles_avatar_key_format
      check (avatar_key is null or avatar_key ~ '^[a-z0-9-]{1,32}$');
  end if;
end $$;
create unique index if not exists profiles_public_alias_ci on public.profiles (lower(public_alias)) where public_alias is not null;

-- New users: profile + 'user' role only. Never auto-grant admin, never copy the email into a name.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 80), ''))
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'user'::public.app_role)
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

-- ---------------------------------------------------------------------------
-- Client privileges: read-only, own rows. All writes happen server-side.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'user_roles', 'profiles', 'app_config', 'app_config_history', 'wallets', 'wallet_nonces',
    'nft_holdings', 'points_ledger', 'prizes', 'spin_credits', 'spins', 'burn_claims', 'audit_log',
    'spin_purchases', 'privy_accounts', 'event_knowledge'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from public, anon, authenticated', t);
      execute format('revoke select on public.%I from anon', t);
    end if;
  end loop;
end $$;

-- Every other public table (including ones created outside these migrations): no client
-- UPDATE/DELETE/TRUNCATE (TRUNCATE ignores RLS), no anonymous writes. The guide chat keeps its
-- RLS-checked INSERT for signed-in players.
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('revoke update, delete, truncate, references, trigger on public.%I from public, anon, authenticated', t.relname);
    execute format('revoke insert on public.%I from public, anon', t.relname);
    if t.relname <> 'guide_messages' then
      execute format('revoke insert on public.%I from authenticated', t.relname);
    end if;
  end loop;
end $$;

-- Prizes are shown to signed-out visitors on the demo machine.
grant select on public.prizes to anon;

-- Policies: replace has_role(auth.uid(), 'admin') with is_admin().
drop policy if exists "own roles readable" on public.user_roles;
create policy "own roles readable" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "profiles own read" on public.profiles;
drop policy if exists "profiles own update" on public.profiles;
create policy "profiles own read" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "config history admin read" on public.app_config_history;
create policy "config history admin read" on public.app_config_history for select to authenticated
  using (public.is_admin());

drop policy if exists "players read nft config" on public.app_config;
create policy "players read nft config" on public.app_config for select to authenticated
  using (key = 'nft' or public.is_admin());

drop policy if exists "wallets own read" on public.wallets;
create policy "wallets own read" on public.wallets for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "holdings own read" on public.nft_holdings;
create policy "holdings own read" on public.nft_holdings for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "ledger own read" on public.points_ledger;
create policy "ledger own read" on public.points_ledger for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "prizes public read" on public.prizes;
create policy "prizes public read" on public.prizes for select to anon, authenticated
  using (active or public.is_admin());

drop policy if exists "credits own read" on public.spin_credits;
create policy "credits own read" on public.spin_credits for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "spins own read" on public.spins;
create policy "spins own read" on public.spins for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "burns own read" on public.burn_claims;
create policy "burns own read" on public.burn_claims for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "audit admin read" on public.audit_log;
create policy "audit admin read" on public.audit_log for select to authenticated
  using (public.is_admin());

drop policy if exists "purchases own read" on public.spin_purchases;
create policy "purchases own read" on public.spin_purchases for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- contact_messages is created by the drizzle migrations (may not exist in every environment).
do $$ begin
  if to_regclass('public.contact_messages') is not null then
    execute 'drop policy if exists "admins read contact messages" on public.contact_messages';
    execute 'create policy "admins read contact messages" on public.contact_messages for select to authenticated using (public.is_admin())';
    execute 'revoke insert, update, delete, truncate on public.contact_messages from public, anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Existing SECURITY DEFINER helpers: pin search_path
-- ---------------------------------------------------------------------------
alter function public.user_id_by_email(text) set search_path = '';
