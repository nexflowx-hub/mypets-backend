-- MyPets Payments v2 — authoritative XPAYMENTS transaction correlation.
-- Additive only. Keeps provider secrets outside MyPets PostgreSQL.

alter table public.payment_intents
  add column if not exists provider_transaction_id text,
  add column if not exists payment_method text;

create unique index if not exists payment_intents_provider_transaction_unique
  on public.payment_intents(provider, provider_transaction_id)
  where provider_transaction_id is not null;

create index if not exists payment_intents_provider_reference_idx
  on public.payment_intents(provider, provider_reference)
  where provider_reference is not null;

comment on column public.payment_intents.provider_transaction_id is
  'Authoritative XPAYMENTS transaction_id used for signed webhook correlation when available.';
comment on column public.payment_intents.payment_method is
  'Normalized selected payment method, e.g. pix, mb_way, multibanco, bizum or checkout.';
