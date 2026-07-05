-- Run this in the Supabase SQL editor.
-- Makes updated_at server-authoritative: the DB sets it to now() on every
-- INSERT or UPDATE, overriding any client-supplied value and eliminating
-- cross-device clock-skew from the delta sync cursor.
--
-- Re-run safely: every statement is idempotent.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.vehicles;
create trigger set_updated_at
  before insert or update on public.vehicles
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.loads;
create trigger set_updated_at
  before insert or update on public.loads
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.pod_records;
create trigger set_updated_at
  before insert or update on public.pod_records
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.sos_records;
create trigger set_updated_at
  before insert or update on public.sos_records
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.vehicle_pins;
create trigger set_updated_at
  before insert or update on public.vehicle_pins
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.load_attachments;
create trigger set_updated_at
  before insert or update on public.load_attachments
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.geofence_alerts;
create trigger set_updated_at
  before insert or update on public.geofence_alerts
  for each row execute function public.set_updated_at();
