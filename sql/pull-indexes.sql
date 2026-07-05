-- Indexes to keep pullAll() under Postgres statement timeout.
-- Run this once in the SQL editor.

create index if not exists vehicles_updated_at_idx        on public.vehicles (updated_at desc);
create index if not exists loads_updated_at_idx           on public.loads (updated_at desc);
create index if not exists pod_records_updated_at_idx     on public.pod_records (updated_at desc);
create index if not exists sos_records_created_at_idx     on public.sos_records (created_at desc);
create index if not exists load_attachments_updated_at_idx on public.load_attachments (updated_at desc);
create index if not exists load_attachments_kind_idx      on public.load_attachments (kind);
create index if not exists geofence_alerts_updated_at_idx on public.geofence_alerts (updated_at desc);

analyze public.vehicles;
analyze public.loads;
analyze public.pod_records;
analyze public.sos_records;
analyze public.load_attachments;
analyze public.geofence_alerts;
