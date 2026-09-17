-- MyPets Commerce legal entity registry
-- Centralizes seller identity and public disclosure without mixing commerce with support flows.

create table if not exists public.commerce_legal_entities (
  code text primary key,
  public_label text not null,
  legal_name text not null,
  registration_type text not null,
  registration_number text not null,
  country_code text not null,
  address jsonb not null,
  support_email text,
  support_phone text,
  whatsapp text,
  website text,
  role text not null default 'COMMERCIAL_OPERATOR',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_legal_entities_country_check check (country_code in ('BR','GB')),
  constraint commerce_legal_entities_role_check check (role in ('COMMERCIAL_OPERATOR','PLATFORM_OPERATOR','TECHNOLOGY_PROVIDER'))
);

insert into public.commerce_legal_entities (
  code, public_label, legal_name, registration_type, registration_number,
  country_code, address, support_email, support_phone, whatsapp, website, role, metadata
)
values
  (
    'MYPETS_BR',
    'MyPets Brasil',
    '69.093.616 MICAELA GOMES DE JESUS',
    'CNPJ',
    '69.093.616/0001-50',
    'BR',
    jsonb_build_object(
      'street', 'AVENIDA JOAO FLORENTINO',
      'number', '9',
      'complement', 'QUADRA 2',
      'district', 'RESIDENCIAL ARAGUAIA',
      'city', 'ANAPOLIS',
      'state', 'GO',
      'postal_code', '75071-430',
      'country', 'Brasil'
    ),
    'contact@mypets.lat',
    '+55 62 99619-7224',
    '+55 62 99619-7224',
    'https://mypets.lat',
    'COMMERCIAL_OPERATOR',
    jsonb_build_object('brand', 'MyPets', 'capital_social_brl', 5000)
  ),
  (
    'HUMAN_IMPACT_UK',
    'MyPets Europe',
    'HUMAN IMPACT TECH LTD',
    'Company number',
    '17422257',
    'GB',
    jsonb_build_object(
      'street', '71-75 Shelton Street',
      'district', 'Covent Garden',
      'city', 'London',
      'postal_code', 'WC2H 9JQ',
      'country', 'United Kingdom'
    ),
    'contact@mypets.lat',
    null,
    null,
    'https://mypets.lat',
    'PLATFORM_OPERATOR',
    jsonb_build_object(
      'brand', 'MyPets',
      'relationship', 'Parent/platform company for UK and European operations and technology provider to the MyPets ecosystem'
    )
  )
on conflict (code) do update set
  public_label = excluded.public_label,
  legal_name = excluded.legal_name,
  registration_type = excluded.registration_type,
  registration_number = excluded.registration_number,
  country_code = excluded.country_code,
  address = excluded.address,
  support_email = excluded.support_email,
  support_phone = excluded.support_phone,
  whatsapp = excluded.whatsapp,
  website = excluded.website,
  role = excluded.role,
  metadata = excluded.metadata,
  updated_at = now();

alter table public.commerce_markets
  add constraint commerce_markets_legal_entity_fk
  foreign key (legal_entity_code)
  references public.commerce_legal_entities(code)
  on delete restrict;

comment on table public.commerce_legal_entities is 'Legal sellers/platform operators used by MyPets commerce. Public labels such as MyPets Brasil/MyPets Europe are trading labels, not separate legal entities.';
