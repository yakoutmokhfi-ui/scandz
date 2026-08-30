-- ============================================================
-- Scanym — PAYMENT P3-B5 — DURABLE PROVIDER CALLBACK INBOX — v2
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- MISE À JOUR v2 (correction post Work re-audit de la candidate v1,
-- verdict « FAIL — PAYMENT P3-B5 DURABLE PROVIDER CALLBACK INBOX v1 —
-- NOT READY FOR CIO GO ») : v1 n'a JAMAIS été mergée/déployée -- ce
-- fichier reste le même candidat cumulatif corrigé EN PLACE (mandat
-- PAYMENT P3-B5 v2 section 32, "prefer modifying the existing P3-B5
-- SQL candidate rather than creating a second SQL file"), pas une
-- nouvelle migration. Deux constats release-blocking fermés ici :
--
--   P3B5-RETRY-01 (HIGH) — v1 persistait durablement les évènements
--   mais ne fournissait AUCUN moyen, pour un processus serveur ayant
--   perdu sa mémoire (crash), de retrouver et reprendre un évènement
--   `received`/`failed_retryable` : `service_role` n'avait ni SELECT
--   direct sur la table (posture RPC-only voulue), ni RPC de lecture/
--   revendication. Fermé ci-dessous par `claim_payment_provider_events`
--   (section 3bis) -- primitif de file de travail PostgreSQL sûr sous
--   concurrence (`FOR UPDATE SKIP LOCKED`), à bail temporel
--   (claim_token/claimed_at/claim_expires_at), permettant la reprise
--   après crash SANS orphelinat permanent. Voir CLAIM-LEASE-RECOVERY-
--   REPORT.txt et P3B5-RETRY-01-CLOSURE-REPORT.txt.
--
--   P3B5-FINGERPRINT-01 (MEDIUM) — v1 laissait le fingerprint être
--   calculé par l'appelant à partir de valeurs BRUTES, indépendamment
--   de la normalisation SQL (espaces, `10.0` vs `10.00`, chaîne vide
--   vs NULL), ET acceptait un fingerprint arbitraire fourni par
--   l'appelant sans lien prouvé avec les champs réellement envoyés.
--   Fermé ci-dessous : la RPC continue de valider strictement la FORME
--   du fingerprint reçu (aucune extension pgcrypto nouvelle, toujours
--   hors périmètre -- mandat section 20, accepté explicitement en
--   défense-en-profondeur documentée), MAIS le wrapper TypeScript
--   `recordPaymentProviderEvent` (lib/server/payment-service.ts)
--   n'accepte PLUS de fingerprint fourni par l'appelant : il
--   canonicalise D'ABORD les champs (lib/server/payment-provider-
--   event-fingerprint.ts, `canonicalizePaymentProviderEventFields`),
--   calcule le fingerprint EXCLUSIVEMENT à partir de ces valeurs
--   canoniques, PUIS envoie ces MÊMES valeurs canoniques à la RPC --
--   plus aucun écart possible entre ce qui est haché et ce qui est
--   stocké. La table de correspondance complète (champ / règle
--   d'entrée / valeur canonique / valeur stockée / valeur de
--   fingerprint) est documentée dans FINGERPRINT-CANONICALIZATION-
--   MATRIX.txt et P3B5-FINGERPRINT-01-CLOSURE-REPORT.txt.
--
-- L'architecture centrale acceptée par le premier audit reste
-- PRÉSERVÉE À L'IDENTIQUE : modèle générique payment_provider_events,
-- réception durable AVANT tout ACK, plusieurs évènements pour un même
-- provider_reference, aucune mutation automatique de paiement,
-- séparation processing-status, corrélation tenant, posture RPC-only,
-- aucune logique spécifique Monetico. Rien de tout cela n'est
-- redesigné par ce correctif.
--
-- ------------------------------------------------------------------
-- CONTEXTE v1 (préservé pour traçabilité -- toujours exact) :
-- ------------------------------------------------------------------
-- OBJET : ce lot existe parce que l'audit indépendant Work de PAYMENT
-- P3-B MONETICO CHECKOUT RUNTIME v2 a rendu le verdict « FAIL —
-- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v2 — NOT READY FOR CIO GO »,
-- avec deux constats HIGH pertinents ici :
--
--   PAY-P3B-V2-03 (HIGH) — un callback prestataire authentifié (MAC
--   valide) DOIT être acquitté selon le protocole du prestataire même
--   si le traitement métier Scanym échoue ensuite. Le runtime rejeté
--   pouvait donc : authentifier le callback -> échouer à confirmer ->
--   acquitter quand même -> ne laisser AUCUNE preuve durable locale ->
--   aucune surface de reprise/réconciliation -- un paiement accepté
--   par le prestataire pourrait n'être JAMAIS reflété localement.
--
--   PAY-P3B-V2-02 (HIGH) — un évènement de type refus peut devoir être
--   enregistré SANS forcer immédiatement la machine à états générique
--   de PAYMENT P1 vers un état terminal `failed`. Ce lot fournit donc
--   une surface d'évènement/inbox GÉNÉRIQUE, capable d'enregistrer des
--   évènements prestataire authentifiés indépendamment du fait qu'ils
--   provoquent ou non une mutation d'état de paiement.
--
-- INVARIANT ARCHITECTURAL VISÉ (mandat section 2) : callback
-- prestataire authentifié -> enregistrement local durable COMMIS ->
-- l'acquittement (ACK) peut être renvoyé en toute sécurité -> le
-- traitement métier peut réussir immédiatement OU être repris plus
-- tard. L'enregistrement durable NE DÉPEND JAMAIS du succès immédiat
-- de `confirm_payment_attempt` (PAYMENT P1, INCHANGÉ par ce lot).
--
-- PÉRIMÈTRE STRICT (mandat section 3) : ce lot ne contient QUE la
-- capacité DB/serveur générique nécessaire pour persister un évènement
-- prestataire authentifié, identifier une correspondance/rejeu, éviter
-- une double application métier, et permettre un traitement/une
-- reprise serveur de confiance. AUCUNE route de callback prestataire,
-- AUCUN code Monetico, AUCUNE vérification de MAC, AUCUNE UI de
-- checkout, AUCUNE activation de paiement -- tout cela reste réservé à
-- une future orchestration PAYMENT P3-B v3.
--
-- RECONNAISSANCE PRÉALABLE (mandat section 4, faits vérifiés depuis le
-- SOURCE RÉEL de ce baseline, jamais supposés) :
--   - `public.payment_transactions` (PAYMENT P1, INCHANGÉ) porte déjà
--     une contrainte UNIQUE sur (provider_code, provider_reference) --
--     c'est la clé de corrélation déjà établie et éprouvée par
--     `get_payment_transaction_correlation` (PAYMENT P3-B0 v2) et par
--     `confirm_payment_attempt` (P1) lui-même. Ce lot RÉUTILISE cette
--     même clé de corrélation, il n'en invente pas une nouvelle.
--   - `public.payment_transactions` porte aussi une contrainte UNIQUE
--     sur (id, order_id) -- `payment_transactions_id_order_id_unique`
--     (posée par PAY-P1-V2-01 pour la FK composite de
--     `orders.current_payment_transaction_id`). Ce lot RÉUTILISE cette
--     MÊME contrainte pour sa propre FK composite structurelle
--     (section 3 ci-dessous) -- exactement le même patron déjà validé
--     par PAYMENT P1, jamais une invention nouvelle.
--   - `public.orders` porte une contrainte UNIQUE sur (id,
--     restaurant_id) -- `orders_id_restaurant_id_unique` (P1) --
--     réutilisée ici pour une FK composite équivalente, garantissant
--     l'isolation tenant au niveau BASE (pas seulement applicatif).
--   - AUCUNE table d'évènement/audit/inbox générique n'existe nulle
--     part dans ce baseline (recherche exhaustive dans supabase/*.sql
--     pour `event`/`inbox`/`audit_log`/`webhook` -- zéro résultat en
--     dehors des lots P3-B eux-mêmes). Ce lot n'en remplace ni n'en
--     étend aucune -- il en crée la première.
--   - AUCUNE des RPC service_role existantes (P3-A0, P3-B0 v2, P3-B1,
--     P3-B2, P3-B3, P3-B4) n'écrit quoi que ce soit -- toutes sont des
--     lectures pures `stable`. Seules `initiate_payment_attempt` et
--     `confirm_payment_attempt` (P1) écrivent, et restent la SEULE
--     autorité de mutation de `payment_transactions`/`orders.payment_
--     status` -- ce lot ne les appelle jamais et ne duplique jamais
--     leur rôle.
--   - Le modèle de sécurité `service_role` déjà établi par P1
--     (`payment_transactions` : `revoke all ... from anon,
--     authenticated, service_role, public` -- AUCUN grant direct MÊME
--     À service_role, autorité RPC-only stricte, PAY-P1-03) est le
--     posture PRÉFÉRÉE de ce lot pour sa propre table (mandat section
--     22, "if service_role direct table access is not needed, do not
--     grant it").
--   - AUCUNE extension pgcrypto n'est prouvée active sur le projet
--     Supabase réel (supabase/schema.sql commente EXPLICITEMENT sa
--     création -- « create extension if not exists pgcrypto; » --
--     avec la note « déjà active sur Supabase », une hypothèse non
--     vérifiable depuis ce lot sans contact Production, interdit par
--     le mandat). Voir EVENT-FINGERPRINT-IDEMPOTENCY-REPORT.txt pour
--     la décision consécutive : ce lot n'introduit AUCUNE dépendance
--     de hachage cryptographique côté SQL -- le calcul du hachage
--     (SHA-256, via Node `crypto`, DÉJÀ utilisé par ce projet dans
--     lib/server/payment-providers/monetico/{reference,mac}.ts) reste
--     entièrement à la charge du code serveur de confiance appelant,
--     AVANT l'appel RPC. Ce lot valide uniquement la FORME du
--     hachage reçu (exactement 64 caractères hexadécimaux minuscules =
--     SHA-256 non tronqué), jamais son calcul.
--
-- GÉNÉRICITÉ (mandat section 5/26) : nom de table choisi --
-- `payment_provider_events` -- et AUCUN nom de colonne/valeur/
-- identifiant spécifique à un prestataire nommé nulle part dans ce
-- fichier. `provider_event_type` est un texte normalisé (même
-- convention que `provider_code`), jamais une énumération fermée
-- Monetico (`Annulation`/`paiement`/`cdr`/etc.) -- voir DATA-MODEL-
-- REPORT.txt pour la justification complète de ce choix.
--
-- FRONTIÈRE DE CONFIANCE (mandat section 6) : ce lot NE VÉRIFIE AUCUN
-- MAC/signature prestataire -- il fait confiance à l'appelant
-- (adaptateur/orchestrateur serveur, hors périmètre de ce lot) pour
-- avoir DÉJÀ authentifié l'évènement avant d'appeler
-- `record_payment_provider_event`. En conséquence : AUCUN grant
-- EXECUTE à anon/authenticated/PUBLIC sur les deux fonctions ci-dessous
-- -- service_role SEUL, exactement le même posture que TOUTES les
-- autres capacités serveur de confiance déjà publiées par ce projet.
--
-- NON-RÉGRESSION (mandat sections 27/28) : AUCUNE modification de
-- `confirm_payment_attempt`, AUCUNE nouvelle valeur ajoutée à
-- `payment_transactions.status`/`orders.payment_status`, AUCUNE
-- modification de `get_payment_runtime_provider_environment` (PAYMENT
-- P3-B4). Ce lot ajoute une table et deux fonctions STRICTEMENT
-- NOUVELLES, disjointes de tout contrat existant.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- Vérifie STRUCTURELLEMENT (jamais par un simple nom de fonction/
-- correspondance de texte fragile, mandat section 37) les prérequis
-- réels de ce lot : PAYMENT P1 uniquement (payment_transactions +
-- orders + leurs contraintes uniques déjà posées). Ce lot NE dépend
-- structurellement d'AUCUN autre lot P3-B (P2A/P2B-A/P3-A0/P3-B0/
-- P3-B1/P3-B2/P3-B3/P3-B4) -- vérifié par relecture directe de leur
-- source (aucun n'ajoute de colonne/contrainte utilisée ici).
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_transactions'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_transactions introuvable -- prérequis PAYMENT P1 FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_transactions'
      and column_name in ('id','restaurant_id','order_id','provider_code','provider_reference','status')
    having count(*) = 6
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.payment_transactions -- prérequis PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_transactions'::regclass
      and contype = 'u'
      and conname = 'payment_transactions_id_order_id_unique'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte unique payment_transactions_id_order_id_unique introuvable -- prérequis PAYMENT P1 (correction PAY-P1-V2-01) manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'payment_transactions'
      and indexdef ilike '%unique%' and indexdef ilike '%provider_code%' and indexdef ilike '%provider_reference%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte unique (provider_code, provider_reference) introuvable sur public.payment_transactions -- invariant requis par la corrélation callback absent, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','restaurant_id')
    having count(*) = 2
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- prérequis migration-orders.sql manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'u'
      and conname = 'orders_id_restaurant_id_unique'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte unique orders_id_restaurant_id_unique introuvable -- prérequis PAYMENT P1 (correction PAY-P1-11) manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'scanym_numeric_is_non_finite'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.scanym_numeric_is_non_finite introuvable -- prérequis PAYMENT P1 FOUNDATION manquant, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_provider_events'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_events existe déjà -- PAYMENT P3-B5 déjà appliqué, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment_provider_event'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.record_payment_provider_event existe déjà -- PAYMENT P3-B5 déjà appliqué, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_payment_provider_event_processing_status'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.update_payment_provider_event_processing_status existe déjà -- PAYMENT P3-B5 déjà appliqué, migration annulée (double application refusée).';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_payment_provider_events'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.claim_payment_provider_events existe déjà -- PAYMENT P3-B5 v2 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. payment_provider_events — table GÉNÉRIQUE, RPC-only authority
-- (mandat section 22, même posture que payment_transactions PAY-P1-03).
--
-- CHAQUE COLONNE JUSTIFIÉE (mandat section 7) :
--   id                      identité durable de CET évènement logique
--                           (convention gen_random_uuid() déjà partout
--                           dans ce projet).
--   restaurant_id           isolation tenant structurelle (FK composite
--                           ci-dessous) -- DÉRIVÉ par corrélation,
--                           jamais fourni en entrée par l'appelant
--                           (mandat section 14/15).
--   order_id                lien vers la commande concernée, DÉRIVÉ,
--                           nécessaire pour la FK composite tenant.
--   payment_transaction_id  ancre de corrélation la PLUS précise (la
--                           tentative EXACTE concernée, pas seulement
--                           la commande) -- permet à un futur
--                           traitement d'agir sur LA tentative visée
--                           sans ambiguïté, y compris si une commande a
--                           eu plusieurs tentatives dans le temps.
--                           DÉRIVÉ, jamais fourni en entrée.
--   provider_code           corrélation + généricité multi-prestataire,
--                           même convention de normalisation que
--                           payment_transactions.provider_code.
--   provider_reference      référence prestataire de la tentative
--                           concernée -- fait partie de la clé
--                           d'idempotence (section 11).
--   event_fingerprint       hachage déterministe (calculé par
--                           l'appelant de confiance, JAMAIS par cette
--                           table/fonction) des champs stables/
--                           authentifiés/assainis -- clé de détection
--                           de rejeu (section 10/11).
--   provider_event_type     classification normalisée générique de
--                           l'évènement (ex. « authorized »,
--                           « refused », futur vocabulaire adaptateur)
--                           -- JAMAIS une valeur Monetico codée en dur,
--                           JAMAIS une énumération fermée (un futur
--                           prestataire aurait un vocabulaire
--                           différent).
--   provider_event_code     code technique court optionnel échoué par
--                           le prestataire (même précédent que
--                           payment_transactions.authorization_reference
--                           -- « champ non sensible, technique »).
--   amount / currency       valeur ASSERTÉE PAR LE PRESTATAIRE pour CET
--                           évènement (PAS la valeur autoritative
--                           Scanym, celle-ci reste exclusivement dans
--                           payment_transactions.amount/.currency,
--                           P1, inchangée) -- nécessaire pour qu'une
--                           future orchestration compare les deux
--                           (même rationale que PAY-P3-B0-01/P3-B0 v2
--                           pour amount/currency autoritatifs).
--   authorization_reference référence d'autorisation bancaire si
--                           fournie par CET évènement (même précédent
--                           que payment_transactions).
--   processing_status       machine à états de L'INBOX (section 12/13)
--                           -- SÉPARÉE de payment_transactions.status
--                           ET de la sémantique métier de l'évènement
--                           lui-même (provider_event_type).
--   retry_count             métadonnée de reprise minimale (section
--                           18).
--   last_error_class        classification COURTE et assainie d'un
--                           échec de traitement -- JAMAIS une pile
--                           d'appel brute (section 18, explicite).
--   created_at              horodatage de RÉCEPTION DURABLE -- l'ancre
--                           de l'invariant d'ordonnancement ACK
--                           (section 16) : ce timestamp existe AVANT
--                           qu'un ACK ne puisse légitimement être
--                           renvoyé.
--   last_attempt_at         métadonnée de reprise, compagnon de
--                           retry_count.
--   processed_at            horodatage du DERNIER changement de
--                           processing_status -- NULL tant que
--                           processing_status = 'received' (contrainte
--                           de cohérence ci-dessous, même patron que
--                           P1 paid_at/failed_at/cancelled_at).
--
-- AUCUNE colonne de charge utile brute prestataire (section 8 --
-- décision explicite : NE STOCKE PAS le corps complet du callback,
-- voir PRIVACY-DATA-CLASSIFICATION-REPORT.txt), AUCUNE colonne
-- credential/MAC/clé/Vault/CVV/PAN/cookie/session/public_token
-- (section 9 -- aucun besoin strict prouvé ici, la corrélation passe
-- exclusivement par provider_code/provider_reference déjà établi par
-- P1/P3-B0).
-- ------------------------------------------------------------
create table public.payment_provider_events (
  id                      uuid primary key default gen_random_uuid(),

  restaurant_id           uuid not null references public.restaurants(id) on delete restrict,
  order_id                uuid not null,
  payment_transaction_id  uuid not null,

  provider_code           text not null
                          check (length(provider_code) between 1 and 40)
                          check (provider_code = btrim(provider_code))
                          check (provider_code ~ '^[a-zA-Z0-9_-]+$'),

  provider_reference      text not null
                          check (length(provider_reference) between 1 and 100)
                          check (provider_reference = btrim(provider_reference)),

  -- SHA-256 complet (64 caractères hex minuscules), NON tronqué --
  -- collision-résistant, calculé côté serveur de confiance appelant
  -- (jamais dans cette table/fonction). Voir EVENT-FINGERPRINT-
  -- IDEMPOTENCY-REPORT.txt.
  event_fingerprint       text not null
                          check (event_fingerprint ~ '^[0-9a-f]{64}$'),

  provider_event_type     text not null
                          check (length(provider_event_type) between 1 and 40)
                          check (provider_event_type = btrim(provider_event_type))
                          check (provider_event_type ~ '^[a-zA-Z0-9_-]+$'),

  provider_event_code     text
                          check (provider_event_code is null or length(provider_event_code) <= 100),

  amount                  numeric(12,2)
                          check (amount is null or not public.scanym_numeric_is_non_finite(amount)),
  currency                varchar(10),

  authorization_reference text
                          check (authorization_reference is null or length(authorization_reference) <= 100),

  processing_status       text not null default 'received'
                          check (processing_status in ('received','applied','ignored','failed_retryable','failed_terminal')),
  retry_count             integer not null default 0
                          check (retry_count >= 0),
  last_error_class        text
                          check (last_error_class is null or length(last_error_class) <= 200),

  created_at              timestamptz not null default now(),
  last_attempt_at         timestamptz,
  processed_at            timestamptz,

  -- AJOUT v2 (ferme P3B5-RETRY-01) : bail (lease) de revendication de
  -- traitement. `claim_token` identifie le détenteur ACTUEL du droit
  -- exclusif de finaliser cet évènement (SEUL
  -- `claim_payment_provider_events` peut le poser, SEUL
  -- `update_payment_provider_event_processing_status` peut le vérifier
  -- puis le libérer) -- jamais un identifiant de session/processus
  -- serveur (aucune fuite d'infrastructure), un simple jeton opaque
  -- gen_random_uuid(). `claimed_at` horodate la revendication.
  -- `claim_expires_at` borne dans le temps l'exclusivité : après cette
  -- date, l'évènement redevient éligible à une NOUVELLE revendication
  -- même si `claim_token` n'a pas été explicitement libéré -- c'est ce
  -- qui permet la reprise après crash SANS orphelinat permanent
  -- (mandat section 5, "a worker that claims and crashes must not
  -- permanently orphan the event"). Un évènement jamais revendiqué a
  -- les trois colonnes NULL.
  claim_token             uuid,
  claimed_at              timestamptz,
  claim_expires_at        timestamptz,

  -- Paire amount/currency toujours ensemble présente ou ensemble
  -- absente -- jamais un état à moitié renseigné (même patron que
  -- P1 paid_at/failed_at/cancelled_at).
  constraint payment_provider_events_amount_currency_pair
    check ((amount is null) = (currency is null)),

  -- processed_at reflète fidèlement si un traitement a déjà eu lieu :
  -- NULL ssi processing_status = 'received' (jamais traité).
  constraint payment_provider_events_processed_at_consistency
    check ((processing_status = 'received') = (processed_at is null)),

  -- AJOUT v2 : les trois colonnes de bail sont ensemble NULL ou
  -- ensemble renseignées -- jamais un état à moitié revendiqué.
  constraint payment_provider_events_claim_consistency
    check ((claim_token is null) = (claimed_at is null)
       and (claim_token is null) = (claim_expires_at is null)),

  -- CORRECTION structurelle directe du mandat section 11/20 : jamais
  -- unique sur provider_reference seul (un même provider_reference
  -- peut légitimement porter PLUSIEURS évènements différents dans le
  -- temps -- ex. refus PUIS accepté, PAY-P3B-V2-02). L'idempotence de
  -- rejeu porte sur le TRIPLET complet.
  unique (provider_code, provider_reference, event_fingerprint),

  -- Isolation tenant STRUCTURELLE (mandat section 21) : réutilise la
  -- contrainte unique(id, restaurant_id) déjà posée par PAYMENT P1 sur
  -- orders -- un couple (order_id, restaurant_id) incohérent est
  -- REJETÉ AU NIVEAU BASE, y compris en accès superutilisateur direct,
  -- exactement le même patron que payment_transactions_order_
  -- restaurant_fk (P1).
  constraint payment_provider_events_order_restaurant_fk
    foreign key (order_id, restaurant_id) references public.orders(id, restaurant_id) on delete restrict,

  -- Corrélation STRUCTURELLE tentative<->commande (mandat section 15,
  -- "if a transaction cannot be uniquely derived, fail closed") :
  -- réutilise la contrainte unique(id, order_id) déjà posée par
  -- PAYMENT P1 (PAY-P1-V2-01) sur payment_transactions -- un
  -- (payment_transaction_id, order_id) incohérent est REJETÉ AU NIVEAU
  -- BASE, même patron exact que orders_current_payment_transaction_fk.
  constraint payment_provider_events_transaction_order_fk
    foreign key (payment_transaction_id, order_id) references public.payment_transactions(id, order_id) on delete restrict
);

create index idx_payment_provider_events_transaction
  on public.payment_provider_events(payment_transaction_id);
create index idx_payment_provider_events_restaurant_status
  on public.payment_provider_events(restaurant_id, processing_status);
create index idx_payment_provider_events_retryable
  on public.payment_provider_events(processing_status)
  where processing_status = 'failed_retryable';

-- AJOUT v2 (ferme P3B5-RETRY-01) : index partiel supportant directement
-- le balayage d'éligibilité de `claim_payment_provider_events`
-- (processing_status in ('received','failed_retryable'), ordonné par
-- created_at) -- évite un scan complet de table à chaque appel de
-- revendication.
create index idx_payment_provider_events_claimable
  on public.payment_provider_events(created_at)
  where processing_status in ('received', 'failed_retryable');

comment on table public.payment_provider_events is
  'PAYMENT P3-B5 v2 -- inbox durable, GÉNÉRIQUE (aucun prestataire nommé), d''évènements prestataire déjà AUTHENTIFIÉS par l''appelant (aucune vérification MAC/signature ici). Ferme PAY-P3B-V2-03 (preuve durable AVANT tout ACK) et PAY-P3B-V2-02 (évènement enregistrable indépendamment d''une mutation de payment_transactions/orders). Ferme P3B5-RETRY-01 (reprise après crash via bail claim_token/claimed_at/claim_expires_at, voir claim_payment_provider_events). AUCUNE charge utile brute prestataire stockée -- champs structurés assainis + event_fingerprint (SHA-256 complet, calculé par le wrapper serveur de confiance à partir des MÊMES valeurs canoniques que celles stockées, jamais fourni arbitrairement par un appelant -- ferme P3B5-FINGERPRINT-01) uniquement. Écriture réservée aux fonctions SECURITY DEFINER ci-dessous -- AUCUN GRANT direct (INSERT/UPDATE/DELETE/SELECT) à quelque rôle applicatif que ce soit, y compris service_role (même posture RPC-only que payment_transactions, PAY-P1-03).';

alter table public.payment_provider_events enable row level security;
-- Aucune policy RLS, aucun grant de table à anon/authenticated/
-- service_role/public dans ce lot -- AUCUN accès direct de quelque
-- nature que ce soit (mandat section 22, "prefer RPC-only over direct
-- table access" -- posture la plus stricte, alignée sur
-- payment_transactions elle-même, pas seulement sur payment_provider_
-- configs qui elle n'a "que" aucune policy).
revoke all on table public.payment_provider_events from anon, authenticated, service_role, public;

-- ------------------------------------------------------------
-- 3. record_payment_provider_event — SEULE autorité d'ÉCRITURE,
-- SECURITY DEFINER, service_role UNIQUEMENT (mandat section 6/14/23).
--
-- CORRÉLATION (mandat section 15) : restaurant_id/order_id/
-- payment_transaction_id sont TOUJOURS dérivés depuis
-- payment_transactions via (provider_code, provider_reference) --
-- EXACTEMENT la même clé et le même échec fermé que
-- get_payment_transaction_correlation (PAYMENT P3-B0 v2). JAMAIS
-- acceptés comme paramètre d'entrée -- structurellement impossible
-- pour un appelant de forcer une corrélation incohérente.
--
-- IDEMPOTENCE/CONCURRENCE (mandat section 10/11/19) : `insert ... on
-- conflict (provider_code, provider_reference, event_fingerprint) do
-- nothing`, PUIS relecture de la ligne (nouvelle OU préexistante) --
-- patron standard PostgreSQL sûr sous concurrence réelle (une seconde
-- session bloque sur l'insertion de l'index unique jusqu'à ce que la
-- première commite, puis résout pacifiquement vers "do nothing" si la
-- ligne existe désormais) -- AUCUN verrou explicite nécessaire,
-- AUCUNE dépendance à une vérification applicative seule.
-- ------------------------------------------------------------
create or replace function public.record_payment_provider_event(
  p_provider_code text,
  p_provider_reference text,
  p_event_fingerprint text,
  p_provider_event_type text,
  p_provider_event_code text default null,
  p_amount numeric default null,
  p_currency text default null,
  p_authorization_reference text default null
)
returns table (
  id uuid,
  restaurant_id uuid,
  order_id uuid,
  payment_transaction_id uuid,
  provider_event_type text,
  processing_status text,
  created_at timestamptz,
  is_new_event boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_provider_reference text;
  v_event_fingerprint text;
  v_provider_event_type text;
  v_provider_event_code text;
  v_currency text;
  v_match_count integer;
  v_restaurant_id uuid;
  v_order_id uuid;
  v_transaction_id uuid;
  v_inserted_id uuid;
  v_row record;
  v_is_new boolean;
begin
  v_provider_code := btrim(coalesce(p_provider_code, ''));
  v_provider_reference := btrim(coalesce(p_provider_reference, ''));
  v_event_fingerprint := lower(btrim(coalesce(p_event_fingerprint, '')));
  v_provider_event_type := btrim(coalesce(p_provider_event_type, ''));
  v_provider_event_code := nullif(btrim(coalesce(p_provider_event_code, '')), '');
  -- AJOUT v2 (P3B5-FINGERPRINT-01) : upper() en plus de btrim() -- les
  -- codes devise ISO 4217 sont canoniquement majuscules et la casse n'y
  -- porte aucune distinction sémantique ; normaliser ici élimine une
  -- source de désalignement entre la valeur stockée et le fingerprint
  -- si un appelant fournissait autrefois une casse différente (le
  -- wrapper serveur de confiance applique désormais la MÊME règle AVANT
  -- de calculer le fingerprint -- voir FINGERPRINT-CANONICALIZATION-
  -- MATRIX.txt).
  v_currency := upper(nullif(btrim(coalesce(p_currency, '')), ''));

  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;
  if length(v_provider_reference) = 0 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_provider_reference requis (vide après normalisation)' using errcode = '22004';
  end if;
  if v_event_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'SCANYM_PAYMENT_EVENT: p_event_fingerprint invalide (attendu exactement 64 caractères hexadécimaux minuscules -- SHA-256 non tronqué)' using errcode = '22023';
  end if;
  if length(v_provider_event_type) = 0 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_provider_event_type requis (vide après normalisation)' using errcode = '22004';
  end if;
  if v_provider_event_type !~ '^[a-zA-Z0-9_-]+$' then
    raise exception 'SCANYM_PAYMENT_EVENT: p_provider_event_type invalide (jeu de caractères non sûr)' using errcode = '22023';
  end if;
  if (p_amount is null) <> (v_currency is null) then
    raise exception 'SCANYM_PAYMENT_EVENT: p_amount et p_currency doivent être fournis ensemble ou absents ensemble' using errcode = '22023';
  end if;
  if p_amount is not null and public.scanym_numeric_is_non_finite(p_amount) then
    raise exception 'SCANYM_PAYMENT_EVENT: p_amount non fini (NaN/Infinity)' using errcode = '22023';
  end if;

  -- CORRÉLATION -- même clé et même posture d'échec fermé que
  -- get_payment_transaction_correlation (PAYMENT P3-B0 v2). Jamais un
  -- raccourci autour d'elle : ce lot ne l'appelle pas (elle renvoie un
  -- contrat plus large que nécessaire ici et lèverait une exception
  -- avec un message distinct) -- il applique directement la MÊME
  -- requête et la MÊME logique de garde, pour un contrôle total sur le
  -- message d'erreur et sans dépendance fonctionnelle croisée entre
  -- deux lots indépendants.
  select count(*) into v_match_count
    from public.payment_transactions t
    where t.provider_code = v_provider_code
      and t.provider_reference = v_provider_reference;

  if v_match_count = 0 then
    raise exception 'SCANYM_PAYMENT_EVENT: aucune tentative de paiement ne correspond à ce provider_code/provider_reference -- corrélation impossible, échec fermé' using errcode = 'P0002';
  end if;
  if v_match_count > 1 then
    raise exception 'SCANYM_PAYMENT_EVENT: correspondance ambiguë (plusieurs tentatives) pour ce provider_code/provider_reference -- échec fermé, incohérence d''intégrité' using errcode = 'P0003';
  end if;

  select t.restaurant_id, t.order_id, t.id
    into v_restaurant_id, v_order_id, v_transaction_id
    from public.payment_transactions t
    where t.provider_code = v_provider_code
      and t.provider_reference = v_provider_reference;

  -- IDEMPOTENCE SOUS CONCURRENCE RÉELLE (mandat section 19) : insertion
  -- avec résolution de conflit atomique -- jamais une vérification
  -- "SELECT puis INSERT" séparée qui laisserait une fenêtre de course.
  insert into public.payment_provider_events (
    restaurant_id, order_id, payment_transaction_id,
    provider_code, provider_reference, event_fingerprint,
    provider_event_type, provider_event_code,
    amount, currency, authorization_reference
  ) values (
    v_restaurant_id, v_order_id, v_transaction_id,
    v_provider_code, v_provider_reference, v_event_fingerprint,
    v_provider_event_type, v_provider_event_code,
    p_amount, v_currency, nullif(btrim(coalesce(p_authorization_reference, '')), '')
  )
  on conflict (provider_code, provider_reference, event_fingerprint) do nothing
  returning payment_provider_events.id into v_inserted_id;

  v_is_new := (v_inserted_id is not null);

  select * into v_row
    from public.payment_provider_events e
    where e.provider_code = v_provider_code
      and e.provider_reference = v_provider_reference
      and e.event_fingerprint = v_event_fingerprint;

  return query select
    v_row.id, v_row.restaurant_id, v_row.order_id, v_row.payment_transaction_id,
    v_row.provider_event_type, v_row.processing_status, v_row.created_at, v_is_new;
end;
$$;

comment on function public.record_payment_provider_event(text, text, text, text, text, numeric, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B5. Seule autorité d''ÉCRITURE de public.payment_provider_events. Ferme PAY-P3B-V2-03 (preuve durable AVANT tout ACK) et PAY-P3B-V2-02 (évènement enregistrable sans mutation de payment_transactions/orders). NE VÉRIFIE AUCUN MAC/signature -- fait confiance à l''appelant serveur pour avoir déjà authentifié l''évènement. restaurant_id/order_id/payment_transaction_id sont TOUJOURS dérivés depuis payment_transactions via (provider_code, provider_reference) -- jamais acceptés en entrée, échec fermé si la corrélation est absente ou ambiguë. Idempotent sous concurrence réelle via INSERT...ON CONFLICT sur (provider_code, provider_reference, event_fingerprint) -- un rejeu exact renvoie la MÊME ligne logique (is_new_event=false) sans jamais créer de doublon ; un provider_reference identique avec un event_fingerprint DIFFÉRENT crée un NOUVEL évènement distinct (jamais une contrainte one-event-per-reference). N''appelle et ne modifie JAMAIS confirm_payment_attempt/initiate_payment_attempt/payment_transactions.status/orders.payment_status.';

revoke all on function public.record_payment_provider_event(text, text, text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.record_payment_provider_event(text, text, text, text, text, numeric, text, text) to service_role;

-- ------------------------------------------------------------
-- 3bis. claim_payment_provider_events — AJOUT v2, ferme P3B5-RETRY-01.
-- SEULE autorité de REVENDICATION (claim) d'un lot borné d'évènements
-- ÉLIGIBLES, SECURITY DEFINER, service_role UNIQUEMENT.
--
-- POURQUOI CE LOT EST NÉCESSAIRE (P3B5-RETRY-01) : v1 enregistrait
-- durablement un évènement mais ne fournissait AUCUN moyen supporté,
-- pour un processus serveur ayant perdu sa mémoire (crash après ACK,
-- redémarrage, nouveau worker), de retrouver et reprendre un évènement
-- `received`/`failed_retryable` -- `service_role` n'a ni SELECT direct
-- sur la table (posture RPC-only voulue, section 2 ci-dessus), ni RPC
-- de lecture. Cette fonction ferme cet écart SANS jamais accorder de
-- SELECT direct sur la table : c'est une primitive de file de travail,
-- pas une fuite de lecture.
--
-- PATRON POSTGRESQL : `FOR UPDATE SKIP LOCKED` à l'intérieur d'un CTE
-- de sélection, suivi d'un UPDATE...FROM sur ce même ensemble -- jamais
-- un SELECT puis un UPDATE séparés (fenêtre de course), jamais un
-- verrou explicite au niveau table (aucun verrou global restaurant,
-- mandat section 7). Deux workers concurrents exécutant cette fonction
-- au même instant ne peuvent JAMAIS revendiquer la même ligne : le
-- second worker "saute" (SKIP LOCKED) toute ligne déjà verrouillée par
-- le premier et ne revendique que les lignes réellement disponibles --
-- prouvé par des sessions PostgreSQL réelles concurrentes (voir
-- CONCURRENCY-REPORT.txt, section claim).
--
-- ÉLIGIBILITÉ (mandat section 4) : EXCLUSIVEMENT processing_status IN
-- ('received', 'failed_retryable') ET (jamais revendiqué OU bail
-- expiré -- `claim_expires_at is null or claim_expires_at <= now()`).
-- `applied`/`ignored`/`failed_terminal` ne sont JAMAIS éligibles (déjà
-- exclus du filtre WHERE -- pas une vérification a posteriori).
--
-- BAIL / REPRISE APRÈS CRASH (mandat section 5/8) : chaque revendication
-- pose un `claim_token` (gen_random_uuid(), jamais un identifiant de
-- processus/session serveur) et un `claim_expires_at` borné dans le
-- temps. Si le worker qui a revendiqué disparaît AVANT de finaliser
-- (crash), AUCUNE action manuelle n'est requise : dès que
-- `claim_expires_at` est dépassé, l'évènement redevient naturellement
-- éligible à une NOUVELLE revendication par CE MÊME appel -- bail
-- temporel plutôt qu'un mécanisme de libération explicite (choisi pour
-- sa simplicité et parce qu'un worker qui a crashé ne peut, par
-- définition, jamais appeler explicitement une fonction de
-- libération).
--
-- ORDONNANCEMENT DÉTERMINISTE (mandat section 4 ; AJOUT v3, ferme
-- P3B5-CLAIM-ORDER-01 — LOW) : `order by created_at, id` (JAMAIS
-- `created_at` seul) à la fois dans le CTE d'éligibilité (quelles
-- lignes sont choisies) et dans le résultat final renvoyé -- toujours
-- les évènements les plus anciens d'abord, et `id` comme départage
-- STABLE et TOTAL entre deux lignes qui partageraient EXACTEMENT le
-- même `created_at` (horodatage à la même microseconde -- rare mais
-- non exclu, `now()` peut renvoyer la même valeur pour deux insertions
-- très rapprochées dans une même transaction/lot). Sans départage,
-- l'ordre entre deux telles lignes ne serait pas garanti stable d'un
-- appel à l'autre (PostgreSQL ne garantit un ordre total que si la
-- clé de tri l'est) ; `id` (uuid, unique par construction) le rend
-- total à coût négligeable.
--
-- CONTRAT DE RETOUR (mandat section 6) : uniquement les champs
-- nécessaires à un traitement métier -- AUCUNE charge utile brute,
-- AUCUN secret, AUCUN public_token (qui n'existe d'ailleurs pas dans ce
-- schéma).
-- ------------------------------------------------------------
create or replace function public.claim_payment_provider_events(
  p_batch_size integer default 20,
  p_lease_seconds integer default 60
)
returns table (
  id uuid,
  restaurant_id uuid,
  order_id uuid,
  payment_transaction_id uuid,
  provider_code text,
  provider_reference text,
  event_fingerprint text,
  provider_event_type text,
  provider_event_code text,
  amount numeric,
  currency text,
  authorization_reference text,
  processing_status text,
  retry_count integer,
  claim_token uuid,
  claim_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer;
  v_lease_seconds integer;
begin
  v_batch_size := coalesce(p_batch_size, 20);
  v_lease_seconds := coalesce(p_lease_seconds, 60);

  -- Lot BORNÉ (mandat section 4, "bounded batch size") -- échec fermé
  -- plutôt qu'un plafonnement silencieux : un appelant qui demande une
  -- valeur hors bornes a un bug qui mérite d'être visible, pas masqué.
  if v_batch_size < 1 or v_batch_size > 100 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_batch_size hors bornes (entre 1 et 100 attendu)' using errcode = '22023';
  end if;
  if v_lease_seconds < 5 or v_lease_seconds > 3600 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_lease_seconds hors bornes (entre 5 et 3600 attendu)' using errcode = '22023';
  end if;

  return query
  with eligible as (
    select e.id
      from public.payment_provider_events e
      where e.processing_status in ('received', 'failed_retryable')
        and (e.claim_expires_at is null or e.claim_expires_at <= now())
      order by e.created_at, e.id
      limit v_batch_size
      for update skip locked
  ),
  claimed as (
    update public.payment_provider_events e
      set claim_token = gen_random_uuid(),
          claimed_at = now(),
          claim_expires_at = now() + make_interval(secs => v_lease_seconds)
      from eligible
      where e.id = eligible.id
      returning e.id, e.restaurant_id, e.order_id, e.payment_transaction_id,
                e.provider_code, e.provider_reference, e.event_fingerprint,
                e.provider_event_type, e.provider_event_code, e.amount, e.currency::text,
                e.authorization_reference, e.processing_status, e.retry_count,
                e.claim_token, e.claim_expires_at, e.created_at
  )
  select claimed.id, claimed.restaurant_id, claimed.order_id, claimed.payment_transaction_id,
         claimed.provider_code, claimed.provider_reference, claimed.event_fingerprint,
         claimed.provider_event_type, claimed.provider_event_code, claimed.amount, claimed.currency,
         claimed.authorization_reference, claimed.processing_status, claimed.retry_count,
         claimed.claim_token, claimed.claim_expires_at
    from claimed
    order by claimed.created_at, claimed.id;
end;
$$;

comment on function public.claim_payment_provider_events(integer, integer) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B5 v2, ferme P3B5-RETRY-01. Primitif de file de travail PostgreSQL : `FOR UPDATE SKIP LOCKED` puis UPDATE atomique -- deux workers concurrents ne peuvent jamais revendiquer la même ligne (chacun saute les lignes déjà verrouillées par l''autre). Éligibilité STRICTE : processing_status in (received, failed_retryable) ET (jamais revendiqué ou bail expiré). applied/ignored/failed_terminal ne sont jamais éligibles. Pose un bail temporel (claim_token/claimed_at/claim_expires_at) -- un worker qui revendique puis crashe n''orpheline JAMAIS l''évènement : dès expiration du bail, l''évènement redevient éligible à une nouvelle revendication. Ordonnancement déterministe (created_at croissant). AUCUN accès SELECT direct à la table n''est requis ni accordé pour cette capacité -- reste RPC-only. Le jeton de bail retourné DOIT être fourni tel quel à update_payment_provider_event_processing_status pour finaliser cet évènement -- un jeton périmé ou incorrect est rejeté (fail-closed), empêchant un worker périmé d''écraser une revendication plus récente.';

revoke all on function public.claim_payment_provider_events(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_payment_provider_events(integer, integer) to service_role;

-- ------------------------------------------------------------
-- 4. update_payment_provider_event_processing_status — SEULE autorité
-- de TRANSITION de processing_status, SECURITY DEFINER, service_role
-- UNIQUEMENT.
--
-- MACHINE À ÉTATS EXPLICITE (mandat section 12/13/32), transitions
-- AUTORISÉES et STRICTEMENT limitées à celles-ci :
--   received         -> applied
--   received         -> ignored
--   received         -> failed_retryable
--   failed_retryable -> applied
--   failed_retryable -> failed_retryable  (nouvel essai raté --
--                                          incrémente retry_count,
--                                          SEULE transition "vers le
--                                          même état" qui n'est PAS un
--                                          simple no-op)
--   failed_retryable -> failed_terminal   (addition délibérée de ce
--                                          lot, mandat section 12 :
--                                          "terminal processing state
--                                          must be explicit" exige
--                                          qu'un état terminal existe
--                                          ET soit atteignable --
--                                          documentée explicitement
--                                          dans PROCESSING-STATE-MODEL-
--                                          REPORT.txt, hors de la liste
--                                          minimale du mandat section
--                                          32 mais strictement
--                                          nécessaire pour qu''elle ne
--                                          soit pas un état mort)
-- VERROUILLAGE TERMINAL (même patron que confirm_payment_attempt,
-- PAYMENT P1, appliqué ICI indépendamment -- P1 lui-même reste
-- INCHANGÉ) : applied/ignored/failed_terminal sont TERMINAUX -- une
-- fois atteints, seule une transition IDENTIQUE (replay) est acceptée
-- (no-op idempotent) ; toute transition vers un état DIFFÉRENT est
-- REFUSÉE. `received` et `failed_retryable` restent seuls non
-- terminaux.
--
-- AJOUT v2 (ferme P3B5-RETRY-01, mandat section 9) : `p_claim_token`
-- est désormais un paramètre REQUIS (aucune valeur par défaut) --
-- toute transition RÉELLE (pas un simple replay idempotent d'un état
-- déjà terminal) exige de prouver la possession du bail ACTUEL de
-- l'évènement, obtenu exclusivement via `claim_payment_provider_events`.
-- Un jeton incorrect OU un bail expiré est REFUSÉ (fail-closed) --
-- c'est précisément ce qui empêche un worker périmé (dont le bail a
-- expiré et a été repris par un autre worker) d'écraser une
-- revendication plus récente : au moment où le worker périmé appelle
-- enfin cette fonction, soit son jeton ne correspond plus (un autre
-- worker a déjà reposé un nouveau jeton), soit son bail est expiré --
-- dans les deux cas, refusé. Le replay idempotent d'un état DÉJÀ
-- terminal (applied->applied, etc.) reste volontairement EXEMPTÉ de
-- cette vérification : c'est un no-op en lecture seule qui ne modifie
-- rien et ne pose aucun risque de concurrence (voir CLAIM-LEASE-
-- RECOVERY-REPORT.txt pour la justification complète). Toute
-- transition qui MODIFIE réellement l'état (y compris
-- failed_retryable -> failed_retryable, un nouvel essai raté) libère
-- IMMÉDIATEMENT le bail (claim_token/claimed_at/claim_expires_at remis
-- à NULL) -- un événement qui redevient failed_retryable est donc
-- IMMÉDIATEMENT re-revendicable par un futur appel de
-- claim_payment_provider_events, sans attendre l'expiration du bail
-- précédent.
-- ------------------------------------------------------------
create or replace function public.update_payment_provider_event_processing_status(
  p_event_id uuid,
  p_claim_token uuid,
  p_new_status text,
  p_error_class text default null
)
returns table (
  id uuid,
  processing_status text,
  retry_count integer,
  processed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_status text;
  v_error_class text;
  v_event public.payment_provider_events%rowtype;
begin
  if p_event_id is null then
    raise exception 'SCANYM_PAYMENT_EVENT: p_event_id requis' using errcode = '22004';
  end if;
  if p_claim_token is null then
    raise exception 'SCANYM_PAYMENT_EVENT: p_claim_token requis -- l''évènement doit avoir été revendiqué via claim_payment_provider_events avant toute transition' using errcode = '22004';
  end if;
  v_new_status := btrim(coalesce(p_new_status, ''));
  if v_new_status not in ('applied','ignored','failed_retryable','failed_terminal') then
    raise exception 'SCANYM_PAYMENT_EVENT: p_new_status invalide (attendu applied/ignored/failed_retryable/failed_terminal)' using errcode = '22023';
  end if;
  v_error_class := nullif(btrim(coalesce(p_error_class, '')), '');
  if v_error_class is not null and length(v_error_class) > 200 then
    raise exception 'SCANYM_PAYMENT_EVENT: p_error_class trop long (200 caractères maximum -- classification courte uniquement, jamais une pile d''appel)' using errcode = '22023';
  end if;

  select * into v_event from public.payment_provider_events where payment_provider_events.id = p_event_id for update;
  if not found then
    raise exception 'SCANYM_PAYMENT_EVENT: évènement introuvable' using errcode = 'P0002';
  end if;

  -- AJOUT v3 (ferme P3B5-CLAIM-TOKEN-01 -- LOW) : validation DÉFENSIVE
  -- du jeton, exécutée AVANT le rejeu idempotent d'un état terminal
  -- ci-dessous, dès qu'un bail EXISTE actuellement sur cet évènement
  -- (claim_token IS NOT NULL) -- quel que soit l'état, terminal ou
  -- non. Sous l'invariant normal de cette fonction, un évènement
  -- TERMINAL a TOUJOURS claim_token = NULL (toute transition réelle
  -- libère inconditionnellement le bail, voir plus bas) : cette
  -- vérification est donc un NO-OP prouvé pour le chemin de rejeu
  -- normal (elle ne se déclenche jamais, puisque v_event.claim_token
  -- est NULL) -- AUCUNE régression sur le comportement déjà testé et
  -- documenté (voir CLAIM-LEASE-RECOVERY-REPORT.txt, "TERMINAL REPLAY
  -- EXEMPTION"). Elle sert de filet de sécurité en profondeur : si un
  -- bail venait à exister malgré tout sur un évènement (violation
  -- future de l'invariant, bug ailleurs, etc.), un jeton INCORRECT
  -- échouerait de façon COHÉRENTE (P0004) au lieu de pouvoir
  -- silencieusement "rejouer" un état -- fermant l'écart identifié par
  -- l'audit : "validate claim token before terminal-state no-op return
  -- so wrong token fails consistently". Un évènement SANS bail
  -- (claim_token IS NULL, le cas normal pour tout état terminal ou
  -- pour un évènement jamais revendiqué) ignore cette vérification et
  -- poursuit -- exactement comme avant.
  if v_event.claim_token is not null and v_event.claim_token is distinct from p_claim_token then
    raise exception 'SCANYM_PAYMENT_EVENT: jeton de revendication invalide -- un bail existe sur cet évènement et ne correspond pas au jeton fourni (fail-closed)' using errcode = 'P0004';
  end if;

  -- Idempotence même-état : rejouer exactement le même statut est un
  -- no-op, SAUF failed_retryable -> failed_retryable qui représente un
  -- nouvel essai raté et incrémente retry_count (seule exception
  -- documentée, mandat section 32 "document idempotent same-state
  -- behavior"). EXEMPTÉ de la vérification de bail lorsque l'état est
  -- déjà TERMINAL (applied/ignored/failed_terminal) -- un no-op en
  -- lecture seule sur un état déjà définitif ne pose aucun risque,
  -- voir note de conception ci-dessus.
  if v_event.processing_status = v_new_status
     and v_new_status <> 'failed_retryable'
     and v_event.processing_status in ('applied','ignored','failed_terminal') then
    return query select v_event.id, v_event.processing_status, v_event.retry_count, v_event.processed_at;
    return;
  end if;

  -- VERROUILLAGE TERMINAL : applied/ignored/failed_terminal sont
  -- définitifs -- toute transition DEPUIS l'un de ces états (sauf la
  -- même valeur, déjà traitée ci-dessus comme no-op) est refusée.
  if v_event.processing_status in ('applied','ignored','failed_terminal') then
    raise exception 'SCANYM_PAYMENT_EVENT: évènement déjà dans un état de traitement terminal (%) -- transition vers % refusée (fail-closed)', v_event.processing_status, v_new_status using errcode = '42501';
  end if;

  -- PROPRIÉTÉ DU BAIL (ferme P3B5-RETRY-01/mandat section 9) : à partir
  -- d'ici, la transition MODIFIE réellement l'état -- exige la
  -- possession PROUVÉE du bail ACTUEL, encore VALIDE (non expiré).
  -- Un évènement jamais revendiqué (claim_token IS NULL) ne peut JAMAIS
  -- satisfaire cette condition, quel que soit p_claim_token fourni --
  -- ce qui impose structurellement le passage par
  -- claim_payment_provider_events avant toute première transition
  -- réelle.
  if v_event.claim_token is distinct from p_claim_token
     or v_event.claim_token is null
     or v_event.claim_expires_at is null
     or v_event.claim_expires_at <= now() then
    raise exception 'SCANYM_PAYMENT_EVENT: jeton de revendication invalide ou bail expiré -- cet appelant n''est pas (ou plus) le détenteur exclusif de cet évènement (fail-closed, reprise après crash requiert une nouvelle revendication via claim_payment_provider_events)' using errcode = 'P0004';
  end if;

  -- TRANSITIONS EXPLICITEMENT AUTORISÉES SEULEMENT (mandat section 32) :
  -- received -> {applied, ignored, failed_retryable} ;
  -- failed_retryable -> {applied, failed_retryable, failed_terminal}.
  if v_event.processing_status = 'received'
     and v_new_status not in ('applied','ignored','failed_retryable') then
    raise exception 'SCANYM_PAYMENT_EVENT: transition received -> % non autorisée', v_new_status using errcode = '42501';
  end if;
  if v_event.processing_status = 'failed_retryable'
     and v_new_status not in ('applied','failed_retryable','failed_terminal') then
    raise exception 'SCANYM_PAYMENT_EVENT: transition failed_retryable -> % non autorisée', v_new_status using errcode = '42501';
  end if;

  -- Toute transition réelle qui atteint cette ligne est AUTORISÉE et
  -- prouvée possédée -- le bail est désormais LIBÉRÉ inconditionnellement
  -- (claim_token/claimed_at/claim_expires_at -> NULL), y compris pour
  -- failed_retryable (re-revendicable immédiatement, sans attendre
  -- l'expiration).
  update public.payment_provider_events
    set processing_status = v_new_status,
        retry_count = case when v_new_status = 'failed_retryable' then payment_provider_events.retry_count + 1 else payment_provider_events.retry_count end,
        last_error_class = case when v_new_status in ('failed_retryable','failed_terminal') then v_error_class else payment_provider_events.last_error_class end,
        last_attempt_at = case when v_new_status = 'failed_retryable' then now() else payment_provider_events.last_attempt_at end,
        processed_at = now(),
        claim_token = null,
        claimed_at = null,
        claim_expires_at = null
    where payment_provider_events.id = p_event_id;

  select * into v_event from public.payment_provider_events where payment_provider_events.id = p_event_id;
  return query select v_event.id, v_event.processing_status, v_event.retry_count, v_event.processed_at;
end;
$$;

comment on function public.update_payment_provider_event_processing_status(uuid, uuid, text, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B5 v2. Seule autorité de TRANSITION de payment_provider_events.processing_status -- machine à états à verrouillage terminal (applied/ignored/failed_terminal définitifs, même patron que confirm_payment_attempt PAYMENT P1, appliqué indépendamment ici -- P1 lui-même INCHANGÉ). AJOUT v2 (ferme P3B5-RETRY-01) : p_claim_token est REQUIS pour toute transition RÉELLE et doit correspondre exactement au bail ACTUEL, NON expiré, posé par claim_payment_provider_events -- un jeton périmé ou incorrect est rejeté fail-closed, empêchant un worker périmé (bail expiré, repris par un autre worker) d''écraser une revendication plus récente. Le replay idempotent d''un état DÉJÀ terminal reste exempté de cette vérification (no-op en lecture seule, aucun risque). Transitions autorisées EXCLUSIVEMENT : received->{applied,ignored,failed_retryable}, failed_retryable->{applied,failed_retryable,failed_terminal}. failed_retryable->failed_retryable incrémente retry_count (reprise ratée) ; toute autre répétition du même état est un no-op idempotent. Toute transition réelle LIBÈRE immédiatement le bail. Ne modifie JAMAIS payment_transactions.status/orders.payment_status/current_payment_transaction_id -- fournit UNIQUEMENT la surface de reprise durable ; une orchestration séparée future reste seule responsable d''appeler confirm_payment_attempt si une mutation métier est décidée (mandat section 34, durable receipt et mutation métier restent séparables).';

revoke all on function public.update_payment_provider_event_processing_status(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.update_payment_provider_event_processing_status(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- 5. NON-RÉGRESSION EXPLICITE (mandat sections 27/28/34) : ce lot
-- n'altère AUCUNE fonction existante (initiate_payment_attempt,
-- confirm_payment_attempt, get_payment_transaction_correlation,
-- get_order_payment_status, get_payment_runtime_provider_config,
-- get_order_payment_context, get_order_active_payment_attempt,
-- get_payment_runtime_provider_environment restent tous INCHANGÉS),
-- AUCUNE valeur d'énumération existante (payment_transactions.status,
-- orders.payment_status, payment_provider_configs.mode/
-- configuration_status), et AUCUN privilège de table existant. Les
-- deux fonctions ci-dessus et la table ci-dessus restent la SEULE
-- autorité nouvelle de ce lot.
-- ------------------------------------------------------------

commit;
