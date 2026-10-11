-- Prize pictures (Lovable security finding "A rule lets anyone download files in prize-images"). Idempotent.
-- Before: any file in the prize-images bucket could be downloaded by anyone. Now a picture can be opened only
-- while it is the photo of an active prize (shown in the prize pool and the machine), by a player who won
-- that prize (their IRL prizes list), or by an admin (Prizes & odds, including uploads not yet saved).
create or replace function public.can_view_prize_image(_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    exists (select 1 from public.prizes p where p.image_url = _name and p.active)
    or (auth.uid() is not null and (
      public.has_role(auth.uid(), 'admin')
      or exists (
        select 1 from public.prizes p join public.spins s on s.prize_id = p.id
         where p.image_url = _name and s.user_id = auth.uid() and s.status = 'fulfilled')
    ))
$$;
revoke all on function public.can_view_prize_image(text) from public;
grant execute on function public.can_view_prize_image(text) to anon, authenticated, service_role;

drop policy if exists "prize images read" on storage.objects;
create policy "prize images read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'prize-images' and public.can_view_prize_image(name));
