-- =============================================================================
-- SCANYM — PRODUCT SERVICE MODES v1 — ROLLBACK. DRAFT ONLY.
-- =============================================================================
-- Annule les primitives ajoutées par
-- DRAFT-lot-product-service-modes-v1.sql.
--
-- AVERTISSEMENT DONNÉES : ce rollback SUPPRIME menu_item_sale_modes
-- (restrictions de mode par produit configurées par les marchands) et
-- la colonne order_items.service_mode_eligible_at_order_time (preuve
-- historique de conformité au mode de service). Décision explicite
-- requise avant exécution en Production -- jamais automatique.
-- =============================================================================

begin;

-- 1. Catalogue marchand -- retour à la signature ONLINE WITHDRAWAL v1
--    (10 paramètres, sans p_allowed_sale_modes). Les corps sont ceux
--    de DRAFT-lot-online-withdrawal-foundation-v1.sql : rejouer ce
--    fichier après ce rollback est le chemin recommandé, plutôt que
--    de dupliquer les corps ici.
drop function if exists public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean, text[]);
drop function if exists public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean, text[]);
drop function if exists public.get_merchant_catalogue(uuid, boolean);

-- 2. create_order -- retour EXACT au corps de DRAFT-lot-delivery-
--    country-scope-v1.sql (signature inchangée par ce lot, donc un
--    simple CREATE OR REPLACE avec l'ancien corps suffit -- rejouer ce
--    fichier après ce rollback est le chemin recommandé).

-- 3. Snapshot de ligne.
alter table public.order_items drop column if exists service_mode_eligible_at_order_time;

-- 4. Restrictions par produit.
drop table if exists public.menu_item_sale_modes;

do $$
begin
  if to_regclass('public.menu_item_sale_modes') is not null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: menu_item_sale_modes subsiste.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'service_mode_eligible_at_order_time'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: order_items.service_mode_eligible_at_order_time subsiste.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_product'
      and pg_get_function_identity_arguments(p.oid) like '%p_allowed_sale_modes%'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: create_product porte encore p_allowed_sale_modes.';
  end if;
end $$;

commit;

-- APRÈS CE ROLLBACK : rejouer
--   1. supabase/DRAFT-lot-online-withdrawal-foundation-v1.sql
--      (sections create_product / update_product / get_merchant_catalogue)
--   2. supabase/DRAFT-lot-delivery-country-scope-v1.sql
--      (section create_order)
-- pour restaurer les RPC dans leur forme antérieure à ce lot.
