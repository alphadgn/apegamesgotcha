-- Free-spin redemption codes. Idempotent.
-- An admin makes a code (hex, 8–10 characters) that gives N spins and is valid for a time window (default 4 hours).
-- Each signed-in player can redeem a code once; redeeming grants the spins through admin_grant_spins (so they show
-- in Admin → Grants, are spent first and are exempt from per-player limits). All checks happen in redeem_spin_code.
create table if not exists public.spin_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[0-9a-f]{8,10}$'),
  kind text not null default 'real' check (kind in ('real', 'demo')),
  spins integer not null default 1 check (spins between 1 and 10),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  disabled boolean not null default false,
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  check (expires_at > starts_at)
);
create table if not exists public.spin_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references public.spin_codes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  grant_id uuid,
  created_at timestamptz not null default now(),
  unique (code_id, user_id)
);
alter table public.spin_codes enable row level security;
alter table public.spin_code_redemptions enable row level security;
revoke all on public.spin_codes from public, anon, authenticated;
revoke all on public.spin_code_redemptions from public, anon, authenticated;
grant all on public.spin_codes to service_role;
grant all on public.spin_code_redemptions to service_role;

-- Redeem a code for a player. Returns the number of spins granted; raises a player-friendly message otherwise.
create or replace function public.redeem_spin_code(_user_id uuid, _code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.spin_codes; v_used int; v_grant uuid; v_code text;
begin
  v_code := lower(regexp_replace(coalesce(_code, ''), '[^0-9a-fA-F]', '', 'g'));
  if v_code !~ '^[0-9a-f]{8,10}$' then raise exception 'That code isn''t valid.'; end if;
  select * into c from public.spin_codes where code = v_code for update;
  if not found or c.disabled then raise exception 'That code isn''t valid.'; end if;
  if now() < c.starts_at then raise exception 'That code isn''t active yet.'; end if;
  if now() >= c.expires_at then raise exception 'That code has expired.'; end if;
  if exists (select 1 from public.spin_code_redemptions r where r.code_id = c.id and r.user_id = _user_id) then
    raise exception 'You already redeemed this code.';
  end if;
  if c.max_redemptions is not null then
    select count(*) into v_used from public.spin_code_redemptions r where r.code_id = c.id;
    if v_used >= c.max_redemptions then raise exception 'This code has been used up.'; end if;
  end if;
  v_grant := public.admin_grant_spins(_user_id, c.spins, c.kind, 'Code ' || c.code, coalesce(c.created_by, _user_id));
  insert into public.spin_code_redemptions (code_id, user_id, grant_id) values (c.id, _user_id, v_grant);
  return jsonb_build_object('spins', c.spins, 'kind', c.kind, 'expires_at', c.expires_at);
end $$;
revoke all on function public.redeem_spin_code(uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_spin_code(uuid, text) to service_role;

-- The first code (Oct 18): 1 real spin, once per player, valid for 4 hours from when this update is applied.
insert into public.spin_codes (code, kind, spins, starts_at, expires_at, note)
values ('fd207d8e67', 'real', 1, now(), now() + interval '4 hours', 'First free-spin code (4 hours)')
on conflict (code) do nothing;