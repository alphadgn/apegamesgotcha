-- ============================================================================
-- Economic controls (season leaderboard, part 3 of 7)
--
-- * Every prize is classified: points_only / digital_free (cost-free, may be
--   unlimited) or fulfillment_required (needs verified finite stock or reserved
--   funding). Unclassified prizes block draws until an admin classifies them.
-- * Costs are recorded with evidence. A cost that has not been entered is
--   "unverified" — never treated as zero.
-- * Burn / grant / free-entry spins must reserve against a funded sponsored
--   budget at the moment the credit is created (atomic). New grants pause
--   before a budget is exhausted; credits already funded are always honoured.
-- * New purchases pause unless verified reserves cover worst-case real-prize
--   obligations for every outstanding credit plus pending fulfilment.
-- * Points are engagement scores only: nothing here redeems or pays out.
-- ============================================================================

alter table public.prizes add column if not exists fulfillment_type text not null default 'unclassified';
alter table public.prizes drop constraint if exists prizes_fulfillment_type_check;
alter table public.prizes add constraint prizes_fulfillment_type_check
  check (fulfillment_type in ('unclassified', 'points_only', 'digital_free', 'fulfillment_required'));
alter table public.prizes drop constraint if exists prizes_unlimited_only_free;
alter table public.prizes add constraint prizes_unlimited_only_free
  check (inventory is not null or fulfillment_type in ('unclassified', 'points_only', 'digital_free'));
alter table public.prizes drop constraint if exists prizes_inventory_nonnegative;
alter table public.prizes add constraint prizes_inventory_nonnegative check (inventory is null or inventory >= 0);
-- Prizes are edited through the server only (see admin_upsert_prize in the draws migration).
revoke insert, update, delete, truncate on public.prizes from service_role;
grant select on public.prizes to service_role;

-- Per-prize costs and proof of stock/funding (admin-only; not public).
create table if not exists public.prize_economics (
  prize_id uuid primary key references public.prizes (id),
  acquisition_usd numeric(14, 2) check (acquisition_usd >= 0),
  fulfillment_usd numeric(14, 2) check (fulfillment_usd >= 0),
  shipping_usd numeric(14, 2) check (shipping_usd >= 0),
  cost_verified_at timestamptz,
  cost_evidence text,
  stock_verified_qty int check (stock_verified_qty >= 0),
  stock_verified_at timestamptz,
  stock_evidence text,
  funding_reserved_usd numeric(14, 2) not null default 0 check (funding_reserved_usd >= 0),
  funding_verified_at timestamptz,
  funding_evidence text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- Marginal and fixed operating costs, one row per cost line (history kept by retiring rows).
create table if not exists public.operating_costs (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('gas', 'vrf', 'provider', 'hosting', 'support', 'other')),
  basis text not null check (basis in ('per_spin', 'per_draw', 'monthly', 'one_time')),
  description text not null check (length(btrim(description)) >= 3),
  amount_usd numeric(14, 6) check (amount_usd >= 0),   -- null = not yet known (unverified)
  verified_at timestamptz,
  evidence text,
  retired_at timestamptz,
  recorded_by uuid,
  created_at timestamptz not null default now(),
  check (amount_usd is null or (verified_at is not null and evidence is not null))
);

-- Verified reserve movements set aside for real-prize obligations (deposits positive, withdrawals negative).
create table if not exists public.reserve_entries (
  id uuid primary key default gen_random_uuid(),
  amount_usd numeric(14, 2) not null check (amount_usd <> 0),
  evidence text not null check (length(btrim(evidence)) >= 5),
  verified_at timestamptz not null default now(),
  recorded_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.sponsored_budgets (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('burn', 'grant', 'free_entry')),
  name text not null,
  funded_usd numeric(14, 2) not null check (funded_usd > 0),
  pause_threshold_usd numeric(14, 2) not null default 0 check (pause_threshold_usd >= 0),
  evidence text not null check (length(btrim(evidence)) >= 5),
  verified_at timestamptz not null default now(),
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.sponsored_reservations (
  credit_id uuid primary key references public.spin_credits (id),
  budget_id uuid not null references public.sponsored_budgets (id),
  reserved_usd numeric(14, 6) not null check (reserved_usd >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'consumed', 'released')),
  actual_usd numeric(14, 6),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists sponsored_reservations_budget_idx on public.sponsored_reservations (budget_id, status);

-- What a confirmed purchase was worth when it was made (USD quote locked with the price).
alter table public.spin_purchases add column if not exists price_usd numeric(14, 2);

revoke all on public.prize_economics, public.operating_costs, public.reserve_entries, public.sponsored_budgets, public.sponsored_reservations from anon;
revoke insert, update, delete, truncate on public.prize_economics, public.operating_costs, public.reserve_entries, public.sponsored_budgets, public.sponsored_reservations from authenticated;
grant all on public.prize_economics, public.operating_costs, public.reserve_entries, public.sponsored_budgets to service_role;
grant select on public.sponsored_reservations to service_role;
revoke insert, update, delete on public.sponsored_reservations from service_role;
alter table public.prize_economics enable row level security;
alter table public.operating_costs enable row level security;
alter table public.reserve_entries enable row level security;
alter table public.sponsored_budgets enable row level security;
alter table public.sponsored_reservations enable row level security;
do $$
declare t text;
begin
  foreach t in array array['prize_economics', 'operating_costs', 'reserve_entries', 'sponsored_budgets', 'sponsored_reservations'] loop
    execute format('drop policy if exists "%s admin read" on public.%I', t, t);
    execute format('create policy "%s admin read" on public.%I for select to authenticated using (public.has_role(auth.uid(), ''admin''))', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Cost model
-- ---------------------------------------------------------------------------
-- Unit cost of one won prize; null when the prize needs fulfilment and any part is unknown.
create or replace function public.prize_unit_cost_usd(_prize_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p.fulfillment_type in ('points_only', 'digital_free') then 0::numeric
           when p.fulfillment_type = 'fulfillment_required' and e.cost_verified_at is not null
                and e.acquisition_usd is not null and e.fulfillment_usd is not null and e.shipping_usd is not null
             then e.acquisition_usd + e.fulfillment_usd + e.shipping_usd
           else null
         end
    from public.prizes p
    left join public.prize_economics e on e.prize_id = p.id
   where p.id = _prize_id
$$;

-- Marginal operating cost of one spin (worst case: one spin per draw request). Null if unverified.
create or replace function public.marginal_spin_cost_usd()
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_missing int; v_total numeric;
begin
  select count(*) into v_missing from public.operating_costs c
   where c.retired_at is null and c.basis in ('per_spin', 'per_draw') and c.amount_usd is null;
  if v_missing > 0 then return null; end if;
  if not exists (select 1 from public.operating_costs c where c.retired_at is null and c.category = 'gas' and c.basis in ('per_spin', 'per_draw'))
     or not exists (select 1 from public.operating_costs c where c.retired_at is null and c.category = 'vrf' and c.basis in ('per_spin', 'per_draw')) then
    return null; -- gas and VRF fees must be measured before a draw has a known cost
  end if;
  select coalesce(sum(c.amount_usd), 0) into v_total from public.operating_costs c
   where c.retired_at is null and c.basis in ('per_spin', 'per_draw');
  return v_total;
end
$$;

-- Prizes that can currently be drawn (positive weight and stock).
create or replace function public.available_prize_pool()
returns table (prize_id uuid, name text, rarity text, weight int, inventory int, fulfillment_type text, onchain_index int, probability numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with a as (
    select p.* from public.prizes p
     where p.active and p.weight > 0 and (p.inventory is null or p.inventory > 0)
  )
  select a.id, a.name, a.rarity, a.weight, a.inventory, a.fulfillment_type, a.onchain_index,
         a.weight::numeric / nullif(sum(a.weight) over (), 0)
    from a
$$;

-- Expected cost of one spin from the actual available pool; null when anything is unverified.
create or replace function public.expected_spin_cost_usd()
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_marginal numeric := public.marginal_spin_cost_usd(); v_prize numeric; v_unknown int;
begin
  if v_marginal is null then return null; end if;
  select count(*) filter (where public.prize_unit_cost_usd(a.prize_id) is null),
         coalesce(sum(a.probability * coalesce(public.prize_unit_cost_usd(a.prize_id), 0)), 0)
    into v_unknown, v_prize
    from public.available_prize_pool() a;
  if v_unknown > 0 then return null; end if;
  return v_prize + v_marginal;
end
$$;

-- Worst case for one spin: the most expensive prize still available, plus marginal cost.
create or replace function public.worst_case_spin_cost_usd()
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_marginal numeric := public.marginal_spin_cost_usd(); v_max numeric; v_unknown int;
begin
  if v_marginal is null then return null; end if;
  select count(*) filter (where public.prize_unit_cost_usd(a.prize_id) is null),
         coalesce(max(public.prize_unit_cost_usd(a.prize_id)), 0)
    into v_unknown, v_max
    from public.available_prize_pool() a;
  if v_unknown > 0 then return null; end if;
  return v_max + v_marginal;
end
$$;

-- Worst-case real-prize obligation if `_spins` outstanding spins each won the costliest remaining real prize unit.
create or replace function public.worst_case_obligation_usd(_spins bigint)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_unknown int; v_total numeric;
begin
  select count(*) into v_unknown from public.available_prize_pool() a where public.prize_unit_cost_usd(a.prize_id) is null;
  if v_unknown > 0 then return null; end if;
  with units as (
    select public.prize_unit_cost_usd(a.prize_id) as cost
      from public.available_prize_pool() a
      cross join lateral generate_series(1, least(coalesce(a.inventory, greatest(_spins, 0)::int), greatest(_spins, 0)::int)) g
     where a.fulfillment_type = 'fulfillment_required'
  )
  select coalesce(sum(cost), 0) into v_total from (select cost from units order by cost desc limit greatest(_spins, 0)) t;
  return v_total + coalesce(public.marginal_spin_cost_usd(), 0) * greatest(_spins, 0);
end
$$;

-- Readiness of the prize catalogue for real draws. Returns problems (empty = ready).
create or replace function public.prize_catalog_problems()
returns table (prize_id uuid, problem text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, 'Classify this prize (points-only, cost-free digital, or needs fulfilment)'
    from public.prizes p where p.active and p.weight > 0 and p.fulfillment_type = 'unclassified'
  union all
  select p.id, 'Real prize needs a finite stock number'
    from public.prizes p where p.active and p.weight > 0 and p.fulfillment_type = 'fulfillment_required' and p.inventory is null
  union all
  select p.id, 'Real prize needs verified costs (acquisition, fulfilment, shipping)'
    from public.prizes p where p.active and p.weight > 0 and p.fulfillment_type = 'fulfillment_required'
     and public.prize_unit_cost_usd(p.id) is null
  union all
  select p.id, 'Real prize needs verified stock on hand or reserved funding for every remaining unit'
    from public.prizes p left join public.prize_economics e on e.prize_id = p.id
   where p.active and p.weight > 0 and p.fulfillment_type = 'fulfillment_required' and p.inventory is not null
     and not (
       (e.stock_verified_at is not null and coalesce(e.stock_verified_qty, 0) >= p.inventory)
       or (e.funding_verified_at is not null and public.prize_unit_cost_usd(p.id) is not null
           and e.funding_reserved_usd >= public.prize_unit_cost_usd(p.id) * p.inventory)
     )
$$;

-- Outstanding prepaid/sponsored spins that could still be drawn.
create or replace function public.outstanding_spin_count()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.spin_credits c where c.used_spin_id is null)
       + (select count(*) from public.spins s where s.status = 'pending')
$$;

create or replace function public.reserve_balance_usd()
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select coalesce(sum(r.amount_usd), 0) from public.reserve_entries r $$;

-- Gate for opening new purchases of `_quantity` spins.
create or replace function public.purchase_gate(_quantity int)
returns table (ok boolean, reason text, required_usd numeric, reserves_usd numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_required numeric;
  v_reserves numeric := public.reserve_balance_usd();
  v_liabilities numeric;
begin
  if exists (select 1 from public.prize_catalog_problems()) then
    return query select false, 'The prize catalogue has unverified prizes', null::numeric, v_reserves; return;
  end if;
  if public.expected_spin_cost_usd() is null then
    return query select false, 'Draw costs are unverified', null::numeric, v_reserves; return;
  end if;
  v_required := public.worst_case_obligation_usd(public.outstanding_spin_count() + greatest(_quantity, 0));
  select coalesce(sum(public.prize_unit_cost_usd(e.prize_id)), 0) into v_liabilities
    from public.prize_entitlements e where e.status = 'owed';
  if v_required is null or v_liabilities is null then
    return query select false, 'Draw costs are unverified', null::numeric, v_reserves; return;
  end if;
  v_required := v_required + v_liabilities;
  if v_reserves < v_required then
    return query select false, 'Reserves don''t cover worst-case prize obligations', v_required, v_reserves; return;
  end if;
  return query select true, null::text, v_required, v_reserves;
end
$$;

-- ---------------------------------------------------------------------------
-- Sponsored spins (burn / grant / free entry) reserve funding as they are created.
-- ---------------------------------------------------------------------------
create or replace function public._reserve_sponsored_credit(_credit_id uuid, _source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cost numeric := public.worst_case_spin_cost_usd();
  b public.sponsored_budgets;
  v_used numeric;
begin
  if _source not in ('burn', 'grant', 'free_entry') then raise exception 'Not a sponsored source: %', _source; end if;
  if v_cost is null then
    raise exception 'Sponsored spins are paused: draw costs are unverified' using errcode = 'P0402';
  end if;
  for b in select * from public.sponsored_budgets x where x.source = _source and x.active order by x.created_at for update loop
    select coalesce(sum(case when r.status = 'reserved' then r.reserved_usd when r.status = 'consumed' then coalesce(r.actual_usd, r.reserved_usd) else 0 end), 0)
      into v_used from public.sponsored_reservations r where r.budget_id = b.id;
    if b.funded_usd - v_used - v_cost >= b.pause_threshold_usd then
      insert into public.sponsored_reservations (credit_id, budget_id, reserved_usd) values (_credit_id, b.id, v_cost);
      return b.id;
    end if;
  end loop;
  raise exception 'Sponsored % spins are paused: no funded budget has room', _source using errcode = 'P0402';
end
$$;

-- Admin grant of spins (each one funded from a sponsored budget, all-or-nothing).
create or replace function public.grant_spins(_user_id uuid, _count int, _reason text, _actor uuid, _source text default 'grant')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare i int; v_credit uuid;
begin
  if _actor is null then raise exception 'Grants need an accountable actor'; end if;
  if _count < 1 or _count > 100 then raise exception 'Grant between 1 and 100 spins'; end if;
  if _source not in ('grant', 'free_entry') then raise exception 'Use grant or free_entry'; end if;
  if _reason is null or length(btrim(_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)'; end if;
  for i in 1.._count loop
    insert into public.spin_credits (user_id, source, created_by) values (_user_id, _source, _actor) returning id into v_credit;
    perform public._reserve_sponsored_credit(v_credit, _source);
  end loop;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'spins.granted', jsonb_build_object('user_id', _user_id, 'count', _count, 'source', _source, 'reason', btrim(_reason)));
  return _count;
end
$$;

-- Admin/economic status for the console.
create or replace function public.economic_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_outstanding bigint := public.outstanding_spin_count();
  v_unused_paid bigint;
  v_unused_paid_usd numeric;
  v_owed_count bigint;
  v_owed_usd numeric;
  v_receipts_usd numeric;
  v_receipts_count bigint;
begin
  select count(*), sum(p.price_usd / nullif(p.quantity, 0))
    into v_unused_paid, v_unused_paid_usd
    from public.spin_credits c join public.spin_purchases p on c.source = 'purchase' and c.ref like p.id::text || ':%'
   where c.used_spin_id is null;
  select count(*), sum(public.prize_unit_cost_usd(e.prize_id)) into v_owed_count, v_owed_usd
    from public.prize_entitlements e where e.status = 'owed';
  select count(*), sum(p.price_usd) into v_receipts_count, v_receipts_usd from public.spin_purchases p where p.status = 'paid';
  return jsonb_build_object(
    'expected_spin_cost_usd', public.expected_spin_cost_usd(),
    'worst_case_spin_cost_usd', public.worst_case_spin_cost_usd(),
    'marginal_spin_cost_usd', public.marginal_spin_cost_usd(),
    'outstanding_spins', v_outstanding,
    'worst_case_obligation_usd', public.worst_case_obligation_usd(v_outstanding),
    'unused_paid_credits', v_unused_paid,
    'unused_paid_credits_usd', v_unused_paid_usd,
    'owed_prizes', v_owed_count,
    'owed_prizes_usd', v_owed_usd,
    'confirmed_purchases', v_receipts_count,
    'confirmed_purchases_usd', v_receipts_usd,
    'reserves_usd', public.reserve_balance_usd(),
    'catalog_problems', coalesce((select jsonb_agg(jsonb_build_object('prize_id', c.prize_id, 'problem', c.problem)) from public.prize_catalog_problems() c), '[]'::jsonb),
    'budgets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'source', b.source, 'name', b.name, 'funded_usd', b.funded_usd, 'pause_threshold_usd', b.pause_threshold_usd,
        'active', b.active,
        'committed_usd', (select coalesce(sum(case when r.status = 'reserved' then r.reserved_usd when r.status = 'consumed' then coalesce(r.actual_usd, r.reserved_usd) else 0 end), 0)
                            from public.sponsored_reservations r where r.budget_id = b.id)
      ) order by b.created_at) from public.sponsored_budgets b), '[]'::jsonb),
    'unverified_costs', coalesce((select jsonb_agg(c.description) from public.operating_costs c where c.retired_at is null and c.amount_usd is null), '[]'::jsonb)
  );
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.prize_unit_cost_usd(uuid)', 'public.marginal_spin_cost_usd()', 'public.available_prize_pool()',
    'public.expected_spin_cost_usd()', 'public.worst_case_spin_cost_usd()', 'public.worst_case_obligation_usd(bigint)',
    'public.prize_catalog_problems()', 'public.outstanding_spin_count()', 'public.reserve_balance_usd()',
    'public.purchase_gate(int)', 'public.grant_spins(uuid, int, text, uuid, text)', 'public.economic_status()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function public._reserve_sponsored_credit(uuid, text) from public, anon, authenticated, service_role;

-- Spin credits are created only by the functions that fund/verify them.
revoke insert, update, delete, truncate on public.spin_credits from service_role, authenticated, anon;
grant select on public.spin_credits to service_role;
