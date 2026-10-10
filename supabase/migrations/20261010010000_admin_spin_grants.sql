-- Admin spin grants: two kinds, tracked per grant, usable the moment they are granted.
--
--   real  "paid-equivalent" — a real on-chain (Chainlink VRF) spin, exactly like a purchased spin.
--   demo  practice spin on the demo machine — simulated, no prizes, no points.
--
-- Granted spins are exempt from the per-player daily / campaign spin limits (the administrator
-- chose to give them), and granted demo spins skip the 30-minute free-demo cooldown.

-- ---------------------------------------------------------------------------
-- Grant batches (one row per admin action) for the admin panel
-- ---------------------------------------------------------------------------
create table if not exists public.spin_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('real', 'demo')),
  count int not null check (count between 1 and 100),
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists spin_grants_created_idx on public.spin_grants (created_at desc);
create index if not exists spin_grants_user_idx on public.spin_grants (user_id);
alter table public.spin_grants enable row level security;
revoke all on public.spin_grants from public, anon, authenticated;
grant select on public.spin_grants to authenticated;
grant all on public.spin_grants to service_role;
drop policy if exists "spin grants admin read" on public.spin_grants;
create policy "spin grants admin read" on public.spin_grants
  for select to authenticated using (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- Credits: kind, link to the grant, and when a demo credit was used
-- ---------------------------------------------------------------------------
alter table public.spin_credits
  add column if not exists kind text not null default 'real',
  add column if not exists grant_id uuid references public.spin_grants (id),
  add column if not exists used_at timestamptz;
alter table public.spin_credits drop constraint if exists spin_credits_kind_check;
alter table public.spin_credits add constraint spin_credits_kind_check check (kind in ('real', 'demo'));
alter table public.spin_credits drop constraint if exists spin_credits_demo_is_grant;
alter table public.spin_credits add constraint spin_credits_demo_is_grant check (kind = 'real' or source = 'grant');
create index if not exists spin_credits_grant_idx on public.spin_credits (grant_id);
create index if not exists spin_credits_unused_idx on public.spin_credits (user_id, kind) where used_spin_id is null and used_at is null;

-- Carry over grants made before this migration ran (the app keeps grants working on the older schema):
--   * paid-equivalent grants made by the app: credits with ref '<grant id>:<n>' + an 'admin.grant_spins' audit row (note)
--   * demo grants made by the app: 'admin.grant_demo_spins' audit rows, use recorded as 'demo.spins_used'
--   * grants from before any tracking: credits with no ref, grouped by player/admin/second
do $$
declare r record; v_grant uuid;
begin
  -- Paid-equivalent grants recorded by the app.
  for r in
    select split_part(c.ref, ':', 1)::uuid as gid, c.user_id, min(c.created_by::text)::uuid as created_by,
           min(c.created_at) as at, count(*)::int as n
      from public.spin_credits c
     where c.source = 'grant' and c.grant_id is null
       and c.ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$'
     group by 1, 2
  loop
    insert into public.spin_grants (id, user_id, kind, count, note, created_by, created_at)
    values (r.gid, r.user_id, 'real', least(r.n, 100),
            coalesce((select a.details ->> 'note' from public.audit_log a
                       where a.action = 'admin.grant_spins' and a.details ->> 'grant_id' = r.gid::text limit 1), ''),
            r.created_by, r.at)
    on conflict (id) do nothing;
    update public.spin_credits c set grant_id = r.gid
     where c.source = 'grant' and c.grant_id is null and split_part(c.ref, ':', 1) = r.gid::text;
  end loop;

  -- Grants from before any tracking.
  for r in
    select user_id, created_by, date_trunc('second', created_at) as at, count(*)::int as n
    from public.spin_credits
    where source = 'grant' and grant_id is null
    group by user_id, created_by, date_trunc('second', created_at)
  loop
    insert into public.spin_grants (user_id, kind, count, note, created_by, created_at)
      values (r.user_id, 'real', least(r.n, 100), 'Granted before grant tracking', r.created_by, r.at)
      returning id into v_grant;
    update public.spin_credits set grant_id = v_grant
      where source = 'grant' and grant_id is null and user_id = r.user_id
        and created_by is not distinct from r.created_by and date_trunc('second', created_at) = r.at;
  end loop;

  -- Demo grants recorded by the app, then the demo spins already used (oldest grants first).
  for r in
    select (a.details ->> 'grant_id')::uuid as gid, (a.details ->> 'user_id')::uuid as user_id, a.actor,
           a.created_at, least(greatest((a.details ->> 'count')::int, 1), 100) as n, coalesce(a.details ->> 'note', '') as note
      from public.audit_log a
     where a.action = 'admin.grant_demo_spins'
       and not exists (select 1 from public.spin_grants g where g.id = (a.details ->> 'grant_id')::uuid)
  loop
    insert into public.spin_grants (id, user_id, kind, count, note, created_by, created_at)
    values (r.gid, r.user_id, 'demo', r.n, r.note, r.actor, r.created_at);
    insert into public.spin_credits (user_id, source, ref, kind, grant_id, created_by, created_at)
    select r.user_id, 'grant', r.gid::text || ':' || i, 'demo', r.gid, r.actor, r.created_at from generate_series(1, r.n) i;
  end loop;
  for r in
    select (a.details ->> 'user_id')::uuid as user_id, sum((a.details ->> 'count')::int)::int as used, max(a.created_at) as at
      from public.audit_log a where a.action = 'demo.spins_used' group by 1
  loop
    update public.spin_credits c set used_at = r.at
     where c.id in (select x.id from public.spin_credits x
                     where x.user_id = r.user_id and x.kind = 'demo' and x.used_at is null
                     order by x.created_at, x.ref limit r.used);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grant spins (server, as the service role, after an admin check)
-- ---------------------------------------------------------------------------
create or replace function public.admin_grant_spins(_user_id uuid, _count int, _kind text, _note text, _actor uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_grant uuid;
begin
  if _kind not in ('real', 'demo') then raise exception 'Unknown spin type %', _kind; end if;
  if _count < 1 or _count > 100 then raise exception 'Grant between 1 and 100 spins'; end if;
  if not exists (select 1 from auth.users u where u.id = _user_id) then raise exception 'No such player'; end if;
  insert into public.spin_grants (user_id, kind, count, note, created_by)
    values (_user_id, _kind, _count, coalesce(_note, ''), _actor) returning id into v_grant;
  insert into public.spin_credits (user_id, source, ref, kind, grant_id, created_by)
    select _user_id, 'grant', v_grant::text || ':' || i, _kind, v_grant, _actor from generate_series(1, _count) i;
  insert into public.audit_log (actor, action, details)
    values (_actor, 'admin.grant_spins', jsonb_build_object('grant_id', v_grant, 'user_id', _user_id, 'kind', _kind, 'count', _count, 'note', _note));
  return v_grant;
end $$;

-- ---------------------------------------------------------------------------
-- Use granted demo spins (simulated draws on the demo machine)
-- ---------------------------------------------------------------------------
create or replace function public.use_demo_spins(_user_id uuid, _count int)
returns int language plpgsql security definer set search_path = '' as $$
declare v_used int;
begin
  if _count < 1 or _count > 10 then raise exception 'Invalid capsule count'; end if;
  with c as (
    select id from public.spin_credits
    where user_id = _user_id and kind = 'demo' and used_spin_id is null and used_at is null
    order by created_at, id limit _count for update skip locked
  ), u as (
    update public.spin_credits s set used_at = now() from c where s.id = c.id returning s.id
  ) select count(*)::int into v_used from u;
  return v_used;
end $$;

-- ---------------------------------------------------------------------------
-- Real draws: only real credits; granted credits are spent first and don't count toward limits
-- ---------------------------------------------------------------------------
create or replace function public.begin_spins(_user_id uuid, _count int)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  v_cfg jsonb; v_daily int; v_campaign int; v_credit uuid; v_source text; v_spin uuid;
  v_ids uuid[] := '{}'; v_limited int := 0; i int;
begin
  if _count < 1 or _count > 10 then raise exception 'Invalid capsule count'; end if;
  perform pg_advisory_xact_lock(hashtext('begin_spins:' || _user_id::text));

  if exists (select 1 from public.spins where user_id = _user_id and status = 'pending' and created_at > now() - interval '30 minutes') then
    raise exception 'You already have a draw in progress';
  end if;

  for i in 1.._count loop
    select c.id, c.source into v_credit, v_source from public.spin_credits c
      where c.user_id = _user_id and c.used_spin_id is null and c.kind = 'real'
      order by (c.source = 'grant') desc, c.created_at limit 1 for update skip locked;
    if v_credit is null then raise exception 'Not enough spin credits'; end if;
    insert into public.spins (user_id, credit_id, status) values (_user_id, v_credit, 'pending') returning id into v_spin;
    update public.spin_credits set used_spin_id = v_spin where id = v_credit;
    v_ids := v_ids || v_spin;
    if v_source <> 'grant' then v_limited := v_limited + 1; end if;
  end loop;

  -- Limits cover spins the player obtained themselves; spins an administrator granted are exempt.
  if v_limited > 0 then
    select value into v_cfg from public.app_config where key = 'spins';
    select count(*) into v_daily from public.spins s join public.spin_credits c on c.id = s.credit_id
      where s.user_id = _user_id and s.status <> 'refunded' and c.source <> 'grant'
        and s.created_at > now() - interval '1 day' and not (s.id = any(v_ids));
    select count(*) into v_campaign from public.spins s join public.spin_credits c on c.id = s.credit_id
      where s.user_id = _user_id and s.status <> 'refunded' and c.source <> 'grant' and not (s.id = any(v_ids));
    if v_daily + v_limited > coalesce((v_cfg->>'daily_limit')::int, 1000000) then raise exception 'Daily spin limit reached'; end if;
    if v_campaign + v_limited > coalesce((v_cfg->>'campaign_limit')::int, 1000000) then raise exception 'Campaign spin limit reached'; end if;
  end if;
  return v_ids;
end $$;

revoke all on function public.admin_grant_spins(uuid, int, text, text, uuid) from public, anon, authenticated;
revoke all on function public.use_demo_spins(uuid, int) from public, anon, authenticated;
revoke all on function public.begin_spins(uuid, int) from public, anon, authenticated;
grant execute on function public.admin_grant_spins(uuid, int, text, text, uuid) to service_role;
grant execute on function public.use_demo_spins(uuid, int) to service_role;
grant execute on function public.begin_spins(uuid, int) to service_role;
