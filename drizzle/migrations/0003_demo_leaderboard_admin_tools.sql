-- Demo vs live leaderboard, deleting granted spins, and prize delivery tracking.
-- Idempotent (safe to run twice). Functions: search_path = '' and no execute for anon/authenticated
-- unless listed as public read-only.

-- ---------------------------------------------------------------------------
-- Demo spins played by signed-in players (the free every-30-minutes spin and granted demo spins).
-- The server draws them (not Chainlink) and they earn points on the demo leaderboard only.
-- ---------------------------------------------------------------------------
create table if not exists public.demo_spins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('free', 'grant')),
  prize_id uuid references public.prizes (id) on delete set null,
  prize_name text not null,
  rarity text not null,
  points int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists demo_spins_user_idx on public.demo_spins (user_id, created_at desc);
create index if not exists demo_spins_free_idx on public.demo_spins (user_id, created_at desc) where source = 'free';
alter table public.demo_spins enable row level security;
revoke all on public.demo_spins from public, anon, authenticated;
grant select on public.demo_spins to authenticated;
grant all on public.demo_spins to service_role;
drop policy if exists "demo spins own read" on public.demo_spins;
create policy "demo spins own read" on public.demo_spins
  for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- Which board the public sees: 'live' (real on-chain spins) or 'demo' (demo spins). Admin switches it.
insert into public.app_config (key, value) values ('leaderboard', '{"mode": "live"}'::jsonb)
on conflict (key) do nothing;

create or replace function public.leaderboard_mode()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select c.value ->> 'mode' from public.app_config c where c.key = 'leaderboard'), 'live')
$$;

-- Same signature as before, so every caller keeps working; what it adds up depends on the mode.
--   live: points from real (Chainlink) spins — purchased, paid-equivalent grants, burns — plus admin adjustments
--   demo: points from signed-in players' demo spins (free + granted)
create or replace function public.get_leaderboard(_limit int default 100)
returns table (rank bigint, user_id uuid, display_name text, points bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.leaderboard_mode() = 'demo' then
    return query
      select rank() over (order by sum(d.points) desc), d.user_id, coalesce(p.display_name, 'Anonymous ape'), sum(d.points)::bigint
        from public.demo_spins d left join public.profiles p on p.id = d.user_id
       group by d.user_id, p.display_name
      having sum(d.points) > 0
       order by 4 desc
       limit least(greatest(_limit, 1), 500);
  else
    return query
      select rank() over (order by sum(l.amount) desc), l.user_id, coalesce(p.display_name, 'Anonymous ape'), sum(l.amount)::bigint
        from public.points_ledger l left join public.profiles p on p.id = l.user_id
       where l.reason in ('spin', 'admin_adjustment')
       group by l.user_id, p.display_name
      having sum(l.amount) <> 0
       order by 4 desc
       limit least(greatest(_limit, 1), 500);
  end if;
end $$;

revoke all on function public.leaderboard_mode() from public;
revoke all on function public.get_leaderboard(int) from public;
grant execute on function public.leaderboard_mode() to anon, authenticated, service_role;
grant execute on function public.get_leaderboard(int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Delete a grant's unused spins (spins already played stay, with their results and points).
-- Returns how many unused spins were removed. The grant row keeps the used count, or goes if none were used.
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_grant(_grant_id uuid, _actor uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare g public.spin_grants; v_removed int; v_used int;
begin
  select * into g from public.spin_grants where id = _grant_id for update;
  if not found then raise exception 'No such grant'; end if;
  with d as (
    delete from public.spin_credits c
     where c.grant_id = _grant_id and c.used_spin_id is null and c.used_at is null
     returning c.id
  ) select count(*)::int into v_removed from d;
  select count(*)::int into v_used from public.spin_credits c where c.grant_id = _grant_id;
  if v_used = 0 then
    delete from public.spin_grants where id = _grant_id;
  else
    update public.spin_grants set count = v_used,
      note = btrim(note || ' · ' || v_removed || ' unused deleted by admin')
     where id = _grant_id;
  end if;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'admin.grant_deleted', jsonb_build_object('grant_id', _grant_id, 'user_id', g.user_id, 'kind', g.kind,
          'granted', g.count, 'removed', v_removed, 'kept_used', v_used, 'note', g.note));
  return v_removed;
end $$;
revoke all on function public.admin_delete_grant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_grant(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Prize delivery: admins mark real prizes as handed over.
-- ---------------------------------------------------------------------------
alter table public.spins
  add column if not exists delivered_at timestamptz,
  add column if not exists delivered_by uuid;
