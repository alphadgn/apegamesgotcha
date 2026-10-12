-- Catch-up of drizzle 0005–0014 (0012/0013 superseded by 0014). Idempotent.
alter table public.prizes add column if not exists image_url text;
alter table public.prizes add column if not exists is_physical boolean not null default false;

create table if not exists public.prize_claims (
  id uuid primary key default gen_random_uuid(),
  spin_id uuid not null unique references public.spins (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  prize_id uuid references public.prizes (id) on delete set null,
  prize_name text not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'shipped', 'delivered', 'rejected')),
  full_name text not null check (char_length(full_name) between 2 and 120),
  email text not null check (char_length(email) between 3 and 255),
  phone text check (phone is null or char_length(phone) <= 40),
  delivery text not null check (delivery in ('pickup', 'ship')),
  address jsonb,
  notes text check (notes is null or char_length(notes) <= 1000),
  admin_note text check (admin_note is null or char_length(admin_note) <= 1000),
  tracking text check (tracking is null or char_length(tracking) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prize_claims_address_for_shipping check (delivery = 'pickup' or address is not null)
);
create index if not exists prize_claims_user_idx on public.prize_claims (user_id, created_at desc);
create index if not exists prize_claims_status_idx on public.prize_claims (status, created_at desc);
revoke all on public.prize_claims from public, anon, authenticated;
grant select on public.prize_claims to authenticated;
grant all on public.prize_claims to service_role;
alter table public.prize_claims enable row level security;
drop policy if exists "prize claims own read" on public.prize_claims;
create policy "prize claims own read" on public.prize_claims
  for select to authenticated using (user_id = (select auth.uid()));

alter table public.prizes add column if not exists stocked integer check (stocked is null or stocked >= 0);
update public.prizes set stocked = inventory where stocked is null and inventory is not null;

create table if not exists public.super_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
revoke all on public.super_admins from public, anon, authenticated;
grant select on public.super_admins to authenticated;
grant all on public.super_admins to service_role;
alter table public.super_admins enable row level security;
drop policy if exists "super admins own read" on public.super_admins;
create policy "super admins own read" on public.super_admins for select to authenticated using (user_id = auth.uid());
insert into public.super_admins (user_id)
select u.id from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role = 'admin'
 where not exists (select 1 from public.super_admins)
 order by (u.raw_app_meta_data ->> 'super_admin') = 'true' desc nulls last,
          (select min(a.created_at) from public.audit_log a where a.actor = u.id and a.action = 'role.promoted') asc nulls last,
          u.created_at asc
 limit 1
on conflict do nothing;

create or replace function public.is_super_admin(_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.super_admins where user_id = _user_id) $$;
revoke execute on function public.is_super_admin(uuid) from public, anon;
grant execute on function public.is_super_admin(uuid) to authenticated, service_role;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, 'Ape-' || upper(substr(md5(new.id::text), 1, 6)))
  on conflict (id) do nothing;
  insert into public.user_roles(user_id, role) values (new.id, 'user') on conflict do nothing;
  if not exists (select 1 from public.user_roles where role='admin') then
    insert into public.user_roles(user_id, role) values (new.id, 'admin') on conflict do nothing;
    insert into public.super_admins(user_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop policy if exists "audit admin read" on public.audit_log;
drop policy if exists "audit super admin read" on public.audit_log;
create policy "audit super admin read" on public.audit_log for select to authenticated using (public.is_super_admin(auth.uid()));

alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
drop policy if exists "profiles own update" on public.profiles;
revoke update on public.profiles from authenticated;

update public.profiles p
   set display_name = 'Ape-' || upper(substr(md5(p.id::text), 1, 6))
  from auth.users u
 where u.id = p.id
   and (p.display_name is null or btrim(p.display_name) = ''
        or lower(p.display_name) = lower(split_part(coalesce(u.email, ''), '@', 1))
        or p.display_name ilike 'wallet-%' or p.display_name ilike '%@%');

create or replace function public.get_leaderboard(_limit int default 100)
returns table (rank bigint, user_id uuid, display_name text, points bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.leaderboard_mode() = 'demo' then
    return query
      select rank() over (order by sum(d.points) desc),
             case when d.user_id = auth.uid() then d.user_id end,
             coalesce(p.display_name, 'Anonymous ape'), sum(d.points)::bigint
        from public.demo_spins d left join public.profiles p on p.id = d.user_id
       group by d.user_id, p.display_name
      having sum(d.points) > 0
       order by 4 desc
       limit least(greatest(_limit, 1), 500);
  else
    return query
      select rank() over (order by sum(l.amount) desc),
             case when l.user_id = auth.uid() then l.user_id end,
             coalesce(p.display_name, 'Anonymous ape'), sum(l.amount)::bigint
        from public.points_ledger l left join public.profiles p on p.id = l.user_id
       where l.reason in ('spin', 'admin_adjustment')
       group by l.user_id, p.display_name
      having sum(l.amount) <> 0
       order by 4 desc
       limit least(greatest(_limit, 1), 500);
  end if;
end $$;
revoke all on function public.get_leaderboard(int) from public;
grant execute on function public.get_leaderboard(int) to anon, authenticated, service_role;

drop policy if exists "players add own guide messages" on public.guide_messages;
revoke insert, update, delete on public.guide_messages from anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['app_config','app_config_history','audit_log','burn_claims','contact_messages','demo_spins',
    'event_knowledge','guide_messages','nft_holdings','points_ledger','privy_accounts','prize_claims','prizes','profiles',
    'spin_credits','spin_grants','spin_purchases','spins','super_admins','user_roles','wallet_nonces','wallets']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke insert, update, delete, truncate on public.%I from anon', t);
    end if;
  end loop;
end $$;

drop policy if exists "admins read contact messages" on public.contact_messages;
revoke all on public.contact_messages from anon, authenticated;
alter table public.contact_messages enable row level security;
drop policy if exists "profiles own read" on public.profiles;
create policy "profiles own read" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "wallets own read" on public.wallets;
create policy "wallets own read" on public.wallets for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "privy accounts own read" on public.privy_accounts;
create policy "privy accounts own read" on public.privy_accounts for select to authenticated using (user_id = (select auth.uid()));

do $outer$ begin execute $q$drop policy if exists "prize images read" on storage.objects;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$create policy "prize images read" on storage.objects for select to anon, authenticated using (bucket_id = 'prize-images');$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$drop policy if exists "avatars read" on storage.objects;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$create policy "avatars read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_super_admin((select auth.uid()))));$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
