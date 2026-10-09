-- ============================================================================
-- Season lifecycle, finalisation, backfill report and monitors
-- (season leaderboard, part 7 of 7)
--
-- Nothing here activates a season: an admin must create a draft with real
-- dates and verified snapshot collections, then activate it deliberately.
-- ============================================================================

create or replace function public.create_season_draft(
  _slug text, _name text, _starts_at timestamptz, _ends_at timestamptz, _settlement_deadline timestamptz, _rules jsonb, _notes text, _actor uuid
)
returns public.seasons
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons;
begin
  if _actor is null then raise exception 'Season changes need an accountable actor'; end if;
  insert into public.seasons (slug, name, starts_at, ends_at, settlement_deadline, rules, notes, created_by)
  values (lower(btrim(_slug)), btrim(_name), _starts_at, _ends_at, _settlement_deadline, public.normalize_season_rules(_rules), _notes, _actor)
  returning * into s;
  insert into public.audit_log (actor, action, details) values (_actor, 'season.draft_created', jsonb_build_object('season_id', s.id, 'slug', s.slug));
  return s;
end
$$;

create or replace function public.update_season_draft(
  _season_id uuid, _name text, _starts_at timestamptz, _ends_at timestamptz, _settlement_deadline timestamptz, _rules jsonb, _notes text, _actor uuid
)
returns public.seasons
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons;
begin
  if _actor is null then raise exception 'Season changes need an accountable actor'; end if;
  select * into s from public.seasons where id = _season_id for update;
  if not found then raise exception 'Unknown season'; end if;
  if s.status <> 'draft' then raise exception 'Only drafts can be edited; rules are frozen once a season is activated'; end if;
  update public.seasons set name = btrim(_name), starts_at = _starts_at, ends_at = _ends_at, settlement_deadline = _settlement_deadline,
         rules = public.normalize_season_rules(_rules), notes = _notes
   where id = _season_id returning * into s;
  insert into public.audit_log (actor, action, details) values (_actor, 'season.draft_updated', jsonb_build_object('season_id', s.id, 'rules', s.rules));
  return s;
end
$$;

create or replace function public.set_season_collections(_season_id uuid, _collection_ids uuid[], _actor uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_count int;
begin
  if _actor is null then raise exception 'Season changes need an accountable actor'; end if;
  delete from public.season_collections where season_id = _season_id;
  insert into public.season_collections (season_id, collection_id)
  select _season_id, c.id from public.nft_collections c where c.id = any (coalesce(_collection_ids, '{}')) and c.status <> 'retired';
  get diagnostics v_count = row_count;
  insert into public.audit_log (actor, action, details) values (_actor, 'season.collections_set', jsonb_build_object('season_id', _season_id, 'collections', _collection_ids));
  return v_count;
end
$$;

-- Freeze rules + snapshot configuration and open the season. Deliberate admin action only.
create or replace function public.activate_season(_season_id uuid, _actor uuid)
returns public.seasons
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seasons;
  v_rules jsonb;
  rv public.season_rule_versions;
  v_bad int;
begin
  if _actor is null then raise exception 'Activation needs an accountable actor'; end if;
  select * into s from public.seasons where id = _season_id for update;
  if not found then raise exception 'Unknown season'; end if;
  if s.status <> 'draft' or s.is_legacy then raise exception 'Only draft seasons can be activated'; end if;
  if s.starts_at is null or s.ends_at is null or s.settlement_deadline is null then raise exception 'Set the UTC start, exclusive end and settlement deadline'; end if;
  if s.ends_at <= now() then raise exception 'This season''s end is already in the past'; end if;
  if exists (select 1 from public.seasons x where x.status = 'active') then raise exception 'Another season is active'; end if;
  if exists (select 1 from public.seasons x where x.id <> s.id and not x.is_legacy and x.status <> 'draft'
              and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)')) then
    raise exception 'Season window overlaps another season';
  end if;
  v_rules := public.normalize_season_rules(s.rules);
  if (v_rules ->> 'nft_snapshot_points')::bigint > 0 then
    if not exists (select 1 from public.season_collections sc where sc.season_id = s.id) then
      raise exception 'Link at least one verified snapshot collection, or set nft_snapshot_points to 0';
    end if;
    select count(*) into v_bad from public.season_collections sc join public.nft_collections c on c.id = sc.collection_id
     where sc.season_id = s.id and c.status not in ('verified', 'frozen');
    if v_bad > 0 then raise exception '% snapshot collection(s) are not verified yet', v_bad; end if;
  end if;
  if (v_rules ->> 'social_enabled')::boolean and not exists (select 1 from public.app_config where key = 'social') then
    raise exception 'Configure share verification first';
  end if;

  insert into public.season_rule_versions (season_id, version, rules, rules_hash, frozen_by)
  values (s.id, 1, v_rules, public.rules_hash(v_rules), _actor) returning * into rv;
  update public.nft_collections c set status = 'frozen', frozen_at = now()
   where c.status = 'verified' and c.id in (select sc.collection_id from public.season_collections sc where sc.season_id = s.id);
  update public.seasons set rules = v_rules, rules_hash = rv.rules_hash, rule_version_id = rv.id, status = 'active',
         activated_at = now(), activated_by = _actor
   where id = s.id returning * into s;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'season.activated', jsonb_build_object('season_id', s.id, 'slug', s.slug, 'rules_hash', s.rules_hash,
          'starts_at', s.starts_at, 'ends_at', s.ends_at, 'settlement_deadline', s.settlement_deadline));
  return s;
end
$$;

-- Active seasons whose exclusive end has passed move to settling (called by the worker; idempotent).
create or replace function public.advance_season_states()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_count int;
begin
  update public.seasons set status = 'settling', settling_at = now()
   where status = 'active' and now() >= ends_at;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create or replace function public.season_unresolved_items(_season_id uuid)
returns table (kind text, item_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select 'pending_spins', count(*) from public.spins s where s.season_id = _season_id and s.status = 'pending'
  union all
  select 'open_draw_batches', count(*) from public.draw_batches b
   where b.season_id = _season_id and b.status in ('reserved', 'signed', 'broadcast', 'confirmed', 'conflict')
  union all
  select 'snapshot_claims', count(*) from public.nft_snapshot_claims c where c.season_id = _season_id and c.status in ('pending', 'unavailable')
  union all
  select 'share_reviews', count(*) from public.social_shares x where x.season_id = _season_id and x.status = 'pending'
$$;

-- Aggregates that disagree with the ledger (should always be empty).
create or replace function public.ledger_drift(_season_id uuid)
returns table (user_id uuid, aggregate_total bigint, ledger_total bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with l as (
    select l.user_id, sum(l.amount)::bigint as total from public.points_ledger l where l.season_id = _season_id group by l.user_id
  ), a as (
    select sc.user_id, sc.total from public.season_scores sc where sc.season_id = _season_id
  )
  select coalesce(a.user_id, l.user_id), coalesce(a.total, 0), coalesce(l.total, 0)
    from a
    full join l on l.user_id = a.user_id
   where coalesce(a.total, 0) <> coalesce(l.total, 0)
$$;

create or replace function public.finalize_season(_season_id uuid, _actor uuid)
returns public.final_standings_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seasons;
  v public.final_standings_versions;
  v_open text;
begin
  if _actor is null then raise exception 'Finalisation needs an accountable actor'; end if;
  select * into s from public.seasons where id = _season_id for update;
  if not found then raise exception 'Unknown season'; end if;
  if s.status <> 'settling' then raise exception 'Only settling seasons can be finalised (status %)', s.status; end if;
  select string_agg(u.kind || ': ' || u.item_count, ', ') into v_open from public.season_unresolved_items(s.id) u where u.item_count > 0;
  if v_open is not null then raise exception 'Resolve these first — %', v_open; end if;
  if exists (select 1 from public.ledger_drift(s.id)) then raise exception 'Season totals disagree with the ledger; investigate before finalising'; end if;
  v := public._write_final_standings(s.id, _actor, null);
  update public.seasons set status = 'finalized', finalized_at = v.finalized_at, finalized_by = _actor where id = s.id;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'season.finalized', jsonb_build_object('season_id', s.id, 'version', v.version, 'watermark', v.ledger_watermark,
          'export_hash', v.export_hash, 'rules_hash', v.rules_hash, 'entries', v.entry_count));
  return v;
end
$$;

create or replace function public.supersede_final_standings(_season_id uuid, _reason text, _actor uuid)
returns public.final_standings_versions
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons; v public.final_standings_versions;
begin
  if _actor is null then raise exception 'Corrections need an accountable actor'; end if;
  if _reason is null or length(btrim(_reason)) < 5 then raise exception 'Explain the correction (at least 5 characters)'; end if;
  select * into s from public.seasons where id = _season_id for update;
  if s.status <> 'finalized' or s.is_legacy then raise exception 'Only finalised (non-legacy) seasons take corrections'; end if;
  if exists (select 1 from public.ledger_drift(s.id)) then raise exception 'Season totals disagree with the ledger'; end if;
  v := public._write_final_standings(s.id, _actor, _reason);
  insert into public.audit_log (actor, action, details)
  values (_actor, 'season.standings_superseded', jsonb_build_object('season_id', s.id, 'version', v.version, 'supersedes', v.supersedes_id,
          'reason', btrim(_reason), 'export_hash', v.export_hash));
  return v;
end
$$;

-- ---------------------------------------------------------------------------
-- Historical backfill: dry-run report always available; applying needs the
-- season's frozen historical_backfill_enabled rule (off by default).
-- NFT snapshot points are never backfilled: players must claim and each claim
-- is verified at the snapshot block (current ownership is never used).
-- ---------------------------------------------------------------------------
create or replace function public.season_backfill_report(_season_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare s public.seasons; v jsonb;
begin
  select * into s from public.seasons where id = _season_id;
  if not found then raise exception 'Unknown season'; end if;
  with candidates as (
    select sp.id, sp.user_id, sp.prize_id, sp.rarity, b.request_block_time,
           (b.request_block_time is not null and b.request_block_time >= s.starts_at and b.request_block_time < s.ends_at) as in_window
      from public.spins sp left join public.draw_batches b on b.id = sp.batch_id
     where sp.status = 'fulfilled' and sp.season_id is null
       and not exists (select 1 from public.points_ledger l where l.season_id = s.id and l.source_type = 'spin' and l.source_id = sp.id::text)
  )
  select jsonb_build_object(
    'season', s.slug,
    'enabled', coalesce((s.rules ->> 'historical_backfill_enabled')::boolean, false),
    'eligible_spins', count(*) filter (where in_window),
    'unverifiable_spins', count(*) filter (where request_block_time is null),
    'outside_window_spins', count(*) filter (where request_block_time is not null and not in_window),
    'points_if_applied', coalesce(sum(case when in_window then (s.rules ->> 'participation_points')::bigint
                                        + public.prize_bonus_for(s.rules, prize_id, rarity) else 0 end), 0)::text,
    'nft_snapshot', 'not backfilled — each token is claimed and verified at the snapshot block'
  ) into v from candidates;
  return v;
end
$$;

create or replace function public.apply_season_backfill(_season_id uuid, _actor uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons; sp record; v_count int := 0;
begin
  if _actor is null then raise exception 'Backfill needs an accountable actor'; end if;
  select * into s from public.seasons where id = _season_id for share;
  if not coalesce((s.rules ->> 'historical_backfill_enabled')::boolean, false) then raise exception 'Historical backfill is disabled for this season'; end if;
  if s.status not in ('active', 'settling') then raise exception 'Season is not accepting points'; end if;
  for sp in
    select x.id, x.user_id, x.prize_id, x.rarity from public.spins x join public.draw_batches b on b.id = x.batch_id
     where x.status = 'fulfilled' and x.season_id is null
       and b.request_block_time >= s.starts_at and b.request_block_time < s.ends_at
  loop
    if public._award_points(s.id, sp.user_id, 'spin', sp.id::text, 'participation', (s.rules ->> 'participation_points')::bigint,
                            s.rule_version_id, now(), jsonb_build_object('backfill', true), _actor) is not null then
      v_count := v_count + 1;
    end if;
    perform public._award_points(s.id, sp.user_id, 'spin', sp.id::text, 'prize_bonus', public.prize_bonus_for(s.rules, sp.prize_id, sp.rarity),
                                 s.rule_version_id, now(), jsonb_build_object('backfill', true), _actor);
  end loop;
  insert into public.audit_log (actor, action, details) values (_actor, 'season.backfill_applied', jsonb_build_object('season_id', s.id, 'spins', v_count));
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Published rules with projections from the actual available pool
-- ---------------------------------------------------------------------------
create or replace function public.get_season_rules(_season_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare s public.seasons; v_odds jsonb; v_bonus numeric; v_all_available boolean;
begin
  select * into s from public.seasons where id = _season_id and status <> 'draft';
  if not found then raise exception 'Unknown season'; end if;
  if s.is_legacy then
    return jsonb_build_object('season', s.slug, 'legacy', true, 'notes', s.notes);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', a.name, 'rarity', a.rarity, 'probability', round(a.probability, 6),
           'remaining', a.inventory, 'bonus', public.prize_bonus_for(s.rules, a.prize_id, a.rarity)) order by a.onchain_index nulls last, a.name), '[]'::jsonb),
         sum(a.probability * public.prize_bonus_for(s.rules, a.prize_id, a.rarity))
    into v_odds, v_bonus
    from public.available_prize_pool() a;
  select not exists (select 1 from public.prizes p where p.active and p.weight > 0 and p.inventory = 0) into v_all_available;
  return jsonb_build_object(
    'season', s.slug, 'name', s.name, 'status', s.status, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'settlement_deadline', s.settlement_deadline, 'rules', s.rules, 'rules_hash', s.rules_hash,
    'odds', v_odds,
    'expected_bonus_per_spin', round(coalesce(v_bonus, 0), 2),
    'expected_points_per_spin', round(coalesce(v_bonus, 0) + (s.rules ->> 'participation_points')::numeric, 2),
    'all_prizes_available', v_all_available
  );
end
$$;
revoke all on function public.get_season_rules(uuid) from public;
grant execute on function public.get_season_rules(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Monitors (the worker calls this every run; admins see open alerts)
-- ---------------------------------------------------------------------------
create or replace function public.ops_monitor_scan()
returns setof public.ops_alerts
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
  for r in select b.id, b.status, b.created_at from public.draw_batches b
            where b.status in ('reserved', 'signed', 'broadcast') and b.created_at < now() - interval '10 minutes' loop
    perform public.raise_ops_alert('stuck_draw:' || r.id, 'stuck_draw', 'warning',
      'Draw request has not been confirmed on-chain for over 10 minutes (' || r.status || '). Credits stay reserved.',
      jsonb_build_object('batch_id', r.id, 'status', r.status, 'since', r.created_at));
  end loop;
  for r in select b.id, b.reconciled_at from public.draw_batches b
            where b.status = 'confirmed' and b.reconciled_at < now() - interval '30 minutes' loop
    perform public.raise_ops_alert('vrf_unfulfilled:' || r.id, 'vrf_funding', 'critical',
      'Chainlink has not answered a confirmed request for over 30 minutes. Check the VRF subscription balance.',
      jsonb_build_object('batch_id', r.id, 'confirmed_at', r.reconciled_at));
  end loop;
  for r in select s.id, s.slug from public.seasons s where s.status in ('active', 'settling') loop
    if exists (select 1 from public.ledger_drift(r.id)) then
      perform public.raise_ops_alert('ledger_drift:' || r.id, 'ledger_drift', 'critical', 'Season ' || r.slug || ' totals disagree with the ledger',
                                     jsonb_build_object('season_id', r.id));
    end if;
  end loop;
  for r in select s.id, s.slug, s.settlement_deadline from public.seasons s
            where s.status in ('active', 'settling') and now() > s.settlement_deadline
              and exists (select 1 from public.season_unresolved_items(s.id) u where u.item_count > 0) loop
    perform public.raise_ops_alert('settlement_deadline:' || r.id, 'settlement_deadline', 'critical',
      'Season ' || r.slug || ' passed its settlement deadline with unresolved items. Nothing is cancelled; resolve and finalise.',
      jsonb_build_object('season_id', r.id, 'deadline', r.settlement_deadline));
  end loop;
  for r in select count(*) as n from public.nft_snapshot_claims c where c.status = 'unavailable' and c.attempts >= 3 having count(*) > 0 loop
    perform public.raise_ops_alert('verification:snapshot', 'verification_failure', 'warning',
      r.n || ' snapshot claim(s) keep failing verification (archive RPC unavailable?)', jsonb_build_object('claims', r.n));
  end loop;
  for r in select count(*) as n from public.social_shares x where x.status = 'pending' and x.submitted_at < now() - interval '72 hours' having count(*) > 0 loop
    perform public.raise_ops_alert('verification:social', 'verification_failure', 'warning',
      r.n || ' share(s) waiting more than 72 hours for review', jsonb_build_object('shares', r.n));
  end loop;
  for r in
    select b.id, b.name, b.funded_usd, b.pause_threshold_usd,
           coalesce(sum(case when x.status = 'reserved' then x.reserved_usd when x.status = 'consumed' then coalesce(x.actual_usd, x.reserved_usd) else 0 end), 0) as used
      from public.sponsored_budgets b left join public.sponsored_reservations x on x.budget_id = b.id
     where b.active group by b.id
  loop
    if r.funded_usd - r.used <= greatest(r.pause_threshold_usd, 0) + coalesce(public.worst_case_spin_cost_usd(), 0) * 5 then
      perform public.raise_ops_alert('budget:' || r.id, 'budget_exhaustion', 'warning',
        'Sponsored budget "' || r.name || '" is nearly exhausted; new sponsored spins will pause.',
        jsonb_build_object('budget_id', r.id, 'funded', r.funded_usd, 'used', r.used));
    end if;
  end loop;
  return query select * from public.ops_alerts a where a.resolved_at is null order by a.raised_at desc;
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.create_season_draft(text, text, timestamptz, timestamptz, timestamptz, jsonb, text, uuid)',
    'public.update_season_draft(uuid, text, timestamptz, timestamptz, timestamptz, jsonb, text, uuid)',
    'public.set_season_collections(uuid, uuid[], uuid)', 'public.activate_season(uuid, uuid)', 'public.advance_season_states()',
    'public.season_unresolved_items(uuid)', 'public.ledger_drift(uuid)', 'public.finalize_season(uuid, uuid)',
    'public.supersede_final_standings(uuid, text, uuid)', 'public.season_backfill_report(uuid)', 'public.apply_season_backfill(uuid, uuid)',
    'public.ops_monitor_scan()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Final sweep: anything in public still executable by the API roles is reviewed here.
-- Read-only public RPCs stay granted: list_seasons, get_season_leaderboard, get_season_rules (anon + authenticated),
-- get_my_season_standing and has_role (authenticated). Everything else is service-role only.
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
