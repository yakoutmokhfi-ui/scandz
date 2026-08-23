-- ============================================================
-- Scanym LOT 2A.4 — Durcissement des privilèges Production.
--
-- Finding Production : SEC-2A3-01 (HIGH) -- les 5 tables créées par
-- LOT 2A/2A.1/2A.2/2A.3 disposent de privilèges EXCESSIFS pour
-- PUBLIC/anon/authenticated : TRUNCATE, REFERENCES, TRIGGER.
--
-- ⚠️ LOT 2A.3 RESTE INSTALLÉ EN PRODUCTION. Ce fichier est un
-- correctif ADDITIF pur (uniquement des REVOKE), jamais un rollback
-- ni une modification rétroactive de migration-v82-lot2a-sale-modes.sql
-- déjà appliquée. Applicable directement sur une Production où LOT
-- 2A.3 est déjà présent (migration 20260823123726_lot2a3_sale_modes).
--
-- Cause investiguée (voir section dédiée dans le rapport de
-- livraison) : un CREATE TABLE + GRANT SELECT ordinaire, vérifié
-- empiriquement dans un environnement PostgreSQL propre, n'accorde
-- JAMAIS TRUNCATE/REFERENCES/TRIGGER par défaut -- ces trois
-- privilèges ne proviennent d'aucune instruction explicite du fichier
-- migration-v82-lot2a-sale-modes.sql. La cause la plus probable est un
-- mécanisme de privilèges par défaut au niveau de la plateforme
-- Supabase (ALTER DEFAULT PRIVILEGES configuré lors du provisionnement
-- du projet, accordant historiquement ALL sur toute nouvelle table à
-- anon/authenticated, RLS étant alors censée porter seule la
-- protection réelle) -- hypothèse documentée, non vérifiable
-- directement sans accès Production, qu'aucun tour de ce lot n'a.
--
-- Aucune donnée, policy RLS, fonction métier ni configuration
-- existante n'est modifiée par ce fichier -- uniquement des REVOKE.
-- ============================================================

-- ------------------------------------------------------------------
-- Contrôle préalable (anti-dérive) : confirme que les 5 tables
-- concernées existent bien (LOT 2A.3 déjà installé) avant toute
-- opération.
-- ------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'sale_mode_catalog')
  or not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_modes')
  or not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'sale_mode_field_requirements')
  or not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'restaurant_sale_mode_field_requirements')
  or not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'order_delivery_address')
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: une ou plusieurs tables LOT 2A introuvables — migration LOT 2A.4 annulée. Prérequis : LOT 2A.3 doit déjà être installé.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------
-- Révocation explicite, table par table, des privilèges excessifs.
-- REVOKE est intrinsèquement idempotent (aucune erreur si le
-- privilège n'est déjà pas accordé) -- ce fichier peut être rejoué
-- sans risque.
-- ------------------------------------------------------------

revoke truncate, references, trigger on public.sale_mode_catalog from public, anon, authenticated;
revoke truncate, references, trigger on public.restaurant_sale_modes from public, anon, authenticated;
revoke truncate, references, trigger on public.sale_mode_field_requirements from public, anon, authenticated;
revoke truncate, references, trigger on public.restaurant_sale_mode_field_requirements from public, anon, authenticated;
revoke truncate, references, trigger on public.order_delivery_address from public, anon, authenticated;

-- ------------------------------------------------------------
-- Réaffirmation explicite des privilèges MINIMAUX réellement
-- nécessaires, table par table -- ceinture et bretelles : même si le
-- REVOKE ci-dessus a correctement retiré TRUNCATE/REFERENCES/TRIGGER,
-- cette section garantit que SELECT (le seul privilège métier
-- réellement utilisé) reste bien present pour les rôles qui en ont
-- besoin, et qu'aucun autre privilège (INSERT/UPDATE/DELETE) n'a été
-- accordé par erreur ou par le même mécanisme par défaut. Idempotent :
-- revoke puis grant, jamais un simple grant qui laisserait subsister
-- un privilège excessif préexistant non couvert par le nom explicite.
-- ------------------------------------------------------------

-- sale_mode_catalog : donnée de référence globale, lecture publique
-- légitime pour anon ET authenticated -- aucune donnée sensible.
revoke all on public.sale_mode_catalog from public, anon, authenticated;
grant select on public.sale_mode_catalog to anon, authenticated;

-- sale_mode_field_requirements : règles par défaut du catalogue,
-- donnée de référence globale également -- même posture.
revoke all on public.sale_mode_field_requirements from public, anon, authenticated;
grant select on public.sale_mode_field_requirements to anon, authenticated;

-- restaurant_sale_modes : STRICTEMENT privée par tenant (RLS membre
-- uniquement depuis LOT 2A.2/2A.3) -- authenticated conserve SELECT
-- (nécessaire au Dashboard, filtré par la RLS existante), anon
-- n'obtient RIEN (la consultation publique passe exclusivement par
-- get_restaurant_public_sale_modes, RPC SECURITY DEFINER déjà
-- auditée -- jamais un accès direct à cette table).
revoke all on public.restaurant_sale_modes from public, anon, authenticated;
grant select on public.restaurant_sale_modes to authenticated;

-- restaurant_sale_mode_field_requirements : même posture stricte.
revoke all on public.restaurant_sale_mode_field_requirements from public, anon, authenticated;
grant select on public.restaurant_sale_mode_field_requirements to authenticated;

-- order_delivery_address : authenticated garde SELECT (nécessaire au
-- Dashboard staff, filtré par la RLS "order_delivery_address_select_staff"
-- déjà auditée -- appartenance réelle via restaurant_users), anon
-- n'obtient RIEN (adresse de livraison jamais publique).
revoke all on public.order_delivery_address from public, anon, authenticated;
grant select on public.order_delivery_address to authenticated;

commit;

-- ============================================================
-- PROTECTION FUTURE (section 6 de la mission) : si la cause racine
-- est bien un ALTER DEFAULT PRIVILEGES au niveau plateforme, ce
-- correctif ne l'annule PAS pour les FUTURES tables (hors périmètre
-- de ce lot, volontairement minimal). Recommandation documentée dans
-- le rapport de livraison : auditer
-- `select * from pg_default_acl` en Production pour confirmer
-- l'hypothèse, puis envisager un correctif séparé et dédié
-- (`alter default privileges ... revoke ...`) si confirmé -- décision
-- explicitement laissée au CIO, hors du périmètre strictement défini
-- de LOT 2A.4.
--
-- TESTS À REJOUER MANUELLEMENT (preuve automatisée réelle dans
-- supabase/tests/v82a4-privilege-check.sh) :
--  ✗ has_table_privilege(anon/authenticated/public, table, 'TRUNCATE') = false, les 5 tables
--  ✗ has_table_privilege(anon/authenticated/public, table, 'REFERENCES') = false, les 5 tables
--  ✗ has_table_privilege(anon/authenticated/public, table, 'TRIGGER') = false, les 5 tables
--  ✓ has_table_privilege(anon/authenticated, catalog tables, 'SELECT') = true
--  ✓ has_table_privilege(authenticated, tenant tables, 'SELECT') = true
--  ✗ has_table_privilege(anon, tenant tables, 'SELECT') = false
--  ✗ INSERT/UPDATE/DELETE = false pour tous les rôles applicatifs
--  ✓ non-régression complète : create_order, projections publiques,
--    helper interne inaccessible, RLS tenant, backfill
-- ============================================================
