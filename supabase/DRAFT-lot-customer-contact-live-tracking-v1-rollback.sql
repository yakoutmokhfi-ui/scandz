-- ============================================================
-- Scanym — CUSTOMER CONTACT + LIVE TRACKING v1
-- ROLLBACK (DRAFT — NOT APPLIED IN PRODUCTION)
--
-- Reverts supabase/DRAFT-lot-customer-contact-live-tracking-v1.sql
-- exactly. Nothing else was modified by the lot, so nothing else is
-- touched here.
--
-- CONSEQUENCES (must be accepted before running):
--   - every merchant's WhatsApp on/off choice is lost; after rollback
--     WhatsApp is again always used (historical behaviour);
--   - public phone/e-mail values are destroyed.
-- The application code must be reverted in the same release.
--
-- ONE explicit transaction, fails closed if the lot is not applied.
-- ============================================================

begin;

do $$
begin
  if not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_configs'
         and column_name = 'whatsapp_enabled'
     )
     or not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_order_tracking_customer_context_by_capability'
     ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: CCLT v1 absent ou partiel -- rollback annulé.';
  end if;
end $$;

drop function public.get_order_tracking_customer_context_by_capability(uuid, uuid, text);
drop function public.update_restaurant_public_contact(uuid, text, text);
drop function public.update_restaurant_whatsapp_enabled(uuid, boolean);
alter table public.restaurant_configs
  drop constraint restaurant_configs_public_email_format,
  drop constraint restaurant_configs_public_phone_format,
  drop column public_email,
  drop column public_phone,
  drop column whatsapp_enabled;

do $$
begin
  if exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_configs'
         and column_name in ('whatsapp_enabled', 'public_phone', 'public_email')
     )
     or exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('update_restaurant_whatsapp_enabled', 'update_restaurant_public_contact',
                           'get_order_tracking_customer_context_by_capability')
     ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: post-vérification rollback -- objets CCLT v1 encore présents.';
  end if;
end $$;

commit;
