-- Gift certificates and vendors. Idempotent.
--
-- A gift certificate is a prize with a dollar value issued by a vendor (a local business). When a player wins
-- one in a real draw they choose:
--   * redeem in person: they get a one-time code, show it at the vendor, and the vendor enters it in the app; or
--   * claim the value: an admin forwards the request to the vendor, who sends the dollar value in APE (at the
--     APE price when they pay) from the certificate's issuer wallet to the winner's wallet; the app checks the
--     payment on ApeChain.
-- Vendors are players the super admin promotes. All writes go through the server (service role).

-- 1) Which prizes are certificates (value, vendor, issuer wallet — set in Admin → Gift certificates).
alter table public.prizes add column if not exists cert_value_usd numeric(12, 2)
  check (cert_value_usd is null or cert_value_usd > 0);
alter table public.prizes add column if not exists cert_vendor_id uuid;
alter table public.prizes add column if not exists cert_issuer_wallet text
  check (cert_issuer_wallet is null or cert_issuer_wallet ~ '^0x[0-9a-f]{40}$');

-- 2) Vendors (promoted by the super admin).
create table if not exists public.vendors (
  user_id uuid primary key references auth.users (id) on delete cascade,
  business_name text not null check (char_length(business_name) between 2 and 120),
  location text check (location is null or char_length(location) <= 300),
  wallet text check (wallet is null or wallet ~ '^0x[0-9a-f]{40}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.vendors enable row level security;
revoke all on public.vendors from public, anon, authenticated;
grant all on public.vendors to service_role;

-- 3) One record per certificate won (created when the win is first listed).
create table if not exists public.gift_certificates (
  id uuid primary key default gen_random_uuid(),
  spin_id uuid not null unique references public.spins (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  prize_id uuid references public.prizes (id) on delete set null,
  prize_name text not null,
  vendor_id uuid,
  issuer_wallet text,
  value_usd numeric(12, 2) not null check (value_usd > 0),
  status text not null default 'unclaimed'
    check (status in ('unclaimed', 'code_issued', 'redeemed', 'requested', 'forwarded', 'paid', 'cancelled')),
  redeem_code text,
  payout_wallet text,
  ape_wei text,
  ape_usd_rate text,
  quoted_at timestamptz,
  pay_tx text unique,
  pending_tx text,
  requested_at timestamptz,
  forwarded_at timestamptz,
  forwarded_by uuid,
  paid_at timestamptz,
  redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists gift_certificates_user_idx on public.gift_certificates (user_id, created_at desc);
create index if not exists gift_certificates_vendor_idx on public.gift_certificates (vendor_id, status);
alter table public.gift_certificates enable row level security;
revoke all on public.gift_certificates from public, anon, authenticated;
grant all on public.gift_certificates to service_role;

-- A payment the vendor already sent that ApeChain hasn't confirmed yet (blocks a second payment meanwhile).
alter table public.gift_certificates add column if not exists pending_tx text;
