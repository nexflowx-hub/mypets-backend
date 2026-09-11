-- MyPets cause verticals + campaign metadata
-- Additive classification for marketing/traffic funnels. Does not change payment finality or Need/Cause boundaries.

alter table public.causes
  add column if not exists vertical text not null default 'GENERAL',
  add column if not exists campaign_key text,
  add column if not exists campaign_meta jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'causes_vertical_check'
      and conrelid = 'public.causes'::regclass
  ) then
    alter table public.causes
      add constraint causes_vertical_check
      check (vertical in ('GENERAL','FOOD','VET','RESCUE','SHELTER','EMERGENCY'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'causes_campaign_key_check'
      and conrelid = 'public.causes'::regclass
  ) then
    alter table public.causes
      add constraint causes_campaign_key_check
      check (campaign_key is null or campaign_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$');
  end if;
end $$;

create index if not exists causes_vertical_public_idx
  on public.causes(vertical, status, is_public, published_at desc);

create unique index if not exists causes_campaign_key_unique
  on public.causes(campaign_key)
  where campaign_key is not null;

comment on column public.causes.vertical is
  'Marketing/impact vertical: GENERAL, FOOD, VET, RESCUE, SHELTER or EMERGENCY.';
comment on column public.causes.campaign_key is
  'Stable campaign identifier used for attribution and dedicated landing aliases.';
comment on column public.causes.campaign_meta is
  'Public-safe presentation metadata for the campaign landing. Never stores payment secrets or private evidence.';

-- First-party funnel analytics are derived from server-side payment intent state.
-- A browser callback never creates DONATION_COMPLETED. The event is emitted only
-- when the verified backend state transitions to SUCCEEDED.
create or replace function public.track_payment_intent_growth_event()
returns trigger
language plpgsql
as $$
declare
  event_to_insert text;
  cause_slug text;
begin
  if new.cause_id is null or old.status is not distinct from new.status then
    return new;
  end if;

  if new.status = 'PENDING' and old.status = 'CREATED' then
    event_to_insert := 'DONATION_STARTED';
  elsif new.status = 'SUCCEEDED' and old.status <> 'SUCCEEDED' then
    event_to_insert := 'DONATION_COMPLETED';
  else
    return new;
  end if;

  select slug into cause_slug from public.causes where id = new.cause_id;

  insert into public.growth_events (
    user_id, event_name, source, medium, campaign, content, landing_path, metadata
  ) values (
    new.user_id,
    event_to_insert,
    new.source,
    new.medium,
    new.campaign,
    new.content,
    case when cause_slug is null then null else '/causas/' || cause_slug end,
    jsonb_build_object(
      'paymentIntentId', new.id,
      'causeId', new.cause_id,
      'amountCents', new.amount_cents,
      'currency', new.currency,
      'refCode', new.ref_code,
      'provider', new.provider,
      'status', new.status
    )
  );

  return new;
end;
$$;

drop trigger if exists payment_intents_growth_events on public.payment_intents;
create trigger payment_intents_growth_events
after update of status on public.payment_intents
for each row execute function public.track_payment_intent_growth_event();
