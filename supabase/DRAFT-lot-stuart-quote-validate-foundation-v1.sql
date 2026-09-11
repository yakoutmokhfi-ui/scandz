-- ============================================================
-- Scanym — STUART LOT A
-- QUOTE / VALIDATE / ETA / SCHEDULING FOUNDATION v1 — DEV ONLY
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET DE CE FICHIER (STRICTEMENT) : une SEULE fonction SQL nouvelle,
-- ADDITIVE, PURE LECTURE : public.get_delivery_provider_config_status.
-- N'ALTÈRE NI NE RECRÉE public.delivery_provider_configs (LOT A-0,
-- déjà fusionné/audité) ni AUCUNE de ses trois RPC existantes
-- (set_/clear_/get_delivery_provider_credentials) -- ce fichier ne les
-- redéfinit jamais, ne change aucun GRANT/REVOKE existant sur elles.
--
-- POURQUOI CETTE FONCTION EST NÉCESSAIRE (mandat STUART LOT A,
-- "CREDENTIAL RESOLUTION", 6 étapes explicites) : la résolution
-- runtime marchand distingue "3. resolve delivery_provider_configs" /
-- "4. verify provider mode" de "5. resolve merchant Vault credential"
-- -- deux lectures distinctes. `get_delivery_provider_credential`
-- (LOT A-0) ne retourne QUE le secret déchiffré (contrat de retour
-- délibérément minimal, `returns text`, AUCUNE métadonnée) -- il n'y a
-- donc AUJOURD'HUI aucun moyen serveur de connaître
-- `delivery_provider_configs.mode` (désormais l'UNIQUE source de
-- vérité pour le mode, fermeture du A-0 LOW finding -- voir
-- lib/server/delivery-providers/stuart/credentials.ts) sans une
-- fonction dédiée. Étendre la signature de retour de
-- `get_delivery_provider_credential` serait une modification du
-- CONTRAT DÉJÀ AUDITÉ de LOT A-0 -- explicitement INTERDIT par le
-- mandat ("Do NOT redesign the credential foundation"). Ce fichier
-- AJOUTE donc une fonction séparée, plutôt que de modifier celle qui
-- existe déjà.
--
-- POSTURE DE SÉCURITÉ -- STRICTEMENT IDENTIQUE à LOT A-0, jamais
-- affaiblie : SECURITY DEFINER, search_path vide, REVOKE ALL puis
-- GRANT EXECUTE service_role UNIQUEMENT, portée strictement au couple
-- (restaurant_id, provider_code) fourni (aucune fuite cross-tenant).
-- Cette fonction est en réalité PLUS restrictive que
-- get_delivery_provider_credential : elle ne touche JAMAIS Vault, ne
-- lit JAMAIS credentials_ref, et ne peut donc STRUCTURELLEMENT
-- JAMAIS exposer un secret ou une référence Vault, quel que soit
-- l'appelant.
--
-- PÉRIMÈTRE STRICTEMENT HORS DE CE FICHIER : Stuart pricing réel,
-- validation réelle, création de job, webhook, persistance
-- provider_cost/customer_delivery_fee/subsidy sur orders, intégration
-- checkout, UI Admin/Operator, Payment, Invoice, Catalogue, Tracking.
-- Aucune exécution Production, aucun commit, aucun push, aucun
-- déploiement, aucun appel réseau Stuart réel (Sandbox ou Production).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. GARDES PRÉFLIGHT (défensif) : LOT A-0 doit déjà être appliqué
-- (table + les 3 RPC existantes), et cette fonction ne doit pas déjà
-- exister (anti double-application).
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'delivery_provider_configs'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.delivery_provider_configs introuvable -- LOT A-0 doit être appliqué avant STUART LOT A, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_delivery_provider_credential'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_delivery_provider_credential introuvable -- LOT A-0 doit être appliqué avant STUART LOT A, migration annulée.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_delivery_provider_config_status'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_delivery_provider_config_status existe déjà -- STUART LOT A déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_delivery_provider_config_status — LECTURE SERVEUR DE
-- CONFIANCE, SEULE, service_role UNIQUEMENT. Retourne les métadonnées
-- de configuration (mode, statut) pour un couple restaurant/provider
-- EXACT -- JAMAIS le secret, JAMAIS credentials_ref, JAMAIS l'UUID
-- Vault. Ne raise PAS si `configuration_status = 'not_configured'`
-- (contrairement à get_delivery_provider_credential) -- cette
-- fonction reflète l'état RÉEL de la ligne, quel qu'il soit ; c'est à
-- l'APPELANT (credential-resolver.ts) d'appliquer la règle "pas encore
-- configuré => échec fermé" -- déjà appliquée de toute façon par le
-- prochain appel à get_delivery_provider_credential. Raise UNIQUEMENT
-- si AUCUNE ligne de configuration n'existe pour ce couple (P0002,
-- même code que get_delivery_provider_credential pour la même classe
-- d'absence).
-- ------------------------------------------------------------
create or replace function public.get_delivery_provider_config_status(
  p_restaurant_id uuid,
  p_provider_code text
)
returns table (
  config_id uuid,
  provider_code text,
  mode text,
  configuration_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
begin
  if p_restaurant_id is null then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CONFIG_STATUS: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CONFIG_STATUS: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;

  -- Portée STRICTEMENT au couple fourni -- aucune requête ne touche
  -- jamais un autre restaurant (même discipline que
  -- get_delivery_provider_credential).
  if not exists (
    select 1 from public.delivery_provider_configs c
    where c.restaurant_id = p_restaurant_id
      and c.provider_code = v_provider_code
  ) then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CONFIG_STATUS: configuration introuvable pour ce restaurant/provider' using errcode = 'P0002';
  end if;

  return query
    select c.id, c.provider_code, c.mode, c.configuration_status
    from public.delivery_provider_configs c
    where c.restaurant_id = p_restaurant_id
      and c.provider_code = v_provider_code;
end;
$$;

comment on function public.get_delivery_provider_config_status(uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- STUART LOT A. Lecture serveur de confiance, SEULE, des MÉTADONNÉES de configuration (mode, configuration_status) pour un couple restaurant_id/provider_code exact -- JAMAIS le secret, JAMAIS credentials_ref, ne touche JAMAIS Vault. Complète get_delivery_provider_credential (LOT A-0, inchangée) sans en modifier le contrat. Échec fermé (P0002) si aucune configuration n''existe pour ce couple ; ne raise PAS pour not_configured (reflète l''état réel, laisse l''appelant décider).';

revoke all on function public.get_delivery_provider_config_status(uuid, text) from public, anon, authenticated;
grant execute on function public.get_delivery_provider_config_status(uuid, text) to service_role;

commit;
