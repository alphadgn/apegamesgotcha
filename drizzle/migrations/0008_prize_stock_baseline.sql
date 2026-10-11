-- Stock baseline for the prize pool's "critical low" hold (live buys & spins pause at 20% left).
-- prizes.stocked = a limited prize's inventory at its last restock. Idempotent.
alter table public.prizes add column if not exists stocked integer check (stocked is null or stocked >= 0);

-- Existing prizes: today's inventory is the baseline (a later inventory increase counts as a restock).
update public.prizes set stocked = inventory where stocked is null and inventory is not null;
