-- MyPets Admin + Claim Center v1
-- Separates human administration from crawler ingest and makes claim invitations time-bound.

create table if not exists public.admin_users (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  role        text not null default 'REVIEWER' check (role in ('SUPERADMIN','REVIEWER','OUTREACH')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.claim_invites (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references public.discovery_candidates(id) on delete cascade,
  token_hash         text not null unique,
  contact_email      text,
  expires_at         timestamptz not null,
  used_at            timestamptz,
  revoked_at         timestamptz,
  created_by_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at         timestamptz not null default now(),
  metadata           jsonb not null default '{}'::jsonb
);
create index if not exists claim_invites_candidate_idx on public.claim_invites(candidate_id, created_at desc);
create index if not exists claim_invites_expiry_idx on public.claim_invites(expires_at) where used_at is null and revoked_at is null;

alter table public.discovery_candidates
  add column if not exists review_notes text,
  add column if not exists lead_score integer not null default 0,
  add column if not exists reviewed_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists invited_at timestamptz,
  add column if not exists verified_at timestamptz;

alter table public.admin_users enable row level security;
alter table public.claim_invites enable row level security;

revoke all on public.admin_users from anon, authenticated;
revoke all on public.claim_invites from anon, authenticated;
