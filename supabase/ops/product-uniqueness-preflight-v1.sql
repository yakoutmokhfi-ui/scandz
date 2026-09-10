-- ============================================================
-- Scanym — OPERATOR BACKOFFICE — OB-4 v1.2
-- PRODUCT UNIQUENESS PRODUCTION PREFLIGHT (OPS TOOL — AGGREGATE ONLY)
--
-- Ce fichier n'est PAS une migration : il ne modifie AUCUN schéma,
-- AUCUNE donnée, AUCUN privilège. C'est une requête SELECT autonome,
-- destinée à être exécutée MANUELLEMENT par un opérateur/DBA autorisé
-- (jamais par l'application, jamais via une RPC exposée au navigateur)
-- avant toute tentative d'installation de DRAFT-lot-catalogue-import-
-- commit-idempotency-v1-1.sql (section 3bis -- la garde de la
-- migration recalcule d'ailleurs EXACTEMENT la même chose, ce fichier
-- permet simplement de le vérifier indépendamment, AVANT de lancer
-- l'installation elle-même -- mandat OB-4 v1.2 : "reusable
-- independently BEFORE migration installation").
--
-- PORTÉE VOLONTAIREMENT AGRÉGÉE : cette requête ne renvoie JAMAIS de
-- nom de produit, de restaurant, de catégorie, ni aucun autre champ
-- métier -- uniquement deux nombres (mandat : "must NOT expose
-- unnecessary customer or merchant data"). Pour l'inspection détaillée
-- nécessaire à une décision de remédiation, voir le fichier SÉPARÉ
-- supabase/ops/product-uniqueness-remediation-inspection-v1.sql (lui-même
-- également NON exécuté par ce lot -- gouvernance CIO requise avant
-- toute exécution en Production, voir PRODUCTION-REMEDIATION-
-- RUNBOOK.md).
--
-- Clé testée : EXACTEMENT celle de l'index proposé --
-- (category_id, lower(btrim(name, E' \t\n\r\f' || chr(11)))),
-- produits actifs seulement (archived_at is null).
--
-- Usage (lecture seule, aucun effet de bord) :
--   psql "<connection string Production>" -f supabase/ops/product-uniqueness-preflight-v1.sql
--
-- Sortie attendue AVANT toute installation de la migration OB-4 :
--   duplicate_group_count = 0
--   excess_row_count      = 0
-- Toute valeur non nulle est BLOQUANTE (mandat : "STOP. No migration
-- install.") -- voir PRODUCTION-REMEDIATION-RUNBOOK.md pour la suite.
-- ============================================================

with active_products as (
  select
    category_id,
    lower(btrim(name, E' \t\n\r\f' || chr(11))) as normalized_name
  from public.menu_items
  where archived_at is null
),
duplicate_groups as (
  select
    category_id,
    normalized_name,
    count(*) as row_count
  from active_products
  group by category_id, normalized_name
  having count(*) > 1
)
select
  coalesce(count(*), 0)::integer                    as duplicate_group_count,
  coalesce(sum(row_count) - count(*), 0)::integer    as excess_row_count
from duplicate_groups;
