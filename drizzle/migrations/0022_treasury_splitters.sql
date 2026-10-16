-- Gotcha Treasury, phase 1: GotchaFeeSplitter deployments made from Admin → Treasury. Idempotent.
-- The page compiles the contract in the browser (solc-js 0.8.24+commit.e11b9ed9, optimizer 200 runs, shanghai)
-- and deploys it from the admin's wallet; the server checks the deployment on-chain (creation code matches the
-- reviewed source, owner / keeper / recipients read back from the contract) before saving it here.
create table if not exists public.treasury_splitters (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id in (33139, 33111)),
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  owner text not null,
  keeper text not null,
  recipients jsonb not null,
  constructor_args text not null,
  block_number bigint,
  deployed_by uuid,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (chain_id, address)
);
-- At most one active splitter per chain.
create unique index if not exists treasury_splitters_active_uidx on public.treasury_splitters (chain_id) where is_active;
alter table public.treasury_splitters enable row level security;
revoke all on public.treasury_splitters from public, anon, authenticated;
grant all on public.treasury_splitters to service_role;
