-- MyPets core platform v1
-- Auth stays in Supabase Auth. Business data is server/API owned.

create schema if not exists mypets_private;
revoke all on schema mypets_private from public;

create sequence if not exists mypets_private.facepets_pt_seq start with 1 increment by 1;
create sequence if not exists mypets_private.facepets_br_seq start with 1 increment by 1;
revoke all on all sequences in schema mypets_private from public, anon, authenticated;

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  locale        text not null default 'pt-PT' check (locale in ('pt-PT','pt-BR','en')),
  country       text check (country in ('PT','BR')),
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.protectors (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references public.profiles(id) on delete cascade,
  slug             text not null unique,
  display_name     text not null,
  country          text not null check (country in ('PT','BR')),
  city             text not null,
  region           text,
  bio              text,
  years_active     integer not null default 0 check (years_active between 0 and 100),
  animals_current  integer not null default 0 check (animals_current >= 0),
  activity_types   jsonb not null default '[]'::jsonb,
  social_links     jsonb not null default '{}'::jsonb,
  verification     text not null default 'NEW' check (verification in ('NEW','IDENTITY_VERIFIED','VERIFIED','MYPETS_VERIFIED')),
  status           text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','SUSPENDED')),
  is_public        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists protectors_country_city_idx on public.protectors(country, city);
create index if not exists protectors_status_idx on public.protectors(status, is_public);

create table if not exists public.protector_verifications (
  id            uuid primary key default gen_random_uuid(),
  protector_id  uuid not null references public.protectors(id) on delete cascade,
  level         text not null check (level in ('IDENTITY','ACTIVITY','MYPETS')),
  status        text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  notes_private text,
  evidence      jsonb not null default '{}'::jsonb,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (protector_id, level)
);
create index if not exists protector_verifications_status_idx on public.protector_verifications(status);

create table if not exists public.pets (
  id            uuid primary key default gen_random_uuid(),
  facepets_id   text not null unique,
  protector_id  uuid not null references public.protectors(id) on delete cascade,
  slug          text not null unique,
  name          text not null,
  species       text not null check (species in ('DOG','CAT','OTHER')),
  sex           text not null default 'UNKNOWN' check (sex in ('MALE','FEMALE','UNKNOWN')),
  country       text not null check (country in ('PT','BR')),
  city          text,
  rescue_date   date,
  status        text not null default 'RESCUED' check (status in ('RESCUED','TREATMENT','RECOVERED','ADOPTABLE','ADOPTED')),
  story         text,
  primary_image text,
  is_public     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pets_protector_idx on public.pets(protector_id);
create index if not exists pets_status_idx on public.pets(status, is_public);
create index if not exists pets_country_idx on public.pets(country);

create table if not exists public.pet_media (
  id            uuid primary key default gen_random_uuid(),
  pet_id        uuid not null references public.pets(id) on delete cascade,
  media_type    text not null default 'IMAGE' check (media_type in ('IMAGE','VIDEO')),
  storage_bucket text,
  storage_path  text,
  external_url  text,
  provenance    text not null default 'REAL_CASE' check (provenance in ('REAL_CASE','AI_GENERATED','LICENSED_STOCK')),
  caption       text,
  sort_order    integer not null default 0,
  is_public     boolean not null default true,
  created_at    timestamptz not null default now(),
  check (storage_path is not null or external_url is not null)
);
create index if not exists pet_media_pet_idx on public.pet_media(pet_id, sort_order);

create table if not exists public.pet_updates (
  id             uuid primary key default gen_random_uuid(),
  pet_id         uuid not null references public.pets(id) on delete cascade,
  author_user_id uuid not null references public.profiles(id) on delete cascade,
  title          text,
  body           text not null,
  status_after   text check (status_after in ('RESCUED','TREATMENT','RECOVERED','ADOPTABLE','ADOPTED')),
  is_public      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists pet_updates_pet_idx on public.pet_updates(pet_id, created_at desc);

create table if not exists public.needs (
  id                  uuid primary key default gen_random_uuid(),
  protector_id        uuid not null references public.protectors(id) on delete cascade,
  pet_id              uuid references public.pets(id) on delete set null,
  type                text not null check (type in ('FOOD','MEDICATION','VET','TRANSPORT','FOSTER','STERILIZATION','SUPPLIES','ADOPTION','VOLUNTEER','OTHER')),
  title               text not null,
  description         text,
  support_mode        text not null default 'BOTH' check (support_mode in ('FINANCIAL','NON_FINANCIAL','BOTH')),
  target_amount_cents integer check (target_amount_cents is null or target_amount_cents >= 100),
  raised_amount_cents integer not null default 0 check (raised_amount_cents >= 0),
  currency            text check (currency in ('EUR','BRL')),
  status              text not null default 'OPEN' check (status in ('OPEN','FUNDED','RESOLVED','CANCELLED')),
  is_public           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (
    support_mode = 'NON_FINANCIAL'
    or (target_amount_cents is not null and currency is not null)
  )
);
create index if not exists needs_protector_idx on public.needs(protector_id, status);
create index if not exists needs_pet_idx on public.needs(pet_id);
create index if not exists needs_status_type_idx on public.needs(status, type, is_public);

create table if not exists public.support_offers (
  id          uuid primary key default gen_random_uuid(),
  need_id     uuid not null references public.needs(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('FOOD','MEDICATION','VET','TRANSPORT','FOSTER','STERILIZATION','SUPPLIES','ADOPTION','VOLUNTEER','OTHER')),
  message     text,
  status      text not null default 'OFFERED' check (status in ('OFFERED','ACCEPTED','DECLINED','FULFILLED','CANCELLED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists support_offers_need_idx on public.support_offers(need_id, status);
create index if not exists support_offers_user_idx on public.support_offers(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.protectors enable row level security;
alter table public.protector_verifications enable row level security;
alter table public.pets enable row level security;
alter table public.pet_media enable row level security;
alter table public.pet_updates enable row level security;
alter table public.needs enable row level security;
alter table public.support_offers enable row level security;

-- The browser uses Supabase only for Auth. Business tables are API-only.
-- Explicit revokes protect against accidental Data API exposure.
revoke all on public.profiles from anon, authenticated;
revoke all on public.protectors from anon, authenticated;
revoke all on public.protector_verifications from anon, authenticated;
revoke all on public.pets from anon, authenticated;
revoke all on public.pet_media from anon, authenticated;
revoke all on public.pet_updates from anon, authenticated;
revoke all on public.needs from anon, authenticated;
revoke all on public.support_offers from anon, authenticated;
