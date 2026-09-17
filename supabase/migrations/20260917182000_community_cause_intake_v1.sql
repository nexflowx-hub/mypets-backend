-- MyPets Community Cause Intake V1
-- Low-friction public presence is separated from verified financial fundraising.

alter table public.causes
  add column if not exists cause_type text,
  add column if not exists region text,
  add column if not exists verification_status text not null default 'UNVERIFIED',
  add column if not exists fundraising_status text not null default 'DISABLED',
  add column if not exists intake_source text not null default 'PLATFORM';

do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.causes'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%country%'
  loop
    execute format('alter table public.causes drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.causes
  add constraint causes_country_iso2_check check (country ~ '^[A-Z]{2}$');

alter table public.causes drop constraint if exists causes_beneficiary_kind_check;
alter table public.causes drop constraint if exists causes_beneficiary_binding_check;

alter table public.causes
  add constraint causes_beneficiary_kind_check
    check (beneficiary_kind in ('PROTECTOR','MYPETS','COMMUNITY')),
  add constraint causes_beneficiary_binding_check
    check (
      (beneficiary_kind = 'PROTECTOR' and protector_id is not null and fund_code is null)
      or (beneficiary_kind = 'MYPETS' and protector_id is null and fund_code is not null)
      or (beneficiary_kind = 'COMMUNITY' and protector_id is null and fund_code is null)
    );

alter table public.causes
  drop constraint if exists causes_verification_status_check,
  drop constraint if exists causes_fundraising_status_check,
  drop constraint if exists causes_intake_source_check,
  drop constraint if exists causes_type_check,
  drop constraint if exists causes_fundraising_gate_check,
  drop constraint if exists causes_community_gate_check;

alter table public.causes
  add constraint causes_verification_status_check
    check (verification_status in ('UNVERIFIED','OWNER_LINKED','REVIEWING','VERIFIED','PLATFORM','REJECTED')),
  add constraint causes_fundraising_status_check
    check (fundraising_status in ('DISABLED','REVIEW_REQUIRED','ENABLED','SUSPENDED')),
  add constraint causes_intake_source_check
    check (intake_source in ('PLATFORM','SELF_SERVICE','ADMIN','DISCOVERY')),
  add constraint causes_type_check
    check (cause_type is null or cause_type in ('VET_HELP','RESCUE','SHELTER','FEEDING','ADOPTION','EMERGENCY','NGO_PROJECT','OTHER'));

update public.causes
set verification_status = case
      when beneficiary_kind = 'MYPETS' then 'PLATFORM'
      when beneficiary_kind = 'PROTECTOR' then 'OWNER_LINKED'
      else verification_status
    end,
    fundraising_status = case
      when support_mode <> 'NON_FINANCIAL' and currency is not null then 'ENABLED'
      else 'DISABLED'
    end
where intake_source = 'PLATFORM';

-- Hard database gates: an active financial cause must explicitly be enabled, and
-- COMMUNITY records can never collect money until promoted to a verified owner.
alter table public.causes
  add constraint causes_fundraising_gate_check
    check (status = 'DRAFT' or support_mode = 'NON_FINANCIAL' or fundraising_status = 'ENABLED'),
  add constraint causes_community_gate_check
    check (
      beneficiary_kind <> 'COMMUNITY'
      or (support_mode = 'NON_FINANCIAL' and fundraising_status = 'DISABLED' and currency is null and target_amount_cents is null)
    );

create index if not exists causes_verification_idx
  on public.causes(verification_status, fundraising_status, published_at desc);
create index if not exists causes_type_location_idx
  on public.causes(cause_type, country, region, status);

create table if not exists public.cause_intake_submissions (
  id                       uuid primary key default gen_random_uuid(),
  cause_id                 uuid not null unique references public.causes(id) on delete cascade,
  contact_name             text not null,
  contact_email            text,
  whatsapp                 text not null,
  public_whatsapp          boolean not null default false,
  country                  text not null check (country ~ '^[A-Z]{2}$'),
  region                   text not null,
  city                     text,
  cause_type               text not null check (cause_type in ('VET_HELP','RESCUE','SHELTER','FEEDING','ADOPTION','EMERGENCY','NGO_PROJECT','OTHER')),
  instagram_url            text,
  facebook_url             text,
  tiktok_url               text,
  media_links              jsonb not null default '[]'::jsonb,
  source                   text,
  medium                   text,
  campaign                 text,
  content                  text,
  landing_path             text,
  contact_consent          boolean not null,
  publication_consent      boolean not null,
  accuracy_confirmed       boolean not null,
  marketing_consent        boolean not null default false,
  status                   text not null default 'PUBLISHED_UNVERIFIED'
                           check (status in ('PUBLISHED_UNVERIFIED','UNDER_REVIEW','VERIFICATION_REQUESTED','VERIFIED','HIDDEN','REJECTED')),
  verification_requested_at timestamptz,
  verified_at              timestamptz,
  review_notes_private     text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (contact_consent = true),
  check (publication_consent = true),
  check (accuracy_confirmed = true),
  check (contact_email is not null or whatsapp <> '')
);
create index if not exists cause_intake_status_idx
  on public.cause_intake_submissions(status, created_at desc);
create index if not exists cause_intake_contact_idx
  on public.cause_intake_submissions(whatsapp, created_at desc);

create table if not exists public.cause_promotion_queue (
  id                 uuid primary key default gen_random_uuid(),
  cause_id           uuid not null references public.causes(id) on delete cascade,
  channels           jsonb not null default '["INSTAGRAM","FACEBOOK","TIKTOK"]'::jsonb,
  suggested_caption  text,
  status              text not null default 'QUEUED'
                      check (status in ('QUEUED','DRAFTED','APPROVED','PUBLISHED','FAILED','CANCELLED')),
  scheduled_at        timestamptz,
  published_at        timestamptz,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (cause_id)
);
create index if not exists cause_promotion_status_idx
  on public.cause_promotion_queue(status, created_at desc);

alter table public.cause_intake_submissions enable row level security;
alter table public.cause_promotion_queue enable row level security;
revoke all on public.cause_intake_submissions from anon, authenticated;
revoke all on public.cause_promotion_queue from anon, authenticated;

comment on table public.cause_intake_submissions is 'Private contact and consent record for low-friction community cause submissions.';
comment on column public.causes.verification_status is 'Public trust state. UNVERIFIED does not imply MyPets endorsement.';
comment on column public.causes.fundraising_status is 'Server-side financial gate. COMMUNITY intake starts DISABLED.';
comment on table public.cause_promotion_queue is 'Editorial/social promotion queue; QUEUED does not mean content was published.';