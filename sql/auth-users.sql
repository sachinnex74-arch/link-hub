-- =====================================================================
-- TMS Auth: profiles + roles + admin bootstrap
-- Idempotent: safe to re-run.
-- Run this in Supabase SQL Editor.
-- The admin user itself (admin / 8826) is auto-created from the app on
-- first load via ensureAdminBootstrap() — no need to seed it here.
-- =====================================================================

-- 1. role enum
do $$ begin
  create type public.app_role as enum ('admin','user');
exception when duplicate_object then null; end $$;

-- 2. profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  created_at timestamptz not null default now()
);
grant select on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_auth" on public.profiles;
create policy "profiles_select_auth"
  on public.profiles for select
  to authenticated
  using (true);

-- 3. user_roles
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  unique(user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

drop policy if exists "user_roles_self_select" on public.user_roles;
create policy "user_roles_self_select"
  on public.user_roles for select
  to authenticated
  using (user_id = auth.uid());

-- 4. has_role helper (SECURITY DEFINER — avoids RLS recursion)
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

-- 5. admin-only management policies
drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all"
  on public.profiles for all
  to authenticated
  using (public.has_role(auth.uid(),'admin'))
  with check (public.has_role(auth.uid(),'admin'));

drop policy if exists "user_roles_admin_all" on public.user_roles;
create policy "user_roles_admin_all"
  on public.user_roles for all
  to authenticated
  using (public.has_role(auth.uid(),'admin'))
  with check (public.has_role(auth.uid(),'admin'));

-- 6. auto-create profile when a user is created in auth.users
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
