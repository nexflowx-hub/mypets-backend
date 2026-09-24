-- Preserve the actual acquisition landing on server-side donation events.
-- Existing payment intents continue to fall back to the cause URL.

create or replace function public.track_payment_intent_growth_event()
returns trigger
language plpgsql
as $$
declare
  event_to_insert text;
  cause_slug text;
  attributed_landing_path text;
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
  attributed_landing_path := nullif(new.metadata->>'landingPath', '');

  insert into public.growth_events (
    user_id, event_name, source, medium, campaign, content, landing_path, metadata
  ) values (
    new.user_id,
    event_to_insert,
    new.source,
    new.medium,
    new.campaign,
    new.content,
    coalesce(
      attributed_landing_path,
      case when cause_slug is null then null else '/causas/' || cause_slug end
    ),
    jsonb_build_object(
      'paymentIntentId', new.id,
      'causeId', new.cause_id,
      'amountCents', new.amount_cents,
      'currency', new.currency,
      'refCode', new.ref_code,
      'provider', new.provider,
      'status', new.status,
      'landingPath', attributed_landing_path
    )
  );

  return new;
end;
$$;

comment on function public.track_payment_intent_growth_event() is
  'Emits server-trusted donation funnel events while preserving the original acquisition landing when supplied in payment metadata.';
