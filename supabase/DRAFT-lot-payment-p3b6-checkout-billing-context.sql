-- ============================================================
-- Scanym — PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ferme l'écart identifié par la reconnaissance/vérification
-- P3-B6 (rapports "P3-B6 checkout billing context recon" et "Monetico
-- Annexe 9.5 verification") : le futur adaptateur Monetico
-- (lib/server/payment-providers/monetico) doit pouvoir envoyer un
-- objet `contexte_commande.billing` conforme au contrat Monetico
-- vérifié (billing OBLIGATOIRE, avec addressLine1/city/postalCode/
-- country eux-mêmes OBLIGATOIRES à l'intérieur de l'objet), mais
-- Scanym ne possède aujourd'hui NULLE PART une donnée de facturation
-- structurée, confirmée, prête à être mappée -- seule une adresse de
-- LIVRAISON partiellement structurée existe (order_delivery_address,
-- LOT 2A), et `country` n'est nulle part une valeur réellement saisie
-- par le client (toujours la valeur par défaut 'FR' de la colonne,
-- jamais une confirmation réelle).
--
-- PRINCIPE DIRECTEUR (mandat section 8/24) : ce lot crée un modèle
-- INTERNE, générique, neutre vis-à-vis du prestataire -- noms de
-- colonnes en snake_case générique (address_line_1, postal_code,
-- state_or_province, ...), JAMAIS les noms de champ Monetico
-- (addressLine1, postalCode, stateOrProvince) directement dans le
-- schéma. Le mapping vers le vocabulaire Monetico exact est une
-- responsabilité EXCLUSIVE de la couche adaptateur TypeScript
-- (lib/server/payment-providers/monetico/billing-mapping.ts, hors
-- SQL) -- ce fichier ne connaît ni Monetico, ni contexte_commande, ni
-- MAC. Un futur second prestataire pourra réutiliser EXACTEMENT le
-- même modèle sans qu'aucune colonne ne soit renommée.
--
-- DISTINCTION CENTRALE (mandat section 6) : CRÉATION DE COMMANDE ≠
-- CONTEXTE DE FACTURATION EN LIGNE. Aucune commande pickup/
-- click_collect/table/room_service n'est jamais tenue de fournir une
-- adresse de facturation pour être créée -- `create_order` (LOT 2A,
-- inchangé dans sa logique de validation de commande) continue de
-- n'exiger AUCUNE adresse pour ces modes. Le contexte de facturation
-- défini ici n'est peuplé QUE lorsqu'un client choisit explicitement
-- le paiement en ligne Monetico -- un évènement postérieur et
-- indépendant de la création de commande, qu'aucune route/UI de ce
-- lot n'active (mandat section 25 : "P3-B6 is only a capability
-- layer", "No customer-facing payment button").
--
-- CE LOT MODIFIE DEUX FONCTIONS EXISTANTES, AUCUNE AUTRE :
--   1. `create_order` (RÉ-AUDIT DE BASELINE, mandat section 7 :
--      dernière définition RÉELLE trouvée par grep exhaustif de TOUTES
--      les occurrences de `create or replace function public.
--      create_order(` dans supabase/*.sql, PAS migration-v82-lot2a-
--      sale-modes.sql comme un premier passage superficiel l'avait
--      supposé -- c'est
--      DRAFT-lot-server-delivery-fulfillment-pricing.sql, déjà publié
--      et appliqué APRÈS v82/v83/v84 dans la chaîne réelle, qui porte
--      la définition actuelle : contrat de sortie étendu
--      (order_id, order_number, public_token, subtotal, delivery_fee,
--      total) et moteur de résolution livraison/tarification serveur-
--      autoritaire. Ce lot repart de CETTE définition réelle,
--      verbatim, et y ajoute UNIQUEMENT deux clés lues depuis
--      p_customer (`street`, `city`), pour cesser de perdre des
--      données structurées déjà saisies côté client en mode
--      `delivery` avant qu'elles n'atteignent le serveur (écart
--      confirmé par ré-audit direct du baseline, mandat section 7) --
--      contrat de sortie INCHANGÉ par CE lot (toujours order_id,
--      order_number, public_token, subtotal, delivery_fee, total),
--      AUCUNE colonne `orders` nouvelle, AUCUNE règle de validation de
--      commande changée pour AUCUN mode, moteur de résolution
--      livraison/tarification INCHANGÉ. `country` n'est PAS ajouté
--      ici : aucune UI ne le capture aujourd'hui, et mandat section 12
--      interdit explicitement de persister/transmettre une valeur non
--      confirmée -- voir IMPLEMENTATION-REPORT pour la justification
--      complète de ce choix de périmètre, et pour le détail de
--      l'erreur de premier passage corrigée par ce ré-audit.
--   2. `purge_old_customer_data` (définition : migration-orders.sql)
--      — AJOUT d'une suppression de la ligne `order_billing_context`
--      correspondante (données entièrement personnelles, table
--      supprimée en bloc plutôt que colonne par colonne -- plus
--      simple et strictement équivalent, puisque CETTE table n'a
--      aucune colonne non-personnelle à conserver, contrairement à
--      `orders`). Le manque de couverture préexistant pour
--      `customer_language`/`room_number` n'est PAS corrigé ici
--      (mandat section 22 : "Do NOT silently fold unrelated fixes
--      into P3-B6 unless necessary") -- signalé séparément dans
--      IMPLEMENTATION-REPORT comme `PRE-EXISTING GDPR PURGE GAP`.
--
-- CE LOT NE MODIFIE NI P3-B4 NI P3-B5 (mandat section 2) : aucune
-- fonction/table de ces deux lots n'est référencée, altérée, ou
-- redéfinie ici. Séquencement conceptuel uniquement (P3-B4 confirme
-- le mode/l'activation avant qu'un contexte de facturation ne soit
-- assemblé ; P3-B5 traite les callbacks APRÈS l'envoi -- aucune donnée
-- partagée avec ce lot).
--
-- POSTURE DE SÉCURITÉ (mandat section 20) : `order_billing_context`
-- reçoit la posture la PLUS STRICTE déjà établie dans ce dépôt (celle
-- de `payment_transactions`/`payment_provider_events`, PAS celle, plus
-- permissive, de `order_delivery_address`) : RLS activée, AUCUNE
-- policy, AUCUN grant de table direct pour QUELQUE RÔLE QUE CE SOIT (y
-- compris service_role) -- accès EXCLUSIVEMENT par les deux fonctions
-- SECURITY DEFINER ci-dessous, toutes deux `service_role` UNIQUEMENT
-- (jamais anon/authenticated/PUBLIC), exactement le patron déjà établi
-- par PAYMENT P3-B2/P3-B3/P3-B4 : signature `(p_order_id, p_public_token,
-- ...)`, appelée par un futur serveur de confiance qui relaie le
-- couple de possession fourni par le navigateur anonyme, jamais
-- exposée directement à ce navigateur.
--
-- AUCUNE DONNÉE DE PAIEMENT BRUTE (mandat section 22) : cette table ne
-- stocke JAMAIS de charge utile prestataire, JAMAIS de JSON
-- `contexte_commande` (ni sa forme Base64), JAMAIS de secret Vault,
-- JAMAIS de donnée de carte -- uniquement les champs de facturation
-- eux-mêmes, dans le vocabulaire interne générique.
--
-- LONGUEURS/FORMATS (mandat section 23) : calées sur les contraintes
-- Monetico CONFIRMÉES par la vérification d'annexe précédente (guide
-- de migration 3DSecure v2, section 6.2.2, entièrement lu) --
-- addressLine1/addressLine2/city max 50, postalCode max 10, name max
-- 45, email max 100, phone max 18, country forme ISO 3166-1 alpha-2
-- (2 lettres majuscules), stateOrProvince (ISO 3166-2, code court, max
-- 10). Ces bornes vivent dans CE lot (couche de validation), pas dans
-- le nom des colonnes -- un futur second prestataire avec des bornes
-- différentes changerait ces CHECK, jamais les noms de colonnes.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- prérequis PAYMENT/ORDERS FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'public_token'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.orders.public_token introuvable -- preuve de possession anonyme absente, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'order_delivery_address'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_delivery_address introuvable -- prérequis LOT 2A (sale modes v82) manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_delivery_address'
      and column_name in ('order_id','formatted_address','street','city','postal_code','country')
    having count(*) = 6
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.order_delivery_address -- prérequis LOT 2A incomplet, migration annulée.';
  end if;

  -- CORRECTIF v2 (ferme P3B6-CREATE-ORDER-GUARD-01, LOW) : une simple
  -- vérification d'EXISTENCE du nom `create_order` (comme la v1 de ce
  -- lot le faisait) ne détecte PAS une dérive de signature ou de
  -- contrat de retour -- seulement son absence totale. Remplacée par
  -- des vérifications pg_catalog EXACTES, jamais un test de forme
  -- source/formatage (mandat v2 section 9 : "prefer pg_catalog-based
  -- checks over brittle source formatting/string matching") :
  --   (a) `to_regprocedure(...)` avec la signature de paramètres EXACTE
  --       attendue (types, dans l'ordre) -- renvoie NULL (jamais une
  --       erreur de résolution) si aucune fonction de ce nom n'a
  --       exactement cette signature, y compris si une AUTRE surcharge
  --       du même nom existe avec des types différents ;
  --   (b) `pg_get_function_result(...)` comparé littéralement au
  --       contrat `RETURNS TABLE` EXACT attendu (noms de colonnes, types,
  --       ORDRE) -- capture un changement de contrat de sortie que (a)
  --       seul ne verrait pas (les types de retour ne participent pas à
  --       la résolution de surcharge Postgres).
  -- Ces deux valeurs ont été vérifiées directement contre la chaîne
  -- réelle (v82+v83+v84+routing+DRAFT-lot-server-delivery-fulfillment-
  -- pricing.sql) avant d'être figées ici -- jamais devinées/recopiées
  -- depuis un commentaire ou une lecture de fichier source.
  if to_regprocedure(
    'public.create_order(text, text, jsonb, integer, jsonb, text, text)'
  ) is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.create_order(text, text, jsonb, integer, jsonb, text, text) introuvable avec cette signature EXACTE -- prérequis ORDERS FOUNDATION manquant ou signature incompatible, migration annulée.';
  end if;

  if pg_get_function_result(
    'public.create_order(text, text, jsonb, integer, jsonb, text, text)'::regprocedure
  ) is distinct from
    'TABLE(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)'
  then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.create_order a un contrat RETURNS TABLE inattendu (colonnes/types/ordre différents de ceux attendus depuis DRAFT-lot-server-delivery-fulfillment-pricing.sql) -- migration annulée pour éviter une régression silencieuse du contrat de sortie.';
  end if;

  -- Prérequis RÉ-AUDITÉ (mandat section 7) : ce lot recopie et étend
  -- la définition ACTUELLE de create_order, laquelle appartient au lot
  -- déjà publié DRAFT-lot-server-delivery-fulfillment-pricing.sql (pas
  -- migration-v82-lot2a-sale-modes.sql) -- vérifie ici que ce lot
  -- sœur est bien appliqué avant de tenter le CREATE OR REPLACE
  -- ci-dessous, pour échouer explicitement plutôt que de régresser
  -- silencieusement son contrat de sortie si jamais l'ordre
  -- d'application réel divergeait de celui supposé. (Marqueurs de
  -- dépendance fulfillment, mandat v2 section 9 : ces 4 colonnes ET la
  -- fonction resolve_delivery_fulfillment ci-dessous forment ensemble
  -- la preuve que ce lot sœur précis, pas seulement UNE forme de
  -- create_order étendue, est bien celle en place.)
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('delivery_fee','fulfillment_rule_id','fulfillment_code','provider_code')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes orders.delivery_fee/fulfillment_rule_id/fulfillment_code/provider_code introuvables -- prérequis DRAFT-lot-server-delivery-fulfillment-pricing.sql manquant ou non appliqué avant ce lot, migration annulée.';
  end if;

  if to_regprocedure(
    'public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric)'
  ) is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric) introuvable avec cette signature EXACTE -- prérequis DRAFT-lot-server-delivery-fulfillment-pricing.sql manquant ou incompatible, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purge_old_customer_data'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.purge_old_customer_data introuvable -- prérequis ORDERS FOUNDATION (GDPR) manquant, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'order_billing_context'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_billing_context existe déjà -- PAYMENT P3-B6 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. order_billing_context — table 1:1 avec orders, NULLABLE-EN-BLOC
-- (n'existe que pour une commande pour laquelle un contexte de
-- facturation a été explicitement assemblé/confirmé -- jamais créée
-- au moment de create_order lui-même). Vocabulaire snake_case
-- générique, jamais les noms de champ Monetico.
-- ------------------------------------------------------------
create table public.order_billing_context (
  order_id           uuid primary key references public.orders(id) on delete cascade,

  -- Origine de la donnée (mandat section 11 : "define how the caller
  -- supplies/confirms whether billing data is derived from existing
  -- order delivery data or supplied separately") -- jamais une
  -- assomption silencieuse côté serveur, toujours un choix explicite
  -- de l'appelant, tracé ici pour audit.
  source             text not null check (source in ('delivery_reuse','manual')),

  -- Champs OBLIGATOIRES côté Monetico (billing.addressLine1/city/
  -- postalCode/country, tous quatre confirmés OBLIGATOIRE, jamais
  -- "si applicable") -- donc NOT NULL ici aussi : une ligne
  -- order_billing_context incomplète n'a pas lieu d'exister.
  address_line_1     text not null check (length(address_line_1) between 1 and 50),
  address_line_2     text check (address_line_2 is null or length(address_line_2) between 1 and 50),
  city               text not null check (length(city) between 1 and 50),
  postal_code        text not null check (length(postal_code) between 1 and 10),
  -- ISO 3166-1 alpha-2, 2 lettres MAJUSCULES -- normalisé en amont par
  -- les deux fonctions ci-dessous (jamais stocké tel que reçu si reçu
  -- en minuscule/casse mixte), jamais une valeur inventée (mandat
  -- section 12 : "Do not silently persist FR").
  country            text not null check (country ~ '^[A-Z]{2}$'),
  -- Conditionnelle côté Monetico ("obligatoire si applicable") --
  -- optionnelle ici, validée uniquement quand fournie.
  state_or_province  text check (state_or_province is null or length(state_or_province) between 1 and 10),

  -- Champs OPTIONNELS côté Monetico (billing.name/email/phone) --
  -- bornes reprises telles que confirmées (name max 45, email max
  -- 100, phone max 18).
  customer_name      text check (customer_name is null or length(customer_name) between 1 and 45),
  customer_email     text check (customer_email is null or length(customer_email) between 1 and 100),
  customer_phone     text check (customer_phone is null or length(customer_phone) between 1 and 18),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.order_billing_context is
  'PAYMENT P3-B6 v1 — contexte de facturation INTERNE, générique, neutre vis-à-vis du prestataire (mandat section 8). 1:1 avec orders, existe UNIQUEMENT pour une commande où un contexte de facturation a été explicitement assemblé (jamais à la création de commande elle-même). Aucune donnée de paiement brute, aucun blob prestataire, aucun contexte_commande/Base64. Le mapping vers le vocabulaire d''un prestataire donné (Monetico ou futur) est une responsabilité EXCLUSIVE de la couche adaptateur applicative, jamais de ce schéma.';

comment on column public.order_billing_context.source is
  'delivery_reuse = les 4 champs d''adresse obligatoires ont été copiés depuis order_delivery_address de CETTE commande par set_order_billing_context (jamais acceptés tels quels depuis l''appelant sous ce mode, pour empêcher une incohérence entre une revendication "reuse" et des valeurs différentes fournies) ; manual = les 4 champs ont été explicitement fournis et validés. `country` est TOUJOURS explicitement fourni par l''appelant dans les deux cas (mandat section 12) -- jamais dérivé de order_delivery_address.country, dont la valeur par défaut ''FR'' ne constitue pas une confirmation client.';

alter table public.order_billing_context enable row level security;

-- Posture la plus stricte déjà établie dans ce dépôt (identique à
-- payment_transactions/payment_provider_events) : aucun accès table
-- direct pour AUCUN rôle, y compris service_role -- exclusivement via
-- les deux fonctions SECURITY DEFINER ci-dessous.
revoke all on table public.order_billing_context from anon, authenticated, service_role, public;

-- ------------------------------------------------------------
-- 3. set_order_billing_context — ÉCRITURE, SECURITY DEFINER,
-- service_role UNIQUEMENT (mandat section 20 : jamais anon/
-- authenticated -- un futur serveur de confiance relaie le couple de
-- possession fourni par le navigateur anonyme). Échec fermé sur toute
-- entrée invalide ou incomplète (mandat section 5 : "Mandatory fields
-- must fail closed if unavailable").
-- ------------------------------------------------------------
create or replace function public.set_order_billing_context(
  p_order_id           uuid,
  p_public_token       uuid,
  p_source             text,
  p_address_line_1     text default null,
  p_address_line_2     text default null,
  p_city               text default null,
  p_postal_code        text default null,
  p_country            text default null,
  p_state_or_province  text default null,
  p_customer_name      text default null,
  p_customer_email     text default null,
  p_customer_phone     text default null
)
returns table (
  order_id    uuid,
  source      text,
  updated_at  timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
-- ^ REQUIS : les colonnes de sortie `order_id`/`source`/`updated_at`
-- (RETURNS TABLE ci-dessus) deviennent des variables PL/pgSQL
-- implicites de même nom, qui entrent en collision avec les colonnes
-- RÉELLES de `order_billing_context` référencées plus bas dans
-- `on conflict (order_id)`/`do update set` -- découvert par test direct
-- (psql a levé `ERROR: column reference "order_id" is ambiguous` sans
-- cette pragma). `use_column` fait préférer explicitement la colonne de
-- table dans TOUTE commande SQL de ce corps en cas d'ambiguïté --
-- pragma documentée standard PL/pgSQL pour ce cas précis, aucun
-- renommage d'interface nécessaire.
declare
  v_order              public.orders%rowtype;
  v_delivery           public.order_delivery_address%rowtype;
  v_source             text;
  v_address_line_1     text;
  v_address_line_2     text;
  v_city               text;
  v_postal_code        text;
  v_country            text;
  v_state_or_province  text;
  v_customer_name      text;
  v_customer_email     text;
  v_customer_phone     text;
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_BILLING_CONTEXT: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  -- Preuve de possession anonyme -- même patron que get_order_payment_
  -- context/get_order_active_payment_attempt (PAYMENT P3-B2/P3-B3) :
  -- id ET public_token doivent correspondre à la MÊME ligne.
  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.public_token = p_public_token;

  if not found then
    raise exception 'SCANYM_BILLING_CONTEXT: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  v_source := btrim(coalesce(p_source, ''));
  if v_source not in ('delivery_reuse', 'manual') then
    raise exception 'SCANYM_BILLING_CONTEXT: p_source doit valoir exactement ''delivery_reuse'' ou ''manual''' using errcode = '22023';
  end if;

  -- `country` est TOUJOURS explicitement fourni par l'appelant, quel
  -- que soit p_source (mandat section 12) -- jamais dérivé de
  -- order_delivery_address.country, dont la valeur par défaut 'FR'
  -- n'est pas une confirmation client. Normalisation : trim + upper,
  -- puis forme ISO 3166-1 alpha-2 stricte (2 lettres) -- échec fermé
  -- sinon (mandat section 23 : "malformed code rejected").
  v_country := upper(btrim(coalesce(p_country, '')));
  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'SCANYM_BILLING_CONTEXT: p_country doit être un code ISO 3166-1 alpha-2 (2 lettres)' using errcode = '22023';
  end if;

  if v_source = 'delivery_reuse' then
    -- Les 4 champs d'adresse obligatoires proviennent EXCLUSIVEMENT de
    -- order_delivery_address de CETTE commande, jamais des arguments
    -- p_address_line_1/p_city/p_postal_code (ignorés sous ce mode) --
    -- empêche une revendication "reuse" accompagnée de valeurs
    -- différentes de celles réellement au dossier (mandat section 11 :
    -- "no heuristic address splitting", et plus largement l'esprit de
    -- l'autorité serveur déjà établie pour amount/tenant ailleurs dans
    -- ce dépôt, généralisée ici à l'intégrité de la donnée d'adresse).
    select * into v_delivery
    from public.order_delivery_address d
    where d.order_id = p_order_id;

    if not found then
      raise exception 'SCANYM_BILLING_CONTEXT: aucune adresse de livraison structurée au dossier pour cette commande -- ''delivery_reuse'' impossible' using errcode = 'P0002';
    end if;

    if v_delivery.street is null or v_delivery.city is null then
      raise exception 'SCANYM_BILLING_CONTEXT: adresse de livraison incomplète (street/city manquant) -- ''delivery_reuse'' impossible' using errcode = 'P0002';
    end if;

    -- CORRECTIF v2 (ferme P3B6-BILLING-TRUNCATION-01) : `left(...)`
    -- MUTAIT silencieusement une adresse de livraison réelle mais trop
    -- longue en une adresse DIFFÉRENTE et plus courte (ex. "12 rue de
    -- la Longue Distance..." tronquée à 50 caractères devient une autre
    -- rue) -- inacceptable pour une donnée de facturation. Ce cas ne
    -- doit plus jamais tronquer : il ÉCHOUE explicitement, et le
    -- message d'erreur oriente vers la voie de correction existante
    -- ('manual', qui permet à l'appelant de fournir/confirmer une
    -- valeur volontairement raccourcie ou différente).
    if length(v_delivery.street) > 50 then
      raise exception 'SCANYM_BILLING_CONTEXT: adresse de livraison (street) dépasse la limite de facturation de 50 caractères -- aucune troncature silencieuse, fournir un contexte de facturation ''manual'' avec une valeur corrigée' using errcode = '22001';
    end if;
    v_address_line_1 := v_delivery.street;
    v_address_line_2 := null;
    if length(v_delivery.city) > 50 then
      raise exception 'SCANYM_BILLING_CONTEXT: ville de livraison dépasse la limite de facturation de 50 caractères -- aucune troncature silencieuse, fournir un contexte de facturation ''manual'' avec une valeur corrigée' using errcode = '22001';
    end if;
    v_city           := v_delivery.city;
    v_postal_code    := v_delivery.postal_code;
    if v_postal_code is null or length(v_postal_code) = 0 then
      raise exception 'SCANYM_BILLING_CONTEXT: code postal de livraison manquant -- ''delivery_reuse'' impossible' using errcode = 'P0002';
    end if;
    -- Défensif : `order_delivery_address.postal_code` porte déjà sa
    -- propre contrainte <=10 (LOT 2A) -- ne peut structurellement
    -- jamais dépasser 10 caractères ici. Vérifié explicitement quand
    -- même (mandat v2 : "critically prove no resulting value is
    -- silently shortened" pour CHAQUE valeur obligatoire), jamais
    -- tronqué par construction (`left()` n'a jamais été utilisé sur ce
    -- champ, avant ou après ce correctif).
    if length(v_postal_code) > 10 then
      raise exception 'SCANYM_BILLING_CONTEXT: code postal de livraison dépasse la limite de facturation de 10 caractères' using errcode = '22001';
    end if;

    -- `state_or_province` (OPTIONNEL, mandat v2 section 4) : POLITIQUE
    -- EXPLICITE, documentée ici et identique dans la branche 'manual'
    -- ci-dessous -- ABSENT/VIDE après trim -> OMIS (NULL), jamais une
    -- erreur (l'absence est un état légitime pour un champ optionnel) ;
    -- FOURNI mais dépassant la borne -> REJETÉ explicitement (fail
    -- closed), JAMAIS tronqué silencieusement. Cette politique
    -- "fourni-mais-invalide-rejette / absent-omet" est appliquée
    -- UNIFORMÉMENT à tous les champs optionnels de cette fonction
    -- (state_or_province, address_line_2, customer_name/email/phone) --
    -- voir la validation Monetico dédiée (format ISO 3166-2/téléphone)
    -- dans billing-mapping.ts, hors périmètre de cette couche SQL
    -- générique et neutre vis-à-vis du prestataire.
    v_state_or_province := nullif(btrim(coalesce(p_state_or_province,'')), '');
    if v_state_or_province is not null and length(v_state_or_province) > 10 then
      raise exception 'SCANYM_BILLING_CONTEXT: p_state_or_province dépasse 10 caractères' using errcode = '22001';
    end if;
  else
    -- 'manual' : chaque champ obligatoire est explicitement fourni et
    -- validé -- échec fermé (raise exception) si absent/vide après
    -- trim, jamais une valeur par défaut silencieuse.
    v_address_line_1 := nullif(btrim(coalesce(p_address_line_1, '')), '');
    v_city           := nullif(btrim(coalesce(p_city, '')), '');
    v_postal_code    := nullif(btrim(coalesce(p_postal_code, '')), '');

    if v_address_line_1 is null then
      raise exception 'SCANYM_BILLING_CONTEXT: p_address_line_1 requis (mode manual)' using errcode = '22004';
    end if;
    if length(v_address_line_1) > 50 then
      raise exception 'SCANYM_BILLING_CONTEXT: p_address_line_1 dépasse 50 caractères' using errcode = '22001';
    end if;
    if v_city is null then
      raise exception 'SCANYM_BILLING_CONTEXT: p_city requis (mode manual)' using errcode = '22004';
    end if;
    if length(v_city) > 50 then
      raise exception 'SCANYM_BILLING_CONTEXT: p_city dépasse 50 caractères' using errcode = '22001';
    end if;
    if v_postal_code is null then
      raise exception 'SCANYM_BILLING_CONTEXT: p_postal_code requis (mode manual)' using errcode = '22004';
    end if;
    if length(v_postal_code) > 10 then
      raise exception 'SCANYM_BILLING_CONTEXT: p_postal_code dépasse 10 caractères' using errcode = '22001';
    end if;

    -- CORRECTIF v2 : `address_line_2` optionnel -- même politique
    -- "absent->omis / fourni-mais-invalide->rejeté" que documentée
    -- ci-dessus pour `state_or_province`, jamais `left()`.
    v_address_line_2 := nullif(btrim(coalesce(p_address_line_2, '')), '');
    if v_address_line_2 is not null and length(v_address_line_2) > 50 then
      raise exception 'SCANYM_BILLING_CONTEXT: p_address_line_2 dépasse 50 caractères' using errcode = '22001';
    end if;

    v_state_or_province := nullif(btrim(coalesce(p_state_or_province,'')), '');
    if v_state_or_province is not null and length(v_state_or_province) > 10 then
      raise exception 'SCANYM_BILLING_CONTEXT: p_state_or_province dépasse 10 caractères' using errcode = '22001';
    end if;
  end if;

  -- CORRECTIF v2 (ferme P3B6-BILLING-TRUNCATION-01) : champs optionnels
  -- name/email/phone -- ABSENT/VIDE après trim -> OMIS (NULL, mandat
  -- section 5 : "omit if empty"), FOURNI mais dépassant la borne
  -- Monetico confirmée -> REJETÉ explicitement, JAMAIS tronqué
  -- silencieusement via `left()` (qui aurait auparavant transformé un
  -- nom/email/téléphone réel en une valeur DIFFÉRENTE et plus courte).
  -- Appliqué quel que soit p_source.
  v_customer_name := nullif(btrim(coalesce(p_customer_name, '')), '');
  if v_customer_name is not null and length(v_customer_name) > 45 then
    raise exception 'SCANYM_BILLING_CONTEXT: p_customer_name dépasse 45 caractères' using errcode = '22001';
  end if;

  v_customer_email := nullif(btrim(coalesce(p_customer_email, '')), '');
  if v_customer_email is not null and length(v_customer_email) > 100 then
    raise exception 'SCANYM_BILLING_CONTEXT: p_customer_email dépasse 100 caractères' using errcode = '22001';
  end if;

  v_customer_phone := nullif(btrim(coalesce(p_customer_phone, '')), '');
  if v_customer_phone is not null and length(v_customer_phone) > 18 then
    raise exception 'SCANYM_BILLING_CONTEXT: p_customer_phone dépasse 18 caractères' using errcode = '22001';
  end if;

  insert into public.order_billing_context (
    order_id, source,
    address_line_1, address_line_2, city, postal_code, country, state_or_province,
    customer_name, customer_email, customer_phone,
    updated_at
  ) values (
    p_order_id, v_source,
    v_address_line_1, v_address_line_2, v_city, v_postal_code, v_country, v_state_or_province,
    v_customer_name, v_customer_email, v_customer_phone,
    now()
  )
  on conflict (order_id) do update set
    source             = excluded.source,
    address_line_1     = excluded.address_line_1,
    address_line_2     = excluded.address_line_2,
    city               = excluded.city,
    postal_code        = excluded.postal_code,
    country            = excluded.country,
    state_or_province  = excluded.state_or_province,
    customer_name      = excluded.customer_name,
    customer_email     = excluded.customer_email,
    customer_phone     = excluded.customer_phone,
    updated_at         = now();

  return query
    select b.order_id, b.source, b.updated_at
    from public.order_billing_context b
    where b.order_id = p_order_id;
end;
$$;

comment on function public.set_order_billing_context(uuid, uuid, text, text, text, text, text, text, text, text, text, text) is
  'PAYMENT P3-B6 v1 — SECURITY DEFINER, service_role UNIQUEMENT. Assemble/confirme le contexte de facturation interne d''une commande (preuve de possession id+public_token requise). p_source=''delivery_reuse'' copie les 4 champs d''adresse obligatoires DEPUIS order_delivery_address de cette même commande (les arguments d''adresse fournis sont ignorés sous ce mode) ; p_source=''manual'' valide les champs explicitement fournis. p_country est TOUJOURS explicitement fourni, jamais dérivé (mandat section 12). Upsert idempotent (on conflict (order_id) do update) -- un contexte peut être reconfirmé/corrigé avant l''envoi effectif du paiement. Échec fermé sur toute donnée obligatoire manquante ou malformée.';

revoke all on function public.set_order_billing_context(uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_order_billing_context(uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 4. get_order_billing_context — LECTURE, SECURITY DEFINER, `stable`,
-- service_role UNIQUEMENT (mandat section 20). Contrat de sortie
-- STRICTEMENT les champs de facturation eux-mêmes -- jamais une ligne
-- `orders` complète, jamais `id` de order_billing_context (il n'y en a
-- pas -- order_id EST la clé), jamais de métadonnée non nécessaire au
-- mapping prestataire.
-- ------------------------------------------------------------
create or replace function public.get_order_billing_context(
  p_order_id      uuid,
  p_public_token  uuid
)
returns table (
  source             text,
  address_line_1     text,
  address_line_2     text,
  city               text,
  postal_code        text,
  country            text,
  state_or_province  text,
  customer_name      text,
  customer_email     text,
  customer_phone     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
-- ^ Défensif, cohérence avec set_order_billing_context ci-dessus --
-- toutes les références sont déjà qualifiées par l'alias `b.` dans ce
-- corps, donc aucune ambiguïté réelle aujourd'hui, mais la même classe
-- de collision (colonnes de sortie nommées comme les colonnes de la
-- table) existe potentiellement si le corps évolue.
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_BILLING_CONTEXT: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.public_token = p_public_token
  ) then
    raise exception 'SCANYM_BILLING_CONTEXT: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  -- Absence de ligne = état légitime ("contexte pas encore assemblé"),
  -- jamais une erreur -- l'appelant (future orchestration de paiement)
  -- doit distinguer "pas encore assemblé" de "commande invalide", ce
  -- que la vérification de possession ci-dessus garantit déjà avant
  -- d'atteindre ce point.
  return query
    select b.source, b.address_line_1, b.address_line_2, b.city, b.postal_code,
           b.country, b.state_or_province, b.customer_name, b.customer_email, b.customer_phone
    from public.order_billing_context b
    where b.order_id = p_order_id;
end;
$$;

comment on function public.get_order_billing_context(uuid, uuid) is
  'PAYMENT P3-B6 v1 — SECURITY DEFINER, `stable`, service_role UNIQUEMENT. Lecture pure du contexte de facturation interne d''une commande (preuve de possession id+public_token requise). Renvoie un ensemble VIDE (jamais une erreur) si aucun contexte n''a encore été assemblé pour cette commande -- état légitime avant tout choix de paiement en ligne. Ne renvoie JAMAIS une ligne orders complète ni aucune métadonnée hors des 10 champs de facturation eux-mêmes.';

revoke all on function public.get_order_billing_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_billing_context(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 5. create_order — RÉ-AUDIT DE BASELINE (mandat section 7) : la
-- copie initialement préparée pour ce lot avait été basée sur la
-- définition PUBLIÉE DANS migration-v82-lot2a-sale-modes.sql. Un
-- second passage de vérification directe sur le dépôt verrouillé
-- (`grep` de TOUTES les définitions `create or replace function
-- public.create_order(` dans supabase/*.sql, puis inspection de
-- l'ordre d'application réel via
-- supabase/tests/server-delivery-fulfillment-pricing-check.sh) a
-- révélé qu'un lot ULTÉRIEUR déjà publié --
-- DRAFT-lot-server-delivery-fulfillment-pricing.sql (appliqué après
-- migration-v82-lot2a-sale-modes.sql, migration-v83-lot2a4-privilege-
-- hardening.sql et migration-v84-lot2b1-delivery-info-rpc.sql dans la
-- chaîne réelle) -- avait DÉJÀ REMPLACÉ create_order avec un contrat
-- de sortie étendu (subtotal/delivery_fee/total explicites) et un
-- moteur de résolution de livraison/tarification serveur-autoritaire
-- (resolve_delivery_fulfillment). La version ci-dessous part donc de
-- CETTE définition réelle et actuelle (copiée verbatim depuis
-- DRAFT-lot-server-delivery-fulfillment-pricing.sql), PAS de la
-- version v82 obsolète -- toute autre approche aurait silencieusement
-- RÉGRESSÉ ce lot sœur déjà publié (perte de delivery_fee, du moteur
-- de résolution, et des trois colonnes d'instantané de fulfillment) à
-- la première application de CE fichier après lui, ce qui aurait
-- constitué une violation directe de la non-régression exigée
-- (mandat section 2/29).
--
-- SEUL AJOUT DE CE LOT : lecture de p_customer->>'street' et
-- p_customer->>'city' (mode delivery uniquement), stockés dans
-- order_delivery_address (colonnes déjà déclarées depuis LOT 2A,
-- jamais alimentées jusqu'ici -- mandat section 13 : "stop discarding
-- genuine structured values"). AUCUNE autre logique de cette fonction
-- n'est modifiée : contrat de sortie inchangé (order_id, order_number,
-- public_token, subtotal, delivery_fee, total), aucune règle de
-- validation de commande changée pour aucun mode, aucun mode ne
-- devient exigeant en adresse s'il ne l'était pas déjà, le moteur de
-- résolution de livraison/tarification (nouveau ou legacy) n'est en
-- rien modifié. `country` n'est PAS lu ici (voir en-tête de fichier)
-- -- order_delivery_address.country conserve sa valeur par défaut
-- 'FR' inchangée, non traitée comme une confirmation. Signature
-- d'entrée et type de retour identiques à la version actuelle -- pas
-- de `drop function` requis (seul un changement de type de retour
-- l'exigerait, ce qui n'est pas le cas ici).
-- ------------------------------------------------------------
create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null
)
returns table (order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant  public.restaurants%rowtype;
  v_config      public.restaurant_configs%rowtype;
  v_order_id    uuid;
  v_token       uuid;
  v_number      bigint;
  v_subtotal    numeric(12,2) := 0;
  v_qty_total   integer := 0;
  v_item        jsonb;
  v_menu_item   public.menu_items%rowtype;
  v_option      public.menu_items%rowtype;
  v_option_id   uuid;
  v_qty         integer;
  v_count       integer;
  v_postal      text;
  v_zone        text;
  v_phone       text;
  v_address     text;
  v_email       text;
  v_name        text;
  v_note        text;
  v_mode_enabled boolean;
  v_req         record;
  v_field_value text;
  v_room_number text;
  -- SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION
  -- (déjà publié -- DRAFT-lot-server-delivery-fulfillment-pricing.sql,
  -- variables reprises verbatim, aucune logique modifiée) :
  v_new_engine         boolean := false;
  v_delivery_fee       numeric(12,2) := 0;
  v_fulfillment_rule_id uuid;
  v_fulfillment_code   text;
  v_provider_code      text;
  v_resolved           record;
  -- AJOUT PAYMENT P3-B6 : structuré, mode delivery uniquement, jamais
  -- dérivé/re-découpé de v_address (mandat section 13 : "Do not parse
  -- a flattened address later to reconstruct structure").
  v_street      text;
  v_city        text;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true and status = 'active';
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  select enabled into v_mode_enabled
  from public.restaurant_sale_modes
  where restaurant_id = v_restaurant.id and mode_code = p_service_mode;

  if v_mode_enabled is null or not v_mode_enabled then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');
  v_room_number := nullif(left(trim(coalesce(p_customer->>'room_number','')), 20), '');
  -- AJOUT PAYMENT P3-B6 : bornes identiques à order_delivery_address.
  -- street/city (200/120 caractères) -- jamais réutilisées pour une
  -- autre commande, jamais recalculées depuis v_address.
  v_street := nullif(left(trim(coalesce(p_customer->>'street','')), 200), '');
  v_city   := nullif(left(trim(coalesce(p_customer->>'city','')), 120), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  create temporary table tmp_field_reqs (
    field text, requirement text, one_of_group text, resolved_value text
  ) on commit drop;

  insert into tmp_field_reqs (field, requirement, one_of_group, resolved_value)
  select x.field, x.requirement, x.one_of_group,
    case x.field
      when 'customer_name' then v_name
      when 'phone' then v_phone
      when 'email' then v_email
      when 'delivery_address' then v_address
      when 'table_number' then p_table_number::text
      when 'room_number' then v_room_number
      else null
    end
  from public.effective_sale_mode_field_requirements(v_restaurant.id, p_service_mode) x;

  for v_req in select field, resolved_value from tmp_field_reqs where requirement = 'required' loop
    if v_req.resolved_value is null then
      raise exception 'Champ requis manquant pour ce mode: %', v_req.field;
    end if;
  end loop;

  for v_req in
    select one_of_group, bool_or(resolved_value is not null) as satisfied
    from tmp_field_reqs
    where requirement = 'one_of' and one_of_group is not null
    group by one_of_group
  loop
    if not v_req.satisfied then
      raise exception 'Au moins un champ du groupe % est requis', v_req.one_of_group;
    end if;
  end loop;

  if p_service_mode = 'delivery' then
    -- PONT DE MIGRATION SERVEUR (déjà publié, INCHANGÉ par ce lot) --
    -- au moins une règle ACTIVE (règle ET mode parent enabled=true)
    -- existe pour ce (restaurant_id, p_service_mode) -> nouveau moteur
    -- exclusif ; sinon -> chemin legacy byte-identique.
    select exists (
      select 1
      from public.restaurant_sale_mode_fulfillments f
      join public.restaurant_sale_modes rsm
        on rsm.restaurant_id = f.restaurant_id and rsm.mode_code = f.mode_code
      where f.restaurant_id = v_restaurant.id
        and f.mode_code = p_service_mode
        and f.enabled = true
        and rsm.enabled = true
    ) into v_new_engine;

    if v_new_engine then
      v_postal := nullif(trim(coalesce(p_customer->>'postalCode', '')), '');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;
    else
      v_postal := substring(v_address from '\m(\d{5})\M');
      if v_postal is null then
        raise exception 'Code postal absent de l''adresse';
      end if;

      select p into v_zone
      from public.restaurant_sale_modes rsm,
           jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb)) as p
      where rsm.restaurant_id = v_restaurant.id and rsm.mode_code = 'delivery'
        and v_postal like p || '%'
      limit 1;

      if v_zone is null then
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number, room_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    case when p_service_mode = 'room_service' then v_room_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  -- AJOUT PAYMENT P3-B6 : street/city désormais transmis quand fournis
  -- (auparavant toujours NULL -- écart confirmé par ré-audit direct du
  -- baseline). formatted_address/postal_code INCHANGÉS (même logique
  -- qu'avant ce lot) -- country conserve son défaut 'FR' de colonne,
  -- non traité comme une confirmation (voir en-tête).
  if p_service_mode = 'delivery' and v_address is not null then
    insert into public.order_delivery_address (order_id, formatted_address, postal_code, street, city)
    values (v_order_id, v_address, v_postal, v_street, v_city);
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::integer, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'Quantité invalide: %', v_qty;
    end if;

    select mi.* into v_menu_item
    from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    where mi.id = (v_item->>'menu_item_id')::uuid
      and mc.restaurant_id = v_restaurant.id
      and mi.is_available = true
      and mc.is_active = true;

    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    v_option_id := nullif(v_item->>'option_item_id','')::uuid;
    v_option := null;

    if v_menu_item.option_source_category_id is not null then
      if v_option_id is null then
        raise exception 'Option obligatoire pour: %', v_menu_item.name;
      end if;
      select mi.* into v_option
      from public.menu_items mi
      where mi.id = v_option_id
        and mi.category_id = v_menu_item.option_source_category_id
        and mi.is_available = true;
      if not found then
        raise exception 'Option invalide pour %', v_menu_item.name;
      end if;
    elsif v_option_id is not null then
      raise exception 'Ce produit n''accepte pas d''option: %', v_menu_item.name;
    end if;

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and not v_new_engine then
    -- LEGACY minimum — INCHANGÉ (déjà publié).
    declare
      v_delivery_min_items integer;
    begin
      select coalesce((config->>'delivery_min_items')::integer, 0) into v_delivery_min_items
      from public.restaurant_sale_modes
      where restaurant_id = v_restaurant.id and mode_code = 'delivery';

      if v_qty_total < coalesce(v_delivery_min_items, 0) then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_delivery_min_items, v_qty_total;
      end if;
    end;
  elsif p_service_mode = 'delivery' and v_new_engine then
    -- INCHANGÉ (déjà publié) : résolution intégrale déléguée au
    -- résolveur partagé, jamais une seconde implémentation.
    select * into v_resolved
    from public.resolve_delivery_fulfillment(v_restaurant.id, p_service_mode, v_postal, v_qty_total, v_subtotal);

    if not v_resolved.eligible then
      if v_resolved.block = 'no-postal' then
        raise exception 'Code postal absent de l''adresse';
      elsif v_resolved.block = 'below-min' then
        raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
          v_resolved.min_items, v_qty_total;
      else
        raise exception 'Zone non desservie: %', v_postal;
      end if;
    end if;

    v_zone := v_resolved.matched_prefix;
    v_delivery_fee := coalesce(v_resolved.delivery_fee, 0);
    v_fulfillment_rule_id := v_resolved.fulfillment_rule_id;
    v_fulfillment_code := v_resolved.fulfillment_code;
    v_provider_code := v_resolved.provider;
  end if;

  update public.orders
  set subtotal = v_subtotal,
      delivery_fee = v_delivery_fee,
      total = v_subtotal + v_delivery_fee,
      fulfillment_rule_id = v_fulfillment_rule_id,
      fulfillment_code = v_fulfillment_code,
      provider_code = v_provider_code
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end $$;

-- Droits préservés par CREATE OR REPLACE FUNCTION à signature identique
-- (déjà publiés par DRAFT-lot-server-delivery-fulfillment-pricing.sql,
-- repris ici sans changement).
revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public, anon;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text) to authenticated, anon;

-- ------------------------------------------------------------
-- 6. purge_old_customer_data — AJOUT ADDITIF : suppression en bloc de
-- la ligne order_billing_context correspondante (données entièrement
-- personnelles). AUCUNE autre logique changée -- la mise à jour
-- orders elle-même reste STRICTEMENT IDENTIQUE à sa définition
-- d'origine (migration-orders.sql).
-- ------------------------------------------------------------
create or replace function public.purge_old_customer_data(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_rows integer;
begin
  -- AJOUT PAYMENT P3-B6 : purge du contexte de facturation AVANT la
  -- purge orders elle-même, sur le même filtre d'ancienneté --
  -- suppression en bloc (jamais un nullage colonne par colonne : cette
  -- table n'a aucune colonne non-personnelle à conserver).
  delete from public.order_billing_context b
  using public.orders o
  where b.order_id = o.id
    and o.created_at < now() - (p_days || ' days')::interval
    and o.personal_data_purged = false;

  update public.orders
  set customer_name = null, customer_phone = null, customer_email = null,
      delivery_address = null, delivery_zone = null, customer_note = null,
      personal_data_purged = true
  where created_at < now() - (p_days || ' days')::interval
    and personal_data_purged = false;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

revoke all on function public.purge_old_customer_data(integer) from public;
revoke all on function public.purge_old_customer_data(integer) from anon, authenticated;

-- ------------------------------------------------------------
-- 7. NON-RÉGRESSION EXPLICITE (mandat sections 2/17) : ce lot ne
-- modifie NI P3-B4 (get_payment_runtime_provider_environment) NI
-- P3-B5 (payment_provider_events et ses 3 RPC de bail/traitement) --
-- aucune référence à ces objets n'apparaît nulle part ci-dessus. Les
-- deux seules fonctions PRÉ-EXISTANTES modifiées par ce lot sont
-- create_order et purge_old_customer_data, toutes deux à signature
-- IDENTIQUE (CREATE OR REPLACE, droits préservés). Aucun nouveau
-- privilège de table n'est accordé à quelque rôle que ce soit --
-- order_billing_context reste sans aucun accès direct, exactement
-- comme payment_transactions/payment_provider_events avant elle.
-- ------------------------------------------------------------

commit;
