-- MyPets Growth v1
-- Privacy-conscious first-party acquisition: campaigns, leads, attribution and share links.

create table if not exists public.growth_campaigns (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  intent          text not null check (intent in ('SUPPORT','VOLUNTEER','SPONSOR','DONATE','PROTECTOR','ADOPT','PROJECT','FOUND_ANIMAL')),
  headline        text not null,
  subheadline     text,
  cta_label       text not null default 'Quero participar',
  country         text check (country in ('PT','BR')),
  status          text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','ARCHIVED')),
  landing_variant text not null default 'A',
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists growth_campaigns_intent_idx on public.growth_campaigns(intent, status);

create table if not exists public.growth_leads (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid references public.growth_campaigns(id) on delete set null,
  user_id           uuid references public.profiles(id) on delete set null,
  intent            text not null check (intent in ('SUPPORT','VOLUNTEER','SPONSOR','DONATE','PROTECTOR','ADOPT','PROJECT','FOUND_ANIMAL')),
  name              text,
  email             text,
  phone             text,
  country           text check (country in ('PT','BR')),
  city              text,
  message           text,
  source            text,
  medium            text,
  campaign          text,
  content           text,
  term              text,
  ref_code          text,
  landing_path      text,
  contact_consent   boolean not null default false,
  marketing_consent boolean not null default false,
  status            text not null default 'NEW' check (status in ('NEW','QUALIFIED','CONTACTED','CONVERTED','DISQUALIFIED')),
  score             integer not null default 0 check (score between 0 and 100),
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (email is not null or phone is not null)
);
create index if not exists growth_leads_created_idx on public.growth_leads(created_at desc);
create index if not exists growth_leads_intent_status_idx on public.growth_leads(intent, status, created_at desc);
create index if not exists growth_leads_campaign_idx on public.growth_leads(campaign_id, created_at desc);
create index if not exists growth_leads_email_idx on public.growth_leads(lower(email)) where email is not null;

create table if not exists public.growth_events (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid references public.growth_campaigns(id) on delete set null,
  lead_id      uuid references public.growth_leads(id) on delete set null,
  user_id      uuid references public.profiles(id) on delete set null,
  event_name   text not null check (event_name in (
    'LANDING_VIEW','LEAD_CREATED','SIGNUP_STARTED','SIGNUP_COMPLETED',
    'ROLE_SELECTED','PROTECTOR_CREATED','PET_CREATED','SUPPORT_STARTED',
    'SPONSORSHIP_STARTED','DONATION_STARTED','DONATION_COMPLETED','SHARE_CLICK'
  )),
  source       text,
  medium       text,
  campaign     text,
  content      text,
  landing_path text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists growth_events_name_created_idx on public.growth_events(event_name, created_at desc);
create index if not exists growth_events_campaign_idx on public.growth_events(campaign_id, created_at desc);
create index if not exists growth_events_lead_idx on public.growth_events(lead_id, created_at desc);

create table if not exists public.share_links (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  destination_path text not null,
  campaign_id      uuid references public.growth_campaigns(id) on delete set null,
  owner_user_id    uuid references public.profiles(id) on delete set null,
  source           text,
  medium           text,
  campaign         text,
  content          text,
  clicks           integer not null default 0 check (clicks >= 0),
  active           boolean not null default true,
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists share_links_owner_idx on public.share_links(owner_user_id, created_at desc);
create index if not exists share_links_campaign_idx on public.share_links(campaign_id, created_at desc);

alter table public.growth_campaigns enable row level security;
alter table public.growth_leads enable row level security;
alter table public.growth_events enable row level security;
alter table public.share_links enable row level security;

-- Browser-facing business access is always through the MyPets API.
revoke all on public.growth_campaigns from anon, authenticated;
revoke all on public.growth_leads from anon, authenticated;
revoke all on public.growth_events from anon, authenticated;
revoke all on public.share_links from anon, authenticated;

insert into public.growth_campaigns (slug, name, intent, headline, subheadline, cta_label)
values
  ('ajudar', 'Quero ajudar', 'SUPPORT', 'Há muitas formas de mudar uma vida.', 'Descubra onde o seu tempo, voz ou apoio pode fazer mais diferença.', 'Quero ajudar'),
  ('voluntario', 'Voluntariado MyPets', 'VOLUNTEER', 'O seu tempo pode salvar uma vida.', 'Diga-nos onde está e como pode ajudar. Ligamos disponibilidade a necessidades reais.', 'Quero ser voluntário'),
  ('padrinho', 'Padrinhos MyPets', 'SPONSOR', 'Não ajude apenas uma vez. Acompanhe uma história.', 'Torne-se padrinho ou madrinha de um animal ou causa e acompanhe a evolução.', 'Quero apadrinhar'),
  ('doador', 'Apoiar causas', 'DONATE', 'Transforme intenção em impacto concreto.', 'Escolha causas verificadas e acompanhe o destino do seu apoio quando os pagamentos estiverem ativos.', 'Quero apoiar'),
  ('protetor', 'Eu ajudo animais', 'PROTECTOR', 'Quem ajuda animais também merece ajuda.', 'Crie a sua presença MyPets, registe animais e apresente necessidades concretas.', 'Quero criar o meu perfil'),
  ('adotar', 'Adoção responsável', 'ADOPT', 'Talvez a próxima história comece consigo.', 'Registe o seu interesse e receba oportunidades de adoção compatíveis.', 'Quero adotar'),
  ('projeto', 'Trazer um projeto para o MyPets', 'PROJECT', 'Tem um projeto, associação ou causa animal?', 'Conte-nos o que faz. Queremos conhecer iniciativas com impacto real e potencial de parceria.', 'Quero apresentar um projeto'),
  ('encontrei-um-animal', 'Encontrei um animal', 'FOUND_ANIMAL', 'Encontrou um animal que precisa de ajuda?', 'Deixe um contacto e a localização aproximada para orientarmos o próximo passo.', 'Preciso de orientação')
on conflict (slug) do update set
  name = excluded.name,
  intent = excluded.intent,
  headline = excluded.headline,
  subheadline = excluded.subheadline,
  cta_label = excluded.cta_label,
  updated_at = now();
