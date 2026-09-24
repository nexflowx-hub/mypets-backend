-- Dedicated first-party MyPets food fund for the "1 eBook = 1 kg de Ração" campaign.
-- One confirmed R$12.90 participation represents one kilogram of dog food to be financed.
-- Confirmed kilograms are preserved even when procurement prices move; only future unit pricing may be revised.

insert into public.causes (
  id, protector_id, slug, title, summary, story, country, city, primary_image,
  support_mode, target_amount_cents, raised_amount_cents, currency, status,
  is_public, published_at, vertical, campaign_key, campaign_meta,
  beneficiary_kind, fund_code, is_evergreen,
  cause_type, verification_status, fundraising_status, intake_source
) values (
  '9a7f1000-0000-4a11-8c01-000000000007'::uuid,
  null,
  'mypets-ebook-racao-brl',
  '1 eBook = 1 kg de Ração',
  'Fundo MyPets de alimentação ligado à campanha de participação com recompensa digital.',
  'Cada unidade financeira confirmada desta campanha cria o compromisso MyPets de financiar 1 kg de ração. O eBook é uma recompensa digital de agradecimento; o beneficiário financeiro é o MyPets.',
  'BR',
  null,
  'https://mypets.lat/images/card-alimentou.jpg',
  'FINANCIAL',
  null,
  0,
  'BRL',
  'ACTIVE',
  true,
  now(),
  'FOOD',
  'ebook-racao',
  '{
    "beneficiaryLabel":"MyPets",
    "trustNote":"Fundo MyPets destinado à alimentação. O beneficiário financeiro é o MyPets; cada unidade confirmada desta campanha representa o compromisso de financiar 1 kg de ração.",
    "unitType":"DOG_FOOD_KG",
    "unitQuantity":1,
    "unitPriceCents":1290,
    "unitCurrency":"BRL",
    "rewardType":"DIGITAL_EBOOK",
    "pricePolicy":"Participações confirmadas preservam 1 kg. Se o custo de aquisição variar, o valor unitário pode ser revisto apenas para novas participações.",
    "campaignVersion":"1kg-v1"
  }'::jsonb,
  'MYPETS',
  'EBOOK_RACAO',
  true,
  'FEEDING',
  'PLATFORM',
  'ENABLED',
  'PLATFORM'
)
on conflict (id) do update set
  title = excluded.title,
  summary = excluded.summary,
  story = excluded.story,
  primary_image = excluded.primary_image,
  support_mode = excluded.support_mode,
  currency = excluded.currency,
  status = excluded.status,
  is_public = excluded.is_public,
  vertical = excluded.vertical,
  campaign_key = excluded.campaign_key,
  campaign_meta = excluded.campaign_meta,
  beneficiary_kind = excluded.beneficiary_kind,
  fund_code = excluded.fund_code,
  is_evergreen = excluded.is_evergreen,
  cause_type = excluded.cause_type,
  verification_status = excluded.verification_status,
  fundraising_status = excluded.fundraising_status,
  intake_source = excluded.intake_source,
  updated_at = now();
