-- ============================================================
-- Scanym — CATALOGUE / SUBCATEGORIES / BACK-OFFICE v1.1
-- STREAM A — MINIMUM REMEDIATION OF WORK AUDIT FINDINGS
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
--
-- Baseline requis pour CE fichier : le lot CATALOGUE / SUBCATEGORIES
-- BACKOFFICE v1 (supabase/DRAFT-lot-catalogue-subcategories-
-- backoffice-v1.sql) doit déjà être appliqué -- vérifié par le
-- contrôle préalable ci-dessous (section 0). Ce fichier ne modifie
-- JAMAIS ce fichier v1 (forward-only, même discipline que tout autre
-- lot de ce dépôt) : il ajoute deux correctifs additifs par-dessus.
--
-- Réponse à l'audit Work indépendant (FAIL — NOT READY FOR CIO GO) sur
-- CATALOGUE / SUBCATEGORIES BACKOFFICE v1, candidat HEAD
-- 9140e4c352a9ce2ca40be76e39c91e2b8ef2efaf. AUCUN redesign de
-- l'architecture catalogue -- strictement les 2 correctifs SQL requis
-- (le 3e finding, CAT-SUB-V1-PUBLIC-GROUPING-01, est un correctif
-- TypeScript pur côté lib/services/restaurant.ts et
-- lib/catalogue-subcategory-grouping.ts, sans aucune incidence SQL --
-- voir README-AUDIT.md / FINDINGS-REMEDIATION.md du paquet v1.1).
--
-- ------------------------------------------------------------------
-- CAT-SUB-V1-INTEGRITY-01 (HIGH) -- menu_subcategories.category_id
-- devient IMMUTABLE après création.
--
-- Problème : le trigger existant (v1,
-- enforce_menu_item_subcategory_category_match) valide les écritures
-- sur menu_items, mais RIEN n'empêchait un UPDATE direct de
-- menu_subcategories.category_id lui-même -- une sous-catégorie déjà
-- utilisée par des produits pourrait ainsi se retrouver rattachée à
-- une AUTRE catégorie (potentiellement d'un AUTRE restaurant), sans
-- qu'aucun produit existant ne soit lui-même touché : les produits
-- resteraient liés à cette sous-catégorie, désormais incohérente avec
-- leur propre category_id, cassant silencieusement l'invariant que le
-- trigger v1 ne vérifie qu'à l'écriture sur menu_items.
--
-- Correctif retenu (le plus simple, pas de sur-ingénierie) : un
-- trigger BEFORE UPDATE OF category_id sur menu_subcategories qui
-- rejette TOUTE tentative de changement de category_id, que la
-- sous-catégorie soit utilisée ou non par un produit -- l'immutabilité
-- est une propriété de la ligne elle-même, pas seulement de ses
-- lignes filles. Aucune logique de "déplacement inter-catégorie" n'est
-- introduite (hors périmètre explicite du mandat) : une sous-catégorie
-- mal placée doit être recréée dans la bonne catégorie, pas déplacée.
--
-- Défense en profondeur : ce trigger s'applique à TOUTE tentative
-- d'UPDATE de category_id, quel que soit l'appelant -- y compris un
-- rôle qui contourne RLS (service_role/bypassrls), puisqu'un trigger
-- PostgreSQL n'est jamais soumis aux policies RLS ni à leur
-- contournement (RLS filtre des LIGNES, un trigger s'exécute pour
-- CHAQUE ligne affectée, RLS ou non). Comme il s'exécute AVANT
-- l'écriture, DANS LA MÊME transaction que la tentative, il n'existe
-- structurellement AUCUNE fenêtre de course entre "vérifier" et
-- "écrire" pour un tiers, contrairement à un contrôle applicatif
-- SELECT-puis-UPDATE.
--
-- ------------------------------------------------------------------
-- CAT-SUB-V1-ACL-01 (MEDIUM) -- SELECT explicite sur menu_subcategories.
--
-- Problème confirmé empiriquement (voir le paquet v1.1 pour la preuve) :
-- une policy RLS ne confère JAMAIS, par elle-même, le privilège de
-- table SELECT -- sans un GRANT SELECT explicite, `anon`/`authenticated`
-- reçoivent "permission denied for table menu_subcategories" AVANT
-- même que RLS ne soit évaluée. La migration v1 révoquait
-- explicitement INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER mais
-- ne GRANTait JAMAIS explicitement SELECT, s'appuyant implicitement
-- sur un éventuel privilège par défaut du projet Supabase -- exactement
-- ce que l'audit Work interdit ("Do not rely on Supabase default
-- privileges"). Impact réel : la carte publique (lib/services/
-- restaurant.ts, requête PostgREST imbriquée menu_categories ->
-- menu_subcategories exécutée en tant que rôle anon) aurait échoué
-- pour tout commerçant utilisant des sous-catégories.
--
-- Correctif : GRANT SELECT explicite à anon ET authenticated,
-- idempotent (GRANT est un no-op si déjà accordé), avec vérification
-- post-application EXPLICITE que SELECT est bien accordé (le
-- postcheck v1 ne vérifiait que l'ABSENCE des droits d'écriture,
-- jamais la PRÉSENCE du droit de lecture).
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (lecture seule, avant
--    toute transaction). Même patron que toutes les migrations
--    précédentes de ce dépôt.
-- ------------------------------------------------------------------
do $$
begin
  -- 0a. Le lot v1 doit déjà être appliqué : table + colonne + les 2
  -- RPC sous-catégorie avec leur signature exacte v1.
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'menu_subcategories'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: table menu_subcategories introuvable -- CATALOGUE / SUBCATEGORIES BACKOFFICE v1 doit être appliqué avant v1.1, annulé.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_subcategories' and column_name = 'category_id'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: menu_subcategories.category_id introuvable -- annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_subcategory'
      and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte create_subcategory (v1) introuvable -- annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_subcategory'
      and pg_get_function_identity_arguments(p.oid) = 'p_subcategory_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: signature exacte update_subcategory (v1) introuvable -- annulé.';
  end if;

  -- 0b. Garde anti-double-application de CE lot v1.1 précisément :
  -- ni le trigger d'immutabilité ci-dessous ne doit déjà exister.
  if exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'menu_subcategories'
      and t.tgname = 'trg_menu_subcategories_category_immutable'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: trigger trg_menu_subcategories_category_immutable existe déjà -- CATALOGUE / SUBCATEGORIES BACKOFFICE v1.1 déjà appliqué ou conflit, annulé.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------------
-- 1. CAT-SUB-V1-INTEGRITY-01 -- menu_subcategories.category_id
--    IMMUTABLE après création (défense en profondeur, même patron que
--    enforce_menu_item_subcategory_category_match en v1 : SECURITY
--    DEFINER, search_path vide, revoke all explicite).
-- ------------------------------------------------------------------

create function public.enforce_menu_subcategory_category_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.category_id is distinct from old.category_id then
    raise exception 'SCANYM_SUBCATEGORY_CATEGORY_IMMUTABLE' using errcode = '0A000';
  end if;

  return new;
end $$;

comment on function public.enforce_menu_subcategory_category_immutable() is
  'CATALOGUE / SUBCATEGORIES v1.1 -- remédiation CAT-SUB-V1-INTEGRITY-01 (audit Work). Rejette TOUTE réassignation de menu_subcategories.category_id après création, utilisée ou non par un produit -- aucune logique de déplacement inter-catégorie de sous-catégorie n''existe ni n''est introduite (hors périmètre). S''applique à TOUT appelant, y compris un rôle qui contourne RLS (bypassrls) : un trigger n''est jamais soumis à RLS ni à son contournement.';

create trigger trg_menu_subcategories_category_immutable
  before update of category_id on public.menu_subcategories
  for each row
  execute function public.enforce_menu_subcategory_category_immutable();

revoke all on function public.enforce_menu_subcategory_category_immutable() from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 2. CAT-SUB-V1-ACL-01 -- SELECT explicite, jamais implicite, sur
--    menu_subcategories pour anon ET authenticated. Idempotent (GRANT
--    répété = no-op) ; ne modifie AUCUNE policy RLS existante (les 2
--    policies "lecture publique sous-categories actives"/"lecture
--    membre sous-categories" de v1 restent inchangées -- ce correctif
--    ajoute le privilège de TABLE requis pour qu'elles s'appliquent
--    réellement, il ne change jamais QUELLES lignes sont visibles).
-- ------------------------------------------------------------------

grant select on public.menu_subcategories to anon, authenticated;

-- ------------------------------------------------------------------
-- 3. VÉRIFICATION POST-APPLICATION -- TOUJOURS AVANT commit; (même
--    patron qu'en v1 : un échec ici déclenche un ROLLBACK complet).
-- ------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- Trigger d'immutabilité présent.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'menu_subcategories'
      and t.tgname = 'trg_menu_subcategories_category_immutable'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: trigger d''immutabilité category_id introuvable après création.';
  end if;

  -- SELECT explicitement accordé -- PRÉSENCE vérifiée (pas seulement
  -- l'absence des droits d'écriture, qui l'était déjà en v1).
  if not has_table_privilege('anon', 'public.menu_subcategories', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon n''a pas SELECT sur menu_subcategories après GRANT explicite.';
  end if;
  if not has_table_privilege('authenticated', 'public.menu_subcategories', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated n''a pas SELECT sur menu_subcategories après GRANT explicite.';
  end if;

  -- Invariant v1 ré-vérifié à l'identique : toujours AUCUN droit
  -- d'écriture direct pour anon/authenticated (ce lot ne l'a jamais
  -- touché, seul SELECT a été ajouté).
  if has_table_privilege('anon', 'public.menu_subcategories', 'INSERT')
     or has_table_privilege('anon', 'public.menu_subcategories', 'UPDATE')
     or has_table_privilege('anon', 'public.menu_subcategories', 'DELETE')
     or has_table_privilege('authenticated', 'public.menu_subcategories', 'INSERT')
     or has_table_privilege('authenticated', 'public.menu_subcategories', 'UPDATE')
     or has_table_privilege('authenticated', 'public.menu_subcategories', 'DELETE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: menu_subcategories a un droit d''écriture direct pour anon/authenticated après ce lot v1.1, jamais attendu.';
  end if;

  -- RLS toujours active (ce lot ne la désactive jamais).
  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'menu_subcategories' and c.relrowsecurity = true;
  if v_count <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RLS non active sur menu_subcategories après ce lot v1.1.';
  end if;

  -- Les 2 RPC sous-catégorie restent inchangées par ce lot (signature
  -- exacte v1 toujours en place).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_subcategory'
      and pg_get_function_identity_arguments(p.oid) = 'p_category_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: signature create_subcategory modifiée de façon inattendue par ce lot v1.1.';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_subcategory'
      and pg_get_function_identity_arguments(p.oid) = 'p_subcategory_id uuid, p_name text, p_display_order integer'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: signature update_subcategory modifiée de façon inattendue par ce lot v1.1.';
  end if;

  -- anon/public n'ont jamais EXECUTE sur la nouvelle fonction trigger.
  if has_function_privilege('anon', 'public.enforce_menu_subcategory_category_immutable()', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur enforce_menu_subcategory_category_immutable, jamais attendu.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport à CATALOGUE / SUBCATEGORIES
-- BACKOFFICE v1 :
--   + trigger trg_menu_subcategories_category_immutable (BEFORE UPDATE
--     OF category_id) + sa fonction, rejette toute réassignation de
--     category_id sur une sous-catégorie existante, utilisée ou non.
--   + grant select on menu_subcategories to anon, authenticated
--     (explicite, jamais implicite/hérité d'un privilège par défaut).
--   Aucune policy RLS modifiée. Aucune RPC modifiée. Aucun changement
--   de comportement pour create_subcategory/update_subcategory/
--   create_product/update_product/get_merchant_catalogue.
-- ============================================================
