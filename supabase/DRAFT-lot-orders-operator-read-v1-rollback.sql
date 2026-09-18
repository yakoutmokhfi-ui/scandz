-- ============================================================
-- Scanym — ORDERS OPERATOR READ v1 — ROLLBACK
-- DEVELOPMENT ONLY -- jamais exécuté sur Production sans GO MEP.
--
-- Retire STRICTEMENT le seul objet créé par
-- DRAFT-lot-orders-operator-read-v1.sql :
--   - public.get_operator_restaurant_orders(uuid, boolean)
-- Aucun autre objet n'est touché : la lecture marchande (RLS
-- is_member_of sur public.orders) n'a jamais été modifiée par le lot.
-- Le client (app/dashboard/page.tsx) doit être rétabli AVANT ce
-- rollback, sinon la vue opérateur affichera une erreur explicite
-- (jamais un repli silencieux).
-- ============================================================

begin;

drop function if exists public.get_operator_restaurant_orders(uuid, boolean);

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_operator_restaurant_orders'
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: get_operator_restaurant_orders subsiste -- rollback annulé.';
  end if;
end $$;

commit;
