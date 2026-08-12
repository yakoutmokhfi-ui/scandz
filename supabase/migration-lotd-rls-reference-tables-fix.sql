-- ============================================================
-- Scanym LOT D — Correctif RLS des tables de référence
-- (scanym_supported_countries / scanym_supported_currencies)
--
-- À exécuter APRÈS migration-lotd-establishment-creation.sql, déjà
-- appliquée en production. Migration CORRECTIVE SÉPARÉE : la
-- migration Lot D initiale n'est PAS réécrite ni rejouée comme si
-- elle n'avait jamais eu lieu (elle a déjà créé ces deux tables et
-- accordé SELECT à authenticated) — seul ce qu'elle a omis est
-- corrigé ici.
--
-- CONSTAT (finding Work, post-déploiement production) : les tables
-- scanym_supported_countries et scanym_supported_currencies ont bien
-- été créées dans le schéma exposé `public`, avec REVOKE des
-- écritures et GRANT SELECT à authenticated — mais SANS jamais
-- activer Row Level Security dessus (`alter table ... enable row
-- level security` absent de la migration Lot D initiale pour ces
-- deux tables précisément, présent pour scanym_operators et
-- establishment_owner_invitations). Supabase signale toute table du
-- schéma public sans RLS activée, indépendamment de ses droits GRANT
-- (finding Security Advisor 0013_rls_disabled_in_public).
--
-- MODÈLE D'ACCÈS — inchangé, celui déjà en vigueur depuis Lot D :
--   authenticated : SELECT autorisé (back-office interne Scanym)
--   anon          : aucun SELECT
--   INSERT/UPDATE/DELETE : interdits à anon, authenticated, PUBLIC
-- Cette migration ne fait qu'ACTIVER RLS et AJOUTER une policy SELECT
-- explicite pour authenticated, reflétant exactement ce modèle déjà
-- en place au niveau des GRANT — elle ne change aucun droit existant.
-- ============================================================


-- ------------------------------------------------------------------
-- 1. CONTRÔLE PRÉALABLE — RÉELLEMENT EXÉCUTÉ. Confirme que les deux
--    tables existent bien (Lot D déjà appliquée) et que RLS n'est
--    effectivement PAS encore activée (évite un rejeu accidentel qui
--    créerait des policies en double).
-- ------------------------------------------------------------------

do $$
declare
  v_tbl record;
begin
  for v_tbl in select t as table_name from unnest(array['scanym_supported_countries', 'scanym_supported_currencies']) as t loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_tbl.table_name
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: table public.% introuvable — la migration Lot D initiale n''a peut-être pas été appliquée. Correctif annulé.', v_tbl.table_name;
    end if;

    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_tbl.table_name and c.relrowsecurity = true
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: RLS est déjà activée sur public.% — ce correctif a peut-être déjà été appliqué. Annulé pour éviter des policies en double (vérifier avant de relancer).', v_tbl.table_name;
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_tbl.table_name
    ) then
      raise exception 'SCANYM_SCHEMA_DRIFT: une policy existe déjà sur public.% alors que RLS n''est pas activée — état inattendu, examiner manuellement avant de relancer.', v_tbl.table_name;
    end if;
  end loop;

  -- Confirme aussi que le modèle de droits GRANT/REVOKE déjà en place
  -- (Lot D initiale) est bien celui attendu, avant d'ajouter RLS
  -- par-dessus — has_table_privilege résout les droits effectifs
  -- (leçon SA3-B01/B-04 réappliquée).
  if not has_table_privilege('authenticated', 'public.scanym_supported_countries', 'SELECT') then
    raise exception 'SCANYM_SCHEMA_DRIFT: authenticated n''a pas SELECT sur scanym_supported_countries — état inattendu, correctif annulé.';
  end if;
  if has_table_privilege('anon', 'public.scanym_supported_countries', 'SELECT') then
    raise exception 'SCANYM_SCHEMA_DRIFT: anon dispose déjà de SELECT sur scanym_supported_countries — état inattendu, correctif annulé.';
  end if;
end $$;


-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- 2a. Activation RLS — corrige l'omission constatée. N'affecte aucun
-- droit GRANT/REVOKE existant : RLS et les privilèges de table sont
-- deux mécanismes indépendants et cumulatifs (les deux doivent
-- autoriser l'accès pour qu'une lecture réussisse).
alter table public.scanym_supported_countries enable row level security;
alter table public.scanym_supported_currencies enable row level security;

-- 2b. Policy SELECT explicite pour authenticated uniquement — reflète
-- exactement le modèle déjà en vigueur au niveau des GRANT (Lot D
-- initiale), ne l'étend pas. `using (true)` ici est sans risque :
-- ces tables ne contiennent que des codes ISO publics (pays/devises
-- supportés), aucune donnée sensible ni scopée par établissement.
create policy "authenticated read supported countries"
  on public.scanym_supported_countries
  for select
  to authenticated
  using (true);

create policy "authenticated read supported currencies"
  on public.scanym_supported_currencies
  for select
  to authenticated
  using (true);

-- 2c. Réaffirmation documentaire des droits déjà en place (Lot D
-- initiale) — idempotent, sans effet si déjà correct, sert de
-- garde-fou explicite plutôt que de supposer silencieusement que
-- l'état antérieur est resté correct.
revoke all on table public.scanym_supported_countries from anon;
revoke all on table public.scanym_supported_currencies from anon;

revoke insert, update, delete
  on table public.scanym_supported_countries
  from authenticated, public;

revoke insert, update, delete
  on table public.scanym_supported_currencies
  from authenticated, public;

grant select on table public.scanym_supported_countries to authenticated;
grant select on table public.scanym_supported_currencies to authenticated;

commit;

-- ============================================================
-- Résumé des changements :
--   + RLS activée sur scanym_supported_countries et
--     scanym_supported_currencies (corrige le finding Security
--     Advisor 0013_rls_disabled_in_public, omis dans la migration
--     Lot D initiale)
--   + policy SELECT explicite pour authenticated sur chacune des
--     deux tables
--   ~ réaffirmation documentaire des GRANT/REVOKE déjà en place,
--     aucun changement de droit réel
-- Aucun autre objet DB modifié. create_establishment() reste
-- SECURITY DEFINER : elle continue de valider pays/devise contre ces
-- deux tables indépendamment de RLS (les fonctions SECURITY DEFINER
-- s'exécutent avec les privilèges de leur propriétaire, RLS ne les
-- concerne pas pour leurs propres requêtes internes) — vérifié
-- empiriquement, voir le harnais de tests.
-- ============================================================
