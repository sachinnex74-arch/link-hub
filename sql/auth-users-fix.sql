-- =====================================================================
-- FIX: existing `profiles` table from earlier driver setup has `name`
-- instead of `username`, so the auth trigger fails and login is broken.
-- Run this in Supabase SQL Editor AFTER sql/auth-users.sql.
-- Idempotent — safe to re-run.
-- =====================================================================

-- 1. Add username column if missing, backfill from `name` or email-like fallback.
alter table public.profiles add column if not exists username text;

update public.profiles p
   set username = coalesce(p.username, nullif(p.name, ''), 'user_' || substr(p.id::text,1,8))
 where p.username is null;

-- 2. Enforce NOT NULL + UNIQUE on username.
alter table public.profiles alter column username set not null;

do $$ begin
  alter table public.profiles add constraint profiles_username_key unique (username);
exception when duplicate_table or duplicate_object then null; end $$;

-- 3. Drop any orphan profile rows whose auth.user no longer exists,
--    so the admin bootstrap can recreate the admin cleanly.
delete from public.profiles p
 where not exists (select 1 from auth.users u where u.id = p.id);

-- 4. (Re-)ensure trigger is attached and uses the up-to-date function.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
