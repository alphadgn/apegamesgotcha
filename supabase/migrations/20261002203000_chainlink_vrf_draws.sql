-- ============================================================================
-- Chainlink VRF draws
-- Prizes are now picked on-chain by the GotchaVRF contract (Chainlink VRF v2.5).
-- The database only reserves credits, records the request, and settles the
-- result the contract produced. The old server-side RNG is removed.
-- ============================================================================

-- Prize <-> contract pool index (stable; new prizes are appended)
alter table public.prizes add column if not exists onchain_index int unique;

-- Spins can now be pending while Chainlink draws
alter table public.spins
  alter column prize_id drop not null,
  alter column prize_name drop not null,
  alter column rarity drop not null,
  alter column points drop not null,
  alter column roll drop not null,
  alter column total_weight drop not null,
  add column if not exists status text not null default 'fulfilled',
  add column if not exists chain_id int,
  add column if not exists contract_address text,
  add column if not exists request_tx text,
  add column if not exists vrf_request_id text,
  add column if not exists random_word text,
  add column if not exists fulfilled_at timestamptz;

alter table public.spins drop constraint if exists spins_status_check;
alter table public.spins add constraint spins_status_check check (status in ('pending', 'fulfilled', 'refunded'));
create index if not exists spins_pending_idx on public.spins(created_at) where status = 'pending';

-- Remove the off-chain RNG entirely
drop function if exists public.perform_spin(uuid);

-- ---------------------------------------------------------------------------
-- Reserve credits and create pending spins (atomic)
-- ---------------------------------------------------------------------------
create or replace function public.begin_spins(_user_id uuid, _count int)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb; v_daily int; v_campaign int; v_credit uuid; v_spin uuid; v_ids uuid[] := '{}'; i int;
begin
  if _count < 1 or _count > 10 then raise exception 'Invalid capsule count'; end if;
  perform pg_advisory_xact_lock(hashtext('begin_spins:' || _user_id::text));

  if exists (select 1 from spins where user_id = _user_id and status = 'pending' and created_at > now() - interval '30 minutes') then
    raise exception 'You already have a draw in progress';
  end if;

  select value into v_cfg from app_config where key = 'spins';
  select count(*) into v_daily from spins where user_id = _user_id and status <> 'refunded' and created_at > now() - interval '1 day';
  select count(*) into v_campaign from spins where user_id = _user_id and status <> 'refunded';
  if v_daily + _count > coalesce((v_cfg->>'daily_limit')::int, 1000000) then raise exception 'Daily spin limit reached'; end if;
  if v_campaign + _count > coalesce((v_cfg->>'campaign_limit')::int, 1000000) then raise exception 'Campaign spin limit reached'; end if;

  for i in 1.._count loop
    select id into v_credit from spin_credits
      where user_id = _user_id and used_spin_id is null
      order by created_at limit 1 for update skip locked;
    if v_credit is null then raise exception 'Not enough spin credits'; end if;
    insert into spins(user_id, credit_id, status) values (_user_id, v_credit, 'pending') returning id into v_spin;
    update spin_credits set used_spin_id = v_spin where id = v_credit;
    v_ids := v_ids || v_spin;
  end loop;
  return v_ids;
end $$;

-- ---------------------------------------------------------------------------
-- Return credits for spins that never reached Chainlink or were cancelled
-- ---------------------------------------------------------------------------
create or replace function public.refund_spins(_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  with r as (
    update spins set status = 'refunded'
    where id = any(_ids) and status = 'pending'
    returning id
  ) select coalesce(array_agg(id), '{}') into v_ids from r;
  update spin_credits set used_spin_id = null where used_spin_id = any(v_ids);
  return coalesce(array_length(v_ids, 1), 0);
end $$;

-- ---------------------------------------------------------------------------
-- Settle a spin with the prize index the contract drew (idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.finalize_spin(_spin_id uuid, _prize_index int, _random_word text, _request_id text)
returns public.spins language plpgsql security definer set search_path = public as $$
declare s public.spins; p public.prizes;
begin
  select * into s from spins where id = _spin_id for update;
  if not found then raise exception 'Unknown spin'; end if;
  if s.status <> 'pending' then return s; end if;

  if _prize_index = 255 then -- NO_PRIZE: pool was empty when Chainlink answered
    perform refund_spins(array[_spin_id]);
    select * into s from spins where id = _spin_id;
    return s;
  end if;

  select * into p from prizes where onchain_index = _prize_index;
  if not found then raise exception 'No prize mapped to on-chain index %', _prize_index; end if;

  update prizes set inventory = inventory - 1 where id = p.id and inventory is not null and inventory > 0;
  update spins set
    status = 'fulfilled', prize_id = p.id, prize_name = p.name, rarity = p.rarity, points = p.points,
    random_word = _random_word, vrf_request_id = coalesce(vrf_request_id, _request_id), fulfilled_at = now()
  where id = _spin_id returning * into s;

  if p.points <> 0 then
    insert into points_ledger(user_id, amount, reason, ref) values (s.user_id, p.points, 'spin', s.id::text)
    on conflict do nothing;
  end if;
  return s;
end $$;

revoke all on function public.begin_spins(uuid, int) from public, anon, authenticated;
revoke all on function public.refund_spins(uuid[]) from public, anon, authenticated;
revoke all on function public.finalize_spin(uuid, int, text, text) from public, anon, authenticated;
grant execute on function public.begin_spins(uuid, int) to service_role;
grant execute on function public.refund_spins(uuid[]) to service_role;
grant execute on function public.finalize_spin(uuid, int, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------
insert into public.app_config(key, value) values
('vrf', '{
  "enabled": false,
  "chain": "base-sepolia",
  "chain_id": 84532,
  "rpc_url": "https://sepolia.base.org",
  "contract": "",
  "explorer_url": "https://sepolia.basescan.org",
  "max_batch": 5,
  "draw_timeout_sec": 900
}')
on conflict (key) do nothing;

update public.app_config
set value = jsonb_set(value, '{randomness_provider}', '"chainlink_vrf"')
where key = 'spins';
