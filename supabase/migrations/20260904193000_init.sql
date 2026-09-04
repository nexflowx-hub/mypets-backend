-- MyPets public slice — canonical Supabase PostgreSQL baseline.
create extension if not exists "pgcrypto";

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(), slug text not null unique,
  kind text not null check (kind in ('PROTECTOR','ANIMAL','CAMPAIGN','NETWORK')),
  name text not null, location text, country text not null check (country in ('PT','BR')),
  currency text not null check (currency in ('EUR','BRL')),
  desc_pt_pt text not null, desc_pt_br text not null, desc_en text not null,
  image text not null, image_alt text not null, tags jsonb not null default '[]'::jsonb,
  target_cents integer not null check (target_cents >= 0), raised_cents integer not null default 0 check (raised_cents >= 0),
  is_demo boolean not null default true, active boolean not null default true, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.impact_metrics (
  id uuid primary key default gen_random_uuid(), key text not null unique, value double precision not null default 0,
  prefix text, suffix text, decimals integer not null default 0,
  label_pt_pt text not null, label_pt_br text not null, label_en text not null,
  icon text not null, color text not null, is_demo boolean not null default true, sort_order integer not null default 0
);

create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(), email text not null unique,
  locale text not null default 'pt-PT', consent boolean not null default false,
  is_demo boolean not null default false, created_at timestamptz not null default now()
);

create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(), story_id uuid references public.stories(id) on delete set null,
  target_type text not null check (target_type in ('ANIMAL','PROTECTOR','NETWORK','GUARDIANS')),
  target_label text not null, amount_cents integer not null check (amount_cents >= 100),
  currency text not null check (currency in ('EUR','BRL')), frequency text not null check (frequency in ('ONE_TIME','MONTHLY')),
  donor_name text, donor_email text, provider text not null default 'mock', provider_ref text,
  status text not null default 'PENDING' check (status in ('PENDING','PAID','FAILED','REFUNDED')),
  idempotency_key text not null unique, is_demo boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists contributions_story_idx on public.contributions(story_id);
create index if not exists contributions_status_idx on public.contributions(status);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(), reason text not null check (char_length(reason) between 3 and 500),
  entity_url text, email text, status text not null default 'OPEN' check (status in ('OPEN','TRIAGED','RESOLVED','DISMISSED')),
  created_at timestamptz not null default now()
);

create table if not exists public.content_blocks (
  id uuid primary key default gen_random_uuid(), key text not null unique, value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.stories enable row level security;
alter table public.impact_metrics enable row level security;
alter table public.newsletter_subscribers enable row level security;
alter table public.contributions enable row level security;
alter table public.reports enable row level security;
alter table public.content_blocks enable row level security;

create policy stories_public_read on public.stories for select using (active = true);
create policy impact_public_read on public.impact_metrics for select using (true);
create policy content_public_read on public.content_blocks for select using (key = 'legal.entity');
