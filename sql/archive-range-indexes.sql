-- Indexes for the hybrid archive fetcher used by Delivered Loads and
-- POD List tabs. The first 90 days are served from localStorage; when the
-- user picks a date range that extends before that window, the server fns
-- listDeliveredLoadsByRange / listPODsByRange query these expressions.
-- Run once in the SQL editor.

create index if not exists loads_delivered_at_idx
  on public.loads (((data->>'deliveredAt')))
  where (data->>'lstatus') = 'DELIVERED';

create index if not exists pod_records_at_idx
  on public.pod_records (((data->>'at')));

analyze public.loads;
analyze public.pod_records;
