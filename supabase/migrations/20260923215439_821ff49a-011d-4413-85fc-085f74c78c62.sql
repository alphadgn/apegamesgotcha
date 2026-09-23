revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.config_version_trigger() from public, anon, authenticated;
revoke execute on function public.has_role(uuid, app_role) from public, anon;
revoke execute on function public.get_leaderboard(int) from public;
grant execute on function public.get_leaderboard(int) to anon, authenticated;
create policy "nonces no client access" on public.wallet_nonces for select to authenticated using (false);