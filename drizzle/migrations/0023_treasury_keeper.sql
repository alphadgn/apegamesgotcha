-- Gotcha Treasury, phases 2–3: dashboard history, keeper bot jobs, alerts, run lock and the 10-minute schedule.
-- Idempotent. All tables are server-only (service role).

-- Where the event history scan has reached, per splitter.
alter table public.treasury_splitters add column if not exists scanned_block bigint;

-- FeesSplit / PaidOut / Released / TargetSet events read from the chain (cached for the dashboard).
create table if not exists public.treasury_events (
  id bigserial primary key,
  chain_id integer not null,
  splitter text not null,
  block_number bigint not null,
  log_index integer not null,
  tx_hash text not null,
  name text not null,
  bucket integer,
  amount_wei text,
  target_wei text,
  address text,
  block_time timestamptz,
  unique (chain_id, tx_hash, log_index)
);
create index if not exists treasury_events_splitter_idx on public.treasury_events (chain_id, splitter, block_number desc);

-- One buy per row; resumable: each step saves its tx hash before moving on.
create table if not exists public.treasury_jobs (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null,
  splitter text not null,
  bucket integer not null check (bucket between 2 and 7),
  status text not null check (status in ('releasing','released','bridging','bridged','buying','bought','delivering','delivered','failed')),
  release_from_block bigint,
  release_tx text,
  released_ape_wei text,
  relay_request_id text,
  bridge_tx text,
  bridge_expected_wei text,
  dest_chain_id integer,
  listing_hash text,
  nft_contract text,
  token_id text,
  price_wei text,
  buy_tx text,
  deliver_tx text,
  note text,
  error text,
  attempts integer not null default 0,
  last_ok_status text,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.treasury_jobs add column if not exists last_ok_status text;

-- Never two open jobs for the same bucket (so a bucket can't be released twice in parallel).
create unique index if not exists treasury_jobs_open_uidx on public.treasury_jobs (chain_id, splitter, bucket)
  where status not in ('delivered', 'failed');
create index if not exists treasury_jobs_created_idx on public.treasury_jobs (created_at desc);

-- What each keeper run did (dry-run plans included).
create table if not exists public.treasury_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null default 'cron',
  dry_run boolean not null default true,
  ok boolean,
  log jsonb not null default '[]'::jsonb
);
create index if not exists treasury_runs_started_idx on public.treasury_runs (started_at desc);

create table if not exists public.treasury_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  level text not null default 'error',
  message text not null,
  job_id uuid,
  acknowledged_at timestamptz
);
create index if not exists treasury_alerts_open_idx on public.treasury_alerts (created_at desc) where acknowledged_at is null;

-- A single-row lock so two keeper runs can't overlap; also spaces cron runs (min_gap) unless forced.
create table if not exists public.treasury_lock (
  id integer primary key check (id = 1),
  locked_until timestamptz,
  last_run_at timestamptz
);
insert into public.treasury_lock (id) values (1) on conflict (id) do nothing;

create or replace function public.treasury_try_lock(_hold_seconds integer, _min_gap_seconds integer, _force boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean;
begin
  update public.treasury_lock
     set locked_until = now() + make_interval(secs => _hold_seconds),
         last_run_at = now()
   where id = 1
     and (locked_until is null or locked_until < now())
     and (_force or last_run_at is null or last_run_at < now() - make_interval(secs => _min_gap_seconds))
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.treasury_unlock()
returns void
language sql
security definer
set search_path = public
as $$ update public.treasury_lock set locked_until = null where id = 1 $$;

do $$
declare t text;
begin
  foreach t in array array['treasury_events','treasury_jobs','treasury_runs','treasury_alerts','treasury_lock'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence public.treasury_events_id_seq to service_role;
revoke all on function public.treasury_try_lock(integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.treasury_unlock() from public, anon, authenticated;
grant execute on function public.treasury_try_lock(integer, integer, boolean) to service_role;
grant execute on function public.treasury_unlock() to service_role;

-- Every 10 minutes: call the keeper (pg_cron + pg_net). Each step is skipped (with a notice) if the
-- extensions aren't available; the keeper can also be run from Admin → Treasury → Run keeper now.
do $outer$ begin
  create extension if not exists pg_cron;
exception when others then raise notice 'pg_cron not available: %', sqlerrm; end $outer$;
do $outer$ begin
  create extension if not exists pg_net;
exception when others then raise notice 'pg_net not available: %', sqlerrm; end $outer$;
do $outer$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'gotcha-treasury-keeper';
  perform cron.schedule(
    'gotcha-treasury-keeper',
    '*/10 * * * *',
    $job$select net.http_post(
      url := 'https://apegamesgotcha.com/api/treasury-keeper',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{"trigger": "cron"}'::jsonb,
      timeout_milliseconds := 120000
    )$job$
  );
exception when others then raise notice 'keeper schedule skipped: %', sqlerrm; end $outer$;
