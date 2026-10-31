-- ORDER HELP TRANSLATIONS v1 rollback.
-- Refuses to discard merchant translations. Export or remove them first.
begin;
lock table public.merchant_communication_text in access exclusive mode;
do $$
begin
  if to_regclass('public.merchant_communication_text') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_communication_text is missing';
  end if;
  if exists (
    select 1 from public.merchant_communication_text
    where translations is not null and translations <> '{}'::jsonb
  ) then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: communication text translations exist; export them before rollback';
  end if;
end $$;
drop function if exists public.get_restaurant_public_order_help_texts(uuid);
drop function if exists public.write_order_help_translation(uuid,text,text,text,text,text);
alter table public.merchant_communication_text drop column body_hash, drop column translations;
commit;
