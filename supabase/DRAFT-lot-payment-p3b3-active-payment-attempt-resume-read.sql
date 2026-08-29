-- ============================================================
-- Scanym — PAYMENT P3-B3 — ACTIVE PAYMENT ATTEMPT RESUME READ — v1
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot existe parce que PAYMENT P3-B MONETICO CHECKOUT
-- RUNTIME v2 a effectué son inspection d'architecture obligatoire
-- (relecture fraîche de DRAFT-lot-payment-p1-foundation.sql,
-- DRAFT-lot-payment-p3b0-correlation-status-read.sql et
-- DRAFT-lot-payment-p3b2-order-payment-context-read.sql) et s'est
-- arrêté correctement avec :
--   STOP — PAYMENT P3-B v2 PENDING ATTEMPT DATABASE CAPABILITY REQUIRED
--
-- Constat précis (répond à l'audit indépendant PAY-P3B-ATTEMPT-01,
-- MEDIUM, RELEASE-BLOCKING) : `initiate_payment_attempt` (PAYMENT P1,
-- déjà publié, INCHANGÉ) verrouille la commande, refuse une tentative
-- active concurrente, crée une tentative 'pending' et positionne
-- `orders.current_payment_transaction_id` -- ceci est un comportement
-- de concurrence CORRECT, non remis en cause ici. Le manque n'est
-- JAMAIS la création -- c'est qu'aucune capacité de confiance
-- n'existe pour RETROUVER, par (order_id, public_token), la tentative
-- 'pending' déjà créée après qu'un navigateur ait abandonné le
-- paiement avant soumission -- rendant cette tentative valide en base
-- mais orpheline du point de vue du runtime.
--
-- DÉCISION ARCHITECTURALE (mandat P3-B3 section 2, contraignante pour
-- ce lot) : ce lot implémente EXCLUSIVEMENT une autorité de
-- REPRISE/LECTURE (RESUME/READ) de la tentative 'pending' courante --
-- AUCUNE expiration, AUCUNE transition automatique, AUCUNE annulation,
-- AUCUN remplacement par une nouvelle référence. Raison explicite :
-- une tentative localement "ancienne" a pu déjà être soumise à
-- Monetico, son callback restant simplement en retard ou perdu --
-- annuler automatiquement une telle tentative puis en créer une
-- nouvelle avec une référence différente créerait un risque de double
-- paiement (deux références actives pour la même commande, potentielle
-- double autorisation bancaire). La seule capacité sûre en premier
-- lieu est donc : REPRENDRE EXACTEMENT LA MÊME TENTATIVE PENDING
-- COURANTE, jamais en créer ou en clôturer une différente. Un futur
-- lot dédié à l'expiration/l'annulation bornée dans le temps (classe
-- C du mandat PAYMENT P3-B v2, sections 11/13 du présent mandat)
-- reste hors périmètre ICI et n'est ni implémenté ni esquissé par ce
-- fichier.
--
-- N'IMPLÉMENTE AUCUN checkout, AUCUNE route de paiement/callback,
-- AUCUNE page de retour navigateur, AUCUN appel réseau Monetico,
-- AUCUNE UI marchande, AUCUNE saisie de credential, AUCUNE activation
-- Production. Mini-lot SQL isolé, au même titre que PAYMENT
-- P3-A0/P3-B0/P3-B1/P3-B2 l'ont été.
--
-- PRÉREQUIS (déjà publiés, INCHANGÉS et NON ROUVERTS par ce lot) :
-- PAYMENT P1 FOUNDATION (`payment_transactions`, `orders.payment_status`,
-- `orders.current_payment_transaction_id`, `orders.public_token` via
-- migration-orders.sql). Ce lot ne dépend PAS de P2A/P2B-A/P3-A0/
-- P3-B0/P3-B1/P3-B2 -- aucune de ces capacités soeurs n'ajoute de
-- colonne/contrainte requise ici, la fonction sous ce lot lit
-- exclusivement des colonnes déjà posées par P1/migration-orders.sql.
-- Ni `initiate_payment_attempt`, ni `confirm_payment_attempt`, ni
-- `get_order_payment_context` (P3-B2, contrat volontairement minimal
-- restaurant_id/payment_status) ne sont modifiés -- ce lot ajoute une
-- fonction strictement nouvelle, à contrat disjoint.
--
-- POURQUOI NI get_order_payment_context (P3-B2) NI
-- get_payment_transaction_correlation (P3-B0) NE SUFFISENT (analyse
-- fraîche, mandat section 1, jamais supposée depuis une session
-- précédente) :
--   - get_order_payment_context(p_order_id, p_public_token) renvoie
--     EXCLUSIVEMENT restaurant_id/payment_status -- son commentaire
--     documente explicitement qu'elle ne renvoie JAMAIS
--     provider_reference/transaction_id/amount/currency (contrat
--     CLIENT public volontairement minimal, mandat P3-B3 section 16,
--     "Do not widen get_order_payment_context").
--   - get_payment_transaction_correlation(p_provider_code,
--     p_provider_reference) est keyed par la RÉFÉRENCE elle-même en
--     ENTRÉE -- elle sert un callback qui la porte déjà, jamais une
--     reprise cliente qui a précisément PERDU cette référence (ou ne
--     l'a jamais reçue, navigateur fermé avant que la réponse ne soit
--     traitée).
-- Aucune fonction existante ne permet de retrouver le triplet
-- (provider_reference, amount, currency) d'une tentative 'pending' à
-- partir de la SEULE preuve de possession (order_id, public_token).
-- Ce lot ferme UNIQUEMENT ce manque précis -- rien de plus.
--
-- CONTRAT DE RETOUR DÉLIBÉRÉMENT MINIMAL (mandat section 3) :
-- EXACTEMENT `provider_reference`, `amount`, `currency` -- juste assez
-- pour qu'une future orchestration P3-B v2 reconstruise le même
-- formulaire hébergé Monetico pour la MÊME tentative. Ne retourne
-- JAMAIS : transaction_id, restaurant_id, public_token, donnée client,
-- order_number, credential, référence Vault, authorization_reference,
-- charge brute prestataire.
--
-- AUTORITÉ MONTANT/DEVISE (mandat section 9) : `amount`/`currency`
-- proviennent EXCLUSIVEMENT de `payment_transactions`, la valeur posée
-- UNIQUEMENT par `initiate_payment_attempt` (P1, inchangé) au moment
-- de l'initiation -- jamais recalculés depuis `orders`/le panier/le
-- navigateur. Ceci garantit qu'une reprise utilise EXACTEMENT la même
-- autorité financière que la tentative d'origine (mandat section 10,
-- "same reference, same amount, same currency, every retry/resume").
--
-- POURQUOI service_role SEUL (mandat section 7) : comme
-- get_order_payment_context/get_payment_transaction_correlation,
-- AUCUN bénéfice fonctionnel pour le navigateur -- seul un futur
-- runtime serveur de confiance (PAYMENT P3-B v2) doit reconstruire un
-- formulaire hébergé prestataire ; le navigateur ne transmet et ne
-- reçoit jamais provider_reference/amount/currency directement via
-- cette RPC.
--
-- MODÈLE DE POSSESSION (mandat section 4) : preuve EXACTE déjà établie
-- par `mark_whatsapp_opened`/`get_order_payment_status`/
-- `get_order_payment_context` -- `orders.id = p_order_id` ET
-- `orders.public_token = p_public_token`, aucun fallback, aucune
-- recherche par order_number, aucun restaurant_id fourni par
-- l'appelant. Instruction SQL PURE, sans branche ni exception :
-- ensemble de résultats vide pour toute paire incorrecte, y compris
-- des arguments NULL (même posture de confidentialité de possession
-- que P3-B0/P3-B2 -- mandat section 17).
--
-- PRÉDICAT "TENTATIVE COURANTE" (mandat section 5) : la tentative
-- renvoyée DOIT être EXACTEMENT celle pointée par
-- `orders.current_payment_transaction_id`, appartenir à CETTE
-- commande, être `status = 'pending'`, avec `orders.payment_status =
-- 'pending'` également, et porter le `provider_code` normalisé
-- demandé. La jointure `t.id = o.current_payment_transaction_id`
-- garantit déjà structurellement (via la FK composite PAY-P1-V2-01)
-- que `t.order_id = o.id` -- le prédicat explicite ci-dessous le
-- revérifie néanmoins en défense en profondeur (mandat section 5,
-- jamais supposé silencieusement), exactement comme PAYMENT P1/P3-B0
-- l'ont déjà fait pour leurs propres garanties structurelles
-- équivalentes.
--
-- NORMALISATION provider_code (mandat section 6) : même convention
-- que PAYMENT P1 (`btrim`, AUCUNE mise en minuscule imposée) --
-- comparaison directe contre `payment_transactions.provider_code`,
-- lui-même déjà trimé et restreint au jeu de caractères sûr par la
-- contrainte CHECK de P1. Un `p_provider_code` vide après trim (ou
-- NULL) ne correspond simplement à AUCUNE ligne réelle -- ensemble de
-- résultats vide, jamais une exception distincte (mandat section 17,
-- "malformed/empty provider -> zero rows").
--
-- AUCUN VERROU (mandat section 7) : lecture pure, `stable`, aucun
-- `FOR UPDATE` -- cette fonction ne prépare aucune mutation et n'en
-- déclenche aucune ; seule `confirm_payment_attempt` reste autorité de
-- mutation, inchangée.
--
-- PATRON DE SÉCURITÉ PRÉSERVÉ : comme pour tous les lots précédents,
-- AUCUN grant de table nouveau n'est posé ici -- la fonction est
-- SECURITY DEFINER, `search_path` explicitement vide, aucune identité
-- de schéma/objet contrôlée par l'appelant, aucun SQL dynamique.
-- AUCUNE clause OWNER TO explicite -- la fonction hérite de la
-- propriété du rôle exécutant cette migration au déploiement,
-- identique au patron déjà établi partout ailleurs. `service_role` ne
-- reçoit et ne reçoit JAMAIS de SELECT direct sur `public.orders` ni
-- `public.payment_transactions` (durcissements ORDERS SERVICE_ROLE
-- SELECT HARDENING v1 et PAY-P1-03 RPC-ONLY AUTHORITY, tous deux
-- préservés sans modification).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
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
      and column_name in ('id','order_id','provider_code','provider_reference','status','amount','currency')
    having count(*) = 7
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.payment_transactions -- prérequis PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','public_token','payment_status','current_payment_transaction_id')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- prérequis migration-orders.sql/PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'f'
      and conname = 'orders_current_payment_transaction_fk'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: FK composite orders_current_payment_transaction_fk introuvable -- prérequis PAYMENT P1 FOUNDATION (correction PAY-P1-V2-01) manquant, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_order_active_payment_attempt'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_active_payment_attempt existe déjà -- PAYMENT P3-B3 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_order_active_payment_attempt — LECTURE SERVEUR DE CONFIANCE
-- SEULE, service_role UNIQUEMENT, possession-scoped, tentative
-- COURANTE uniquement.
-- ------------------------------------------------------------
create or replace function public.get_order_active_payment_attempt(
  p_order_id uuid,
  p_public_token uuid,
  p_provider_code text
)
returns table (
  provider_reference text,
  amount numeric,
  currency text
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.provider_reference, t.amount, t.currency::text
  from public.orders o
  join public.payment_transactions t
    on t.id = o.current_payment_transaction_id
  where o.id = p_order_id
    and o.public_token = p_public_token
    and o.payment_status = 'pending'
    and t.order_id = o.id
    and t.status = 'pending'
    and t.provider_code = btrim(coalesce(p_provider_code, ''));
$$;

comment on function public.get_order_active_payment_attempt(uuid, uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B3. Lecture serveur de confiance SEULE, possession-scoped (order_id + public_token, même patron que get_order_payment_context/get_order_payment_status/mark_whatsapp_opened), de la tentative de paiement PENDING COURANTE (orders.current_payment_transaction_id, orders.payment_status=''pending'', payment_transactions.status=''pending'', provider_code normalisé correspondant) d''une commande -- ferme PAY-P3B-ATTEMPT-01 (capacité de reprise/lecture, JAMAIS d''expiration/annulation, mandat P3-B3 section 2). Renvoie EXACTEMENT provider_reference/amount/currency, les valeurs AUTORITATIVES posées par initiate_payment_attempt (P1, inchangé) -- jamais recalculées depuis orders/le panier/le navigateur, garantissant qu''une reprise utilise la MÊME autorité financière et la MÊME référence que la tentative d''origine (mandat section 10, "one pending payment_transaction = one provider_reference = every retry/resume"). Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL), toute tentative non courante/non pending, ou tout provider_code non correspondant produit systématiquement un ensemble de résultats vide, de façon identique dans tous les cas -- aucune fuite d''information observable. Ne retourne jamais transaction_id, restaurant_id, public_token, donnée client, order_number, credential, référence Vault, authorization_reference. Aucune écriture, aucun verrou -- initiate_payment_attempt/confirm_payment_attempt restent seules autorités de mutation et restent INCHANGÉES par ce lot. N''implémente AUCUNE expiration ni annulation automatique (hors périmètre, risque de double paiement -- voir SAME-REFERENCE-REPORT.txt/CONCURRENCY-REPORT.txt du paquet livré).';

revoke all on function public.get_order_active_payment_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.get_order_active_payment_attempt(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. NON-RÉGRESSION EXPLICITE — ce lot n'altère AUCUN privilège de
-- table existant, ni AUCUNE fonction existante (initiate_payment_attempt,
-- confirm_payment_attempt, get_payment_provider_credential,
-- get_payment_transaction_correlation, get_order_payment_status,
-- get_payment_runtime_provider_config, get_order_payment_context
-- restent tous INCHANGÉS). AUCUN grant de table nouveau n'est ajouté
-- par ce lot, pour quelque rôle que ce soit, y compris service_role --
-- la fonction ci-dessus reste la SEULE autorité nouvelle, et
-- service_role ne reçoit toujours AUCUN SELECT direct sur
-- public.orders ni public.payment_transactions (préservé tel quel,
-- revérifié par le harnais de ce lot).
-- ------------------------------------------------------------

commit;
