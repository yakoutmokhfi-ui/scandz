-- ============================================================
-- Scanym — CATALOGUE — COLLECTIONS / TAGS FOUNDATION v1 — ROLLBACK
--
-- ------------------------------------------------------------------
-- CE QUE CE FICHIER FAIT EXACTEMENT
-- ------------------------------------------------------------------
-- 1. SUPPRIME (DROP FUNCTION) les 6 fonctions du lot :
--    create_tag, add_product_tags, update_tag_collection_settings,
--    get_restaurant_tags, get_restaurant_collections, assert_tag_admin.
-- 2. SUPPRIME (DROP TABLE) menu_item_tags puis menu_tags.
--
-- LES DONNÉES DE TAGS SONT DONC PERDUES par ce rollback : définitions
-- de tags, associations produit/tag, visibilité et ordre des
-- collections. Ce n'est PAS une opération neutre -- à exporter avant
-- rollback si cette configuration doit être conservée. Les deux
-- tables sont entièrement créées par ce lot ; rien d'antérieur à lui
-- n'existe dedans.
--
-- ------------------------------------------------------------------
-- CE QUE CE ROLLBACK NE TOUCHE PAS
-- ------------------------------------------------------------------
-- AUCUNE ligne et AUCUNE colonne de menu_items, menu_categories,
-- menu_subcategories, orders, order_items, restaurants. Le lot étant
-- STRICTEMENT ADDITIF (2 tables neuves, 6 fonctions neuves, zéro
-- objet préexistant modifié -- get_merchant_catalogue n'est
-- délibérément pas étendue par ce lot), le rollback l'est
-- symétriquement : il n'a rien à restaurer, seulement à retirer.
--
-- Il ne contient donc AUCUN précheck conditionnel, contrairement au
-- rollback d'OPERATOR CATALOGUE RESET v1.2 : celui-là devait
-- reconstruire un index unique INCONDITIONNEL sur des données que la
-- fonctionnalité pouvait légitimement rendre non conformes. Ici,
-- retirer des tables neuves ne peut être bloqué par aucun état de
-- données, et aucun objet préexistant ne dépend d'elles (les clés
-- étrangères partent de menu_item_tags VERS menu_items/menu_tags,
-- jamais l'inverse : DROP TABLE de nos tables n'entraîne donc rien
-- côté catalogue).
--
-- ------------------------------------------------------------------
-- ATOMICITÉ
-- ------------------------------------------------------------------
-- La totalité s'exécute dans UNE transaction, contrôle de dérive en
-- PREMIÈRE instruction À L'INTÉRIEUR de celle-ci (et non avant
-- `begin;`) : un contrôle placé avant ne protégerait que si psql
-- tourne avec -v ON_ERROR_STOP=1. Dans la transaction, un échec
-- avorte tout et le `commit;` final agit comme un ROLLBACK -- la
-- garantie ne dépend d'aucun drapeau client.
--
-- Ce fichier N'A PAS ÉTÉ EXÉCUTÉ sur Production par ce lot.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.menu_tags') is null then
    raise exception
      'SCANYM_ROLLBACK_DRIFT: menu_tags introuvable -- cette base ne semble pas avoir reçu COLLECTIONS/TAGS FOUNDATION v1, rollback annulé (aucune mutation).';
  end if;
end $$;

drop function if exists public.get_restaurant_collections(uuid);
drop function if exists public.get_restaurant_tags(uuid);
drop function if exists public.update_tag_collection_settings(uuid, boolean, integer);
drop function if exists public.add_product_tags(uuid, text[]);
drop function if exists public.create_tag(uuid, text);

-- menu_item_tags d'abord : elle référence menu_tags.
drop table if exists public.menu_item_tags;
drop table if exists public.menu_tags;

-- assert_tag_admin en dernier : les fonctions ci-dessus l'appellent.
drop function if exists public.assert_tag_admin(uuid);

do $$
begin
  if to_regclass('public.menu_tags') is not null
     or to_regclass('public.menu_item_tags') is not null then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une table du lot subsiste -- rollback annulé.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_tag', 'add_product_tags', 'update_tag_collection_settings',
                        'get_restaurant_tags', 'get_restaurant_collections', 'assert_tag_admin')
  ) then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une RPC du lot subsiste -- rollback annulé.';
  end if;

  -- Le catalogue préexistant doit être intact.
  if to_regclass('public.menu_items') is null
     or to_regclass('public.menu_categories') is null
     or to_regclass('public.menu_subcategories') is null then
    raise exception 'SCANYM_ROLLBACK_INCOMPLETE: une table catalogue préexistante a disparu -- rollback annulé.';
  end if;
end $$;

commit;

-- ============================================================
-- FIN — COLLECTIONS / TAGS FOUNDATION v1 — ROLLBACK
-- ============================================================
