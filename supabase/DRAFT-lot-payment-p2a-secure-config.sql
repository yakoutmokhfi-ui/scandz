-- ============================================================
-- Scanym — PAYMENT P2A — SECURE PAYMENT CONFIGURATION FOUNDATION — v2
-- CORRECTION APRÈS WORK AUDIT (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- Verdict Work audit v1 : « FAIL — PAYMENT P2A SECURE CONFIG
-- FOUNDATION — CORRECTION REQUIRED ». Findings fermés par cette
-- version :
--   PAY-P2A-01 (HIGH)   la garde préflight Vault vérifiait des
--                       identités INCORRECTES (create_secret à 3
--                       arguments, update_secret à 4 arguments) --
--                       Work a inspecté le projet Supabase Production
--                       cible réel et confirmé les identités RÉELLES :
--                       create_secret(text,text,text,uuid) returns
--                       uuid ; update_secret(uuid,text,text,text,uuid)
--                       returns void (Supabase Vault 0.3.1, dernier
--                       argument new_key_id avec valeur par défaut).
--                       -> voir section 1 (garde corrigée par
--                       identité EXACTE de catalogue, pas seulement
--                       par nom) et section 3 (appel explicite en
--                       signature complète).
--   PAY-P2A-02 (MEDIUM) le mock Vault de test local différait
--                       matériellement de la cible réelle (arité
--                       incorrecte) -- aurait laissé passer un
--                       54/54 illusoire contre une API qui n'était
--                       pas celle de Production. -> voir harnais de
--                       test, mock reconstruit à l'identique de
--                       l'identité réelle, PLUS un test de régression
--                       qui prouve que l'ANCIEN mock incorrect est
--                       désormais REJETÉ par la garde corrigée
--                       (ferme le "faux 54/54").
--   PAY-P2A-03 (MEDIUM) tests de concurrence manquants + risque de
--                       deadlock set/clear par ordre de verrouillage
--                       divergent -> voir section 3/4, les DEUX RPC
--                       verrouillent désormais la ligne de
--                       configuration EN PREMIER (FOR UPDATE), AVANT
--                       toute opération Vault, dans le MÊME ordre --
--                       aucun verrou croisé possible, donc aucun
--                       deadlock. Prouvé par 3 scénarios de
--                       concurrence RÉELLE (sessions psql séparées),
--                       répétés 3 fois chacun.
--   PAY-P2A-04 (LOW)    credentials_ref pouvait théoriquement être
--                       partagé entre deux configurations, ou
--                       référencer un secret Vault qui n'existe plus
--                       (orphelin) -> voir section 2 (index unique
--                       partiel unique(credentials_ref) where non
--                       nul) et section 3 (vérification d'existence
--                       du secret référencé AVANT tout remplacement,
--                       échec fermé sinon).
--
-- P1 FOUNDATION (déjà publiée en Production, baseline
-- 95520c645f15bc32a74302c9ca1b3fe9328db4e8) reste STRICTEMENT
-- INCHANGÉE et NON ROUVERTE par cette correction :
--   orders.payment_status / orders.current_payment_transaction_id,
--   payment_transactions (index uniques partiels, FK composite,
--   RPC-only authority), initiate_payment_attempt,
--   confirm_payment_attempt -- tout est INCHANGÉ.
--
-- OBJET (inchangé depuis v1) : configuration prestataire par tenant
-- avec stockage sécurisé du credential technique (Supabase Vault),
-- gérée exclusivement par Scanym (aucune écriture marchand). N'active
-- AUCUN prestataire, n'implémente AUCUN adaptateur Monetico, ne
-- modifie AUCUN parcours client/checkout, n'ajoute AUCUNE UI.
--
-- ARCHITECTURE DE STOCKAGE SÉCURISÉ — Supabase Vault, IDENTITÉS
-- RÉELLES CONFIRMÉES PAR L'AUDIT WORK CONTRE LA PRODUCTION CIBLE
-- (PostgreSQL 17.6, supabase_vault 0.3.1) :
--   - `vault.create_secret(new_secret text, new_name text,
--      new_description text, new_key_id uuid default null)
--      returns uuid`
--   - `vault.update_secret(secret_id uuid, new_secret text,
--      new_name text, new_description text, new_key_id uuid
--      default null) returns void` (mise à jour EN PLACE du même
--      secret -- élimine la fenêtre "config pointe vers un secret
--      manquant" lors d'un remplacement, voir section 3)
--   - `vault.secrets` / `vault.decrypted_secrets`
--   - AUCUN chiffrement custom, AUCUNE clé embarquée dans ce SQL.
-- Appelées ici en SIGNATURE EXPLICITE COMPLÈTE (4 et 5 arguments,
-- dernier `null`) -- élimine toute ambiguïté de résolution de
-- surcharge (mandat section 3, option A retenue).
-- Ce lot exige la présence réelle de cette identité EXACTE (schéma
-- `vault`, catalogue pg_proc/pg_get_function_identity_arguments) --
-- garde anti-dérive dédiée section 1, échoue loudly si absente ou
-- différente (PAY-P2A-01).
--
-- PÉRIMÈTRE STRICTEMENT HORS DE CE LOT : aucun nom de prestataire
-- codé en dur, aucun TPE/MAC/CGI2, aucune UI Dashboard, aucun
-- checkout, aucun email, aucune activation tenant réelle, aucune
-- clé bancaire réelle, aucune exécution Production, aucun push,
-- aucun déploiement.
--
-- CE FICHIER EST GÉNÉRIQUE (aucun nom de prestataire codé en dur) et
-- DÉTERMINISTE — même patron que les lots précédents.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application +
-- garde d'architecture (Supabase Vault requis, IDENTITÉ EXACTE --
-- CORRECTION PAY-P2A-01).
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
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.touch_updated_at introuvable -- prérequis migration-v55-updated-at.sql manquant, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_configs' and column_name = 'credentials_ref'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_configs.credentials_ref existe déjà -- PAYMENT P2A déjà appliqué, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_payment_provider_credentials'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.set_payment_provider_credentials existe déjà -- PAYMENT P2A déjà appliqué, migration annulée (double application refusée).';
  end if;

  -- GARDE D'ARCHITECTURE (CORRECTION PAY-P2A-01) : Supabase Vault
  -- doit être réellement disponible AVEC L'IDENTITÉ EXACTE de
  -- catalogue confirmée par Work contre la Production cible --
  -- PAS seulement un nom de fonction identique (une fonction
  -- homonyme à arité différente, ex. l'ancienne API 3/4-arguments,
  -- doit être REJETÉE, pas silencieusement acceptée). Vérifie :
  -- schéma, table/vue, ET pour chaque fonction : nom, arité, types de
  -- paramètres d'entrée ET leur ORDRE (via p.proargtypes -- volontai-
  -- rement PAS pg_get_function_identity_arguments, qui inclurait les
  -- noms de paramètres réels de la fonction cible et ferait échouer à
  -- tort une comparaison littérale contre une chaîne de types seuls),
  -- type de retour, ET présence d'au moins un argument par défaut
  -- (signature réelle documentée : les 3 derniers arguments de
  -- create_secret et les 4 derniers de update_secret sont par défaut
  -- NULL).
  if to_regnamespace('vault') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: schéma `vault` (Supabase Vault) introuvable -- architecture de stockage sécurisé indisponible sur ce projet, migration annulée. Voir STOP — PAYMENT P2A SECURE STORAGE ARCHITECTURE DECISION REQUIRED.';
  end if;

  if to_regclass('vault.secrets') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: table vault.secrets introuvable -- architecture de stockage sécurisé indisponible, migration annulée.';
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: vue vault.decrypted_secrets introuvable -- architecture de stockage sécurisé indisponible, migration annulée.';
  end if;

  -- NOTE D'IMPLÉMENTATION IMPORTANTE (corrigée dans cette révision de
  -- la garde, avant toute exécution réelle) : pg_get_function_
  -- identity_arguments() inclut les NOMS de paramètres tels que
  -- déclarés par la fonction cible lorsque celle-ci en porte (ce qui
  -- est le cas de la vraie fonction Supabase Vault, déclarée avec des
  -- paramètres nommés new_secret/new_name/new_description/new_key_id)
  -- -- une comparaison littérale contre la chaîne de TYPES SEULS
  -- ('text, text, text, uuid') échouerait donc à tort contre la vraie
  -- Production (faux négatif SCANYM_SCHEMA_DRIFT sur une fonction en
  -- réalité correcte). La garde compare donc ARITÉ + TYPES + ORDRE
  -- directement via p.proargtypes (vecteur des types de paramètres
  -- d'entrée, insensible aux noms) -- exactement l'exigence "type ET
  -- ordre" du mandat, sans dépendre d'une convention de nommage de
  -- paramètres qui n'est pas un contrat garanti par Supabase.
  select p.oid into v_create_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault'
      and p.proname = 'create_secret'
      and p.pronargs = 4
      and array(select unnest(p.proargtypes)) = array['text','text','text','uuid']::regtype[]::oid[]
      and p.prorettype = 'uuid'::regtype
      and p.pronargdefaults >= 1;
  if v_create_oid is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: identité exacte vault.create_secret(text,text,text,uuid) returns uuid introuvable (nom seul insuffisant -- arité/types/ordre/type de retour vérifiés) -- version/API Supabase Vault incompatible, migration annulée. Voir PAY-P2A-01.';
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
    raise exception 'SCANYM_SCHEMA_DRIFT: identité exacte vault.update_secret(uuid,text,text,text,uuid) returns void introuvable (nom seul insuffisant -- arité/types/ordre/type de retour vérifiés) -- version/API Supabase Vault incompatible, migration annulée. Voir PAY-P2A-01.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. EXTENSION payment_provider_configs — RÉFÉRENCE SÉCURISÉE.
--
-- Réutilise TEL QUEL : provider_code, mode, status, is_enabled,
-- last_verified_at, updated_at (déjà posés par P1) -- AUCUNE
-- duplication.
--
-- Ajoute :
--   credentials_ref     -- référence opaque vers vault.secrets.id.
--                           JAMAIS une FK déclarée vers vault.secrets
--                           (schéma géré par l'extension Supabase,
--                           hors du contrôle de nos migrations --
--                           mandat section 16). L'intégrité
--                           référentielle est garantie PAR
--                           CONSTRUCTION des deux RPC (seul chemin
--                           d'écriture) ET, désormais, par une
--                           vérification d'existence explicite avant
--                           tout remplacement (section 3 ci-dessous,
--                           CORRECTION PAY-P2A-04).
--   configuration_status -- cycle de vie du CREDENTIAL, DISTINCT de
--                           `status` (provider, P1, inchangé) et de
--                           `is_enabled` (activation, P1, inchangé).
--
-- CORRECTION PAY-P2A-04 (mandat section 13) : un secret Vault
-- n'appartient JAMAIS qu'à UNE SEULE configuration. Index unique
-- PARTIEL (pas de FK -- pas nécessaire, la référence est interne à
-- notre propre table) empêchant structurellement deux lignes
-- payment_provider_configs de partager le même credentials_ref, quel
-- que soit l'appelant (y compris un accès direct privilégié).
-- ------------------------------------------------------------
alter table public.payment_provider_configs
  add column credentials_ref uuid,
  add column configuration_status text not null default 'not_configured'
    check (configuration_status in ('not_configured','configured','verified')),
  add constraint payment_provider_configs_credentials_consistency
    check ((configuration_status = 'not_configured') = (credentials_ref is null));

create unique index payment_provider_configs_credentials_ref_unique
  on public.payment_provider_configs (credentials_ref)
  where credentials_ref is not null;

comment on column public.payment_provider_configs.credentials_ref is
  'Référence OPAQUE vers vault.secrets.id (Supabase Vault) -- JAMAIS le secret lui-même. NULL tant qu''aucun credential n''est configuré. Positionné UNIQUEMENT par set_payment_provider_credentials/clear_payment_provider_credentials (SECURITY DEFINER, service_role uniquement). Un secret Vault n''appartient JAMAIS qu''à UNE configuration -- garanti par index unique partiel (CORRECTION PAY-P2A-04).';

comment on column public.payment_provider_configs.configuration_status is
  'Cycle de vie du CREDENTIAL (PAYMENT P2A), DISTINCT de status (cycle de vie du provider, P1) et de is_enabled (activation, P1). not_configured = aucun credential. configured = credential stocké, jamais vérifié par un adaptateur prestataire. verified = vérification technique réussie par un FUTUR adaptateur prestataire spécifique -- P2A ne peut JAMAIS fabriquer verified lui-même.';

comment on column public.payment_provider_configs.is_enabled is
  'Bascule d''activation opérée par Scanym (P1, inchangée). NE garantit PAS, à elle seule, l''éligibilité runtime au checkout -- l''éligibilité future exigera conceptuellement : config existe + credential existe + configuration_status=verified + is_enabled + adaptateur prestataire disponible. Aucune de ces conditions combinées n''est implémentée dans P2A (aucun runtime de paiement dans ce lot).';

-- ------------------------------------------------------------
-- 3. set_payment_provider_credentials — ÉCRITURE SERVEUR-SEULE.
--
-- CORRECTION PAY-P2A-03 (ORDRE DE VERROUILLAGE, mandat sections 6/8) :
-- verrouille TOUJOURS la ligne de configuration EN PREMIER (FOR
-- UPDATE, ou gain d'ownership via INSERT), AVANT toute opération
-- Vault -- jamais l'inverse. clear_payment_provider_credentials
-- (section 4) applique désormais EXACTEMENT le même ordre : aucun
-- verrou croisé possible entre les deux fonctions => aucun deadlock.
--
-- Boucle de nouvelle tentative (mandat section 9, PREMIÈRE CRÉATION
-- CONCURRENTE) : si deux appels concurrents visent la MÊME paire
-- (restaurant_id, provider_code) qui n'existe pas encore, l'un des
-- deux INSERT échoue avec une violation d'unicité UNIQUEMENT après
-- que l'autre a validé -- rattrapée explicitement (SAVEPOINT
-- implicite du bloc EXCEPTION), on reboucle et on verrouille alors
-- la ligne qui vient d'apparaître, puis on la traite comme une
-- configuration EXISTANTE (remplacement en place du secret qui vient
-- d'être créé). Résultat : UNE seule ligne de configuration, UN seul
-- secret Vault, AUCUN orphelin, les DEUX appels réussissent (celui
-- qui perd la course met simplement à jour le secret que l'autre
-- vient de créer) -- ceci ferme PAY-P2A-03 pour le cas création.
--
-- CORRECTION PAY-P2A-04 (RÉFÉRENCE ORPHELINE, mandat section 14) :
-- avant tout remplacement en place (vault.update_secret sur une
-- credentials_ref déjà existante), vérifie EXPLICITEMENT que ce
-- secret existe RÉELLEMENT dans vault.secrets. update_secret sur un
-- UUID inexistant affecte silencieusement ZÉRO ligne (comportement
-- réel confirmé par Work) -- sans cette vérification, la
-- configuration resterait faussement "configured" alors qu'aucun
-- secret n'a été mis à jour. Si la référence est orpheline : ÉCHEC
-- FERMÉ explicite (SCANYM_CREDENTIAL_REFERENCE_INVALID), AUCUNE
-- recréation automatique en clair.
--
-- Remplacement en place (mandat section 11, inchangé depuis v1) :
-- credentials_ref ne change JAMAIS pendant un remplacement -- un
-- seul secret Vault existe pour toute la vie de la configuration.
-- ------------------------------------------------------------
create or replace function public.set_payment_provider_credentials(
  p_restaurant_id uuid,
  p_provider_code text,
  p_secret text,
  p_mode text default 'test'
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
    raise exception 'SCANYM_PAYMENT_P2A: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT_P2A: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;
  if length(v_provider_code) > 40 or v_provider_code !~ '^[a-zA-Z0-9_-]+$' then
    raise exception 'SCANYM_PAYMENT_P2A: p_provider_code invalide (longueur/charset)' using errcode = '22023';
  end if;

  if p_mode is null or p_mode not in ('test','live') then
    raise exception 'SCANYM_PAYMENT_P2A: p_mode invalide (attendu test/live)' using errcode = '22023';
  end if;

  -- Un secret est du texte opaque -- AUCUN trim, AUCUNE normalisation
  -- de casse. Seule une validation de présence/longueur maximale est
  -- appliquée.
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'SCANYM_PAYMENT_P2A: p_secret requis (non vide)' using errcode = '22004';
  end if;
  if length(p_secret) > 8192 then
    raise exception 'SCANYM_PAYMENT_P2A: p_secret dépasse la longueur maximale autorisée' using errcode = '22023';
  end if;

  if not exists (select 1 from public.restaurants where id = p_restaurant_id) then
    raise exception 'SCANYM_PAYMENT_P2A: restaurant introuvable' using errcode = 'P0002';
  end if;

  -- CORRECTION PAY-P2A-03 : ownership de la ligne de configuration
  -- GAGNÉE (verrouillée ou créée) AVANT toute opération Vault.
  <<upsert_retry>>
  loop
    select id, credentials_ref into v_config_id, v_existing_ref
      from public.payment_provider_configs
      where payment_provider_configs.restaurant_id = p_restaurant_id
        and payment_provider_configs.provider_code = v_provider_code
      for update;

    if found then
      update public.payment_provider_configs
        set mode = p_mode
        where id = v_config_id;
      exit upsert_retry;
    end if;

    begin
      insert into public.payment_provider_configs (restaurant_id, provider_code, mode)
        values (p_restaurant_id, v_provider_code, p_mode)
        returning id, credentials_ref into v_config_id, v_existing_ref;
      exit upsert_retry;
    exception when unique_violation then
      -- Une insertion concurrente a gagné la course entre notre
      -- SELECT et notre INSERT (mandat section 9) -- reboucle pour
      -- verrouiller la ligne qui vient d'être validée par l'autre
      -- session. Aucun secret Vault n'a encore été touché à ce
      -- stade : aucun orphelin possible.
      continue upsert_retry;
    end;
  end loop;

  -- CORRECTION PAY-P2A-04 : vérifie l'existence RÉELLE du secret
  -- référencé avant de le traiter comme valide pour un remplacement.
  if v_existing_ref is not null then
    select exists(select 1 from vault.secrets where id = v_existing_ref) into v_secret_exists;
    if not v_secret_exists then
      raise exception 'SCANYM_CREDENTIAL_REFERENCE_INVALID: credentials_ref % ne correspond à aucun secret Vault existant -- configuration incohérente, remplacement refusé (fail-closed, aucune recréation automatique en clair)', v_existing_ref using errcode = 'P0002';
    end if;
    -- Remplacement EN PLACE, signature complète explicite (mandat
    -- section 3, option A) -- identités confirmées par Work.
    perform vault.update_secret(v_existing_ref, p_secret, null, null, null);
    v_secret_ref := v_existing_ref;
  else
    v_secret_ref := vault.create_secret(
      p_secret,
      'scanym-payment-provider-config-' || v_config_id::text,
      'Scanym payment provider credential (P2A, server-managed)',
      null
    );
  end if;

  update public.payment_provider_configs
    set credentials_ref = v_secret_ref,
        configuration_status = 'configured',
        updated_at = now()
    where id = v_config_id;

  return query
    select c.id, c.provider_code, c.mode, c.configuration_status, c.updated_at
    from public.payment_provider_configs c
    where c.id = v_config_id;
  -- Ne retourne JAMAIS p_secret ni v_secret_ref.
end;
$$;

comment on function public.set_payment_provider_credentials(uuid, text, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT. Verrouille/gagne la ligne de configuration AVANT toute opération Vault (CORRECTION PAY-P2A-03, ordre identique à clear_payment_provider_credentials -- aucun deadlock possible). Vérifie l''existence du secret référencé avant tout remplacement, échec fermé sinon (CORRECTION PAY-P2A-04). Stockage exclusivement via Supabase Vault, signature explicite complète (create_secret/update_secret, 4/5 arguments, identité vérifiée en préflight). Remplacement EN PLACE du même secret -- la référence ne change jamais. Ne retourne JAMAIS le secret.';

revoke all on function public.set_payment_provider_credentials(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.set_payment_provider_credentials(uuid, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 4. clear_payment_provider_credentials — RESET SERVEUR-SEUL.
--
-- CORRECTION PAY-P2A-03 : verrouille désormais la ligne de
-- configuration EN PREMIER (FOR UPDATE), EXACTEMENT dans le même
-- ordre que set_payment_provider_credentials, AVANT de toucher au
-- secret Vault -- élimine le risque de deadlock par ordre de
-- verrouillage divergent identifié par Work.
--
-- CORRECTION PAY-P2A-04 / mandat section 15 (CAS ORPHELIN AU RESET) :
-- décision documentée -- si credentials_ref pointe vers un secret
-- Vault déjà absent (incohérence antérieure), le DELETE affecte
-- silencieusement zéro ligne ; ceci N'EST PAS traité comme une
-- erreur ici (contrairement au remplacement, section 3) car
-- l'intention d'un reset est atteinte dans les deux cas :
-- credentials_ref redevient NULL, configuration_status redevient
-- not_configured. Le reset ne prétend jamais avoir supprimé un
-- secret qui n'existait déjà plus -- mais il ne bloque pas non plus
-- un reset légitime pour une incohérence qu'il est justement en
-- train de corriger. Priorité de sécurité respectée (mandat section
-- 15) : la configuration ne reste JAMAIS "configured" avec un secret
-- manquant après un clear.
-- ------------------------------------------------------------
create or replace function public.clear_payment_provider_credentials(
  p_restaurant_id uuid,
  p_provider_code text
)
returns table (
  config_id uuid,
  provider_code text,
  configuration_status text,
  is_enabled boolean,
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
    raise exception 'SCANYM_PAYMENT_P2A: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT_P2A: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;

  -- CORRECTION PAY-P2A-03 : FOR UPDATE ajouté ici -- même ordre de
  -- verrouillage que set_payment_provider_credentials (config
  -- d'abord, Vault ensuite). Référence qualifiée
  -- (payment_provider_configs.provider_code) -- une comparaison nue
  -- serait ambiguë contre la colonne de sortie `provider_code` de
  -- RETURNS TABLE ci-dessus.
  select id, credentials_ref into v_config_id, v_existing_ref
    from public.payment_provider_configs
    where payment_provider_configs.restaurant_id = p_restaurant_id
      and payment_provider_configs.provider_code = v_provider_code
    for update;

  if not found then
    raise exception 'SCANYM_PAYMENT_P2A: configuration introuvable pour ce restaurant/provider' using errcode = 'P0002';
  end if;

  if v_existing_ref is not null then
    -- DELETE affectant zéro ligne (secret déjà absent) n'est pas une
    -- erreur ici -- voir décision documentée ci-dessus.
    delete from vault.secrets where id = v_existing_ref;
  end if;

  update public.payment_provider_configs
    set credentials_ref = null,
        configuration_status = 'not_configured',
        is_enabled = false,
        updated_at = now()
    where id = v_config_id;

  return query
    select c.id, c.provider_code, c.configuration_status, c.is_enabled, c.updated_at
    from public.payment_provider_configs c
    where c.id = v_config_id;
end;
$$;

comment on function public.clear_payment_provider_credentials(uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT. Verrouille la ligne de configuration EN PREMIER (FOR UPDATE, CORRECTION PAY-P2A-03 -- même ordre que set_payment_provider_credentials, aucun deadlock possible), PUIS retire le secret Vault si présent (silencieux si déjà absent -- décision documentée section 15). credentials_ref -> NULL, configuration_status -> not_configured, is_enabled -> FALSE (fail-closed).';

revoke all on function public.clear_payment_provider_credentials(uuid, text) from public, anon, authenticated;
grant execute on function public.clear_payment_provider_credentials(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 5. DURCISSEMENT ACL VAULT (préservé à l'identique depuis v1,
-- mandat section 17 -- ne retire AUCUN privilège nécessaire au
-- propriétaire postgres, aux fonctions de l'extension Vault
-- elles-mêmes, ou à un futur adaptateur serveur de confiance ; cible
-- explicitement et uniquement PUBLIC/anon/authenticated).
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
