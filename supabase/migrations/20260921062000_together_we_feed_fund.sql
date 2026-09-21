-- Together We Feed first-party earmarked support fund.
-- Funds are received by MyPets and accounted separately for the Together We Feed program.

insert into public.causes (
  id, protector_id, slug, title, summary, story, country, city, primary_image,
  support_mode, target_amount_cents, raised_amount_cents, currency, status,
  is_public, published_at, vertical, campaign_key, campaign_meta,
  beneficiary_kind, fund_code, is_evergreen
) values (
  '9a7f1000-0000-4a11-8c01-000000000006'::uuid,
  null,
  'mypets-together-we-feed-brl',
  'Apoie o Together We Feed',
  'Apoio recebido pelo MyPets e destinado à frente Together We Feed para alimentação e apoio imediato a animais em situação de vulnerabilidade.',
  'Fundo dedicado ao Together We Feed dentro do ecossistema MyPets. O beneficiário financeiro e recebedor da cobrança é o MyPets; os recursos ficam identificados contabilmente como destinados a esta frente.',
  'BR',
  null,
  'https://res.cloudinary.com/fnki0ccg/image/upload/v1789145246/Logo_VPT.png',
  'FINANCIAL',
  null,
  0,
  'BRL',
  'ACTIVE',
  true,
  now(),
  'FOOD',
  null,
  '{"beneficiaryLabel":"MyPets · Together We Feed","trustNote":"Cobrança recebida pelo MyPets e contabilmente destinada à frente Together We Feed."}'::jsonb,
  'MYPETS',
  'TOGETHER_WE_FEED',
  true
)
on conflict (id) do update set
  slug = excluded.slug,
  title = excluded.title,
  summary = excluded.summary,
  story = excluded.story,
  primary_image = excluded.primary_image,
  support_mode = excluded.support_mode,
  currency = excluded.currency,
  status = excluded.status,
  is_public = excluded.is_public,
  vertical = excluded.vertical,
  campaign_meta = excluded.campaign_meta,
  beneficiary_kind = excluded.beneficiary_kind,
  fund_code = excluded.fund_code,
  is_evergreen = excluded.is_evergreen,
  updated_at = now();
