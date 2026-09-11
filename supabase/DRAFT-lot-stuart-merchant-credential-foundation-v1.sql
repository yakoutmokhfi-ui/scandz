-- ============================================================
-- Scanym — OPERATOR BACKOFFICE — LOT A-0
-- MERCHANT STUART CREDENTIAL FOUNDATION v1 — DEV ONLY
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- CIO/CTO BUSINESS RULE AUTHORITATIVE (mandat LOT A-0, non-négociable) :
-- chaque marchand détient SON PROPRE compte Stuart -- contracte
-- directement avec Stuart, est facturé directement par Stuart, porte
-- son propre coût prestataire. Scanym N'A PAS de contrat Production
-- Stuart et NE DOIT JAMAIS devenir le client contractuel Stuart. Les
-- identifiants globaux Scanym existants (STUART_CLIENT_ID/
-- STUART_CLIENT_SECRET/STUART_ENV, lib/server/delivery-providers/
-- stuart/{auth,environment}.ts) restent réservés EXCLUSIVEMENT au
-- diagnostic Sandbox synthétique Scanym (app/api/internal/stuart/
-- sandbox-readiness, sandbox-trigger) -- ce lot ne les modifie ni ne
-- les supprime, et n'introduit AUCUN chemin qui pourrait les
-- confondre avec un credential marchand réel.
--
-- OBJET DE CE LOT (STRICTEMENT) : poser la fondation SQL de stockage
-- sécurisé, PAR RESTAURANT, d'un credential technique de prestataire
-- de LIVRAISON (Stuart en premier, mais domaine générique --
-- "chronofresh"/"other_external" restent des valeurs de provider_code
-- possibles, exactement comme le vocabulaire déjà existant de
-- restaurant_sale_modes.provider/restaurant_sale_mode_fulfillments.provider).
-- N'implémente AUCUN appel réseau Stuart, AUCUNE tarification, AUCUNE
-- validation, AUCUNE création de job, AUCUN webhook, AUCUNE UI, AUCUN
-- calcul de frais de livraison, AUCUNE persistance provider_cost/
-- customer_delivery_fee/subsidy sur orders. STRICTEMENT une fondation
-- d'identifiants.
--
-- DÉCISION D'ARCHITECTURE CIO/CTO (mandat LOT A-0) : NE PAS réutiliser
-- directement public.payment_provider_configs. Ce lot crée un domaine
-- PARALLÈLE, séparé : public.delivery_provider_configs. Le patron de
-- sécurité déjà audité PAYMENT P2A/P3-A0 (Supabase Vault, référence
-- opaque credentials_ref, RPC SECURITY DEFINER service_role
-- UNIQUEMENT, verrouillage FOR UPDATE de la ligne de config AVANT
-- toute opération Vault, vérification anti-orphelin avant tout
-- remplacement) est reproduit STRUCTURELLEMENT à l'identique --
-- AUCUNE table payment_*, AUCUNE fonction *_payment_provider_*, AUCUN
-- comportement Monetico n'est modifié, ni même relu, par ce lot.
--
-- ARCHITECTURE DE STOCKAGE SÉCURISÉ — mêmes identités Supabase Vault
-- EXACTES déjà confirmées par l'audit Work et déjà vérifiées en
-- préflight par PAYMENT P2A (PostgreSQL 17.6, supabase_vault 0.3.1) :
--   - `vault.create_secret(new_secret text, new_name text,
--      new_description text, new_key_id uuid default null)
--      returns uuid`
--   - `vault.update_secret(secret_id uuid, new_secret text,
--      new_name text, new_description text, new_key_id uuid
--      default null) returns void`
--   - `vault.secrets` / `vault.decrypted_secrets`
-- Ce lot exige la présence réelle de cette identité EXACTE (même
-- garde, arité + types + ordre + type de retour, PAS seulement le
-- nom) -- échoue loudly si absente ou différente. Aucune architecture
-- de stockage alternative n'est inventée ici : la preuve documentaire
-- ci-dessus (déjà apportée pour PAYMENT P2A) est jugée suffisante pour
-- ce lot également, même schéma `vault` partagé au niveau du projet.
--
-- VOCABULAIRE mode : 'sandbox'/'production' (PAS 'test'/'live' comme
-- payment_provider_configs) -- aligné volontairement sur le
-- vocabulaire déjà existant de STUART_ENV
-- (lib/server/delivery-providers/stuart/environment.ts), puisque ce
-- domaine sert spécifiquement les prestataires de livraison de forme
-- Stuart. provider_code reste GÉNÉRIQUE (aucun nom de prestataire
-- codé en dur dans une contrainte CHECK fermée), même discipline que
-- payment_provider_configs (P1) -- seul un charset/longueur sûrs sont
-- validés ; 'stuart' est une convention APPLICATIVE, jamais imposée
-- par le schéma.
--
-- PÉRIMÈTRE STRICTEMENT HORS DE CE LOT : Stuart pricing, validation,
-- création de job, webhook, scheduling, ETA, calcul de frais de
-- livraison, persistance provider_cost/customer_delivery_fee/subsidy
-- sur orders, intégration checkout, UI Admin/Operator, Payment,
-- Invoice, Catalogue, Tracking. Aucune exécution Production, aucun
-- commit, aucun push, aucun déploiement.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application +
-- garde d'architecture Vault (IDENTITÉ EXACTE, même contrôle que
-- PAYMENT P2A -- ce lot ne redéfinit rien, il exige la même identité
-- réelle).
-- ------------------------------------------------------------
do $$
declare
  v_create_oid oid;
  v_update_oid oid;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'restaurants'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.restaurants introuvable -- prérequis manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.touch_updated_at introuvable -- prérequis migration-v55-updated-at.sql manquant, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'delivery_provider_configs'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.delivery_provider_configs existe déjà -- LOT A-0 déjà appliqué, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_delivery_provider_credentials'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.set_delivery_provider_credentials existe déjà -- LOT A-0 déjà appliqué, migration annulée (double application refusée).';
  end if;

  -- GARDE D'ARCHITECTURE VAULT (identique à PAYMENT P2A section 1) --
  -- schéma, table/vue, ET pour chaque fonction : nom, arité, types
  -- d'entrée ET leur ORDRE (p.proargtypes, insensible aux noms de
  -- paramètres), type de retour, ET présence d'au moins un argument
  -- par défaut.
  if to_regnamespace('vault') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: schéma `vault` (Supabase Vault) introuvable -- architecture de stockage sécurisé indisponible sur ce projet, migration annulée.';
  end if;

  if to_regclass('vault.secrets') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: table vault.secrets introuvable -- architecture de stockage sécurisé indisponible, migration annulée.';
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: vue vault.decrypted_secrets introuvable -- architecture de stockage sécurisé indisponible, migration annulée.';
  end if;

  select p.oid into v_create_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault'
      and p.proname = 'create_secret'
      and p.pronargs = 4
      and array(select unnest(p.proargtypes)) = array['text','text','text','uuid']::regtype[]::oid[]
      and p.prorettype = 'uuid'::regtype
      and p.pronargdefaults >= 1;
  if v_create_oid is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: identité exacte vault.create_secret(text,text,text,uuid) returns uuid introuvable (nom seul insuffisant -- arité/types/ordre/type de retour vérifiés) -- version/API Supabase Vault incompatible, migration annulée.';
  end if;

  select p.oid into v_update_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault'
      and p.proname = 'update_secret'
      and p.pronargs = 5
      and array(select unnest(p.proargtypes)) = array['uuid','text','text','text','uuid']::regtype[]::oid[]
      and p.prorettype = 'void'::regtype
      and p.pronargdefaults >= 1;
  if v_update_oid is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: identité exacte vault.update_secret(uuid,text,text,text,uuid) returns void introuvable (nom seul insuffisant -- arité/types/ordre/type de retour vérifiés) -- version/API Supabase Vault incompatible, migration annulée.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. public.delivery_provider_configs — DOMAINE PARALLÈLE, SÉPARÉ de
-- payment_provider_configs (décision CIO/CTO explicite, jamais
-- réutilisée). Table NUE + référence Vault opaque dès ce lot (pas de
-- séquence P1-nu puis P2A-sécurisé distincte comme pour Payment --
-- ce lot est volontairement UN SEUL mini-lot combiné, périmètre plus
-- petit).
--
-- Clé (restaurant_id, provider_code) -- AU PLUS UN credential par
-- (restaurant, prestataire). provider_code générique (charset/longueur
-- sûrs uniquement, AUCUNE énumération de prestataire nommé codée en
-- dur) -- 'stuart' est une convention applicative.
--
-- credentials_ref : référence OPAQUE vers vault.secrets.id -- JAMAIS
-- une FK déclarée vers vault.secrets (schéma géré par l'extension
-- Supabase, hors du contrôle de nos migrations). Intégrité garantie
-- PAR CONSTRUCTION des RPC (seul chemin d'écriture) et par l'index
-- unique partiel ci-dessous (un secret Vault n'appartient jamais qu'à
-- UNE configuration).
--
-- AUCUNE colonne is_enabled/status/last_verified_at : ce lot est
-- STRICTEMENT une fondation de credential, PAS un cycle de vie
-- d'activation runtime (hors périmètre, cf. mandat "CREDENTIAL
-- FOUNDATION ONLY").
-- ------------------------------------------------------------
create table public.delivery_provider_configs (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete cascade,
  provider_code         text not null
                        check (length(provider_code) between 1 and 40)
                        check (provider_code = btrim(provider_code))
                        check (provider_code ~ '^[a-zA-Z0-9_-]+$'),

  mode                  text not null default 'sandbox' check (mode in ('sandbox','production')),
  credentials_ref       uuid,
  configuration_status  text not null default 'not_configured'
                        check (configuration_status in ('not_configured','configured','verified')),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (restaurant_id, provider_code),
  constraint delivery_provider_configs_credentials_consistency
    check ((configuration_status = 'not_configured') = (credentials_ref is null))
);

create unique index delivery_provider_configs_credentials_ref_unique
  on public.delivery_provider_configs (credentials_ref)
  where credentials_ref is not null;

comment on table public.delivery_provider_configs is
  'LOT A-0 — configuration credential par tenant pour un prestataire de LIVRAISON (Stuart en premier). Domaine PARALLÈLE et SÉPARÉ de payment_provider_configs (décision CIO/CTO explicite). Chaque restaurant détient son PROPRE contrat prestataire -- Scanym ne devient jamais le client contractuel. AUCUN secret stocké directement -- voir credentials_ref.';

comment on column public.delivery_provider_configs.provider_code is
  'Générique (charset/longueur sûrs uniquement) -- AUCUNE énumération de prestataire nommé codée en dur ici. "stuart" est une convention APPLICATIVE (lib/server/delivery-providers/stuart/*), pas une contrainte SQL fermée -- permet un futur prestataire (ex. "chronofresh") sans migration de schéma.';

comment on column public.delivery_provider_configs.mode is
  'sandbox/production -- aligné sur le vocabulaire déjà existant de STUART_ENV (lib/server/delivery-providers/stuart/environment.ts), PAS sur test/live (payment_provider_configs). Chaque marchand peut être en sandbox ou en production indépendamment des autres.';

comment on column public.delivery_provider_configs.credentials_ref is
  'Référence OPAQUE vers vault.secrets.id (Supabase Vault) -- JAMAIS le secret lui-même. NULL tant qu''aucun credential n''est configuré. Positionné UNIQUEMENT par set_delivery_provider_credentials/clear_delivery_provider_credentials (SECURITY DEFINER, service_role uniquement). Un secret Vault n''appartient JAMAIS qu''à UNE configuration -- garanti par index unique partiel.';

comment on column public.delivery_provider_configs.configuration_status is
  'Cycle de vie du CREDENTIAL uniquement. not_configured = aucun credential. configured = credential stocké, jamais vérifié par un futur adaptateur prestataire. verified = vérification technique réussie par un FUTUR adaptateur -- ce lot ne peut JAMAIS fabriquer verified lui-même (aucun appel Stuart dans ce lot).';

create trigger trg_touch_updated_at
  before update on public.delivery_provider_configs
  for each row execute function public.touch_updated_at();

alter table public.delivery_provider_configs enable row level security;
-- Aucune policy RLS, aucun grant à anon/authenticated/service_role au
-- niveau table -- exactement le même patron que payment_provider_configs
-- (P1) : seul un accès via les RPC SECURITY DEFINER ci-dessous est
-- possible, y compris pour service_role (aucun SELECT/INSERT/UPDATE/
-- DELETE direct de table, même en service_role).
revoke all on table public.delivery_provider_configs from anon, authenticated, service_role, public;

-- ------------------------------------------------------------
-- 3. set_delivery_provider_credentials — ÉCRITURE SERVEUR-SEULE,
-- SECURITY DEFINER, service_role UNIQUEMENT.
--
-- Même discipline que set_payment_provider_credentials (PAYMENT P2A,
-- corrections PAY-P2A-03/04 déjà auditées et reproduites ici à
-- l'identique) : verrouille TOUJOURS la ligne de configuration EN
-- PREMIER (FOR UPDATE, ou gain d'ownership via INSERT + boucle de
-- nouvelle tentative sur violation d'unicité concurrente), AVANT
-- toute opération Vault -- même ordre que clear_delivery_provider_
-- credentials (section 4), aucun deadlock possible. Vérifie
-- l'existence RÉELLE du secret référencé AVANT tout remplacement en
-- place, échec fermé sinon (SCANYM_CREDENTIAL_REFERENCE_INVALID,
-- même identifiant que PAYMENT P2A pour la même classe de défaut
-- d'intégrité). Ne retourne JAMAIS le secret.
-- ------------------------------------------------------------
create or replace function public.set_delivery_provider_credentials(
  p_restaurant_id uuid,
  p_provider_code text,
  p_secret text,
  p_mode text default 'sandbox'
)
returns table (
  config_id uuid,
  provider_code text,
  mode text,
  configuration_status text,
  last_updated timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_config_id uuid;
  v_existing_ref uuid;
  v_secret_ref uuid;
  v_secret_exists boolean;
begin
  if p_restaurant_id is null then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;
  if length(v_provider_code) > 40 or v_provider_code !~ '^[a-zA-Z0-9_-]+$' then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_provider_code invalide (longueur/charset)' using errcode = '22023';
  end if;

  if p_mode is null or p_mode not in ('sandbox','production') then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_mode invalide (attendu sandbox/production)' using errcode = '22023';
  end if;

  -- Un secret est du texte opaque (payload JSON défini par la couche
  -- applicative, ex. {"clientId":...,"clientSecret":...}) -- AUCUN
  -- trim, AUCUNE normalisation. Seule une validation de présence/
  -- longueur maximale est appliquée.
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_secret requis (non vide)' using errcode = '22004';
  end if;
  if length(p_secret) > 8192 then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_secret dépasse la longueur maximale autorisée' using errcode = '22023';
  end if;

  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: restaurant introuvable' using errcode = 'P0002';
  end if;

  -- Ownership de la ligne de configuration GAGNÉE (verrouillée ou
  -- créée) AVANT toute opération Vault -- même ordre que
  -- clear_delivery_provider_credentials.
  <<upsert_retry>>
  loop
    select id, credentials_ref into v_config_id, v_existing_ref
      from public.delivery_provider_configs
      where delivery_provider_configs.restaurant_id = p_restaurant_id
        and delivery_provider_configs.provider_code = v_provider_code
      for update;

    if found then
      update public.delivery_provider_configs
        set mode = p_mode
        where id = v_config_id;
      exit upsert_retry;
    end if;

    begin
      insert into public.delivery_provider_configs (restaurant_id, provider_code, mode)
        values (p_restaurant_id, v_provider_code, p_mode)
        returning id, credentials_ref into v_config_id, v_existing_ref;
      exit upsert_retry;
    exception when unique_violation then
      -- Une insertion concurrente a gagné la course entre notre
      -- SELECT et notre INSERT -- reboucle pour verrouiller la ligne
      -- qui vient d'être validée par l'autre session. Aucun secret
      -- Vault n'a encore été touché à ce stade : aucun orphelin
      -- possible.
      continue upsert_retry;
    end;
  end loop;

  -- Vérifie l'existence RÉELLE du secret référencé avant de le
  -- traiter comme valide pour un remplacement.
  if v_existing_ref is not null then
    select exists(select 1 from vault.secrets where id = v_existing_ref) into v_secret_exists;
    if not v_secret_exists then
      raise exception 'SCANYM_CREDENTIAL_REFERENCE_INVALID: credentials_ref % ne correspond à aucun secret Vault existant -- configuration incohérente, remplacement refusé (fail-closed, aucune recréation automatique en clair)', v_existing_ref using errcode = 'P0002';
    end if;
    -- Remplacement EN PLACE, signature complète explicite -- la
    -- référence ne change jamais pendant un remplacement.
    perform vault.update_secret(v_existing_ref, p_secret, null, null, null);
    v_secret_ref := v_existing_ref;
  else
    v_secret_ref := vault.create_secret(
      p_secret,
      'scanym-delivery-provider-config-' || v_config_id::text,
      'Scanym delivery provider credential (LOT A-0, server-managed, per-restaurant)',
      null
    );
  end if;

  update public.delivery_provider_configs
    set credentials_ref = v_secret_ref,
        configuration_status = 'configured',
        updated_at = now()
    where id = v_config_id;

  return query
    select c.id, c.provider_code, c.mode, c.configuration_status, c.updated_at
    from public.delivery_provider_configs c
    where c.id = v_config_id;
  -- Ne retourne JAMAIS p_secret ni v_secret_ref.
end;
$$;

comment on function public.set_delivery_provider_credentials(uuid, text, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (LOT A-0). Verrouille/gagne la ligne de configuration AVANT toute opération Vault (même ordre que clear_delivery_provider_credentials -- aucun deadlock possible). Vérifie l''existence du secret référencé avant tout remplacement, échec fermé sinon. Stockage exclusivement via Supabase Vault, signature explicite complète. Remplacement EN PLACE du même secret -- la référence ne change jamais. Ne retourne JAMAIS le secret. Domaine delivery, séparé de payment_provider_configs.';

revoke all on function public.set_delivery_provider_credentials(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.set_delivery_provider_credentials(uuid, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 4. clear_delivery_provider_credentials — RESET SERVEUR-SEUL,
-- SECURITY DEFINER, service_role UNIQUEMENT. Même ordre de
-- verrouillage que set_delivery_provider_credentials (config d'abord,
-- Vault ensuite).
-- ------------------------------------------------------------
create or replace function public.clear_delivery_provider_credentials(
  p_restaurant_id uuid,
  p_provider_code text
)
returns table (
  config_id uuid,
  provider_code text,
  configuration_status text,
  last_updated timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_config_id uuid;
  v_existing_ref uuid;
begin
  if p_restaurant_id is null then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;

  select id, credentials_ref into v_config_id, v_existing_ref
    from public.delivery_provider_configs
    where delivery_provider_configs.restaurant_id = p_restaurant_id
      and delivery_provider_configs.provider_code = v_provider_code
    for update;

  if not found then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: configuration introuvable pour ce restaurant/provider' using errcode = 'P0002';
  end if;

  if v_existing_ref is not null then
    -- DELETE affectant zéro ligne (secret déjà absent) n'est pas une
    -- erreur ici -- l'intention d'un reset est atteinte dans les deux
    -- cas (credentials_ref redevient NULL) ; même décision que
    -- PAYMENT P2A section 4.
    delete from vault.secrets where id = v_existing_ref;
  end if;

  update public.delivery_provider_configs
    set credentials_ref = null,
        configuration_status = 'not_configured',
        updated_at = now()
    where id = v_config_id;

  return query
    select c.id, c.provider_code, c.configuration_status, c.updated_at
    from public.delivery_provider_configs c
    where c.id = v_config_id;
end;
$$;

comment on function public.clear_delivery_provider_credentials(uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (LOT A-0). Verrouille la ligne de configuration EN PREMIER (FOR UPDATE, même ordre que set_delivery_provider_credentials -- aucun deadlock possible), PUIS retire le secret Vault si présent (silencieux si déjà absent). credentials_ref -> NULL, configuration_status -> not_configured (fail-closed).';

revoke all on function public.clear_delivery_provider_credentials(uuid, text) from public, anon, authenticated;
grant execute on function public.clear_delivery_provider_credentials(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 5. get_delivery_provider_credential — LECTURE SERVEUR DE CONFIANCE,
-- SEULE, service_role UNIQUEMENT.
--
-- Contrat de retour DÉLIBÉRÉMENT minimal : `returns text` contenant
-- UNIQUEMENT le payload secret déchiffré. Ne retourne JAMAIS
-- credentials_ref, l'UUID Vault, l'id de la ligne de config,
-- restaurant_id, ni aucune métadonnée. Exige configuration_status IN
-- ('configured','verified') -- 'not_configured' est refusé. AUCUNE
-- écriture, aucun verrou FOR UPDATE (lecture pure).
-- ------------------------------------------------------------
create or replace function public.get_delivery_provider_credential(
  p_restaurant_id uuid,
  p_provider_code text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_config_id uuid;
  v_configuration_status text;
  v_credentials_ref uuid;
  v_secret text;
begin
  if p_restaurant_id is null then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;

  -- Portée STRICTEMENT au couple fourni -- aucune requête ne touche
  -- jamais un autre restaurant, donc aucune fuite possible sur
  -- l'existence d'une configuration d'un AUTRE tenant.
  select id, configuration_status, credentials_ref
    into v_config_id, v_configuration_status, v_credentials_ref
    from public.delivery_provider_configs
    where restaurant_id = p_restaurant_id
      and provider_code = v_provider_code;

  if not found then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: configuration introuvable pour ce restaurant/provider' using errcode = 'P0002';
  end if;

  if v_configuration_status not in ('configured', 'verified') then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: configuration non prête pour la lecture de credential (état actuel non éligible)' using errcode = '42501';
  end if;

  if v_credentials_ref is null then
    raise exception 'SCANYM_DELIVERY_PROVIDER_CREDENTIAL: credentials_ref manquant malgré un état de configuration éligible (incohérence, échec fermé)' using errcode = 'P0002';
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where id = v_credentials_ref;

  if not found or v_secret is null then
    raise exception 'SCANYM_CREDENTIAL_REFERENCE_INVALID: credentials_ref % ne correspond à aucun secret Vault existant -- incohérence de configuration, lecture refusée (échec fermé)', v_credentials_ref using errcode = 'P0002';
  end if;

  return v_secret;
end;
$$;

comment on function public.get_delivery_provider_credential(uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- LOT A-0. Lecture serveur de confiance, SEULE, du credential déchiffré (vault.decrypted_secrets) pour un couple restaurant_id/provider_code exact. Retourne UNIQUEMENT le texte secret -- jamais credentials_ref, id, restaurant_id ni métadonnée. Exige configuration_status IN (configured, verified). Échec fermé si config absente, état non éligible, credentials_ref absent, ou référence orpheline. Aucune écriture. N''accorde AUCUN accès direct à vault.secrets/vault.decrypted_secrets.';

revoke all on function public.get_delivery_provider_credential(uuid, text) from public, anon, authenticated;
grant execute on function public.get_delivery_provider_credential(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 6. DURCISSEMENT ACL VAULT (défensif, NO-OP si déjà en vigueur
-- depuis PAYMENT P2A -- ce lot ne fait que confirmer qu'il ne les
-- affaiblit pas, il ne les réémet pas différemment. Aucun grant
-- direct nouveau sur vault.secrets/vault.decrypted_secrets n'est
-- ajouté par ce lot, pour quelque rôle que ce soit).
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('vault.secrets') is not null then
    execute 'revoke all on table vault.secrets from anon, authenticated, public';
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'revoke all on vault.decrypted_secrets from anon, authenticated, public';
  end if;
end $$;

commit;
