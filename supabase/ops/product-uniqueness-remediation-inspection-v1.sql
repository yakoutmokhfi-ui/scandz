-- ============================================================
-- Scanym — OPERATOR BACKOFFICE — OB-4 v1.2
-- PRODUCT UNIQUENESS REMEDIATION INSPECTION (OPS TOOL — GOVERNED STEP)
--
-- ⚠️ NON EXÉCUTÉ PAR CE LOT. NON EXÉCUTÉ EN PRODUCTION PAR CLAUDE
-- NOUGARO. Ce fichier est préparé pour la PROCHAINE étape gouvernée
-- (inspection contrôlée par un opérateur/DBA autorisé, PUIS décision
-- CIO explicite sur la ligne autoritaire, PUIS autorisation explicite
-- de la mutation exacte -- voir PRODUCTION-REMEDIATION-RUNBOOK.md pour
-- la séquence complète). AUCUNE valeur de ligne Production n'est
-- incluse dans ce paquet -- cette requête n'a jamais été exécutée
-- contre Production par ce travail.
--
-- Objectif : une fois que supabase/ops/product-uniqueness-preflight-v1.sql (ou
-- la garde de migration, section 3bis) a signalé au moins un groupe de
-- doublons, CETTE requête identifie PRÉCISÉMENT les lignes en conflit
-- -- avec le MINIMUM de champs nécessaires à une décision humaine,
-- jamais l'intégralité de la ligne produit (mandat : "may expose only
-- the minimum fields necessary to make a human remediation decision").
--
-- Champs exposés (mandat, liste fermée) :
--   - product_id                 (identifiant produit)
--   - restaurant_id              (contexte restaurant)
--   - category_id, category_name (contexte catégorie)
--   - name                       (nom produit courant, tel qu'affiché)
--   - is_available                (disponibilité courante)
--   - display_order               (ordre d'affichage courant)
--   - created_at / updated_at si présent -- NOTE : menu_items ne porte
--     PAS de colonne created_at native (schéma d'origine, voir
--     supabase/schema.sql) ; updated_at existe (migration-v55) et est
--     inclus ci-dessous comme signal temporel disponible le plus
--     proche du mandat ("created/updated timestamp if relevant").
--
-- Champs délibérément EXCLUS : price, description, short_description,
-- image_url, tax_rate, unit_weight_grams, translations, tout champ non
-- nécessaire à la décision "quelle ligne est autoritaire" -- aucune
-- donnée commerciale sensible au-delà du strict nécessaire.
--
-- Usage (lecture seule -- à exécuter SEULEMENT après autorisation CIO
-- explicite pour cette investigation précise) :
--   psql "<connection string Production>" -f supabase/ops/product-uniqueness-remediation-inspection-v1.sql
--
-- Résultat : une ligne par PRODUIT en conflit, groupées visuellement
-- par (category_id, normalized_name) via duplicate_group_key --
-- permet à un humain de comparer les candidats d'un même groupe côte à
-- côte et de décider laquelle est la ligne autoritaire, AVANT toute
-- autorisation de mutation.
-- ============================================================

with active_products as (
  select
    mi.id as product_id,
    mc.restaurant_id,
    mi.category_id,
    mc.name as category_name,
    mi.name as name,
    lower(btrim(mi.name, E' \t\n\r\f' || chr(11))) as normalized_name,
    mi.is_available,
    mi.display_order,
    mi.updated_at
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.archived_at is null
),
conflicting_groups as (
  select category_id, normalized_name
  from active_products
  group by category_id, normalized_name
  having count(*) > 1
)
select
  (ap.category_id::text || '|' || ap.normalized_name) as duplicate_group_key,
  ap.product_id,
  ap.restaurant_id,
  ap.category_id,
  ap.category_name,
  ap.name,
  ap.is_available,
  ap.display_order,
  ap.updated_at
from active_products ap
join conflicting_groups cg
  on cg.category_id = ap.category_id and cg.normalized_name = ap.normalized_name
order by duplicate_group_key, ap.product_id;
