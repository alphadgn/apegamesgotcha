-- One row per wallet, whatever the capitals (0xAbC… and 0xabc… are the same wallet). Idempotent.

-- 1) Duplicates that differ only in capitals: keep the earliest link; if a removed copy was its player's default
--    wallet and the kept one belongs to the same player, the kept one becomes the default.
do $outer$
declare r record;
begin
  for r in
    select w.id, w.user_id, w.is_default, k.id as keep_id, k.user_id as keep_user
      from public.wallets w
      join lateral (
        select id, user_id from public.wallets k
         where lower(k.address) = lower(w.address)
         order by k.verified_at nulls last, k.id
         limit 1
      ) k on k.id <> w.id
  loop
    delete from public.wallets where id = r.id;
    if r.is_default and r.keep_user = r.user_id then
      update public.wallets set is_default = true
       where id = r.keep_id
         and not exists (select 1 from public.wallets x where x.user_id = r.user_id and x.is_default);
    end if;
  end loop;
end $outer$;

-- 2) Store every address in lower case, now and on every future insert/update.
update public.wallets set address = lower(address) where address <> lower(address);

create or replace function public.wallets_lower_address()
returns trigger language plpgsql as $$
begin
  new.address := lower(new.address);
  return new;
end $$;
drop trigger if exists wallets_lower_address on public.wallets;
create trigger wallets_lower_address before insert or update of address on public.wallets
  for each row execute function public.wallets_lower_address();

-- 3) The database refuses a second copy of a wallet.
do $outer$
begin
  execute 'create unique index if not exists wallets_address_lower_unique on public.wallets (lower(address))';
exception when others then
  raise notice 'wallet unique index not created: %', sqlerrm;
end $outer$;
