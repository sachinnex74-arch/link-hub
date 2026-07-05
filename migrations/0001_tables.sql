-- ════════════════════════════════════════════════════════════════════════════
-- 0001_tables.sql — table structures, snapshot from production 2026-07-04
-- 22 tables · REFERENCE SNAPSHOT (see README for limitations: constraints,
-- indexes, and generated-column expressions are not fully rendered here —
-- columns marked 'default' on loads.lstatus/vehicle_id/delivered_at and
-- vehicles.status/assigned_load_id are actually GENERATED columns).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.app_audit_log (
  id uuid not null default gen_random_uuid(),
  entity_type text not null,
  entity_id text,
  entity_label text,
  action text not null,
  changes jsonb not null default '{}'::jsonb,
  user_id uuid,
  email text,
  source text default 'app'::text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.app_settings (
  key text not null,
  value jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.audit_log (
  id uuid not null default gen_random_uuid(),
  at timestamp with time zone not null default now(),
  action text not null,
  entity_type text not null default 'load'::text,
  entity_id text,
  lid text,
  user_id uuid,
  email text,
  source text not null default 'app'::text,
  details jsonb not null default '{}'::jsonb
);

create table if not exists public.dwell_alerts (
  id bigint not null default nextval('dwell_alerts_id_seq'::regclass),
  vehicle_id text not null,
  vnum text,
  zone_id text not null,
  zone_name text,
  entered_at timestamp with time zone not null,
  alerted_at timestamp with time zone not null default now(),
  cleared_at timestamp with time zone,
  acknowledged boolean not null default false
);

create table if not exists public.dwell_state (
  vehicle_id text not null,
  zone_id text not null,
  vnum text,
  entered_at timestamp with time zone not null default now(),
  last_seen_inside timestamp with time zone not null default now(),
  notified_at timestamp with time zone
);

create table if not exists public.dwell_zones (
  id text not null default (gen_random_uuid())::text,
  name text not null,
  center_lat double precision not null,
  center_lng double precision not null,
  radius_m integer not null default 2000,
  active boolean not null default true,
  created_by text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.geofence_alerts (
  id text not null,
  data jsonb not null,
  updated_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now()
);

create table if not exists public.gps_hourly (
  id uuid not null default gen_random_uuid(),
  vehicle_number text not null,
  lat double precision not null,
  lng double precision not null,
  speed double precision,
  heading double precision,
  status text,
  address text,
  captured_at timestamp with time zone not null default now()
);

create table if not exists public.load_attachments (
  id uuid not null default gen_random_uuid(),
  load_id text,
  kind text not null,
  name text,
  storage_path text not null,
  size bigint,
  mime text,
  uploaded_at timestamp with time zone default now(),
  meta jsonb not null default '{}'::jsonb,
  path text,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.load_audit_log (
  id uuid not null default gen_random_uuid(),
  load_id text not null,
  lid text,
  load_data jsonb,
  deleted_by_user_id uuid,
  deleted_by_email text,
  source text not null default 'db'::text,
  deleted_at timestamp with time zone not null default now()
);

create table if not exists public.loads (
  id text not null default gen_random_uuid(),
  lid text not null,
  customer text,
  origin text,
  dest text,
  commodity text,
  weight text,
  vehicle_id text,
  delivered_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone not null default now(),
  version bigint not null default 1,
  lstatus text default (data ->> 'lstatus'::text),
  deleted_at timestamp with time zone
);

create table if not exists public.loads_delete_log (
  log_id bigint not null,
  load_id text,
  data jsonb,
  deleted_at timestamp with time zone not null default now(),
  deleted_by_user_id uuid,
  deleted_by_email text
);

create table if not exists public.place_search_cache (
  query text not null,
  payload jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.pod_records (
  id text not null default gen_random_uuid(),
  vnum text,
  driver text,
  mobile text,
  customer text,
  load_id text,
  lid text,
  storage_path text,
  status text default 'OK'::text,
  at timestamp with time zone default now(),
  data jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.profiles (
  id uuid not null,
  name text,
  created_at timestamp with time zone not null default now(),
  username text not null
);

create table if not exists public.sos_records (
  id text not null default gen_random_uuid(),
  vnum text,
  driver text,
  mobile text,
  at timestamp with time zone default now(),
  data jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.user_roles (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  role app_role not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.vehicle_halt_current (
  vehicle_number text not null,
  is_stopped boolean not null default false,
  halt_started_at timestamp with time zone,
  lat double precision,
  lng double precision,
  address text,
  load_id text,
  last_lat double precision,
  last_lng double precision,
  last_seen_at timestamp with time zone,
  last_moved_at timestamp with time zone,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.vehicle_halt_events (
  id bigint not null default nextval('vehicle_halt_events_id_seq'::regclass),
  vehicle_number text not null,
  started_at timestamp with time zone not null,
  ended_at timestamp with time zone not null,
  duration_seconds integer not null,
  lat double precision,
  lng double precision,
  address text,
  load_id text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.vehicle_idle_state (
  vehicle_id text not null,
  lat double precision not null,
  lng double precision not null,
  first_seen_at timestamp with time zone not null default now(),
  last_seen_at timestamp with time zone not null default now(),
  status text,
  address text,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.vehicle_pins (
  vnum text not null,
  pin_hash text not null default ''::text,
  salt text default ''::text,
  updated_at timestamp with time zone default now(),
  pin text
);

create table if not exists public.vehicles (
  id text not null default gen_random_uuid(),
  vnum text not null,
  vtype text,
  driver text,
  mobile text,
  customer text,
  gps jsonb,
  route text,
  eta timestamp with time zone,
  assigned_load_id text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  status text default (data ->> 'vstatus'::text)
);
