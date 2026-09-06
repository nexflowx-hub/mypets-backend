-- MyPets Payments v1 — provider-neutral checkout orchestration.
-- XPAYMENTS is the first provider, but no secret/API key is persisted in MyPets PostgreSQL.

create table if not exists public.payment_intents (
  id                    uuid primary key default gen_random_uuid(),
  cause_id              uuid references public.causes(id) on delete set null,
  need_id               uuid references public.needs(id) on delete set null,
  pet_id                uuid references public.pets(id) on delete set null,
  protector_id          uuid references public.protectors(id) on delete set null,
  user_id               uuid references public.profiles(id) on delete set null,
  provider              text not null default 'XPAYMENTS',
  provider_store_code   text,
  provider_session_id   text unique,
  provider_reference    text not null unique,
  checkout_url          text,
  amount_cents          integer not null check (amount_cents >= 100),
  currency              text not null check (currency in ('EUR','BRL')),
  frequency             text not null default 'ONE_TIME' check (frequency in ('ONE_TIME','MONTHLY')),
  donor_name            text,
  donor_email           text,
  status                text not null default 'CREATED' check (status in ('CREATED','PENDING','PROCESSING','SUCCEEDED','FAILED','CANCELLED','EXPIRED')),
  idempotency_key       text not null unique,
  source                text,
  medium                text,
  campaign              text,
  content               text,
  ref_code              text,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  succeeded_at          timestamptz,
  check (
    (cause_id is not null)::int +
    (need_id is not null)::int +
    (pet_id is not null)::int +
    (protector_id is not null)::int >= 1
  )
);

create index if not exists payment_intents_cause_idx on public.payment_intents(cause_id, status, created_at desc);
create index if not exists payment_intents_user_idx on public.payment_intents(user_id, created_at desc);
create index if not exists payment_intents_provider_session_idx on public.payment_intents(provider, provider_session_id) where provider_session_id is not null;
create index if not exists payment_intents_status_idx on public.payment_intents(status, created_at desc);

create table if not exists public.payment_provider_events (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null,
  provider_event_id   text,
  provider_session_id text,
  event_type          text not null,
  signature_valid     boolean,
  payload             jsonb not null default '{}'::jsonb,
  processing_status   text not null default 'RECEIVED' check (processing_status in ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  processing_error    text,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz
);
create unique index if not exists payment_provider_events_dedupe_idx
  on public.payment_provider_events(provider, provider_event_id)
  where provider_event_id is not null;
create index if not exists payment_provider_events_session_idx
  on public.payment_provider_events(provider, provider_session_id, received_at desc)
  where provider_session_id is not null;

alter table public.payment_intents enable row level security;
alter table public.payment_provider_events enable row level security;

-- Payment business data is API-only. Browser access to application tables is never direct.
revoke all on public.payment_intents from anon, authenticated;
revoke all on public.payment_provider_events from anon, authenticated;
