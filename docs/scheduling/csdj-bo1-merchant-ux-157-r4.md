# PR #157 — remédiation R4 (contre-audit Cat Turing R3 : R4-F02a, R4-F02b, R4-F01-SAVE)

> **Statut : DRAFT. NO MERGE / NO DEPLOY / NO SQL / NO PAYMENTS.**
> HEAD R3 audité, conservé et **non réécrit** : `744a07361f9bca6d8fa0d9c8f03c6f16cab39f87` (tree `24e406250cce5a3a069d69ae0209ccab3db3ef07`).
> R4 = commits enfants de ce HEAD. Périmètre : `app/dashboard/availability/page.tsx`, `lib/i18n.ts`, tests. Aucun SQL, aucun service availability, aucune donnée.

## R4-F02a — le conflit est connu AVANT le premier await

**Cause (confirmée).** `loadServerVersion` ne posait `setConflict` qu'après `await getFulfillmentConfiguration`. Pendant la relecture, `conflictInScope` restait `null` :
le calcul d'exemple était permis et son résultat présenté « actuel » (RPC supplémentaire, date 2026-10-20 `ready`).

**Correctif.** L'état `conflict` porte désormais `reading: boolean`. `loadServerVersion` pose `{restaurantId, scopeKey, server: null, reading: true}`
**avant le premier await** (provenance restaurant + portée), puis `{server, reading: false}` à l'arrivée (succès) ou `server: null, reading: false` (erreur → « Réessayer »).
Toutes les gardes lisent ce même état : `runPreview` (refus), les deux boutons de calcul (inactifs), `previewInScope` (jamais « ready »), `canSaveDraft` (sauvegarde fermée dès le STALE),
et l'affichage (`data-conflict-reading`, note `avConflictReading`, 4 langues). La génération de snapshot est toujours incrémentée dès le STALE, mais **aucune nouvelle demande ne peut plus la capter** tant que le conflit est ouvert.

## R4-F02b — l'exemple en vol est annoncé « périmé » tout de suite

**Cause.** `runPreview` efface `previewScopeKey` au départ et le rendu donnait priorité à `previewLoading` : un exemple lent restait « loading » jusqu'à l'arrivée de l'ancienne réponse.

**Correctif.** `previewRequestGen` mémorise la génération de la demande en vol ; `previewInFlightStale = previewLoading && (previewRequestGen ≠ snapshotGen || conflit)`.
L'écran passe aussitôt à `data-server-example="stale"` avec la note « périmé », sans attendre l'ancienne réponse. Le bouton reste utilisable une fois le conflit résolu :
une nouvelle demande rend l'ancienne muette (`previewSeqRef`), son arrivée tardive ne l'écrase pas.

## R4-F01-SAVE — la sauvegarde de A n'appartient jamais à B

**Cause.** `setSaving(true)` n'était remis à `false` que si le restaurant n'avait pas changé (`finally` gardé) ; après A→B, rien ne le remettait à zéro : B restait « saving », éditeur et sauvegarde verrouillés.

**Correctif (la garde est CONSERVÉE).** `saving` repart de zéro au changement de contexte, de façon synchrone, dans `load` et `handleSelectRestaurant`. Le `finally` de A reste gardé par l'identité du restaurant,
si bien qu'une réponse tardive de A (succès **ou** erreur) ne peut ni libérer ni verrouiller B, et ne touche ni brouillon, ni version, ni jetons de B. La sauvegarde de B lève son propre drapeau.
**Preuve de mutation** : en retirant temporairement la garde du `finally`, `[R4-F01-SAVE-race]` devient rouge (puis restaurée).

## Preuves — `tests/csdj-bo1-merchant-ux-157-r4.dom.test.ts` (9 tests, vraie page + vrai drapeau, promesses contrôlées)

| Test | R3 `744a073` | R4 |
|---|---|---|
| `R4-F02a-success` / `-error` (relecture du conflit retenue puis réussie / en erreur : conflit déjà posé, calcul impossible, 0 RPC d'exemple, aucune date, sauvegarde fermée) | **ROUGE** | VERT |
| `R4-F02a-retry` (échec puis « Réessayer ») | VERT (préservation) | VERT |
| `R4-F02b` (exemple en vol au STALE → « périmé » immédiat, avant la fin de la relecture et avant l'ancienne réponse) | **ROUGE** | VERT |
| `R4-F02b-late` (nouvelle demande possible après résolution ; l'ancienne réponse tardive ne l'écrase pas) | **ROUGE** | VERT |
| `R4-F01-SAVE-success` / `-error` (A en vol → B chargé : B modifiable avant/après ; B enregistre avec ses propres jetons) | **ROUGE** | VERT |
| `R4-F01-SAVE-race` (B enregistre pendant que A est en vol ; réponses désordonnées) | **ROUGE** | VERT |
| `R4-I18N` (FR/EN/AR/NL, AR en RTL, aucune clé brute, aucune date) | **ROUGE** (clé absente) | VERT |

Journaux : `docs/scheduling/evidence/csdj-bo1-merchant-ux-156/remediation-157-r4/` (`red-on-744a073.log` : 8 rouges / 1 vert de préservation ; `green-r4.log` ; `green-targeted-94.log`).
Pour le RED, `page.tsx` et `i18n.ts` ont été remis à l'état de `744a073` (stash), le fichier de tests conservé.

**Préservation** (rejouée verte, 94/94 ciblés) : relectures R3-F01, protection du brouillon, races inter-portées (`UX156-10c`), F02 après save, verrou fermé à **0 RPC** (`BO1-LOCK-1..6`),
jetons `expectedUpdatedAt`/`expectedRevision`, isolation inter-commerçants, refus staff, une seule RPC transactionnelle, i18n.

## Vérifications

- `tsc --noEmit` : 0 erreur. `next build` : OK (variables Supabase factices).
- `npm test` complet, **seul**, Linux : 5 689 tests, 15 échecs = **exactement** les 15 historiques (0 nouveau, 0 disparu vs R3 ; tous inclus dans les 27 de `main`).
- `supabase/`, `lib/services/availability.ts`, `lib/availability-payload.ts` : 0 ligne modifiée.

## Échecs Windows signalés par l'audit R3 : analyse, sans promesse « zéro régression »

L'audit R3 compte 26 échecs sous Windows (15 historiques + 5 variations connues + 6 autres). Je **ne masque et ne réécris aucun test**. Mon analyse (Linux, `--test-concurrency=1`) :

- Les 5 fichiers concernés (catalogue reorder, gap-01 rétractation, cockpit, annuaire opérateur, import catalogue) et les pages qu'ils rendent **ne sont pas modifiés** par cette PR (aucune importation de `availability`).
- Rejeu séquentiel de ces 5 fichiers, 3 fois sur R4 et 3 fois sur `main` : 0 échec sauf **un** (gap-01 « affiche référence… sent », 1 run sur 3 sur R4). Isolé, ce test passe **12/12** sur R4 comme sur `main` : instabilité sous charge (attentes fixes de 50/60 ms), non attribuable à cette PR.
- Je n'ai **pas** pu reproduire sous Windows le rouge persistant du test cockpit « 9 sections » observé par l'auditeur au rejeu R3 (vert sur `main` pour lui, vert ici sur les deux arbres). Verdict honnête : **INCONCLUSIF sous Windows** pour ces six identités ; à rejouer par l'auditeur sur R4. Détail : `remediation-157-r4/replay-six-flaky-identities.txt`.

## INCONCLUSIF / limites

- Aucune session commerçant authentifiée en Preview : `get_fulfillment_configuration` réel **non vérifié**, jamais présenté comme E2E (tests DOM JSDOM avec doubles de services).
- Une relecture/un exemple abandonnés par un changement de contexte ne sont pas annulés côté réseau ; leur résultat est ignoré. La génération reste locale à l'onglet.

Contre-audit Turing R4 demandé sur le HEAD R4 avant toute décision CTO/CIO.
