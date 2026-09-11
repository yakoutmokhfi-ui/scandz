-- ============================================================
-- Scanym — OPERATOR DASHBOARD — DELIVERY PRICING OPERATOR
-- AUTHORIZATION v1.1 — CIO GO — IMPLEMENT APPROVED MINIMAL DELTA
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
--
-- Baseline requis : 820bfee4307749191c70f418bbfc195b7ec3befb (main).
--
-- CONTEXTE (reconnaissance obligatoire, voir v1 STOP-REPORT.md pour
-- le détail complet de la découverte empirique) : Operator Dashboard
-- Context v1/v1.1/v1.2 (déjà publié) résout CORRECTEMENT le
-- restaurant ciblé côté client pour un opérateur Scanym (F-01,
-- ?r=<id> fait foi, pas de repli silencieux sur next[0]).
-- app/dashboard/delivery-pricing/page.tsx applique déjà ce même
-- patron F-01 pour l'AFFICHAGE -- MAIS l'AUTORISATION D'ÉDITION
-- (`canEdit`) ne consulte JAMAIS `isOperator`, et
-- get_merchant_delivery_fulfillment_pricing(uuid) /
-- update_merchant_delivery_fulfillment_pricing(...) (DASHBOARD
-- DELIVERY PRICING v1, déjà publié) n'autorisent aujourd'hui QUE
-- public.is_member_of(p_restaurant_id) / has_role_in(...,
-- ['owner','manager']) -- vérifié empiriquement (PostgreSQL réelle,
-- v1 STOP-REPORT.md) : un opérateur authentique, ciblant un
-- établissement HORS de ses propres rattachements restaurant_users,
-- échoue en LECTURE ET EN ÉCRITURE avec 42501 "Not authorized for
-- this restaurant".
--
-- Ce lot ferme EXACTEMENT ce gap, avec le delta minimal proposé dans
-- le rapport STOP v1 et approuvé verbatim par le CIO (v1.1 GO) --
-- même patron que DRAFT-lot-catalogue-operator-authorization-v1.sql
-- (OB-2) et DRAFT-lot-payment-operator-authorization-v1.sql : `and
-- not public.is_scanym_operator()` ajouté À CÔTÉ de chaque contrôle
-- existant, préservé À L'IDENTIQUE, jamais un remplacement.
--
-- STRICT SQL LOCK (mandat v1.1) — PÉRIMÈTRE STRICT :
--   - DEUX fonctions modifiées, AUCUNE AUTRE :
--     public.get_merchant_delivery_fulfillment_pricing(uuid)
--     public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text)
--   - AUCUNE signature modifiée. AUCUNE forme de retour modifiée.
--   - AUCUN message ni code d'erreur modifié (toujours 42501 / "Not
--     authorized for this restaurant").
--   - AUCUN GRANT élargi (anon/public restent sans EXECUTE ;
--     authenticated garde EXECUTE, inchangé).
--   - AUCUNE policy RLS ajoutée, AUCUN GRANT direct ajouté sur
--     restaurant_sale_mode_fulfillments (le garde-fou existant,
--     réaffirmé ci-dessous en section 3, reste inchangé).
--   - Les conditions existantes (`is_member_of(p_restaurant_id)` en
--     lecture, `has_role_in(v_restaurant_id, array['owner',
--     'manager'])` en écriture) sont PRÉSERVÉES À L'IDENTIQUE : un
--     `and not public.is_scanym_operator()` est simplement ajouté À
--     CÔTÉ (polarité conjonction, cohérente avec la forme `if not X
--     and not Y then raise` déjà utilisée par ce lot ET par le lot
--     Payment Operator Authorization v1), jamais une réécriture ou
--     un remplacement de la condition marchande existante.
--   - AUCUNE modification de la validation numérique DDP-V1-01
--     (scanym_numeric_is_non_finite, contraintes CHECK NaN/Infinity)
--     -- fonction/contraintes non touchées par ce lot.
--   - AUCUNE modification des champs structurels (restaurant_id,
--     mode_code, fulfillment_code, provider, zone_prefixes,
--     is_fallback, display_order, enabled, min_items) -- toujours
--     non exposés en écriture par ce chemin, comme avant ce lot.
--   - AUCUN nouveau primitif d'autorisation : réutilise TEL QUEL
--     public.is_scanym_operator() (migration-lotd-establishment-
--     creation.sql, déjà audité/publié, déjà réutilisé par OB-2 et
--     Payment Operator Authorization v1).
--
-- HORS PÉRIMÈTRE, VOLONTAIREMENT (mandat v1 et v1.1) :
--   - AUCUNE nouvelle fonctionnalité, AUCUN nouveau mode de
--     tarification, AUCUNE tarification Stuart dynamique, AUCUNE
--     propagation de frais de livraison vers commandes/paiements/
--     factures.
--   - AUCUNE modification de Checkout, Invoice Request, email
--     validation, Catalogue, Bulk Product Photos, OB-4, Payment,
--     Stuart, Fulfillment routing -- zéro overlap avec les streams
--     parallèles ou lots précédents.
--   - AUCUNE ligne restaurant_users factice n'est jamais créée pour
--     un opérateur -- is_scanym_operator() reste un primitif
--     INDÉPENDANT (table public.scanym_operators), jamais un
--     contournement de restaurant_users.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (lecture seule, avant
--    toute transaction -- si ce bloc échoue, rien n'a encore été
--    touché). Même patron que DRAFT-lot-payment-operator-
--    authorization-v1.sql / DRAFT-lot-catalogue-operator-
--    authorization-v1.sql.
-- ------------------------------------------------------------------
do $$
begin
  -- 0a. Les deux fonctions ciblées doivent exister avec EXACTEMENT
  -- la signature et la forme de retour attendues (état courant,
  -- DASHBOARD DELIVERY PRICING v1 déjà publié, baseline 820bfee4).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_delivery_fulfillment_pricing'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) = 'TABLE(rule_id uuid, fulfillment_label text, pricing_mode text, fixed_fee numeric, free_threshold numeric, customer_text text)'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_delivery_fulfillment_pricing(uuid) introuvable ou signature/forme de retour différente -- DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 annulé, aucune modification appliquée.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_delivery_fulfillment_pricing'
      and pg_get_function_identity_arguments(p.oid) = 'p_rule_id uuid, p_pricing_mode text, p_fixed_fee numeric, p_free_threshold numeric, p_customer_text text'
      and pg_get_function_result(p.oid) = 'void'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) introuvable ou signature/forme de retour différente -- annulé, aucune modification appliquée.';
  end if;

  -- 0b. is_scanym_operator() / is_member_of / has_role_in doivent
  -- déjà exister (dépendances directes, primitifs d'autorisation
  -- déjà audités/publiés -- réutilisés, jamais réinventés).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: is_scanym_operator() introuvable -- DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.is_member_of introuvable -- annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_role_in'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.has_role_in introuvable -- annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'scanym_numeric_is_non_finite'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.scanym_numeric_is_non_finite introuvable -- prérequis DDP-V1-01 manquant, annulé.';
  end if;

  -- 0c. Garde anti-double-application.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_delivery_fulfillment_pricing'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_delivery_fulfillment_pricing référence déjà is_scanym_operator -- déjà appliqué ou conflit, annulé.';
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_delivery_fulfillment_pricing'
      and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_merchant_delivery_fulfillment_pricing référence déjà is_scanym_operator -- déjà appliqué ou conflit, annulé.';
  end if;

  -- 0d. Propriétaire / SECURITY DEFINER / search_path inchangés
  -- avant modification, pour les deux fonctions.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_delivery_fulfillment_pricing'
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef = true
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_merchant_delivery_fulfillment_pricing n''est pas postgres/SECURITY DEFINER/search_path fixé comme attendu -- annulé.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_delivery_fulfillment_pricing'
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef = true
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: update_merchant_delivery_fulfillment_pricing n''est pas postgres/SECURITY DEFINER/search_path fixé comme attendu -- annulé.';
  end if;
end $$;


begin;

-- ------------------------------------------------------------------
-- 1. get_merchant_delivery_fulfillment_pricing -- ajout du bypass
--    opérateur, corps IDENTIQUE par ailleurs
--    (DRAFT-lot-merchant-delivery-pricing.sql, déjà publiée).
--    CREATE OR REPLACE : signature ET forme de retour INCHANGÉES,
--    préserve les GRANT existants sans les élargir.
--
--    Owner/manager/staff (membership sans filtre de rôle, contrat
--    existant) gardent EXACTEMENT le même accès lecture qu'avant ce
--    lot : la condition `is_member_of(...)` existante est
--    intégralement préservée, seul un `and not
--    public.is_scanym_operator()` est ajouté à côté (forme "if not X
--    and not Y then raise", identique à la structure déjà utilisée
--    ci-dessous en écriture et par le lot Payment Operator
--    Authorization v1).
-- ------------------------------------------------------------------
create or replace function public.get_merchant_delivery_fulfillment_pricing(
  p_restaurant_id uuid
)
returns table (
  rule_id           uuid,
  fulfillment_label text,
  pricing_mode      text,
  fixed_fee         numeric,
  free_threshold    numeric,
  customer_text     text
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

  -- DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 : membre
  -- (owner/manager/staff) DU restaurant (contrat existant, préservé
  -- À L'IDENTIQUE), OU opérateur Scanym global (bypass
  -- inconditionnel, même patron que OB-2 / Payment Operator
  -- Authorization v1 -- primitif is_scanym_operator() réutilisé sans
  -- modification). Aucune ligne restaurant_users factice n'est
  -- jamais créée pour un opérateur.
  if not public.is_member_of(p_restaurant_id)
     and not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  return query
  select
    f.id as rule_id,
    (
      (case when f.is_fallback then 'Livraison (option de repli)' else 'Livraison' end)
      || case
           when f.zone_prefixes is not null and array_length(f.zone_prefixes, 1) > 0
             then ' — zones ' || array_to_string(f.zone_prefixes, ', ')
           else ''
         end
    ) as fulfillment_label,
    f.pricing_mode,
    f.fixed_fee,
    f.free_threshold,
    f.customer_text
  from public.restaurant_sale_mode_fulfillments f
  where f.restaurant_id = p_restaurant_id
    and f.mode_code = 'delivery'
  order by f.display_order;
end;
$$;

comment on function public.get_merchant_delivery_fulfillment_pricing(uuid) is
  'Lecture marchande ET opérateur (DELIVERY PRICING OPERATOR AUTHORIZATION v1.1, sur la base de DASHBOARD DELIVERY PRICING v1) des règles de tarification livraison -- rule_id/fulfillment_label/pricing_mode/fixed_fee/free_threshold/customer_text UNIQUEMENT, jamais provider/fulfillment_code bruts. Autorisation : is_member_of(p_restaurant_id) [owner/manager/staff, contrat marchand inchangé] OR is_scanym_operator() [opérateur Scanym global, aucune ligne restaurant_users requise, aucun nouveau primitif]. SECURITY DEFINER, search_path vide, aucun SQL dynamique.';

revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public, anon;
grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;

-- ------------------------------------------------------------------
-- 2. update_merchant_delivery_fulfillment_pricing -- ajout du bypass
--    opérateur, corps IDENTIQUE par ailleurs (même fichier
--    DASHBOARD DELIVERY PRICING v1). CREATE OR REPLACE : signature
--    ET forme de retour INCHANGÉES. AUCUNE modification de la
--    validation DDP-V1-01 (NaN/Infinity), AUCUNE modification de la
--    résolution tenant AVANT vérification de rôle (préservée EN
--    PREMIER, comme avant ce lot -- une règle inexistante ou d'un
--    autre tenant échoue toujours au même endroit, 42501, sans
--    indice différentiel).
--
--    Owner/manager gardent EXACTEMENT le même accès écriture qu'avant
--    ce lot : la condition `has_role_in(v_restaurant_id,
--    array['owner', 'manager'])` existante est intégralement
--    préservée, seul un `and not public.is_scanym_operator()` est
--    ajouté à côté.
-- ------------------------------------------------------------------
create or replace function public.update_merchant_delivery_fulfillment_pricing(
  p_rule_id        uuid,
  p_pricing_mode   text,
  p_fixed_fee      numeric,
  p_free_threshold numeric,
  p_customer_text  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_mode_code     text;
  v_clean_text    text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  -- Résolution tenant AVANT toute vérification de rôle : une règle
  -- inexistante ou appartenant à un autre tenant échoue au même
  -- endroit (42501 via has_role_in/is_scanym_operator ci-dessous,
  -- JAMAIS d'indice sur l'existence d'une règle chez un tenant tiers
  -- -- mutation cross-tenant rejetée, aucune ligne modifiée).
  -- INCHANGÉ par ce lot.
  select f.restaurant_id, f.mode_code into v_restaurant_id, v_mode_code
  from public.restaurant_sale_mode_fulfillments f
  where f.id = p_rule_id;

  if v_restaurant_id is null or v_mode_code is distinct from 'delivery' then
    raise exception using errcode = 'P0002', message = 'Delivery fulfillment rule not found';
  end if;

  -- DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 : owner/manager DU
  -- restaurant résolu ci-dessus (contrat existant, préservé À
  -- L'IDENTIQUE), OU opérateur Scanym global (bypass inconditionnel,
  -- même primitif is_scanym_operator() réutilisé sans modification,
  -- même forme "if not X and not Y then raise" que la lecture
  -- ci-dessus et que le lot Payment Operator Authorization v1).
  -- Aucun rôle staff n'obtient l'écriture par ce lot (staff n'était
  -- déjà pas autorisé avant ce lot, et ne l'est toujours pas --
  -- seule la condition opérateur est ajoutée, la liste de rôles
  -- marchands ['owner', 'manager'] n'est pas modifiée).
  if not public.has_role_in(
       v_restaurant_id,
       array['owner', 'manager']
     )
     and not public.is_scanym_operator() then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  -- ------------------------------------------------------------
  -- Validation fail-closed, indépendante par mode -- INCHANGÉE par
  -- ce lot (DDP-V1-01 NaN/Infinity hardening préservé à l'identique).
  -- ------------------------------------------------------------
  if p_pricing_mode is null or p_pricing_mode not in ('fixed', 'free_above_threshold') then
    raise exception using errcode = '22023', message = 'Invalid pricing_mode';
  end if;

  if p_fixed_fee is not null and public.scanym_numeric_is_non_finite(p_fixed_fee) then
    raise exception using errcode = '22023', message = 'fixed_fee must be a finite numeric value (NaN/Infinity not allowed)';
  end if;

  if p_fixed_fee is null or p_fixed_fee < 0 then
    raise exception using errcode = '22023', message = 'fixed_fee is required and must be >= 0';
  end if;

  if p_pricing_mode = 'fixed' then
    if p_free_threshold is not null then
      raise exception using errcode = '22023', message = 'free_threshold must be NULL when pricing_mode = fixed';
    end if;
  elsif p_pricing_mode = 'free_above_threshold' then
    if p_free_threshold is not null and public.scanym_numeric_is_non_finite(p_free_threshold) then
      raise exception using errcode = '22023', message = 'free_threshold must be a finite numeric value (NaN/Infinity not allowed)';
    end if;
    if p_free_threshold is null or p_free_threshold < 0 then
      raise exception using errcode = '22023', message = 'free_threshold is required and must be >= 0 when pricing_mode = free_above_threshold';
    end if;
  end if;

  v_clean_text := nullif(trim(coalesce(p_customer_text, '')), '');
  if v_clean_text is not null and length(v_clean_text) > 500 then
    raise exception using errcode = '22023', message = 'customer_text exceeds 500 characters';
  end if;

  update public.restaurant_sale_mode_fulfillments
  set pricing_mode   = p_pricing_mode,
      fixed_fee      = p_fixed_fee,
      free_threshold = p_free_threshold,
      customer_text  = v_clean_text
  where id = p_rule_id
    and mode_code = 'delivery';

  if not found then
    raise exception using errcode = 'P0002', message = 'Delivery fulfillment rule not found';
  end if;
end;
$$;

comment on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) is
  'Écriture marchande ET opérateur (DELIVERY PRICING OPERATOR AUTHORIZATION v1.1, sur la base de DASHBOARD DELIVERY PRICING v1) de 4 champs éditables (pricing_mode, fixed_fee, free_threshold, customer_text) UNIQUEMENT -- aucun champ structurel exposé. Autorisation : has_role_in(v_restaurant_id, [owner, manager]) [contrat marchand inchangé] OR is_scanym_operator() [opérateur Scanym global]. Validation DDP-V1-01 (NaN/Infinity) inchangée. SECURITY DEFINER, search_path vide.';

revoke all on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) from public, anon;
grant execute on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) to authenticated;

-- ------------------------------------------------------------
-- 3. GARDE-FOU EXPLICITE RÉAFFIRMÉ (inchangé par rapport à
-- DRAFT-lot-merchant-delivery-pricing.sql) : aucun GRANT direct
-- n'est ajouté sur la table elle-même -- toute écriture continue de
-- passer exclusivement par update_merchant_delivery_fulfillment_pricing
-- (SECURITY DEFINER). AUCUNE régression introduite par ce lot.
-- ------------------------------------------------------------
do $$
begin
  if has_table_privilege('authenticated', 'public.restaurant_sale_mode_fulfillments', 'UPDATE') then
    raise exception 'SCANYM_UPDATE_GRANT_UNEXPECTED: authenticated a un privilège UPDATE direct sur restaurant_sale_mode_fulfillments -- ce lot exige que toute écriture passe exclusivement par update_merchant_delivery_fulfillment_pricing (SECURITY DEFINER), migration annulée.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 4. VÉRIFICATION POST-APPLICATION -- TOUJOURS AVANT commit; (un
--    échec ici déclenche un ROLLBACK automatique complet, aucune
--    modification partielle ne peut jamais rester committée).
-- ------------------------------------------------------------------
do $$
declare
  v_def_read  text;
  v_def_write text;
begin
  select pg_get_functiondef(p.oid) into v_def_read
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_merchant_delivery_fulfillment_pricing';

  select pg_get_functiondef(p.oid) into v_def_write
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'update_merchant_delivery_fulfillment_pricing';

  -- 4a. Les deux corps référencent désormais is_scanym_operator.
  if v_def_read not ilike '%is_scanym_operator%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_delivery_fulfillment_pricing ne référence pas is_scanym_operator après application.';
  end if;
  if v_def_write not ilike '%is_scanym_operator%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_merchant_delivery_fulfillment_pricing ne référence pas is_scanym_operator après application.';
  end if;

  -- 4b. Les conditions marchandes existantes sont toujours présentes,
  -- INCHANGÉES -- non-régression marchande.
  if v_def_read not ilike '%is_member_of(p_restaurant_id)%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_delivery_fulfillment_pricing a perdu sa condition marchande is_member_of après application.';
  end if;
  if v_def_write not ilike '%has_role_in(%' or v_def_write not ilike '%owner%' or v_def_write not ilike '%manager%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_merchant_delivery_fulfillment_pricing a perdu sa condition marchande has_role_in(owner/manager) après application.';
  end if;

  -- 4c. Validation DDP-V1-01 (NaN/Infinity) toujours présente,
  -- inchangée.
  if v_def_write not ilike '%scanym_numeric_is_non_finite%' then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_merchant_delivery_fulfillment_pricing a perdu la validation DDP-V1-01 (scanym_numeric_is_non_finite) après application.';
  end if;

  -- 4d. SECURITY DEFINER / search_path / propriétaire préservés, les
  -- deux fonctions.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_delivery_fulfillment_pricing'
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef = true
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: get_merchant_delivery_fulfillment_pricing a perdu SECURITY DEFINER/search_path/propriétaire postgres après application.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_delivery_fulfillment_pricing'
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef = true
      and array_to_string(p.proconfig, ',') like '%search_path=%'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: update_merchant_delivery_fulfillment_pricing a perdu SECURITY DEFINER/search_path/propriétaire postgres après application.';
  end if;

  -- 4e. Signature ET forme de retour INCHANGÉES, les deux fonctions.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_delivery_fulfillment_pricing'
      and pg_get_function_identity_arguments(p.oid) = 'p_restaurant_id uuid'
      and pg_get_function_result(p.oid) = 'TABLE(rule_id uuid, fulfillment_label text, pricing_mode text, fixed_fee numeric, free_threshold numeric, customer_text text)'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: signature ou forme de retour de get_merchant_delivery_fulfillment_pricing a changé après application, jamais attendu.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_delivery_fulfillment_pricing'
      and pg_get_function_identity_arguments(p.oid) = 'p_rule_id uuid, p_pricing_mode text, p_fixed_fee numeric, p_free_threshold numeric, p_customer_text text'
      and pg_get_function_result(p.oid) = 'void'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: signature ou forme de retour de update_merchant_delivery_fulfillment_pricing a changé après application, jamais attendu.';
  end if;

  -- 4f. Aucun octroi élargi : anon/public toujours sans EXECUTE,
  -- authenticated toujours avec EXECUTE, les deux fonctions.
  if has_function_privilege('anon', 'public.get_merchant_delivery_fulfillment_pricing(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur get_merchant_delivery_fulfillment_pricing après application, jamais attendu.';
  end if;
  if not has_function_privilege('authenticated', 'public.get_merchant_delivery_fulfillment_pricing(uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur get_merchant_delivery_fulfillment_pricing après application.';
  end if;
  if has_function_privilege('anon', 'public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur update_merchant_delivery_fulfillment_pricing après application, jamais attendu.';
  end if;
  if not has_function_privilege('authenticated', 'public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a perdu EXECUTE sur update_merchant_delivery_fulfillment_pricing après application.';
  end if;

  -- 4g. Aucun octroi direct apparu sur la table sous-jacente.
  if has_table_privilege('authenticated', 'public.restaurant_sale_mode_fulfillments', 'UPDATE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated a un privilège UPDATE direct sur restaurant_sale_mode_fulfillments après application, jamais attendu.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport au baseline 820bfee430 (main) :
--   ~ get_merchant_delivery_fulfillment_pricing(uuid) : ajout du
--     bypass is_scanym_operator() (lecture), corps identique par
--     ailleurs (CREATE OR REPLACE, signature et forme de retour
--     INCHANGÉES).
--   ~ update_merchant_delivery_fulfillment_pricing(uuid, text,
--     numeric, numeric, text) : ajout du bypass is_scanym_operator()
--     (écriture), corps identique par ailleurs (CREATE OR REPLACE,
--     signature et forme de retour INCHANGÉES, validation DDP-V1-01
--     inchangée).
--   AUCUNE autre fonction modifiée. AUCUNE signature modifiée. AUCUN
--   message/code d'erreur modifié. AUCUNE nouvelle table/colonne.
--   AUCUN GRANT élargi (anon toujours sans EXECUTE, authenticated
--   inchangé ; restaurant_sale_mode_fulfillments reste sans UPDATE
--   direct anon/authenticated).
-- ============================================================
