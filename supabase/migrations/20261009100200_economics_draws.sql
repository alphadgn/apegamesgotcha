-- ============================================================================
-- Economic controls, operational alerts, and replay-safe Chainlink VRF draw settlement.
--
--  * Prizes are points-only or fulfillment-required. Unlimited stock is only valid for cost-free
--    digital outcomes; real prizes need finite, verified stock or reserved funding.
--  * Unknown costs are "unverified" (NULL), never zero. Expected/worst-case draw costs are computed
--    from the prizes that are actually still available.
--  * Burn / grant / free-entry spins are funded from sponsored budgets, reserved atomically.
--  * Draw batches are idempotent per player key, serialized globally until reconciled, and keep the
--    exact signed transaction so recovery re-sends the SAME transaction. Credits are refunded only on
--    proven pre-broadcast failure, a canonically confirmed revert, or a provably dropped nonce.
--  * Season, rule version and the prize->bonus mapping are captured when credits are reserved.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Operational alerts
-- ---------------------------------------------------------------------------
create table if not exists public.ops_alerts (
  id bigserial primary key,
  kind text not null,
  subject text not null default '',
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  message text not null,
  details jsonb not null default '{}'::jsonb,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  occurrences int not null default 1,
  resolved_at timestamptz,
  resolved_by uuid
);
create unique index if not exists ops_alerts_open on public.ops_alerts (kind, subject) where resolved_at is null;
alter table public.ops_alerts enable row level security;
revoke all on public.ops_alerts from public, anon, authenticated;
grant select on public.ops_alerts to authenticated;
grant all on public.ops_alerts to service_role;
grant usage on sequence public.ops_alerts_id_seq to service_role;
drop policy if exists "alerts admin read" on public.ops_alerts;
create policy "alerts admin read" on public.ops_alerts for select to authenticated using (public.is_admin());

create or replace function public.raise_alert(_kind text, _subject text, _severity text, _message text, _details jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  update public.ops_alerts
     set last_seen = now(), occurrences = occurrences + 1, message = _message, details = coalesce(_details, '{}'::jsonb),
         severity = case when _severity = 'critical' or severity = 'critical' then 'critical' else _severity end
   where kind = _kind and subject = coalesce(_subject, '') and resolved_at is null
  returning id into v_id;
  if v_id is null then
    insert into public.ops_alerts (kind, subject, severity, message, details)
    values (_kind, coalesce(_subject, ''), _severity, _message, coalesce(_details, '{}'::jsonb))
    returning id into v_id;
  end if;
  return v_id;
end
$$;

create or replace function public.resolve_alert(_kind text, _subject text, _actor uuid default null)
returns int
language sql
security definer
set search_path = ''
as $$
  with r as (
    update public.ops_alerts set resolved_at = now(), resolved_by = _actor
     where kind = _kind and subject = coalesce(_subject, '') and resolved_at is null
    returning 1)
  select count(*)::int from r
$$;

-- ---------------------------------------------------------------------------
-- Prize classification and costs
-- ---------------------------------------------------------------------------
alter table public.prizes
  add column if not exists kind text not null default 'points_only',
  add column if not exists unit_cost_usd numeric(14, 4),
  add column if not exists cost_verified boolean not null default false,
  add column if not exists stock_verified boolean not null default false,
  add column if not exists economics_notes text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'prizes_kind_check') then
    alter table public.prizes add constraint prizes_kind_check check (kind in ('points_only', 'fulfillment_required'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prizes_unit_cost_nonneg') then
    alter table public.prizes add constraint prizes_unit_cost_nonneg check (unit_cost_usd is null or unit_cost_usd >= 0);
  end if;
end $$;

-- The two seeded real-world prizes need fulfillment; their seeded stock (500 / 20) is NOT verified.
update public.prizes set kind = 'fulfillment_required', stock_verified = false
 where name in ('Charleston VIP Pass', 'Gold Crate') and kind = 'points_only' and inventory is not null;

-- Clients see what the machine shows, not internal cost data.
revoke select on public.prizes from anon, authenticated;
grant select (id, name, rarity, weight, points, inventory, active, created_at, onchain_index, kind) on public.prizes to anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'prizes_real_need_stock') then
    alter table public.prizes add constraint prizes_real_need_stock check (kind = 'points_only' or inventory is not null);
  end if;
end $$;

-- Stock changes made deliberately by an admin (restocks). Publication never "refills" consumed stock
-- from stale database values; only these audited events can raise remaining stock above the chain's.
create table if not exists public.prize_stock_events (
  id bigserial primary key,
  prize_id uuid not null references public.prizes(id),
  delta int not null check (delta <> 0),
  reason text not null check (char_length(btrim(reason)) >= 3),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  published_pool_version bigint
);
alter table public.prize_stock_events enable row level security;
revoke all on public.prize_stock_events from public, anon, authenticated;
grant all on public.prize_stock_events to service_role;
grant usage on sequence public.prize_stock_events_id_seq to service_role;

create table if not exists public.operating_costs (
  key text primary key check (key in ('vrf_per_spin', 'gas_per_spin', 'provider_per_spin', 'hosting_monthly', 'support_monthly')),
  amount_usd numeric(14, 4) check (amount_usd is null or amount_usd >= 0),
  verified boolean not null default false,
  evidence text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.operating_costs (key) values
  ('vrf_per_spin'), ('gas_per_spin'), ('provider_per_spin'), ('hosting_monthly'), ('support_monthly')
on conflict (key) do nothing;

-- Actual spending, as it happens (acquisition, fulfillment, shipping, gas, VRF, provider, hosting, support).
create table if not exists public.cost_entries (
  id bigserial primary key,
  category text not null check (category in ('prize_acquisition', 'fulfillment', 'shipping', 'gas', 'vrf', 'provider', 'hosting', 'support', 'other')),
  amount_usd numeric(14, 2) check (amount_usd is null or amount_usd >= 0),
  verified boolean not null default false,
  occurred_at timestamptz not null default now(),
  reference text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- Money set aside: the prize reserve and the sponsored-spin budgets. Append-only.
create table if not exists public.funding_events (
  id bigserial primary key,
  account text not null check (account in ('prize_reserve', 'sponsored_burn', 'sponsored_grant', 'sponsored_free_entry')),
  amount_usd numeric(14, 2) not null check (amount_usd <> 0),
  evidence text not null check (char_length(btrim(evidence)) >= 3),
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sponsored_budgets (
  source text primary key check (source in ('burn', 'grant', 'free_entry')),
  committed_usd numeric(16, 4) not null default 0 check (committed_usd >= 0),
  low_water_usd numeric(14, 2) not null default 0 check (low_water_usd >= 0),
  paused boolean not null default true,
  pause_reason text default 'Not funded yet',
  updated_at timestamptz not null default now()
);
insert into public.sponsored_budgets (source) values ('burn'), ('grant'), ('free_entry') on conflict do nothing;

create table if not exists public.prize_fulfillments (
  spin_id uuid primary key references public.spins(id),
  user_id uuid not null,
  prize_id uuid not null references public.prizes(id),
  status text not null default 'pending' check (status in ('pending', 'shipped', 'delivered', 'cancelled')),
  unit_cost_usd numeric(14, 4),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['operating_costs', 'cost_entries', 'funding_events', 'sponsored_budgets', 'prize_fulfillments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists "admin read" on public.%I', t);
    execute format('create policy "admin read" on public.%I for select to authenticated using (public.is_admin())', t);
  end loop;
end $$;
grant usage on sequence public.cost_entries_id_seq, public.funding_events_id_seq to service_role;
drop policy if exists "admin read" on public.prize_fulfillments;
create policy "own or admin read" on public.prize_fulfillments for select to authenticated using (user_id = auth.uid() or public.is_admin());

create or replace function public.funding_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'funding_events is append-only; record a withdrawal instead';
end
$$;
drop trigger if exists funding_events_immutable on public.funding_events;
create trigger funding_events_immutable before update or delete on public.funding_events
  for each row execute function public.funding_immutable();

-- Credits: how each one is funded.
alter table public.spin_credits
  add column if not exists funding text not null default 'legacy',
  add column if not exists reserved_usd numeric(14, 4),
  add column if not exists metadata jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'spin_credits_funding_check') then
    alter table public.spin_credits add constraint spin_credits_funding_check check (funding in ('legacy', 'purchase', 'sponsored'));
  end if;
end $$;

alter table public.spin_purchases
  add column if not exists quoted_usd numeric(14, 2),
  add column if not exists ape_usd_rate text;

-- Problems that block publishing the pool, activating a season or opening purchases.
create or replace function public.prize_pool_issues()
returns table (prize_id uuid, prize_name text, issue text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.name, i.issue
    from public.prizes p
    cross join lateral (values
      (case when p.inventory is null and not (p.kind = 'points_only' and p.cost_verified and p.unit_cost_usd = 0)
            then 'Unlimited stock is only allowed for a points-only prize with a verified cost of 0' end),
      (case when p.kind = 'fulfillment_required' and not p.cost_verified then 'Real prize: unit cost not verified' end),
      (case when p.kind = 'fulfillment_required' and not p.stock_verified then 'Real prize: stock not verified' end),
      (case when p.kind = 'points_only' and (p.unit_cost_usd is null or not p.cost_verified) then 'Cost not verified (use 0 for cost-free digital outcomes)' end)
    ) as i(issue)
   where p.active and p.weight > 0 and i.issue is not null
$$;

-- Expected and worst-case cost of one more spin, from the prizes still available right now.
create or replace function public.draw_cost_estimate()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  total_w numeric;
  unknown text[] := '{}';
  exp_prize numeric := 0;
  worst_prize numeric := 0;
  ops numeric := 0;
  r record;
begin
  select sum(weight) into total_w from public.prizes
   where active and weight > 0 and onchain_index is not null and (inventory is null or inventory > 0);
  for r in select id, name, weight, unit_cost_usd, cost_verified from public.prizes
            where active and weight > 0 and onchain_index is not null and (inventory is null or inventory > 0) loop
    if r.unit_cost_usd is null or not r.cost_verified then
      unknown := unknown || ('prize:' || r.name);
    else
      exp_prize := exp_prize + (r.weight / total_w) * r.unit_cost_usd;
      worst_prize := greatest(worst_prize, r.unit_cost_usd);
    end if;
  end loop;
  for r in select key, amount_usd, verified from public.operating_costs where key in ('vrf_per_spin', 'gas_per_spin', 'provider_per_spin') loop
    if r.amount_usd is null or not r.verified then unknown := unknown || ('cost:' || r.key);
    else ops := ops + r.amount_usd; end if;
  end loop;
  if total_w is null then unknown := unknown || text 'pool:no available prizes'; end if;
  return jsonb_build_object(
    'available_weight', coalesce(total_w, 0)::text,
    'verified', cardinality(unknown) = 0,
    'unverified', to_jsonb(unknown),
    'expected_prize_cost_usd', case when cardinality(unknown) = 0 then round(exp_prize, 4)::text end,
    'ops_cost_per_spin_usd', case when cardinality(unknown) = 0 then round(ops, 4)::text end,
    'expected_cost_per_spin_usd', case when cardinality(unknown) = 0 then round(exp_prize + ops, 4)::text end,
    'worst_case_cost_per_spin_usd', case when cardinality(unknown) = 0 then round(worst_prize + ops, 4)::text end
  );
end
$$;

create or replace function public.funding_balance(_account text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(amount_usd), 0) from public.funding_events where account = _account
$$;

-- Full picture for admins and for gating purchases/grants.
create or replace function public.economics_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  est jsonb := public.draw_cost_estimate();
  issues jsonb;
  real_stock numeric;
  real_unknown int;
  pend_liab numeric;
  pend_unknown int;
  pend_count int;
  unused int;
  reserve numeric := public.funding_balance('prize_reserve');
  blockers text[] := '{}';
  budgets jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('prize_id', prize_id, 'prize', prize_name, 'issue', issue)), '[]'::jsonb) into issues from public.prize_pool_issues();
  select coalesce(sum(inventory * unit_cost_usd) filter (where cost_verified and unit_cost_usd is not null), 0),
         count(*) filter (where not cost_verified or unit_cost_usd is null)
    into real_stock, real_unknown
    from public.prizes where kind = 'fulfillment_required' and active and coalesce(inventory, 0) > 0;
  select coalesce(sum(unit_cost_usd), 0), count(*) filter (where unit_cost_usd is null), count(*)
    into pend_liab, pend_unknown, pend_count
    from public.prize_fulfillments where status = 'pending';
  select count(*) into unused from public.spin_credits where used_spin_id is null;

  if not (est ->> 'verified')::boolean then blockers := blockers || text 'Some costs are unverified'; end if;
  if jsonb_array_length(issues) > 0 then blockers := blockers || text 'Prize pool has unresolved classification/stock issues'; end if;
  if real_unknown > 0 or pend_unknown > 0 then blockers := blockers || text 'Real prize obligations cannot be valued (unverified costs)';
  elsif reserve < real_stock + pend_liab then blockers := blockers || text 'Prize reserve does not cover every remaining real prize plus pending fulfillment'; end if;

  select jsonb_object_agg(b.source, jsonb_build_object(
           'funded_usd', public.funding_balance('sponsored_' || b.source)::text,
           'committed_usd', b.committed_usd::text,
           'available_usd', (public.funding_balance('sponsored_' || b.source) - b.committed_usd)::text,
           'low_water_usd', b.low_water_usd::text,
           'paused', b.paused, 'pause_reason', b.pause_reason))
    into budgets from public.sponsored_budgets b;

  return jsonb_build_object(
    'cost_estimate', est,
    'prize_issues', issues,
    'liabilities', jsonb_build_object(
      'remaining_real_prize_stock_usd', case when real_unknown = 0 then real_stock::text end,
      'pending_fulfillment_count', pend_count,
      'pending_fulfillment_usd', case when pend_unknown = 0 then pend_liab::text end,
      'unused_credits', unused,
      'unused_credits_worst_case_usd', case when (est ->> 'verified')::boolean then (unused * (est ->> 'worst_case_cost_per_spin_usd')::numeric)::text end),
    'reserves', jsonb_build_object('prize_reserve_usd', reserve::text),
    'sponsored_budgets', coalesce(budgets, '{}'::jsonb),
    'purchases_allowed', cardinality(blockers) = 0,
    'purchase_blockers', to_jsonb(blockers));
end
$$;

-- Issue sponsored (burn / grant / free-entry) credits, reserving the worst-case cost of each one.
-- Returns the new credit ids, or an empty array if the budget is exhausted (budget is then paused).
create or replace function public.issue_sponsored_credits(_user uuid, _source text, _count int, _ref text, _actor uuid, _metadata jsonb default '{}'::jsonb)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.sponsored_budgets;
  est jsonb;
  per numeric;
  need numeric;
  avail numeric;
  ids uuid[] := '{}';
  v uuid;
  i int;
begin
  if _source not in ('burn', 'grant', 'free_entry') then raise exception 'Unknown sponsored source %', _source; end if;
  if _count < 1 or _count > 100 then raise exception 'Invalid credit count'; end if;
  select * into b from public.sponsored_budgets where source = _source for update;
  if b.paused then raise exception 'Sponsored % spins are paused: %', _source, coalesce(b.pause_reason, 'budget not available'); end if;
  est := public.draw_cost_estimate();
  if not (est ->> 'verified')::boolean then raise exception 'Sponsored spins need verified costs first (%)', est -> 'unverified'; end if;
  per := (est ->> 'worst_case_cost_per_spin_usd')::numeric;
  need := per * _count;
  avail := public.funding_balance('sponsored_' || _source) - b.committed_usd;
  if avail < need then
    update public.sponsored_budgets set paused = true, pause_reason = 'Budget exhausted', updated_at = now() where source = _source;
    perform public.raise_alert('budget_exhausted', _source, 'critical', format('Sponsored %s budget cannot fund %s more spin(s)', _source, _count),
                               jsonb_build_object('available_usd', avail::text, 'needed_usd', need::text));
    return '{}';  -- nothing issued; the pause and alert are kept (no exception, so they commit)
  end if;
  for i in 1.._count loop
    insert into public.spin_credits (user_id, source, ref, created_by, funding, reserved_usd, metadata)
    values (_user, _source, case when _ref is null then null when _count = 1 then _ref else _ref || ':' || i end, _actor, 'sponsored', per, coalesce(_metadata, '{}'::jsonb))
    returning id into v;
    ids := ids || v;
  end loop;
  update public.sponsored_budgets set committed_usd = committed_usd + need, updated_at = now() where source = _source;
  if avail - need <= b.low_water_usd then
    update public.sponsored_budgets set paused = true, pause_reason = 'Below the low-water mark; top up to resume', updated_at = now() where source = _source;
    perform public.raise_alert('budget_low', _source, 'warning', format('Sponsored %s budget reached its low-water mark and was paused', _source),
                               jsonb_build_object('available_usd', (avail - need)::text));
  end if;
  return ids;
end
$$;

-- Paid purchases (rewritten: pinned search_path, funded credits).
create or replace function public.complete_spin_purchase(_purchase_id uuid, _tx_hash text, _payer text)
returns public.spin_purchases
language plpgsql
security definer
set search_path = ''
as $$
declare p public.spin_purchases; i int;
begin
  select * into p from public.spin_purchases where id = _purchase_id for update;
  if not found then raise exception 'Unknown purchase'; end if;
  if p.status = 'paid' then return p; end if;
  if _tx_hash !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'Bad transaction hash'; end if;
  if exists (select 1 from public.spin_purchases where tx_hash = lower(_tx_hash) and id <> _purchase_id) then
    raise exception 'This transaction was already used';
  end if;
  update public.spin_purchases
     set status = 'paid', tx_hash = lower(_tx_hash), payer = lower(_payer), paid_at = now()
   where id = _purchase_id
  returning * into p;
  for i in 1..p.quantity loop
    insert into public.spin_credits (user_id, source, ref, funding) values (p.user_id, 'purchase', p.id::text || ':' || i, 'purchase');
  end loop;
  return p;
end
$$;

-- ---------------------------------------------------------------------------
-- Draw batches and submissions
-- ---------------------------------------------------------------------------
create table if not exists public.draw_coordination (
  id boolean primary key default true check (id),
  active_batch_id uuid,
  pool_publishing boolean not null default false,
  requests_paused boolean not null default false,
  pause_reason text,
  updated_at timestamptz not null default now()
);
insert into public.draw_coordination (id) values (true) on conflict do nothing;

create table if not exists public.draw_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  spin_count int not null check (spin_count between 1 and 10),
  season_id uuid references public.seasons(id),
  rule_version int,
  rules_hash text,
  participation_points bigint not null default 0,
  prize_map jsonb not null,
  chain_id int not null,
  contract_address text not null,
  pool_version bigint not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'signed', 'broadcast', 'ambiguous', 'confirmed', 'reverted', 'dropped', 'refunded')),
  request_tx text,
  request_id numeric(78, 0),
  request_block_number bigint,
  request_block_hash text,
  request_confirmed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz,
  unique (user_id, idempotency_key)
);
create index if not exists draw_batches_open on public.draw_batches (created_at)
  where status in ('reserved', 'signed', 'broadcast', 'ambiguous');

create table if not exists public.draw_submissions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.draw_batches(id),
  chain_id int not null,
  contract_address text not null,
  from_address text not null,
  nonce bigint not null,
  tx_hash text not null unique,
  signed_tx text not null,
  pool_version bigint not null,
  status text not null default 'signed' check (status in ('signed', 'broadcast', 'confirmed', 'reverted', 'dropped')),
  broadcast_attempts int not null default 0,
  last_broadcast_at timestamptz,
  last_error text,
  receipt_block_number bigint,
  receipt_block_hash text,
  confirmations int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, from_address, nonce)
);

alter table public.spins
  add column if not exists batch_id uuid references public.draw_batches(id),
  add column if not exists batch_position int,
  add column if not exists season_id uuid references public.seasons(id),
  add column if not exists rule_version int,
  add column if not exists credit_source text,
  add column if not exists prize_index int,
  add column if not exists prize_kind text,
  add column if not exists participation_points bigint not null default 0,
  add column if not exists bonus_points bigint not null default 0,
  add column if not exists seasonal_eligible boolean,
  add column if not exists request_block_number bigint,
  add column if not exists request_block_hash text,
  add column if not exists request_confirmed_at timestamptz,
  add column if not exists fulfill_block_number bigint,
  add column if not exists fulfill_block_hash text,
  add column if not exists refund_reason text,
  add column if not exists settled_at timestamptz;
alter table public.spins alter column points type bigint;
create index if not exists spins_user_created on public.spins (user_id, created_at desc);
create index if not exists spins_season_user on public.spins (season_id, user_id);
create index if not exists spins_batch on public.spins (batch_id);

do $$
declare t text;
begin
  foreach t in array array['draw_coordination', 'draw_batches', 'draw_submissions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant select on public.draw_batches, public.draw_submissions, public.draw_coordination to authenticated;
drop policy if exists "admin read" on public.draw_coordination;
create policy "admin read" on public.draw_coordination for select to authenticated using (public.is_admin());
drop policy if exists "own or admin read" on public.draw_batches;
create policy "own or admin read" on public.draw_batches for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "admin read" on public.draw_submissions;
create policy "admin read" on public.draw_submissions for select to authenticated using (public.is_admin());

-- Old entry points are replaced by the functions below.
drop function if exists public.begin_spins(uuid, int);
drop function if exists public.finalize_spin(uuid, int, text, text);
drop function if exists public.refund_spins(uuid[]);

-- The season that is accepting new activity right now (active and inside its window), if any.
create or replace function public.current_season()
returns public.seasons
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.seasons
   where status = 'active' and not is_legacy and starts_at <= now() and now() < ends_at
   limit 1
$$;

-- Reserve credits and create one pending batch. Idempotent per (player, key).
create or replace function public.reserve_draw_batch(_user uuid, _count int, _idempotency_key text, _chain_id int, _contract text, _pool_version bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  coord public.draw_coordination;
  existing public.draw_batches;
  s public.seasons;
  cfg jsonb;
  lim_24h int;
  lim_season int;
  used_24h int;
  used_season int;
  v_map jsonb;
  v_batch uuid;
  v_credit public.spin_credits;
  v_spin uuid;
  v_ids uuid[] := '{}';
  i int;
begin
  if _count < 1 or _count > 10 then raise exception 'Invalid capsule count'; end if;
  if _contract !~ '^0x[0-9a-fA-F]{40}$' then raise exception 'Bad contract address'; end if;

  -- Global serialization: one batch in flight at a time (MVP).
  select * into coord from public.draw_coordination where id for update;

  select * into existing from public.draw_batches where user_id = _user and idempotency_key = _idempotency_key;
  if found then
    return jsonb_build_object('batch_id', existing.id, 'replayed', true, 'status', existing.status,
      'spin_ids', (select coalesce(jsonb_agg(id order by batch_position), '[]'::jsonb) from public.spins where batch_id = existing.id));
  end if;

  if coord.requests_paused then raise exception 'Draws are paused: %', coalesce(coord.pause_reason, 'maintenance'); end if;
  if coord.pool_publishing then raise exception 'Prize odds are being published. Try again in a minute.'; end if;
  if coord.active_batch_id is not null then raise exception 'The machine is busy with another draw. Try again in a few seconds.'; end if;

  perform pg_advisory_xact_lock(hashtext('draw-user:' || _user::text));
  if exists (select 1 from public.spins where user_id = _user and status = 'pending') then
    raise exception 'You already have a draw in progress';
  end if;

  s := public.current_season();
  if s.id is not null then
    lim_24h := (s.rules #>> '{limits,spins_rolling_24h}')::int;
    lim_season := (s.rules #>> '{limits,spins_per_season}')::int;
  else
    select value into cfg from public.app_config where key = 'spins';
    lim_24h := coalesce((cfg ->> 'daily_limit')::int, 10);
    lim_season := coalesce((cfg ->> 'campaign_limit')::int, 100);
  end if;
  -- Pending reservations count; refunds release capacity (status flips to 'refunded' exactly once).
  select count(*) into used_24h from public.spins where user_id = _user and status <> 'refunded' and created_at > now() - interval '24 hours';
  if s.id is not null then
    select count(*) into used_season from public.spins where user_id = _user and season_id = s.id and status <> 'refunded';
  else
    select count(*) into used_season from public.spins where user_id = _user and status <> 'refunded';
  end if;
  if used_24h + _count > lim_24h then raise exception 'Spin limit reached: % per 24 hours', lim_24h; end if;
  if used_season + _count > lim_season then raise exception 'Season spin limit reached (% per season)', lim_season; end if;

  -- Captured prize mapping: on-chain index -> prize and the bonus it earns under the frozen rules.
  select jsonb_object_agg(p.onchain_index::text, jsonb_build_object(
           'prize_id', p.id, 'name', p.name, 'rarity', p.rarity, 'kind', p.kind,
           'bonus', case when s.id is null then '0'
                         else coalesce(s.rules #>> array['points', 'prize_bonus_overrides', p.id::text],
                                       s.rules #>> array['points', 'rarity_bonus', p.rarity], '0') end))
    into v_map
    from public.prizes p where p.onchain_index is not null;
  if v_map is null then raise exception 'No prizes are published on-chain'; end if;

  insert into public.draw_batches (user_id, idempotency_key, spin_count, season_id, rule_version, rules_hash, participation_points, prize_map, chain_id, contract_address, pool_version)
  values (_user, _idempotency_key, _count, s.id, s.rules_version, s.rules_hash,
          case when s.id is null then 0 else (s.rules #>> '{points,participation_per_spin}')::bigint end,
          v_map, _chain_id, lower(_contract), _pool_version)
  returning id into v_batch;

  for i in 1.._count loop
    select * into v_credit from public.spin_credits
     where user_id = _user and used_spin_id is null
     order by created_at, id limit 1 for update skip locked;
    if not found then raise exception 'Not enough spin credits'; end if;
    insert into public.spins (user_id, credit_id, status, batch_id, batch_position, season_id, rule_version, credit_source, chain_id, contract_address)
    values (_user, v_credit.id, 'pending', v_batch, i - 1, s.id, s.rules_version, v_credit.source, _chain_id, lower(_contract))
    returning id into v_spin;
    update public.spin_credits set used_spin_id = v_spin where id = v_credit.id;
    v_ids := v_ids || v_spin;
  end loop;

  update public.draw_coordination set active_batch_id = v_batch, updated_at = now() where id;
  return jsonb_build_object('batch_id', v_batch, 'replayed', false, 'status', 'reserved', 'spin_ids', to_jsonb(v_ids));
end
$$;

-- Internal: release a batch's credits exactly once (pending spins -> refunded) and free the machine.
create or replace function public.refund_batch(_batch uuid, _status text, _reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_ids uuid[];
begin
  with r as (
    update public.spins set status = 'refunded', refund_reason = _reason, settled_at = now()
     where batch_id = _batch and status = 'pending'
    returning id)
  select coalesce(array_agg(id), '{}') into v_ids from r;
  update public.spin_credits set used_spin_id = null where used_spin_id = any (v_ids);
  update public.draw_batches set status = _status, last_error = _reason, reconciled_at = now(), updated_at = now() where id = _batch;
  update public.draw_coordination set active_batch_id = null, updated_at = now() where id and active_batch_id = _batch;
  return coalesce(array_length(v_ids, 1), 0);
end
$$;

-- Nothing was ever signed for this batch (e.g. simulation failed): provably never broadcast.
create or replace function public.release_draw_prebroadcast(_batch uuid, _reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare b public.draw_batches;
begin
  select * into b from public.draw_batches where id = _batch for update;
  if not found then raise exception 'Unknown batch'; end if;
  if b.status <> 'reserved' or exists (select 1 from public.draw_submissions where batch_id = _batch) then
    raise exception 'Batch % has a signed transaction; it must be reconciled on-chain, not refunded', _batch;
  end if;
  return public.refund_batch(_batch, 'refunded', 'prebroadcast_failure: ' || left(coalesce(_reason, ''), 300));
end
$$;

-- Persist the signed transaction BEFORE broadcasting, so recovery can resend the same bytes.
create or replace function public.record_draw_signed(_batch uuid, _from text, _nonce bigint, _tx_hash text, _signed_tx text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare b public.draw_batches; v uuid;
begin
  select * into b from public.draw_batches where id = _batch for update;
  if not found then raise exception 'Unknown batch'; end if;
  if b.status <> 'reserved' then raise exception 'Batch % is already %', _batch, b.status; end if;
  if _tx_hash !~ '^0x[0-9a-f]{64}$' or _signed_tx !~ '^0x[0-9a-f]+$' then raise exception 'Bad transaction data'; end if;
  insert into public.draw_submissions (batch_id, chain_id, contract_address, from_address, nonce, tx_hash, signed_tx, pool_version)
  values (_batch, b.chain_id, b.contract_address, lower(_from), _nonce, _tx_hash, _signed_tx, b.pool_version)
  returning id into v;
  update public.draw_batches set status = 'signed', request_tx = _tx_hash, updated_at = now() where id = _batch;
  update public.spins set request_tx = _tx_hash where batch_id = _batch;
  return v;
end
$$;

-- Result of a (re)broadcast attempt. An error is ambiguous: the node may still have the tx.
create or replace function public.record_draw_broadcast(_tx_hash text, _error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare sub public.draw_submissions;
begin
  select * into sub from public.draw_submissions where tx_hash = _tx_hash for update;
  if not found then raise exception 'Unknown submission'; end if;
  update public.draw_submissions
     set broadcast_attempts = broadcast_attempts + 1, last_broadcast_at = now(), updated_at = now(),
         status = case when status = 'signed' and _error is null then 'broadcast' else status end,
         last_error = _error
   where id = sub.id;
  update public.draw_batches
     set status = case when status in ('signed', 'ambiguous', 'broadcast') then (case when _error is null then 'broadcast' else 'ambiguous' end) else status end,
         last_error = _error, updated_at = now()
   where id = sub.batch_id;
end
$$;

-- The request transaction is canonically confirmed with status success.
-- `_event_spin_ids` are the spin ids parsed from the receipt's SpinRequested events.
create or replace function public.confirm_draw_request(_tx_hash text, _request_id numeric, _block_number bigint, _block_hash text, _block_time timestamptz, _confirmations int, _event_spin_ids uuid[])
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  sub public.draw_submissions;
  b public.draw_batches;
  s public.seasons;
  expected uuid[];
begin
  select * into sub from public.draw_submissions where tx_hash = _tx_hash for update;
  if not found then raise exception 'Unknown submission'; end if;
  select * into b from public.draw_batches where id = sub.batch_id for update;
  if b.status = 'confirmed' then
    if b.request_block_hash is distinct from _block_hash or b.request_id is distinct from _request_id then
      perform public.raise_alert('reorg_conflict', b.id::text, 'critical', 'Draw request confirmation changed after it was recorded',
        jsonb_build_object('recorded_block', b.request_block_hash, 'new_block', _block_hash));
      update public.draw_coordination set requests_paused = true, pause_reason = 'Reorg/conflict on draw ' || b.id::text, updated_at = now() where id;
      return 'conflict';
    end if;
    return 'already_confirmed';
  end if;
  if b.status not in ('signed', 'broadcast', 'ambiguous') then
    perform public.raise_alert('reorg_conflict', b.id::text, 'critical', format('Batch already %s but a confirmation arrived', b.status),
      jsonb_build_object('tx', _tx_hash, 'block', _block_hash));
    update public.draw_coordination set requests_paused = true, pause_reason = 'Reorg/conflict on draw ' || b.id::text, updated_at = now() where id;
    return 'conflict';
  end if;

  select coalesce(array_agg(id order by id), '{}') into expected from public.spins where batch_id = b.id;
  if (select coalesce(array_agg(x order by x), '{}') from unnest(_event_spin_ids) x) <> expected then
    perform public.raise_alert('request_mismatch', b.id::text, 'critical', 'SpinRequested events do not match the batch',
      jsonb_build_object('expected', to_jsonb(expected), 'events', to_jsonb(_event_spin_ids)));
    update public.draw_coordination set requests_paused = true, pause_reason = 'Request/event mismatch on draw ' || b.id::text, updated_at = now() where id;
    return 'conflict';
  end if;

  update public.draw_submissions
     set status = 'confirmed', receipt_block_number = _block_number, receipt_block_hash = _block_hash, confirmations = _confirmations, updated_at = now()
   where id = sub.id;
  update public.draw_batches
     set status = 'confirmed', request_id = _request_id, request_block_number = _block_number, request_block_hash = _block_hash,
         request_confirmed_at = _block_time, reconciled_at = now(), updated_at = now(), last_error = null
   where id = b.id;

  select * into s from public.seasons where id = b.season_id;
  -- Seasonal points only if the request was confirmed inside the season window (exclusive cutoff).
  update public.spins
     set vrf_request_id = _request_id::text, request_block_number = _block_number, request_block_hash = _block_hash,
         request_confirmed_at = _block_time,
         seasonal_eligible = (s.id is not null and _block_time >= s.starts_at and _block_time < s.ends_at
                              and credit_source in (select jsonb_array_elements_text(s.rules -> 'eligible_credit_sources')))
   where batch_id = b.id;
  update public.draw_coordination set active_batch_id = null, updated_at = now() where id and active_batch_id = b.id;
  return 'confirmed';
end
$$;

-- The request transaction failed on-chain (canonically confirmed revert) or its nonce was provably
-- consumed by a different transaction. Either way no randomness was requested: refund exactly once.
create or replace function public.record_draw_failed(_tx_hash text, _outcome text, _block_number bigint, _block_hash text, _evidence jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare sub public.draw_submissions; b public.draw_batches;
begin
  if _outcome not in ('reverted', 'dropped') then raise exception 'Outcome must be reverted or dropped'; end if;
  select * into sub from public.draw_submissions where tx_hash = _tx_hash for update;
  if not found then raise exception 'Unknown submission'; end if;
  select * into b from public.draw_batches where id = sub.batch_id for update;
  if b.status in ('reverted', 'dropped', 'refunded') then return 0; end if;
  if b.status = 'confirmed' then
    perform public.raise_alert('reorg_conflict', b.id::text, 'critical', 'A confirmed draw request now looks failed', coalesce(_evidence, '{}'::jsonb));
    update public.draw_coordination set requests_paused = true, pause_reason = 'Reorg/conflict on draw ' || b.id::text, updated_at = now() where id;
    return -1;
  end if;
  update public.draw_submissions
     set status = _outcome, receipt_block_number = _block_number, receipt_block_hash = _block_hash,
         last_error = left(coalesce(_evidence::text, ''), 1000), updated_at = now()
   where id = sub.id;
  return public.refund_batch(b.id, _outcome, 'request_' || _outcome);
end
$$;

-- Settle one spin with what the contract drew. Atomic and replay-safe:
-- spin result, inventory, fulfillment liability, participation + bonus ledger entries and totals.
create or replace function public.settle_drawn_spin(_spin uuid, _prize_index int, _random_word text, _request_id numeric, _fulfill_block bigint, _fulfill_block_hash text)
returns public.spins
language plpgsql
security definer
set search_path = ''
as $$
declare
  sp public.spins;
  b public.draw_batches;
  s public.seasons;
  entry jsonb;
  pz public.prizes;
  v_bonus bigint := 0;
  v_part bigint := 0;
  eligible boolean;
begin
  select * into sp from public.spins where id = _spin for update;
  if not found then raise exception 'Unknown spin'; end if;

  -- Replays: identical result is a no-op; a different result is a conflict.
  if sp.status = 'fulfilled' then
    if sp.prize_index is distinct from _prize_index or sp.random_word is distinct from _random_word then
      perform public.raise_alert('result_conflict', sp.id::text, 'critical', 'Chain result differs from the recorded result',
        jsonb_build_object('recorded', sp.prize_index, 'chain', _prize_index));
      update public.draw_coordination set requests_paused = true, pause_reason = 'Result conflict on spin ' || sp.id::text, updated_at = now() where id;
    end if;
    return sp;  -- unchanged; caller compares and sees the conflict
  end if;
  if sp.status = 'refunded' then
    if sp.refund_reason = 'no_prize' and _prize_index = 255 then return sp; end if;
    perform public.raise_alert('result_conflict', sp.id::text, 'critical', 'A refunded spin received a chain result',
      jsonb_build_object('refund_reason', sp.refund_reason, 'chain', _prize_index));
    update public.draw_coordination set requests_paused = true, pause_reason = 'Result conflict on spin ' || sp.id::text, updated_at = now() where id;
    return sp;
  end if;

  if sp.batch_id is not null then
    select * into b from public.draw_batches where id = sp.batch_id;
    if b.status <> 'confirmed' then raise exception 'The request for spin % is not canonically confirmed yet', sp.id; end if;
    if b.request_id is distinct from _request_id then raise exception 'Request id mismatch for spin %', sp.id; end if;
  end if;

  -- NO_PRIZE: credit returns once, no points.
  if _prize_index = 255 then
    update public.spins
       set status = 'refunded', refund_reason = 'no_prize', random_word = _random_word, fulfill_block_number = _fulfill_block,
           fulfill_block_hash = _fulfill_block_hash, settled_at = now(), seasonal_eligible = false
     where id = sp.id returning * into sp;
    update public.spin_credits set used_spin_id = null where id = sp.credit_id and used_spin_id = sp.id;
    return sp;
  end if;

  if sp.batch_id is not null then
    entry := b.prize_map -> _prize_index::text;
    if entry is null then
      perform public.raise_alert('prize_mapping', sp.id::text, 'critical', 'Chain drew an index missing from the captured prize map',
        jsonb_build_object('index', _prize_index));
      update public.draw_coordination set requests_paused = true, pause_reason = 'Unmapped prize index on spin ' || sp.id::text, updated_at = now() where id;
      return sp;  -- stays pending until an admin resolves the mapping
    end if;
    select * into pz from public.prizes where id = (entry ->> 'prize_id')::uuid;
    v_part := b.participation_points;
    v_bonus := coalesce((entry ->> 'bonus')::bigint, 0);
  else
    -- Spins requested before seasons existed: current mapping, no seasonal points.
    select * into pz from public.prizes where onchain_index = _prize_index;
    if not found then raise exception 'No prize mapped to on-chain index %', _prize_index; end if;
    entry := jsonb_build_object('prize_id', pz.id, 'name', pz.name, 'rarity', pz.rarity, 'kind', pz.kind, 'bonus', '0');
  end if;

  -- Inventory: the entitlement stands even if the database disagrees with the chain (alert, never drop).
  if pz.inventory is not null then
    if pz.inventory > 0 then
      update public.prizes set inventory = inventory - 1 where id = pz.id;
    else
      perform public.raise_alert('inventory_drift', pz.id::text, 'critical',
        format('Prize %s was won on-chain but the database shows no stock left', pz.name), jsonb_build_object('spin_id', sp.id));
    end if;
  end if;

  eligible := coalesce(sp.seasonal_eligible, false);
  if eligible then
    select * into s from public.seasons where id = sp.season_id;
  end if;

  update public.spins
     set status = 'fulfilled', prize_id = (entry ->> 'prize_id')::uuid, prize_name = entry ->> 'name', rarity = entry ->> 'rarity',
         prize_kind = entry ->> 'kind', prize_index = _prize_index, random_word = _random_word,
         vrf_request_id = coalesce(vrf_request_id, _request_id::text),
         participation_points = case when eligible then v_part else 0 end,
         bonus_points = case when eligible then v_bonus else 0 end,
         points = case when eligible then v_bonus else 0 end,
         fulfill_block_number = _fulfill_block, fulfill_block_hash = _fulfill_block_hash,
         fulfilled_at = now(), settled_at = now()
   where id = sp.id returning * into sp;

  if pz.kind = 'fulfillment_required' then
    insert into public.prize_fulfillments (spin_id, user_id, prize_id, unit_cost_usd)
    values (sp.id, sp.user_id, pz.id, case when pz.cost_verified then pz.unit_cost_usd end)
    on conflict (spin_id) do nothing;
  end if;

  if eligible then
    perform public.ledger_award(sp.season_id, sp.user_id, 'spin', sp.id::text, 'participation', v_part, sp.rule_version,
                                sp.request_confirmed_at, jsonb_build_object('batch_id', sp.batch_id), null);
    perform public.ledger_award(sp.season_id, sp.user_id, 'spin', sp.id::text, 'prize_bonus', v_bonus, sp.rule_version,
                                sp.request_confirmed_at, jsonb_build_object('prize_id', pz.id, 'rarity', entry ->> 'rarity'), null);
  end if;
  return sp;
end
$$;

-- ---------------------------------------------------------------------------
-- Prize pool publication (coordinated with draw submission)
-- ---------------------------------------------------------------------------
create table if not exists public.prize_pool_publications (
  id bigserial primary key,
  chain_id int not null,
  contract_address text not null,
  pool_version bigint,
  weights jsonb not null,
  remaining jsonb not null,
  tx_hash text,
  status text not null default 'publishing' check (status in ('publishing', 'published', 'aborted')),
  started_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);
alter table public.prize_pool_publications enable row level security;
revoke all on public.prize_pool_publications from public, anon, authenticated;
grant select on public.prize_pool_publications to authenticated;
grant all on public.prize_pool_publications to service_role;
grant usage on sequence public.prize_pool_publications_id_seq to service_role;
drop policy if exists "admin read" on public.prize_pool_publications;
create policy "admin read" on public.prize_pool_publications for select to authenticated using (public.is_admin());

-- Locks out new draws, checks nothing is in flight, and computes what to publish.
-- `_chain_remaining` is the contract's current remaining stock by index (JSON array of numbers/strings).
create or replace function public.begin_pool_publication(_chain_id int, _contract text, _chain_remaining jsonb, _actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  coord public.draw_coordination;
  n int;
  w jsonb := '[]'::jsonb;
  rem jsonb := '[]'::jsonb;
  p record;
  i int;
  chain_rem bigint;
  restock bigint;
  db_rem bigint;
  pub bigint;
  pub_id bigint;
  issues int;
begin
  select * into coord from public.draw_coordination where id for update;
  if coord.pool_publishing then raise exception 'A publication is already in progress'; end if;
  if coord.active_batch_id is not null then raise exception 'A draw is in flight; wait for it to be reconciled'; end if;
  if exists (select 1 from public.draw_batches where status in ('reserved', 'signed', 'broadcast', 'ambiguous')) then
    raise exception 'Unreconciled draw batches exist';
  end if;
  if exists (select 1 from public.spins where status = 'pending') then
    raise exception 'Settle all pending spins before publishing (chain inventory must be reconciled first)';
  end if;
  select count(*) into issues from public.prize_pool_issues();
  if issues > 0 then raise exception 'Resolve % prize classification/stock issue(s) before publishing', issues; end if;

  -- Assign stable indexes to newly active prizes (existing indexes never change).
  select coalesce(max(onchain_index), -1) + 1 into i from public.prizes;
  for p in select id from public.prizes where onchain_index is null and active order by created_at, id loop
    if i >= 32 then raise exception 'The contract holds at most 32 prizes'; end if;
    update public.prizes set onchain_index = i where id = p.id;
    i := i + 1;
  end loop;

  select coalesce(max(onchain_index), -1) + 1 into n from public.prizes;
  for i in 0..n - 1 loop
    select * into p from public.prizes where onchain_index = i;
    if not found then
      w := w || to_jsonb(0); rem := rem || to_jsonb(0); continue;
    end if;
    w := w || to_jsonb(case when p.active then least(p.weight, 4294967295) else 0 end);
    if p.inventory is null then
      rem := rem || to_jsonb(4294967295::bigint);
    else
      db_rem := p.inventory;
      chain_rem := case when jsonb_array_length(coalesce(_chain_remaining, '[]'::jsonb)) > i then (_chain_remaining ->> i)::bigint end;
      select coalesce(sum(delta), 0) into restock from public.prize_stock_events where prize_id = p.id and published_pool_version is null and delta > 0;
      if chain_rem is null or chain_rem = 4294967295 then
        pub := db_rem;  -- first publication of this index
      else
        -- Never exceed what the chain has left plus audited restocks since the last publication.
        pub := least(db_rem, chain_rem + restock);
        if db_rem > chain_rem + restock then
          perform public.raise_alert('inventory_drift', p.id::text, 'warning',
            format('Database stock for %s (%s) exceeds chain stock (%s) plus restocks (%s); publishing the lower number', p.name, db_rem, chain_rem, restock),
            jsonb_build_object('db', db_rem, 'chain', chain_rem, 'restock', restock));
          update public.prizes set inventory = pub where id = p.id;
        end if;
      end if;
      rem := rem || to_jsonb(pub);
    end if;
  end loop;
  if n = 0 then raise exception 'No active prizes to publish'; end if;

  update public.draw_coordination set pool_publishing = true, updated_at = now() where id;
  insert into public.prize_pool_publications (chain_id, contract_address, weights, remaining, started_by)
  values (_chain_id, lower(_contract), w, rem, _actor) returning id into pub_id;
  return jsonb_build_object('publication_id', pub_id, 'weights', w, 'remaining', rem);
end
$$;

create or replace function public.finish_pool_publication(_publication bigint, _ok boolean, _tx_hash text, _pool_version bigint, _error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.prize_pool_publications
     set status = case when _ok then 'published' else 'aborted' end, tx_hash = _tx_hash, pool_version = _pool_version,
         finished_at = now(), error = _error
   where id = _publication and status = 'publishing';
  if _ok then
    update public.prize_stock_events set published_pool_version = _pool_version where published_pool_version is null;
  end if;
  update public.draw_coordination set pool_publishing = false, updated_at = now() where id;
end
$$;

-- Audited restock / write-off of a finite prize.
create or replace function public.adjust_prize_stock(_prize uuid, _delta int, _reason text, _actor uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare p public.prizes;
begin
  if _actor is null or not public.has_role(_actor, 'admin') then raise exception 'Forbidden'; end if;
  select * into p from public.prizes where id = _prize for update;
  if not found then raise exception 'Unknown prize'; end if;
  if p.inventory is null then raise exception 'Unlimited prizes have no stock to adjust'; end if;
  if p.inventory + _delta < 0 then raise exception 'Stock cannot go below zero'; end if;
  insert into public.prize_stock_events (prize_id, delta, reason, created_by) values (_prize, _delta, btrim(_reason), _actor);
  update public.prizes set inventory = inventory + _delta where id = _prize;
  insert into public.audit_log (actor, action, details) values (_actor, 'prize.stock_adjusted', jsonb_build_object('prize_id', _prize, 'delta', _delta, 'reason', _reason));
  return p.inventory + _delta;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants: server only
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.raise_alert(text, text, text, text, jsonb)',
    'public.resolve_alert(text, text, uuid)',
    'public.prize_pool_issues()',
    'public.draw_cost_estimate()',
    'public.funding_balance(text)',
    'public.economics_status()',
    'public.issue_sponsored_credits(uuid, text, int, text, uuid, jsonb)',
    'public.complete_spin_purchase(uuid, text, text)',
    'public.current_season()',
    'public.reserve_draw_batch(uuid, int, text, int, text, bigint)',
    'public.refund_batch(uuid, text, text)',
    'public.release_draw_prebroadcast(uuid, text)',
    'public.record_draw_signed(uuid, text, bigint, text, text)',
    'public.record_draw_broadcast(text, text)',
    'public.confirm_draw_request(text, numeric, bigint, text, timestamptz, int, uuid[])',
    'public.record_draw_failed(text, text, bigint, text, jsonb)',
    'public.settle_drawn_spin(uuid, int, text, numeric, bigint, text)',
    'public.begin_pool_publication(int, text, jsonb, uuid)',
    'public.finish_pool_publication(bigint, boolean, text, bigint, text)',
    'public.adjust_prize_stock(uuid, int, text, uuid)',
    'public.funding_immutable()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
