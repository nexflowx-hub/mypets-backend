-- MyPets first-party internal fund schema.

alter table public.causes
  alter column protector_id drop not null,
  add column if not exists beneficiary_kind text not null default 'PROTECTOR',
  add column if not exists fund_code text,
  add column if not exists is_evergreen boolean not null default false;

do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.causes'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%support_mode%'
      and pg_get_constraintdef(oid) ilike '%target_amount_cents%'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.causes drop constraint %I', constraint_name);
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'causes_beneficiary_kind_check' and conrelid = 'public.causes'::regclass) then
    alter table public.causes add constraint causes_beneficiary_kind_check check (beneficiary_kind in ('PROTECTOR','MYPETS'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'causes_beneficiary_binding_check' and conrelid = 'public.causes'::regclass) then
    alter table public.causes add constraint causes_beneficiary_binding_check check (
      (beneficiary_kind = 'PROTECTOR' and protector_id is not null and fund_code is null)
      or (beneficiary_kind = 'MYPETS' and protector_id is null and fund_code is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'causes_financial_configuration_check' and conrelid = 'public.causes'::regclass) then
    alter table public.causes add constraint causes_financial_configuration_check check (
      support_mode = 'NON_FINANCIAL' or status = 'DRAFT'
      or (currency is not null and (target_amount_cents is not null or is_evergreen))
    );
  end if;
end $$;

create unique index if not exists causes_mypets_fund_code_unique on public.causes(fund_code) where beneficiary_kind = 'MYPETS';
