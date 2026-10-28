# ISSUE #171 — Commandes non payées non opérationnelles au back-office — rapport d'implémentation

Base : `main` `6b996f4` · Branche : `fix/issue-171-unpaid-orders-not-operational` · Consigne : commentaire CIO du 28/10/2026 sur l'issue #171 (version amendée : six états, liste noire, audit).
Statut : **candidat R2 pour ré-audit indépendant** (remédiation de l'audit FAIL de la PR #179, commentaire 6475706399 : AUD179-01..04). Aucun merge, aucun déploiement, aucun SQL hébergé, aucune donnée Production touchée.

> **Ce lot ne ferme PAS le problème global « commandes en ligne non payées non opérationnelles ».** Le P1 AUD179-03 (fenêtre préexistante entre `create_order` et `require_order_payment`) reste **OUVERT** et est suivi par l'issue **#182**. Voir §8.

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
| `app/dashboard/page.tsx` | (AUD179-01) la détection de « nouvelles commandes » (sonnerie) et la mémoire `knownOrderIds` ne retiennent que les commandes opérationnelles, y compris en Historique : une commande non payée ne sonne plus, et sonne une fois quand elle devient `paid` |
| `lib/i18n.ts` | `dsPaymentAwaiting`, `dsPaymentFailed` (FR/EN/AR) |
| `supabase/DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql` (+ rollback) | `get_operator_restaurant_orders_page` : même signature, **mêmes dix champs**, filtre opérationnel ajouté (historique inchangé) ; `update_order_status` : corps V29 reproduit à l'identique + garde liste noire `42501 ORDER_PAYMENT_NOT_OPERATIONAL` ; gardes de schéma, refus de double application, post-contrôles grants/sécurité. (AUD179-04) **un seul bloc transactionnel** `begin; … commit;` précédé d'un **pré-contrôle** (attributs de sécurité et ACL des deux fonctions) exécuté avant tout remplacement. Le rollback a la même structure et restaure les deux corps antérieurs à l'identique |

Tests existants ajustés (délibérément, chacun pour une raison vérifiée) :
- `tests/delivery-pricing-v2-b1-order-snapshot-v1-structural.test.ts` B1-T-22 : empreinte SHA-256 de la liste de colonnes de `getDashboardOrders` mise à jour pour l'ajout unique de `payment_status` (ancienne empreinte conservée en commentaire) ;
- `tests/invoice-backoffice-visibility-v1-query.test.ts` 16 : le double de test du query builder reçoit une méthode `in()` (le filtre opérationnel l'appelle).
Le texte du badge n'utilise pas « — », réservé par `backoffice-ticket-invalid-timestamp-ui-fallback` au repli de durée (constaté au premier passage de la suite complète).

**Non touché** : machine à états paiement (`initiate/confirm_payment_attempt`, inbox Monetico, callback, processeur), `create_order`, `payment_transactions`, RLS, grants, scheduling CSDJ, simulateur.

Compteurs : il n'existe pas de compteur numérique distinct dans le back-office ; le seul « compteur » est la détection de nouvelles commandes `status = new` (sonnerie) dans `app/dashboard/page.tsx`. Correction R2 (AUD179-01) : en vue Historique la liste contient volontairement toutes les commandes, la détection ne pouvait donc plus s'appuyer sur le seul filtrage de requête ; elle applique maintenant la même règle `isOrderPaymentOperational`. Testé avec comptage réel des démarrages audio (rouge sur `426ee62`, vert après correction).

## 4. Point 2 de la consigne — outbox `ORDER_RECEIVED` : conclusion de l'investigation (corrigée après audit)

Constat factuel, différent de l'hypothèse de l'issue :
1. **Aucune notification commerçant n'existe dans Scanym.** `ORDER_RECEIVED` est adressé au **client** (`recipient_email = orders.customer_email`, lot N1-A), pas au commerçant.
2. **Mécanisme actuel exact** (correction de la première version de ce rapport, qui parlait d'une ligne « enfilée dans `create_order` ») : la migration `migration-20260919000000-order-success-boundary-v1.sql` a remplacé l'enfilement synchrone par une **intention durable** posée sur la ligne `orders` (`order_received_notification_intent_at`, trigger `orders_record_order_received_intent_trg`), puis une **récupération** tenant-scoped dans une transaction distincte (`recover_missing_order_received_notifications` → `create_order_received_notification`). Ni l'intention, ni la récupération, ni le claim ne regardent `payment_status`.
3. **Aucun e-mail n'est envoyé aujourd'hui** : `resolveTransactionalEmailProvider()` renvoie `null` dans tous les cas (même porte activée), et aucun worker de notification n'est déclenché (aucune route, aucun cron — `vercel.json` ne planifie que le recover Monetico).
4. Le texte « Le commerçant en a été informé » **n'existe pas dans le dépôt** (aucune chaîne i18n ni page de retour). **Hypothèse non reproduite** : il provient de la page hébergée Monetico, comme « Code retour : Annulation CGI2: OK ». Elle n'a pas été vérifiée face à un vrai écran Monetico (aucun paiement réel autorisé).

Plus petit changement sûr dans ce lot : **aucun**. Il n'y a ni notification commerçant à retarder, ni envoi réel.

**Risque futur identifié, à lever AVANT toute activation de l'envoi réel** : parce que l'intention est posée à l'insertion et que la récupération/le claim n'ont aucune garde paiement, le client recevrait « commande reçue » avant confirmation du paiement (ou pour un paiement refusé/annulé). Proposition pour ce futur lot (**non implémentée ici**, elle toucherait le SQL N1-A et le worker d'un autre stream) : au claim ET à la récupération, ignorer/différer une ligne `order_received` dont la commande a `payment_status ∈ {required, pending, failed, cancelled}`, et la rendre éligible à `paid`/`not_required`. À arbitrer avec l'activation du fournisseur d'e-mail.

## 5. Tests

| Fichier | Contenu | Résultat |
|---|---|---|
| `tests/issue-171-unpaid-orders-sql.test.ts` | **PostgreSQL réel (PGlite)**, harnais PAGINATION v1 existant + `update_order_status` V29 réel + lot appliqué : application / double application refusée / rollback qui restaure ; (AUD179-04) **3 tests d'atomicité** : reproduction de l'auditeur (grant révoqué, lot rejoué instruction par instruction en autocommit → refus par le pré-contrôle, rien modifié, rejeu après correction du grant réussi), échec forcé juste avant `COMMIT` dans les deux modes (requête unique et instruction par instruction), rollback lui-même atomique ; vue opérateur opérationnelle = `not_required`+`paid` seulement, historique = 6, projection dix champs inchangée, isolation tenant ; garde : 2 états acceptés, 4 refusés (accepter ET refuser), statut inchangé, règles V29 intactes (tenant étranger, transition invalide, anon) ; marchand sans paiement en ligne : cycle complet new→completed | 7/7 |
| `tests/issue-171-unpaid-orders-operability.test.ts` | règle pure (6 états + valeurs inconnues), forme exacte de la requête PostgREST (opérationnel vs historique), périmètre du lot (deux RPC seulement, aucune fonction paiement, liste noire, projection) | 3/3 |
| `tests/issue-171-unpaid-orders-backoffice.dom.test.ts` | **vrai `OrderCard` et vraie page dashboard** : 6 états (actions vs badge), ligne sans `payment_status` non actionnable, `paid` en `accepted` garde ses transitions ; liste opérationnelle (seulement #not_required et #paid) ; historique : 6 cartes, 4 badgées sans action, clic Accepter sur `paid` transmis ; marchand sans paiement en ligne inchangé ; temps réel : `pending` reste invisible, passage à `paid` → apparaît **une seule fois**, rafraîchissement rejoué → pas de doublon ; (AUD179-01) **3 tests d'alerte sonore** avec comptage réel des démarrages audio : reproduction de l'auditeur (aucune sonnerie quand une ligne `pending` arrive en Historique), une seule sonnerie au passage `paid` en Historique, et non-régression en vue opérationnelle (un `pending` ne sonne jamais, un `paid` ou `not_required` sonne) | 15/15 |

Le rejeu de notification Monetico (point 4 de la consigne) est déjà couvert côté paiement par les suites existantes (dédup par fingerprint, verrou terminal) ; ce lot couvre son effet côté back-office (apparition unique).

Preuve rouge→vert (R2) : 2 des 3 tests AUD179-01 (reproduction de l'auditeur et « une seule sonnerie en Historique ») échouent sur `426ee62` (log `aud01-on-426ee62.log`, tests 13 et 14) ; le 3e, en vue opérationnelle, est un test de non-régression qui passait déjà et doit continuer à passer ; les 3 tests AUD179-04 échouent sur `426ee62` (log `aud04-on-426ee62.log`) et passent sur le candidat.

Commandes, résultats TypeScript / build / suite complète et comparaison par identité d'échec : voir le message de livraison et la description de la PR #179 (le rapport est figé dans le dépôt avec le commit testé, les résultats d'exécution n'y sont donc pas recopiés).

## 6. Remédiation de l'audit FAIL de la PR #179 (R2)

| Constat | Sévérité | Décision CIO | Traitement |
|---|---|---|---|
| AUD179-01 — sonnerie déclenchée en Historique par une commande non opérationnelle | P2 | corriger dans #179 | **Corrigé** : `app/dashboard/page.tsx` applique `isOrderPaymentOperational` à la détection et à `knownOrderIds` ; 3 tests DOM avec comptage audio, 2 rouges sur `426ee62` |
| AUD179-02 — l'historique opérateur ne distingue pas les paiements bloquants | P2 | **écart accepté, documenté** | **Non modifié.** L'historique opérateur garde le contrat des **dix champs approuvés** : il expose `status` (une commande bloquée y apparaît `new`) sans information de paiement. La liste opérateur est en **lecture seule** (`OperatorOrderList` : aucun bouton, aucune sonnerie, aucun repli sur `getDashboardOrders`), et `update_order_status` refuse de toute façon l'action côté serveur. Exposer `payment_status` à l'opérateur demanderait de rouvrir le contrat de projection, hors périmètre ; à reprendre si le CIO le demande |
| AUD179-03 — fenêtre `create_order` → `require_order_payment` | **P1** | **borner #179, lot dédié** | **NON corrigé, explicitement ouvert** : issue **#182**. #179 ne ferme pas cette race et ne doit pas être présenté comme la fermant (§8) |
| AUD179-04 — lot SQL non atomique, reprise refusée après application partielle | P2 | corriger dans #179 | **Corrigé** : `begin; … commit;` + pré-contrôle avant remplacement, même structure pour le rollback ; 3 tests PGlite dont la reproduction de l'auditeur (rouges sur `426ee62`) |

Rapport d'audit, point annexe « parité de suite complète » : l'affirmation de la première livraison (« 15 échecs identiques, zéro nouveau ») n'était vraie que sur la machine Linux de l'auteur. L'auditeur a mesuré sous Windows 22 échecs candidat contre 21 base (20 communs, 2 propres au candidat). La parité n'est donc **plus revendiquée** ; la méthode de la R2 est : comparaison par identité d'échec, puis rejeu répété de chaque échec propre au candidat sur la base et sur le candidat. Résultats : voir la description de la PR #179 et le commentaire de livraison R2.

## 7. Déploiement — ordre et conditions (pour après audit PASS + GO)

1. **SQL d'abord** (hébergé, GO distinct requis) : appliquer `DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql` en Production. Prérequis vérifiés par le lot lui-même : `orders.payment_status` (P1), `update_order_status` (V29), `get_operator_restaurant_orders_page` (PAGINATION v1). La garde serveur est l'autorité : sans elle, un client existant ou un appel direct à la RPC peut encore accepter une commande non payée.
2. **Puis le front** (Vercel). L'ordre inverse est sans danger fonctionnel (le filtre client n'utilise que la colonne `payment_status` existante) mais laisse la fenêtre serveur ouverte.
3. Rollback : `…-rollback.sql` (restaure les deux corps antérieurs) + revert du commit front.

## 8. Limites

- La lecture RLS marchand de `orders` n'est pas restreinte : un appel PostgREST direct d'un membre du restaurant voit encore les commandes non payées (comme avant). La protection serveur porte sur **l'action** (`update_order_status`), le filtrage de **liste** est côté requête client — choix délibéré pour ne pas toucher aux RLS (audit/historique).
- **P1 ouvert — AUD179-03 (issue #182).** Entre `create_order` (`not_required`) et `require_order_payment` (appel HTTP distinct), une commande en ligne à total > 0 est visible et actionnable. Si elle est acceptée dans cet intervalle, `require_order_payment` refuse (statut ≠ `new`), le runtime répond `checkout_not_needed` et le paiement est évité. Cette fenêtre est **préexistante** (câblage P4-A) et **non fermée par #179** ; la garde ajoutée la laisse passer, conformément à son prédicat littéral. Sa fermeture suppose de figer l'obligation de paiement côté serveur à la création, ce qui impose d'abord de trancher le sort du kill switch `PAYMENT_CHECKOUT_RUNTIME_ENABLED`, variable d'environnement invisible de la base. Atteignabilité en Production non établie depuis le dépôt.
- **Écart accepté — AUD179-02.** Voir §6 : l'historique opérateur n'expose pas le paiement.
- **Risque futur — e-mail `ORDER_RECEIVED`.** Voir §4 : aucune garde paiement à l'intention, à la récupération ni au claim ; à traiter avant toute activation d'un envoi réel.
- Décision métier ouverte (non tranchée, conformément à la consigne) : commandes `pending` longtemps (abandon) — invisibles partout aujourd'hui sauf dans l'historique avec badge ; aucune expiration inventée.
- Lint : le dépôt n'a pas de configuration ESLint (`next lint` lance l'assistant interactif) — non exécutable de façon significative.
