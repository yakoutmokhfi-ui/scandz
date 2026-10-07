-- DRAFT ONLY — roll back the application to its previous version FIRST.
-- This removes only the new endpoint; the original operator RPC is untouched.
-- No table, policy, data, or existing grant is modified.
begin;
drop function if exists public.get_operator_restaurant_orders_page(uuid, boolean, timestamptz, uuid);
commit;
