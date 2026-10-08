-- ApeFest 2026 (Charleston) knowledge for the guide, scraped from the Bored Ape Yacht Club site with Firecrawl.

create table if not exists public.event_knowledge (
  url text primary key,
  title text,
  content text not null,
  source text not null default 'scrape', -- 'scrape' (configured page) | 'search' (Firecrawl search hit) | 'linked' (found on a configured page)
  fetched_at timestamptz not null default now()
);
grant all on public.event_knowledge to service_role;
alter table public.event_knowledge enable row level security;
-- No client policies: only the server (guide + admin functions) reads or writes it.

-- What to check and how often. Editable in Admin → Configuration → event_info.
insert into public.app_config (key, value)
values (
  'event_info',
  '{
    "name": "ApeFest 2026",
    "host": "Bored Ape Yacht Club (@BoredApeYC)",
    "city": "Charleston, South Carolina",
    "date": "2026-10-17",
    "notes": "The ApeGames are held at ApeFest every year.",
    "sources": ["https://boredapeyachtclub.com/", "https://boredapeyachtclub.com/activations", "https://boredapeyachtclub.com/meetups"],
    "follow_link_keywords": ["apefest-2026", "apefest-charleston", "charleston", "apegames", "ape-games"],
    "search_queries": ["ApeFest 2026 Charleston", "ApeGames ApeFest"],
    "allowed_domains": ["boredapeyachtclub.com"],
    "refresh_hours": 6
  }'::jsonb
)
on conflict (key) do nothing;
