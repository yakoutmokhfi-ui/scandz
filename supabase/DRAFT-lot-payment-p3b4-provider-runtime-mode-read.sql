-- ============================================================
-- Scanym — PAYMENT P3-B4 — PROVIDER RUNTIME MODE READ CAPABILITY —
-- v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot existe parce que l'audit d'architecture post-Work de
-- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v2 (verdict indépendant
-- « FAIL — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v2 — NOT READY FOR
-- CIO GO ») a identifié :
--   PAY-P3B-V2-06 — MEDIUM — « Two uncorrelated environment
--   authorities » : le candidat rejeté introduisait une variable
--   d'environnement globale (`PAYMENT_MONETICO_MODE`) comme seule
--   autorité de sélection Sandbox/Production, alors que
--   `payment_provider_configs.mode` (PAYMENT P1 FOUNDATION,
--   `'test'|'live'`, écrite par `set_payment_provider_credentials`,
--   PAYMENT P2A, déjà publiée) porte déjà, PAR TENANT, exactement cette
--   même information -- persistée, réelle, jamais hypothétique. Les
--   deux autorités peuvent structurellement diverger (un tenant
--   configuré `test` alors que la variable globale vaut `production`,
--   ou l'inverse), un état dangereux qu'aucune capacité publiée ne
--   permettait de détecter ni de prévenir avant ce lot.
--
-- INSPECTION DIRECTE DU BASELINE (mandat section 4, jamais devinée) :
--   - `payment_provider_configs.mode` porte EXACTEMENT la contrainte
--     `payment_provider_configs_mode_check` = CHECK ((mode = ANY
--     (ARRAY['test'::text, 'live'::text]))) -- confirmé par
--     introspection directe de `pg_constraint` sur une base construite
--     depuis le baseline réel avant l'écriture de ce fichier, jamais
--     supposé depuis la seule lecture du fichier source PAYMENT P1.
--     Valeurs canoniques persistées : EXACTEMENT 'test' | 'live' --
--     jamais 'sandbox'/'production' au niveau base (mandat section 5,
--     "Do NOT invent sandbox/production at DB level"). Un futur
--     adaptateur prestataire (Monetico ou autre) reste seul responsable
--     de traduire cette valeur canonique vers son propre vocabulaire
--     d'environnement -- hors périmètre de ce lot.
--   - `payment_provider_configs.mode` est ÉCRITE UNIQUEMENT par
--     `set_payment_provider_credentials` (PAYMENT P2A, déjà publiée,
--     NON modifiée ni rouverte par ce lot) -- AUCUNE nouvelle colonne
--     mode/environment/sandbox n'est ajoutée ici (mandat section 12,
--     "Absolutely DO NOT add another environment/mode field") ; ce lot
--     expose fidèlement la valeur DÉJÀ persistée, il n'en crée aucune
--     nouvelle source.
--
-- POURQUOI P3-B1 NE PEUT PAS ÊTRE ÉTENDU EN PLACE (mandat section 6,
-- OPTION A vs OPTION B) : `get_payment_runtime_provider_config(uuid,
-- text)` (PAYMENT P3-B1, déjà publiée et utilisée -- voir
-- lib/server/payment-service.ts::getPaymentRuntimeProviderConfig et
-- son propre test dédié tests/v113-payment-p3b1-service.test.ts) a un
-- contrat `returns table` FIGÉ à 3 colonnes exactes (provider_code,
-- is_enabled, configuration_status). PostgreSQL n'autorise PAS
-- `CREATE OR REPLACE FUNCTION` à modifier l'ensemble de colonnes d'un
-- `RETURNS TABLE` existant -- cela exige structurellement un `DROP
-- FUNCTION` puis une recréation, ce qui est exactement le risque que
-- le mandat demande d'éviter ("Do NOT casually break its existing
-- 3-field return contract"). DROP+CREATE romprait la RÉSOLUTION DE
-- SURCHARGE pour tout appelant existant pendant la fenêtre de
-- migration, romprait l'identité stable du catalogue (OID de fonction)
-- que d'autres outils (introspection, futurs GRANT différentiels)
-- pourraient légitimement référencer, et romprait la garantie de non-
-- régression déjà auditée du contrat 3 colonnes de PAYMENT P3-B1 --
-- sans aucun bénéfice, puisqu'une capacité sœur additive atteint
-- exactement le même résultat sans aucun de ces risques. PAYMENT P3-B1
-- reste donc STRICTEMENT INCHANGÉ, NON rouvert, NON redéfini par ce
-- lot (mandat sections 6/17) -- exactement le même principe déjà
-- appliqué par ce lot lui-même envers P1/P3-A0/P3-B0/P3-B2/P3-B3.
--
-- DÉCISION : CAPACITÉ SŒUR, CONTRAT COMPLET (mandat section 9, "Goal:
-- one unambiguous tenant-scoped runtime configuration authority") --
-- PAS une capacité "mode seul". Une fonction dédiée qui ne renverrait
-- QUE `mode` obligerait tout futur appelant runtime à exécuter DEUX
-- lectures indépendantes (celle-ci PLUS `get_payment_runtime_provider_
-- config`) pour obtenir l'image complète nécessaire à une décision de
-- checkout -- deux lectures séparées, même en `stable`, ne garantissent
-- PAS d'observer un instantané cohérent si une configuration change
-- entre les deux appels (ex. un marchand désactive son prestataire ou
-- change de mode entre les deux lectures dans le même flux entrant),
-- ce qui recréerait exactement le genre d'incohérence à deux autorités
-- que ce lot existe pour éliminer. `get_payment_runtime_provider_
-- environment` ci-dessous est donc une lecture UNIQUE, autonome
-- (aucun appel interne à `get_payment_runtime_provider_config` --
-- indirection inutile, les deux fonctions restent indépendantes et
-- évoluables séparément), qui renvoie le QUADRUPLET complet
-- (provider_code, is_enabled, configuration_status, mode) en un seul
-- instantané transactionnel cohérent. `get_payment_runtime_provider_
-- config` (PAYMENT P3-B1) continue d'exister, inchangée, pour tout
-- appelant qui n'a besoin que du triplet original -- les deux
-- fonctions coexistent, aucune n'appelle l'autre, aucune ne dépend de
-- l'autre pour fonctionner.
--
-- PRÉREQUIS (déjà publiés, INCHANGÉS et NON ROUVERTS par ce lot) :
-- PAYMENT P1 FOUNDATION (payment_provider_configs, restaurant_id,
-- provider_code, is_enabled, mode, contrainte unique(restaurant_id,
-- provider_code), contrainte CHECK mode) et PAYMENT P2A SECURE
-- CONFIGURATION FOUNDATION (configuration_status, avec ses valeurs
-- autorisées CHECK (configuration_status in ('not_configured',
-- 'configured','verified'))). PAYMENT P3-B1 est vérifié comme
-- PRÉALABLEMENT APPLIQUÉ par la garde ci-dessous -- NON pour une
-- dépendance de colonne/fonction (cette fonction n'appelle jamais
-- `get_payment_runtime_provider_config`), mais pour une cohérence
-- d'ORDRE DE CAPACITÉS : ce lot corrige explicitement un manque de
-- PAYMENT P3-B1, il serait incohérent qu'il s'applique sur un
-- baseline où PAYMENT P3-B1 lui-même n'existe pas encore.
--
-- CONFIGURATION_STATUS / MODE -- VALEURS AUTORISÉES (vérifiées par
-- introspection directe ci-dessus, jamais devinées) : EXACTEMENT
-- 'not_configured' | 'configured' | 'verified' pour configuration_status
-- (contrainte CHECK déjà posée par PAYMENT P2A, non modifiée, non
-- dupliquée ici) et EXACTEMENT 'test' | 'live' pour mode (contrainte
-- CHECK déjà posée par PAYMENT P1, non modifiée, non dupliquée ici).
-- Ce lot ne décide d'AUCUNE politique métier sur ces valeurs -- il
-- expose fidèlement la valeur stockée, telle quelle, sans filtrage ni
-- réinterprétation, exactement le même principe déjà établi par
-- PAYMENT P3-B1 pour configuration_status.
--
-- UNICITÉ (vérifiée par introspection directe ci-dessus, jamais
-- supposée) : `payment_provider_configs` porte déjà
-- `unique (restaurant_id, provider_code)`
-- (`payment_provider_configs_restaurant_id_provider_code_key`,
-- contrainte posée par PAYMENT P1) -- au plus une ligne peut
-- structurellement exister par couple (restaurant_id, provider_code).
-- Revérifiée explicitement en garde préflight ci-dessous (section 1)
-- ET par défense en profondeur dans le corps de la fonction (section
-- 2, "v_match_count > 1"), exactement le même patron défensif déjà
-- établi par PAYMENT P3-B0/P3-B1.
--
-- PATRON DE SÉCURITÉ PRÉSERVÉ (mandat section 7) : SECURITY DEFINER,
-- `stable`, `search_path` explicitement vide, toutes les références de
-- table pleinement qualifiées (`public.payment_provider_configs`),
-- AUCUN grant de table nouveau (`payment_provider_configs` reste sans
-- aucun privilège direct pour service_role/anon/authenticated/PUBLIC
-- -- cette fonction, comme PAYMENT P3-B1 avant elle, reste une lecture
-- SECURITY DEFINER pure, jamais un relais de privilège de table).
-- AUCUNE clause OWNER TO explicite -- la fonction hérite de la
-- propriété du rôle exécutant cette migration au déploiement,
-- identique au patron déjà établi par tous les lots précédents. AUCUN
-- verrou (`FOR UPDATE`), AUCUNE écriture, AUCUN SQL dynamique.
--
-- AUCUNE DONNÉE SECRÈTE (mandat sections 9/28) : le contrat de retour
-- est STRICTEMENT `provider_code, is_enabled, configuration_status,
-- mode` -- jamais `id`, jamais `restaurant_id` (l'appelant le connaît
-- déjà, il l'a fourni), jamais `credentials_ref`, jamais
-- `last_verified_at`/`updated_at`/`status` (le champ `status` de
-- PAYMENT P2A, distinct de `is_enabled`, n'a aucun besoin runtime
-- prouvé ici -- même raisonnement que PAYMENT P3-B1 pour les champs
-- qu'elle exclut déjà), et évidemment jamais aucun matériel Vault --
-- cette fonction ne référence NULLE PART le schéma `vault`.
--
-- GÉNÉRICITÉ (mandat section 15) : aucune valeur ni endpoint
-- spécifique à un prestataire nommé (Monetico ou autre) n'apparaît
-- nulle part dans ce fichier -- `mode` reste une configuration tenant
-- générique, la traduction vers un endpoint concret (Sandbox/
-- Production Monetico, ou l'équivalent d'un futur prestataire) reste
-- entièrement la responsabilité d'un futur adaptateur runtime, hors
-- périmètre de ce lot.
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
      and column_name in ('restaurant_id','provider_code','is_enabled','configuration_status','mode')
    having count(*) = 5
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.payment_provider_configs -- prérequis PAYMENT P1 FOUNDATION/PAYMENT P2A SECURE CONFIG FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_provider_configs'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%restaurant_id%'
      and pg_get_constraintdef(oid) ilike '%provider_code%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte unique (restaurant_id, provider_code) introuvable sur public.payment_provider_configs -- invariant requis par la lecture runtime absent, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_provider_configs'::regclass
      and contype = 'c'
      and conname = 'payment_provider_configs_configuration_status_check'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte CHECK sur configuration_status introuvable -- prérequis PAYMENT P2A SECURE CONFIG FOUNDATION manquant, migration annulée.';
  end if;

  -- Vérification DIRECTE de la contrainte CHECK sur `mode` (mandat
  -- section 11, "Do not guess constraint names if catalogue inspection
  -- provides better structural verification" -- nom et définition
  -- confirmés par introspection réelle avant l'écriture de ce fichier,
  -- voir en-tête). Valide à la fois l'EXISTENCE de la contrainte et
  -- que ses valeurs autorisées couvrent bien 'test' et 'live' --
  -- refuse de s'appliquer sur un schéma où `mode` existerait sous une
  -- contrainte différente/plus large (mandat section 27, "STOP if
  -- existing mode semantics are ambiguous").
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_provider_configs'::regclass
      and contype = 'c'
      and conname = 'payment_provider_configs_mode_check'
      and pg_get_constraintdef(oid) ilike '%test%'
      and pg_get_constraintdef(oid) ilike '%live%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte CHECK attendue sur payment_provider_configs.mode (test/live) introuvable ou différente de celle attendue -- prérequis PAYMENT P1 FOUNDATION manquant ou sémantique de mode ambiguë, migration annulée.';
  end if;

  -- Cohérence d'ORDRE de capacités (PAS une dépendance de colonne/
  -- fonction -- voir en-tête) : PAYMENT P3-B1 doit déjà être appliqué.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_payment_runtime_provider_config'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_payment_runtime_provider_config (PAYMENT P3-B1) introuvable -- ce lot corrige un manque de PAYMENT P3-B1 et exige qu''il soit déjà appliqué, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_payment_runtime_provider_environment'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_payment_runtime_provider_environment existe déjà -- PAYMENT P3-B4 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_payment_runtime_provider_environment — LECTURE SERVEUR DE
-- CONFIANCE, SEULE, service_role UNIQUEMENT. Capacité SŒUR de PAYMENT
-- P3-B1 (voir en-tête pour la justification complète du choix
-- "capacité sœur, contrat complet" plutôt qu'une évolution en place ou
-- une capacité "mode seul").
--
-- Contrat de retour DÉLIBÉRÉMENT minimal mais COMPLET (mandat sections
-- 9/28) : provider_code (confirmation de la ligne exacte trouvée),
-- is_enabled (bascule d'activation runtime AUTORITATIVE, PAYMENT P1),
-- configuration_status (état de cycle de vie du credential, PAYMENT
-- P2A), mode (autorité d'environnement AUTORITATIVE PAR TENANT,
-- PAYMENT P1/P2A -- 'test'|'live', jamais réinterprétée ici). PAS de
-- id/restaurant_id/credentials_ref/last_verified_at/updated_at/status
-- -- aucun besoin runtime strict prouvé pour ces champs.
--
-- CORRESPONDANCE EXACTE UNIQUEMENT (même patron que PAYMENT P3-B1) :
-- aucune correspondance partielle, aucun repli sur un autre
-- prestataire, aucun prestataire par défaut. `p_provider_code` est
-- normalisé par `btrim` SEUL (aucune mise en minuscule -- même patron
-- que P3-A0/P3-B0/P3-B1) avant comparaison exacte.
--
-- ÉCHEC FERMÉ (mandat section 10) : p_restaurant_id NULL,
-- p_provider_code NULL/vide/uniquement blancs après normalisation ->
-- exception. Aucune configuration correspondante -> exception (P0002).
-- Plusieurs correspondances (structurellement impossible tant que
-- l'index unique de PAYMENT P1 reste en place, revérifié en garde
-- préflight ci-dessus) -> exception (P0003), jamais un choix arbitraire
-- de ligne.
--
-- AUCUNE ÉCRITURE : SELECT uniquement, aucun verrou FOR UPDATE.
-- Appels répétés : zéro effet de bord, par construction.
-- ------------------------------------------------------------
create or replace function public.get_payment_runtime_provider_environment(
  p_restaurant_id uuid,
  p_provider_code text
)
returns table (
  provider_code        text,
  is_enabled           boolean,
  configuration_status text,
  mode                 text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_match_count integer;
begin
  if p_restaurant_id is null then
    raise exception 'SCANYM_PAYMENT_RUNTIME_ENVIRONMENT: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT_RUNTIME_ENVIRONMENT: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;

  select count(*) into v_match_count
    from public.payment_provider_configs c
    where c.restaurant_id = p_restaurant_id
      and c.provider_code = v_provider_code;

  if v_match_count = 0 then
    raise exception 'SCANYM_PAYMENT_RUNTIME_ENVIRONMENT: aucune configuration ne correspond à ce restaurant/provider' using errcode = 'P0002';
  end if;

  -- Défense en profondeur (même patron que PAYMENT P3-B0/P3-B1) :
  -- structurellement impossible tant que l'index unique de PAYMENT P1
  -- reste en place (vérifié en garde préflight ci-dessus) -- cette
  -- fonction ne suppose néanmoins jamais silencieusement que cette
  -- garantie externe ne pourra jamais changer.
  if v_match_count > 1 then
    raise exception 'SCANYM_PAYMENT_RUNTIME_ENVIRONMENT: correspondance ambiguë (plusieurs configurations) pour ce restaurant/provider -- échec fermé, incohérence d''intégrité' using errcode = 'P0003';
  end if;

  return query
    select c.provider_code, c.is_enabled, c.configuration_status, c.mode
    from public.payment_provider_configs c
    where c.restaurant_id = p_restaurant_id
      and c.provider_code = v_provider_code;
end;
$$;

comment on function public.get_payment_runtime_provider_environment(uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B4. Lecture serveur de confiance, SEULE, en LECTURE PURE, du quadruplet (provider_code, is_enabled, configuration_status, mode) d''une configuration prestataire, pour un couple (restaurant_id, provider_code) exact, en UN SEUL instantané transactionnel cohérent. Réponse à PAY-P3B-V2-06 ("Two uncorrelated environment authorities") : payment_provider_configs.mode (PAYMENT P1/P2A, ''test''|''live'', déjà persistée par tenant) devient l''AUTORITÉ D''ENVIRONNEMENT UNIQUE pour un futur runtime de paiement -- aucune variable d''environnement globale de sélection Sandbox/Production ne doit plus exister à côté de cette lecture. Capacité SŒUR de get_payment_runtime_provider_config (PAYMENT P3-B1, INCHANGÉE, NON rouverte, continue de coexister pour tout appelant n''ayant besoin que du triplet original) -- aucune des deux fonctions n''appelle l''autre. Ne retourne JAMAIS id, restaurant_id, credentials_ref, last_verified_at, updated_at, status, ni aucun matériel Vault. Échec fermé si entrée NULL/vide, aucune correspondance, ou correspondance ambiguë (structurellement empêché par l''index unique de PAYMENT P1, revérifié ici en défense en profondeur). Aucune écriture, aucun verrou.';

revoke all on function public.get_payment_runtime_provider_environment(uuid, text) from public, anon, authenticated;
grant execute on function public.get_payment_runtime_provider_environment(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. NON-RÉGRESSION EXPLICITE (mandat sections 16/17) : ce lot n'altère
-- AUCUN privilège de table existant, ni AUCUNE fonction existante --
-- get_payment_runtime_provider_config (PAYMENT P3-B1),
-- get_merchant_payment_provider_config (PAYMENT P2B-A),
-- get_payment_provider_credential (PAYMENT P3-A0),
-- get_payment_transaction_correlation/get_order_payment_status
-- (PAYMENT P3-B0), get_order_payment_context (PAYMENT P3-B2),
-- get_order_active_payment_attempt (PAYMENT P3-B3),
-- initiate_payment_attempt/confirm_payment_attempt (PAYMENT P1)
-- restent STRICTEMENT INCHANGÉES -- ce lot ne les modifie ni ne les
-- redéfinit. Aucun grant de table nouveau n'est ajouté par ce lot,
-- pour quelque rôle que ce soit -- la fonction ci-dessus reste la
-- SEULE addition de ce lot, et payment_provider_configs reste sans
-- aucun privilège de table direct pour service_role/anon/authenticated
-- /PUBLIC, exactement comme depuis PAYMENT P1 FOUNDATION.
-- ------------------------------------------------------------

commit;
