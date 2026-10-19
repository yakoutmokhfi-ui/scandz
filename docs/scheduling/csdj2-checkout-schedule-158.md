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

## 11. Remédiation du contre-audit de la PR #160 (réponses calendrier incohérentes)

Parent audité : `f81bb606e5baf2d52fffbb3f01ddd3a63b201d10`. Le contre-audit confirme que le fail-open initial est corrigé ; quatre
réponses **incohérentes** restaient envoyables. Principe commun : une réponse qui ne se laisse pas lire **sans deviner** ferme l'envoi
(`unreadable` + raison), l'écran explique pourquoi et propose « Réessayer », le panier reste intact, aucun `create_order`, aucune ouverture
WhatsApp. Aucune disponibilité n'est inventée, rien n'est normalisé, rien n'est « corrigé » côté navigateur : le serveur reste l'autorité.

### 11.1 Les quatre cas

| # | Réponse incohérente | Avant (f81bb60) | Après | Raison affichée |
|---|---|---|---|---|
| 1 | Deux créneaux de même `slot_key` le même jour (ou deux dates identiques, ou deux fenêtres qui se chevauchent) | `toSchedulePayload` prenait le **premier** créneau qui correspondait à la clé : l'heure de début/fin envoyée pouvait différer de celle que le client voyait choisie | envoi fermé ; `isSelectionOffered` et `toSchedulePayload` exigent **exactement une** offre correspondante (défense en profondeur) | `ambiguous` |
| 2 | Date impossible (`2026-02-31`, `2026-04-31`, `2025-02-29`, `2026-13-01`, `2026-10-00`) | `isIsoDate` ne contrôlait que la forme : la date impossible partait telle quelle | `isIsoDate` vérifie mois (1–12), jour (1–nb de jours du mois), années bissextiles ; la valeur n'est **jamais** convertie en autre date. Vaut pour dates éligibles, clés d'offres, première date éligible et date dérivée | `date` |
| 3 | Intervalle dont la fin précède ou égale le début (`14:00`→`09:00`, `14:00`→`14:00`) | accepté (créneau fixe, fenêtre, date seule, dérivée) | refusé dans tous les modes ; un intervalle d'une minute reste valide | `interval` |
| 4 | Politique inconnue nécessaire pour dériver la date ou le créneau : `derived_earliest` avec créneau ≠ `none`, mode de date ou de créneau inconnu/absent, fenêtre sans granularité entière > 0 | traités comme un cas connu ou ignorés | envoi fermé | `policy` |

Fichiers : `lib/checkout-schedule/model.ts` (règles ci-dessus ; un type `UnreadableReason`), `lib/checkout-schedule/messages.ts`
(`unreadableMessageKey`), `components/CheckoutSchedulePicker.tsx` (affiche la raison), `lib/i18n.ts` (4 messages × fr/en/ar/nl). Aucun SQL,
aucun autre fichier de production. `MenuView.tsx`, `CartPanel.tsx` (SHA épinglé) et les services ne changent pas dans ce commit.

**Décision à confirmer (CIO / DIRAC).** `derived_earliest` avec un créneau ≠ `none` est **bloqué** (`policy`) : le contrat v1.2 dit que, en
date dérivée, le créneau et l'heure fournis donnent `selection_not_expected`. Bloquer côté client évite d'envoyer une sélection que le serveur
refuserait ; si le CIO préfère laisser le serveur trancher, c'est une ligne à retirer (et le test `[158-R2-4]` à adapter) — non fait sans accord.

### 11.2 RED / GREEN

| Test | RED sur f81bb60 | GREEN sur 5ef2063 |
|---|---|---|
| `tests/csdj2-checkout-schedule-158-r2.dom.test.ts` (10 tests, parcours complet jsdom + bundle MenuView) | 9/10 en échec (`evidence-158-r2/red-parent-f81bb60-dom.tap`) : « créneau différent de celui choisi envoyé », « date impossible envoyée », « intervalle inversé envoyé », « politique inconnue : envoi ouvert » | 10/10 (`green-r2-dom.tap`) |
| `tests/csdj2-checkout-schedule-158-r2.test.ts` (5 tests purs) | 4/4 en échec sur le modèle parent (`red-parent-f81bb60-pure.tap`) ; `[158-R2-P5]` (traductions) ne peut pas s'exécuter sur le parent : la clé de message n'y existe pas | 5/5 (`green-r2-pure.tap`) |

Chaque cas DOM vérifie : bouton d'envoi absent, explication française visible, « Réessayer » présent, aucun choix de créneau ni sélecteur de
date, « Cookie chocolat » toujours dans le panier, **0** `create_order`, **0** ouverture WhatsApp ; puis, après réponse saine, la commande part
avec le bon `schedule`. Non-régression : `[158-R2-4b]` (dérivée + créneau `none` reste envoyable). Aucun test existant retiré ni affaibli : les 19
purs, 13 DOM et 5 `r1` passent inchangés.

### 11.3 Vérifications

- Tests ciblés : 19 + 13 + 5 + 5 + 10 + 16 (épinglage `delivery-engine-unchanged-v1`) = 68/68 ; SW-04 (`storefront-order-help-wording…`) : seul `[SW-01]` en échec, **identique sur main** (préexistant) ; dérive documentaire `[158-R1-E]` verte.
- `npx tsc --noEmit -p .` : aucune erreur. `next build` (variables factices) : succès, `exit=0` (`next-build-tail.txt`).
- Parent : `f81bb606e5baf2d52fffbb3f01ddd3a63b201d10` ; candidat : voir le commentaire de la PR (SHA et arbre).

### 11.4 Suite complète comparée par identité — les « 5 échecs de plus » de Turing

Méthode : identité d'échec = (fichier, nom du test) extraite du TAP (`evidence-158-r2/tools/failids.py`), jamais le seul compteur. Huit
exécutions complètes, une à la fois (`full-suite-comparison.txt`, listes `failures-*.tsv`) :

- **Avec variables d'environnement** : main (f852988 et pointe a66fcc6), parent f81bb60 (deux fois), candidat, candidat fusionné à la pointe de main : **14 échecs, mêmes 14 identités partout**. Le candidat n'ajoute ni ne retire aucun échec. Ces 14 existent sur main (OB-1 non-modification ×5, SW-01/CB-02/SWD-01, BL-1, deux gardes structurelles P3-A1, une P3-A2, « Scénario 16 », « 1-3 technical details… »).
- **Sans variables** : main, parent et candidat ont **les mêmes 15 identités** (les 14 + le fichier `cfte-v1-customer-name-and-email.test.ts` entier, 21 tests non exécutés parce que `lib/supabase.ts` lève sans variables).
- **Répétition** : parent mesuré deux fois (identique) ; les 52 tests de la PR : 5 exécutions séquentielles + 12 sous charge CPU, 17/17 vertes.

**Conclusion mesurée : les 5 échecs supplémentaires ne sont PAS reproduits** — ni dans l'arbre candidat, ni dans le parent, ni selon la présence des
variables, ni sous charge, ni après fusion avec la pointe actuelle de main. Je ne peux donc pas dire s'ils sont « nouveaux » (aucun signe de
régression due à la PR), « intermittents » (aucune bascule observée : 17 exécutions ciblées répétées, et deux mesures du parent aux identités identiques) ou « environnementaux »
(une différence d'environnement existe — le fichier `cfte` — mais elle est identique pour main). Je ne conclus pas au-delà.

Ce qui manque pour trancher, à fournir par le contre-audit : **les 5 noms de tests (fichier + nom)**, le **SHA de sa référence**, sa
version de Node, son nombre de CPU, la présence des trois variables Supabase et la profondeur de son clone Git. Points de comparaison utiles :
(a) le nombre 5 coïncide avec les 5 tests de `ob1-non-modification-proof`, qui échouent **déjà sur main** ici parce qu'ils comparent
`git diff --name-only 7dde570…` à une liste de fichiers autorisés — leur résultat dépend de l'état Git de l'arbre, pas du code testé ; c'est une
piste, **non vérifiée** ; (b) la référence de Turing est-elle `f852988` ou une pointe de main plus récente (main a avancé : #161/#162) ?
Le script `tools/failids.py` permet de produire la liste d'identités de n'importe quelle exécution pour un `diff` direct.

### 11.5 P1 — toujours INCONCLUSIF

Rien en Production n'a été lu ni touché. `docs/scheduling/csdj2-create-order-production-verification-158.md` reçoit un §6 « Rapprochement
avec les erreurs du 15 octobre » (R1–R5) que DIRAC ou le CTO remplissent en **lecture seule** : journaux des 4 requêtes (base touchée, clés du
corps), comparaison avec la base lue en A1–A6, révision cliente déployée, et table de lecture des résultats. Nouveau point à lever avant
tout déploiement : si `get_checkout_fulfillment_schedule` n'existe pas ou n'est pas exécutable par le client en Production, la PR #160 ferme
l'envoi du retrait (par conception, fail-closed) — décision CIO / DIRAC. Le P1 n'est pas clos tant que A1–A6, R1–R5 et M1–M12 ne sont pas joints.

### 11.6 Limites

Tout est mesuré sur doublures (mocks `supabase.rpc`, jsdom) ; aucune base hébergée, aucun Preview authentifié, aucune commande réelle. La
fusion avec la pointe de main est une simulation locale jetable, non poussée. Les requêtes de la procédure P1 n'ont été exécutées que sur PGlite local.

## 12. CSDJ2-R3-01 (P2) — date dérivée : valider les offres avant de la déclarer disponible

Candidat de départ : `427c395aaa31858144d0f80cd0afdd775b6c4daf` (tree `64f1c644573305c23d3744d47a502b88b0e4392d`). Finding du contre-audit Turing :
dans le chemin `derived_earliest` avec `slot_selection_mode='none'`, le modèle retournait l'exigence « derived » **avant** d'avoir validé les offres.

### 12.1 Défaut

`offers:null` (que le mapper transforme en objet vide), une offre mal formée (`slot_key:null, starts_at:"25:00", ends_at:"09:00"`) ou des
bornes inversées en format non strict (`18:00:00`→`09:00:00`) laissaient partir un `create_order` date seule (`{date, slot_key:null,
starts_at:null, ends_at:null}`), en retrait comme en livraison. Cause : le contrôle d'ordre des bornes ne s'applique que si **les deux heures
sont strictes**, et le contrôle de complétude/forme des offres n'existait que dans la branche `customer_selectable`. Défaut préexistant à
`5ef2063` (déjà présent sur `f81bb60`), non introduit par la remédiation précédente.

### 12.2 Correctif (`lib/checkout-schedule/model.ts`, +32 lignes, aucun autre fichier de production)

Avant de retourner « derived », la réponse doit contenir pour la date dérivée **au moins une offre**, et **toute offre fournie, pour n'importe quelle
date,** doit être bien formée pour la politique `none` : `slot_key` nul, `starts_at` et `ends_at` en `HH:MM` strict (`00:00`–`23:59`), fin
strictement après le début. Sinon : `unreadable` (raison `response`, ou `interval` pour des bornes strictes inversées/égales, déjà traitées) ⇒
envoi fermé, explication, « Réessayer », panier conservé, 0 `create_order`, 0 ouverture WhatsApp. Le payload du cas dérivé valide est **inchangé**
(date seule, contrat v1.2 §5.1).

Fondement dans le SQL source du dépôt (lecture seule du fichier, **pas** de la base déployée) :
`supabase/DRAFT-lot-checkout-scheduling-foundation-v1.sql` — le lecteur n'ajoute une date que si au moins une offre a été retenue (« Une date dont
TOUTES les offres ont été écartées n'est pas une date éligible »), émet `starts_at`/`ends_at` en `to_char(…,'HH24:MI')`, et `slot_key` nul pour les
fenêtres (politique `none`). Une réponse qui s'en écarte est donc incohérente au regard de la source connue ; ce que Production a réellement
déployé reste à lire (P1).

Choix à connaître (décrits, non contournés) :
- une date dérivée dont les offres sont **absentes** est refusée, alors que le contrat n'affiche pas d'heure pour une date dérivée : la présence d'offres
  sert de preuve que le serveur a retenu la date, pas de donnée affichée ;
- une offre mal formée pour une **autre** date que la date dérivée ferme aussi l'envoi (réponse contradictoire) ; si le CIO préfère n'exiger la forme
  que de la date dérivée, c'est une boucle à restreindre dans le modèle et un test à adapter — non fait sans accord ;
- les bornes non strictes inversées (`18:00:00`→`09:00:00`) sont refusées comme **réponse mal formée** (message générique « disponibilités
  inexploitables »), non comme « intervalle » : la forme est invalide avant d'être comparée.

### 12.3 RED / GREEN

| Test | RED sur 427c395 | GREEN sur 60e25ed |
|---|---|---|
| `tests/csdj2-checkout-schedule-158-r3.dom.test.ts` (5 tests, vrai MenuView sous jsdom, 13 réponses × retrait et × livraison) | 3/5 en échec (`evidence-158-r3/red-427c395-dom.tap`) : 11 des 13 réponses envoient `create_order` date seule et ouvrent WhatsApp (les 2 réponses à bornes strictes inversées étaient déjà fermées) | 5/5 (`green-r3-dom.tap`) |
| `tests/csdj2-checkout-schedule-158-r3.test.ts` (5 tests purs : exigence, payload, mapper brut `offers:null`) | 2/5 en échec (`red-427c395-pure.tap`) ; les 3 autres sont des contrôles positifs/inchangés | 5/5 (`green-r3-pure.tap`) |

Les 13 réponses : `offers:null`, offres absentes, liste vide, `25:00→09:00`, `24:00`, `18:00:00→09:00:00`, `09:00:00→18:00:00`, heure vide, strict inversé,
durée nulle, bonne + mal formée, clé de créneau présente, offres d'une autre date seulement. Pour chacune : envoi fermé, raison visible, « Réessayer »,
nom et téléphone conservés, panier intact, 0 `create_order`, 0 WhatsApp ; puis, réponse valide : un seul appel (double clic compris) avec
`{"date":"2026-10-20","slot_key":null,"starts_at":null,"ends_at":null}`. Contrôles positifs conservés : dérivée valide (une offre, bornes adjacentes,
durée d'une minute, `00:00–23:59`), date seule, créneaux fixes, fenêtre, absence explicite, dates bissextiles 2000/2028/2400.

### 12.4 Vérifications

- Ciblés : 19 + 13 + 5 + 5 + 10 + 5 + 5 + 16 (épinglage `delivery-engine-unchanged-v1`) = 78/78 ; aucun test existant retiré ni modifié.
- `tsc --noEmit` : exit 0 (`tsc.txt`). `next build` (variables factices) : succès, `exit=0` (`next-build-tail.txt`).
- Suites complètes par identité (`full-suite-comparison.txt`) : candidat `60e25ed` en parallélisme 1 et 2 et main `a66fcc6` en parallélisme 2 : **14 échecs, mêmes 14
  identités que L0** ; 0 nouvel échec, 0 en moins ; +10 tests.
- Écart signalé par Turing (Windows, Node v24, 23 échecs communs, dont 5 seulement sur main, 0 de plus sur le candidat) : non reproduit sous Linux/Node v22
  (14 partout, y compris en parallélisme 2). Je ne l'attribue pas : ses 14 identités historiques sont retrouvées, les autres sont des différences d'environnement
  (chemins Windows, origine Supabase factice, attentes courtes des tests DOM) qu'il a lui-même laissées en échec.

### 12.5 Limites et P1

Doublures (mocks `supabase.rpc`, jsdom) ; aucune base hébergée, aucun Preview authentifié, aucune commande réelle. La conformité à la base **déployée** n'est pas établie.
**P1 Production : INCONCLUSIF** — aucune des preuves de lecture seule (A1–A6, R1–R5 de `csdj2-create-order-production-verification-158.md` §6, M1–M12) n'a été fournie. Rien ici n'a touché la Production.
