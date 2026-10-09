-- Configuration defaults for the season features. Everything that needs real-world input starts
-- disabled or empty and is reported as a setup step (Admin -> Setup checklist).

-- Wallet ownership challenges (SIWE). Origins must be listed explicitly; RPCs verify contract wallets.
insert into public.app_config (key, value) values
('siwe', '{
  "allowed_origins": [],
  "statement": "Sign in to link this wallet to your ApeGames Gotcha account. This does not send a transaction or cost gas.",
  "ttl_minutes": 10,
  "chains": {"33139": "https://rpc.apechain.com/http", "8453": "https://mainnet.base.org", "1": "https://eth.llamarpc.com"}
}')
on conflict (key) do nothing;

-- Historical snapshot verification needs an ARCHIVE RPC per chain (state at the snapshot block).
insert into public.app_config (key, value) values
('snapshot', '{"archive_rpc_urls": {}, "index_chunk_blocks": 5000, "min_confirmations": 12}')
on conflict (key) do nothing;

-- Verified X shares: disabled until an admin chooses manual review or the X API is configured.
insert into public.app_config (key, value) values
('social', '{"verification": "disabled", "site_origin": ""}')
on conflict (key) do nothing;

-- Burn verification: confirmations required before a burn counts.
update public.app_config
   set value = value || '{"burn_min_confirmations": 12}'::jsonb
 where key = 'nft' and not (value ? 'burn_min_confirmations');

-- VRF: expected coordinator (pauses draws if it changes), confirmations before a request counts,
-- and the subscription balance below which an alert is raised.
update public.app_config
   set value = value || '{"coordinator": "", "min_confirmations": 3, "min_subscription_balance": "0"}'::jsonb
 where key = 'vrf' and not (value ? 'coordinator');

-- Worker heartbeat (shown in Admin -> Setup checklist and Settlement).
alter table public.draw_coordination
  add column if not exists worker_last_run_at timestamptz,
  add column if not exists worker_last_report jsonb;
