-- ============================================================
-- Scanym — DASHBOARD DELIVERY PRICING v1 (SAFE MERCHANT EDITING ONLY)
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- Mission : "SCANYM — CIO REQUIREMENT — DASHBOARD DELIVERY PRICING v1
-- — SAFE MERCHANT EDITING ONLY — KEEP IT SIMPLE — IMPLEMENT → TEST →
-- PACKAGE → STOP FOR WORK AUDIT".
--
-- PÉRIMÈTRE STRICT (ne construit RIEN d'autre) : donne au marchand
-- (owner/manager) le droit de modifier UNIQUEMENT 4 champs de ses
-- règles de livraison DÉJÀ configurées par Scanym :
--   pricing_mode, fixed_fee, free_threshold, customer_text
-- Tout le reste (restaurant_id, mode_code, fulfillment_code, provider,
-- zone_prefixes, is_fallback, display_order, enabled, min_items) reste
-- STRUCTUREL et géré exclusivement par Scanym (DRAFT tenant + SQL
-- CIO) — aucune de ces colonnes n'est acceptée en entrée des fonctions
-- ci-dessous, ni exposée en écriture d'aucune façon.
--
-- CE FICHIER EST GÉNÉRIQUE (aucune donnée tenant, aucun restaurant_id,
-- aucun code postal, aucun nom de prestataire codé en dur) et
-- DÉTERMINISTE — compatible PostgreSQL 17.6, même patron que les
-- lots précédents (DRAFT-lot-fulfillment-routing-model.sql,
-- DRAFT-lot-server-delivery-fulfillment-pricing.sql). Suit exactement
-- le patron d'autorisation déjà en Production pour les mutations
-- marchand (voir update_restaurant_settings, migration-v39-settings.sql :
-- auth.uid() null -> 28000 ; rôle owner/manager insuffisant -> 42501),
-- et réutilise TEL QUEL public.is_member_of / public.has_role_in
-- (migration-orders.sql) au lieu de dupliquer la logique d'appartenance.
--
-- DEUX FONCTIONS SECURITY DEFINER, AUCUNE AUTRE SURFACE :
--   1. get_merchant_delivery_fulfillment_pricing(p_restaurant_id)
--      -- LECTURE, tout membre (owner/manager/staff) de restaurant_users,
--      -- ne retourne JAMAIS `provider` ni `fulfillment_code` bruts --
--      -- une étiquette lisible est composée UNIQUEMENT à partir de
--      -- champs génériques déjà présents (is_fallback, zone_prefixes),
--      -- jamais d'un mapping codé en dur par fulfillment_code/tenant.
--   2. update_merchant_delivery_fulfillment_pricing(p_rule_id, ...)
--      -- ÉCRITURE, owner/manager UNIQUEMENT, valide chaque combinaison
--      -- pricing_mode/fixed_fee/free_threshold indépendamment,
--      -- fail-closed strict (aucun défaut à 'free'/0, aucune conversion
--      -- silencieuse), vérifie l'appartenance tenant AVANT toute
--      -- mutation (cross-tenant => 42501, aucune ligne modifiée).
--
-- Aucune policy RLS UPDATE/INSERT n'est ajoutée sur
-- restaurant_sale_mode_fulfillments — aucun GRANT UPDATE n'est donné à
-- `authenticated` sur cette table. L'écriture ne peut se faire QUE via
-- update_merchant_delivery_fulfillment_pricing (SECURITY DEFINER),
-- conformément à "Do NOT grant authenticated users direct UPDATE" /
-- "Do NOT add a broad UPDATE RLS policy" (mission, section SECURITY).
--
-- ⚠️ NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION dans ce lot sans GO
-- CIO explicite après Work audit. Testable uniquement dans le harnais
-- PostgreSQL jetable (supabase/tests/merchant-delivery-pricing-check.sh).
--
-- ------------------------------------------------------------
-- CORRECTION APRÈS AUDIT WORK — DDP-V1-01 (HIGH) — NaN MONETARY
-- HARDENING. Finding : "numeric NaN bypasses delivery pricing
-- validation". Mécanisme exact (vérifié empiriquement, PostgreSQL
-- 16.13) : le type `numeric` de PostgreSQL a un ordre total NON
-- standard où `'NaN'::numeric >= 0` est VRAI et `'NaN'::numeric < 0`
-- est FAUX (contrairement à IEEE-754) -- les gardes existantes
-- (`p_fixed_fee < 0` / `fixed_fee >= 0`) laissaient donc passer NaN.
-- `'Infinity'::numeric` partage exactement le même défaut
-- (`>= 0` est VRAI) et PostgreSQL peut réellement persister cette
-- valeur dans une colonne `numeric` (vérifié : `select
-- 'Infinity'::numeric;` réussit) -- donc traité ici aussi, dans le
-- même correctif, pour la même raison exacte que NaN (pas
-- d'extension spéculative : -Infinity était déjà rejeté par `< 0`).
-- Le test classique `x <> x` ne fonctionne PAS non plus ici, car
-- `'NaN'::numeric = 'NaN'::numeric` est VRAI en PostgreSQL --
-- d'où une comparaison explicite par égalité (voir
-- scanym_numeric_is_non_finite ci-dessous), section 1.5.
--
-- Ce correctif ferme UNIQUEMENT ce trou : aucune autre logique de ce
-- fichier n'est modifiée (le périmètre marchand strict de la mission
-- d'origine reste identique).
-- ------------------------------------------------------------
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) : ce lot dépend de SADFP v3
-- (pricing_mode/fixed_fee/free_threshold sur
-- restaurant_sale_mode_fulfillments) déjà en Production.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurant_sale_mode_fulfillments'
      and column_name = 'pricing_mode'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_sale_mode_fulfillments.pricing_mode introuvable -- prérequis SADFP v3 manquant, migration annulée.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.is_member_of introuvable -- prérequis restaurant_users/migration-orders.sql manquant, migration annulée.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_role_in'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.has_role_in introuvable -- prérequis restaurant_users/migration-orders.sql manquant, migration annulée.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1.5 CORRECTION DDP-V1-01 — HELPER : détection explicite de valeurs
-- numériques non finies (NaN, Infinity, -Infinity), par comparaison
-- d'égalité contre les 3 valeurs spéciales littérales -- PAS via
-- `< 0` / `>= 0` (contournables, voir DDP-V1-01) ni via `x <> x`
-- (également contournable en PostgreSQL, où NaN = NaN est VRAI).
-- Fonction pure, IMMUTABLE, sans accès table, sans SECURITY DEFINER
-- -- même patron que
-- restaurant_sale_mode_fulfillments_zone_prefixes_valid ci-dessus
-- (DRAFT-lot-fulfillment-routing-model.sql) : réutilisable à la fois
-- par une contrainte CHECK et par du code PL/pgSQL.
-- ------------------------------------------------------------
create or replace function public.scanym_numeric_is_non_finite(p numeric)
returns boolean
language sql
immutable
as $func$
  select coalesce(
    p = 'NaN'::numeric or p = 'Infinity'::numeric or p = '-Infinity'::numeric,
    false
  );
$func$;

comment on function public.scanym_numeric_is_non_finite(numeric) is
  'DDP-V1-01 — retourne TRUE si p est NaN, Infinity ou -Infinity (FALSE si p est NULL ou une valeur numérique finie). Utilisée par les contraintes CHECK de restaurant_sale_mode_fulfillments (fixed_fee, free_threshold) et par update_merchant_delivery_fulfillment_pricing. Fonction pure, IMMUTABLE, sans SECURITY DEFINER, sans accès table.';

revoke all on function public.scanym_numeric_is_non_finite(numeric) from public, anon, authenticated;
grant execute on function public.scanym_numeric_is_non_finite(numeric) to service_role;

-- ------------------------------------------------------------
-- 1.6 CORRECTION DDP-V1-01 — SÉCURITÉ DES DONNÉES EXISTANTES :
-- avant toute modification de contrainte, on vérifie qu'AUCUNE ligne
-- existante de restaurant_sale_mode_fulfillments ne contient déjà une
-- valeur non finie dans fixed_fee/free_threshold. Si c'est le cas, la
-- migration s'arrête ICI avec une erreur explicite -- AUCUNE
-- normalisation silencieuse vers 0/NULL, AUCUNE modification de
-- tarification tenant légitime (mission, section "Existing data
-- safety").
-- ------------------------------------------------------------
do $$
declare
  v_bad_count bigint;
begin
  select count(*) into v_bad_count
  from public.restaurant_sale_mode_fulfillments
  where (fixed_fee is not null and public.scanym_numeric_is_non_finite(fixed_fee))
     or (free_threshold is not null and public.scanym_numeric_is_non_finite(free_threshold));

  if v_bad_count > 0 then
    raise exception 'SCANYM_EXISTING_DATA_NONFINITE: % ligne(s) existante(s) de restaurant_sale_mode_fulfillments contiennent déjà une valeur non finie (NaN/Infinity/-Infinity) dans fixed_fee ou free_threshold -- migration DDP-V1-01 annulée AVANT toute modification de contrainte ou de donnée. Aucune normalisation silencieuse effectuée : ces lignes doivent être corrigées manuellement avant de rejouer cette migration.', v_bad_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1.7 CORRECTION DDP-V1-01 — DURCISSEMENT DES CONTRAINTES DE TABLE :
-- remplace les 2 CHECK existants (installés par
-- DRAFT-lot-server-delivery-fulfillment-pricing.sql, section SADFP)
-- par une version qui exclut explicitement NaN/Infinity/-Infinity,
-- EN PLUS de la sémantique déjà en place (NULL autorisé, sinon
-- valeur >= 0). Ceci protège TOUT chemin d'écriture privilégié direct
-- sur la table (pas seulement le RPC ci-dessous, qui reçoit sa PROPRE
-- garde indépendante en section 3) -- défense en profondeur, comme
-- exigé par la mission ("cannot be persisted through ANY
-- privileged/direct path").
--
-- Noms de contrainte confirmés empiriquement (pg_constraint /
-- pg_get_constraintdef) sur la chaîne réelle jusqu'à SADFP v3 :
--   restaurant_sale_mode_fulfillments_fixed_fee_check
--   restaurant_sale_mode_fulfillments_free_threshold_check
-- La contrainte combo (restaurant_sale_mode_fulfillments_pricing_combo_valid)
-- n'est PAS modifiée : elle ne vérifie que la NULLITÉ des colonnes
-- selon pricing_mode, jamais leur magnitude -- aucun changement
-- nécessaire ni pertinent à ce correctif.
-- ------------------------------------------------------------
alter table public.restaurant_sale_mode_fulfillments
  drop constraint restaurant_sale_mode_fulfillments_fixed_fee_check;
alter table public.restaurant_sale_mode_fulfillments
  add constraint restaurant_sale_mode_fulfillments_fixed_fee_check
  check (
    fixed_fee is null
    or (fixed_fee >= 0 and not public.scanym_numeric_is_non_finite(fixed_fee))
  );

alter table public.restaurant_sale_mode_fulfillments
  drop constraint restaurant_sale_mode_fulfillments_free_threshold_check;
alter table public.restaurant_sale_mode_fulfillments
  add constraint restaurant_sale_mode_fulfillments_free_threshold_check
  check (
    free_threshold is null
    or (free_threshold >= 0 and not public.scanym_numeric_is_non_finite(free_threshold))
  );

-- ------------------------------------------------------------
-- 2. LECTURE MARCHAND (tout rôle membre -- owner/manager/staff),
-- limitée aux règles de livraison ("mode_code = 'delivery'") --
-- ce lot ne concerne QUE la livraison, jamais pickup/table/room.
--
-- Étiquette lisible (`fulfillment_label`) composée UNIQUEMENT à
-- partir de champs déjà génériques (is_fallback, zone_prefixes) --
-- JAMAIS de fulfillment_code ni provider, pour rester valable pour
-- n'importe quel tenant/règle futur sans modification de cette
-- fonction (aucun mapping codé en dur "local_delivery" -> "...").
-- ------------------------------------------------------------
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

  if not public.is_member_of(p_restaurant_id) then
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

revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public, anon;
grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. ÉCRITURE MARCHAND (owner/manager UNIQUEMENT) -- 4 champs
-- éditables, rien d'autre. Toute autre colonne (restaurant_id,
-- mode_code, fulfillment_code, provider, zone_prefixes, is_fallback,
-- display_order, enabled, min_items) N'EST PAS un paramètre de cette
-- fonction -- structurellement impossible à modifier par ce chemin.
--
-- Validation indépendante par mode, fail-closed strict : aucune
-- valeur par défaut, aucune conversion silencieuse vers 'free' ou 0,
-- rejet explicite de toute combinaison invalide.
-- ------------------------------------------------------------
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
  -- endroit (42501 via has_role_in ci-dessous, JAMAIS d'indice sur
  -- l'existence d'une règle chez un tenant tiers -- mutation
  -- cross-tenant rejetée, aucune ligne modifiée).
  select f.restaurant_id, f.mode_code into v_restaurant_id, v_mode_code
  from public.restaurant_sale_mode_fulfillments f
  where f.id = p_rule_id;

  if v_restaurant_id is null or v_mode_code is distinct from 'delivery' then
    raise exception using errcode = 'P0002', message = 'Delivery fulfillment rule not found';
  end if;

  if not public.has_role_in(v_restaurant_id, array['owner', 'manager']) then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  -- ------------------------------------------------------------
  -- Validation fail-closed, indépendante par mode (aucune valeur
  -- CIO/Production réelle ici -- ce sont des règles de validation
  -- génériques, pas des données tenant).
  -- ------------------------------------------------------------
  if p_pricing_mode is null or p_pricing_mode not in ('fixed', 'free_above_threshold') then
    raise exception using errcode = '22023', message = 'Invalid pricing_mode';
  end if;

  -- CORRECTION DDP-V1-01 : rejet explicite de NaN/Infinity/-Infinity,
  -- AVANT toute autre validation et AVANT toute mutation -- n'utilise
  -- PAS `< 0` / `>= 0` (contournables par NaN/+Infinity en
  -- PostgreSQL, voir scanym_numeric_is_non_finite ci-dessus) ni la
  -- validation côté client (insuffisante -- Number.isNaN() côté
  -- navigateur n'empêche pas un appel RPC direct avec
  -- 'NaN'::numeric).
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
    -- CORRECTION DDP-V1-01 : même rejet explicite pour free_threshold.
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

revoke all on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) from public, anon;
grant execute on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) to authenticated;

-- ------------------------------------------------------------
-- 4. GARDE-FOU EXPLICITE (mission, section SECURITY) : aucun GRANT
-- direct n'est ajouté sur la table elle-même -- ré-affirmation
-- défensive de l'état déjà établi par DRAFT-lot-fulfillment-routing-model.sql
-- (aucune régression introduite par ce lot).
-- ------------------------------------------------------------
do $$
begin
  if has_table_privilege('authenticated', 'public.restaurant_sale_mode_fulfillments', 'UPDATE') then
    raise exception 'SCANYM_UPDATE_GRANT_UNEXPECTED: authenticated a un privilège UPDATE direct sur restaurant_sale_mode_fulfillments -- ce lot exige que toute écriture passe exclusivement par update_merchant_delivery_fulfillment_pricing (SECURITY DEFINER), migration annulée.';
  end if;
end $$;

commit;
