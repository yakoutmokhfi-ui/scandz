-- ============================================================
-- Scanym — PAYMENT P3-B / MONETICO CHECKOUT RUNTIME v3 — SQL LOT
-- (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot ferme la partie BASE DE DONNÉES du mandat PAYMENT
-- P3-B MONETICO CHECKOUT RUNTIME v3, en réponse à 7 constats d'audit
-- v2 nommés (V2-01 à V2-07). Ce lot ajoute EXACTEMENT UNE fonction
-- nouvelle, DISJOINTE de tout contrat existant :
--   - public.get_order_payment_status_snapshot(uuid, uuid)
-- AUCUNE table, colonne, contrainte, index ou fonction déjà publiée
-- (PAYMENT P1, P3-A0, P3-A2, P3-B0..P3-B6) n'est modifiée, recréée ou
-- rouverte par ce lot. En particulier `initiate_payment_attempt` et
-- `confirm_payment_attempt` (PAYMENT P1) restent INCHANGÉS -- ce lot
-- ne les appelle même pas.
--
-- DÉCISION DE PÉRIMÈTRE (révision après reconnaissance approfondie,
-- voir SUPERSESSION-GAP-REPORT.txt du paquet livré pour l'analyse
-- complète) : une version antérieure de ce fichier ajoutait une
-- deuxième fonction, `cancel_payment_attempt(uuid, uuid, text)`,
-- destinée à donner au client un moyen explicite d'abandonner une
-- tentative ''pending'' bloquée en la faisant transitionner vers la
-- cible terminale ''cancelled'' déjà existante de P1. Cette fonction a
-- été RETIRÉE avant toute application, sur la base d'une analyse
-- rigoureuse du contrat Monetico réel (re-vérification fraîche du
-- document technique v2.0, §1.4.3 p.25 et §7.2 p.69) :
--   - Monetico ne connaît RIEN de notre état ''cancelled'' local --
--     l''annuler chez Scanym n''annule rien côté acquéreur/Monetico.
--   - Le document ne documente AUCUNE fenêtre après laquelle une
--     référence peut être considérée comme définitivement morte -- au
--     contraire (§1.4.3, p.25) il prévient explicitement qu''une MÊME
--     référence peut recevoir plusieurs notifications dans le temps,
--     y compris un paiement accepté APRÈS un ou plusieurs refus.
--   - Le seul délai documenté (45 minutes, §7.2 p.69) borne la SAISIE
--     carte sur la page hébergée Monetico -- pas le délai du retour
--     après une soumission dans cette fenêtre, qui reste NON borné
--     dans le cas général (paiement simple, non fractionné).
--   - Notre modèle ne peut PAS distinguer une tentative ''créée mais
--     jamais soumise au navigateur'' d''une tentative ''effectivement
--     soumise, callback en attente'' -- payment_transactions ne porte
--     que created_at, aucun signal de soumission fiable n''existe ni
--     ne peut raisonnablement être ajouté (un beacon client-side ne
--     prouverait jamais la soumission réelle -- la requête peut
--     échouer après son émission).
-- Conséquence : `confirm_payment_attempt` (P1, inchangé) verrouille
-- TERMINALEMENT paid/failed/cancelled de façon strictement identique
-- -- une fois ''cancelled'' posé, un callback ''paid'' authentique et
-- POSTÉRIEUR sur la même référence serait rejeté (42501) par ce même
-- verrouillage qui protège par ailleurs correctement le système contre
-- les callbacks tardifs sur tentative dépassée. `cancel_payment_
-- attempt` aurait donc donné au NAVIGATEUR (via une action cliente
-- d''abandon) le pouvoir de rendre impossible l''application
-- AUTOMATIQUE d''un paiement réellement encaissé -- violation directe
-- de l''invariant contraignant de ce mandat ("a legitimate
-- authenticated Monetico paid event must never be blocked by a prior
-- local/browser action"). AUCUN des 7 constats v2 nommés (V2-01 à
-- V2-07) n''exige cette capacité -- elle était une extension de
-- périmètre auto-proposée, jamais un prérequis. Elle est donc retirée
-- intégralement plutôt que rendue "sûre au prix d''une réconciliation
-- manuelle" : voir OPEN GAP ci-dessous pour la trace explicite du
-- compromis UX qui en résulte, et pour la piste de conception (NON
-- implémentée, NON esquissée en détail ici) d''un futur lot séparé si
-- ce besoin est un jour confirmé.
--
-- OPEN GAP — SAFE PAYMENT ATTEMPT SUPERSESSION REQUIRES SEPARATE
-- ARCHITECTURE LOT : tant qu'une tentative reste 'pending' (y compris
-- indéfiniment, y compris après abandon apparent du client, y compris
-- après un ou plusieurs refus Monetico observés), `payment_transactions_
-- one_active_per_order` (index unique partiel, PAYMENT P1, INCHANGÉ)
-- empêche toute NOUVELLE tentative pour la même commande --
-- `initiate_payment_attempt` la refuse explicitement. Ce lot
-- N'IMPLÉMENTE AUCUNE capacité pour en sortir : ni annulation
-- explicite, ni expiration automatique, ni "supersession". Un client
-- dont la tentative reste bloquée ne peut que REPRENDRE la MÊME
-- tentative (get_order_active_payment_attempt, PAYMENT P3-B3, déjà
-- publié, tant qu'il reste dans la fenêtre de 45 minutes Monetico) --
-- il ne peut pas obtenir une seconde référence active tant que la
-- première n'est pas résolue par un callback authentique ou une
-- intervention opérationnelle hors bande (hors périmètre de tout
-- code -- décision humaine/support, pas une capacité logicielle). Ce
-- choix est DÉLIBÉRÉ, pas un oubli : c'est le prix payé pour garantir
-- qu'AUCUNE action navigateur/cliente ne puisse jamais rendre
-- impossible l'application automatique d'un paiement réellement
-- encaissé. Si ce gap doit un jour être fermé, le lot qui le ferait
-- DOIT explicitement redessiner la machine à états de P1 autour d'un
-- concept de "supersession" NON TERMINAL (ex. un statut distinct de
-- paid/failed/cancelled, exclu du verrouillage terminal de
-- confirm_payment_attempt, exclu de payment_transactions_one_active_
-- per_order) et DOIT démontrer, par des tests de concurrence réels,
-- qu'un callback 'paid' authentique et tardif sur une tentative
-- supersédée reste réconciliable en toute sécurité (y compris le cas
-- où LA NOUVELLE tentative a, entretemps, elle-même déjà été payée --
-- double paiement -- auquel cas l'index unique payment_transactions_
-- one_paid_per_order doit continuer à faire échouer bruyamment la
-- transition plutôt que de la laisser silencieusement réussir). CE
-- LOT NE TENTE PAS CETTE CONCEPTION -- il se contente de la nommer et
-- de refuser explicitement toute solution partielle qui violerait
-- l'invariant contraignant du mandat.
--
-- POURQUOI CE PÉRIMÈTRE MINIMAL SUFFIT À FERMER LES 7 CONSTATS :
--
-- V2-01 (invalid contexte_commande) : déjà fermé par PAYMENT P3-B6
-- CHECKOUT BILLING CONTEXT v2 (validation stateOrProvince/phone câblée
-- dans billing-mapping.ts) -- non rouvert, non retesté ici (hors
-- périmètre SQL).
--
-- V2-02 (refusal -> later-paid lifecycle) : le document technique
-- Monetico v2.0 (page 25, §1.4.3, re-vérifié fraîchement) documente
-- explicitement qu'une MÊME référence peut légitimement recevoir
-- PLUSIEURS notifications dans le temps, y compris un ou plusieurs
-- refus SUIVIS d'un paiement accepté tardif. `confirm_payment_attempt`
-- (P1, inchangé) verrouille TERMINALEMENT paid/failed/cancelled -- si
-- la couche d'orchestration appelait `confirm_payment_attempt(...,
-- 'failed')` sur un simple refus, elle fermerait DÉFINITIVEMENT une
-- tentative qui doit rester capable de recevoir un paiement accepté
-- légitime et postérieur. DÉCISION (contraignante, INCHANGÉE depuis la
-- version précédente de ce fichier) : un refus classifié (code-retour
-- Annulation/Annulation_pf[2..4]) est ENREGISTRÉ de façon durable via
-- PAYMENT P3-B5 (`record_payment_provider_event`, `provider_event_type
-- = 'refused'`, inchangé) mais NE DÉCLENCHE JAMAIS `confirm_payment_
-- attempt('failed')` -- la tentative reste 'pending', capable
-- d'accepter un paiement accepté postérieur authentique. Ce constat se
-- ferme ENTIÈREMENT par une règle d'orchestration (jamais de SQL
-- nouveau) : aucune capacité SQL n'est nécessaire ni ajoutée pour lui.
--
-- V2-03 (callback durability before ACK) : déjà fermé par PAYMENT
-- P3-B5 DURABLE PROVIDER CALLBACK INBOX (enregistrement durable garanti
-- AVANT tout accusé de réception) -- non rouvert, non retesté au
-- niveau SQL ici (la couche orchestration applicative de ce lot, hors
-- périmètre du présent fichier, est responsable d'appeler
-- `record_payment_provider_event` avant `buildMoneticoAcknowledgement`).
--
-- V2-04 (missing/malformed amount must fail closed) : ce lot n'ajoute
-- AUCUNE logique de comparaison montant/devise en SQL -- cette
-- comparaison est effectuée par la couche orchestration applicative
-- (TypeScript, hors périmètre du présent fichier) via
-- `getPaymentTransactionCorrelation` (PAYMENT P3-B0, inchangé) comme
-- source d'autorité, AVANT tout appel à `confirm_payment_attempt`.
-- `payment_transactions.amount`/`.currency` restent, comme sous P1,
-- posés UNIQUEMENT par `initiate_payment_attempt` -- jamais recalculés
-- ici.
--
-- V2-05 (code-retour ambiguity, y compris "pf1") : question de
-- classification applicative pure -- répondue par un nouveau module
-- TypeScript séparé (hors périmètre du présent fichier SQL, voir
-- lib/server/payment-providers/monetico/code-retour.ts). Réponse
-- documentée dans ce module (re-vérification fraîche du document
-- v2.0) : AUCUNE variante "pf1" n'existe dans le document technique --
-- seules les variantes `_pf2`, `_pf3`, `_pf4` sont documentées ; un
-- code-retour "...pf1" (s'il était un jour observé) est classé
-- `unknown`, jamais `paid` ni `refused`, par posture fail-closed.
--
-- V2-06 (dual runtime-mode authority) : déjà fermé par PAYMENT P3-B4
-- PROVIDER RUNTIME MODE READ v1 (`get_payment_runtime_provider_
-- environment`, source UNIQUE d'autorité test/live par tenant) -- non
-- rouvert, non modifié ici. La couche orchestration de ce lot (hors
-- périmètre SQL) doit lire EXCLUSIVEMENT cette fonction pour le mode
-- -- jamais une variable d'environnement, un paramètre navigateur ou
-- une configuration dupliquée.
--
-- V2-07 (return URLs, browser-return-never-authoritative) : ce lot
-- fournit `get_order_payment_status_snapshot` (section 2) précisément
-- pour que les pages de retour navigateur (url_retour_ok/url_retour_err,
-- hors périmètre SQL) lisent l'état AUTORITAIRE serveur plutôt que de
-- faire confiance à un paramètre de requête/POST renvoyé par le
-- navigateur, qui n'a jamais aucune valeur probante (le navigateur peut
-- atteindre url_retour_ok même si le paiement a en réalité échoué, ou
-- ne jamais atteindre aucune des deux URLs alors que le paiement a
-- réussi -- documenté comme non fiable par nature dans le document
-- Monetico lui-même).
--
-- PRÉREQUIS (déjà publiés, INCHANGÉS et NON ROUVERTS par ce lot) :
-- PAYMENT P1 FOUNDATION (`payment_transactions`, `orders.payment_status`,
-- `orders.current_payment_transaction_id`, `orders.public_token`) et
-- PAYMENT P3-B5 DURABLE PROVIDER CALLBACK INBOX (`payment_provider_
-- events`, colonne générique `provider_event_type`, JAMAIS une
-- énumération fermée). Ce lot ÉTABLIT, au niveau de la seule couche
-- d'orchestration v3 (jamais au niveau de la table P3-B5 elle-même,
-- qui reste générique et INCHANGÉE), une convention de valeurs
-- `provider_event_type` -- `'paid'`, `'refused'`, `'pending'`,
-- `'unknown'` -- documentée ici pour que `get_order_payment_status_
-- snapshot` puisse en tirer un indicateur agrégé sans introduire de
-- contrainte CHECK nouvelle sur `payment_provider_events`. Ce lot ne
-- dépend PAS et n'appelle PAS `confirm_payment_attempt`/
-- `initiate_payment_attempt` -- aucune garde de signature sur ces deux
-- fonctions n'est donc nécessaire ici (à la différence de la version
-- précédente de ce fichier).
--
-- N'IMPLÉMENTE AUCUNE route HTTP, AUCUNE page de retour navigateur,
-- AUCUN appel réseau Monetico, AUCUNE UI marchande, AUCUNE saisie de
-- credential, AUCUNE activation Production, AUCUNE modification de
-- configuration tenant. Mini-lot SQL isolé, au même titre que les lots
-- P3-A0/P3-B0 à P3-B6 l'ont été.
--
-- MODÈLE DE POSSESSION (mandat, même patron que P3-B0/P3-B2/P3-B3) :
-- `orders.id = p_order_id` ET `orders.public_token = p_public_token`,
-- aucun fallback, aucune recherche par order_number. Toute paire
-- incorrecte produit un ensemble de résultats vide, jamais une
-- exception -- posture identique à P3-B0/P3-B2/P3-B3.
--
-- POURQUOI service_role SEUL : comme pour toutes les fonctions
-- soeurs, AUCUN grant de table nouveau n'est posé ici -- la fonction
-- est SECURITY DEFINER, `search_path` explicitement vide, AUCUNE
-- clause OWNER TO explicite. `service_role` ne reçoit et ne reçoit
-- JAMAIS de SELECT/INSERT/UPDATE direct sur `public.orders`,
-- `public.payment_transactions` ni `public.payment_provider_events`
-- (durcissements ORDERS SERVICE_ROLE SELECT HARDENING v1, PAY-P1-03
-- RPC-ONLY AUTHORITY et l'équivalent P3-B5, tous préservés sans
-- modification).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('id','public_token','payment_status','current_payment_transaction_id')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.orders -- prérequis PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_transactions'
      and column_name in ('id','order_id','provider_code')
    having count(*) = 3
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.payment_transactions -- prérequis PAYMENT P1 FOUNDATION manquant ou incomplet, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_provider_events'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_events introuvable -- prérequis PAYMENT P3-B5 DURABLE PROVIDER CALLBACK INBOX manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name in ('id','payment_transaction_id','provider_event_type','created_at')
    having count(*) = 4
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes attendues introuvables sur public.payment_provider_events -- prérequis PAYMENT P3-B5 manquant ou incomplet, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_order_payment_status_snapshot'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_order_payment_status_snapshot existe déjà -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 déjà appliqué, migration annulée (double application refusée).';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_order_payment_status_snapshot — LECTURE SERVEUR DE CONFIANCE
-- SEULE, possession-scoped, état AUTORITAIRE agrégé pour les pages de
-- retour navigateur (url_retour_ok/url_retour_err, ferme V2-07 côté
-- "browser return never authoritative" : ces pages doivent lire CETTE
-- fonction plutôt que de faire confiance à un paramètre de requête/POST
-- renvoyé par le navigateur).
-- ------------------------------------------------------------
create or replace function public.get_order_payment_status_snapshot(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  payment_status text,
  provider_code text,
  has_observed_refusal boolean,
  last_refusal_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.payment_status,
    t.provider_code,
    coalesce(bool_or(e.provider_event_type = 'refused'), false) as has_observed_refusal,
    max(e.created_at) filter (where e.provider_event_type = 'refused') as last_refusal_at
  from public.orders o
  left join public.payment_transactions t
    on t.id = o.current_payment_transaction_id
   and t.order_id = o.id
  left join public.payment_provider_events e
    on e.payment_transaction_id = t.id
  where o.id = p_order_id
    and o.public_token = p_public_token
  group by o.payment_status, t.provider_code;
$$;

comment on function public.get_order_payment_status_snapshot(uuid, uuid) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3. Lecture serveur de confiance SEULE, possession-scoped (orders.id + orders.public_token, même patron que get_order_payment_context/get_order_active_payment_attempt), de l''état de paiement AUTORITAIRE d''une commande -- ferme V2-07 (les pages de retour navigateur url_retour_ok/url_retour_err DOIVENT lire cette fonction, JAMAIS un paramètre de requête/POST renvoyé par le navigateur, qui n''a aucune valeur probante). payment_status provient EXCLUSIVEMENT de orders.payment_status (P1, inchangé). has_observed_refusal/last_refusal_at agrègent public.payment_provider_events (P3-B5, INCHANGÉ, colonne provider_event_type générique) filtré sur la convention provider_event_type=''refused'' ÉTABLIE PAR LA SEULE couche d''orchestration v3 (documentée en tête de ce fichier) -- ne modifie ni ne contraint la colonne P3-B5 elle-même, et n''appelle JAMAIS confirm_payment_attempt/initiate_payment_attempt (P1, totalement hors du chemin de cette fonction). Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL) produit un ensemble de résultats vide, identique dans tous les cas -- aucune fuite d''information observable. Une commande sans tentative de paiement jamais initiée retourne quand même une ligne (payment_status courant, provider_code NULL, has_observed_refusal=false) via LEFT JOIN. Ne retourne jamais transaction_id, provider_reference, amount, currency, donnée client, credential. Aucune écriture, aucun verrou -- lecture pure et strictement additive, aucune capacité de mutation n''est ajoutée par ce lot (voir OPEN GAP en tête de fichier pour la limite explicite qui en résulte).';

revoke all on function public.get_order_payment_status_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_payment_status_snapshot(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 3. NON-RÉGRESSION EXPLICITE — ce lot n'altère AUCUN privilège de
-- table existant, ni AUCUNE fonction existante (initiate_payment_attempt,
-- confirm_payment_attempt, get_payment_provider_credential,
-- get_payment_transaction_correlation, get_payment_runtime_provider_
-- environment, get_order_payment_context, get_order_active_payment_
-- attempt, set_order_billing_context, record_payment_provider_event,
-- claim_payment_provider_events, update_payment_provider_event_
-- processing_status restent tous INCHANGÉS). AUCUN grant de table
-- nouveau n'est ajouté par ce lot, pour quelque rôle que ce soit, y
-- compris service_role -- la fonction ci-dessus reste la SEULE
-- autorité nouvelle de ce lot.
-- ------------------------------------------------------------

commit;
