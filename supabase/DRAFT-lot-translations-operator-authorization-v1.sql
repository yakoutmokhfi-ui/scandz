-- ============================================================
-- Scanym — LOT 02 — TRANSLATIONS OPERATOR AUTHORIZATION v1 (refresh)
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO (GO MEP), jamais directement sur Production par
-- ce lot.
--
-- Baseline requis : 051893071fee337340af600cab7c01ffed8b8f7a
-- (main, tree f5743b5d36e0668b1788aed70881aab90fb49c8f).
--
-- PROBLÈME MÉTIER : en contexte opérateur (ex. Au Lait Cru), la page
-- Dashboard "Langues & Traductions" affiche "Not authorized for this
-- restaurant" : get_restaurant_translation_settings(uuid)
-- (migration-v81-lot1b-translations.sql, section 2e) ne reconnaît QUE
-- la membership restaurant_users. Les deux autres lectures de la page
-- ne bloquent pas l'opérateur (get_merchant_catalogue : bypass déjà
-- ajouté par OB-2 v1.1 ; get_restaurant_active_languages : lecture
-- publique). L'écriture (write_translation) passe DÉJÀ par
-- assert_restaurant_asset_role (owner/manager/opérateur) -- l'opérateur
-- pouvait donc écrire mais pas lire : incohérence fermée ici.
--
-- CONCEPTION MINIMALE (même patron exact que DRAFT-lot-catalogue-
-- operator-authorization-v1.sql, get_merchant_catalogue v1.1) :
--   UNE SEULE fonction modifiée, UN SEUL prédicat étendu :
--   `if not exists (restaurant_users ...) then raise` devient
--   `if not exists (restaurant_users ...) and not
--   public.is_scanym_operator() then raise`.
--   - Condition membership existante préservée À L'IDENTIQUE (aucun
--     filtre de rôle, comme avant : owner/manager/staff membres
--     gardent exactement le même accès lecture).
--   - Signature, forme de retour (6 colonnes), message et code
--     d'erreur (28000 / 42501) INCHANGÉS -- un refus reste une
--     exception explicite, jamais un résultat vide silencieux.
--   - CREATE OR REPLACE : OID et GRANT existants préservés
--     (authenticated EXECUTE, anon/public sans EXECUTE).
--
-- HORS PÉRIMÈTRE, VOLONTAIREMENT :
--   - write_translation et assert_restaurant_asset_role NON modifiés
--     (aucun élargissement de l'autorisation d'écriture).
--   - Aucune modification UI/TypeScript, aucune table, colonne, policy
--     ni GRANT. Aucune ligne restaurant_users factice pour l'opérateur.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE (lecture seule, avant toute
--    transaction -- si ce bloc échoue, rien n'a été touché).
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  -- 0a. Signature ET forme de retour exactes attendues.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_restaurant_translation_settings'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) = 'TABLE(source_language text, intro_text text, intro_text_hash text, announcement_text text, announcement_text_hash text, translations jsonb)'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_restaurant_translation_settings(uuid) introuvable ou forme de retour différente -- LOT 02 annulé, aucune modification appliquée.';
  end if;

  -- 0b. Dépendance directe : is_scanym_operator() doit exister.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator() introuvable -- LOT 02 annulé.';
  end if;

  -- 0c. Garde anti-double-application.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_restaurant_translation_settings'
    and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid';
  if v_def ilike '%is_scanym_operator%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_restaurant_translation_settings référence déjà is_scanym_operator -- LOT 02 déjà appliqué ou conflit, annulé.';
  end if;

  -- 0d. Propriétaire / SECURITY DEFINER / search_path attendus.
  for v_def in
    select pg_get_userbyid(p.proowner) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_restaurant_translation_settings', 'is_scanym_operator')
  loop
    if v_def not like 'postgres|true|%search_path=%' then
      raise exception 'SCANYM_SCHEMA_DRIFT: fonction non postgres/SECURITY DEFINER/search_path fixé comme attendu (%) -- LOT 02 annulé.', v_def;
    end if;
  end loop;
end $$;


begin;

-- ------------------------------------------------------------------
-- 1. get_restaurant_translation_settings -- ajout du bypass opérateur,
--    corps identique par ailleurs (migration-v81-lot1b-translations.sql,
--    section 2e).
-- ------------------------------------------------------------------
create or replace function public.get_restaurant_translation_settings(p_restaurant_id uuid)
returns table (
  source_language        text,
  intro_text             text,
  intro_text_hash        text,
  announcement_text      text,
  announcement_text_hash text,
  translations           jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  -- LOT 02 : membre DU restaurant (contrat existant, préservé À
  -- L'IDENTIQUE, sans filtre de rôle), OU opérateur Scanym global
  -- (bypass inconditionnel, même patron que get_merchant_catalogue
  -- OB-2 v1.1 et assert_restaurant_asset_role).
  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  return query
  select rc.source_language, rc.intro_text, rc.intro_text_hash,
         rc.announcement_text, rc.announcement_text_hash, rc.translations
  from public.restaurant_configs rc
  where rc.restaurant_id = p_restaurant_id;
end $$;

-- ------------------------------------------------------------------
-- 2. VÉRIFICATION POST-APPLICATION -- AVANT commit; (un échec ici
--    annule toute la transaction).
-- ------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_restaurant_translation_settings'
    and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
    and pg_get_function_result(p.oid) = 'TABLE(source_language text, intro_text text, intro_text_hash text, announcement_text text, announcement_text_hash text, translations jsonb)';

  if v_def is null then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: signature/forme de retour de get_restaurant_translation_settings modifiée.';
  end if;
  if v_def not ilike '%is_scanym_operator%' or v_def not ilike '%restaurant_users%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_restaurant_translation_settings ne combine pas membership restaurant_users ET is_scanym_operator.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_restaurant_translation_settings'
      and pg_get_userbyid(p.proowner) = 'postgres' and p.prosecdef
      and 'search_path=""' = any (p.proconfig)
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: SECURITY DEFINER/search_path/propriétaire perdu sur get_restaurant_translation_settings.';
  end if;

  if has_function_privilege('anon', 'public.get_restaurant_translation_settings(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur get_restaurant_translation_settings, jamais attendu.';
  end if;
  if not has_function_privilege('authenticated', 'public.get_restaurant_translation_settings(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur get_restaurant_translation_settings.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport au baseline 05189307 :
--   ~ get_restaurant_translation_settings(uuid) : ajout du bypass
--     is_scanym_operator(), corps identique par ailleurs.
--   AUCUNE signature / forme de retour / message / code d'erreur
--   modifié. AUCUN GRANT modifié. write_translation INCHANGÉE.
--   Rollback : DRAFT-lot-translations-operator-authorization-v1-rollback.sql
-- ============================================================
