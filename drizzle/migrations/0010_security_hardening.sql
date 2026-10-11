-- Security hardening. Idempotent.

-- 1) The public leaderboard no longer reveals anything from players' emails or sign-in IDs.
--    Default usernames used the part of the email before the @ (or "wallet-<Privy ID>"); new accounts now get
--    "Ape-XXXXXX", and existing auto-generated names are replaced the same way. Players pick their own name
--    on My account.
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

update public.profiles p
   set display_name = 'Ape-' || upper(substr(md5(p.id::text), 1, 6))
  from auth.users u
 where u.id = p.id
   and (p.display_name is null
        or btrim(p.display_name) = ''
        or lower(p.display_name) = lower(split_part(coalesce(u.email, ''), '@', 1))
        or p.display_name ilike 'wallet-%'
        or p.display_name ilike '%@%');

-- 2) The leaderboard returns a player's ID only to that player (for "your rank"); everyone else's is hidden.
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

-- 3) Guide chat history is written only by the server (players can't insert forged guide replies).
drop policy if exists "players add own guide messages" on public.guide_messages;
revoke insert, update, delete on public.guide_messages from anon, authenticated;

-- 4) Profile pictures: only the player themself and admins can open (or list) them.
drop policy if exists "avatars read" on storage.objects;
create policy "avatars read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(), 'admin')));

-- 5) Belt and braces: nothing reachable without signing in can write to any app table.
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
