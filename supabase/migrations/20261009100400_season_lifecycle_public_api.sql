-- ============================================================================
-- Season lifecycle (activate -> settling -> finalized, audited corrections), public read API,
-- profile aliases, historical backfill (off by default, dry-run first) and database monitors.
-- ============================================================================

alter table public.prizes drop constraint if exists prizes_inventory_nonneg;
alter table public.prizes add constraint prizes_inventory_nonneg check (inventory is null or inventory >= 0) not valid;

-- ---------------------------------------------------------------------------
-- Lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.season_activation_errors(_season uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.seasons;
  errs text[] := '{}';
  k text;
  cid text;
  st text;
begin
  select * into s from public.seasons where id = _season;
  if not found then return array['Unknown season']; end if;
  if s.status <> 'draft' then errs := errs || format('Season is %s, not draft', s.status); end if;
  if s.is_legacy then errs := errs || text 'Legacy seasons cannot be activated'; end if;
  if s.starts_at is null or s.ends_at is null or s.settlement_deadline is null then
    errs := errs || text 'Set the UTC start, exclusive end and settlement deadline';
  elsif s.ends_at <= now() then
    errs := errs || text 'The season end is in the past';
  end if;
  errs := errs || public.season_rules_errors(s.rules);
  if jsonb_typeof(s.rules #> '{points,prize_bonus_overrides}') = 'object' then
    for k in select jsonb_object_keys(s.rules #> '{points,prize_bonus_overrides}') loop
      if not exists (select 1 from public.prizes where id::text = k) then errs := errs || format('Bonus override for unknown prize %s', k); end if;
    end loop;
  end if;
  if exists (select 1 from public.seasons o where o.id <> s.id and not o.is_legacy and o.status <> 'draft'
              and o.starts_at < s.ends_at and s.starts_at < o.ends_at) then
    errs := errs || text 'The window overlaps another published season';
  end if;
  if exists (select 1 from public.seasons where status = 'active' and id <> s.id) then errs := errs || text 'Another season is active'; end if;
  if coalesce(s.rules #>> '{points,nft_snapshot_per_token}', '0') <> '0' then
    if jsonb_array_length(coalesce(s.snapshot_config -> 'collection_ids', '[]'::jsonb)) = 0 then
      errs := errs || text 'NFT snapshot points need at least one ready collection (or set nft_snapshot_per_token to "0")';
    end if;
    for cid in select jsonb_array_elements_text(coalesce(s.snapshot_config -> 'collection_ids', '[]'::jsonb)) loop
      select status into st from public.nft_collections where id::text = cid;
      if st is distinct from 'ready' then errs := errs || format('Collection %s is not ready (%s)', cid, coalesce(st, 'missing')); end if;
    end loop;
  end if;
  if exists (select 1 from public.prize_pool_issues()) then errs := errs || text 'Resolve prize classification/stock/cost issues first'; end if;
  return errs;
end
$$;

create or replace function public.activate_season(_season uuid, _actor uuid)
returns public.seasons
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons; errs text[];
begin
  if _actor is null or not public.has_role(_actor, 'admin') then raise exception 'Forbidden'; end if;
  perform 1 from public.seasons where id = _season for update;
  errs := public.season_activation_errors(_season);
  if cardinality(errs) > 0 then raise exception 'Cannot activate: %', array_to_string(errs, '; '); end if;
  update public.seasons
     set status = 'active', activated_at = now(), rules_hash = encode(extensions.digest(rules::text, 'sha256'), 'hex')
   where id = _season returning * into s;
  insert into public.audit_log (actor, action, details) values (_actor, 'season.activated', jsonb_build_object('season_id', s.id, 'rules_hash', s.rules_hash, 'rules_version', s.rules_version));
  return s;
end
$$;

-- Moves seasons whose cutoff has passed from active to settling (worker or admin).
create or replace function public.advance_seasons()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  with u as (
    update public.seasons set status = 'settling', settling_at = now()
     where status = 'active' and ends_at <= now()
    returning id)
  select count(*) into n from u;
  return n;
end
$$;

-- What still blocks finalization.
create or replace function public.season_unresolved(_season uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select * from public.seasons where id = _season)
  select jsonb_build_object(
    'pending_draws', (select count(*) from public.spins sp, s
                       where sp.season_id = s.id and sp.status = 'pending'
                         and (sp.request_confirmed_at is null or sp.request_confirmed_at < s.ends_at)),
    'unreconciled_batches', (select count(*) from public.draw_batches b where b.season_id = _season and b.status in ('reserved', 'signed', 'broadcast', 'ambiguous')),
    'open_snapshot_claims', (select count(*) from public.nft_snapshot_claims c where c.season_id = _season and c.status in ('pending', 'unavailable')),
    'pending_share_reviews', (select count(*) from public.social_shares x where x.season_id = _season and x.status = 'pending'))
$$;

create or replace function public.finalize_season(_season uuid, _actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons; open jsonb; v int;
begin
  if _actor is null or not public.has_role(_actor, 'admin') then raise exception 'Forbidden'; end if;
  select * into s from public.seasons where id = _season for update;
  if s.status <> 'settling' then raise exception 'Only a settling season can be finalized (this one is %)', s.status; end if;
  if now() < s.ends_at then raise exception 'The season has not ended yet'; end if;
  open := public.season_unresolved(_season);
  if (open ->> 'pending_draws')::int + (open ->> 'unreconciled_batches')::int + (open ->> 'open_snapshot_claims')::int + (open ->> 'pending_share_reviews')::int > 0 then
    raise exception 'Unresolved work blocks finalization: %', open;
  end if;
  v := public.write_season_standings(_season, _actor, null, null);
  update public.seasons set status = 'finalized', finalized_at = now() where id = _season;
  perform public.resolve_alert('settlement_deadline', _season::text, _actor);
  insert into public.audit_log (actor, action, details) values (_actor, 'season.finalized', jsonb_build_object('season_id', _season, 'version', v));
  return jsonb_build_object('version', v);
end
$$;

-- Audited correction of a finalized season: reversals/adjustments, then a superseding standings version.
-- _ops: [{"op":"reverse","ledger_id":"123","amount":"10"}, {"op":"adjust","user_id":"...","amount":"-5"}]
create or replace function public.correct_finalized_season(_season uuid, _actor uuid, _reason text, _ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons; o jsonb; prev int; v int;
begin
  if _actor is null or not public.has_role(_actor, 'admin') then raise exception 'Forbidden'; end if;
  if _reason is null or char_length(btrim(_reason)) < 3 then raise exception 'A reason is required'; end if;
  select * into s from public.seasons where id = _season for update;
  if s.status <> 'finalized' then raise exception 'Only finalized seasons take corrections'; end if;
  if jsonb_typeof(_ops) <> 'array' or jsonb_array_length(_ops) = 0 then raise exception 'No correction operations'; end if;
  perform set_config('gotcha.season_correction', _season::text, true);
  for o in select * from jsonb_array_elements(_ops) loop
    if o ->> 'op' = 'reverse' then
      if not exists (select 1 from public.points_ledger where id = (o ->> 'ledger_id')::bigint and season_id = _season) then
        raise exception 'Ledger entry % is not in this season', o ->> 'ledger_id';
      end if;
      perform public.reverse_ledger_entry((o ->> 'ledger_id')::bigint, (o ->> 'amount')::bigint, _reason, _actor);
    elsif o ->> 'op' = 'adjust' then
      perform public.admin_adjust_points(_season, (o ->> 'user_id')::uuid, (o ->> 'amount')::bigint, _reason, _actor);
    else
      raise exception 'Unknown correction op %', o ->> 'op';
    end if;
  end loop;
  perform set_config('gotcha.season_correction', '', true);
  select max(version) into prev from public.season_standings_versions where season_id = _season;
  v := public.write_season_standings(_season, _actor, prev, btrim(_reason));
  insert into public.audit_log (actor, action, details) values (_actor, 'season.corrected', jsonb_build_object('season_id', _season, 'version', v, 'supersedes', prev, 'reason', btrim(_reason), 'ops', _ops));
  return jsonb_build_object('version', v, 'supersedes', prev);
end
$$;

-- ---------------------------------------------------------------------------
-- Historical backfill: OFF unless the season's rules enable it. Spins only — snapshot ownership is
-- never inferred from current holdings.
-- ---------------------------------------------------------------------------
create or replace function public.season_backfill_report(_season uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare s public.seasons; r jsonb;
begin
  select * into s from public.seasons where id = _season;
  if not found then raise exception 'Unknown season'; end if;
  select jsonb_build_object(
    'enabled', coalesce((s.rules ->> 'historical_backfill_enabled')::boolean, false),
    'spins', count(*),
    'participation_points', coalesce(sum((s.rules #>> '{points,participation_per_spin}')::bigint), 0)::text,
    'bonus_points', coalesce(sum(coalesce(s.rules #>> array['points', 'prize_bonus_overrides', sp.prize_id::text],
                                          s.rules #>> array['points', 'rarity_bonus', sp.rarity], '0')::bigint), 0)::text,
    'players', count(distinct sp.user_id),
    'note', 'NFT snapshot points are never backfilled from current ownership.')
    into r
    from public.spins sp
   where sp.status = 'fulfilled' and sp.season_id is null and sp.created_at >= s.starts_at and sp.created_at < s.ends_at
     and not exists (select 1 from public.points_ledger l where l.season_id = s.id and l.source_type = 'spin' and l.source_id = sp.id::text);
  return r;
end
$$;

create or replace function public.apply_season_backfill(_season uuid, _actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare s public.seasons; sp record; n int := 0;
begin
  if _actor is null or not public.has_role(_actor, 'admin') then raise exception 'Forbidden'; end if;
  select * into s from public.seasons where id = _season for update;
  if s.status not in ('active', 'settling') then raise exception 'Backfill needs an active or settling season'; end if;
  if not coalesce((s.rules ->> 'historical_backfill_enabled')::boolean, false) then raise exception 'Historical backfill is disabled for this season'; end if;
  for sp in select * from public.spins
             where status = 'fulfilled' and season_id is null and created_at >= s.starts_at and created_at < s.ends_at loop
    perform public.ledger_award(s.id, sp.user_id, 'spin', sp.id::text, 'participation', (s.rules #>> '{points,participation_per_spin}')::bigint,
                                s.rules_version, sp.created_at, jsonb_build_object('backfill', true), _actor);
    perform public.ledger_award(s.id, sp.user_id, 'spin', sp.id::text, 'prize_bonus',
                                coalesce(s.rules #>> array['points', 'prize_bonus_overrides', sp.prize_id::text], s.rules #>> array['points', 'rarity_bonus', sp.rarity], '0')::bigint,
                                s.rules_version, sp.created_at, jsonb_build_object('backfill', true), _actor);
    n := n + 1;
  end loop;
  insert into public.audit_log (actor, action, details) values (_actor, 'season.backfilled', jsonb_build_object('season_id', _season, 'spins', n));
  return jsonb_build_object('spins', n);
end
$$;

-- ---------------------------------------------------------------------------
-- Public profile (alias/avatar chosen explicitly)
-- ---------------------------------------------------------------------------
create or replace function public.set_public_profile(_user uuid, _alias text, _avatar text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare p public.profiles; a text := nullif(btrim(_alias), '');
begin
  if a is not null and lower(regexp_replace(a, '[^A-Za-z0-9]', '', 'g')) ~ '(admin|moderator|official|apegames|support|staff)' then
    raise exception 'That alias is reserved';
  end if;
  begin
    update public.profiles set public_alias = a, avatar_key = nullif(btrim(_avatar), ''), public_profile_updated_at = now()
     where id = _user returning * into p;
  exception when unique_violation then
    raise exception 'That alias is taken';
  when check_violation then
    raise exception 'Aliases are 3-24 letters, numbers, spaces, dots, dashes or underscores';
  end;
  if not found then raise exception 'Profile not found'; end if;
  return p;
end
$$;

-- ---------------------------------------------------------------------------
-- Public read API (no emails, wallets, private ledgers or auth ids)
-- ---------------------------------------------------------------------------
create or replace function public.get_public_seasons()
returns table (id uuid, slug text, name text, status public.season_status, is_legacy boolean, starts_at timestamptz,
               ends_at timestamptz, settlement_deadline timestamptz, grace_hours int, rules jsonb, rules_version int,
               rules_hash text, standings_version int, standings_export_hash text, finalized_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.slug, s.name, s.status, s.is_legacy, s.starts_at, s.ends_at, s.settlement_deadline,
         (extract(epoch from s.grace_period) / 3600)::int, s.rules, s.rules_version, s.rules_hash,
         v.version, v.export_hash, s.finalized_at
    from public.seasons s
    left join lateral (select version, export_hash from public.season_standings_versions x
                        where x.season_id = s.id order by version desc limit 1) v on true
   where s.status <> 'draft'
   order by s.is_legacy, s.starts_at desc nulls last
$$;

create or replace function public.get_season_leaderboard(_slug text, _offset int default 0, _limit int default 10)
returns table (rank bigint, public_id text, alias text, avatar_key text, total_points text, nft_points text,
               participation_points text, prize_points text, social_points text, adjustment_points text,
               total_reached_at timestamptz, total_count bigint, standings_version int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare s public.seasons; v int;
begin
  select * into s from public.seasons where slug = _slug and status <> 'draft';
  if not found then raise exception 'Unknown season'; end if;
  _offset := greatest(coalesce(_offset, 0), 0);
  _limit := least(greatest(coalesce(_limit, 10), 1), 100);
  if s.status = 'finalized' then
    select max(x.version) into v from public.season_standings_versions x where x.season_id = s.id;
    return query
      select st.rank, st.public_id, p.public_alias, p.avatar_key, st.total_points::text, st.nft_points::text,
             st.participation_points::text, st.prize_points::text, st.social_points::text, st.adjustment_points::text,
             st.total_reached_at, count(*) over (), v
        from public.season_standings st
        left join public.profiles p on p.id = st.user_id
       where st.season_id = s.id and st.version = v
       order by st.rank
      offset _offset limit _limit;
  else
    return query
      select r.rank, p.public_id, p.public_alias, p.avatar_key, r.total_points::text, r.nft_points::text,
             r.participation_points::text, r.prize_points::text, r.social_points::text, r.adjustment_points::text,
             r.total_reached_at, count(*) over (), null::int
        from public.season_ranking(s.id) r
        join public.profiles p on p.id = r.user_id
       order by r.rank
      offset _offset limit _limit;
  end if;
end
$$;

-- The signed-in player's own place (uses auth.uid(); never takes a user id).
create or replace function public.get_my_season_standing(_slug text)
returns table (rank bigint, total_points text, nft_points text, participation_points text, prize_points text,
               social_points text, adjustment_points text, total_reached_at timestamptz, players bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare s public.seasons; v int; me uuid := auth.uid();
begin
  if me is null then return; end if;
  select * into s from public.seasons where slug = _slug and status <> 'draft';
  if not found then return; end if;
  if s.status = 'finalized' then
    select max(x.version) into v from public.season_standings_versions x where x.season_id = s.id;
    return query
      select st.rank, st.total_points::text, st.nft_points::text, st.participation_points::text, st.prize_points::text,
             st.social_points::text, st.adjustment_points::text, st.total_reached_at,
             (select count(*) from public.season_standings z where z.season_id = s.id and z.version = v)
        from public.season_standings st where st.season_id = s.id and st.version = v and st.user_id = me;
  else
    return query
      select r.rank, r.total_points::text, r.nft_points::text, r.participation_points::text, r.prize_points::text,
             r.social_points::text, r.adjustment_points::text, r.total_reached_at,
             (select count(*) from public.season_scores z where z.season_id = s.id)
        from public.season_ranking(s.id) r where r.user_id = me;
  end if;
end
$$;

-- Old signature kept for callers; now returns public ids/aliases and string totals only.
drop function if exists public.get_leaderboard(int);
create or replace function public.get_leaderboard(_limit int default 100)
returns table (rank bigint, public_id text, display_name text, avatar_key text, points text)
language sql
stable
security definer
set search_path = ''
as $$
  with pick as (
    select s.slug from public.seasons s
     where s.status <> 'draft'
     order by (s.status = 'active') desc, s.is_legacy asc, s.starts_at desc nulls last
     limit 1)
  select l.rank, l.public_id, coalesce(l.alias, 'Ape ' || right(l.public_id, 4)), l.avatar_key, l.total_points
    from pick, public.get_season_leaderboard(pick.slug, 0, least(greatest(coalesce(_limit, 100), 1), 100)) l
$$;

-- ---------------------------------------------------------------------------
-- Monitors (database side). Chain-side checks (VRF funding, chain inventory) run in the worker.
-- ---------------------------------------------------------------------------
create or replace function public.run_db_monitors()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  drift int := 0;
  stuck int := 0;
  late int := 0;
  failing int := 0;
begin
  for r in
    select sc.season_id, sc.user_id, sc.total_points, coalesce(l.total, 0) as ledger_total
      from public.season_scores sc
      left join (select season_id, user_id, sum(amount) total from public.points_ledger group by 1, 2) l
        on l.season_id = sc.season_id and l.user_id = sc.user_id
     where sc.total_points <> coalesce(l.total, 0)
  loop
    drift := drift + 1;
    perform public.raise_alert('ledger_drift', r.season_id::text || ':' || r.user_id::text, 'critical', 'Season total differs from the ledger',
      jsonb_build_object('aggregate', r.total_points::text, 'ledger', r.ledger_total::text));
  end loop;

  for r in select id, status, created_at from public.draw_batches
            where status in ('reserved', 'signed', 'broadcast', 'ambiguous') and created_at < now() - interval '10 minutes' loop
    stuck := stuck + 1;
    perform public.raise_alert('stuck_draw', r.id::text, 'critical', format('Draw batch has been %s for over 10 minutes', r.status),
      jsonb_build_object('created_at', r.created_at));
  end loop;
  for r in select sp.batch_id, count(*) n, min(b.request_confirmed_at) since
             from public.spins sp join public.draw_batches b on b.id = sp.batch_id
            where sp.status = 'pending' and b.status = 'confirmed' and b.request_confirmed_at < now() - interval '30 minutes'
            group by sp.batch_id loop
    stuck := stuck + 1;
    perform public.raise_alert('unfulfilled_draw', r.batch_id::text, 'critical', 'Chainlink has not fulfilled a confirmed request for 30+ minutes (check VRF subscription funding)',
      jsonb_build_object('spins', r.n, 'since', r.since));
  end loop;

  for r in select id, slug, settlement_deadline from public.seasons
            where status in ('active', 'settling') and settlement_deadline < now() loop
    late := late + 1;
    perform public.raise_alert('settlement_deadline', r.id::text, 'critical', format('Season %s missed its settlement deadline; draws are NOT cancelled', r.slug),
      jsonb_build_object('deadline', r.settlement_deadline, 'unresolved', public.season_unresolved(r.id)));
  end loop;

  for r in select collection_id, count(*) n from public.nft_snapshot_claims where status = 'unavailable' and attempts >= 5 group by 1 loop
    failing := failing + 1;
    perform public.raise_alert('verification_failures', 'snapshot:' || r.collection_id::text, 'warning', 'Snapshot verification keeps failing (archive RPC unavailable?)',
      jsonb_build_object('claims', r.n));
  end loop;

  for r in select id, name from public.prizes where inventory < 0 loop
    perform public.raise_alert('inventory_drift', r.id::text, 'critical', format('Negative stock for %s', r.name), '{}'::jsonb);
  end loop;

  return jsonb_build_object('ledger_drift', drift, 'stuck', stuck, 'deadline_missed', late, 'verification_failures', failing);
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.season_activation_errors(uuid)',
    'public.activate_season(uuid, uuid)',
    'public.advance_seasons()',
    'public.season_unresolved(uuid)',
    'public.finalize_season(uuid, uuid)',
    'public.correct_finalized_season(uuid, uuid, text, jsonb)',
    'public.season_backfill_report(uuid)',
    'public.apply_season_backfill(uuid, uuid)',
    'public.set_public_profile(uuid, text, text)',
    'public.run_db_monitors()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Read-only public API.
revoke all on function public.get_public_seasons() from public;
revoke all on function public.get_season_leaderboard(text, int, int) from public;
revoke all on function public.get_leaderboard(int) from public;
revoke all on function public.get_my_season_standing(text) from public, anon;
grant execute on function public.get_public_seasons() to anon, authenticated, service_role;
grant execute on function public.get_season_leaderboard(text, int, int) to anon, authenticated, service_role;
grant execute on function public.get_leaderboard(int) to anon, authenticated, service_role;
grant execute on function public.get_my_season_standing(text) to authenticated, service_role;
