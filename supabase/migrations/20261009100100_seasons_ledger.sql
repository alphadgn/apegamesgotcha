-- ============================================================================
-- Seasons, append-only points ledger, per-season aggregates and finalized standings.
--
-- Points are nontransferable engagement scores. They have no guaranteed dollar, APE or $GAMES
-- value and nothing here pays anyone out.
--
-- Every existing ledger row is archived, unchanged, in a finalized "legacy" season.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'season_status' and typnamespace = 'public'::regnamespace) then
    create type public.season_status as enum ('draft', 'active', 'settling', 'finalized');
  end if;
end $$;

-- Draft defaults for a new season. Points are strings so they survive JSON as exact integers.
create or replace function public.default_season_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'schema', 1,
    'points', jsonb_build_object(
      'nft_snapshot_per_token', '100',
      'participation_per_spin', '10',
      'rarity_bonus', jsonb_build_object('common', '25', 'rare', '100', 'epic', '250', 'legendary', '500'),
      'prize_bonus_overrides', '{}'::jsonb,
      'x_share', '2'
    ),
    'limits', jsonb_build_object('spins_rolling_24h', 10, 'spins_per_season', 100, 'x_shares_per_utc_day', 1),
    'eligible_credit_sources', jsonb_build_array('purchase', 'burn', 'grant', 'free_entry'),
    'referrals_enabled', false,
    'historical_backfill_enabled', false
  )
$$;

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text not null check (char_length(name) between 1 and 80),
  status public.season_status not null default 'draft',
  is_legacy boolean not null default false,
  starts_at timestamptz,             -- UTC, inclusive
  ends_at timestamptz,               -- UTC, exclusive cutoff
  settlement_deadline timestamptz,   -- finalize by this time (missing it raises an alert, never cancels draws)
  grace_period interval not null default interval '72 hours', -- pending verifications may finish after the cutoff
  rules jsonb not null default public.default_season_rules(),
  rules_version int not null default 1,
  rules_hash text,
  snapshot_config jsonb not null default '{"collection_ids": []}'::jsonb,
  activated_at timestamptz,
  settling_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  constraint seasons_window check (starts_at is null or ends_at is null or starts_at < ends_at),
  constraint seasons_deadline check (settlement_deadline is null or ends_at is null or settlement_deadline >= ends_at),
  constraint seasons_grace check (grace_period >= interval '0' and grace_period <= interval '30 days')
);
create unique index if not exists seasons_one_active on public.seasons ((true)) where status = 'active';
create index if not exists seasons_window_idx on public.seasons (starts_at, ends_at);

alter table public.seasons enable row level security;
revoke all on public.seasons from public, anon, authenticated;
grant select on public.seasons to anon, authenticated;
grant all on public.seasons to service_role;
drop policy if exists "seasons published read" on public.seasons;
create policy "seasons published read" on public.seasons for select to anon, authenticated
  using (status <> 'draft' or public.is_admin());

-- Validates a rules document. Returns a list of problems (empty = valid).
create or replace function public.season_rules_errors(_rules jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  errs text[] := '{}';
  k text;
  v jsonb;
  intpat constant text := '^(0|[1-9][0-9]{0,17})$';
begin
  if _rules is null or jsonb_typeof(_rules) <> 'object' then return array['rules must be an object']; end if;
  if (_rules ->> 'schema') is distinct from '1' then errs := errs || 'schema must be 1'; end if;
  foreach k in array array['nft_snapshot_per_token', 'participation_per_spin', 'x_share'] loop
    if coalesce(_rules #>> array['points', k], '') !~ intpat then errs := errs || format('points.%s must be a non-negative integer string', k); end if;
  end loop;
  foreach k in array array['common', 'rare', 'epic', 'legendary'] loop
    if coalesce(_rules #>> array['points', 'rarity_bonus', k], '') !~ intpat then errs := errs || format('points.rarity_bonus.%s must be a non-negative integer string', k); end if;
  end loop;
  if jsonb_typeof(_rules #> '{points,prize_bonus_overrides}') is distinct from 'object' then
    errs := errs || 'points.prize_bonus_overrides must be an object of prize_id -> integer string';
  else
    for k, v in select * from jsonb_each(_rules #> '{points,prize_bonus_overrides}') loop
      if k !~ '^[0-9a-f-]{36}$' then errs := errs || format('prize_bonus_overrides key %s is not a prize id', k); end if;
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ intpat then errs := errs || format('prize_bonus_overrides.%s must be an integer string (0 allowed)', k); end if;
    end loop;
  end if;
  if coalesce(_rules #>> '{limits,spins_rolling_24h}', '') !~ '^[1-9][0-9]{0,3}$' then errs := errs || 'limits.spins_rolling_24h must be 1-9999'; end if;
  if coalesce(_rules #>> '{limits,spins_per_season}', '') !~ '^[1-9][0-9]{0,5}$' then errs := errs || 'limits.spins_per_season must be 1-999999'; end if;
  if coalesce(_rules #>> '{limits,x_shares_per_utc_day}', '') !~ '^[0-9]$' then errs := errs || 'limits.x_shares_per_utc_day must be 0-9'; end if;
  if jsonb_typeof(_rules -> 'eligible_credit_sources') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements_text(_rules -> 'eligible_credit_sources') s where s not in ('purchase', 'burn', 'grant', 'free_entry')) then
    errs := errs || 'eligible_credit_sources must list purchase/burn/grant/free_entry';
  end if;
  if (_rules -> 'referrals_enabled') is distinct from 'false'::jsonb then errs := errs || 'referrals are not supported (referrals_enabled must be false)'; end if;
  if jsonb_typeof(_rules -> 'historical_backfill_enabled') is distinct from 'boolean' then errs := errs || 'historical_backfill_enabled must be true or false'; end if;
  return errs;
end
$$;

-- Rules, window and snapshot are frozen once a season leaves draft. Status only moves forward.
create or replace function public.seasons_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'Only draft seasons can be deleted'; end if;
    return old;
  end if;
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then
      if new.rules is distinct from old.rules or new.rules_version <> old.rules_version
         or new.rules_hash is distinct from old.rules_hash or new.snapshot_config is distinct from old.snapshot_config
         or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
         or new.grace_period <> old.grace_period or new.is_legacy <> old.is_legacy or new.slug <> old.slug then
        raise exception 'Season % is %; its rules, window and snapshot are frozen', old.slug, old.status;
      end if;
      if new.settlement_deadline < old.settlement_deadline then
        raise exception 'The settlement deadline can only be extended';
      end if;
    elsif new.rules is distinct from old.rules then
      new.rules_version := old.rules_version + 1;
    end if;
    if new.status <> old.status then
      if not ((old.status = 'draft' and new.status = 'active')
           or (old.status = 'active' and new.status = 'settling')
           or (old.status = 'settling' and new.status = 'finalized')) then
        raise exception 'Season status cannot move from % to %', old.status, new.status;
      end if;
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists seasons_guard on public.seasons;
create trigger seasons_guard before insert or update or delete on public.seasons
  for each row execute function public.seasons_guard();

-- ---------------------------------------------------------------------------
-- Ledger: extend points_ledger (amount/reason/ref history is kept as-is)
-- ---------------------------------------------------------------------------
alter table public.points_ledger alter column amount type bigint;
alter table public.points_ledger
  add column if not exists season_id uuid references public.seasons(id),
  add column if not exists source_type text,
  add column if not exists source_id text,
  add column if not exists reward_subtype text,
  add column if not exists rule_version int,
  add column if not exists effective_at timestamptz,
  add column if not exists reverses_id bigint references public.points_ledger(id),
  add column if not exists reversal_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Legacy season: holds every pre-season ledger row exactly as it was.
insert into public.seasons (slug, name, status, is_legacy, starts_at, ends_at, settlement_deadline, grace_period, rules, rules_version, snapshot_config)
select 'legacy-preseason', 'Pre-season (legacy points)', 'draft', true,
       coalesce((select min(created_at) from public.points_ledger), now()) - interval '1 second',
       now(), now(), interval '0',
       jsonb_build_object('schema', 0, 'legacy', true, 'note', 'Archived pre-season points; amounts unchanged.'),
       0, '{"collection_ids": []}'::jsonb
where not exists (select 1 from public.seasons where slug = 'legacy-preseason');

update public.points_ledger l
   set season_id = s.id,
       source_type = 'legacy',
       source_id = 'ledger:' || l.id::text,
       reward_subtype = case l.reason
                          when 'holding' then 'legacy_holding'
                          when 'spin' then 'legacy_spin'
                          when 'admin_adjustment' then 'legacy_adjustment'
                          else 'legacy_other' end,
       rule_version = 0,
       effective_at = l.created_at,
       metadata = jsonb_build_object('legacy_reason', l.reason, 'legacy_ref', l.ref)
  from public.seasons s
 where s.slug = 'legacy-preseason' and l.season_id is null;

alter table public.points_ledger
  alter column season_id set not null,
  alter column source_type set not null,
  alter column source_id set not null,
  alter column reward_subtype set not null,
  alter column effective_at set not null,
  alter column effective_at set default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'points_ledger_subtype_check') then
    alter table public.points_ledger add constraint points_ledger_subtype_check check (reward_subtype in (
      'nft_snapshot', 'participation', 'prize_bonus', 'x_share', 'adjustment',
      'legacy_holding', 'legacy_spin', 'legacy_adjustment', 'legacy_other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'points_ledger_reversal_shape') then
    alter table public.points_ledger add constraint points_ledger_reversal_shape check (
      (reverses_id is null and reversal_reason is null)
      or (reverses_id is not null and char_length(btrim(reversal_reason)) between 3 and 500));
  end if;
end $$;

-- The old (reason, ref) key is superseded by the per-season source key below.
drop index if exists public.points_ledger_unique_ref;
create unique index if not exists points_ledger_original_award
  on public.points_ledger (season_id, source_type, source_id, reward_subtype) where reverses_id is null;
create index if not exists points_ledger_season_user on public.points_ledger (season_id, user_id);
create index if not exists points_ledger_reverses on public.points_ledger (reverses_id) where reverses_id is not null;

-- ---------------------------------------------------------------------------
-- Aggregates (one row per season and player)
-- ---------------------------------------------------------------------------
create table if not exists public.season_scores (
  season_id uuid not null references public.seasons(id),
  user_id uuid not null,
  nft_points bigint not null default 0,
  participation_points bigint not null default 0,
  prize_points bigint not null default 0,
  social_points bigint not null default 0,
  adjustment_points bigint not null default 0,
  total_points bigint not null default 0,
  total_reached_at timestamptz,
  last_ledger_id bigint,
  updated_at timestamptz not null default now(),
  primary key (season_id, user_id),
  constraint season_scores_total check (total_points = nft_points + participation_points + prize_points + social_points + adjustment_points)
);
create index if not exists season_scores_rank on public.season_scores (season_id, total_points desc, total_reached_at asc, user_id asc);
alter table public.season_scores enable row level security;
revoke all on public.season_scores from public, anon, authenticated;
grant select on public.season_scores to authenticated;
grant all on public.season_scores to service_role;
drop policy if exists "scores own read" on public.season_scores;
create policy "scores own read" on public.season_scores for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create or replace function public.ledger_category(_subtype text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case _subtype
    when 'nft_snapshot' then 'nft'
    when 'legacy_holding' then 'nft'
    when 'participation' then 'participation'
    when 'prize_bonus' then 'prize'
    when 'legacy_spin' then 'prize'
    when 'x_share' then 'social'
    else 'adjustment' end
$$;

-- When did the player's current total come about? The latest effective time among awards that
-- still contribute (original amount plus its reversals is non-zero). A full reversal therefore
-- "un-happens" an award, and the tie time falls back to the previous contributing award.
create or replace function public.score_reached_at(_season uuid, _user uuid)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select max(o.effective_at)
    from public.points_ledger o
   where o.season_id = _season and o.user_id = _user and o.reverses_id is null
     and o.amount + coalesce((select sum(r.amount) from public.points_ledger r where r.reverses_id = o.id), 0) <> 0
$$;

-- Ledger guard: append-only, sane reversals, no writes to closed seasons.
create or replace function public.points_ledger_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s public.seasons;
  o public.points_ledger;
  reversed bigint;
begin
  select * into s from public.seasons where id = new.season_id;
  if not found then raise exception 'Unknown season'; end if;
  if s.status = 'draft' then raise exception 'Season % is not active', s.slug; end if;
  if s.status = 'finalized' and coalesce(current_setting('gotcha.season_correction', true), '') <> s.id::text then
    raise exception 'Season % is finalized; use an audited correction', s.slug;
  end if;

  if new.reverses_id is null then
    if new.amount = 0 then raise exception 'Zero-point ledger entries are not recorded'; end if;
    if new.reward_subtype like 'legacy\_%' then raise exception 'Legacy subtypes are archive-only'; end if;
    new.reason := coalesce(new.reason, new.reward_subtype);
    return new;
  end if;

  -- Reversal: references an original award, never exceeds what remains.
  if new.created_by is null then raise exception 'Reversals must record who made them'; end if;
  select * into o from public.points_ledger where id = new.reverses_id for update;
  if not found then raise exception 'Reversal target not found'; end if;
  if o.reverses_id is not null then raise exception 'A reversal cannot itself be reversed'; end if;
  if o.season_id <> new.season_id or o.user_id <> new.user_id then raise exception 'Reversal must match the original season and player'; end if;
  select coalesce(sum(amount), 0) into reversed from public.points_ledger where reverses_id = o.id;
  if new.amount = 0 or sign(new.amount) = sign(o.amount) then raise exception 'A reversal must have the opposite sign of the original'; end if;
  if abs(reversed + new.amount) > abs(o.amount) then
    raise exception 'Reversal exceeds the remaining amount (% of % left)', o.amount + reversed, o.amount;
  end if;
  new.source_type := o.source_type;
  new.source_id := o.source_id;
  new.reward_subtype := o.reward_subtype;
  new.effective_at := o.effective_at;
  new.rule_version := o.rule_version;
  new.reason := 'reversal';
  new.ref := null;
  return new;
end
$$;

create or replace function public.points_ledger_after_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare cat text := public.ledger_category(new.reward_subtype);
begin
  insert into public.season_scores as sc (season_id, user_id, nft_points, participation_points, prize_points, social_points, adjustment_points, total_points, last_ledger_id, updated_at)
  values (new.season_id, new.user_id,
          case when cat = 'nft' then new.amount else 0 end,
          case when cat = 'participation' then new.amount else 0 end,
          case when cat = 'prize' then new.amount else 0 end,
          case when cat = 'social' then new.amount else 0 end,
          case when cat = 'adjustment' then new.amount else 0 end,
          new.amount, new.id, now())
  on conflict (season_id, user_id) do update set
    nft_points = sc.nft_points + excluded.nft_points,
    participation_points = sc.participation_points + excluded.participation_points,
    prize_points = sc.prize_points + excluded.prize_points,
    social_points = sc.social_points + excluded.social_points,
    adjustment_points = sc.adjustment_points + excluded.adjustment_points,
    total_points = sc.total_points + excluded.total_points,
    last_ledger_id = greatest(sc.last_ledger_id, excluded.last_ledger_id),
    updated_at = now();
  update public.season_scores
     set total_reached_at = public.score_reached_at(new.season_id, new.user_id)
   where season_id = new.season_id and user_id = new.user_id;
  return null;
end
$$;

create or replace function public.points_ledger_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'points_ledger is append-only (% blocked); record a reversal instead', tg_op;
end
$$;

drop trigger if exists points_ledger_before_insert on public.points_ledger;
drop trigger if exists points_ledger_after_insert on public.points_ledger;
drop trigger if exists points_ledger_no_update on public.points_ledger;
drop trigger if exists points_ledger_no_truncate on public.points_ledger;
create trigger points_ledger_before_insert before insert on public.points_ledger
  for each row execute function public.points_ledger_before_insert();
create trigger points_ledger_after_insert after insert on public.points_ledger
  for each row execute function public.points_ledger_after_insert();
create trigger points_ledger_no_update before update or delete on public.points_ledger
  for each row execute function public.points_ledger_immutable();
create trigger points_ledger_no_truncate before truncate on public.points_ledger
  for each statement execute function public.points_ledger_immutable();

-- Season scores may only be written by the ledger trigger (and the legacy archive below).
create or replace function public.season_scores_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() < 2 and coalesce(current_setting('gotcha.scores_rebuild', true), '') <> 'on' then
    raise exception 'season_scores is maintained by the ledger; insert a ledger entry instead';
  end if;
  return coalesce(new, old);
end
$$;
drop trigger if exists season_scores_guard on public.season_scores;
create trigger season_scores_guard before insert or update or delete on public.season_scores
  for each row execute function public.season_scores_guard();

-- ---------------------------------------------------------------------------
-- Award / adjust / reverse (server only)
-- ---------------------------------------------------------------------------
-- Inserts an original award once. Returns the ledger id, or null if it already existed or is zero.
create or replace function public.ledger_award(
  _season uuid, _user uuid, _source_type text, _source_id text, _subtype text, _amount bigint,
  _rule_version int, _effective_at timestamptz, _metadata jsonb default '{}'::jsonb, _actor uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  if _amount is null or _amount = 0 then return null; end if;
  insert into public.points_ledger (user_id, amount, reason, ref, created_by, season_id, source_type, source_id, reward_subtype, rule_version, effective_at, metadata)
  values (_user, _amount, _subtype, _source_id, _actor, _season, _source_type, _source_id, _subtype, _rule_version, coalesce(_effective_at, now()), coalesce(_metadata, '{}'::jsonb))
  on conflict (season_id, source_type, source_id, reward_subtype) where reverses_id is null do nothing
  returning id into v_id;
  return v_id;
end
$$;

-- Audited manual adjustment (positive or negative) in an active or settling season.
create or replace function public.admin_adjust_points(_season uuid, _user uuid, _amount bigint, _reason text, _actor uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint; v_source text := gen_random_uuid()::text;
begin
  if _actor is null or not public.has_role(_actor, 'admin') then raise exception 'Forbidden'; end if;
  if _reason is null or char_length(btrim(_reason)) < 3 then raise exception 'A reason is required'; end if;
  if _amount is null or _amount = 0 then raise exception 'Amount must be non-zero'; end if;
  v_id := public.ledger_award(_season, _user, 'adjustment', v_source, 'adjustment', _amount, null, now(),
                              jsonb_build_object('reason', btrim(_reason)), _actor);
  insert into public.audit_log (actor, action, details)
  values (_actor, 'points.adjusted', jsonb_build_object('ledger_id', v_id, 'season_id', _season, 'user_id', _user, 'amount', _amount::text, 'reason', btrim(_reason)));
  return v_id;
end
$$;

-- Audited reversal of (part of) an original award. `_amount` is how much to take back (null = everything left).
create or replace function public.reverse_ledger_entry(_ledger_id bigint, _amount bigint, _reason text, _actor uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare o public.points_ledger; remaining bigint; take bigint; v_id bigint;
begin
  if _actor is null or not public.has_role(_actor, 'admin') then raise exception 'Forbidden'; end if;
  if _reason is null or char_length(btrim(_reason)) < 3 then raise exception 'A reason is required'; end if;
  select * into o from public.points_ledger where id = _ledger_id for update;
  if not found then raise exception 'Ledger entry not found'; end if;
  if o.reverses_id is not null then raise exception 'Pick the original award, not a reversal'; end if;
  select o.amount + coalesce(sum(amount), 0) into remaining from public.points_ledger where reverses_id = o.id;
  if remaining = 0 then raise exception 'Nothing left to reverse'; end if;
  take := coalesce(_amount, abs(remaining));
  if take <= 0 or take > abs(remaining) then raise exception 'Can reverse at most % points', abs(remaining); end if;
  insert into public.points_ledger (user_id, amount, reason, created_by, season_id, source_type, source_id, reward_subtype, reverses_id, reversal_reason, metadata)
  values (o.user_id, -sign(o.amount)::bigint * take, 'reversal', _actor, o.season_id, o.source_type, o.source_id, o.reward_subtype, o.id, btrim(_reason), '{}'::jsonb)
  returning id into v_id;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'points.reversed', jsonb_build_object('ledger_id', v_id, 'reverses_id', o.id, 'amount', (-sign(o.amount)::bigint * take)::text, 'reason', btrim(_reason)));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Ranking. Total desc, then the time the total was reached asc, then user id asc.
-- Consecutive ordinal ranks (1, 2, 3, ... — no shared places).
-- ---------------------------------------------------------------------------
create or replace function public.season_ranking(_season uuid)
returns table (rank bigint, user_id uuid, total_points bigint, nft_points bigint, participation_points bigint,
               prize_points bigint, social_points bigint, adjustment_points bigint, total_reached_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select row_number() over (order by s.total_points desc, s.total_reached_at asc nulls last, s.user_id asc),
         s.user_id, s.total_points, s.nft_points, s.participation_points, s.prize_points, s.social_points,
         s.adjustment_points, s.total_reached_at
    from public.season_scores s
   where s.season_id = _season
$$;
revoke all on function public.season_ranking(uuid) from public, anon, authenticated;
grant execute on function public.season_ranking(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Finalized standings (immutable; corrections add a superseding version)
-- ---------------------------------------------------------------------------
create table if not exists public.season_standings_versions (
  season_id uuid not null references public.seasons(id),
  version int not null check (version >= 1),
  rules_hash text,
  ledger_watermark bigint not null,
  export_hash text not null,
  row_count int not null,
  finalized_at timestamptz not null default now(),
  finalized_by uuid,
  supersedes_version int,
  correction_reason text,
  primary key (season_id, version),
  constraint standings_correction_reason check (supersedes_version is null or char_length(btrim(correction_reason)) >= 3)
);
create table if not exists public.season_standings (
  season_id uuid not null,
  version int not null,
  rank bigint not null,
  user_id uuid not null,
  public_id text not null,
  total_points bigint not null,
  nft_points bigint not null,
  participation_points bigint not null,
  prize_points bigint not null,
  social_points bigint not null,
  adjustment_points bigint not null,
  total_reached_at timestamptz,
  primary key (season_id, version, user_id),
  unique (season_id, version, rank),
  foreign key (season_id, version) references public.season_standings_versions (season_id, version)
);

create or replace function public.standings_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is immutable; publish a superseding version instead', tg_table_name;
end
$$;
drop trigger if exists standings_versions_immutable on public.season_standings_versions;
drop trigger if exists standings_immutable on public.season_standings;
create trigger standings_versions_immutable before update or delete on public.season_standings_versions
  for each row execute function public.standings_immutable();
create trigger standings_immutable before update or delete on public.season_standings
  for each row execute function public.standings_immutable();

alter table public.season_standings_versions enable row level security;
alter table public.season_standings enable row level security;
revoke all on public.season_standings_versions, public.season_standings from public, anon, authenticated;
grant select on public.season_standings_versions to anon, authenticated;
grant select on public.season_standings to authenticated;
grant all on public.season_standings_versions, public.season_standings to service_role;
drop policy if exists "standings versions public" on public.season_standings_versions;
create policy "standings versions public" on public.season_standings_versions for select to anon, authenticated using (true);
drop policy if exists "standings own read" on public.season_standings;
create policy "standings own read" on public.season_standings for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Writes the next standings version from the live aggregates. Caller holds the season lock.
create or replace function public.write_season_standings(_season uuid, _actor uuid, _supersedes int, _reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version int;
  v_watermark bigint;
  v_hash text;
  v_rows int;
  v_rules_hash text;
begin
  select coalesce(max(version), 0) + 1 into v_version from public.season_standings_versions where season_id = _season;
  select coalesce(max(id), 0) into v_watermark from public.points_ledger where season_id = _season;
  select rules_hash into v_rules_hash from public.seasons where id = _season;

  select encode(extensions.digest(coalesce(string_agg(line, E'\n' order by r.rank), ''), 'sha256'), 'hex'), count(*)
    into v_hash, v_rows
    from (
      select r.rank,
             concat_ws(',', r.rank, p.public_id, r.total_points, r.nft_points, r.participation_points, r.prize_points,
                       r.social_points, r.adjustment_points, coalesce(to_char(r.total_reached_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '')) as line
        from public.season_ranking(_season) r
        join public.profiles p on p.id = r.user_id
    ) r;

  insert into public.season_standings_versions (season_id, version, rules_hash, ledger_watermark, export_hash, row_count, finalized_by, supersedes_version, correction_reason)
  values (_season, v_version, v_rules_hash, v_watermark, v_hash, v_rows, _actor, _supersedes, _reason);

  insert into public.season_standings (season_id, version, rank, user_id, public_id, total_points, nft_points, participation_points, prize_points, social_points, adjustment_points, total_reached_at)
  select _season, v_version, r.rank, r.user_id, p.public_id, r.total_points, r.nft_points, r.participation_points, r.prize_points,
         r.social_points, r.adjustment_points, r.total_reached_at
    from public.season_ranking(_season) r
    join public.profiles p on p.id = r.user_id;
  return v_version;
end
$$;
revoke all on function public.write_season_standings(uuid, uuid, int, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Archive legacy points: aggregates and standings v1 from the untouched ledger rows.
-- ---------------------------------------------------------------------------
do $$
declare v_season uuid;
begin
  select id into v_season from public.seasons where slug = 'legacy-preseason';
  if exists (select 1 from public.season_standings_versions where season_id = v_season) then return; end if;

  perform set_config('gotcha.scores_rebuild', 'on', true);
  insert into public.season_scores (season_id, user_id, nft_points, participation_points, prize_points, social_points, adjustment_points, total_points, total_reached_at, last_ledger_id)
  select v_season, l.user_id,
         coalesce(sum(l.amount) filter (where public.ledger_category(l.reward_subtype) = 'nft'), 0),
         0,
         coalesce(sum(l.amount) filter (where public.ledger_category(l.reward_subtype) = 'prize'), 0),
         0,
         coalesce(sum(l.amount) filter (where public.ledger_category(l.reward_subtype) = 'adjustment'), 0),
         sum(l.amount),
         max(l.effective_at),
         max(l.id)
    from public.points_ledger l
   where l.season_id = v_season
   group by l.user_id;
  perform set_config('gotcha.scores_rebuild', '', true);

  -- Profiles may be missing for very old rows; standings need a public id.
  insert into public.profiles (id) select distinct user_id from public.season_scores s
   where s.season_id = v_season and not exists (select 1 from public.profiles p where p.id = s.user_id);

  update public.seasons set status = 'active', activated_at = now(),
         rules_hash = encode(extensions.digest(rules::text, 'sha256'), 'hex')
   where id = v_season;
  -- (rules_hash above is set while still draft-shaped; the guard freezes it from here on)
  update public.seasons set status = 'settling', settling_at = now() where id = v_season;
  perform public.write_season_standings(v_season, null, null, null);
  update public.seasons set status = 'finalized', finalized_at = now() where id = v_season;
end $$;

grant execute on function public.ledger_award(uuid, uuid, text, text, text, bigint, int, timestamptz, jsonb, uuid) to service_role;
revoke all on function public.ledger_award(uuid, uuid, text, text, text, bigint, int, timestamptz, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.admin_adjust_points(uuid, uuid, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_adjust_points(uuid, uuid, bigint, text, uuid) to service_role;
revoke all on function public.reverse_ledger_entry(bigint, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.reverse_ledger_entry(bigint, bigint, text, uuid) to service_role;
revoke all on function public.score_reached_at(uuid, uuid) from public, anon, authenticated;
revoke all on function public.season_rules_errors(jsonb) from public, anon;
revoke all on function public.ledger_category(text) from public, anon;
revoke all on function public.default_season_rules() from public, anon;
revoke all on function public.seasons_guard(), public.points_ledger_before_insert(), public.points_ledger_after_insert(),
              public.points_ledger_immutable(), public.season_scores_guard(), public.standings_immutable()
  from public, anon, authenticated;
