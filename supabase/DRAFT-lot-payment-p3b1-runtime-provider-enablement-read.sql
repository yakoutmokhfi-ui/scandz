-- ============================================================
-- Scanym — PAYMENT P3-B1 — RUNTIME PROVIDER ENABLEMENT READ
-- CAPABILITY — v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot existe parce que PAYMENT P3-B MONETICO CHECKOUT
-- RUNTIME v1 a effectué son inspection d'architecture obligatoire et
-- s'est arrêté correctement avec :
--   STOP — PAYMENT P3-B RUNTIME PROVIDER CONFIG CAPABILITY REQUIRED
--
-- Constat précis : avant qu'une requête client anonyme puisse
-- déclencher `initiate_payment_attempt(...)`, le runtime serveur de
-- confiance doit pouvoir vérifier que le prestataire sélectionné est
-- RÉELLEMENT activé pour CE tenant précis. Trois obstacles combinés
-- empêchaient cela jusqu'ici :
--
--   A. `public.payment_provider_configs` a AUCUN privilège direct
--      accordé à anon/authenticated/service_role/PUBLIC (PAYMENT P1,
--      RPC-ONLY AUTHORITY, `revoke all ... from anon, authenticated,
--      service_role, public`) -- service_role lui-même ne peut pas
--      lire cette table directement.
--
--   B. `get_merchant_payment_provider_config(uuid)` (PAYMENT P2B-A)
--      est la SEULE fonction existante exposant `is_enabled`/
--      `configuration_status` -- mais son EXECUTE n'est accordé qu'à
--      `authenticated`, et son corps exige `auth.uid() is not null`
--      PLUS `is_member_of(p_restaurant_id)`. Une requête d'initiation
--      de paiement client anonyme n'a et n'aura jamais de session
--      Supabase Auth -- cette fonction rejetterait systématiquement
--      un tel appel, et service_role n'a de toute façon aucun EXECUTE
--      dessus. Modèle de confiance délibérément différent (session
--      marchand authentifiée + appartenance), volontairement NON
--      réutilisé ici (mandat section 16) -- les deux responsabilités
--      restent séparées.
--
--   C. `get_payment_provider_credential(uuid, text)` (PAYMENT P3-A0)
--      exige `configuration_status IN ('configured', 'verified')`
--      mais son propre commentaire documente explicitement qu'elle ne
--      lit PAS `is_enabled` : « activation runtime distincte, hors
--      périmètre de ce lot ». Une configuration `configured` mais
--      encore `is_enabled = false` (crédential vérifié par Scanym
--      mais paiement pas encore activé pour ce tenant) laisserait
--      passer la lecture de credential sans jamais confirmer
--      l'activation runtime -- l'existence/la disponibilité d'un
--      credential N'EST PAS équivalente à l'activation (mandat
--      section 32, "Do not assume credential existence alone means
--      checkout enabled"). P3-A0 reste volontairement INCHANGÉ par ce
--      lot (mandat section 17) -- cette séparation entre disponibilité
--      du credential et activation runtime est un choix
--      architectural délibéré, pas un oubli à corriger ici.
--
-- CE LOT FERME UNIQUEMENT CE MANQUE PRÉCIS -- une lecture runtime
-- SEULE, en LECTURE PURE, service_role UNIQUEMENT, du triplet minimal
-- (provider_code, is_enabled, configuration_status) nécessaire à un
-- futur PAYMENT P3-B pour décider s'il peut appeler
-- `initiate_payment_attempt(...)`. N'IMPLÉMENTE AUCUN checkout, AUCUNE
-- route de paiement/callback, AUCUN appel réseau Monetico, AUCUNE
-- activation de tenant, AUCUNE écriture de configuration/credential.
-- Mini-lot SQL isolé, au même titre que PAYMENT P3-A0/P3-B0 l'ont été.
--
-- PRÉREQUIS (déjà publiés, INCHANGÉS et NON ROUVERTS par ce lot) :
-- PAYMENT P1 FOUNDATION (payment_provider_configs, restaurant_id,
-- provider_code, is_enabled, contrainte unique(restaurant_id,
-- provider_code)) et PAYMENT P2A SECURE CONFIGURATION FOUNDATION
-- (configuration_status, avec ses valeurs autorisées CHECK
-- (configuration_status in ('not_configured','configured',
-- 'verified'))). Ce lot NE dépend PAS de PAYMENT P2B-A ni PAYMENT
-- P3-A0 -- ni l'un ni l'autre n'ajoute de colonne/contrainte requise
-- ici, ce sont des capacités soeurs, pas des prérequis de schéma.
--
-- CONFIGURATION_STATUS -- VALEURS AUTORISÉES (mandat sections 6/27,
-- inspectées directement dans supabase/DRAFT-lot-payment-p2a-secure-
-- config.sql avant d'écrire ce fichier, jamais devinées) : EXACTEMENT
-- 'not_configured' | 'configured' | 'verified' (contrainte CHECK déjà
-- posée par PAYMENT P2A, non modifiée, non dupliquée ici). Ce lot ne
-- décide d'AUCUNE politique métier sur ces valeurs -- il expose
-- fidèlement la valeur stockée, telle quelle, sans filtrage ni
-- réinterprétation. Documentation, PAS décision (mandat section 6,
-- "P3-B1 itself should NOT decide business orchestration") : un futur
-- PAYMENT P3-B peut envisager 'configured' et 'verified' comme
-- potentiellement utilisables et 'not_configured' comme jamais
-- utilisable, mais ce choix appartient explicitement à ce futur lot
-- d'orchestration, pas à celui-ci.
--
-- UNICITÉ (mandat sections 19/20, vérifiée directement, jamais
-- supposée) : `payment_provider_configs` porte déjà
-- `unique (restaurant_id, provider_code)` (contrainte posée par
-- PAYMENT P1, nom de catalogue généré
-- `payment_provider_configs_restaurant_id_provider_code_key`,
-- confirmé par introspection directe de `pg_indexes` avant d'écrire ce
-- fichier) -- au plus une ligne peut structurellement exister par
-- couple (restaurant_id, provider_code). Revérifiée explicitement en
-- garde préflight ci-dessous (section 1) ET par défense en profondeur
-- dans le corps de la fonction (section 2, "v_match_count > 1"),
-- exactement le même patron défensif que PAYMENT P3-B0 a déjà établi
-- pour l'unicité de payment_transactions. AUCUN index nouveau n'est
-- ajouté par ce lot -- l'index unique existant satisfait déjà
-- entièrement le besoin de consultation exacte par
-- (restaurant_id, provider_code).
--
-- PATRON DE SÉCURITÉ PRÉSERVÉ (mandat sections 7-9) : SECURITY
-- DEFINER, `search_path` explicitement vide, AUCUN grant de table
-- nouveau (`payment_provider_configs` reste sans aucun privilège
-- direct pour service_role -- cette fonction demeure l'UNIQUE
-- nouvelle autorité de lecture). AUCUNE clause OWNER TO explicite --
-- la fonction hérite de la propriété du rôle exécutant cette
-- migration au déploiement, identique au patron déjà établi par tous
-- les lots précédents.
--
-- AUCUNE DONNÉE SECRÈTE (mandat sections 14/28) : le contrat de
-- retour est STRICTEMENT `provider_code, is_enabled,
-- configuration_status` -- jamais `credentials_ref`, jamais `id`,
-- jamais `restaurant_id` (l'appelant le connaît déjà, il l'a fourni),
-- jamais `mode`/`last_verified_at`/`updated_at` (aucun besoin runtime
-- strict prouvé pour ces champs, mandat section 4, "Do NOT return
-- anything else unless a strict runtime need is proven"), et
-- évidemment jamais aucun matériel Vault -- cette fonction ne
-- référence NULLE PART le schéma `vault`.
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
      and column_name in ('restaurant_id','provider_code','is_enabled','configuration_status')
    having count(*) = 4
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

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_payment_runtime_provider_config'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_payment_runtime_provider_config existe déjà -- PAYMENT P3-B1 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_payment_runtime_provider_config — LECTURE SERVEUR DE
-- CONFIANCE, SEULE, service_role UNIQUEMENT.
--
-- Contrat de retour DÉLIBÉRÉMENT minimal (mandat sections 4/14/28) :
-- provider_code (confirmation de la ligne exacte trouvée),
-- is_enabled (bascule d'activation runtime AUTORITATIVE, PAYMENT P1),
-- configuration_status (état de cycle de vie du credential,
-- PAYMENT P2A). PAS de mode/last_verified_at/updated_at/id/
-- restaurant_id/credentials_ref -- aucun besoin runtime strict prouvé
-- pour ces champs (mandat section 4).
--
-- CORRESPONDANCE EXACTE UNIQUEMENT (mandat section 10) : aucune
-- correspondance partielle, aucun repli sur un autre prestataire,
-- aucun prestataire par défaut. `p_provider_code` est normalisé par
-- `btrim` SEUL (aucune mise en minuscule -- même patron que P3-A0/
-- P3-B0, le schéma publié n'impose aucune règle de casse) avant
-- comparaison exacte -- jamais un repli silencieux vers un autre
-- provider_code.
--
-- ÉCHEC FERMÉ (mandat section 11) : p_restaurant_id NULL,
-- p_provider_code NULL/vide/uniquement blancs après normalisation ->
-- exception. Aucune configuration correspondante -> exception (P0002,
-- "aucun résultat utilisable" -- mandat section 10, "If record does
-- not exist: fail closed / no usable result"). Plusieurs
-- correspondances (structurellement impossible tant que l'index
-- unique de PAYMENT P1 reste en place, revérifié en garde préflight
-- ci-dessus) -> exception (P0003, défense en profondeur, jamais un
-- choix arbitraire de ligne -- mandat section 20, "Do not arbitrarily
-- choose one row").
--
-- AUCUNE ÉCRITURE (mandat section 18) : SELECT uniquement, aucun
-- verrou FOR UPDATE (lecture pure, jamais destinée à préparer une
-- mutation dans cette fonction). Appels répétés : zéro effet de bord,
-- par construction.
-- ------------------------------------------------------------
create or replace function public.get_payment_runtime_provider_config(
  p_restaurant_id uuid,
  p_provider_code text
)
returns table (
  provider_code        text,
  is_enabled           boolean,
  configuration_status text
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
    raise exception 'SCANYM_PAYMENT_RUNTIME_CONFIG: p_restaurant_id requis' using errcode = '22004';
  end if;

  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT_RUNTIME_CONFIG: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;

  select count(*) into v_match_count
    from public.payment_provider_configs c
    where c.restaurant_id = p_restaurant_id
      and c.provider_code = v_provider_code;

  if v_match_count = 0 then
    raise exception 'SCANYM_PAYMENT_RUNTIME_CONFIG: aucune configuration ne correspond à ce restaurant/provider' using errcode = 'P0002';
  end if;

  -- Défense en profondeur (mandat section 20, "If duplicate rows are
  -- structurally possible: STOP") : structurellement impossible tant
  -- que l'index unique de PAYMENT P1 reste en place (vérifié en garde
  -- préflight ci-dessus) -- cette fonction ne suppose néanmoins jamais
  -- silencieusement que cette garantie externe ne pourra jamais
  -- changer, même patron que PAYMENT P3-B0.
  if v_match_count > 1 then
    raise exception 'SCANYM_PAYMENT_RUNTIME_CONFIG: correspondance ambiguë (plusieurs configurations) pour ce restaurant/provider -- échec fermé, incohérence d''intégrité' using errcode = 'P0003';
  end if;

  return query
    select c.provider_code, c.is_enabled, c.configuration_status
    from public.payment_provider_configs c
    where c.restaurant_id = p_restaurant_id
      and c.provider_code = v_provider_code;
end;
$$;

comment on function public.get_payment_runtime_provider_config(uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B1. Lecture serveur de confiance, SEULE, en LECTURE PURE, de l''état d''activation runtime (is_enabled) et du cycle de vie du credential (configuration_status) d''une configuration prestataire, pour un couple (restaurant_id, provider_code) exact. Réponse au STOP — PAYMENT P3-B RUNTIME PROVIDER CONFIG CAPABILITY REQUIRED de PAYMENT P3-B : ni get_merchant_payment_provider_config (authenticated + is_member_of, inutilisable par un runtime anonyme) ni get_payment_provider_credential (ne lit délibérément pas is_enabled) ne peuvent remplir ce rôle -- les deux restent INCHANGÉS et NON réutilisés par ce lot. Ne retourne JAMAIS credentials_ref, id, restaurant_id, mode, last_verified_at, updated_at, ni aucun matériel Vault. Échec fermé si entrée NULL/vide, aucune correspondance, ou correspondance ambiguë (structurellement empêché par l''index unique de PAYMENT P1, revérifié ici en défense en profondeur). Aucune écriture, aucun verrou.';

revoke all on function public.get_payment_runtime_provider_config(uuid, text) from public, anon, authenticated;
grant execute on function public.get_payment_runtime_provider_config(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. NON-RÉGRESSION EXPLICITE (mandat section 9) : ce lot n'altère
-- AUCUN privilège de table existant. Redéclaré ici en NO-OP défensif
-- (déjà en vigueur depuis PAYMENT P1 FOUNDATION -- ce lot confirme
-- qu'il ne l'affaiblit pas, il ne le réémet pas différemment). Aucun
-- grant de table nouveau n'est ajouté par ce lot, pour quelque rôle
-- que ce soit -- la fonction ci-dessus reste la SEULE autorité
-- nouvelle. get_merchant_payment_provider_config (PAYMENT P2B-A) et
-- get_payment_provider_credential (PAYMENT P3-A0) restent
-- STRICTEMENT INCHANGÉS -- ce lot ne les modifie ni ne les
-- redéfinit (mandat sections 16/17).
-- ------------------------------------------------------------

commit;
