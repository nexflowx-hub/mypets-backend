-- MyPets identity roles v1
-- A single authenticated account can participate in multiple ways.

create table if not exists public.profile_roles (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('PROTECTOR','VOLUNTEER','DONOR','SPONSOR','ADOPTER','SUPPORTER')),
  created_at  timestamptz not null default now(),
  primary key (user_id, role)
);
create index if not exists profile_roles_role_idx on public.profile_roles(role, created_at desc);

-- Existing protector accounts are already participating as protectors.
insert into public.profile_roles (user_id, role)
select user_id, 'PROTECTOR'
from public.protectors
on conflict (user_id, role) do nothing;

create table if not exists public.volunteer_profiles (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  country         text check (country in ('PT','BR')),
  city            text,
  region          text,
  availability    text,
  participation   jsonb not null default '[]'::jsonb,
  skills          jsonb not null default '[]'::jsonb,
  radius_km       integer check (radius_km is null or radius_km between 0 and 500),
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists volunteer_profiles_location_idx on public.volunteer_profiles(country, city, is_active);

alter table public.profile_roles enable row level security;
alter table public.volunteer_profiles enable row level security;

-- Business data remains API-only. The browser uses Supabase directly only for Auth/Storage.
revoke all on public.profile_roles from anon, authenticated;
revoke all on public.volunteer_profiles from anon, authenticated;
