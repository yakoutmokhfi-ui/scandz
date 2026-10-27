-- ============================================================
-- Scanym — MENU ITEM CONTAINS ALCOHOL v1 (UX LOT 2026-10, demande Emmanuel)
-- (DRAFT — NON APPLIQUÉ — AUCUNE EXÉCUTION HÉBERGÉE dans ce lot :
--  à appliquer UNIQUEMENT sur décision explicite, après revue de la PR.)
--
-- CONSTAT : aucune donnée du catalogue ne dit si un produit est une
-- boisson alcoolisée. menu_items porte nom/description/tags (libellés
-- libres du commerçant), tax_rate, poids, modes de vente -- rien de
-- fiable. Déduire l'alcool du nom, de la description ou d'un tag serait
-- une inférence (interdite par la demande). Il faut donc UNE donnée
-- déclarée par le commerçant.
--
-- CHANGEMENT DE DONNÉES MINIMAL :
--   A. UNE colonne additive : menu_items.contains_alcohol boolean
--      NOT NULL DEFAULT false. false = aucun changement (100 % des
--      produits existants) ; true = le checkout affiche une case de
--      confirmation d'âge (décochée par défaut, bloquante) dès que le
--      panier contient ce produit (lib/cart.ts::cartContainsAlcohol,
--      components/CartPanel.tsx, components/MenuView.tsx).
--      La vitrine lit déjà `menu_items ( * )` (lib/services/restaurant.ts)
--      : aucun RPC de lecture, aucune policy, aucun GRANT à ajouter.
--
-- CE QUE CE LOT NE FAIT PAS :
--   - ne touche ni create_product/update_product (RPC back-office) ni
--     l'écran produit du tableau de bord : la valeur ne peut être posée
--     que par l'opérateur (section C) tant que le prolongement
--     back-office (paramètre p_contains_alcohol + case « boisson
--     alcoolisée » dans le formulaire produit) n'est pas livré ;
--   - ne touche ni create_order ni aucune commande : la confirmation
--     d'âge est une déclaration du client dans l'interface, elle n'est
--     PAS enregistrée sur la commande dans ce lot (voir « DÉCISIONS »
--     dans la PR : la conserver sur la commande -- horodatage de la
--     case -- est une décision métier/juridique à prendre, pas une
--     évidence technique) ;
--   - n'apporte AUCUNE garantie de conformité réglementaire : une case
--     cochée n'est pas une vérification d'âge.
--
-- ROLLBACK : alter table public.menu_items drop column contains_alcohol;
-- ============================================================

begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items'
      and column_name = 'contains_alcohol'
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: menu_items.contains_alcohol existe déjà -- MENU ITEM CONTAINS ALCOHOL v1 annulé.';
  end if;
end $$;

alter table public.menu_items
  add column contains_alcohol boolean not null default false;

comment on column public.menu_items.contains_alcohol is
  'MENU ITEM CONTAINS ALCOHOL v1 — boisson alcoolisée DÉCLARÉE par le commerçant. true = le checkout exige une confirmation d''âge (case décochée par défaut, bloquante) dès que le panier contient ce produit. JAMAIS déduit du nom, de la description ou des tags. Aucune garantie de conformité : déclaration du client, pas une vérification d''identité.';

commit;

-- ============================================================
-- C. OPÉRATION DE DONNÉES SÉPARÉE (à exécuter À PART, par l'opérateur,
--    produit par produit, d'après la liste fournie par le commerçant) :
--
--    update public.menu_items
--       set contains_alcohol = true
--     where id in ('<uuid produit 1>', '<uuid produit 2>');
--
--    Vérification : select i.id, i.name, i.contains_alcohol
--                     from public.menu_items i
--                     join public.menu_categories c on c.id = i.category_id
--                    where c.restaurant_id = '<uuid établissement>' and i.contains_alcohol;
-- ============================================================
