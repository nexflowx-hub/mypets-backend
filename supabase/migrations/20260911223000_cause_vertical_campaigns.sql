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
