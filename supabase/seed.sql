-- Deterministic MyPets demo seed. Fictional records remain is_demo = true.
insert into public.stories (
  slug, kind, name, location, country, currency, desc_pt_pt, desc_pt_br, desc_en,
  image, image_alt, tags, target_cents, raised_cents, is_demo, active, sort_order
) values
('ana-porto','PROTECTOR','Ana','Porto','PT','EUR','Cuida atualmente de 14 gatos.','Cuida atualmente de 14 gatos.','Currently caring for 14 cats.','/images/story-ana.jpg','Ana sentada num degrau rodeada por gatos resgatados no Porto','["RACAO","MEDICACAO","ESTERILIZACAO"]'::jsonb,42000,28500,true,true,1),
('carlos-sao-paulo','PROTECTOR','Carlos','São Paulo','BR','BRL','Alimenta e acompanha 23 cães numa comunidade local.','Alimenta e acompanha 23 cães em uma comunidade local.','Feeds and looks after 23 dogs in a local community.','/images/story-carlos.jpg','Carlos ajoelhado entre cães resgatados numa comunidade de São Paulo','["RACAO","VACINACAO","TRANSPORTE"]'::jsonb,240000,167000,true,true,2),
('luna','ANIMAL','Luna',null,'PT','EUR','Encontrada ferida. Está em tratamento.','Encontrada ferida. Está em tratamento.','Found injured. Currently in treatment.','/images/story-luna.jpg','Luna, cadelinha em recuperação sobre coberta clínica','["CONSULTA","CIRURGIA","RECUPERACAO"]'::jsonb,42000,28500,true,true,3),
('milo','ANIMAL','Milo',null,'PT','EUR','Resgatado da rua. Precisa de cuidados.','Resgatado da rua. Precisa de cuidados.','Rescued from the street. Needs care.','/images/story-milo.jpg','Milo, cão jovem resgatado da rua, a olhar para a câmara','["RACAO","CONSULTA","ACOLHIMENTO"]'::jsonb,30000,12000,true,true,4)
on conflict (slug) do update set
  kind=excluded.kind,name=excluded.name,location=excluded.location,country=excluded.country,currency=excluded.currency,
  desc_pt_pt=excluded.desc_pt_pt,desc_pt_br=excluded.desc_pt_br,desc_en=excluded.desc_en,image=excluded.image,image_alt=excluded.image_alt,
  tags=excluded.tags,target_cents=excluded.target_cents,raised_cents=excluded.raised_cents,is_demo=true,active=excluded.active,sort_order=excluded.sort_order,updated_at=now();

insert into public.impact_metrics (key,value,prefix,suffix,decimals,label_pt_pt,label_pt_br,label_en,icon,color,is_demo,sort_order) values
('animals_supported',3482,null,null,0,'Animais apoiados','Animais apoiados','Animals supported','paw','coral',true,1),
('protectors_supported',612,null,null,0,'Protetores apoiados','Protetores apoiados','Protectors supported','paw','teal',true,2),
('needs_resolved',1920,null,null,0,'Necessidades resolvidas','Necessidades resolvidas','Needs resolved','check','amber',true,3),
('adoptions',285,null,null,0,'Adoções','Adoções','Adoptions','heart','red',true,4),
('food_delivered',48.7,null,'ton',1,'Ração doada','Ração doada','Food delivered','food','blue',true,5),
('community',12500,'+',null,0,'Pessoas na comunidade','Pessoas na comunidade','Community members','users','green',true,6)
on conflict (key) do update set value=excluded.value,prefix=excluded.prefix,suffix=excluded.suffix,decimals=excluded.decimals,label_pt_pt=excluded.label_pt_pt,label_pt_br=excluded.label_pt_br,label_en=excluded.label_en,icon=excluded.icon,color=excluded.color,is_demo=true,sort_order=excluded.sort_order;

insert into public.content_blocks (key,value) values ('legal.entity',jsonb_build_object(
'poweredBy','HUMAN IMPACT TECH LTD','companyNumber','17422257','address','1-75 Shelton Street, Covent Garden, London, United Kingdom, WC2H 9JQ','site','humanimpact.tech','disclaimerPt','MyPets é uma iniciativa de impacto social powered by HUMAN IMPACT TECH LTD.','disclaimerEn','MyPets is a social impact initiative powered by HUMAN IMPACT TECH LTD.'))
on conflict (key) do update set value=excluded.value,updated_at=now();
