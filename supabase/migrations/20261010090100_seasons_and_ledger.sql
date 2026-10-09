-- ============================================================================
-- Seasons, append-only seasonal ledger, aggregates and public standings
-- (season leaderboard, part 2 of 7)
--
-- * Seasons: draft → active → settling → finalized, with a UTC start, an
--   exclusive end, a settlement deadline and rules frozen at activation.
-- * points_ledger keeps every existing amount/reason/ref and gains season,
--   source identity, reward subtype, rule version, effective time, reversal
--   reference and audit metadata. It is append-only, enforced in Postgres.
-- * season_scores holds per-season/per-player aggregates, updated in the same
--   transaction as every ledger insert; duplicate awards change nothing.
-- * All pre-existing points are archived, unchanged, in a finalized legacy season.
-- * Public standings expose only alias/avatar, an opaque public id and scores.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Default rules for a new draft season (points are engagement scores only).
-- ---------------------------------------------------------------------------
create or replace function public.default_season_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'nft_snapshot_points', 100,
    'participation_points', 10,
    'rarity_bonus', jsonb_build_object('common', 25, 'rare', 100, 'epic', 250, 'legendary', 500),
    'prize_bonus_overrides', '{}'::jsonb,
    'social_share_points', 2,
    'social_daily_limit', 1,
    'social_enabled', false,
    'referrals_enabled', false,
    'daily_spin_limit', 10,
    'season_spin_limit', 100,
    'historical_backfill_enabled', false
  )
$$;

-- Validates and normalises a rules document (unknown keys are rejected).
create or replace function public.normalize_season_rules(_rules jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  r jsonb := public.default_season_rules() || coalesce(_rules, '{}'::jsonb);
  k text;
  v jsonb;
  allowed text[] := array['nft_snapshot_points', 'participation_points', 'rarity_bonus', 'prize_bonus_overrides',
    'social_share_points', 'social_daily_limit', 'social_enabled', 'referrals_enabled', 'daily_spin_limit',
    'season_spin_limit', 'historical_backfill_enabled'];
begin
  for k in select jsonb_object_keys(r) loop
    if not (k = any (allowed)) then raise exception 'Unknown rule: %', k; end if;
  end loop;
  foreach k in array array['nft_snapshot_points', 'participation_points', 'social_share_points'] loop
    if jsonb_typeof(r -> k) <> 'number' or (r ->> k)::numeric < 0 or (r ->> k)::numeric <> trunc((r ->> k)::numeric)
       or (r ->> k)::numeric > 1000000000 then
      raise exception 'Rule % must be a whole number of points (0 or more)', k;
    end if;
  end loop;
  foreach k in array array['daily_spin_limit', 'season_spin_limit'] loop
    if jsonb_typeof(r -> k) <> 'number' or (r ->> k)::numeric < 1 or (r ->> k)::numeric > 100000
       or (r ->> k)::numeric <> trunc((r ->> k)::numeric) then
      raise exception 'Rule % must be a whole number between 1 and 100000', k;
    end if;
  end loop;
  if (r ->> 'social_daily_limit')::numeric is distinct from 1 then
    raise exception 'social_daily_limit is fixed at 1 rewarded share per player per UTC day';
  end if;
  foreach k in array array['social_enabled', 'referrals_enabled', 'historical_backfill_enabled'] loop
    if jsonb_typeof(r -> k) <> 'boolean' then raise exception 'Rule % must be true or false', k; end if;
  end loop;
  if (r ->> 'referrals_enabled')::boolean then raise exception 'Referrals are disabled'; end if;
  if jsonb_typeof(r -> 'rarity_bonus') <> 'object' then raise exception 'rarity_bonus must be an object'; end if;
  for k, v in select * from jsonb_each(r -> 'rarity_bonus') loop
    if k not in ('common', 'rare', 'epic', 'legendary') then raise exception 'Unknown rarity %', k; end if;
    if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
      raise exception 'Bonus for % must be a whole number (0 or more)', k;
    end if;
  end loop;
  if jsonb_typeof(r -> 'prize_bonus_overrides') <> 'object' then raise exception 'prize_bonus_overrides must be an object'; end if;
  for k, v in select * from jsonb_each(r -> 'prize_bonus_overrides') loop
    if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Prize bonus overrides are keyed by prize id (got %)', k;
    end if;
    if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
      raise exception 'Override for prize % must be a whole number (0 allowed)', k;
    end if;
  end loop;
  return r;
end
$$;

create or replace function public.rules_hash(_rules jsonb)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(sha256(convert_to(_rules::text, 'UTF8')), 'hex') $$;

-- ---------------------------------------------------------------------------
-- Seasons
-- ---------------------------------------------------------------------------
create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  status text not null default 'draft' check (status in ('draft', 'active', 'settling', 'finalized')),
  is_legacy boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,               -- exclusive
  settlement_deadline timestamptz,   -- verification grace ends; finalisation expected by then
  rules jsonb not null default public.default_season_rules(),
  rules_hash text,
  rule_version_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  activated_at timestamptz,
  activated_by uuid,
  settling_at timestamptz,
  finalized_at timestamptz,
  finalized_by uuid,
  constraint seasons_window check (starts_at is null or ends_at is null or starts_at < ends_at),
  constraint seasons_deadline check (ends_at is null or settlement_deadline is null or settlement_deadline >= ends_at),
  constraint seasons_live_has_dates check (
    is_legacy or status = 'draft' or (starts_at is not null and ends_at is not null and settlement_deadline is not null and rules_hash is not null)
  )
);
create unique index if not exists seasons_one_active on public.seasons ((true)) where status = 'active';
create unique index if not exists seasons_one_legacy on public.seasons ((true)) where is_legacy;

create table if not exists public.season_rule_versions (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id),
  version int not null,
  rules jsonb not null,
  rules_hash text not null,
  frozen_at timestamptz not null default now(),
  frozen_by uuid,
  unique (season_id, version)
);
alter table public.seasons drop constraint if exists seasons_rule_version_fk;
alter table public.seasons add constraint seasons_rule_version_fk foreign key (rule_version_id) references public.season_rule_versions (id);

-- Frozen fields stay frozen; status only moves forward one step at a time.
create or replace function public.seasons_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' or old.is_legacy then raise exception 'Only draft seasons can be deleted'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' and not new.is_legacy then raise exception 'New seasons start as drafts'; end if;
    return new;
  end if;
  if old.is_legacy then raise exception 'The legacy season is archived'; end if;
  if new.is_legacy <> old.is_legacy or new.id <> old.id or (new.slug <> old.slug and old.status <> 'draft') then
    raise exception 'Season identity is frozen';
  end if;
  if old.status <> 'draft' and (
       new.rules is distinct from old.rules or new.rules_hash is distinct from old.rules_hash
    or new.rule_version_id is distinct from old.rule_version_id
    or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
    or new.settlement_deadline is distinct from old.settlement_deadline) then
    raise exception 'Season rules and dates are frozen once the season is activated';
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft' and new.status = 'active')
    or (old.status = 'active' and new.status = 'settling')
    or (old.status = 'settling' and new.status = 'finalized')) then
    raise exception 'Invalid season transition % → %', old.status, new.status;
  end if;
  return new;
end
$$;
drop trigger if exists seasons_guard on public.seasons;
create trigger seasons_guard before insert or update or delete on public.seasons
for each row execute function public.seasons_guard();

create or replace function public.rule_versions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is immutable; publish a superseding version instead', tg_table_name;
end
$$;
drop trigger if exists season_rule_versions_immutable on public.season_rule_versions;
create trigger season_rule_versions_immutable before update or delete on public.season_rule_versions
for each row execute function public.rule_versions_immutable();

-- ---------------------------------------------------------------------------
-- Ledger: extend, archive history in the legacy season, then lock it down.
-- ---------------------------------------------------------------------------
alter table public.points_ledger alter column amount type bigint;
alter table public.points_ledger
  add column if not exists season_id uuid references public.seasons (id),
  add column if not exists source_type text,
  add column if not exists source_id text,
  add column if not exists reward_subtype text,
  add column if not exists rule_version_id uuid references public.season_rule_versions (id),
  add column if not exists effective_at timestamptz,
  add column if not exists reverses_id bigint references public.points_ledger (id),
  add column if not exists reversal_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

insert into public.seasons (slug, name, status, is_legacy, rules, rules_hash, notes, finalized_at)
select 'legacy', 'Pre-season points (archived)', 'finalized', true,
       '{"archived": true, "note": "Points earned before seasons existed, kept exactly as recorded."}'::jsonb,
       public.rules_hash('{"archived": true, "note": "Points earned before seasons existed, kept exactly as recorded."}'::jsonb),
       'Archive of every points_ledger amount recorded before the seasonal leaderboard. Not rescaled or reset.',
       now()
where not exists (select 1 from public.seasons where is_legacy);

update public.points_ledger l
   set season_id = (select id from public.seasons where is_legacy),
       source_type = 'legacy',
       source_id = l.id::text,
       reward_subtype = 'legacy',
       effective_at = l.created_at,
       metadata = jsonb_build_object('legacy_reason', l.reason, 'legacy_ref', l.ref)
 where l.season_id is null;

alter table public.points_ledger
  alter column season_id set not null,
  alter column source_type set not null,
  alter column source_id set not null,
  alter column reward_subtype set not null,
  alter column effective_at set not null,
  alter column effective_at set default now();
alter table public.points_ledger drop constraint if exists points_ledger_subtype_check;
alter table public.points_ledger add constraint points_ledger_subtype_check
  check (reward_subtype in ('legacy', 'nft_snapshot', 'participation', 'prize_bonus', 'social_share', 'adjustment'));
alter table public.points_ledger drop constraint if exists points_ledger_reversal_check;
alter table public.points_ledger add constraint points_ledger_reversal_check
  check (reverses_id is null or (reversal_reason is not null and length(btrim(reversal_reason)) >= 5));
create unique index if not exists points_ledger_original_award_key
  on public.points_ledger (season_id, source_type, source_id, reward_subtype) where reverses_id is null;
create index if not exists points_ledger_season_user_idx on public.points_ledger (season_id, user_id, id);
create index if not exists points_ledger_reverses_idx on public.points_ledger (reverses_id) where reverses_id is not null;

create or replace function public.points_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'points_ledger is append-only; use reverse_points() for corrections';
end
$$;
drop trigger if exists points_ledger_no_update on public.points_ledger;
create trigger points_ledger_no_update before update or delete on public.points_ledger
for each row execute function public.points_ledger_append_only();
drop trigger if exists points_ledger_no_truncate on public.points_ledger;
create trigger points_ledger_no_truncate before truncate on public.points_ledger
for each statement execute function public.points_ledger_append_only();

-- Only the ledger functions below write the ledger.
revoke insert, update, delete, truncate on public.points_ledger from service_role, authenticated, anon;
revoke all on sequence public.points_ledger_id_seq from service_role, authenticated, anon;
grant select on public.points_ledger to service_role;

-- ---------------------------------------------------------------------------
-- Aggregates
-- ---------------------------------------------------------------------------
create table if not exists public.season_scores (
  season_id uuid not null references public.seasons (id),
  user_id uuid not null,
  nft_points bigint not null default 0,
  participation_points bigint not null default 0,
  prize_points bigint not null default 0,
  social_points bigint not null default 0,
  adjustment_points bigint not null default 0,
  legacy_points bigint not null default 0,
  total bigint not null default 0,
  total_reached_at timestamptz,
  last_ledger_id bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (season_id, user_id),
  constraint season_scores_total check (total = nft_points + participation_points + prize_points + social_points + adjustment_points + legacy_points)
);
create index if not exists season_scores_rank_idx on public.season_scores (season_id, total desc, total_reached_at asc, user_id asc);
revoke all on public.season_scores from anon;
revoke insert, update, delete, truncate on public.season_scores from authenticated, service_role;
grant select on public.season_scores to authenticated, service_role;
alter table public.season_scores enable row level security;
drop policy if exists "season scores own read" on public.season_scores;
create policy "season scores own read" on public.season_scores for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

insert into public.season_scores (season_id, user_id, legacy_points, total, total_reached_at, last_ledger_id)
select l.season_id, l.user_id, sum(l.amount), sum(l.amount),
       max(l.effective_at) filter (where l.amount <> 0), max(l.id)
  from public.points_ledger l
  join public.seasons s on s.id = l.season_id and s.is_legacy
 group by l.season_id, l.user_id
on conflict (season_id, user_id) do nothing;

-- Time the player's current total was reached: the latest effective time among
-- awards that still contribute (an award fully reversed no longer counts).
create or replace function public._recompute_tie_time(_season_id uuid, _user_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(o.effective_at)
    from public.points_ledger o
   where o.season_id = _season_id and o.user_id = _user_id and o.reverses_id is null
     and o.amount + coalesce((select sum(r.amount) from public.points_ledger r where r.reverses_id = o.id), 0) <> 0
$$;

-- Internal: record an award and update the aggregate in the same transaction.
-- Returns the ledger id, or null when this award was already recorded (no double count).
create or replace function public._award_points(
  _season_id uuid, _user_id uuid, _source_type text, _source_id text, _subtype text, _amount bigint,
  _rule_version_id uuid, _effective_at timestamptz, _metadata jsonb, _actor uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seasons;
  v_id bigint;
  v_at timestamptz := coalesce(_effective_at, now());
begin
  if _user_id is null or _source_type is null or _source_id is null then raise exception 'Award needs a player and a source'; end if;
  if _amount is null then raise exception 'Award amount required'; end if;
  select * into s from public.seasons where id = _season_id for share;
  if not found then raise exception 'Unknown season'; end if;
  if s.is_legacy then raise exception 'The legacy season is archived'; end if;
  if s.status not in ('active', 'settling') then raise exception 'Season % is not accepting points (status %)', s.slug, s.status; end if;
  if _subtype not in ('nft_snapshot', 'participation', 'prize_bonus', 'social_share', 'adjustment') then
    raise exception 'Unknown reward subtype %', _subtype;
  end if;
  insert into public.points_ledger (user_id, amount, reason, ref, season_id, source_type, source_id, reward_subtype,
                                    rule_version_id, effective_at, metadata, created_by)
  values (_user_id, _amount, _subtype, null, _season_id, _source_type, _source_id, _subtype,
          coalesce(_rule_version_id, s.rule_version_id), v_at, coalesce(_metadata, '{}'::jsonb), _actor)
  on conflict (season_id, source_type, source_id, reward_subtype) where reverses_id is null do nothing
  returning id into v_id;
  if v_id is null then return null; end if;

  insert into public.season_scores as sc (season_id, user_id, nft_points, participation_points, prize_points,
                                          social_points, adjustment_points, total, total_reached_at, last_ledger_id)
  values (_season_id, _user_id,
          case when _subtype = 'nft_snapshot' then _amount else 0 end,
          case when _subtype = 'participation' then _amount else 0 end,
          case when _subtype = 'prize_bonus' then _amount else 0 end,
          case when _subtype = 'social_share' then _amount else 0 end,
          case when _subtype = 'adjustment' then _amount else 0 end,
          _amount,
          case when _amount <> 0 then v_at end,
          v_id)
  on conflict (season_id, user_id) do update set
    nft_points = sc.nft_points + excluded.nft_points,
    participation_points = sc.participation_points + excluded.participation_points,
    prize_points = sc.prize_points + excluded.prize_points,
    social_points = sc.social_points + excluded.social_points,
    adjustment_points = sc.adjustment_points + excluded.adjustment_points,
    total = sc.total + excluded.total,
    total_reached_at = case when _amount <> 0 then greatest(coalesce(sc.total_reached_at, v_at), v_at) else sc.total_reached_at end,
    last_ledger_id = greatest(sc.last_ledger_id, excluded.last_ledger_id),
    updated_at = now();
  return v_id;
end
$$;
revoke all on function public._award_points(uuid, uuid, text, text, text, bigint, uuid, timestamptz, jsonb, uuid) from public, anon, authenticated, service_role;

-- Audited reversal of (part of) an original award. Never reverses more than remains.
create or replace function public.reverse_points(_ledger_id bigint, _amount bigint, _reason text, _actor uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.points_ledger;
  s public.seasons;
  v_reversed bigint;
  v_remaining bigint;
  v_amount bigint;
  v_signed bigint;
  v_id bigint;
begin
  if _actor is null then raise exception 'Reversals need an accountable actor'; end if;
  if _reason is null or length(btrim(_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)'; end if;
  select * into o from public.points_ledger where id = _ledger_id for update;
  if not found then raise exception 'Unknown ledger entry'; end if;
  if o.reverses_id is not null then raise exception 'A reversal cannot itself be reversed; reverse the original award'; end if;
  select * into s from public.seasons where id = o.season_id for share;
  if s.is_legacy then raise exception 'Legacy points are archived and cannot be changed'; end if;
  select coalesce(sum(abs(r.amount)), 0) into v_reversed from public.points_ledger r where r.reverses_id = o.id;
  v_remaining := abs(o.amount) - v_reversed;
  v_amount := coalesce(_amount, v_remaining);
  if v_amount <= 0 or v_amount > v_remaining then
    raise exception 'Cannot reverse % points; % remain on this award', v_amount, v_remaining;
  end if;
  v_signed := -sign(o.amount)::bigint * v_amount;

  insert into public.points_ledger (user_id, amount, reason, ref, season_id, source_type, source_id, reward_subtype,
                                    rule_version_id, effective_at, reverses_id, reversal_reason, metadata, created_by)
  values (o.user_id, v_signed, 'reversal', null, o.season_id, o.source_type, o.source_id, o.reward_subtype,
          o.rule_version_id, now(), o.id, btrim(_reason),
          jsonb_build_object('reversed_amount', v_amount, 'remaining_after', v_remaining - v_amount), _actor)
  returning id into v_id;

  update public.season_scores sc set
    nft_points = sc.nft_points + case when o.reward_subtype = 'nft_snapshot' then v_signed else 0 end,
    participation_points = sc.participation_points + case when o.reward_subtype = 'participation' then v_signed else 0 end,
    prize_points = sc.prize_points + case when o.reward_subtype = 'prize_bonus' then v_signed else 0 end,
    social_points = sc.social_points + case when o.reward_subtype = 'social_share' then v_signed else 0 end,
    adjustment_points = sc.adjustment_points + case when o.reward_subtype = 'adjustment' then v_signed else 0 end,
    total = sc.total + v_signed,
    last_ledger_id = greatest(sc.last_ledger_id, v_id),
    updated_at = now()
  where sc.season_id = o.season_id and sc.user_id = o.user_id;
  update public.season_scores sc
     set total_reached_at = public._recompute_tie_time(o.season_id, o.user_id)
   where sc.season_id = o.season_id and sc.user_id = o.user_id;

  insert into public.audit_log (actor, action, details)
  values (_actor, 'points.reversed', jsonb_build_object('ledger_id', o.id, 'reversal_id', v_id, 'amount', v_amount,
          'season', s.slug, 'reason', btrim(_reason), 'season_status', s.status));
  return v_id;
end
$$;
revoke all on function public.reverse_points(bigint, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.reverse_points(bigint, bigint, text, uuid) to service_role;

-- Audited manual adjustment (positive or negative) inside an open season.
create or replace function public.adjust_points(_season_id uuid, _user_id uuid, _amount bigint, _reason text, _actor uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  if _actor is null then raise exception 'Adjustments need an accountable actor'; end if;
  if _reason is null or length(btrim(_reason)) < 5 then raise exception 'Give a reason (at least 5 characters)'; end if;
  if _amount is null or _amount = 0 then raise exception 'Adjustment must be non-zero'; end if;
  v_id := public._award_points(_season_id, _user_id, 'adjustment', gen_random_uuid()::text, 'adjustment', _amount, null, now(),
                               jsonb_build_object('reason', btrim(_reason)), _actor);
  insert into public.audit_log (actor, action, details)
  values (_actor, 'points.adjusted', jsonb_build_object('ledger_id', v_id, 'season_id', _season_id, 'user_id', _user_id,
          'amount', _amount, 'reason', btrim(_reason)));
  return v_id;
end
$$;
revoke all on function public.adjust_points(uuid, uuid, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.adjust_points(uuid, uuid, bigint, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Finalized standings (immutable; corrections are new superseding versions)
-- ---------------------------------------------------------------------------
create table if not exists public.final_standings_versions (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id),
  version int not null,
  rules_hash text not null,
  ledger_watermark bigint not null,
  export_hash text,
  entry_count int not null default 0,
  finalized_at timestamptz not null default now(),
  finalized_by uuid,
  supersedes_id uuid references public.final_standings_versions (id),
  reason text,
  unique (season_id, version),
  check (version = 1 or (supersedes_id is not null and reason is not null and length(btrim(reason)) >= 5))
);
create table if not exists public.final_standings (
  version_id uuid not null references public.final_standings_versions (id),
  rank int not null,
  user_id uuid not null,
  public_id uuid not null,
  nft_points bigint not null,
  participation_points bigint not null,
  prize_points bigint not null,
  social_points bigint not null,
  adjustment_points bigint not null,
  legacy_points bigint not null,
  total bigint not null,
  total_reached_at timestamptz,
  primary key (version_id, rank),
  unique (version_id, user_id)
);
-- Versions may only be sealed once (export hash + entry count, in the finalising transaction).
create or replace function public.final_standings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.export_hash is null and new.export_hash is not null
     and (new.id, new.season_id, new.version, new.rules_hash, new.ledger_watermark, new.finalized_at, new.supersedes_id, new.reason)
         is not distinct from (old.id, old.season_id, old.version, old.rules_hash, old.ledger_watermark, old.finalized_at, old.supersedes_id, old.reason) then
    return new;
  end if;
  raise exception '% is immutable; publish a superseding version instead', tg_table_name;
end
$$;

drop trigger if exists final_standings_versions_guard on public.final_standings_versions;
create trigger final_standings_versions_guard before update or delete on public.final_standings_versions
for each row execute function public.final_standings_guard();
drop trigger if exists final_standings_guard on public.final_standings;
create trigger final_standings_guard before update or delete on public.final_standings
for each row execute function public.rule_versions_immutable();

revoke all on public.final_standings_versions, public.final_standings from anon;
revoke insert, update, delete, truncate on public.final_standings_versions, public.final_standings from authenticated, service_role;
grant select on public.final_standings_versions, public.final_standings to service_role;
alter table public.final_standings_versions enable row level security;
alter table public.final_standings enable row level security;
drop policy if exists "final versions admin read" on public.final_standings_versions;
create policy "final versions admin read" on public.final_standings_versions for select to authenticated using (public.has_role(auth.uid(), 'admin'));
drop policy if exists "final standings own read" on public.final_standings;
create policy "final standings own read" on public.final_standings for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- Canonical export (CSV text without personal data) and its hash.
create or replace function public.standings_export_text(_version_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'rank,public_id,nft,participation,prize,social,adjustment,legacy,total,total_reached_at' || chr(10) ||
         coalesce(string_agg(
           concat_ws(',', f.rank, f.public_id, f.nft_points, f.participation_points, f.prize_points, f.social_points,
                     f.adjustment_points, f.legacy_points, f.total,
                     coalesce(to_char(f.total_reached_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '')),
           chr(10) order by f.rank), '')
    from public.final_standings f
   where f.version_id = _version_id
$$;
revoke all on function public.standings_export_text(uuid) from public, anon, authenticated;
grant execute on function public.standings_export_text(uuid) to service_role;

-- Internal: snapshot the live ranking into a new immutable version.
create or replace function public._write_final_standings(_season_id uuid, _actor uuid, _reason text)
returns public.final_standings_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seasons;
  prev public.final_standings_versions;
  v public.final_standings_versions;
  v_watermark bigint;
  v_count int;
begin
  select * into s from public.seasons where id = _season_id;
  select * into prev from public.final_standings_versions f where f.season_id = _season_id order by f.version desc limit 1;
  select coalesce(max(l.id), 0) into v_watermark from public.points_ledger l where l.season_id = _season_id;
  insert into public.final_standings_versions (season_id, version, rules_hash, ledger_watermark, finalized_by, supersedes_id, reason)
  values (_season_id, coalesce(prev.version, 0) + 1, coalesce(s.rules_hash, ''), v_watermark, _actor, prev.id,
          case when prev.id is null then nullif(btrim(coalesce(_reason, '')), '') else btrim(_reason) end)
  returning * into v;
  insert into public.final_standings (version_id, rank, user_id, public_id, nft_points, participation_points, prize_points,
                                      social_points, adjustment_points, legacy_points, total, total_reached_at)
  select v.id,
         row_number() over (order by sc.total desc, sc.total_reached_at asc nulls last, sc.user_id asc),
         sc.user_id, coalesce(p.public_id, gen_random_uuid()), sc.nft_points, sc.participation_points, sc.prize_points,
         sc.social_points, sc.adjustment_points, sc.legacy_points, sc.total, sc.total_reached_at
    from public.season_scores sc
    left join public.profiles p on p.id = sc.user_id
   where sc.season_id = _season_id and sc.total <> 0;
  get diagnostics v_count = row_count;
  update public.final_standings_versions f
     set export_hash = encode(sha256(convert_to(public.standings_export_text(v.id), 'UTF8')), 'hex'), entry_count = v_count
   where f.id = v.id
  returning * into v;
  return v;
end
$$;
revoke all on function public._write_final_standings(uuid, uuid, text) from public, anon, authenticated, service_role;

-- Every player with points gets a profile row (and so an opaque public id).
insert into public.profiles (id)
select distinct l.user_id from public.points_ledger l
 where not exists (select 1 from public.profiles p where p.id = l.user_id)
on conflict (id) do nothing;

-- Freeze the legacy archive as version 1.
do $$
declare v_legacy uuid;
begin
  select id into v_legacy from public.seasons where is_legacy;
  if not exists (select 1 from public.final_standings_versions where season_id = v_legacy) then
    perform public._write_final_standings(v_legacy, null, null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Read-only RPCs for the leaderboard (no emails, wallets, auth ids or ledgers).
-- ---------------------------------------------------------------------------
drop function if exists public.get_leaderboard(int);

create or replace function public.list_seasons()
returns table (
  id uuid, slug text, name text, status text, is_legacy boolean, starts_at timestamptz, ends_at timestamptz,
  settlement_deadline timestamptz, rules jsonb, rules_hash text, finalized_at timestamptz,
  standings_version int, standings_export_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.slug, s.name, s.status, s.is_legacy, s.starts_at, s.ends_at, s.settlement_deadline,
         s.rules, s.rules_hash, s.finalized_at, v.version, v.export_hash
    from public.seasons s
    left join lateral (
      select f.version, f.export_hash from public.final_standings_versions f
       where f.season_id = s.id order by f.version desc limit 1
    ) v on true
   where s.status <> 'draft'
   order by s.is_legacy asc, coalesce(s.starts_at, s.created_at) desc
$$;
revoke all on function public.list_seasons() from public;
grant execute on function public.list_seasons() to anon, authenticated, service_role;

create or replace function public.get_season_leaderboard(_season_id uuid, _limit int default 10, _offset int default 0)
returns table (
  rank bigint, public_id uuid, alias text, avatar_key text,
  total_points text, nft_points text, participation_points text, prize_points text, social_points text,
  adjustment_points text, legacy_points text, total_count bigint, standings_version int, is_final boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.seasons;
  v public.final_standings_versions;
  v_limit int := least(greatest(coalesce(_limit, 10), 1), 100);
  v_offset int := least(greatest(coalesce(_offset, 0), 0), 1000000);
begin
  select * into s from public.seasons x where x.id = _season_id and x.status <> 'draft';
  if not found then raise exception 'Unknown season'; end if;
  if s.status = 'finalized' then
    select * into v from public.final_standings_versions f where f.season_id = s.id order by f.version desc limit 1;
  end if;
  if v.id is not null then
    return query
      select f.rank::bigint, f.public_id, p.public_alias, p.avatar_key,
             f.total::text, f.nft_points::text, f.participation_points::text, f.prize_points::text, f.social_points::text,
             f.adjustment_points::text, f.legacy_points::text,
             (select count(*) from public.final_standings c where c.version_id = v.id), v.version, true
        from public.final_standings f
        left join public.profiles p on p.id = f.user_id
       where f.version_id = v.id
       order by f.rank
       limit v_limit offset v_offset;
  else
    return query
      with ranked as (
        select row_number() over (order by sc.total desc, sc.total_reached_at asc nulls last, sc.user_id asc) as rnk,
               sc.*, count(*) over () as cnt
          from public.season_scores sc
         where sc.season_id = s.id and sc.total <> 0
      )
      select r.rnk, p.public_id, p.public_alias, p.avatar_key,
             r.total::text, r.nft_points::text, r.participation_points::text, r.prize_points::text, r.social_points::text,
             r.adjustment_points::text, r.legacy_points::text, r.cnt, null::int, false
        from ranked r
        left join public.profiles p on p.id = r.user_id
       order by r.rnk
       limit v_limit offset v_offset;
  end if;
end
$$;
revoke all on function public.get_season_leaderboard(uuid, int, int) from public;
grant execute on function public.get_season_leaderboard(uuid, int, int) to anon, authenticated, service_role;

-- The signed-in player's own standing (rank among all players in the season).
create or replace function public.get_my_season_standing(_season_id uuid)
returns table (
  rank bigint, public_id uuid, alias text, avatar_key text, total_points text, nft_points text,
  participation_points text, prize_points text, social_points text, adjustment_points text, legacy_points text,
  total_reached_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  s public.seasons;
  v public.final_standings_versions;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  select * into s from public.seasons x where x.id = _season_id and x.status <> 'draft';
  if not found then raise exception 'Unknown season'; end if;
  if s.status = 'finalized' then
    select * into v from public.final_standings_versions f where f.season_id = s.id order by f.version desc limit 1;
  end if;
  if v.id is not null then
    return query
      select f.rank::bigint, f.public_id, p.public_alias, p.avatar_key, f.total::text, f.nft_points::text,
             f.participation_points::text, f.prize_points::text, f.social_points::text, f.adjustment_points::text,
             f.legacy_points::text, f.total_reached_at, (select count(*) from public.final_standings c where c.version_id = v.id)
        from public.final_standings f left join public.profiles p on p.id = f.user_id
       where f.version_id = v.id and f.user_id = v_uid;
  else
    return query
      with ranked as (
        select row_number() over (order by sc.total desc, sc.total_reached_at asc nulls last, sc.user_id asc) as rnk,
               sc.*, count(*) over () as cnt
          from public.season_scores sc
         where sc.season_id = s.id and sc.total <> 0
      )
      select r.rnk, p.public_id, p.public_alias, p.avatar_key, r.total::text, r.nft_points::text,
             r.participation_points::text, r.prize_points::text, r.social_points::text, r.adjustment_points::text,
             r.legacy_points::text, r.total_reached_at, r.cnt
        from ranked r left join public.profiles p on p.id = r.user_id
       where r.user_id = v_uid;
  end if;
end
$$;
revoke all on function public.get_my_season_standing(uuid) from public, anon;
grant execute on function public.get_my_season_standing(uuid) to authenticated;

-- Seasons are managed through server functions only.
revoke all on public.seasons, public.season_rule_versions from anon;
revoke insert, update, delete, truncate on public.seasons, public.season_rule_versions from authenticated, service_role;
grant select on public.seasons, public.season_rule_versions to service_role;
alter table public.seasons enable row level security;
alter table public.season_rule_versions enable row level security;
drop policy if exists "seasons admin read" on public.seasons;
create policy "seasons admin read" on public.seasons for select to authenticated using (public.has_role(auth.uid(), 'admin'));
drop policy if exists "rule versions admin read" on public.season_rule_versions;
create policy "rule versions admin read" on public.season_rule_versions for select to authenticated using (public.has_role(auth.uid(), 'admin'));

-- Utility functions that only compute values are safe for the API roles; keep the rest closed.
revoke all on function public.normalize_season_rules(jsonb) from public, anon, authenticated;
grant execute on function public.normalize_season_rules(jsonb) to service_role;
revoke all on function public._recompute_tie_time(uuid, uuid) from public, anon, authenticated, service_role;
