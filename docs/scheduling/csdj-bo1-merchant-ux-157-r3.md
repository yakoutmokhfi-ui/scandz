# PR #157 — remédiation R3 (contre-audit Cat Turing R2 : R3-F01, R3-F02)

> **Statut : DRAFT. NO MERGE / NO DEPLOY / NO SQL / NO PAYMENTS.**
> HEAD R2 audité, conservé et **non réécrit** : `1f7351034b820ae998ab897f7055f99f36838c77` (tree `479a91afb48cf77e7a6e814e3bf564799434d92b`).
> La remédiation R3 est livrée en **commits enfants** de ce HEAD. Périmètre : frontend (`page.tsx`, `i18n.ts`) et tests. Zéro SQL, zéro service, zéro donnée.

## R3-F01 — la relecture de A n'appartient jamais à B

**Cause (confirmée).** `handleSelectRestaurant` invalidait `requestSeqRef` mais pas `refreshSeqRef`, `reloading` ni `reloadAbandoned`
(`selectScope` le faisait). Une relecture de A en vol laissait donc le bouton de B inactif (« Relecture en cours… ») puis, à l'arrivée
de A, le message d'abandon apparaissait dans B. Le chargement initial `load(id)` avait la même lacune.

**Correctif.** Dans `handleSelectRestaurant` **et** `load` (les deux seuls endroits qui changent de restaurant), de façon **synchrone** :
`refreshSeqRef += 1`, `previewSeqRef += 1`, `reloading = false`, `reloadAbandoned = false`. Les continuations de A, en succès comme en erreur,
vérifient en plus l'**identité du restaurant** (`requestSeq === requestSeqRef.current`) avant d'écrire le statut d'abandon ;
la branche de succès/erreur nominale exigeait déjà génération + restaurant + portée + brouillon.

## R3-F02 — plus d'exemple « ready » pendant un conflit STALE connu

**Cause (confirmée).** `loadServerVersion` posait le conflit sans toucher à la génération ; elle ne changeait qu'au choix manuel.
`previewInScope` ne consultait pas le conflit.

**Correctif.**
- `loadServerVersion` incrémente la génération **dès qu'il est appelé**, avant sa relecture : le STALE prouve que la version enregistrée
  n'est plus celle que l'écran croyait. Un exemple affiché **ou encore en vol** devient d'une version révolue (statut « périmé », date masquée).
- `previewInScope` exige aussi `conflictInScope === null` ; `previewStale` couvre le conflit ouvert.
- Le calcul est **suspendu** tant que le conflit n'est pas résolu (`runPreview` refuse, boutons inactifs, note `avServerExampleConflict`
  en FR/EN/AR/NL) : une nouvelle réponse ne peut pas être attribuée à une version non vérifiée.
- Après reprise de la version du serveur ou rebase : l'exemple reste périmé jusqu'à une **nouvelle** demande, dont le résultat est alors cohérent.
- La sauvegarde reste impossible sans résolution explicite ; aucun enregistrement par le rebase. Aucun oracle de disponibilité dans le navigateur.

## Preuves

Nouveau fichier `tests/csdj-bo1-merchant-ux-157-r3.dom.test.ts` (8 tests) : vraie page, vrai drapeau d'écriture, vrais helpers,
promesses contrôlées (`deferred` avec succès **et** rejet), deux commerçants.

| Test | HEAD R2 `1f73510` | HEAD R3 |
|---|---|---|
| `R3-F01-release` (A en vol → B chargé → A réussit) | **ROUGE** (bouton de B inactif) | VERT |
| `R3-F01-reject` (… A échoue) | **ROUGE** | VERT |
| `R3-F01-own` (B lance sa relecture, puis A arrive) | **ROUGE** | VERT |
| `R3-F02-a` (STALE non résolu : ancienne date 2026-10-20 visible) | **ROUGE** | VERT |
| `R3-F02-b` (exemple en vol libéré après le STALE) | **ROUGE** | VERT |
| `R3-F02-c` (reprise de version → nouvelle demande cohérente) | VERT (préservation) | VERT |
| `R3-F02-d` (rebase ; sauvegarde impossible sans résolution) | VERT (préservation) | VERT |
| `R3-I18N` (FR/EN/AR/NL, AR en RTL, aucune clé brute) | n/a (clé absente) | VERT |

Journaux : `docs/scheduling/evidence/csdj-bo1-merchant-ux-156/remediation-157-r3/` (`red-on-1f73510.log`, `green-r3.log`, `green-targeted-85.log`).
Pour la comparaison à `1f73510`, `page.tsx` et `i18n.ts` ont été remis à l'état de `1f73510` (stash), le fichier de tests R3 conservé.

**Préservation des PASS R2** (rejoués verts) : protection du brouillon (R1/R2/R1b/R1c), races inter-portées (`UX156-10c`), F02 après save et changement de portée
(R3/R3b/R3c/R3d), verrou fermé à **0 RPC** (`BO1-LOCK-1..6`). Ciblé : **85/85** (R3 8, remédiation 8, verrou 6, UX-156 28, `availability`, `editor-save`, `a11y`).

## Vérifications

- `tsc --noEmit` : 0 erreur. `next build` (variables Supabase factices) : OK.
- `npm test` complet, lancé **seul** : 5 680 tests, 15 échecs. Comparaison **par identité** : les 15 sont **exactement** les 15 historiques de `1f73510`/`b060eba`
  (0 nouveau, 0 disparu), tous inclus dans les 27 de `main` (`97e0ddc`). Listes versionnées dans le dossier de preuves. Windows : non exécuté ici (Linux), à comparer par l'auditeur.
- `supabase/`, `lib/services/availability.ts`, `lib/availability-payload.ts` : 0 ligne modifiée.

## INCONCLUSIF

- Aucune session commerçant authentifiée en Preview n'a été utilisée : `get_fulfillment_configuration` réel **non vérifié**. Les scénarios sont des tests DOM (JSDOM) avec doubles de services ; ils ne sont jamais présentés comme E2E.

## Risque résiduel

- Une relecture lancée puis abandonnée par un changement de restaurant n'est pas annulée côté réseau (les requêtes se terminent) ; leur résultat est simplement ignoré.
- La génération reste locale à l'onglet : un autre onglet qui enregistre n'invalide pas l'exemple d'un onglet inactif (le STALE protège l'enregistrement).

Contre-audit indépendant demandé sur le HEAD R3 avant toute décision CTO/CIO.
