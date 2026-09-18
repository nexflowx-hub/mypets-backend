-- MyPets Internal Alerts + Telegram Outbox V1
-- Internal event/ticket log with resilient Telegram delivery.
-- Business flows must never depend on Telegram availability.

create table if not exists public.internal_alerts (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  category text not null,
  severity text not null default 'NOTICE',
  title text not null,
  summary text,
  entity_type text,
  entity_id text,
  public_url text,
  admin_url text,
  ticket_status text not null default 'LOGGED',
  action_required boolean not null default false,
  dedupe_key text,
  metadata jsonb not null default '{}'::jsonb,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint internal_alerts_event_type_len check (char_length(event_type) between 2 and 120),
  constraint internal_alerts_category_check check (category in ('PAYMENT','CAUSE','SUPPORT','MESSAGE','LEAD','REPORT','SYSTEM')),
  constraint internal_alerts_severity_check check (severity in ('INFO','NOTICE','WARNING','CRITICAL')),
  constraint internal_alerts_ticket_status_check check (ticket_status in ('LOGGED','OPEN','ACKNOWLEDGED','RESOLVED','IGNORED'))
);

create unique index if not exists internal_alerts_dedupe_key_unique
  on public.internal_alerts (dedupe_key)
  where dedupe_key is not null;

create index if not exists internal_alerts_created_idx
  on public.internal_alerts (created_at desc);

create index if not exists internal_alerts_open_idx
  on public.internal_alerts (ticket_status, created_at desc)
  where ticket_status in ('OPEN','ACKNOWLEDGED');

create index if not exists internal_alerts_event_type_idx
  on public.internal_alerts (event_type, created_at desc);

create table if not exists public.internal_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.internal_alerts(id) on delete cascade,
  channel text not null,
  status text not null default 'PENDING',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint internal_alert_deliveries_channel_check check (channel in ('TELEGRAM')),
  constraint internal_alert_deliveries_status_check check (status in ('PENDING','SENDING','SENT','FAILED','CANCELLED')),
  constraint internal_alert_deliveries_attempt_count_check check (attempt_count >= 0)
);

create unique index if not exists internal_alert_deliveries_alert_channel_unique
  on public.internal_alert_deliveries (alert_id, channel);

create index if not exists internal_alert_deliveries_dispatch_idx
  on public.internal_alert_deliveries (status, next_attempt_at, created_at)
  where status in ('PENDING','FAILED');

alter table public.internal_alerts enable row level security;
alter table public.internal_alert_deliveries enable row level security;

-- These are internal operational tables. Keep them unavailable to browser roles.
revoke all privileges on table public.internal_alerts from anon, authenticated;
revoke all privileges on table public.internal_alert_deliveries from anon, authenticated;

-- Server-side service_role may be used by internal tooling in Supabase.
-- CI also validates migrations against plain PostgreSQL, where this role is absent.
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on table public.internal_alerts to service_role;
    grant select, insert, update, delete on table public.internal_alert_deliveries to service_role;
  end if;
end
$grant$;

comment on table public.internal_alerts is
  'MyPets internal operational event/ticket log. Not exposed to anon/authenticated roles.';

comment on table public.internal_alert_deliveries is
  'Reliable outbox for internal notification channels such as Telegram.';
