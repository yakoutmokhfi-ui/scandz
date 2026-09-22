-- SCANYM — DELIVERY DELAY CUSTOMER NOTICE v1 — ROLLBACK
-- Removes only the two additive RPCs. No tenant data is changed.

begin;

drop function if exists public.update_merchant_delivery_method_notice(uuid, text, text);
drop function if exists public.get_merchant_delivery_method_notices(uuid);

commit;
