-- Shipping paid by the winner for IRL prizes. Idempotent.
--
-- A winner who has an IRL prize mailed pays the shipping. The claim form asks Shippo for live carrier rates
-- (USPS / UPS / FedEx…) from the ship-from address (Admin → IRL claims → Shipping setup) to the winner's address,
-- for the prize's box (weight and size per prize). The winner picks a rate and pays it in APE at the live price
-- from their Glyph wallet to the treasury; the app checks the payment on ApeChain.

-- 1) Each IRL prize's box: weight (oz) and size (inches). Unset → the default box in the shipping settings.
alter table public.prizes add column if not exists ship_weight_oz numeric(10, 2) check (ship_weight_oz is null or ship_weight_oz > 0);
alter table public.prizes add column if not exists ship_length_in numeric(8, 2) check (ship_length_in is null or ship_length_in > 0);
alter table public.prizes add column if not exists ship_width_in numeric(8, 2) check (ship_width_in is null or ship_width_in > 0);
alter table public.prizes add column if not exists ship_height_in numeric(8, 2) check (ship_height_in is null or ship_height_in > 0);

-- 2) Rates quoted to a winner (the claim can only use a rate the server quoted for that address).
create table if not exists public.shipping_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  spin_id uuid not null references public.spins (id),
  address jsonb not null,
  rates jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists shipping_quotes_user_idx on public.shipping_quotes (user_id, created_at desc);
alter table public.shipping_quotes enable row level security;
revoke all on public.shipping_quotes from public, anon, authenticated;
grant all on public.shipping_quotes to service_role;

-- 3) The shipping the winner chose and paid, on their claim.
alter table public.prize_claims add column if not exists ship_quote_id uuid;
alter table public.prize_claims add column if not exists ship_rate_id text;
alter table public.prize_claims add column if not exists ship_carrier text;
alter table public.prize_claims add column if not exists ship_service text;
alter table public.prize_claims add column if not exists ship_days integer;
alter table public.prize_claims add column if not exists ship_usd numeric(10, 2) check (ship_usd is null or ship_usd >= 0);
alter table public.prize_claims add column if not exists ship_ape_wei text;
alter table public.prize_claims add column if not exists ship_ape_rate text;
alter table public.prize_claims add column if not exists ship_quoted_at timestamptz;
alter table public.prize_claims add column if not exists ship_pay_tx text;
alter table public.prize_claims add column if not exists ship_pending_tx text;
alter table public.prize_claims add column if not exists ship_payer text;
alter table public.prize_claims add column if not exists ship_paid_at timestamptz;
create unique index if not exists prize_claims_ship_pay_tx_uidx on public.prize_claims (ship_pay_tx) where ship_pay_tx is not null;
