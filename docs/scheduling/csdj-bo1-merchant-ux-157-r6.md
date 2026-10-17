# PR #157 — remédiation R6 (contre-audit Cat Turing R5 : R5-PREVIEW-ROUNDTRIP)

> **Statut : DRAFT. NO MERGE / NO DEPLOY / NO SQL / NO PAYMENTS.**
> HEAD R5 audité, conservé et **non réécrit** : `3e4bf8e5e68e7535709ef1ef9866f4ad2c4243a5` (tree `19e655cede171f1e4da0dc623d4232409387bc47`).
> R6 = commits enfants de ce HEAD. Périmètre : `app/dashboard/availability/page.tsx`, `lib/i18n.ts`, tests, documentation. Aucun SQL, aucun service availability, aucune donnée.

## R5-PREVIEW-ROUNDTRIP (P2, régression introduite par R5)

**Scénario (Turing).** Sauvegarde retenue en vol sur `pickup` ; le commerçant passe à `delivery` puis revient à `pickup` (lecture de la version avant le commit, activation encore « activée ») ;
l'exemple serveur est calculé (prêt le 2026-10-20) ; la sauvegarde réussit ensuite. Le serveur est désormais désactivé.

**Cause.** Le retour anticipé `!stillInScope()` du succès de `saveConfiguration` (R5) ne touchait plus la portée courante, ce qui est juste pour une *autre* portée,
mais ignorait le cas « même portée, revenue entre-temps » : la génération de snapshot n'était pas invalidée, l'exemple restait `ready`, l'activation restait cochée, l'état `clean`,
alors que le serveur avait changé (R4 donnait `stale`).

**Correctif (gardes de portée et de génération CONSERVÉES).** Dans la branche `!stillInScope()`, si la portée sélectionnée est celle qui vient d'être enregistrée :
1. `bumpSnapshotGen()` : l'exemple lu avant le commit est périmé (`stale`) ;
2. **brouillon propre** (`dirtyRef=false`) → relecture autoritaire (`reloadNonce`) : l'écran rejoint la version enregistrée (désactivée) sans écriture supplémentaire ;
3. **brouillon modifié** → la saisie n'est **jamais écrasée** ; mention `data-saved-meanwhile` (« une sauvegarde est intervenue entre-temps », FR/EN/AR/NL) ; aucun enregistrement implicite ;
   le prochain enregistrement passe par le refus `STALE` du serveur (jeton périmé) puis par le conflit visible, jamais en silence.
Pour une autre portée, rien ne change (aucune péremption inutile, aucune lecture supplémentaire). La mention est effacée au changement de contexte, au rechargement et au début d'une sauvegarde.

## Preuves — `tests/csdj-bo1-merchant-ux-157-r6.dom.test.ts` (5 tests, vraie page + vrai drapeau, promesses contrôlées, deux ordres lecture/commit)

| Test | R5 `3e4bf8e` | R6 |
|---|---|---|
| `R6-ROUNDTRIP` (scénario exact de Turing : exemple `stale`, activation décochée, statut `clean`, 1 seule écriture, recalcul cohérent 2026-11-03) | **ROUGE** (`'ready' !== 'stale'`) | VERT |
| `R6-ROUNDTRIP-DIRTY` (saisie du commerçant préservée, exemple périmé, mention affichée, aucune écriture implicite, 2e enregistrement refusé STALE → conflit) | **ROUGE** | VERT |
| `R6-ORDRE` (lecture APRÈS le commit : cohérent d'emblée, une seule relecture) | VERT (préservation) | VERT |
| `R6-AUTRE-PORTEE` (succès tardif de pickup pendant que delivery est affiché : exemple `ready` conservé, 0 lecture en plus) | VERT (préservation) | VERT |
| `R6-I18N` (4 langues, AR en RTL, aucune clé brute) | **ROUGE** (clé absente) | VERT |

Journaux : `docs/scheduling/evidence/csdj-bo1-merchant-ux-156/remediation-157-r6/` (`red-on-3e4bf8e.log` : 3 rouges / 2 verts de préservation ; `green-r6.log` : 5/5 ; `green-targeted-241.log` : 241/241).
Pour le RED, `page.tsx` et `i18n.ts` ont été remis à l'état de `3e4bf8e`, le fichier de tests conservé.

**Preuves de mutation** (puis restauré) :
- retrait de `bumpSnapshotGen()` → `R6-ROUNDTRIP-DIRTY` rouge ;
- ignorer `dirtyRef` (toujours relire) → `R6-ROUNDTRIP-DIRTY` et `R6-I18N` rouges.
Remarque : sur le chemin « propre », la relecture re-bumpe elle-même la génération ; le bump est déterminant surtout sur le chemin « modifié ».

## Vérifications

- `tsc --noEmit` : 0 erreur. `next build` : OK (variables Supabase factices), 34/34 pages.
- Tests `csdj-bo1-*` : 241/241 verts (préservation R1–R5, verrou d'écriture `BO1-LOCK-1..6`, jetons, isolation inter-commerçants, refus staff, RPC transactionnelle unique).
- `npm test` complet, **seul**, Linux : 5 705 tests, 15 échecs = **exactement** les 15 identités de la référence R4 (0 nouveau, 0 disparu ; comparaison par identité : `npm-test-failures-after-r6.txt` vs `npm-test-failures-reference-r4.txt`). 5 705 = 5 689 (R4) + 11 (R5) + 5 (R6).
- `supabase/`, `lib/services/availability.ts`, `lib/availability-payload.ts` : 0 ligne modifiée.
- Je ne promets pas « zéro régression » universel : les tests Windows-dépendants relevés par l'audit (cockpit, annuaire, import, gap-01, catalogue-focus, `v152-product-photo-service`) restent **INCONCLUSIFS** depuis Linux ; la 15e identité historique (cfte) dépend de l'environnement Supabase.

## Limites connues (documentées, non des défauts de R6)

- Les listes `schedules`/`v12` ne sont pas ordonnées par version : une lecture partielle ne peut pas être classée avant/après un commit sans jeton serveur.
- `saving` est partagé entre les portées d'un même commerçant.
- Le transport n'est pas annulé : les réponses tardives sont ignorées, pas interrompues.
- La génération de snapshot est locale à l'onglet (une sauvegarde faite dans un autre onglet est détectée par le refus STALE).
- Lecture authentifiée de l'exemple (Preview) : **INCONCLUSIF**, non exécutée ici (pas de session ni de déploiement).
