-- MyPets Causes + Sponsorships v1
-- Public mobilisation is separated from concrete needs and from future payment-provider state.

create table if not exists public.causes (
  id                   uuid primary key default gen_random_uuid(),
  protector_id         uuid not null references public.protectors(id) on delete cascade,
  slug                 text not null unique,
  title                text not null,
  summary              text,
  story                text,
  country              text not null check (country in ('PT','BR')),
  city                 text,
  primary_image        text,
  support_mode         text not null default 'BOTH' check (support_mode in ('FINANCIAL','NON_FINANCIAL','BOTH')),
  target_amount_cents  integer check (target_amount_cents is null or target_amount_cents >= 100),
  raised_amount_cents  integer not null default 0 check (raised_amount_cents >= 0),
  currency             text check (currency in ('EUR','BRL')),
  status               text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','PAUSED','FUNDED','CLOSED')),
  is_public            boolean not null default true,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (
    support_mode = 'NON_FINANCIAL'
    or status = 'DRAFT'
    or (target_amount_cents is not null and currency is not null)
  )
);
create index if not exists causes_public_idx on public.causes(status, is_public, published_at desc);
create index if not exists causes_protector_idx on public.causes(protector_id, created_at desc);
create index if not exists causes_location_idx on public.causes(country, city, status);

create table if not exists public.cause_pets (
  cause_id   uuid not null references public.causes(id) on delete cascade,
  pet_id     uuid not null references public.pets(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (cause_id, pet_id)
);
create index if not exists cause_pets_pet_idx on public.cause_pets(pet_id, cause_id);

create table if not exists public.cause_needs (
  cause_id   uuid not null references public.causes(id) on delete cascade,
  need_id    uuid not null references public.needs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (cause_id, need_id)
);
create index if not exists cause_needs_need_idx on public.cause_needs(need_id, cause_id);

create table if not exists public.cause_updates (
  id             uuid primary key default gen_random_uuid(),
  cause_id       uuid not null references public.causes(id) on delete cascade,
  author_user_id uuid not null references public.profiles(id) on delete cascade,
  title          text,
  body           text not null,
  image_url      text,
  is_public      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists cause_updates_cause_idx on public.cause_updates(cause_id, created_at desc);

create table if not exists public.cause_followers (
  cause_id   uuid not null references public.causes(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (cause_id, user_id)
);
create index if not exists cause_followers_user_idx on public.cause_followers(user_id, created_at desc);

create table if not exists public.sponsorships (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  cause_id                uuid references public.causes(id) on delete cascade,
  pet_id                  uuid references public.pets(id) on delete cascade,
  status                  text not null default 'INTERESTED' check (status in ('INTERESTED','PENDING','ACTIVE','PAUSED','ENDED')),
  is_anonymous            boolean not null default false,
  communication_preferences jsonb not null default '{}'::jsonb,
  payment_subscription_id text,
  started_at              timestamptz,
  ended_at                timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check ((cause_id is not null)::int + (pet_id is not null)::int = 1)
);
create unique index if not exists sponsorships_user_cause_unique on public.sponsorships(user_id, cause_id) where cause_id is not null;
create unique index if not exists sponsorships_user_pet_unique on public.sponsorships(user_id, pet_id) where pet_id is not null;
create index if not exists sponsorships_status_idx on public.sponsorships(status, created_at desc);
create index if not exists sponsorships_cause_idx on public.sponsorships(cause_id, status) where cause_id is not null;
create index if not exists sponsorships_pet_idx on public.sponsorships(pet_id, status) where pet_id is not null;

-- Discovery is intentionally separate from verified MyPets entities.
-- A public URL can be discovered and reviewed before a protector/cause is claimed.
create table if not exists public.discovery_candidates (
  id                   uuid primary key default gen_random_uuid(),
  source_url           text not null unique,
  source_type          text not null check (source_type in ('WEBSITE','DIRECTORY','SOCIAL_LINK','SEARCH_API','MANUAL')),
  title                text,
  summary              text,
  country              text check (country in ('PT','BR')),
  city                 text,
  contact_url          text,
  contact_email        text,
  status               text not null default 'DISCOVERED' check (status in ('DISCOVERED','REVIEWED','CONTACT_PENDING','INVITED','CLAIMED','VERIFIED','REJECTED','DUPLICATE')),
  matched_protector_id uuid references public.protectors(id) on delete set null,
  matched_cause_id     uuid references public.causes(id) on delete set null,
  claimed_by_user_id   uuid references public.profiles(id) on delete set null,
  source_hash          text,
  last_crawled_at      timestamptz,
  discovered_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  metadata             jsonb not null default '{}'::jsonb
);
create index if not exists discovery_candidates_status_idx on public.discovery_candidates(status, discovered_at desc);
create index if not exists discovery_candidates_location_idx on public.discovery_candidates(country, city, status);

create table if not exists public.discovery_evidence (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references public.discovery_candidates(id) on delete cascade,
  source_url    text not null,
  evidence_type text not null check (evidence_type in ('PAGE_METADATA','SOCIAL_LINK','CONTACT','SCREENSHOT_PRIVATE','MANUAL_NOTE')),
  title         text,
  excerpt       text check (excerpt is null or char_length(excerpt) <= 1200),
  snapshot_url  text,
  captured_at   timestamptz not null default now(),
  metadata      jsonb not null default '{}'::jsonb
);
create index if not exists discovery_evidence_candidate_idx on public.discovery_evidence(candidate_id, captured_at desc);

-- Official social identities are attached only to a claimed protector/cause or to a discovery candidate.
create table if not exists public.social_profiles (
  id                    uuid primary key default gen_random_uuid(),
  protector_id          uuid references public.protectors(id) on delete cascade,
  cause_id              uuid references public.causes(id) on delete cascade,
  candidate_id          uuid references public.discovery_candidates(id) on delete cascade,
  platform              text not null check (platform in ('INSTAGRAM','FACEBOOK','TIKTOK','YOUTUBE','THREADS','WEBSITE')),
  profile_url           text not null,
  handle                text,
  display_name          text,
  embed_mode            text not null default 'LINK' check (embed_mode in ('LINK','OEMBED','API')),
  verification_status   text not null default 'UNVERIFIED' check (verification_status in ('UNVERIFIED','SOURCE_MATCHED','OWNER_CONFIRMED','VERIFIED','REJECTED')),
  owner_confirmed       boolean not null default false,
  sync_enabled          boolean not null default false,
  is_public             boolean not null default true,
  created_by_user_id    uuid references public.profiles(id) on delete set null,
  verified_at           timestamptz,
  last_synced_at        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  metadata              jsonb not null default '{}'::jsonb,
  check ((protector_id is not null)::int + (cause_id is not null)::int + (candidate_id is not null)::int = 1)
);
create unique index if not exists social_profiles_protector_unique on public.social_profiles(protector_id, platform, profile_url) where protector_id is not null;
create unique index if not exists social_profiles_cause_unique on public.social_profiles(cause_id, platform, profile_url) where cause_id is not null;
create unique index if not exists social_profiles_candidate_unique on public.social_profiles(candidate_id, platform, profile_url) where candidate_id is not null;
create index if not exists social_profiles_public_idx on public.social_profiles(platform, verification_status, is_public);

create table if not exists public.social_content_items (
  id                   uuid primary key default gen_random_uuid(),
  social_profile_id    uuid not null references public.social_profiles(id) on delete cascade,
  provider_content_id  text,
  canonical_url        text not null,
  content_type         text not null default 'POST' check (content_type in ('POST','REEL','VIDEO','SHORT','PROFILE')),
  caption_excerpt      text check (caption_excerpt is null or char_length(caption_excerpt) <= 800),
  thumbnail_url        text,
  published_at         timestamptz,
  is_featured          boolean not null default false,
  is_public            boolean not null default true,
  last_checked_at      timestamptz,
  created_at           timestamptz not null default now(),
  metadata             jsonb not null default '{}'::jsonb,
  unique (social_profile_id, canonical_url)
);
create index if not exists social_content_profile_idx on public.social_content_items(social_profile_id, is_public, published_at desc);
create index if not exists social_content_featured_idx on public.social_content_items(is_featured, published_at desc) where is_public = true;

create table if not exists public.claim_requests (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references public.discovery_candidates(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  contact_email text,
  proof_url     text,
  message       text,
  status        text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  review_notes  text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists claim_requests_candidate_idx on public.claim_requests(candidate_id, status, created_at desc);
create index if not exists claim_requests_user_idx on public.claim_requests(user_id, status, created_at desc);

alter table public.causes enable row level security;
alter table public.cause_pets enable row level security;
alter table public.cause_needs enable row level security;
alter table public.cause_updates enable row level security;
alter table public.cause_followers enable row level security;
alter table public.sponsorships enable row level security;
alter table public.discovery_candidates enable row level security;
alter table public.discovery_evidence enable row level security;
alter table public.social_profiles enable row level security;
alter table public.social_content_items enable row level security;
alter table public.claim_requests enable row level security;

-- Application data remains API-only. Browser direct Supabase access is Auth/Storage only.
revoke all on public.causes from anon, authenticated;
revoke all on public.cause_pets from anon, authenticated;
revoke all on public.cause_needs from anon, authenticated;
revoke all on public.cause_updates from anon, authenticated;
revoke all on public.cause_followers from anon, authenticated;
revoke all on public.sponsorships from anon, authenticated;
revoke all on public.discovery_candidates from anon, authenticated;
revoke all on public.discovery_evidence from anon, authenticated;
revoke all on public.social_profiles from anon, authenticated;
revoke all on public.social_content_items from anon, authenticated;
revoke all on public.claim_requests from anon, authenticated;
