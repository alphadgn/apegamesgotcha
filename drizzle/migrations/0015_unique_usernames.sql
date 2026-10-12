-- Every username belongs to exactly one player (ignoring capitals and surrounding spaces). Idempotent.

-- 1) Players with no name, or sharing a name with someone who had it first, get an "Ape-XXXXXXXX" name.
update public.profiles p
   set display_name = 'Ape-' || upper(substr(md5(p.id::text), 1, 8))
 where p.display_name is null or btrim(p.display_name) = '';

with ranked as (
  select p.id,
         row_number() over (
           partition by lower(btrim(p.display_name))
           order by u.created_at nulls last, p.id
         ) as rn
    from public.profiles p
    left join auth.users u on u.id = p.id
)
update public.profiles p
   set display_name = 'Ape-' || upper(substr(md5(p.id::text), 1, 8))
  from ranked r
 where r.id = p.id and r.rn > 1;

-- 2) The database refuses a second player with the same username.
do $outer$
begin
  execute 'create unique index if not exists profiles_display_name_unique
             on public.profiles (lower(btrim(display_name)))';
exception when others then
  raise notice 'unique username index not created: %', sqlerrm;
end $outer$;

-- 3) New accounts get a default name nobody has yet (and the first-admin step works with or without the
--    super_admins table).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  candidate text := 'Ape-' || upper(substr(md5(new.id::text), 1, 6));
  n int := 0;
begin
  while exists (select 1 from public.profiles where lower(btrim(display_name)) = lower(candidate)) loop
    n := n + 1;
    candidate := 'Ape-' || upper(substr(md5(new.id::text || ':' || n), 1, case when n < 5 then 6 else 10 end));
  end loop;
  insert into public.profiles(id, display_name) values (new.id, candidate)
  on conflict (id) do nothing;
  insert into public.user_roles(user_id, role) values (new.id, 'user') on conflict do nothing;
  if not exists (select 1 from public.user_roles where role = 'admin') then
    insert into public.user_roles(user_id, role) values (new.id, 'admin') on conflict do nothing;
    if to_regclass('public.super_admins') is not null then
      execute 'insert into public.super_admins(user_id) values ($1) on conflict do nothing' using new.id;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
