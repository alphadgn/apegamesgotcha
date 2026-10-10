-- IRL (physical) prize claims. A player who wins a physical prize in a real Chainlink draw submits how
-- to receive it (pick up at ApeFest or ship it); admins track each claim to delivery.
-- Idempotent.

-- Prize pictures are uploaded image files kept in a PRIVATE bucket (no public links); the app shows them
-- through short-lived signed URLs. Make sure the bucket exists and only takes images.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('prize-images', 'prize-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.prize_claims (
  id uuid primary key default gen_random_uuid(),
  spin_id uuid not null unique references public.spins (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  prize_id uuid references public.prizes (id) on delete set null,
  prize_name text not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'shipped', 'delivered', 'rejected')),
  full_name text not null check (char_length(full_name) between 2 and 120),
  email text not null check (char_length(email) between 3 and 255),
  phone text check (phone is null or char_length(phone) <= 40),
  delivery text not null check (delivery in ('pickup', 'ship')),
  address jsonb,
  notes text check (notes is null or char_length(notes) <= 1000),
  admin_note text check (admin_note is null or char_length(admin_note) <= 1000),
  tracking text check (tracking is null or char_length(tracking) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prize_claims_address_for_shipping check (delivery = 'pickup' or address is not null)
);
create index if not exists prize_claims_user_idx on public.prize_claims (user_id, created_at desc);
create index if not exists prize_claims_status_idx on public.prize_claims (status, created_at desc);

alter table public.prize_claims enable row level security;
revoke all on public.prize_claims from public, anon, authenticated;
grant select on public.prize_claims to authenticated;
grant all on public.prize_claims to service_role;
-- Players see their own claims (contact details included); admins see all. All writes go through the server.
drop policy if exists "prize claims own read" on public.prize_claims;
create policy "prize claims own read" on public.prize_claims
  for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
