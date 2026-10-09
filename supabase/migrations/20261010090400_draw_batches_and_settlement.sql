-- ============================================================================
-- Draw batches, durable submissions and settlement (season leaderboard, part 5 of 7)
--
-- * Chainlink VRF stays the only outcome authority. The database records what
--   the contract drew; animation never decides anything.
-- * Each draw batch has an authenticated idempotency key, captures the season,
--   rule version, chain, contract, pool version and prize mapping at
--   reservation, and is serialised globally until the previous batch is
--   reconciled on-chain (MVP).
-- * Submissions are durable: the signed transaction and its hash are stored
--   before broadcast, so recovery resends the SAME transaction. Operator
--   nonces are claimed per batch.
-- * Credits are refunded only for proven pre-broadcast failure, a canonically
--   confirmed reverted request, or an on-chain cancellation (old contracts).
--   Timeouts never refund. A confirmed NO_PRIZE returns its credit once.
-- * Settlement (prize, entitlement, inventory, participation + bonus points)
--   is one replay-safe transaction using the captured rules.
-- * Pool publication is coordinated with submissions and never replenishes
--   consumed stock from stale database values.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Operational alerts (deduplicated by key while open)
-- ---------------------------------------------------------------------------
create table if not exists public.ops_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_key text not null,
  kind text not null check (kind in ('stuck_draw', 'vrf_funding', 'ledger_drift', 'inventory_drift', 'verification_failure',
                                     'budget_exhaustion', 'settlement_deadline', 'draw_conflict', 'reorg')),
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  message text not null,
  details jsonb not null default '{}'::jsonb,
  raised_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create unique index if not exists ops_alerts_open_key on public.ops_alerts (alert_key) where resolved_at is null;
revoke all on public.ops_alerts from anon;
revoke insert, update, delete, truncate on public.ops_alerts from authenticated, service_role;
grant select on public.ops_alerts to service_role;
alter table public.ops_alerts enable row level security;
drop policy if exists "ops alerts admin read" on public.ops_alerts;
create policy "ops alerts admin read" on public.ops_alerts for select to authenticated using (public.has_role(auth.uid(), 'admin'));

create or replace function public.raise_ops_alert(_key text, _kind text, _severity text, _message text, _details jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  insert into public.ops_alerts (alert_key, kind, severity, message, details)
  values (_key, _kind, _severity, left(_message, 1000), coalesce(_details, '{}'::jsonb))
  on conflict (alert_key) where resolved_at is null
  do update set last_seen_at = now(), message = excluded.message, details = excluded.details,
                severity = case when excluded.severity = 'critical' then 'critical' else public.ops_alerts.severity end
  returning id into v_id;
  return v_id;
end
$$;

create or replace function public.resolve_ops_alert(_alert_id uuid, _actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ops_alerts set resolved_at = now(), resolved_by = _actor where id = _alert_id and resolved_at is null;
  insert into public.audit_log (actor, action, details) values (_actor, 'ops.alert_resolved', jsonb_build_object('alert_id', _alert_id));
end
$$;

-- ---------------------------------------------------------------------------
-- Pool publications (odds + stock on the contract)
-- ---------------------------------------------------------------------------
create table if not exists public.pool_publications (
  id uuid primary key default gen_random_uuid(),
  chain_id int not null,
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  status text not null default 'prepared' check (status in ('prepared', 'sent', 'confirmed', 'failed')),
  weights bigint[] not null,
  remaining bigint[] not null,
  prize_ids uuid[] not null,
  tx_hash text,
  pool_version bigint,
  prepared_by uuid,
  prepared_at timestamptz not null default now(),
  confirmed_at timestamptz,
  error text
);
create unique index if not exists pool_publications_one_open on public.pool_publications (chain_id, contract_address) where status in ('prepared', 'sent');

create table if not exists public.prize_restocks (
  id uuid primary key default gen_random_uuid(),
  prize_id uuid not null references public.prizes (id),
  quantity int not null check (quantity > 0),
  evidence text not null check (length(btrim(evidence)) >= 5),
  created_by uuid not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Batches, submissions, nonces, entitlements
-- ---------------------------------------------------------------------------
create table if not exists public.draw_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  spin_ids uuid[] not null,
  spin_count int not null check (spin_count between 1 and 10),
  season_id uuid references public.seasons (id),
  rule_version_id uuid references public.season_rule_versions (id),
  chain_id int not null,
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  pool_version bigint not null,
  prize_map jsonb not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'signed', 'broadcast', 'confirmed', 'settled', 'reverted', 'refunded', 'conflict')),
  request_id text,
  request_tx text,
  request_block bigint,
  request_block_hash text,
  request_block_time timestamptz,
  request_confirmations int,
  last_error text,
  refund_reason text,
  submission_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz,
  unique (user_id, idempotency_key)
);
create index if not exists draw_batches_open_idx on public.draw_batches (created_at) where status in ('reserved', 'signed', 'broadcast', 'confirmed', 'conflict');

create table if not exists public.draw_submissions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.draw_batches (id),
  chain_id int not null,
  operator_address text not null check (operator_address ~ '^0x[0-9a-f]{40}$'),
  nonce bigint not null check (nonce >= 0),
  tx_hash text not null unique check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  raw_tx text not null check (raw_tx ~ '^0x[0-9a-f]+$'),
  status text not null default 'signed' check (status in ('signed', 'broadcast', 'mined', 'reverted', 'replaced')),
  broadcast_attempts int not null default 0,
  last_broadcast_at timestamptz,
  last_error text,
  block_number bigint,
  block_hash text,
  created_at timestamptz not null default now()
);
create index if not exists draw_submissions_batch_idx on public.draw_submissions (batch_id);

create table if not exists public.operator_nonces (
  chain_id int not null,
  operator_address text not null,
  nonce bigint not null,
  batch_id uuid not null references public.draw_batches (id),
  claimed_at timestamptz not null default now(),
  primary key (chain_id, operator_address, nonce)
);

create table if not exists public.prize_entitlements (
  spin_id uuid primary key,
  user_id uuid not null,
  prize_id uuid not null references public.prizes (id),
  fulfillment_type text not null,
  status text not null check (status in ('granted', 'owed', 'fulfilled', 'review')),
  unit_cost_usd numeric(14, 2),
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz,
  notes text
);
create index if not exists prize_entitlements_user_idx on public.prize_entitlements (user_id);

alter table public.spins
  add column if not exists batch_id uuid references public.draw_batches (id),
  add column if not exists season_id uuid references public.seasons (id),
  add column if not exists rule_version_id uuid references public.season_rule_versions (id),
  add column if not exists prize_onchain_index int,
  add column if not exists participation_points bigint,
  add column if not exists bonus_points bigint,
  add column if not exists scored boolean,
  add column if not exists score_note text,
  add column if not exists settled_evidence jsonb;
alter table public.spins drop constraint if exists spins_status_check;
alter table public.spins add constraint spins_status_check check (status in ('pending', 'fulfilled', 'refunded', 'no_prize'));
create index if not exists spins_batch_idx on public.spins (batch_id);
create index if not exists spins_user_season_idx on public.spins (user_id, season_id, status);

revoke all on public.draw_batches, public.draw_submissions, public.operator_nonces, public.pool_publications, public.prize_restocks from anon, authenticated;
revoke all on public.prize_entitlements from anon;
revoke insert, update, delete, truncate on public.prize_entitlements from authenticated;
revoke insert, update, delete, truncate on public.draw_batches, public.draw_submissions, public.operator_nonces,
  public.pool_publications, public.prize_restocks, public.prize_entitlements, public.spins from service_role;
grant select on public.draw_batches, public.draw_submissions, public.operator_nonces, public.pool_publications,
  public.prize_restocks, public.prize_entitlements, public.spins to service_role;
revoke insert, update, delete, truncate on public.spins from authenticated, anon;
alter table public.draw_batches enable row level security;
alter table public.draw_submissions enable row level security;
alter table public.operator_nonces enable row level security;
alter table public.pool_publications enable row level security;
alter table public.prize_restocks enable row level security;
alter table public.prize_entitlements enable row level security;
drop policy if exists "entitlements own read" on public.prize_entitlements;
create policy "entitlements own read" on public.prize_entitlements for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "pool publications admin read" on public.pool_publications;
create policy "pool publications admin read" on public.pool_publications for select to authenticated using (public.has_role(auth.uid(), 'admin'));

-- The old helpers allowed timeout-based refunds; they are replaced below.
drop function if exists public.begin_spins(uuid, int);
drop function if exists public.refund_spins(uuid[]);
drop function if exists public.finalize_spin(uuid, int, text, text);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public._current_season()
returns public.seasons
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.seasons s
   where s.status = 'active' and not s.is_legacy and now() >= s.starts_at and now() < s.ends_at
   limit 1
$$;

-- Points a prize would earn under a rules document (explicit override, including 0, wins).
create or replace function public.prize_bonus_for(_rules jsonb, _prize_id uuid, _rarity text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select coalesce((_rules -> 'prize_bonus_overrides' ->> _prize_id::text)::bigint,
                  (_rules -> 'rarity_bonus' ->> _rarity)::bigint, 0)
$$;

create or replace function public._unreconciled_batch_exists()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from public.draw_batches b where b.status in ('reserved', 'signed', 'broadcast', 'conflict')) $$;

create or replace function public._release_spin(_spin_id uuid, _status text, _note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_credit uuid;
begin
  -- pending → refunded / no_prize happens once; the credit becomes usable again exactly once.
  update public.spins s set status = _status, score_note = _note, scored = false, points = 0, fulfilled_at = coalesce(s.fulfilled_at, now())
   where s.id = _spin_id and s.status = 'pending'
  returning s.credit_id into v_credit;
  if v_credit is null then return; end if;
  update public.spin_credits c set used_spin_id = null where c.id = v_credit and c.used_spin_id = _spin_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Reservation
-- ---------------------------------------------------------------------------
create or replace function public.begin_draw_batch(
  _user_id uuid, _idempotency_key text, _count int, _chain_id int, _contract text, _pool_version bigint
)
returns public.draw_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.draw_batches;
  s public.seasons;
  pub public.pool_publications;
  v_cfg jsonb;
  v_vrf jsonb;
  v_daily_limit int;
  v_season_limit int;
  v_daily int;
  v_season int;
  v_credit uuid;
  v_spin uuid;
  v_ids uuid[] := '{}';
  v_map jsonb;
  i int;
begin
  if _user_id is null then raise exception 'Sign in first'; end if;
  if _count < 1 or _count > 10 then raise exception 'Invalid capsule count'; end if;
  select * into b from public.draw_batches x where x.user_id = _user_id and x.idempotency_key = _idempotency_key;
  if found then
    if b.spin_count <> _count then raise exception 'Idempotency key reused for a different request'; end if;
    return b; -- same request retried: same batch, no double reservation
  end if;

  -- One batch at a time across all players until the previous one is reconciled (MVP).
  perform pg_advisory_xact_lock(hashtextextended('draw_batches:global', 0));
  select * into b from public.draw_batches x where x.user_id = _user_id and x.idempotency_key = _idempotency_key;
  if found then return b; end if;
  if public._unreconciled_batch_exists() then
    raise exception 'The machine is finishing another draw. Try again in a few seconds.' using errcode = 'P0503';
  end if;

  select value into v_vrf from public.app_config where key = 'vrf';
  if not coalesce((v_vrf ->> 'enabled')::boolean, false) then raise exception 'Spins are paused while the on-chain draw is set up'; end if;
  if (v_vrf ->> 'chain_id')::int is distinct from _chain_id or lower(v_vrf ->> 'contract') is distinct from lower(_contract) then
    raise exception 'Draw configuration changed; try again';
  end if;
  if exists (select 1 from public.pool_publications p where p.chain_id = _chain_id and p.contract_address = lower(_contract) and p.status in ('prepared', 'sent')) then
    raise exception 'Prize odds are being updated on-chain. Try again in a minute.' using errcode = 'P0503';
  end if;
  select * into pub from public.pool_publications p
   where p.chain_id = _chain_id and p.contract_address = lower(_contract) and p.status = 'confirmed'
   order by p.confirmed_at desc limit 1;
  if pub.id is null or pub.pool_version is distinct from _pool_version then
    raise exception 'Prize odds on-chain differ from the published odds. Try again in a minute.' using errcode = 'P0503';
  end if;
  if exists (select 1 from public.prize_catalog_problems()) then raise exception 'Spins are paused: the prize catalogue needs verification'; end if;

  s := public._current_season();
  select value into v_cfg from public.app_config where key = 'spins';
  v_daily_limit := coalesce((s.rules ->> 'daily_spin_limit')::int, (v_cfg ->> 'daily_limit')::int, 10);
  v_season_limit := coalesce((s.rules ->> 'season_spin_limit')::int, (v_cfg ->> 'campaign_limit')::int, 100);

  perform pg_advisory_xact_lock(hashtextextended('begin_spins:' || _user_id::text, 0));
  select count(*) into v_daily from public.spins x
   where x.user_id = _user_id and x.status in ('pending', 'fulfilled') and x.created_at > now() - interval '24 hours';
  if s.id is not null then
    select count(*) into v_season from public.spins x where x.user_id = _user_id and x.season_id = s.id and x.status in ('pending', 'fulfilled');
  else
    select count(*) into v_season from public.spins x where x.user_id = _user_id and x.season_id is null and x.status in ('pending', 'fulfilled');
  end if;
  if v_daily + _count > v_daily_limit then raise exception 'Daily spin limit reached (% per 24 hours)', v_daily_limit; end if;
  if v_season + _count > v_season_limit then raise exception 'Season spin limit reached (% per season)', v_season_limit; end if;

  -- Prize mapping as published (index → prize) with the bonus each prize earns under the captured rules.
  select coalesce(jsonb_object_agg(p.onchain_index::text, jsonb_build_object(
           'prize_id', p.id, 'name', p.name, 'rarity', p.rarity, 'fulfillment_type', p.fulfillment_type,
           'bonus', case when s.id is null then 0 else public.prize_bonus_for(s.rules, p.id, p.rarity) end)), '{}'::jsonb)
    into v_map
    from public.prizes p
   where p.onchain_index is not null and p.id = any (pub.prize_ids);

  insert into public.draw_batches (user_id, idempotency_key, spin_ids, spin_count, season_id, rule_version_id, chain_id,
                                   contract_address, pool_version, prize_map)
  values (_user_id, _idempotency_key, '{}', _count, s.id, s.rule_version_id, _chain_id, lower(_contract), _pool_version, v_map)
  returning * into b;

  for i in 1.._count loop
    select c.id into v_credit from public.spin_credits c
     where c.user_id = _user_id and c.used_spin_id is null
     order by c.created_at, c.id limit 1 for update skip locked;
    if v_credit is null then raise exception 'Not enough spin credits'; end if;
    insert into public.spins (user_id, credit_id, status, batch_id, season_id, rule_version_id, chain_id, contract_address)
    values (_user_id, v_credit, 'pending', b.id, s.id, s.rule_version_id, _chain_id, lower(_contract))
    returning id into v_spin;
    update public.spin_credits c set used_spin_id = v_spin where c.id = v_credit;
    v_ids := v_ids || v_spin;
  end loop;
  update public.draw_batches x set spin_ids = v_ids where x.id = b.id returning * into b;
  insert into public.audit_log (actor, action, details)
  values (_user_id, 'draw.reserved', jsonb_build_object('batch_id', b.id, 'spins', _count, 'season_id', s.id, 'pool_version', _pool_version));
  return b;
end
$$;

-- Exactly one caller may sign/submit a freshly reserved batch (retries of the same request don't double-submit).
create or replace function public.claim_batch_submission(_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  update public.draw_batches set submission_claimed_at = now(), updated_at = now()
   where id = _batch_id and status = 'reserved' and submission_claimed_at is null
  returning id into v_id;
  return v_id is not null;
end
$$;

-- Work list for the settlement worker (all players, independent of any browser).
create or replace function public.open_draw_work(_limit int default 50)
returns setof public.draw_batches
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.draw_batches b
   where b.status in ('reserved', 'signed', 'broadcast', 'confirmed')
   order by b.created_at
   limit least(greatest(coalesce(_limit, 50), 1), 500)
$$;

-- Nothing was ever signed for this batch, so nothing can be on-chain: give the credits back.
create or replace function public.refund_batch_prebroadcast(_batch_id uuid, _reason text)
returns public.draw_batches
language plpgsql
security definer
set search_path = ''
as $$
declare b public.draw_batches; v_spin uuid;
begin
  select * into b from public.draw_batches where id = _batch_id for update;
  if not found then raise exception 'Unknown batch'; end if;
  if b.status = 'refunded' then return b; end if;
  if b.status <> 'reserved' or exists (select 1 from public.draw_submissions d where d.batch_id = b.id) then
    raise exception 'Batch % may have been broadcast; it can only be refunded after on-chain proof', b.id;
  end if;
  foreach v_spin in array b.spin_ids loop
    perform public._release_spin(v_spin, 'refunded', 'never sent: ' || left(coalesce(_reason, ''), 200));
  end loop;
  update public.draw_batches set status = 'refunded', refund_reason = 'pre-broadcast: ' || left(coalesce(_reason, ''), 300),
         reconciled_at = now(), updated_at = now()
   where id = b.id returning * into b;
  return b;
end
$$;

-- Store the signed transaction BEFORE it is broadcast (also used for fee replacements: same nonce).
create or replace function public.record_signed_submission(
  _batch_id uuid, _chain_id int, _operator text, _nonce bigint, _tx_hash text, _raw_tx text
)
returns public.draw_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare b public.draw_batches; d public.draw_submissions; v_owner uuid;
begin
  select * into b from public.draw_batches where id = _batch_id for update;
  if not found then raise exception 'Unknown batch'; end if;
  if b.status not in ('reserved', 'signed', 'broadcast') then raise exception 'Batch is % and cannot take a new submission', b.status; end if;
  if b.chain_id <> _chain_id then raise exception 'Submission chain differs from the batch chain'; end if;
  select x.batch_id into v_owner from public.operator_nonces x
   where x.chain_id = _chain_id and x.operator_address = lower(_operator) and x.nonce = _nonce;
  if v_owner is not null and v_owner <> _batch_id then raise exception 'Operator nonce % already belongs to another batch', _nonce; end if;
  if b.status <> 'reserved' and not exists (
       select 1 from public.draw_submissions x where x.batch_id = _batch_id and x.nonce = _nonce and x.operator_address = lower(_operator)) then
    raise exception 'A replacement must reuse the original nonce';
  end if;
  insert into public.operator_nonces (chain_id, operator_address, nonce, batch_id)
  values (_chain_id, lower(_operator), _nonce, _batch_id) on conflict do nothing;
  insert into public.draw_submissions (batch_id, chain_id, operator_address, nonce, tx_hash, raw_tx)
  values (_batch_id, _chain_id, lower(_operator), _nonce, lower(_tx_hash), lower(_raw_tx))
  on conflict (tx_hash) do nothing
  returning * into d;
  if d.id is null then select * into d from public.draw_submissions where tx_hash = lower(_tx_hash); end if;
  update public.draw_batches set status = case when status = 'reserved' then 'signed' else status end, updated_at = now()
   where id = _batch_id;
  return d;
end
$$;

create or replace function public.mark_submission_broadcast(_tx_hash text, _error text)
returns public.draw_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare d public.draw_submissions;
begin
  update public.draw_submissions
     set broadcast_attempts = broadcast_attempts + 1, last_broadcast_at = now(),
         status = case when _error is null and status = 'signed' then 'broadcast' else status end,
         last_error = left(_error, 500)
   where tx_hash = lower(_tx_hash)
  returning * into d;
  if not found then raise exception 'Unknown submission'; end if;
  if _error is null then
    update public.draw_batches set status = 'broadcast', updated_at = now() where id = d.batch_id and status = 'signed';
  end if;
  return d;
end
$$;

-- Record a mined request transaction (call again as confirmations grow; idempotent).
-- _spin_ids: spin ids decoded from SpinRequested events in the receipt (never from simulation).
create or replace function public.record_request_receipt(
  _tx_hash text, _success boolean, _block_number bigint, _block_hash text, _block_time timestamptz,
  _confirmations int, _min_confirmations int, _request_id text, _spin_ids uuid[]
)
returns public.draw_batches
language plpgsql
security definer
set search_path = ''
as $$
declare d public.draw_submissions; b public.draw_batches; v_spin uuid;
begin
  select * into d from public.draw_submissions where tx_hash = lower(_tx_hash) for update;
  if not found then raise exception 'Unknown submission'; end if;
  select * into b from public.draw_batches where id = d.batch_id for update;

  if b.status in ('confirmed', 'settled') then
    if b.request_tx <> d.tx_hash then
      update public.draw_batches set status = 'conflict', last_error = 'two request transactions mined for one batch', updated_at = now() where id = b.id returning * into b;
      perform public.raise_ops_alert('draw_conflict:' || b.id, 'draw_conflict', 'critical', 'Two request transactions mined for one draw batch',
                                     jsonb_build_object('batch_id', b.id, 'tx', d.tx_hash, 'recorded_tx', b.request_tx));
      return b;
    end if;
    if b.request_block_hash <> lower(_block_hash) then
      update public.draw_batches set status = 'conflict', last_error = 'request block hash changed (reorg)', updated_at = now() where id = b.id returning * into b;
      perform public.raise_ops_alert('reorg:' || b.id, 'reorg', 'critical', 'Request transaction moved blocks (reorg); draws paused',
                                     jsonb_build_object('batch_id', b.id, 'old_block', b.request_block_hash, 'new_block', lower(_block_hash)));
      return b;
    end if;
    update public.draw_batches set request_confirmations = greatest(coalesce(request_confirmations, 0), _confirmations), updated_at = now()
     where id = b.id returning * into b;
    return b;
  end if;
  if b.status not in ('signed', 'broadcast', 'reserved') then return b; end if;

  update public.draw_submissions set block_number = _block_number, block_hash = lower(_block_hash),
         status = case when _success then 'mined' else 'reverted' end
   where id = d.id;
  if _confirmations < _min_confirmations then
    return b; -- seen, not final yet: stays reserved
  end if;

  if not _success then
    foreach v_spin in array b.spin_ids loop
      perform public._release_spin(v_spin, 'refunded', 'request reverted on-chain');
    end loop;
    update public.draw_batches set status = 'refunded', request_tx = d.tx_hash, request_block = _block_number,
           request_block_hash = lower(_block_hash), request_block_time = _block_time, request_confirmations = _confirmations,
           refund_reason = 'request transaction reverted (canonically confirmed)', reconciled_at = now(), updated_at = now()
     where id = b.id returning * into b;
    return b;
  end if;

  if _request_id is null or _request_id !~ '^[0-9]{1,78}$' then raise exception 'Request id missing from the confirmed events'; end if;
  if (select array_agg(x order by x) from unnest(coalesce(_spin_ids, '{}')) x) is distinct from
     (select array_agg(x order by x) from unnest(b.spin_ids) x) then
    update public.draw_batches set status = 'conflict', last_error = 'SpinRequested events do not match the batch', updated_at = now()
     where id = b.id returning * into b;
    perform public.raise_ops_alert('draw_conflict:' || b.id, 'draw_conflict', 'critical', 'Confirmed request events do not match the reserved spins',
                                   jsonb_build_object('batch_id', b.id, 'tx', d.tx_hash));
    return b;
  end if;
  update public.draw_submissions set status = 'replaced' where batch_id = b.id and id <> d.id and status in ('signed', 'broadcast');
  update public.draw_batches set status = 'confirmed', request_id = _request_id, request_tx = d.tx_hash, request_block = _block_number,
         request_block_hash = lower(_block_hash), request_block_time = _block_time, request_confirmations = _confirmations,
         reconciled_at = now(), updated_at = now()
   where id = b.id returning * into b;
  update public.spins set request_tx = d.tx_hash, vrf_request_id = _request_id where id = any (b.spin_ids);
  return b;
end
$$;

create or replace function public.flag_batch_conflict(_batch_id uuid, _reason text)
returns public.draw_batches
language plpgsql
security definer
set search_path = ''
as $$
declare b public.draw_batches;
begin
  update public.draw_batches set status = 'conflict', last_error = left(_reason, 500), updated_at = now()
   where id = _batch_id and status in ('reserved', 'signed', 'broadcast', 'confirmed')
  returning * into b;
  if found then
    perform public.raise_ops_alert('draw_conflict:' || _batch_id, 'draw_conflict', 'critical', 'Draw batch needs review: ' || left(_reason, 300),
                                   jsonb_build_object('batch_id', _batch_id));
  else
    select * into b from public.draw_batches where id = _batch_id;
  end if;
  return b;
end
$$;

-- Admin resolution of a conflicted batch after re-checking the chain (the server gathers the evidence).
-- 'confirmed': the request is on-chain (worker re-records the receipt next). 'not_onchain': every spin id
-- reads None on the contract, no submission has a receipt, and the operator nonce was consumed by another
-- transaction at finalized depth — so the request can never be mined and the credits are returned.
create or replace function public.resolve_batch_conflict(_batch_id uuid, _resolution text, _evidence jsonb, _actor uuid)
returns public.draw_batches
language plpgsql
security definer
set search_path = ''
as $$
declare b public.draw_batches; v_spin uuid;
begin
  if _actor is null then raise exception 'Resolution needs an accountable actor'; end if;
  select * into b from public.draw_batches where id = _batch_id for update;
  if b.status <> 'conflict' then raise exception 'Batch is not in conflict'; end if;
  if _resolution = 'confirmed' then
    update public.draw_batches set status = case when request_id is null then 'broadcast' else 'confirmed' end,
           request_block_hash = case when request_id is null then null else request_block_hash end,
           last_error = null, updated_at = now()
     where id = b.id returning * into b;
  elsif _resolution = 'not_onchain' then
    if not coalesce((_evidence ->> 'all_spins_none')::boolean, false)
       or not coalesce((_evidence ->> 'no_receipts')::boolean, false)
       or not coalesce((_evidence ->> 'nonce_consumed_by_other_tx_final')::boolean, false) then
      raise exception 'Not enough on-chain proof to return these credits';
    end if;
    foreach v_spin in array b.spin_ids loop
      perform public._release_spin(v_spin, 'refunded', 'request provably never mined');
    end loop;
    update public.draw_batches set status = 'refunded', refund_reason = 'proven not on-chain', reconciled_at = now(), updated_at = now()
     where id = b.id returning * into b;
  else
    raise exception 'Unknown resolution';
  end if;
  update public.ops_alerts set resolved_at = now(), resolved_by = _actor
   where alert_key in ('draw_conflict:' || b.id, 'reorg:' || b.id) and resolved_at is null;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'draw.conflict_resolved', jsonb_build_object('batch_id', b.id, 'resolution', _resolution, 'evidence', _evidence));
  return b;
end
$$;

-- ---------------------------------------------------------------------------
-- Settlement of one spin from the contract's recorded outcome (replay-safe)
-- _chain_status mirrors GotchaVRF.Status: 0 None, 1 Pending, 2 Fulfilled, 3 Cancelled (old contracts only)
-- ---------------------------------------------------------------------------
create or replace function public.settle_spin(
  _spin_id uuid, _chain_status int, _prize_index int, _random_word text, _request_id text, _evidence jsonb
)
returns public.spins
language plpgsql
security definer
set search_path = ''
as $$
declare
  sp public.spins;
  b public.draw_batches;
  se public.seasons;
  rv public.season_rule_versions;
  p public.prizes;
  m jsonb;
  v_part bigint := 0;
  v_bonus bigint := 0;
  v_scored boolean := false;
  v_note text;
  v_cost numeric;
  v_ent_status text;
begin
  select * into sp from public.spins where id = _spin_id for update;
  if not found then raise exception 'Unknown spin'; end if;
  if sp.status <> 'pending' then return sp; end if;
  select * into b from public.draw_batches where id = sp.batch_id for update;
  if not found then raise exception 'Spin has no draw batch'; end if;
  if b.status = 'conflict' then return sp; end if; -- paused for review
  if b.status not in ('confirmed', 'settled') or b.request_id is null then raise exception 'Request is not confirmed on-chain yet'; end if;
  if _request_id is distinct from b.request_id then
    -- Don't guess: pause the batch for review (the flag must persist, so return instead of raising).
    perform public.flag_batch_conflict(b.id, 'contract reports a different request id for spin ' || sp.id);
    return sp;
  end if;

  if _chain_status = 3 then
    perform public._release_spin(sp.id, 'refunded', 'request cancelled on-chain (legacy contract)');
  elsif _chain_status <> 2 then
    raise exception 'Spin % is not fulfilled on-chain yet', sp.id;
  elsif _prize_index = 255 then
    perform public._release_spin(sp.id, 'no_prize', 'pool was empty when Chainlink answered');
    update public.spins set random_word = _random_word, settled_evidence = _evidence where id = sp.id;
  else
    m := b.prize_map -> _prize_index::text;
    if m is null then
      perform public.flag_batch_conflict(b.id, 'prize index ' || _prize_index || ' is not in the captured prize mapping');
      return sp;
    end if;
    select * into p from public.prizes where id = (m ->> 'prize_id')::uuid for update;
    if p.inventory is not null then
      if p.inventory > 0 then
        update public.prizes set inventory = inventory - 1 where id = p.id;
      else
        perform public.raise_ops_alert('inventory_drift:' || p.id, 'inventory_drift', 'critical',
          'Chainlink awarded ' || p.name || ' but the database shows no stock left. The entitlement is kept; reconcile stock.',
          jsonb_build_object('prize_id', p.id, 'spin_id', sp.id));
      end if;
    end if;
    v_cost := public.prize_unit_cost_usd(p.id);
    v_ent_status := case m ->> 'fulfillment_type' when 'fulfillment_required' then 'owed' when 'unclassified' then 'review' else 'granted' end;
    insert into public.prize_entitlements (spin_id, user_id, prize_id, fulfillment_type, status, unit_cost_usd)
    values (sp.id, sp.user_id, p.id, m ->> 'fulfillment_type', v_ent_status, v_cost)
    on conflict (spin_id) do nothing;
    update public.sponsored_reservations r
       set status = 'consumed', actual_usd = coalesce(v_cost + public.marginal_spin_cost_usd(), r.reserved_usd), settled_at = now()
     where r.credit_id = sp.credit_id and r.status = 'reserved';

    -- Seasonal scoring: only if the request was canonically confirmed inside the season window.
    if sp.season_id is not null then
      select * into se from public.seasons where id = sp.season_id for share;
      select * into rv from public.season_rule_versions where id = sp.rule_version_id;
      if se.status not in ('active', 'settling') then
        v_note := 'season closed';
      elsif b.request_block_time is null or b.request_block_time < se.starts_at or b.request_block_time >= se.ends_at then
        v_note := 'request confirmed outside the season window';
      else
        v_part := coalesce((rv.rules ->> 'participation_points')::bigint, 0);
        v_bonus := coalesce((m ->> 'bonus')::bigint, 0);
        perform public._award_points(se.id, sp.user_id, 'spin', sp.id::text, 'participation', v_part, rv.id, now(),
                                     jsonb_build_object('batch_id', b.id, 'request_id', b.request_id), null);
        perform public._award_points(se.id, sp.user_id, 'spin', sp.id::text, 'prize_bonus', v_bonus, rv.id, now(),
                                     jsonb_build_object('prize_id', p.id, 'rarity', m ->> 'rarity', 'onchain_index', _prize_index), null);
        v_scored := true;
      end if;
    else
      v_note := 'no active season when reserved';
    end if;

    update public.spins set status = 'fulfilled', prize_id = p.id, prize_name = m ->> 'name', rarity = m ->> 'rarity',
           prize_onchain_index = _prize_index, participation_points = v_part, bonus_points = v_bonus,
           points = (v_part + v_bonus)::int, scored = v_scored, score_note = v_note,
           random_word = _random_word, vrf_request_id = coalesce(vrf_request_id, _request_id), fulfilled_at = now(),
           settled_evidence = _evidence
     where id = sp.id;
  end if;

  if not exists (select 1 from public.spins x where x.batch_id = b.id and x.status = 'pending') then
    update public.draw_batches set status = 'settled', updated_at = now() where id = b.id and status = 'confirmed';
  end if;
  select * into sp from public.spins where id = _spin_id;
  return sp;
end
$$;

-- ---------------------------------------------------------------------------
-- Prize catalogue and pool publication
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_prize(
  _id uuid, _name text, _rarity text, _weight int, _inventory int, _active boolean, _fulfillment_type text, _actor uuid
)
returns public.prizes
language plpgsql
security definer
set search_path = ''
as $$
declare p public.prizes;
begin
  if _actor is null then raise exception 'Prize edits need an accountable actor'; end if;
  if _rarity not in ('common', 'rare', 'epic', 'legendary') then raise exception 'Unknown rarity'; end if;
  if _weight < 0 or _weight > 1000000 then raise exception 'Weight must be 0-1000000'; end if;
  if _inventory is not null and _inventory < 0 then raise exception 'Stock cannot be negative'; end if;
  if _id is null then
    insert into public.prizes (name, rarity, weight, points, inventory, active, fulfillment_type)
    values (btrim(_name), _rarity, _weight, 0, _inventory, _active, _fulfillment_type) returning * into p;
  else
    select * into p from public.prizes where id = _id for update;
    if not found then raise exception 'Unknown prize'; end if;
    if p.onchain_index is not null and (
         (_inventory is null and p.inventory is not null)
      or (_inventory is not null and p.inventory is not null and _inventory > p.inventory)) then
      raise exception 'Stock of a published prize can only go up through an audited restock';
    end if;
    update public.prizes set name = btrim(_name), rarity = _rarity, weight = _weight, inventory = _inventory,
           active = _active, fulfillment_type = _fulfillment_type
     where id = _id returning * into p;
  end if;
  insert into public.audit_log (actor, action, details) values (_actor, 'prize.upserted', to_jsonb(p));
  return p;
end
$$;

create or replace function public.restock_prize(_prize_id uuid, _quantity int, _evidence text, _actor uuid)
returns public.prizes
language plpgsql
security definer
set search_path = ''
as $$
declare p public.prizes;
begin
  if _actor is null then raise exception 'Restocks need an accountable actor'; end if;
  select * into p from public.prizes where id = _prize_id for update;
  if not found then raise exception 'Unknown prize'; end if;
  if p.inventory is null then raise exception 'Unlimited prizes are not restocked'; end if;
  insert into public.prize_restocks (prize_id, quantity, evidence, created_by) values (_prize_id, _quantity, btrim(_evidence), _actor);
  update public.prizes set inventory = inventory + _quantity where id = _prize_id returning * into p;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'prize.restocked', jsonb_build_object('prize_id', _prize_id, 'quantity', _quantity, 'evidence', btrim(_evidence)));
  return p;
end
$$;

-- Prepare the arrays to publish. Requires: nothing in flight, chain reconciled, no stale stock.
-- _chain_remaining: the contract's current getPool() remaining values by index (empty before the first publication).
create or replace function public.prepare_pool_publication(
  _chain_id int, _contract text, _chain_pool_version bigint, _chain_remaining bigint[], _chain_pending int, _actor uuid
)
returns public.pool_publications
language plpgsql
security definer
set search_path = ''
as $$
declare
  last public.pool_publications;
  pub public.pool_publications;
  p record;
  v_next int;
  v_weights bigint[] := '{}';
  v_remaining bigint[] := '{}';
  v_ids uuid[] := '{}';
  v_allowed bigint;
  v_restocked bigint;
  n int;
  i int;
begin
  perform pg_advisory_xact_lock(hashtextextended('draw_batches:global', 0));
  if _chain_pending <> 0 then raise exception 'The contract still has % pending request(s)', _chain_pending; end if;
  if public._unreconciled_batch_exists() then raise exception 'A draw batch is still being reconciled'; end if;
  if exists (select 1 from public.spins s where s.status = 'pending') then raise exception 'Settle pending spins before changing the pool'; end if;
  if exists (select 1 from public.pool_publications x where x.chain_id = _chain_id and x.contract_address = lower(_contract) and x.status in ('prepared', 'sent')) then
    raise exception 'Another publication is in progress';
  end if;
  if exists (select 1 from public.prize_catalog_problems()) then raise exception 'Fix the prize catalogue problems first'; end if;

  select * into last from public.pool_publications x
   where x.chain_id = _chain_id and x.contract_address = lower(_contract) and x.status = 'confirmed'
   order by x.confirmed_at desc limit 1;
  if last.id is not null and last.pool_version is distinct from _chain_pool_version then
    raise exception 'The contract pool (v%) differs from the last confirmed publication (v%); reconcile first', _chain_pool_version, last.pool_version;
  end if;

  -- Stable indexes: new active prizes are appended; existing indexes never move.
  select coalesce(max(onchain_index), -1) + 1 into v_next from public.prizes;
  for p in select * from public.prizes where onchain_index is null and active and weight > 0 order by created_at, id for update loop
    if v_next >= 32 then raise exception 'The contract holds at most 32 prizes'; end if;
    update public.prizes set onchain_index = v_next where id = p.id;
    v_next := v_next + 1;
  end loop;

  select coalesce(max(onchain_index), -1) + 1 into n from public.prizes;
  if n = 0 then raise exception 'No active prizes to publish'; end if;
  for i in 0..n - 1 loop
    select * into p from public.prizes where onchain_index = i;
    if not found then
      v_weights := v_weights || 0::bigint; v_remaining := v_remaining || 0::bigint; v_ids := v_ids || '00000000-0000-0000-0000-000000000000'::uuid;
      continue;
    end if;
    if p.inventory is not null and last.id is not null and i < coalesce(array_length(_chain_remaining, 1), 0) and _chain_remaining[i + 1] <> 4294967295 then
      -- Never replenish consumed stock from stale DB values: only an audited restock may raise it.
      select coalesce(sum(r.quantity), 0) into v_restocked from public.prize_restocks r
       where r.prize_id = p.id and r.created_at > last.confirmed_at;
      v_allowed := _chain_remaining[i + 1] + v_restocked;
      if p.inventory > v_allowed then
        perform public.raise_ops_alert('inventory_drift:' || p.id, 'inventory_drift', 'critical',
          'Database stock for ' || p.name || ' is higher than the contract allows; settle draws or restock with evidence.',
          jsonb_build_object('prize_id', p.id, 'db', p.inventory, 'chain', _chain_remaining[i + 1], 'restocked', v_restocked));
        raise exception 'Stock for % (%) exceeds on-chain remaining (%) plus audited restocks (%)', p.name, p.inventory, _chain_remaining[i + 1], v_restocked;
      end if;
    end if;
    v_weights := v_weights || (case when p.active then p.weight else 0 end)::bigint;
    v_remaining := v_remaining || coalesce(p.inventory::bigint, 4294967295);
    v_ids := v_ids || p.id;
  end loop;

  insert into public.pool_publications (chain_id, contract_address, weights, remaining, prize_ids, prepared_by)
  values (_chain_id, lower(_contract), v_weights, v_remaining, v_ids, _actor)
  returning * into pub;
  return pub;
end
$$;

create or replace function public.mark_pool_publication_sent(_publication_id uuid, _tx_hash text)
returns public.pool_publications
language plpgsql
security definer
set search_path = ''
as $$
declare pub public.pool_publications;
begin
  update public.pool_publications set status = 'sent', tx_hash = lower(_tx_hash)
   where id = _publication_id and status = 'prepared' returning * into pub;
  if not found then raise exception 'Publication is not awaiting a transaction'; end if;
  return pub;
end
$$;

-- Confirm from what the contract now reports (getPool + poolVersion), never from what was intended.
create or replace function public.confirm_pool_publication(_publication_id uuid, _pool_version bigint, _chain_weights bigint[], _chain_remaining bigint[], _actor uuid)
returns public.pool_publications
language plpgsql
security definer
set search_path = ''
as $$
declare pub public.pool_publications;
begin
  select * into pub from public.pool_publications where id = _publication_id for update;
  if pub.status not in ('prepared', 'sent') then raise exception 'Publication already %', pub.status; end if;
  if pub.weights is distinct from _chain_weights or pub.remaining is distinct from _chain_remaining then
    raise exception 'The contract pool does not match this publication';
  end if;
  update public.pool_publications set status = 'confirmed', pool_version = _pool_version, confirmed_at = now()
   where id = pub.id returning * into pub;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'vrf.pool_published', jsonb_build_object('publication_id', pub.id, 'pool_version', _pool_version, 'tx', pub.tx_hash,
          'weights', pub.weights, 'remaining', pub.remaining));
  return pub;
end
$$;

-- Only when the setPool transaction provably did not change the pool (never sent, or reverted).
create or replace function public.fail_pool_publication(_publication_id uuid, _error text, _actor uuid)
returns public.pool_publications
language plpgsql
security definer
set search_path = ''
as $$
declare pub public.pool_publications;
begin
  update public.pool_publications set status = 'failed', error = left(_error, 500)
   where id = _publication_id and status in ('prepared', 'sent') returning * into pub;
  if not found then raise exception 'Publication is not open'; end if;
  insert into public.audit_log (actor, action, details) values (_actor, 'vrf.pool_publication_failed', jsonb_build_object('publication_id', pub.id, 'error', pub.error));
  return pub;
end
$$;

-- ---------------------------------------------------------------------------
-- Narrow machine readiness for an ordinary signed-in player (no config table access needed)
-- ---------------------------------------------------------------------------
create or replace function public.machine_readiness(_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vrf jsonb;
  pub public.pool_publications;
  s public.seasons;
  v_reason text;
  v_odds jsonb;
  v_daily int;
  v_season_used int;
  v_cfg jsonb;
  v_expected_bonus numeric;
begin
  select value into v_vrf from public.app_config where key = 'vrf';
  select value into v_cfg from public.app_config where key = 'spins';
  s := public._current_season();
  if not coalesce((v_vrf ->> 'enabled')::boolean, false) or coalesce(v_vrf ->> 'contract', '') !~* '^0x[0-9a-f]{40}$' then
    v_reason := 'The on-chain prize draw is being switched on. Your spins are saved.';
  else
    select * into pub from public.pool_publications p
     where p.chain_id = (v_vrf ->> 'chain_id')::int and p.contract_address = lower(v_vrf ->> 'contract') and p.status = 'confirmed'
     order by p.confirmed_at desc limit 1;
    if pub.id is null then v_reason := 'Prize odds haven''t been published on-chain yet. Your spins are saved.';
    elsif exists (select 1 from public.pool_publications p where p.chain_id = pub.chain_id and p.contract_address = pub.contract_address and p.status in ('prepared', 'sent')) then
      v_reason := 'Prize odds are being updated on-chain. Try again in a minute.';
    elsif exists (select 1 from public.draw_batches b where b.status = 'conflict') then
      v_reason := 'Draws are paused while an on-chain request is reviewed. Your spins are saved.';
    elsif exists (select 1 from public.prize_catalog_problems()) then
      v_reason := 'Draws are paused while the prize list is verified. Your spins are saved.';
    elsif not exists (select 1 from public.available_prize_pool() a where a.onchain_index is not null) then
      v_reason := 'All prizes have been claimed.';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('prize_id', a.prize_id, 'name', a.name, 'rarity', a.rarity,
           'probability', round(a.probability, 6), 'remaining', a.inventory,
           'bonus', case when s.id is null then null else public.prize_bonus_for(s.rules, a.prize_id, a.rarity) end)
           order by a.onchain_index), '[]'::jsonb),
         sum(a.probability * case when s.id is null then 0 else public.prize_bonus_for(s.rules, a.prize_id, a.rarity) end)
    into v_odds, v_expected_bonus
    from public.available_prize_pool() a where a.onchain_index is not null;

  select count(*) into v_daily from public.spins x where x.user_id = _user_id and x.status in ('pending', 'fulfilled') and x.created_at > now() - interval '24 hours';
  select count(*) into v_season_used from public.spins x
   where x.user_id = _user_id and x.status in ('pending', 'fulfilled') and x.season_id is not distinct from s.id;

  return jsonb_build_object(
    'open', v_reason is null,
    'reason', v_reason,
    'odds', v_odds,
    'season', case when s.id is null then null else jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'ends_at', s.ends_at,
                    'participation_points', (s.rules ->> 'participation_points')::bigint) end,
    'expected_bonus_per_spin', case when s.id is null then null else round(coalesce(v_expected_bonus, 0), 2) end,
    'expected_points_per_spin', case when s.id is null then null else round(coalesce(v_expected_bonus, 0) + (s.rules ->> 'participation_points')::numeric, 2) end,
    'daily_limit', coalesce((s.rules ->> 'daily_spin_limit')::int, (v_cfg ->> 'daily_limit')::int, 10),
    'daily_used', v_daily,
    'season_limit', coalesce((s.rules ->> 'season_spin_limit')::int, (v_cfg ->> 'campaign_limit')::int, 100),
    'season_used', v_season_used,
    'chain_id', (v_vrf ->> 'chain_id')::int,
    'explorer_url', v_vrf ->> 'explorer_url'
  );
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.raise_ops_alert(text, text, text, text, jsonb)', 'public.resolve_ops_alert(uuid, uuid)',
    'public.begin_draw_batch(uuid, text, int, int, text, bigint)', 'public.refund_batch_prebroadcast(uuid, text)',
    'public.record_signed_submission(uuid, int, text, bigint, text, text)', 'public.mark_submission_broadcast(text, text)',
    'public.record_request_receipt(text, boolean, bigint, text, timestamptz, int, int, text, uuid[])',
    'public.flag_batch_conflict(uuid, text)', 'public.resolve_batch_conflict(uuid, text, jsonb, uuid)',
    'public.settle_spin(uuid, int, int, text, text, jsonb)', 'public.admin_upsert_prize(uuid, text, text, int, int, boolean, text, uuid)',
    'public.restock_prize(uuid, int, text, uuid)',
    'public.prepare_pool_publication(int, text, bigint, bigint[], int, uuid)', 'public.mark_pool_publication_sent(uuid, text)',
    'public.confirm_pool_publication(uuid, bigint, bigint[], bigint[], uuid)', 'public.fail_pool_publication(uuid, text, uuid)',
    'public.machine_readiness(uuid)', 'public.claim_batch_submission(uuid)', 'public.open_draw_work(int)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function public._current_season() from public, anon, authenticated, service_role;
revoke all on function public._unreconciled_batch_exists() from public, anon, authenticated, service_role;
revoke all on function public._release_spin(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.prize_bonus_for(jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.prize_bonus_for(jsonb, uuid, text) to service_role;

update public.app_config
   set value = value || '{"min_confirmations": 3, "max_batch": 5, "rpc_by_chain": {}}'::jsonb
 where key = 'vrf' and not (value ? 'min_confirmations');
