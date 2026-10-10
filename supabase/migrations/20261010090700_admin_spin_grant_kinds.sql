-- Admin spin grants on the season build: demo vs paid-equivalent, tracked per grant, usable immediately.
--
--   real  "paid-equivalent": a real Chainlink draw, same as a purchased spin. Still funded from a sponsored
--         budget (grant_spins reserves it), so the economic controls are unchanged.
--   demo  practice spins on the demo machine: simulated, no prizes, no points, no budget.
--
-- Builds on 20261010010000_admin_spin_grants.sql (spin_grants, spin_credits.kind/grant_id/used_at,
-- use_demo_spins). Admin-granted spins are exempt from the per-player daily/season spin limits and are
-- spent before purchased ones. Demo credits never count as outstanding draw liabilities.

-- The pre-season helper bypassed sponsored budgets; on this build every grant goes through grant_spins.
drop function if exists public.admin_grant_spins(uuid, int, text, text, uuid);

-- Grant rows are written only by grant_spins.
revoke insert, update, delete, truncate on public.spin_grants from public, anon, authenticated, service_role;
grant select on public.spin_grants to service_role;

drop function if exists public.grant_spins(uuid, int, text, uuid, text);
create or replace function public.grant_spins(
  _user_id uuid, _count int, _reason text, _actor uuid, _source text default 'grant', _kind text default 'real'
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare i int; v_credit uuid; v_grant uuid;
begin
  if _actor is null then raise exception 'Grants need an accountable actor'; end if;
  if _count < 1 or _count > 100 then raise exception 'Grant between 1 and 100 spins'; end if;
  if _source not in ('grant', 'free_entry') then raise exception 'Use grant or free_entry'; end if;
  if _kind not in ('real', 'demo') then raise exception 'Unknown spin type %', _kind; end if;
  if _kind = 'demo' and _source <> 'grant' then raise exception 'Demo spins can only be granted'; end if;
  if _reason is null or length(btrim(_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)'; end if;
  if _source = 'grant' then
    insert into public.spin_grants (user_id, kind, count, note, created_by)
    values (_user_id, _kind, _count, btrim(_reason), _actor) returning id into v_grant;
  end if;
  for i in 1.._count loop
    insert into public.spin_credits (user_id, source, created_by, kind, grant_id, ref)
    values (_user_id, _source, _actor, _kind, v_grant, case when v_grant is null then null else v_grant::text || ':' || i end)
    returning id into v_credit;
    -- Demo spins are simulated and cost nothing; real ones are reserved against a sponsored budget.
    if _kind = 'real' then perform public._reserve_sponsored_credit(v_credit, _source); end if;
  end loop;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'spins.granted', jsonb_build_object('user_id', _user_id, 'count', _count, 'source', _source,
          'kind', _kind, 'grant_id', v_grant, 'reason', btrim(_reason)));
  return _count;
end
$$;

-- Outstanding spins that could still be drawn on-chain (demo credits are never drawn).
create or replace function public.outstanding_spin_count()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.spin_credits c where c.used_spin_id is null and c.kind = 'real')
       + (select count(*) from public.spins s where s.status = 'pending')
$$;

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
  v_source text;
  v_limited int := 0;
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
  -- Limits cover spins players obtain themselves; spins an administrator granted are exempt.
  select count(*) into v_daily from public.spins x join public.spin_credits c on c.id = x.credit_id
   where x.user_id = _user_id and x.status in ('pending', 'fulfilled') and x.created_at > now() - interval '24 hours'
     and c.source <> 'grant';
  if s.id is not null then
    select count(*) into v_season from public.spins x join public.spin_credits c on c.id = x.credit_id
     where x.user_id = _user_id and x.season_id = s.id and x.status in ('pending', 'fulfilled') and c.source <> 'grant';
  else
    select count(*) into v_season from public.spins x join public.spin_credits c on c.id = x.credit_id
     where x.user_id = _user_id and x.season_id is null and x.status in ('pending', 'fulfilled') and c.source <> 'grant';
  end if;

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
    -- Real (paid-equivalent) credits only; administrator grants are spent first.
    select c.id, c.source into v_credit, v_source from public.spin_credits c
     where c.user_id = _user_id and c.used_spin_id is null and c.kind = 'real'
     order by (c.source = 'grant') desc, c.created_at, c.id limit 1 for update skip locked;
    if v_credit is null then raise exception 'Not enough spin credits'; end if;
    if v_source <> 'grant' then v_limited := v_limited + 1; end if;
    insert into public.spins (user_id, credit_id, status, batch_id, season_id, rule_version_id, chain_id, contract_address)
    values (_user_id, v_credit, 'pending', b.id, s.id, s.rule_version_id, _chain_id, lower(_contract))
    returning id into v_spin;
    update public.spin_credits c set used_spin_id = v_spin where c.id = v_credit;
    v_ids := v_ids || v_spin;
  end loop;
  if v_daily + v_limited > v_daily_limit then raise exception 'Daily spin limit reached (% per 24 hours)', v_daily_limit; end if;
  if v_season + v_limited > v_season_limit then raise exception 'Season spin limit reached (% per season)', v_season_limit; end if;
  update public.draw_batches x set spin_ids = v_ids where x.id = b.id returning * into b;
  insert into public.audit_log (actor, action, details)
  values (_user_id, 'draw.reserved', jsonb_build_object('batch_id', b.id, 'spins', _count, 'season_id', s.id, 'pool_version', _pool_version));
  return b;
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.grant_spins(uuid, int, text, uuid, text, text)', 'public.outstanding_spin_count()',
    'public.begin_draw_batch(uuid, text, int, int, text, bigint)', 'public.use_demo_spins(uuid, int)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Final sweep (same rule as 20261010090600): only the read-only public RPCs stay callable by API roles.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname not in ('list_seasons', 'get_season_leaderboard', 'get_season_rules', 'get_my_season_standing', 'has_role')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
