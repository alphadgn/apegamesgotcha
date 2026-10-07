-- Privy sign-in: link a Privy account to a Supabase user, and give every player a default wallet.

-- Privy accounts linked to a player (a player can sign in with more than one Privy login).
create table if not exists public.privy_accounts (
  privy_did text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists privy_accounts_user_id on public.privy_accounts (user_id);
grant select on public.privy_accounts to authenticated;
grant all on public.privy_accounts to service_role;
alter table public.privy_accounts enable row level security;
drop policy if exists "privy accounts own read" on public.privy_accounts;
create policy "privy accounts own read" on public.privy_accounts for select to authenticated using (user_id = auth.uid());

-- Default wallet + where the wallet came from ('privy' = embedded wallet Privy created, 'external' = MetaMask etc.).
alter table public.wallets add column if not exists is_default boolean not null default false;
alter table public.wallets add column if not exists kind text not null default 'external';
create unique index if not exists wallets_one_default_per_user on public.wallets (user_id) where is_default;

-- Existing players: their earliest linked wallet becomes the default.
update public.wallets w set is_default = true
where w.id in (
  select distinct on (user_id) id from public.wallets
  where user_id not in (select user_id from public.wallets where is_default)
  order by user_id, verified_at
);

-- Lets the server match a Privy-verified email to an existing account (service role only).
create or replace function public.user_id_by_email(_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(_email) order by created_at limit 1
$$;
revoke all on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;