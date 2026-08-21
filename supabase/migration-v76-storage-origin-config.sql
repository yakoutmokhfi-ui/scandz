-- ============================================================
-- Scanym V76 — Remplacement du mécanisme app.storage_public_base_url
-- (GUC personnalisé) par une configuration persistante EN TABLE,
-- compatible Supabase hébergé.
--
-- ⚠️ CONTEXTE RÉEL DE PRODUCTION (Supabase ctqfpszwunfomrbxgigu) :
-- V68/V69/V70 sont installées et vérifiées. V71/V72/V73 n'ont PAS
-- encore été exécutées. Une tentative réelle de configurer le GUC :
--
--   alter database postgres set app.storage_public_base_url =
--     'https://ctqfpszwunfomrbxgigu.supabase.co';
--
-- a échoué avec : ERROR 42501: permission denied to set parameter
-- "app.storage_public_base_url".
--
-- CAUSE CONFIRMÉE (comportement Supabase hébergé documenté, pas une
-- anomalie de ce projet précis) : `ALTER DATABASE ... SET` pour un
-- paramètre GUC personnalisé (namespace "app.*") exige les privilèges
-- de propriétaire de base ("database-owner"), que le rôle `postgres`
-- utilisé par l'éditeur SQL de Supabase hébergé NE POSSÈDE PAS. Ce
-- refus est systématique sur Supabase hébergé, quel que soit le
-- projet -- confirmé par la documentation Supabase et les rapports
-- d'autres utilisateurs rencontrant l'erreur identique pour
-- app.settings_*, app.jwt_secret, etc. Le mécanisme GUC
-- (current_setting('app.storage_public_base_url', true)) introduit en
-- V70 (déjà en production, fail-open) et durci en V71 (fail-closed,
-- jamais encore appliqué) ne peut donc JAMAIS être configuré en
-- production hébergée -- V71 tel qu'écrit initialement aurait
-- durablement bloqué tout envoi de logo/cover, sans aucun moyen de le
-- configurer.
--
-- CORRECTION : une TABLE ordinaire dans un schéma dédié NON EXPOSÉ à
-- l'API Data (PostgREST) — confirmé compatible Supabase hébergé,
-- puisqu'une opération INSERT/UPDATE standard ne requiert JAMAIS les
-- privilèges de propriétaire de base, contrairement à `ALTER DATABASE
-- ... SET` pour un GUC personnalisé. Un schéma nouvellement créé
-- n'est PAR DÉFAUT jamais exposé à l'API Data tant qu'il n'est pas
-- explicitement ajouté à "Exposed schemas" (réglage de tableau de
-- bord, hors du contrôle SQL) — confirmé par la documentation
-- Supabase. En défense en profondeur, ce fichier révoque aussi
-- explicitement tout accès à `anon`/`authenticated`/`PUBLIC` au niveau
-- SQL, au cas où ce schéma serait un jour exposé par erreur via le
-- tableau de bord.
--
-- ⚠️ CE FICHIER MODIFIE migration-v71-hardening.sql EN PLACE (rupture
-- explicite avec la convention "ne jamais réécrire une migration déjà
-- livrée") : autorisé et justifié précisément parce que V71 n'a
-- JAMAIS été exécutée en production (confirmé par l'état réel
-- ci-dessus), et que son mécanisme de configuration est fondamentalement
-- incompatible avec Supabase hébergé -- le laisser tel quel produirait
-- une migration qui s'applique sans erreur SQL, mais qui bloque
-- ensuite DÉFINITIVEMENT tout envoi de logo/cover en production, sans
-- aucun moyen de configurer le réglage requis. Seule la lecture du
-- GUC dans assert_establishment_asset_url est remplacée par un appel
-- à scanym_internal.get_storage_public_origin() -- toute la logique de
-- validation UUID v4/chemin/kind de V71 reste strictement identique.
--
-- ORDRE D'EXÉCUTION DEPUIS L'ÉTAT PRODUCTION ACTUEL (V70 installée) --
-- SÉQUENCE UNIQUE, corrige V76-02 (contre-audit Work, 7e tour) :
-- la configuration CIO de l'origine apparaît désormais comme une
-- ÉTAPE EXPLICITE et NUMÉROTÉE de cette même liste, jamais reléguée à
-- une section séparée plus bas dans le fichier (ancienne présentation
-- ambiguë sur le moment exact où elle doit avoir lieu) :
--
--   1. V70 (déjà en production)
--   2. CE FICHIER (migration-v76-storage-origin-config.sql)
--   3. CONFIGURATION CIO DE L'ORIGINE (voir section 4 plus bas pour la
--      commande exacte) -- DOIT avoir lieu ICI, avant l'étape 4,
--      jamais après. Sans cette étape, la table existe mais reste
--      vide : le préflight (étape 4) continuera de réussir (il ne
--      dépend pas de cette valeur), mais toute tentative d'envoi de
--      logo/cover échouera dès que V71 (étape 5) sera en place, tant
--      que cette étape 3 n'est pas faite.
--   4. preflight-historical-uuid-check.sql (déjà existant, inchangé)
--   5. migration-v71-hardening.sql (ÉDITÉ par ce lot -- lit désormais
--      la table, plus le GUC)
--   6. migration-v72-hardening.sql (inchangé -- ne touche pas ce
--      mécanisme, confirmé par inventaire, voir rapport de livraison)
--   7. migration-v73-hardening.sql (inchangé, même confirmation)
--
-- Cette même séquence à 7 étapes doit être reflétée IDENTIQUEMENT dans
-- le rapport de livraison, le runbook transmis au CIO, et les tests
-- d'ordre du harnais -- une seule séquence documentée, jamais deux
-- versions divergentes.
--
-- Justification de cet ordre : la table de configuration doit exister
-- AVANT que V71 ne tente de la lire (ordre de dépendance normal), et
-- avant le préflight UUID (qui ne dépend pas de ce mécanisme, mais
-- garder son emplacement existant dans la séquence évite de perturber
-- un fichier déjà audité favorablement par Work).
--
-- NE PAS EXÉCUTER AUTOMATIQUEMENT : le CIO exécute ce fichier
-- manuellement, après audit indépendant ChatGPT Work, PUIS renseigne
-- la valeur réelle (voir section 4 ci-dessous), PUIS seulement ensuite
-- exécute le préflight et V71/V72/V73.
--
-- Ne modifie ni ne touche V68/V69/V70 (déjà en production) : aucune
-- ligne de ces fichiers n'est éditée par ce lot.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Contrôle préalable.
-- ------------------------------------------------------------------

do $$
declare
  v_count       integer;
  v_oid         oid;
  v_rettype     text;
  v_volatile    "char";
  v_secdef      boolean;
  v_owner       text;
  v_funcdef     text;
begin
  -- Corrige V78-01 (contre-audit Work, 9e tour) : ce fichier est LA
  -- PREMIÈRE migration réellement exécutée depuis l'état production
  -- actuel (V70 installée, rien après) -- le contrôle structurel
  -- complet de l'état V70 vivait jusqu'ici UNIQUEMENT dans
  -- migration-v71-hardening.sql, trop tard : ce fichier-ci aurait déjà
  -- créé scanym_internal (schéma/table/fonction) sur un état V70
  -- potentiellement dérivé, AVANT que V71 ne détecte quoi que ce soit.
  -- Le même contrôle structurel complet (jamais un hash fragile du
  -- corps SQL formaté) est donc désormais placé ICI, EN TOUT PREMIER,
  -- avant CREATE SCHEMA/toute création de fonction ou de table. Le
  -- contrôle de V71 (identique) reste en place comme défense en
  -- profondeur, au cas où V76 serait un jour contournée. Chaque
  -- contrôle vérifié empiriquement (scénarios de dérive simulés un
  -- par un, la migration NE DOIT RIEN créer en cas d'échec) avant
  -- d'écrire ce bloc, voir rapport de livraison V79.
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url';

  if v_count = 0 then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.assert_establishment_asset_url introuvable — migration V76 annulée. Prérequis : migration-v70-identity-corrections.sql doit déjà être appliquée (confirmé en production).';
  end if;
  if v_count > 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: % fonction(s) public.assert_establishment_asset_url détectée(s), une seule attendue (surcharge inattendue) — migration V76 annulée. Examiner manuellement avant de relancer.', v_count;
  end if;

  select p.oid into v_oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'assert_establishment_asset_url';

  if pg_get_function_identity_arguments(v_oid) != 'p_restaurant_id uuid, p_kind text, p_url text' then
    raise exception 'SCANYM_SCHEMA_DRIFT: la signature de public.assert_establishment_asset_url ne correspond pas à celle attendue (p_restaurant_id uuid, p_kind text, p_url text) — dérive détectée, migration V76 annulée. Examiner manuellement avant de relancer.';
  end if;

  select prorettype::regtype::text, provolatile, prosecdef, pg_get_userbyid(proowner)
  into v_rettype, v_volatile, v_secdef, v_owner
  from pg_proc where oid = v_oid;

  if v_rettype != 'void' then
    raise exception 'SCANYM_SCHEMA_DRIFT: type de retour de assert_establishment_asset_url attendu "void", obtenu "%" — dérive détectée, migration V76 annulée.', v_rettype;
  end if;
  if v_volatile != 's' then
    raise exception 'SCANYM_SCHEMA_DRIFT: volatilité de assert_establishment_asset_url attendue STABLE, obtenue "%" — dérive détectée, migration V76 annulée.', v_volatile;
  end if;
  if not v_secdef then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_establishment_asset_url attendue SECURITY DEFINER, absente — dérive détectée, migration V76 annulée.';
  end if;
  if v_owner != 'postgres' then
    raise exception 'SCANYM_SCHEMA_DRIFT: propriétaire de assert_establishment_asset_url attendu "postgres" (convention standard de ce projet), obtenu "%" — dérive détectée, migration V76 annulée.', v_owner;
  end if;
  if not exists (
    select 1 from pg_proc where oid = v_oid and 'search_path=""' = any(proconfig)
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_establishment_asset_url attendue avec search_path = '''' , absent ou différent — dérive détectée, migration V76 annulée.';
  end if;

  v_funcdef := pg_get_functiondef(v_oid);
  if v_funcdef !~ 'current_setting\(''app\.storage_public_base_url''' then
    raise exception 'SCANYM_SCHEMA_DRIFT: le corps de assert_establishment_asset_url ne contient pas le marqueur caractéristique de V70 (lecture de app.storage_public_base_url) — dérive détectée (fonction potentiellement déjà modifiée de façon inattendue), migration V76 annulée. Examiner manuellement avant de relancer.';
  end if;

  if exists (
    select 1 from pg_namespace where nspname = 'scanym_internal'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: le schéma scanym_internal existe déjà — migration V76 annulée pour éviter une double application. Vérifier manuellement l''état avant de relancer.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 2a. Schéma dédié, PAR DÉFAUT non exposé à l'API Data (PostgREST) --
-- confirmé : un schéma n'est exposé que s'il est explicitement ajouté
-- à "Exposed schemas" dans le tableau de bord Supabase, jamais par
-- simple création SQL. Révocation explicite en défense en profondeur.
-- ------------------------------------------------------------

create schema scanym_internal;

revoke all on schema scanym_internal from public;
revoke all on schema scanym_internal from anon;
revoke all on schema scanym_internal from authenticated;
grant usage on schema scanym_internal to postgres;

-- ------------------------------------------------------------
-- 2b. Table de configuration -- une seule ligne possible par
-- construction (id booléen en clé primaire + contrainte id = true :
-- toute tentative d'insérer une seconde ligne violerait la clé
-- primaire, aucune origine concurrente possible). Structure minimale :
-- une seule colonne de valeur.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 2b bis. Helper de validation UNIQUE et partagé (corrige V76-04,
-- contre-audit Work) : IMMUTABLE, utilisé À LA FOIS par la contrainte
-- CHECK ci-dessous ET par assert_establishment_asset_url (V71 édité)
-- -- jamais deux regex divergentes maintenues séparément.
--
-- Contrat strict :
--   - schéma "https://" minuscule, strictement obligatoire ;
--   - host DNS non vide, débutant par un caractère alphanumérique ;
--   - host EXCLUT explicitement toute forme purement numérique
--     ("https://1", "https://999.999.999.999") -- un host ambigu
--     ressemblant à une IP mal formée ou un entier nu n'est jamais
--     une référence de projet Supabase valide (toujours
--     alphanumérique, ex. "ctqfpszwunfomrbxgigu") ;
--   - port optionnel, STRICTEMENT 1-65535 (même motif que
--     lib/maps-url.ts, PORT_1_TO_65535) ;
--   - AUCUN chemin, query, fragment, slash final, espace ou retour
--     ligne -- ancré début et fin, rien d'autre toléré après le host
--     (et l'éventuel port).
-- Vérifié exhaustivement (17 cas) avant intégration, voir rapport de
-- livraison V77.
-- ------------------------------------------------------------

create or replace function scanym_internal.is_valid_storage_origin(p_origin text)
returns boolean
language plpgsql
immutable
as $$
declare
  v_match text[];
  v_host  text;
  v_port  text;
begin
  if p_origin is null then
    return false;
  end if;

  -- Corrige V77-02 (contre-audit Work, 8e tour) : host et port
  -- désormais séparés EXPLICITEMENT et validés INDÉPENDAMMENT --
  -- l'ancien lookahead négatif ancré en fin de chaîne
  -- (?!\d+(\.\d+)*$) cessait de s'appliquer dès qu'un port suivait le
  -- host (le "$" de fin de chaîne ne matchait plus juste après le
  -- host), laissant passer "https://1:443",
  -- "https://999.999.999.999:443", "https://127.0.0.1:5432" -- tous
  -- confirmés acceptés à tort avant ce correctif, tous refusés après
  -- (vérifié empiriquement avant intégration, voir rapport de
  -- livraison V78).
  --
  -- Une seule capture ancrée début/fin : host (aucun caractère
  -- ":", "/", "?", "#" ni espace/retour ligne) suivi d'un port
  -- optionnel (uniquement des chiffres). Rien d'autre toléré après
  -- (chemin/query/fragment exclus par construction).
  v_match := regexp_match(p_origin, '^https://([^:/?#\s]+)(?::([0-9]+))?$');
  if v_match is null then
    return false;
  end if;

  v_host := v_match[1];
  v_port := v_match[2];

  if v_host = '' or v_host is null then
    return false;
  end if;

  -- Host purement numérique (chiffres et points uniquement) refusé
  -- EXPLICITEMENT, quel que soit le port -- validé INDÉPENDAMMENT du
  -- port, jamais couplé dans un seul motif fragile.
  if v_host ~ '^[0-9]+(\.[0-9]+)*$' then
    return false;
  end if;

  -- Grammaire DNS standard pour le host (lettres/chiffres/tirets,
  -- jamais de tiret en tête/fin de libellé).
  if v_host !~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$' then
    return false;
  end if;

  -- Port éventuel : strictement 1-65535 (même motif que
  -- lib/maps-url.ts, PORT_1_TO_65535), validé indépendamment du host.
  if v_port is not null and v_port !~ '^(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3})$' then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function scanym_internal.is_valid_storage_origin(text) from public;
revoke all on function scanym_internal.is_valid_storage_origin(text) from anon;
revoke all on function scanym_internal.is_valid_storage_origin(text) from authenticated;
grant execute on function scanym_internal.is_valid_storage_origin(text) to postgres;

create table scanym_internal.storage_config (
  id                    boolean primary key default true,
  storage_public_origin text not null,
  updated_at            timestamptz not null default now(),
  constraint storage_config_single_row check (id),
  -- Corrige V76-04 : réutilise le helper partagé ci-dessus, jamais une
  -- regex répétée/divergente.
  constraint storage_config_origin_format check (
    scanym_internal.is_valid_storage_origin(storage_public_origin)
  )
);

comment on table scanym_internal.storage_config is
  'Origine Storage publique de CET environnement Supabase (une seule ligne, jamais exposée à anon/authenticated ni à l''API Data). Remplace app.storage_public_base_url (GUC), incompatible avec Supabase hébergé (ALTER DATABASE ... SET refusé, 42501). Voir migration-v76-storage-origin-config.sql pour la procédure de configuration par le CIO.';

revoke all on scanym_internal.storage_config from public;
revoke all on scanym_internal.storage_config from anon;
revoke all on scanym_internal.storage_config from authenticated;
grant select, insert, update, delete on scanym_internal.storage_config to postgres;

-- ------------------------------------------------------------
-- 2c. Fonction interne de lecture -- jamais accordée à
-- anon/authenticated directement ; seules les fonctions
-- SECURITY DEFINER internes (assert_establishment_asset_url) la
-- consomment, avec les privilèges de leur propriétaire.
-- ------------------------------------------------------------

create or replace function scanym_internal.get_storage_public_origin()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select storage_public_origin from scanym_internal.storage_config limit 1;
$$;

revoke all on function scanym_internal.get_storage_public_origin() from public;
revoke all on function scanym_internal.get_storage_public_origin() from anon;
revoke all on function scanym_internal.get_storage_public_origin() from authenticated;

commit;

-- ============================================================
-- 3. VÉRIFICATIONS À REJOUER MANUELLEMENT (voir preuve automatisée
-- réelle dans supabase/tests/v68-storage-policy-check.sh, étendu pour
-- V76) :
--  ✗ anon ne peut ni lire ni écrire scanym_internal.storage_config
--  ✗ authenticated ne peut ni lire ni écrire scanym_internal.storage_config
--  ✗ anon/authenticated ne peuvent pas exécuter get_storage_public_origin()
--  ✗ une deuxième ligne (id=false explicitement, ou toute tentative de
--    contourner le singleton) est rejetée par la contrainte
--  ✗ une valeur avec chemin/query/fragment/slash final/espace est
--    rejetée par storage_config_origin_format
--  ✓ insertion d'une origine valide réussit avec un privilège
--    NORMAL (INSERT), jamais un privilège superutilisateur
-- ============================================================

-- ============================================================
-- 4. CONFIGURATION REQUISE PAR LE CIO (jamais exécutée par cette
-- migration -- exemple donné à titre indicatif uniquement) :
--
--   insert into scanym_internal.storage_config (id, storage_public_origin)
--   values (true, 'https://ctqfpszwunfomrbxgigu.supabase.co')
--   on conflict (id) do update set
--     storage_public_origin = excluded.storage_public_origin,
--     updated_at = now();
--
-- Cette commande utilise un privilège INSERT/UPDATE ordinaire --
-- fonctionne sans aucun privilège élevé sur Supabase hébergé,
-- contrairement à `ALTER DATABASE ... SET` (confirmé refusé en
-- production, voir l'en-tête de ce fichier). Aucun secret : l'URL
-- Storage publique d'un projet Supabase n'est pas une information
-- sensible (déjà visible dans le code client, les URLs de logo/cover
-- existantes, etc.).
-- ============================================================
