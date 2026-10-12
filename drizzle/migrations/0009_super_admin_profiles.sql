-- Super admin + promoted admins, and player profiles (username + profile picture). Idempotent.
--
-- Roles: every admin keeps user_roles.role = 'admin' (so existing admin checks keep working). The super admin
-- is additionally listed in public.super_admins and alone can manage admins, configuration, Chainlink VRF,
-- purchases and the audit log. Promoted admins are 'admin' without a super_admins row.

create table if not exists public.super_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.super_admins enable row level security;
revoke all on public.super_admins from public, anon, authenticated;
grant select on public.super_admins to authenticated;
grant all on public.super_admins to service_role;
drop policy if exists "super admins own read" on public.super_admins;
create policy "super admins own read" on public.super_admins for select to authenticated using (user_id = auth.uid());

-- Today's administrator account(s) become the super admin (only when no super admin exists yet).
-- Exactly ONE: the account already marked super admin by the app (app_metadata.super_admin), else the admin who
-- promoted another admin first (only the super admin can promote), else the earliest-created admin.
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

-- A brand-new install: the very first account is admin and super admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  insert into public.user_roles(user_id, role) values (new.id, 'user') on conflict do nothing;
  if not exists (select 1 from public.user_roles where role='admin') then
    insert into public.user_roles(user_id, role) values (new.id, 'admin') on conflict do nothing;
    insert into public.super_admins(user_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- The audit log is for the super admin only.
drop policy if exists "audit admin read" on public.audit_log;
drop policy if exists "audit super admin read" on public.audit_log;
create policy "audit super admin read" on public.audit_log for select to authenticated using (public.is_super_admin(auth.uid()));

-- Profiles: username (display_name) and a profile picture (path in the private 'avatars' bucket).
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
-- Profile pictures: uploaded image files in a private bucket, shown through signed links.
do $outer$ begin execute $q$insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 3145728, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
-- Anyone may view (signed links); a player may only add, change or remove files in their own folder.
do $outer$ begin execute $q$drop policy if exists "avatars read" on storage.objects;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$create policy "avatars read" on storage.objects for select to anon, authenticated using (bucket_id = 'avatars');$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$drop policy if exists "avatars own insert" on storage.objects;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$create policy "avatars own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$drop policy if exists "avatars own update" on storage.objects;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$create policy "avatars own update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$drop policy if exists "avatars own delete" on storage.objects;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$create policy "avatars own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;

-- Usernames and pictures change only through the app's server (username rules, no duplicates, own picture only).
drop policy if exists "profiles own update" on public.profiles;
revoke update on public.profiles from authenticated;
