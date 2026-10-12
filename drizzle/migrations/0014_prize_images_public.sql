-- Prize pictures are public again (owner's decision, Oct 11): they're photos of prizes, not personal or
-- sensitive data, so anyone may view or download them. Idempotent.
-- The app shows them with plain public links. Only admins can upload, replace or delete them.
update storage.buckets set public = true where id = 'prize-images';
drop policy if exists "prize images read" on storage.objects;
create policy "prize images read" on storage.objects for select to anon, authenticated using (bucket_id = 'prize-images');
