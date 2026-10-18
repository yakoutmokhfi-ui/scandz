# CSDJ-2 — Checkout : date et créneau de retrait (issue #158)

Auteur : Boulez (Claude). Branche `fix/csdj2-checkout-pickup-schedule-158`, partie de `main` `f852988`.
Statut : **PR brouillon, en attente de revue indépendante**. Rien n'est fusionné, déployé ni activé.

## 1. Symptôme et cause

Production (Au Lait Cru, 15 oct.) : 4 × HTTP 400 `P0001 SCANYM_SCHEDULE_REQUIRED` sur `create_order`.
Pour un retrait en `customer_selectable / fixed_slots`, `create_order` exige une date et un créneau dans
`p_customer.schedule`. `buildCreateOrderPayload()` (`lib/services/order-payload.ts`) n'envoyait aucun
`schedule`, et le checkout ne proposait ni date ni créneau : la commande ne pouvait pas aboutir.

## 2. Contrat utilisé (non déduit)

Source : `docs/scheduling/csdj-v1.2-interface-contract.md` (branche de la PR #146), §4.1 (lecteur public),
§5.1 (format), §10 (erreurs typées).

- Lecture : `get_checkout_fulfillment_schedule(p_restaurant_id, p_mode_code, p_postal_code, p_total_count, p_subtotal)`.
  Elle n'accepte **aucune heure** de l'appelant ; « maintenant » est l'horloge du serveur dans le fuseau du commerçant.
- Écriture : `p_customer.schedule = { "date": "YYYY-MM-DD", "slot_key": null|"…", "starts_at": null|"HH:MM", "ends_at": null|"HH:MM" }`,
  heure murale du commerçant, **jamais en mode table**.
- Erreurs : `P0001` dont le message est exactement `SCANYM_SCHEDULE_{REQUIRED,MALFORMED,UNFULFILLABLE,NOT_SELECTABLE,DATE_NOT_ELIGIBLE,SLOT_INVALID,TIME_INVALID,SLOT_FULL,NOT_OFFERED}`.

## 3. Ce qui change (client uniquement, aucun SQL)

| Fichier | Rôle |
|---|---|
| `lib/checkout-schedule/model.ts` | Modèle pur : exigence serveur → sélection → payload. Ne calcule aucune éligibilité. |
| `lib/checkout-schedule/map-row.ts`, `lib/services/checkout-schedule.ts` | Lecture publique et mapping (statut absent ⇒ `absent`). |
| `lib/checkout-schedule/use-checkout-schedule.ts` | État idle / loading / ready / error ; une réponse en retard est ignorée. |
| `lib/checkout-schedule/messages.ts` | Clés de texte (indication, message de relecture). |
| `components/CheckoutSchedulePicker.tsx` | Sélecteur date / créneau / heure, limité aux offres du serveur. |
| `components/MenuView.tsx`, `components/CartPanel.tsx` | Branchement ; `schedule` transmis à `createOrder` ; relecture sur refus typé ; verrou anti double envoi. |
| `lib/services/order-payload.ts`, `orders.ts`, `order-error.ts` | `p_customer.schedule`, erreurs typées `ScheduleSelectionError`. |
| `lib/i18n.ts` | 16 clés `chkSchedule*` en FR / EN / NL / AR. |

## 4. Comportement par politique

| Réponse du serveur | Écran | Payload |
|---|---|---|
| `dates_available` + `customer_selectable` + `fixed_slots` | date puis créneau, parmi les offres | `{date, slot_key, starts_at, ends_at}` du créneau |
| idem + `slot none` | date seule | `{date, null, null, null}` |
| idem + `time_within_window` | date puis heure (grille = fenêtre serveur au pas du commerçant) | `{date, null, heure choisie, fin de fenêtre}` |
| `derived_earliest` | date prévue affichée, rien à choisir | `{date serveur, null, null, null}` |
| `absent` / `informational_only` / `blocked_upstream` | **rien** (parcours d'avant) | aucune clé `schedule` |
| `unfulfillable` | message clair, envoi fermé (jamais de date inventée) | — |
| statut ou politique inconnus, réponse incohérente | message, envoi fermé (fail-closed) | — |
| lecture en échec, réponse vide / nulle / sans `schedule_status` / au statut hors catalogue / à plusieurs lignes *(corrigé au commit enfant, §10)* | message + « Réessayer » ; **envoi fermé, aucun `create_order`** | — |
| mode table | aucune lecture, aucun schedule | `p_customer = {}` |

Date expirée, créneau retiré ou plein, politique changée (`SCANYM_SCHEDULE_*`) : la sélection est vidée, les
disponibilités sont **relues**, un message générique est affiché (aucun motif ni capacité), le panier est conservé.
Aucun code technique n'est montré au client.

## 5. Preuves (dossier `evidence-158/`)

| Preuve | Résultat |
|---|---|
| RED sur `main` `f852988` — `red-main-dom.tap` | 12 / 13 en échec. `[158-D0]` reproduit la Production : *« create_order appelé SANS p_customer.schedule alors que le serveur l'exige (SCANYM_SCHEDULE_REQUIRED, HTTP 400 en Production) »*. Le seul test vert, `[158-D5]`, est la non-régression « sans calendrier », identique sur `main`. |
| GREEN sur la branche — `green-dom.tap`, `green-pure.tap` | 13 / 13 (MenuView monté, `create_order` simulé qui applique la règle de Production) et 16 / 16 (logique pure). |
| `tsc --noEmit` | sans erreur |
| `next build` (variables factices) — `next-build-tail.txt` | exit 0 |
| Suite complète — `full-suite-comparison.txt` | `main` : 5731 tests, 14 échecs. Branche : 5760 tests, **les mêmes 14 échecs** (comparaison par nom), 0 nouveau. |

Les 14 échecs de `main` préexistent (garde-fous OB-1 « git diff depuis la baseline », `[SW-01]`, `[BL-1]`, `[CB-02]`,
archi P3-A1/A2, etc.) et ne touchent pas ce lot.

Scénarios couverts par `tests/csdj2-checkout-schedule-158.dom.test.ts` : D0 repro, D1 `fixed_slots`, D2 date seule,
D3 `time_within_window`, D4 `derived_earliest`, D5 sans calendrier / information seule / amont, D6 `unfulfillable`,
D7 lecture en échec puis `REQUIRED`, D8 sélection expirée puis nouveau choix, D9 double clic, D10 livraison
(avec et sans calendrier), D11 EN / NL / AR et critères mobile, D12 réponse illisible.

## 6. Points à relire en priorité

1. **`components/CartPanel.tsx` est épinglé par SHA** (`tests/delivery-engine-unchanged-v1.test.ts`). Le diff de CartPanel est de 15 lignes (deux props optionnelles, une indication, un emplacement) ; l'épingle est mise à jour dans son **propre commit** (`282af7a`), comme le test le demande. Aucune ligne du moteur de tarifs ni de l'éligibilité n'est touchée.
2. **Tests existants adaptés** (commit `a44b9f4`) : la lecture publique `get_checkout_fulfillment_schedule` est déclarée dans les mocks / listes de RPC autorisées de `v148`, `v149`, `v171b`, `cclt-v1-whatsapp-journey` — même patron que `get_restaurant_public_communication_texts`. `create_order`, Stuart et paiement restent interdits dans ces traces. `[SW-04]` : le périmètre des clés NL (mesuré sur les sources) inclut le sélecteur ; une traduction NL générale échoue toujours.
3. **Livraison** : le même mécanisme s'applique à la livraison dès qu'un code postal valide désigne la règle **et** que le serveur renvoie un calendrier. Sans calendrier, rien ne change (test D10). À confirmer par Noether / DIRAC si la livraison doit rester hors de ce lot.
4. ~~Fail-open sur lecture en échec~~ **corrigé au commit enfant (§10)** : un état du calendrier inconnu ferme l'envoi.
5. **Verrou anti double envoi** (`submitInFlightRef`) : sur `main`, deux clics dans le même instant créaient deux commandes (`[158-D9]` rouge sur `main`). Le garde existant lisait l'état React, visible seulement au rendu suivant.
6. **`time_within_window`** : `ends_at` envoyé = fin de fenêtre rendue par le serveur ; `starts_at` = heure choisie. Conforme à §5.1 tel que lu ; à confirmer à la revue.

## 7. Limites de l'environnement (ce qui n'est PAS prouvé)

- **Le bloc `schedule` de `create_order` en Production n'est dans aucun SQL ni TypeScript du dépôt** (192 références cherchées). Le format réel de Production **n'a pas pu être vérifié** (aucun accès hébergé, interdit par le mandat). Le format implémenté est celui du contrat CSDJ v1.2 §5.1 ; si Production diffère, l'écart est dans `toSchedulePayload()` seul.
- Le contrat indique qu'un constructeur de payload CSDJ-2 existe ; **aucun code de ce type n'existe dans aucune branche** : il a donc été écrit ici.
- Le test « simule une transaction sur base jetable » n'est pas disponible : `create_order` est **simulé** (règle de Production reproduite côté test). Preview authentifié et transaction réelle : **INCONCLUSIFS**.
- Aucun achat, paiement, transporteur ni message réel ; aucune donnée marchand modifiée ; aucun SQL hébergé.
- Non touchés : #155 (affichage — à vérifier séparément), CGV MIXED v8, textes Chronofresh / Stuart. Le message « lait cru » n'est pas modifié.

## 8. Retour arrière

Changement 100 % client, sans SQL ni donnée : `git revert 4acb4b3 282af7a a44b9f4` (ou revert de la fusion de la PR). Les
commerçants sans calendrier ne voient aucune différence avant ou après.

## 9. Suite

L'activation du retrait en Production et le déploiement relèvent d'un **GO CIO distinct** ; rien n'est activé par cette PR.

## 10. Remédiation de l'audit de la PR #160 (commit enfant)

**Finding — fail-open.** `mapCheckoutScheduleRow` transformait une réponse vide ou sans statut en `absent`, et une lecture en
échec laissait l'envoi ouvert : dans ces cas `create_order` partait **sans `schedule`**, c'est-à-dire exactement le défaut de
l'issue. Or le lecteur rend toujours **une seule ligne** dont `schedule_status` appartient à un catalogue fermé de 5 valeurs
(`absent` y est explicite, `checkout_schedule_statuses()`), donc « vide / sans statut / statut inconnu » n'est pas « pas de
calendrier » : c'est un état **inconnu**.

**Correctif.**
- `lib/checkout-schedule/map-row.ts` : toute réponse qui n'est pas exactement une ligne au statut du catalogue devient
  `invalid` (jamais `absent`) ; le modèle la classe `unreadable` ; `scheduleAllowsSubmit(null, …)` passe de `true` à `false`.
- `components/MenuView.tsx` : `scheduleOk` n'est vrai que pour `idle` (table, ou livraison sans code postal valide) ou
  `ready` + exigence satisfaite. `loading`, `error`, `invalid` ⇒ envoi fermé (bouton absent, garde défensive dans
  `handleSendOrder`), message, « Réessayer », panier intact, aucun `create_order`, aucune ouverture WhatsApp.
- Le cas légitime reste intact : `absent` **explicite** ⇒ parcours d'avant, rien envoyé.

**RED / GREEN** (`tests/csdj2-checkout-schedule-158-r1.dom.test.ts`, 8 variantes de réponse × retrait, + livraison) :
RED sur le commit parent `88277b9` (`evidence-158-r1/red-parent-88277b9.tap`) : `[158-R1-0]` « tableau vide: create_order envoyé
SANS p_customer.schedule alors que l'état du calendrier est INCONNU (fail-open) » ; `[158-R1-A]` et `[158-R1-D]` : pas de
« Réessayer ». GREEN sur le commit enfant (`evidence-158-r1/green-*.tap`). Variantes : tableau vide, `data` null, ligne `{}`,
ligne sans statut, statut inconnu, statut non textuel, deux lignes, lecture en échec ; puis réponse valide ⇒ choix ⇒ commande
avec `schedule`. États couverts : absent (`[158-R1-B]`), invalides, disponibles (`[158-R1-C]`) ; unitaires `[158-15b]`, `[158-15c]`.

**Conséquence assumée — tests existants.** Un `get_checkout_fulfillment_schedule` non servi ferme maintenant l'envoi. Onze
fichiers de tests DOM dont le mock `supabase.rpc` levait sur toute RPC inconnue (et que le fail-open masquait) servent
désormais la lecture « absent » : même patron de configuration que `get_restaurant_public_communication_texts`, aucune
assertion modifiée. Le test `[158-D7]` (qui affirmait « lecture en échec ⇒ envoi possible ») est réécrit : le refus typé
`REQUIRED` est maintenant testé quand le lecteur disait « absent » puis que le calendrier a été configuré entre-temps.

**Point résiduel.** Si le lecteur répond `absent` alors que `create_order` exige une date (configuration changée entre la
lecture et l'envoi), l'écran relit et affiche le message ; le cas est couvert par `[158-D7]`. Un désaccord **permanent** entre
le lecteur et `create_order` (ce que le P1 doit exclure) afficherait ce message sans proposer de choix.

**P1 — format Production de `create_order`.** Non déduit : procédure lecture seule + validation sur base jetable dans
`docs/scheduling/csdj2-create-order-production-verification-158.md`. Constat nouveau à lever : le contrat v1.2 (§12.3) rapporte
que le `md5(prosrc)` de `create_order` en Production égalait la tête du dépôt, qui **ne contient aucun bloc `schedule`**, alors
que l'incident rapporte `SCANYM_SCHEDULE_REQUIRED`. Les requêtes de la procédure ont été vérifiées **syntaxiquement et à
l'exécution sur une instance PGlite locale** (`evidence-158-r1/pglite-doc-queries.txt`), **jamais sur une base hébergée**.
Le P1 reste **INCONCLUSIF** tant que les sorties Production (A1–A6) et la matrice M1–M12 ne sont pas jointes.
