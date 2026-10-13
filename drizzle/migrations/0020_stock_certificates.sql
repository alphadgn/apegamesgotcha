-- Stock certificates (Stonk Certificates). Idempotent.
--
-- A stock certificate is an NFT (ERC-721 on Robinhood Chain, StonkBrokers) whose own token-bound wallet holds
-- stock tokens: whoever owns the NFT controls the tokens inside it. A prize becomes a stock certificate when an
-- admin lists the certificate token IDs the project's custody wallet holds for it (Admin → Stock certificates).
-- Each win gets one of those token IDs. The winner chooses how to receive it:
--   * to a wallet: the app sends the NFT from the custody wallet to the winner's wallet straight away; or
--   * by email: the app emails a one-time claim link to the account email; the winner opens it, picks the
--     wallet, and the app sends the NFT there.
-- Chain, contract and RPC live in app_config.stock (super admin). All writes go through the server.

-- 1) Which prizes are stock certificates: the certificate token IDs set aside for each one.
alter table public.prizes add column if not exists stock_token_ids text[];

-- 2) One record per stock certificate won (created when the win is first listed).
create table if not exists public.stock_certificates (
  id uuid primary key default gen_random_uuid(),
  spin_id uuid not null unique references public.spins (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  prize_id uuid references public.prizes (id) on delete set null,
  prize_name text not null,
  chain_id integer,
  contract text check (contract is null or contract ~ '^0x[0-9a-f]{40}$'),
  token_id text check (token_id is null or token_id ~ '^[0-9]{1,78}$'),
  status text not null default 'unclaimed'
    check (status in ('unclaimed', 'emailed', 'sending', 'sent', 'failed')),
  delivery text check (delivery is null or delivery in ('wallet', 'email')),
  to_wallet text check (to_wallet is null or to_wallet ~ '^0x[0-9a-f]{40}$'),
  email text,
  claim_rand text,
  emailed_at timestamptz,
  tx_hash text unique,
  error text,
  send_started_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A certificate NFT goes to one winner only.
create unique index if not exists stock_certificates_token_uidx
  on public.stock_certificates (contract, token_id) where token_id is not null;
create index if not exists stock_certificates_user_idx on public.stock_certificates (user_id, created_at desc);
create index if not exists stock_certificates_status_idx on public.stock_certificates (status);
alter table public.stock_certificates enable row level security;
revoke all on public.stock_certificates from public, anon, authenticated;
grant all on public.stock_certificates to service_role;
