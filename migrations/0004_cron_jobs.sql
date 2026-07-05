-- ════════════════════════════════════════════════════════════════════════════
-- 0004_cron_jobs.sql — pg_cron schedule, verbatim from production
-- Exported: 2026-07-04 · 9 jobs
-- To restore a job: cron.unschedule('<name>') first (schedule() with an existing
-- name errors), then run its line below. Secrets note: the x-cron-secret value is
-- embedded in the commands — when Phase S rotates it, re-export this file.
-- ════════════════════════════════════════════════════════════════════════════

select cron.schedule('left-unloading-tick', '*/15 * * * *', $cron$
    select net.http_post(
      url     := 'https://www.nsload.com/api/public/left-unloading-tick',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', 'Vercel@8826'),
      body    := '{}'::jsonb
    ) as request_id;
  $cron$);

select cron.schedule('geofence-tick', '*/2 * * * *', $cron$
    select net.http_post(
      url     := 'https://www.nsload.com/api/public/geofence-tick',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', 'Vercel@8826'),
      body    := '{}'::jsonb
    ) as request_id;
  $cron$);

select cron.schedule('gps-hourly-snapshot', '0 * * * *', $cron$
    select net.http_post(
      url     := 'https://www.nsload.com/api/public/gps-snapshot',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', 'Vercel@8826'),
      body    := '{}'::jsonb
    ) as request_id;
  $cron$);

select cron.schedule('arrival-tick', '*/5 * * * *', $cron$
    select net.http_post(
      url     := 'https://www.nsload.com/api/public/arrival-tick',
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', 'Vercel@8826'),
      body    := '{}'::jsonb
    ) as request_id;
  $cron$);

select cron.schedule('audit-log-purge', '30 21 1 * *', $cron$
    delete from public.audit_log
    where
      (entity_type = 'load'    and at < now() - interval '1 year')
      or
      (entity_type = 'vehicle' and at < now() - interval '90 days');
  $cron$);

select cron.schedule('stoppage-tick', '*/15 * * * *', $cron$
  select net.http_post(
    url     := 'https://www.nsload.com/api/public/stoppage-tick',
    headers := jsonb_build_object('content-type','application/json','x-cron-secret','Vercel@8826'),
    body    := '{}'::jsonb
  ) as request_id;
  $cron$);

select cron.schedule('vehicle-halt-purge', '10 3 1 * *', $cron$ select public.app_purge_halt_events(90); $cron$);

select cron.schedule('dwell-tick', '*/15 * * * *', $cron$
  select net.http_post(
    url     := 'https://www.nsload.com/api/public/dwell-tick',
    headers := jsonb_build_object('x-cron-secret', 'Vercel@8826', 'Content-Type', 'application/json'),
    body    := '{}'::jsonb
  );
  $cron$);

select cron.schedule('invariant-tick', '*/30 * * * *', $cron$
    select net.http_post(
      url     := 'https://www.nsload.com/api/public/invariant-tick',
      headers := jsonb_build_object('content-type','application/json','x-cron-secret','Vercel@8826'),
      body    := '{}'::jsonb
    ) as request_id;
  $cron$);
