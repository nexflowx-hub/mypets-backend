-- MyPets Commerce V1
-- Keeps commercial orders/payments strictly separated from support/contribution flows.

create table if not exists public.commerce_markets (
  code text primary key,
  label text not null,
  currency text not null,
  legal_entity_code text not null,
  payment_profile text not null,
  enabled boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_markets_code_check check (code in ('BR','UK','EU')),
  constraint commerce_markets_currency_check check (currency in ('BRL','GBP','EUR')),
  constraint commerce_markets_entity_check check (legal_entity_code in ('MYPETS_BR','HUMAN_IMPACT_UK'))
);

insert into public.commerce_markets (code, label, currency, legal_entity_code, payment_profile, enabled)
values
  ('BR', 'Brasil', 'BRL', 'MYPETS_BR', 'XPAYMENTS_BR', true),
  ('UK', 'United Kingdom', 'GBP', 'HUMAN_IMPACT_UK', 'XPAYMENTS_INTL', false),
  ('EU', 'Europe', 'EUR', 'HUMAN_IMPACT_UK', 'XPAYMENTS_INTL', false)
on conflict (code) do update set
  label = excluded.label,
  currency = excluded.currency,
  legal_entity_code = excluded.legal_entity_code,
  payment_profile = excluded.payment_profile;

create table if not exists public.commerce_products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  category text not null,
  species text not null default 'DOG_CAT',
  brand text not null default 'MyPets',
  status text not null default 'DRAFT',
  is_physical boolean not null default true,
  tax_class text,
  media jsonb not null default '[]'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_products_status_check check (status in ('DRAFT','ACTIVE','ARCHIVED'))
);

create table if not exists public.commerce_product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  sku text not null unique,
  name text not null,
  barcode text,
  weight_grams integer,
  dimensions jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.commerce_product_offers (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.commerce_product_variants(id) on delete cascade,
  market_code text not null references public.commerce_markets(code) on delete restrict,
  currency text not null,
  price_cents integer not null,
  compare_at_cents integer,
  active boolean not null default false,
  available_from timestamptz,
  available_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_product_offers_price_check check (price_cents >= 0),
  constraint commerce_product_offers_compare_check check (compare_at_cents is null or compare_at_cents >= price_cents),
  unique (variant_id, market_code)
);

create table if not exists public.commerce_inventory_locations (
  id uuid primary key default gen_random_uuid(),
  market_code text not null references public.commerce_markets(code) on delete restrict,
  name text not null,
  country_code text not null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.commerce_inventory (
  variant_id uuid not null references public.commerce_product_variants(id) on delete cascade,
  location_id uuid not null references public.commerce_inventory_locations(id) on delete cascade,
  on_hand integer not null default 0,
  reserved integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (variant_id, location_id),
  constraint commerce_inventory_nonnegative_check check (on_hand >= 0 and reserved >= 0 and reserved <= on_hand)
);

create table if not exists public.commerce_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  user_id uuid,
  market_code text not null references public.commerce_markets(code) on delete restrict,
  legal_entity_code text not null,
  seller_label text not null,
  currency text not null,
  status text not null default 'PENDING',
  payment_status text not null default 'UNPAID',
  fulfillment_status text not null default 'UNFULFILLED',
  customer_email text not null,
  customer_name text,
  customer_document text,
  subtotal_cents integer not null,
  shipping_cents integer not null default 0,
  discount_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null,
  shipping_address jsonb not null,
  billing_address jsonb,
  shipping_method text,
  terms_version text not null,
  privacy_version text not null,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_orders_status_check check (status in ('PENDING','CONFIRMED','CANCELLED','COMPLETED')),
  constraint commerce_orders_payment_check check (payment_status in ('UNPAID','PENDING','PAID','PARTIALLY_REFUNDED','REFUNDED','FAILED')),
  constraint commerce_orders_fulfillment_check check (fulfillment_status in ('UNFULFILLED','PROCESSING','SHIPPED','DELIVERED','RETURNED','CANCELLED')),
  constraint commerce_orders_amounts_check check (subtotal_cents >= 0 and shipping_cents >= 0 and discount_cents >= 0 and tax_cents >= 0 and total_cents >= 0)
);

create table if not exists public.commerce_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  product_id uuid references public.commerce_products(id) on delete set null,
  variant_id uuid references public.commerce_product_variants(id) on delete set null,
  sku text not null,
  product_name text not null,
  variant_name text,
  quantity integer not null,
  unit_price_cents integer not null,
  total_cents integer not null,
  metadata jsonb not null default '{}'::jsonb,
  constraint commerce_order_items_quantity_check check (quantity > 0),
  constraint commerce_order_items_amount_check check (unit_price_cents >= 0 and total_cents >= 0)
);

create table if not exists public.commerce_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  provider text not null,
  provider_ref text,
  payment_method text not null,
  currency text not null,
  amount_cents integer not null,
  status text not null default 'PENDING',
  idempotency_key text not null unique,
  provider_payload jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_payments_status_check check (status in ('PENDING','REQUIRES_ACTION','AUTHORIZED','SUCCEEDED','FAILED','CANCELLED','REFUNDED')),
  constraint commerce_payments_amount_check check (amount_cents >= 0)
);

create unique index if not exists commerce_payments_provider_ref_unique
  on public.commerce_payments(provider, provider_ref)
  where provider_ref is not null;

create table if not exists public.commerce_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  payment_id uuid not null references public.commerce_payments(id) on delete restrict,
  provider_ref text,
  amount_cents integer not null,
  reason text,
  status text not null default 'PENDING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_refunds_status_check check (status in ('PENDING','SUCCEEDED','FAILED','CANCELLED')),
  constraint commerce_refunds_amount_check check (amount_cents > 0)
);

create index if not exists commerce_products_status_idx on public.commerce_products(status, category);
create index if not exists commerce_variants_product_idx on public.commerce_product_variants(product_id, active);
create index if not exists commerce_offers_market_idx on public.commerce_product_offers(market_code, active);
create index if not exists commerce_orders_market_created_idx on public.commerce_orders(market_code, created_at desc);
create index if not exists commerce_orders_email_idx on public.commerce_orders(customer_email, created_at desc);
create index if not exists commerce_payments_order_idx on public.commerce_payments(order_id, created_at desc);
create index if not exists commerce_refunds_order_idx on public.commerce_refunds(order_id, created_at desc);

comment on table public.commerce_orders is 'Commercial orders only. Never use for MyPets support/contribution flows.';
comment on column public.commerce_orders.legal_entity_code is 'Immutable seller snapshot routing the order to the correct legal operator.';
comment on column public.commerce_orders.seller_label is 'Human-readable seller shown/accepted at checkout and retained on the order.';
comment on table public.commerce_payments is 'Commercial payment ledger separated from support/contribution payments.';
