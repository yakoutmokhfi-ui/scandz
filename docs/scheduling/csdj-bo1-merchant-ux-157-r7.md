# PR #157 — remédiation R7 (contre-audit Cat Turing R6 : R6-ROUNDTRIP-STALE-PREVIEW)

> **Statut : DRAFT. NO MERGE / NO DEPLOY / NO SQL / NO PAYMENTS.**
> HEAD R6 audité, conservé et **non réécrit** : `9ce1ab3522cca27a13e955ddfe95dc2c23af32c4` (tree `1e56d7fba83eacd80d2567a7409528ae7f11ee40`).
> R7 = commits enfants de ce HEAD. Périmètre : `app/dashboard/availability/page.tsx` et tests. Aucun SQL, aucun service availability, aucune donnée, aucune clé i18n nouvelle.

## R6-ROUNDTRIP-STALE-PREVIEW (P2, résiduel hérité de R5, confirmé par l'audit R6)

**Scénario (Turing).** Sauvegarde retenue en vol sur `pickup` ; `delivery` puis retour sur `pickup` (la lecture rend encore la révision `1111…` de la demande) ; exemple calculé `ready` (2026-10-20) ;
un tiers désactive pickup (jetons changés) **après** cette lecture ; la demande retenue est refusée `CSDJBO1_STALE_CONFIGURATION`.

**Cause.** Le `catch` de `saveConfiguration` sortait sur `!stillInScope()` (garde R5) **avant** de lire le code du refus : l'information « la version affichée est périmée »
était connue mais ignorée -> exemple resté `ready`, statut `clean`, aucun conflit.

**Correctif (gardes R5/R6 CONSERVÉES, `stillInScope()` non retiré).** Dans la branche `!stillInScope()` du `catch`, un refus STALE n'a d'effet que si l'écran est **revenu sur la portée refusée** :
1. **Snapshot affiché portant les MÊMES jetons** que la demande refusée (`expectedRevision` + `expectedUpdatedAt`) -> traitement identique à un refus en portée : message de refus, `loadServerVersion` (génération invalidée donc exemple `stale` aussitôt,
   conflit relu à part, sauvegarde fermée, brouillon et saisie jamais écrasés) ;
2. **Lecture neuve encore en vol** (aucun snapshot affiché pour juger) : les jetons refusés sont mémorisés (`refusedStaleRef`) et jugés **à l'arrivée du snapshot** (effet dédié) :
   mêmes jetons = lecture antérieure au commit du tiers -> même traitement ; jetons différents = lecture plus récente -> **aucun effet** ; la lecture en vol n'est jamais invalidée ;
3. **Snapshot affiché plus récent que la demande** (jetons différents : le tiers a modifié *avant* la nouvelle lecture) : **aucun effet** (contrôle négatif de l'audit : ni conflit, ni erreur, ni lecture en plus, exemple `ready` conservé) ;
4. Autre portée / autre commerçant / refus non-STALE : inchangés (R5).

## Preuves — `tests/csdj-bo1-merchant-ux-157-r7.dom.test.ts` (5 tests, vraie page + vrai drapeau, promesses contrôlées)

| Test | R6 `9ce1ab3` | R7 |
|---|---|---|
| `R7-STALE-ORDRE-A` (scénario exact : exemple plus `ready`, aucune date, conflit relu, enregistrement fermé, 1 seule écriture, version du tiers non écrasée, reprise du serveur puis recalcul cohérent) | **ROUGE** (`ready`) | VERT |
| `R7-STALE-DIRTY` (saisie du commerçant préservée, exemple périmé, conflit visible, enregistrement fermé) | **ROUGE** | VERT |
| `R7-STALE-ORDRE-B` (contrôle négatif : tiers AVANT la nouvelle lecture -> `ready` conservé, ni conflit, ni erreur, ni lecture supplémentaire) | VERT (préservation) | VERT |
| `R7-STALE-LECTURE-EN-VOL-recente` (lecture en vol postérieure au commit : non invalidée, aucun conflit) | VERT (préservation) | VERT |
| `R7-STALE-LECTURE-EN-VOL-ancienne` (lecture en vol antérieure au commit : à l'arrivée, version périmée connue -> conflit, enregistrement fermé) | **ROUGE** | VERT |

Journaux : `docs/scheduling/evidence/csdj-bo1-merchant-ux-156/remediation-157-r7/` (`red-on-9ce1ab3.log` : 3 rouges / 2 verts de préservation ; `green-r7.log` ; `green-targeted.log`).
Pour le RED, `page.tsx` a été remis à l'état de `9ce1ab3`, le fichier de tests conservé.

**Preuves de mutation** (puis restauré) :
- retrait de la comparaison des jetons dans le `catch` -> `R7-STALE-ORDRE-B` rouge ;
- neutralisation de l'effet de jugement à l'arrivée -> `R7-STALE-LECTURE-EN-VOL-ancienne` rouge.

## Vérifications

Voir les résultats consolidés ci-dessous (section « Résultats »).

## Limites connues (documentées, non des défauts de R7)

- Listes `schedules`/`v12` non ordonnées par version ; `saving` partagé entre portées d'un même commerçant ; transports non annulés ; génération locale à l'onglet.
- Le jugement à l'arrivée repose sur l'égalité des deux jetons ; une lecture rendant d'autres jetons sans lien avec la demande refusée est jugée « plus récente » (c'est le cas normal).
- JSDOM uniquement ; lecture authentifiée de l'exemple (Preview) : **INCONCLUSIVE**. Les tests Windows-dépendants relevés par l'audit R6 (chemins, fins de ligne CRLF, origine `placeholder.supabase.co`) restent hors de ce que Linux peut établir.

## Résultats

- `tsc --noEmit` : 0 erreur. `next build` : OK (variables Supabase factices), 34/34 pages.
- Tests `csdj-bo1-*` : **246/246** verts (R1–R6 inclus, verrou d'écriture `BO1-LOCK-1..6`, invariant source `BO1-F01-8`).
  Un premier passage a donné 245/246 : `BO1-F01-8` (la page n'écrit jamais un jeton `expectedRevision:`) échouait sur les noms de champs de mon nouveau `refusedStaleRef` ; **le test audité n'a pas été touché**, les champs ont été renommés (`revisionRefused`/`updatedAtRefused`). Journaux des deux passages conservés : `green-targeted-246.log` (final).
- `npm test` complet, **seul**, Linux : 5 710 tests, 15 échecs = **exactement** les 15 identités de la référence R4 (0 nouveau, 0 disparu ; `npm-test-failures-after-r7.txt` vs `npm-test-failures-reference-r4.txt`). 5 710 = 5 705 (R6) + 5 (R7).
- `supabase/`, `lib/services/availability.ts`, `lib/availability-payload.ts`, `lib/i18n.ts` : 0 ligne modifiée.
- Pas de promesse « zéro régression » universelle : le comptage Windows de l'audit (23 échecs : 14 historiques + 5 chemins Windows + 4 origine `placeholder.supabase.co`) et la sensibilité aux fins de ligne CRLF (ex. `BO1-LOCK-3`) restent **INCONCLUSIFS** depuis Linux ; le parcours Preview authentifié aussi.
