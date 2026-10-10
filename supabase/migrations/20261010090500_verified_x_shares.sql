-- ============================================================================
-- Verified X result shares (season leaderboard, part 6 of 7)
--
-- * Only a verified X post that references a fulfilled spin owned by the
--   player earns points; a click or a submission alone never does.
-- * One post globally, one rewarded post per spin, one rewarded share per
--   player per UTC day (award_day from the server's submission time), one
--   linked X account at a time (history kept).
-- * Approval, daily slot, ledger entry and totals are one transaction.
--   Reversing the points does not reopen the day.
-- * The server never fetches arbitrary URLs: x.com / twitter.com status links
--   are normalised to post ids. Verification is either the X API (fixed
--   endpoint, when configured) or an audited manual review.
-- ============================================================================

create table if not exists public.x_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  x_user_id text check (x_user_id ~ '^[0-9]{1,25}$'),
  x_username text not null check (x_username ~ '^[A-Za-z0-9_]{1,15}$'),
  verification text not null check (verification in ('oauth', 'manual_review', 'self_declared')),
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  evidence jsonb not null default '{}'::jsonb
);
create unique index if not exists x_accounts_one_per_user on public.x_accounts (user_id) where unlinked_at is null;
create unique index if not exists x_accounts_one_owner_username on public.x_accounts (lower(x_username)) where unlinked_at is null;
create unique index if not exists x_accounts_one_owner_id on public.x_accounts (x_user_id) where unlinked_at is null and x_user_id is not null;

create table if not exists public.social_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  season_id uuid not null references public.seasons (id),
  spin_id uuid not null references public.spins (id),
  x_account_id uuid not null references public.x_accounts (id),
  post_id text not null unique check (post_id ~ '^[0-9]{5,25}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'limit_reached')),
  submitted_at timestamptz not null default now(),
  award_day date not null,
  reviewed_at timestamptz,
  reviewed_by uuid,
  verifier text check (verifier in ('x_api', 'manual_review')),
  author_x_user_id text,
  author_username text,
  post_created_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  rejection_reason text,
  ledger_id bigint
);
create unique index if not exists social_shares_one_reward_per_spin on public.social_shares (spin_id) where status = 'approved';
create index if not exists social_shares_queue_idx on public.social_shares (submitted_at) where status = 'pending';
create index if not exists social_shares_user_idx on public.social_shares (user_id, submitted_at desc);

create table if not exists public.social_award_slots (
  user_id uuid not null,
  award_day date not null,
  share_id uuid not null unique references public.social_shares (id),
  season_id uuid not null references public.seasons (id),
  created_at timestamptz not null default now(),
  primary key (user_id, award_day)
);

revoke all on public.x_accounts, public.social_shares, public.social_award_slots from anon;
revoke insert, update, delete, truncate on public.x_accounts, public.social_shares, public.social_award_slots from authenticated, service_role;
grant select on public.x_accounts, public.social_shares, public.social_award_slots to service_role;
alter table public.x_accounts enable row level security;
alter table public.social_shares enable row level security;
alter table public.social_award_slots enable row level security;
drop policy if exists "x accounts own read" on public.x_accounts;
create policy "x accounts own read" on public.x_accounts for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "social shares own read" on public.social_shares;
create policy "social shares own read" on public.social_shares for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "award slots own read" on public.social_award_slots;
create policy "award slots own read" on public.social_award_slots for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- x.com / twitter.com (and mobile.) status URLs → numeric post id. Anything else is rejected.
create or replace function public.normalize_x_post_url(_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare m text[];
begin
  m := regexp_match(btrim(coalesce(_url, '')),
       '^https://(?:www\.|mobile\.)?(?:x|twitter)\.com/(?:[A-Za-z0-9_]{1,15}|i/web|i)/status(?:es)?/([0-9]{5,25})(?:[/?#].*)?$');
  if m is null then return null; end if;
  return m[1];
end
$$;

-- Short code printed on each share card so a reviewer can match a post to its spin.
create or replace function public.spin_share_code(_spin_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$ select 'AGG-' || upper(substr(replace(_spin_id::text, '-', ''), 1, 10)) $$;

create or replace function public.link_x_account(_user_id uuid, _username text, _x_user_id text, _verification text, _evidence jsonb)
returns public.x_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare a public.x_accounts; v_name text := ltrim(btrim(_username), '@');
begin
  if v_name !~ '^[A-Za-z0-9_]{1,15}$' then raise exception 'Enter your X handle (letters, numbers, underscore)'; end if;
  if _verification not in ('oauth', 'manual_review', 'self_declared') then raise exception 'Unknown verification'; end if;
  perform pg_advisory_xact_lock(hashtextextended('x_accounts', 0));
  if exists (select 1 from public.x_accounts x where x.unlinked_at is null and x.user_id <> _user_id
              and (lower(x.x_username) = lower(v_name) or (_x_user_id is not null and x.x_user_id = _x_user_id))) then
    raise exception 'That X account is linked to another player' using errcode = 'P0409';
  end if;
  select * into a from public.x_accounts x where x.user_id = _user_id and x.unlinked_at is null for update;
  if found and lower(a.x_username) = lower(v_name) and a.x_user_id is not distinct from _x_user_id then return a; end if;
  update public.x_accounts set unlinked_at = now() where user_id = _user_id and unlinked_at is null;
  insert into public.x_accounts (user_id, x_user_id, x_username, verification, evidence)
  values (_user_id, _x_user_id, v_name, _verification, coalesce(_evidence, '{}'::jsonb)) returning * into a;
  insert into public.audit_log (actor, action, details) values (_user_id, 'x.linked', jsonb_build_object('username', v_name, 'verification', _verification));
  return a;
end
$$;

-- Submit a post for review. Never awards anything by itself.
create or replace function public.submit_social_share(_user_id uuid, _spin_id uuid, _post_url text)
returns public.social_shares
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seasons;
  sp public.spins;
  a public.x_accounts;
  sh public.social_shares;
  v_post text := public.normalize_x_post_url(_post_url);
  v_recent int;
  v_queue int;
  v_cfg jsonb;
begin
  s := public._current_season();
  if s.id is null then raise exception 'Share rewards open during an active season'; end if;
  if not coalesce((s.rules ->> 'social_enabled')::boolean, false) or coalesce((s.rules ->> 'social_share_points')::bigint, 0) = 0 then
    raise exception 'Share rewards are turned off this season' using errcode = 'P0403';
  end if;
  if v_post is null then raise exception 'Paste the link to your post on x.com'; end if;
  select * into sp from public.spins where id = _spin_id;
  if not found or sp.user_id <> _user_id then raise exception 'That spin isn''t yours'; end if;
  if sp.status <> 'fulfilled' then raise exception 'Only revealed prizes can be shared for points'; end if;
  select * into a from public.x_accounts where user_id = _user_id and unlinked_at is null;
  if not found then raise exception 'Link your X account first'; end if;

  select value into v_cfg from public.app_config where key = 'social';
  perform pg_advisory_xact_lock(hashtextextended('social_submit:' || _user_id::text, 0));
  select count(*) into v_recent from public.social_shares x where x.user_id = _user_id and x.submitted_at > now() - interval '1 hour';
  if v_recent >= coalesce((v_cfg ->> 'max_submissions_per_hour')::int, 5) then raise exception 'Too many submissions. Try again later.' using errcode = 'P0429'; end if;
  select count(*) into v_queue from public.social_shares x where x.status = 'pending';
  if v_queue >= coalesce((v_cfg ->> 'max_pending_queue')::int, 500) then raise exception 'The review queue is full. Try again later.' using errcode = 'P0429'; end if;
  if exists (select 1 from public.social_shares x where x.post_id = v_post) then raise exception 'That post was already submitted' using errcode = 'P0409'; end if;
  if exists (select 1 from public.social_shares x where x.spin_id = _spin_id and x.user_id = _user_id and x.status in ('pending', 'approved')) then
    raise exception 'This spin already has a share under review or rewarded';
  end if;

  insert into public.social_shares (user_id, season_id, spin_id, x_account_id, post_id, award_day)
  values (_user_id, s.id, _spin_id, a.id, v_post, (now() at time zone 'UTC')::date)
  returning * into sh;
  return sh;
end
$$;

-- Approve or reject after verifying the public post (X API or manual review). Approval and award are atomic.
-- _evidence must include: author_username (and author_x_user_id when known), post_created_at,
-- references_spin (true when the post text/card shows the spin's share code), public (true).
create or replace function public.review_social_share(_share_id uuid, _decision text, _verifier text, _evidence jsonb, _reason text, _actor uuid)
returns public.social_shares
language plpgsql
security definer
set search_path = ''
as $$
declare
  sh public.social_shares;
  a public.x_accounts;
  s public.seasons;
  v_created timestamptz;
  v_slot int;
  v_ledger bigint;
begin
  if _actor is null and _verifier = 'manual_review' then raise exception 'Manual reviews need an accountable reviewer'; end if;
  if _verifier not in ('x_api', 'manual_review') then raise exception 'Unknown verifier'; end if;
  select * into sh from public.social_shares where id = _share_id for update;
  if not found then raise exception 'Unknown share'; end if;
  if sh.status <> 'pending' then return sh; end if;

  if _decision = 'reject' then
    if _reason is null or length(btrim(_reason)) < 3 then raise exception 'Give a reason'; end if;
    update public.social_shares set status = 'rejected', reviewed_at = now(), reviewed_by = _actor, verifier = _verifier,
           rejection_reason = btrim(_reason), evidence = coalesce(_evidence, '{}'::jsonb)
     where id = sh.id returning * into sh;
    insert into public.audit_log (actor, action, details) values (_actor, 'social.rejected', jsonb_build_object('share_id', sh.id, 'reason', btrim(_reason)));
    return sh;
  end if;
  if _decision <> 'approve' then raise exception 'Decision must be approve or reject'; end if;

  select * into a from public.x_accounts where id = sh.x_account_id;
  select * into s from public.seasons where id = sh.season_id for share;
  v_created := (_evidence ->> 'post_created_at')::timestamptz;
  if not coalesce((_evidence ->> 'public')::boolean, false) then raise exception 'The post must be public'; end if;
  if not coalesce((_evidence ->> 'references_spin')::boolean, false) then raise exception 'The post must show this spin''s share code'; end if;
  if lower(coalesce(_evidence ->> 'author_username', '')) <> lower(a.x_username)
     or (a.x_user_id is not null and (_evidence ->> 'author_x_user_id') is distinct from a.x_user_id) then
    raise exception 'The post was not written by the linked X account';
  end if;
  if v_created is null or v_created < s.starts_at or v_created >= s.ends_at or v_created > sh.submitted_at then
    raise exception 'The post must be created during the season and before it was submitted';
  end if;
  if s.status not in ('active', 'settling') then raise exception 'Season is closed'; end if;

  insert into public.social_award_slots (user_id, award_day, share_id, season_id)
  values (sh.user_id, sh.award_day, sh.id, sh.season_id)
  on conflict (user_id, award_day) do nothing;
  get diagnostics v_slot = row_count;

  if v_slot = 1 then
    v_ledger := public._award_points(s.id, sh.user_id, 'social_share', sh.id::text, 'social_share',
                                     coalesce((s.rules ->> 'social_share_points')::bigint, 0), s.rule_version_id, now(),
                                     jsonb_build_object('post_id', sh.post_id, 'spin_id', sh.spin_id, 'award_day', sh.award_day), _actor);
    update public.social_shares set status = 'approved', ledger_id = v_ledger
     where id = sh.id;
  else
    update public.social_shares set status = 'limit_reached' where id = sh.id;
  end if;
  update public.social_shares set reviewed_at = now(), reviewed_by = _actor, verifier = _verifier,
         author_x_user_id = _evidence ->> 'author_x_user_id', author_username = _evidence ->> 'author_username',
         post_created_at = v_created, evidence = coalesce(_evidence, '{}'::jsonb)
   where id = sh.id returning * into sh;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'social.reviewed', jsonb_build_object('share_id', sh.id, 'status', sh.status, 'verifier', _verifier));
  return sh;
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.link_x_account(uuid, text, text, text, jsonb)', 'public.submit_social_share(uuid, uuid, text)',
    'public.review_social_share(uuid, text, text, jsonb, text, uuid)', 'public.normalize_x_post_url(text)',
    'public.spin_share_code(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

insert into public.app_config (key, value)
values ('social', '{"verifier": "manual_review", "max_submissions_per_hour": 5, "max_pending_queue": 500, "x_api_enabled": false}'::jsonb)
on conflict (key) do nothing;
