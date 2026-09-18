-- ============================================================
-- Scanym — CUSTOMER TRACKING v3.1 — ROLLBACK (DRAFT — NOT APPLIED IN
-- PRODUCTION)
--
-- Reverts supabase/DRAFT-lot-customer-tracking-capability-v3-1.sql
-- exactly: drops the three v3.1 functions and the capability table.
-- `create_order`, `get_order_tracking(uuid, uuid)` and every other
-- object were never modified by v3.1 and are therefore left as-is.
--
-- CONSEQUENCE (must be accepted before running): every minted tracking
-- capability is destroyed. Customers whose browser holds a v3.1
-- session cookie fall back to the generic "invalid link" screen; the
-- application code must be reverted to v2.1 in the same release.
--
-- ONE explicit transaction, fails closed if v3.1 is not applied.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.order_tracking_capabilities') is null
     or not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_order_tracking_by_capability'
     )
     or not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'upgrade_legacy_tracking_capability'
     )
     or not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'issue_order_email_tracking_capability'
     ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: CUSTOMER TRACKING v3.1 absent ou partiel -- rollback annulé.';
  end if;
end $$;

drop function public.issue_order_email_tracking_capability(uuid);
drop function public.upgrade_legacy_tracking_capability(uuid, uuid);
drop function public.get_order_tracking_by_capability(uuid, uuid, text);
drop table public.order_tracking_capabilities;

do $$
begin
  if to_regclass('public.order_tracking_capabilities') is not null
     or exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('get_order_tracking_by_capability', 'upgrade_legacy_tracking_capability', 'issue_order_email_tracking_capability')
     ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: post-vérification rollback -- objets CUSTOMER TRACKING v3.1 encore présents.';
  end if;
end $$;

commit;
