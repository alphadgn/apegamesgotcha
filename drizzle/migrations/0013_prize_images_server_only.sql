-- Prize pictures: no direct downloads at all (Lovable finding "A rule lets anyone download files in
-- prize-images"). Idempotent.
-- The app now gets short-lived signed links from the server (src/lib/prize-images.functions.ts), which checks
-- who may see each picture: active prizes for everyone, won prizes for their winner, everything for admins.
-- So the bucket stays private and no read rule is needed. Admins still upload/replace/delete pictures.
do $outer$ begin execute $q$drop policy if exists "prize images read" on storage.objects;$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
do $outer$ begin execute $q$update storage.buckets set public = false where id = 'prize-images';$q$; exception when others then raise notice 'storage step skipped: %', sqlerrm; end $outer$;
