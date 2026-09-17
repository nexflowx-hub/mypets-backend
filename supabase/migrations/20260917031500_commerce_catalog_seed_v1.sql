-- MyPets Commerce catalog seed v1
-- Draft-only catalog. Offers stay inactive until supplier, stock, freight and warranty are validated.

insert into public.commerce_products (slug, name, description, category, species, brand, status, is_physical, attributes)
values
  ('smart-pet-id-qr', 'MyPets Smart QR Tag', 'Tag de identificacao com QR Code para ligar o animal ao seu perfil MyPets/FacePets e aos contactos definidos pelo tutor.', 'smart', 'DOG_CAT', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A','proprietary',true)),
  ('tapete-higienico-care-pack', 'Tapete Higienico Care Pack', 'Pack de tapetes higienicos para rotina diaria, sujeito a validacao final de fornecedor e quantidade por embalagem.', 'higiene', 'DOG', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A','recurring',true)),
  ('comedouro-slow-care', 'Comedouro Slow Care', 'Comedouro de alimentacao lenta para caes e gatos, sujeito a validacao de material, dimensoes e fornecedor.', 'alimentacao', 'DOG_CAT', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A')),
  ('bebedouro-anti-respingo', 'Bebedouro Anti-Respingo', 'Bebedouro de rotina com desenho orientado a reduzir respingos.', 'alimentacao', 'DOG_CAT', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A')),
  ('fonte-agua-flow', 'Fonte de Agua Flow', 'Fonte de agua com circulacao continua; capacidade, potencia e filtros dependem da referencia final aprovada.', 'alimentacao', 'DOG_CAT', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A')),
  ('filtros-fonte-flow', 'Filtros Fonte Flow', 'Kit de reposicao para fonte de agua compatível com a referencia final aprovada.', 'alimentacao', 'DOG_CAT', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A','recurring',true)),
  ('escova-autolimpante-soft', 'Escova Autolimpante Soft', 'Escova para cuidados frequentes de caes e gatos com mecanismo de limpeza rapida.', 'higiene', 'DOG_CAT', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A')),
  ('peitoral-guia-refletiva-kit', 'Kit Peitoral + Guia Refletiva', 'Kit de passeio com peitoral ajustavel e guia refletiva; tamanhos e resistencia dependem da referencia final aprovada.', 'passeio', 'DOG', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A')),
  ('cinto-seguranca-pet', 'Cinto de Seguranca Pet', 'Acessorio de retencao para transporte de pets; compatibilidade deve ser validada por modelo e uso.', 'passeio', 'DOG', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','A')),
  ('varinha-interativa-cat-play', 'Varinha Interativa Cat Play', 'Brinquedo interativo leve para gatos, sujeito a validacao de materiais e seguranca.', 'brinquedos', 'CAT', 'MyPets', 'DRAFT', true, jsonb_build_object('priority','B'))
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  species = excluded.species,
  brand = excluded.brand,
  attributes = excluded.attributes,
  updated_at = now();

insert into public.commerce_product_variants (product_id, sku, name, active)
select p.id, v.sku, 'Padrao', true
from public.commerce_products p
join (values
  ('smart-pet-id-qr','MYP-BR-SMARTTAG-001'),
  ('tapete-higienico-care-pack','MYP-BR-TAPETE-001'),
  ('comedouro-slow-care','MYP-BR-SLOW-001'),
  ('bebedouro-anti-respingo','MYP-BR-BEBEDOURO-001'),
  ('fonte-agua-flow','MYP-BR-FONTE-001'),
  ('filtros-fonte-flow','MYP-BR-FILTROS-001'),
  ('escova-autolimpante-soft','MYP-BR-ESCOVA-001'),
  ('peitoral-guia-refletiva-kit','MYP-BR-PASSEIO-001'),
  ('cinto-seguranca-pet','MYP-BR-CINTO-001'),
  ('varinha-interativa-cat-play','MYP-BR-CATPLAY-001')
) as v(slug, sku) on v.slug = p.slug
on conflict (sku) do update set active = true, updated_at = now();

-- Indicative BR offer values are retained as inactive planning data only.
-- They are not commercial offers until supplier/stock/freight are approved and active=true is explicitly set.
insert into public.commerce_product_offers (variant_id, market_code, currency, price_cents, active, metadata)
select v.id, 'BR', 'BRL', x.price_cents, false,
       jsonb_build_object('planning_only', true, 'requires_supplier_validation', true)
from public.commerce_product_variants v
join (values
  ('MYP-BR-SMARTTAG-001',4990),
  ('MYP-BR-TAPETE-001',5990),
  ('MYP-BR-SLOW-001',4990),
  ('MYP-BR-BEBEDOURO-001',6990),
  ('MYP-BR-FONTE-001',9990),
  ('MYP-BR-FILTROS-001',2990),
  ('MYP-BR-ESCOVA-001',4590),
  ('MYP-BR-PASSEIO-001',8990),
  ('MYP-BR-CINTO-001',3990),
  ('MYP-BR-CATPLAY-001',2990)
) as x(sku, price_cents) on x.sku = v.sku
on conflict (variant_id, market_code) do update set
  currency = excluded.currency,
  price_cents = excluded.price_cents,
  active = false,
  metadata = excluded.metadata,
  updated_at = now();
