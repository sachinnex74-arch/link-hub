-- Run this once in your Supabase SQL editor.
-- Shared DB-backed cache for Photon city autocomplete results.
-- Lets all users/devices share results across the worker pool, so we
-- stop hammering Photon from Cloudflare's shared egress IP.

create table if not exists public.place_search_cache (
  query      text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists place_search_cache_updated_at_idx
  on public.place_search_cache (updated_at);

-- Only the server (service_role) reads/writes this cache.
grant all on public.place_search_cache to service_role;

alter table public.place_search_cache enable row level security;
-- No policies: anon/authenticated have no access. service_role bypasses RLS.
