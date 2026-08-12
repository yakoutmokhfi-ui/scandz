-- ============================================================
-- Scanym LOT D — Rollback du correctif RLS des tables de référence
--
-- NE JAMAIS EXÉCUTER AUTOMATIQUEMENT. Documenté pour référence
-- uniquement, à exécuter manuellement par le CTO en cas de besoin
-- réel, après revue.
--
-- Ce rollback retire la policy et désactive RLS, ramenant l'état
-- exact d'avant migration-lotd-rls-reference-tables-fix.sql (mais
-- PAS d'avant Lot D dans son ensemble : les tables, leurs données,
-- et les GRANT/REVOKE déjà en place depuis Lot D restent inchangés,
-- puisqu'ils ne sont pas modifiés par ce correctif).
-- ============================================================

begin;

drop policy if exists "authenticated read supported countries" on public.scanym_supported_countries;
drop policy if exists "authenticated read supported currencies" on public.scanym_supported_currencies;

alter table public.scanym_supported_countries disable row level security;
alter table public.scanym_supported_currencies disable row level security;

-- Les GRANT/REVOKE ne sont pas défaits ici : ils préexistaient à ce
-- correctif (depuis la migration Lot D initiale) et ne lui
-- appartiennent pas. Les défaire romprait le modèle d'accès déjà en
-- vigueur avant ce correctif, ce qui n'est pas l'objet d'un rollback
-- de CE fichier précisément.

commit;

-- Après ce rollback, le finding Security Advisor
-- 0013_rls_disabled_in_public réapparaîtra pour les deux tables —
-- c'est attendu, puisque ce rollback annule précisément la correction
-- de ce finding.
