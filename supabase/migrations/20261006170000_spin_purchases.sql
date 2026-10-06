-- ============================================================================
-- Spin purchases: players buy spins (bundles of 5, up to 20) by sending APE on
-- ApeChain to the treasury. Each purchase gets an id that the wallet sends as
-- the transaction's data, so a payment can only ever be credited to the player
-- who created it, and each transaction can only be used once.
-- ============================================================================

create table if not exists public.spin_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  quantity int not null check (quantity in (5, 10, 15, 20)),
  price_wei numeric(78, 0) not null check (price_wei > 0), -- total price for the bundle
  chain_id int not null,
  treasury text not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  tx_hash text unique,
  payer text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists spin_purchases_user_idx on public.spin_purchases(user_id, created_at desc);
grant select on public.spin_purchases to authenticated;
grant all on public.spin_purchases to service_role;
alter table public.spin_purchases enable row level security;
drop policy if exists "purchases own read" on public.spin_purchases;
create policy "purchases own read" on public.spin_purchases for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- Mark a verified payment and add the spins (idempotent; one transaction per purchase).
create or replace function public.complete_spin_purchase(_purchase_id uuid, _tx_hash text, _payer text)
returns public.spin_purchases language plpgsql security definer set search_path = public as $$
declare p public.spin_purchases; i int;
begin
  select * into p from spin_purchases where id = _purchase_id for update;
  if not found then raise exception 'Unknown purchase'; end if;
  if p.status = 'paid' then return p; end if;
  if exists (select 1 from spin_purchases where tx_hash = lower(_tx_hash) and id <> _purchase_id) then
    raise exception 'This transaction was already used';
  end if;

  update spin_purchases
     set status = 'paid', tx_hash = lower(_tx_hash), payer = lower(_payer), paid_at = now()
   where id = _purchase_id
  returning * into p;

  for i in 1..p.quantity loop
    insert into spin_credits(user_id, source, ref) values (p.user_id, 'purchase', p.id::text || ':' || i);
  end loop;
  return p;
end $$;

revoke all on function public.complete_spin_purchase(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_spin_purchase(uuid, text, text) to service_role;

-- Settings (edit in Admin → Configuration → purchase)
insert into public.app_config(key, value) values
('purchase', '{
  "enabled": false,
  "chain_id": 33139,
  "rpc_url": "https://rpc.apechain.com/http",
  "explorer_url": "https://apescan.io",
  "treasury": "",
  "price_ape_per_spin": "1",
  "bundles": [5, 10, 15, 20],
  "min_confirmations": 1,
  "privy_app_id": ""
}')
on conflict (key) do nothing;
