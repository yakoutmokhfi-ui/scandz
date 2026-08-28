-- ============================================================
-- Scanym — PAYMENT P2B-A — SAFE MERCHANT PAYMENT CONFIG READ RPC
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- CONTEXTE : la mission P2B (frontend Dashboard "Paiement") a
-- correctement STOPPÉ avec `STOP — PAYMENT P2B DATABASE CAPABILITY
-- REQUIRED` : `payment_provider_configs` (P1) a RLS activée mais AUCUNE
-- policy, et `revoke all ... from anon, authenticated, service_role,
-- public` (P1) retire tout accès direct -- aucun chemin marchand vers
-- ces données n'existe. P2B-A ferme UNIQUEMENT ce manque de capacité :
-- UNE fonction de lecture sûre, rien d'autre.
--
-- PÉRIMÈTRE STRICT :
--   - UNE SEULE nouvelle fonction : public.get_merchant_payment_provider_config
--   - AUCUNE écriture, AUCUN accès Vault, AUCUNE UI.
--   - AUCUNE modification de P1 ou P2A (fichiers DRAFT existants
--     NON touchés, aucune fonction/contrainte/ACL déjà publiée n'est
--     recréée ni altérée par ce lot).
--   - AUCUN nouveau primitif d'autorisation : réutilise
--     `public.is_member_of(uuid)` (migration-orders.sql, déjà publiée).
--
-- CONTRAT DE RETOUR (mandat section 2) : EXACTEMENT six colonnes,
-- jamais `select *` :
--   provider_code, mode, configuration_status, is_enabled,
--   last_verified_at, updated_at
-- N'inclut JAMAIS : id, restaurant_id, credentials_ref, ou toute
-- colonne future non explicitement listée ici -- une future colonne
-- ajoutée à payment_provider_configs par un lot ultérieur ne sera
-- JAMAIS exposée automatiquement (pas de `select *`, liste de
-- colonnes figée dans cette définition de fonction).
--
-- CARDINALITÉ (mandat section 7) : `payment_provider_configs` porte
-- `unique (restaurant_id, provider_code)` (P1) -- un restaurant PEUT
-- structurellement avoir PLUSIEURS configurations, une par
-- `provider_code` distinct. Cette fonction retourne donc TOUTES les
-- lignes appartenant au restaurant (0, 1 ou plusieurs), jamais un
-- `LIMIT 1` arbitraire qui masquerait silencieusement des
-- configurations supplémentaires à une future UI.
--
-- FRONTIÈRE SECRET (mandat sections 8/18) : cette fonction ne
-- référence JAMAIS `vault.secrets`, `vault.decrypted_secrets`, ni la
-- colonne `credentials_ref` -- même pas pour un test d'existence.
-- Lecture de métadonnées UNIQUEMENT.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_provider_configs'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_configs introuvable -- prérequis PAYMENT P1 FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_configs'
      and column_name in ('provider_code','mode','status','is_enabled','last_verified_at','updated_at')
    having count(*) = 6
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: forme attendue de public.payment_provider_configs (P1) introuvable ou différente -- migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_configs'
      and column_name = 'configuration_status'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_configs.configuration_status introuvable -- prérequis PAYMENT P2A SECURE CONFIG FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
      and p.pronargs = 1
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.is_member_of(uuid) introuvable -- prérequis migration-orders.sql manquant, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_merchant_payment_provider_config'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_merchant_payment_provider_config existe déjà -- PAYMENT P2B-A déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_merchant_payment_provider_config — LECTURE SÛRE, SEULE
-- FRONTIÈRE DE LECTURE MARCHAND pour payment_provider_configs.
--
-- Patron identique à get_merchant_delivery_fulfillment_pricing
-- (DRAFT-lot-merchant-delivery-pricing.sql, déjà publié) : SECURITY
-- DEFINER, search_path vide, vérification explicite de session puis
-- d'appartenance via is_member_of, AUCUN SQL dynamique, liste de
-- colonnes explicite (jamais `select *`).
--
-- Aucun accès direct (SELECT) n'est accordé sur
-- payment_provider_configs à authenticated/anon/public -- cette
-- fonction reste l'UNIQUE chemin de lecture marchand (section 5/12).
-- ------------------------------------------------------------
create or replace function public.get_merchant_payment_provider_config(
  p_restaurant_id uuid
)
returns table (
  provider_code        text,
  mode                 text,
  configuration_status text,
  is_enabled           boolean,
  last_verified_at     timestamptz,
  updated_at           timestamptz
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

  if p_restaurant_id is null then
    raise exception using errcode = '22004', message = 'p_restaurant_id requis';
  end if;

  if not public.is_member_of(p_restaurant_id) then
    raise exception using errcode = '42501', message = 'Not authorized for this restaurant';
  end if;

  -- Restaurant inexistant : is_member_of renvoie déjà FALSE (aucune
  -- ligne restaurant_users ne peut référencer un restaurant qui
  -- n'existe pas), donc déjà rejeté ci-dessus avec 42501 -- pas de
  -- distinction "restaurant absent" vs "non membre" exposée à
  -- l'appelant (évite de confirmer/infirmer l'existence d'un
  -- restaurant à un utilisateur qui n'y est pas rattaché).

  -- Liste de colonnes EXPLICITE et FIGÉE -- jamais `select *`.
  -- AUCUNE référence à id, restaurant_id, credentials_ref,
  -- vault.secrets ou vault.decrypted_secrets.
  return query
  select
    c.provider_code,
    c.mode,
    c.configuration_status,
    c.is_enabled,
    c.last_verified_at,
    c.updated_at
  from public.payment_provider_configs c
  where c.restaurant_id = p_restaurant_id
  order by c.provider_code;
end;
$$;

comment on function public.get_merchant_payment_provider_config(uuid) is
  'Lecture marchande SÛRE et SEULE (PAYMENT P2B-A) des métadonnées de configuration prestataire -- provider_code/mode/configuration_status/is_enabled/last_verified_at/updated_at UNIQUEMENT. Ne retourne JAMAIS id, restaurant_id, credentials_ref, ni aucun matériel Vault -- aucune référence à vault.secrets/vault.decrypted_secrets dans cette fonction. Autorisation via is_member_of (aucun nouveau primitif). Retourne TOUTES les configurations du restaurant (0, 1 ou plusieurs -- unique(restaurant_id, provider_code) permet plusieurs prestataires par restaurant), jamais un LIMIT 1 arbitraire. SECURITY DEFINER, search_path vide, aucun SQL dynamique.';

revoke all on function public.get_merchant_payment_provider_config(uuid) from public, anon;
grant execute on function public.get_merchant_payment_provider_config(uuid) to authenticated;

commit;
