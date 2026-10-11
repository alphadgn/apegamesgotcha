-- Personal data lockdown (Lovable security finding "Exposed personal & sensitive data"). Idempotent.
-- Players' contact details (claim names, emails, phone numbers, shipping addresses, contact-form emails),
-- profiles and wallets were readable through the database API by every admin account. The app never reads
-- them that way: each player reads only their own rows, and admin screens get what they need through
-- server functions that check the admin's role first. So the database API now returns only a player's own
-- rows, and nothing at all for contact-form messages.

-- IRL prize claims: only the player who won the prize (admins use adminListIrlClaims on the server).
drop policy if exists "prize claims own read" on public.prize_claims;
create policy "prize claims own read" on public.prize_claims
  for select to authenticated using (user_id = (select auth.uid()));

-- Contact-form messages (name, email, message): server only.
drop policy if exists "admins read contact messages" on public.contact_messages;
do $$
begin
  if to_regclass('public.contact_messages') is not null then
    execute 'revoke all on public.contact_messages from anon, authenticated';
    execute 'alter table public.contact_messages enable row level security';
  end if;
end $$;

-- Profiles: only your own (the leaderboard shows usernames through get_leaderboard; the super admin's
-- Admins tab goes through superListAccounts on the server).
drop policy if exists "profiles own read" on public.profiles;
create policy "profiles own read" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

-- Wallets: only your own.
drop policy if exists "wallets own read" on public.wallets;
create policy "wallets own read" on public.wallets
  for select to authenticated using (user_id = (select auth.uid()));

-- Linked sign-in accounts: only your own.
do $$
begin
  if to_regclass('public.privy_accounts') is not null then
    execute 'drop policy if exists "privy accounts own read" on public.privy_accounts';
    execute 'create policy "privy accounts own read" on public.privy_accounts for select to authenticated using (user_id = (select auth.uid()))';
  end if;
end $$;

-- Profile pictures: the player and the super admin (Admins tab) only.
drop policy if exists "avatars read" on storage.objects;
create policy "avatars read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_super_admin((select auth.uid()))));
