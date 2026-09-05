-- MyPets Story Catalog Fallback v1
-- Guarantees that the public stories section can render while real cases are being onboarded.
-- These rows are explicitly demo/editorial placeholders and must never be presented as verified cases.

insert into public.stories (
  slug, kind, name, location, country, currency, desc_pt_pt, desc_pt_br, desc_en,
  image, image_alt, tags, target_cents, raised_cents, is_demo, active, sort_order
) values
('ana-porto','PROTECTOR','Ana','Porto','PT','EUR',
 'Cuida atualmente de 14 gatos e precisa de apoio com alimentação, medicação e esterilização.',
 'Cuida atualmente de 14 gatos e precisa de apoio com alimentação, medicação e esterilização.',
 'Currently caring for 14 cats and needs support with food, medication and sterilization.',
 '/images/story-ana.jpg','História editorial de demonstração sobre uma protetora e gatos resgatados no Porto',
 '["RACAO","MEDICACAO","ESTERILIZACAO"]'::jsonb,42000,28500,true,true,1),
('carlos-sao-paulo','PROTECTOR','Carlos','São Paulo','BR','BRL',
 'Alimenta e acompanha 23 cães numa comunidade local e procura apoio para ração, vacinação e transporte.',
 'Alimenta e acompanha 23 cães em uma comunidade local e busca apoio para ração, vacinação e transporte.',
 'Feeds and looks after 23 dogs in a local community and is seeking support for food, vaccination and transport.',
 '/images/story-carlos.jpg','História editorial de demonstração sobre um protetor e cães numa comunidade de São Paulo',
 '["RACAO","VACINACAO","TRANSPORTE"]'::jsonb,240000,167000,true,true,2),
('luna','ANIMAL','Luna',null,'PT','EUR',
 'Encontrada ferida. Está em tratamento e precisa de apoio para consulta, cirurgia e recuperação.',
 'Encontrada ferida. Está em tratamento e precisa de apoio para consulta, cirurgia e recuperação.',
 'Found injured. Currently in treatment and needs support for consultation, surgery and recovery.',
 '/images/story-luna.jpg','História editorial de demonstração de Luna, uma cadelinha em recuperação',
 '["CONSULTA","CIRURGIA","RECUPERACAO"]'::jsonb,42000,28500,true,true,3),
('milo','ANIMAL','Milo',null,'PT','EUR',
 'Resgatado da rua. Precisa de alimentação, consulta veterinária e acolhimento temporário.',
 'Resgatado da rua. Precisa de alimentação, consulta veterinária e lar temporário.',
 'Rescued from the street. Needs food, veterinary care and temporary foster support.',
 '/images/story-milo.jpg','História editorial de demonstração de Milo, um cão jovem resgatado da rua',
 '["RACAO","CONSULTA","ACOLHIMENTO"]'::jsonb,30000,12000,true,true,4)
on conflict (slug) do update set
  kind=excluded.kind,
  name=excluded.name,
  location=excluded.location,
  country=excluded.country,
  currency=excluded.currency,
  desc_pt_pt=excluded.desc_pt_pt,
  desc_pt_br=excluded.desc_pt_br,
  desc_en=excluded.desc_en,
  image=excluded.image,
  image_alt=excluded.image_alt,
  tags=excluded.tags,
  target_cents=excluded.target_cents,
  raised_cents=excluded.raised_cents,
  is_demo=true,
  active=true,
  sort_order=excluded.sort_order,
  updated_at=now();
