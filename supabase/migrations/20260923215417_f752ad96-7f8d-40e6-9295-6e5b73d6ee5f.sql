create extension if not exists pgcrypto with schema extensions;

create type public.app_role as enum ('admin','moderator','user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.user_roles where user_id=_user_id and role=_role) $$;

create policy "own roles readable" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create table public.profiles (
  id uuid primary key,
  display_name text,
  created_at timestamptz not null default now()
);
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "profiles own read" on public.profiles for select to authenticated using (id = auth.uid() or public.has_role(auth.uid(),'admin'));
create policy "profiles own update" on public.profiles for update to authenticated using (id = auth.uid());

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)));
  insert into public.user_roles(user_id, role) values (new.id, 'user');
  if not exists (select 1 from public.user_roles where role='admin') then
    insert into public.user_roles(user_id, role) values (new.id, 'admin');
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Versioned configuration
create table public.app_config (
  key text primary key,
  value jsonb not null,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create table public.app_config_history (
  id bigserial primary key,
  key text not null,
  value jsonb not null,
  version int not null,
  changed_at timestamptz not null default now(),
  changed_by uuid
);
grant select on public.app_config to anon, authenticated;
grant all on public.app_config to service_role;
grant select on public.app_config_history to authenticated;
grant all on public.app_config_history to service_role;
alter table public.app_config enable row level security;
alter table public.app_config_history enable row level security;
create policy "config public read" on public.app_config for select to anon, authenticated using (true);
create policy "config history admin read" on public.app_config_history for select to authenticated using (public.has_role(auth.uid(),'admin'));

create or replace function public.config_version_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then new.version := old.version + 1; new.updated_at := now(); end if;
  insert into public.app_config_history(key,value,version,changed_by) values (new.key,new.value,new.version,new.updated_by);
  return new;
end $$;
create trigger app_config_versioning before insert or update on public.app_config for each row execute function public.config_version_trigger();

insert into public.app_config(key, value) values
('campaign', '{"name":"Go ApeGames 2026","phase":"pre_event","event_name":"Charleston","event_start":null,"event_end":null}'),
('nft', '{"contract":"0x8Bb7b20291A9fA2F25705b8487194B410808c28b","chain":"apechain","chain_id":33139,"rpc_url":"https://rpc.apechain.com/http","level_trait":"Level","burn_min_level":4,"burn_address":"0x000000000000000000000000000000000000dEaD","opensea_url":"https://opensea.io/collection/apegames-digital-competition-182336256"}'),
('chains', '{"supported":["apechain","ethereum","robinhood"]}'),
('scoring', '{"level_weights":{"1":10,"2":25,"3":50,"4":100,"5":200,"6":400},"default_level_weight":10}'),
('spins', '{"price_usd":5,"daily_limit":10,"campaign_limit":100,"payment_methods":["crypto","card"],"purchase_enabled":false,"randomness_provider":"server_csprng"}'),
('launch_gates', '{"snapshot_frozen":false,"claims_enabled":false,"lp_launch_enabled":false,"public_trading_enabled":false}');

-- Wallets
create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  address text not null unique,
  verified_at timestamptz not null default now()
);
grant select on public.wallets to authenticated;
grant all on public.wallets to service_role;
alter table public.wallets enable row level security;
create policy "wallets own read" on public.wallets for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create table public.wallet_nonces (
  user_id uuid primary key,
  nonce text not null,
  created_at timestamptz not null default now()
);
grant all on public.wallet_nonces to service_role;
alter table public.wallet_nonces enable row level security;

-- NFT holdings snapshot
create table public.nft_holdings (
  token_id text primary key,
  owner_address text not null,
  user_id uuid,
  level int,
  level_override int,
  burned boolean not null default false,
  synced_at timestamptz not null default now()
);
grant select on public.nft_holdings to authenticated;
grant all on public.nft_holdings to service_role;
alter table public.nft_holdings enable row level security;
create policy "holdings own read" on public.nft_holdings for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

-- Points ledger (append-only)
create table public.points_ledger (
  id bigserial primary key,
  user_id uuid not null,
  amount int not null,
  reason text not null,
  ref text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index points_ledger_unique_ref on public.points_ledger(reason, ref) where ref is not null;
grant select on public.points_ledger to authenticated;
grant all on public.points_ledger to service_role;
alter table public.points_ledger enable row level security;
create policy "ledger own read" on public.points_ledger for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

-- Prizes
create table public.prizes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rarity text not null default 'common',
  weight int not null default 1,
  points int not null default 0,
  inventory int,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select on public.prizes to anon, authenticated;
grant all on public.prizes to service_role;
alter table public.prizes enable row level security;
create policy "prizes public read" on public.prizes for select to anon, authenticated using (active or public.has_role(auth.uid(),'admin'));

insert into public.prizes(name, rarity, weight, points, inventory) values
('Banana Chip', 'common', 600, 50, null),
('Silver Crate', 'rare', 280, 150, null),
('Gold Crate', 'epic', 100, 400, 500),
('Charleston VIP Pass', 'legendary', 20, 1000, 20);

-- Spin credits & spins
create table public.spin_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source text not null check (source in ('burn','purchase','grant','free_entry')),
  ref text,
  used_spin_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index spin_credits_unique_ref on public.spin_credits(source, ref) where ref is not null;
grant select on public.spin_credits to authenticated;
grant all on public.spin_credits to service_role;
alter table public.spin_credits enable row level security;
create policy "credits own read" on public.spin_credits for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create table public.spins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  credit_id uuid not null,
  prize_id uuid not null references public.prizes(id),
  prize_name text not null,
  rarity text not null,
  points int not null,
  roll int not null,
  total_weight int not null,
  created_at timestamptz not null default now()
);
grant select on public.spins to authenticated;
grant all on public.spins to service_role;
alter table public.spins enable row level security;
create policy "spins own read" on public.spins for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

-- Burns
create table public.burn_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  token_id text not null unique,
  tx_hash text not null unique,
  level int not null,
  created_at timestamptz not null default now()
);
grant select on public.burn_claims to authenticated;
grant all on public.burn_claims to service_role;
alter table public.burn_claims enable row level security;
create policy "burns own read" on public.burn_claims for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

-- Audit log
create table public.audit_log (
  id bigserial primary key,
  actor uuid,
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
grant select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;
alter table public.audit_log enable row level security;
create policy "audit admin read" on public.audit_log for select to authenticated using (public.has_role(auth.uid(),'admin'));

-- Atomic spin (service role only)
create or replace function public.perform_spin(_user_id uuid)
returns public.spins language plpgsql security definer set search_path = public, extensions as $$
declare
  v_credit uuid; v_total int; v_roll int; v_acc int := 0; p record; v_spin public.spins;
  v_cfg jsonb; v_daily int; v_campaign int;
begin
  select value into v_cfg from app_config where key='spins';
  select count(*) into v_daily from spins where user_id=_user_id and created_at > now() - interval '1 day';
  select count(*) into v_campaign from spins where user_id=_user_id;
  if v_daily >= coalesce((v_cfg->>'daily_limit')::int, 1000000) then raise exception 'Daily spin limit reached'; end if;
  if v_campaign >= coalesce((v_cfg->>'campaign_limit')::int, 1000000) then raise exception 'Campaign spin limit reached'; end if;

  select id into v_credit from spin_credits where user_id=_user_id and used_spin_id is null order by created_at limit 1 for update skip locked;
  if v_credit is null then raise exception 'No spin credits available'; end if;

  select coalesce(sum(weight),0) into v_total from prizes where active and weight > 0 and (inventory is null or inventory > 0);
  if v_total = 0 then raise exception 'No prizes available'; end if;
  v_roll := (('x' || encode(gen_random_bytes(4),'hex'))::bit(32)::bigint % v_total)::int;

  for p in select * from prizes where active and weight > 0 and (inventory is null or inventory > 0) order by created_at, id loop
    v_acc := v_acc + p.weight;
    if v_roll < v_acc then
      update prizes set inventory = inventory - 1 where id = p.id and inventory is not null;
      insert into spins(user_id, credit_id, prize_id, prize_name, rarity, points, roll, total_weight)
        values (_user_id, v_credit, p.id, p.name, p.rarity, p.points, v_roll, v_total) returning * into v_spin;
      update spin_credits set used_spin_id = v_spin.id where id = v_credit;
      if p.points <> 0 then
        insert into points_ledger(user_id, amount, reason, ref) values (_user_id, p.points, 'spin', v_spin.id::text);
      end if;
      return v_spin;
    end if;
  end loop;
  raise exception 'Spin failed';
end $$;
revoke all on function public.perform_spin(uuid) from public, anon, authenticated;
grant execute on function public.perform_spin(uuid) to service_role;

-- Public leaderboard
create or replace function public.get_leaderboard(_limit int default 100)
returns table(rank bigint, user_id uuid, display_name text, points bigint)
language sql stable security definer set search_path = public as $$
  select rank() over (order by sum(l.amount) desc), l.user_id, coalesce(p.display_name,'Anonymous ape'), sum(l.amount)::bigint
  from points_ledger l left join profiles p on p.id = l.user_id
  group by l.user_id, p.display_name
  order by 4 desc limit least(_limit, 500)
$$;
grant execute on function public.get_leaderboard(int) to anon, authenticated;