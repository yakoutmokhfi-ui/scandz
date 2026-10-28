# ISSUE #171 — Commandes non payées non opérationnelles au back-office — rapport d'implémentation

Base : `main` `6b996f4` · Branche : `fix/issue-171-unpaid-orders-not-operational` · Consigne : commentaire CIO du 28/10/2026 sur l'issue #171 (version amendée : six états, liste noire, audit).
Statut : **candidat pour audit indépendant**. Aucun merge, aucun déploiement, aucun SQL hébergé, aucune donnée Production touchée.

## 1. Cause racine (vérifiée sur `6b996f4`)

La commande est créée **avant** le paiement : `create_order` → `status = new`, `payment_status = not_required` ; `require_order_payment` (P4-A) → `required` ; `initiate_payment_attempt` → `pending`. Un refus Monetico (`Annulation`) laisse **volontairement** la tentative `pending` (nouvelle tentative possible, règle dure v3 inchangée).

Or les trois surfaces back-office ne regardaient que `orders.status`, jamais `orders.payment_status` :
- lecture marchand `getDashboardOrders` (`lib/services/dashboard.ts`) : filtre `status not in (completed, rejected, cancelled)` seul ;
- lecture opérateur `get_operator_restaurant_orders_page` : même filtre seul ;
- mutation `update_order_status` (V29) : aucune vérification du paiement.

D'où une commande refusée affichée « Nouvelle » avec Accepter / Refuser / Annuler.

## 2. Règle appliquée

| `payment_status` | Liste opérationnelle | Actions (UI) | `update_order_status` (serveur) | Historique |
|---|---|---|---|---|
| `not_required` | oui | oui | autorisé | oui |
| `paid` | oui | oui | autorisé | oui |
| `required` | **non** | **aucune** + badge « Paiement non confirmé » | **refusé** 42501 | oui |
| `pending` | **non** | **aucune** + badge | **refusé** 42501 | oui |
| `failed` | **non** | **aucune** + badge « refusé ou annulé — conservée pour audit » | **refusé** 42501 | oui (audit) |
| `cancelled` | **non** | **aucune** + badge | **refusé** 42501 | oui (audit) |
| absent / inconnu | non | aucune (fail-closed) | refusé | — |

La garde serveur est une **liste noire** (`not in ('not_required','paid')` refuse), jamais « `paid` uniquement » : les marchands sans paiement en ligne (toutes commandes `not_required`) ne sont pas affectés — testé explicitement.

## 3. Changements (diff minimal)

| Fichier | Changement |
|---|---|
| `lib/order-payment-operability.ts` (nouveau) | règle pure unique : `isOrderPaymentOperational`, `orderPaymentBadge`, listes des six états |
| `lib/services/dashboard.ts` | `select` inclut `payment_status` ; vue opérationnelle ajoute `payment_status=in.(not_required,paid)` ; historique inchangé (tout) ; lecture opérateur **inchangée côté TS** (dix champs — le filtre est dans la RPC) |
| `lib/dashboard-types.ts` | `payment_status?` sur `DashboardOrder` (pas sur `OperatorOrderSummary` : projection opérateur figée à dix champs) |
| `components/dashboard/OrderCard.tsx` | actions rendues uniquement si opérationnel ; badge explicatif sinon ; impression conservée (pas une transition) |
| `lib/i18n.ts` | `dsPaymentAwaiting`, `dsPaymentFailed` (FR/EN/AR) |
| `supabase/DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql` (+ rollback) | `get_operator_restaurant_orders_page` : même signature, **mêmes dix champs**, filtre opérationnel ajouté (historique inchangé) ; `update_order_status` : corps V29 reproduit à l'identique + garde liste noire `42501 ORDER_PAYMENT_NOT_OPERATIONAL` ; gardes de schéma, refus de double application, post-contrôles grants/sécurité. Le rollback restaure les deux corps antérieurs à l'identique |

Tests existants ajustés (délibérément, chacun pour une raison vérifiée) :
- `tests/delivery-pricing-v2-b1-order-snapshot-v1-structural.test.ts` B1-T-22 : empreinte SHA-256 de la liste de colonnes de `getDashboardOrders` mise à jour pour l'ajout unique de `payment_status` (ancienne empreinte conservée en commentaire) ;
- `tests/invoice-backoffice-visibility-v1-query.test.ts` 16 : le double de test du query builder reçoit une méthode `in()` (le filtre opérationnel l'appelle).
Le texte du badge n'utilise pas « — », réservé par `backoffice-ticket-invalid-timestamp-ui-fallback` au repli de durée (constaté au premier passage de la suite complète).

**Non touché** : machine à états paiement (`initiate/confirm_payment_attempt`, inbox Monetico, callback, processeur), `create_order`, `payment_transactions`, RLS, grants, scheduling CSDJ, simulateur.

Compteurs : il n'existe pas de compteur numérique distinct dans le back-office ; le seul « compteur » est la détection de nouvelles commandes `status = new` (sonnerie) dans `app/dashboard/page.tsx`, qui opère sur la liste déjà filtrée — une commande non payée ne déclenche donc plus la sonnerie. Testé (rafraîchissement temps réel).

## 4. Point 2 de la consigne — outbox `ORDER_RECEIVED` : conclusion de l'investigation

Constat factuel, différent de l'hypothèse de l'issue :
1. **Aucune notification commerçant n'existe dans Scanym.** `ORDER_RECEIVED` est adressé au **client** (`recipient_email = orders.customer_email`, lot N1-A), pas au commerçant.
2. **Aucun e-mail n'est envoyé aujourd'hui** : `resolveTransactionalEmailProvider()` renvoie `null` dans tous les cas (même porte activée), et aucun worker de notification n'est déclenché (aucune route, aucun cron — `vercel.json` ne planifie que le recover Monetico).
3. Le texte « Le commerçant en a été informé » **n'existe pas dans le dépôt** (aucune chaîne i18n ni page de retour) : il provient de la page hébergée Monetico, comme « Code retour : Annulation CGI2: OK ».

Plus petit changement sûr : **aucun dans ce lot**. Il n'y a ni notification commerçant à retarder, ni envoi réel. En revanche un **risque futur** est identifié et doit être levé **avant** toute activation de l'envoi réel : le client recevrait « commande reçue » avant confirmation du paiement (ligne enfilée dans `create_order`). Proposition pour ce futur lot (non implémentée ici, elle toucherait le worker et le SQL N1-A d'un autre stream) : au moment du claim par le worker, ignorer/différer une ligne `order_received` dont la commande a `payment_status ∈ {required, pending, failed, cancelled}`, et la rendre éligible à `paid`. À arbitrer.

## 5. Tests

| Fichier | Contenu | Résultat |
|---|---|---|
| `tests/issue-171-unpaid-orders-sql.test.ts` | **PostgreSQL réel (PGlite)**, harnais PAGINATION v1 existant + `update_order_status` V29 réel + lot appliqué : application / double application refusée / rollback qui restaure ; vue opérateur opérationnelle = `not_required`+`paid` seulement, historique = 6, projection dix champs inchangée, isolation tenant ; garde : 2 états acceptés, 4 refusés (accepter ET refuser), statut inchangé, règles V29 intactes (tenant étranger, transition invalide, anon) ; marchand sans paiement en ligne : cycle complet new→completed | 4/4 |
| `tests/issue-171-unpaid-orders-operability.test.ts` | règle pure (6 états + valeurs inconnues), forme exacte de la requête PostgREST (opérationnel vs historique), périmètre du lot (deux RPC seulement, aucune fonction paiement, liste noire, projection) | 3/3 |
| `tests/issue-171-unpaid-orders-backoffice.dom.test.ts` | **vrai `OrderCard` et vraie page dashboard** : 6 états (actions vs badge), ligne sans `payment_status` non actionnable, `paid` en `accepted` garde ses transitions ; liste opérationnelle (seulement #not_required et #paid) ; historique : 6 cartes, 4 badgées sans action, clic Accepter sur `paid` transmis ; marchand sans paiement en ligne inchangé ; temps réel : `pending` reste invisible, passage à `paid` → apparaît **une seule fois**, rafraîchissement rejoué → pas de doublon | 12/12 |

Le rejeu de notification Monetico (point 4 de la consigne) est déjà couvert côté paiement par les suites existantes (dédup par fingerprint, verrou terminal) ; ce lot couvre son effet côté back-office (apparition unique).

Commandes, résultats TypeScript / build / suite complète et comparaison par identité d'échec : voir §6 (rempli après exécution).

## 6. Résultats d'exécution

_(voir le message de livraison et `ISSUE-171-CANDIDATE.txt`)_

## 7. Déploiement — ordre et conditions (pour après audit PASS + GO)

1. **SQL d'abord** (hébergé, GO distinct requis) : appliquer `DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql` en Production. Prérequis vérifiés par le lot lui-même : `orders.payment_status` (P1), `update_order_status` (V29), `get_operator_restaurant_orders_page` (PAGINATION v1). La garde serveur est l'autorité : sans elle, un client existant ou un appel direct à la RPC peut encore accepter une commande non payée.
2. **Puis le front** (Vercel). L'ordre inverse est sans danger fonctionnel (le filtre client n'utilise que la colonne `payment_status` existante) mais laisse la fenêtre serveur ouverte.
3. Rollback : `…-rollback.sql` (restaure les deux corps antérieurs) + revert du commit front.

## 8. Limites

- La lecture RLS marchand de `orders` n'est pas restreinte : un appel PostgREST direct d'un membre du restaurant voit encore les commandes non payées (comme avant). La protection serveur porte sur **l'action** (`update_order_status`), le filtrage de **liste** est côté requête client — choix délibéré pour ne pas toucher aux RLS (audit/historique).
- Décision métier ouverte (non tranchée, conformément à la consigne) : commandes `pending` longtemps (abandon) — invisibles partout aujourd'hui sauf dans l'historique avec badge ; aucune expiration inventée.
- Lint : le dépôt n'a pas de configuration ESLint (`next lint` lance l'assistant interactif) — non exécutable de façon significative.
