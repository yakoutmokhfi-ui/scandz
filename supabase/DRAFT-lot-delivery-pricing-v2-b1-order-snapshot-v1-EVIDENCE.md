# DELIVERY PRICING v2 — B1 — ORDER DELIVERY FULFILLMENT SNAPSHOT v1 — dossier de preuves

Candidat à l'audit indépendant. **DRAFT — non appliqué en Production ni en PREPROD. Non mergé.**

| | |
|---|---|
| Mandat | `yakoutmokhfi-ui/scanym-orchestrator` issue #17, `IMPLEMENTATION_GO` (Ravel / CIO) |
| Contrat | Debussy, `DESIGN APPROVED — READY FOR IMPLEMENTATION`, CONTRACT_SHA256 `aac856732ff48aef5b69bcf6c65fb91a88754e95756587512ed0b453e28ec517` (recalculé : les deux commentaires de l'issue réassemblés donnent exactement ce hash) |
| Arbitrage | Ravel / CIO, `REMEDIATION_REQUESTED — NARROW` (issue #17), après le FAIL de Chateaubriand sur `722e6360` |
| Base | `497efb9af3288ae63d2bed500b361a3dab9a7f8c`, tree `faf1d51e5ff437dc465e6e7085329a588a843d26` |
| Candidat précédent | `722e6360f1147dc84259e6663deea22524385a3d` (audité FAIL) |
| Candidat | SHA du commit et tree : voir la PR et l'issue #17 (un fichier ne peut pas contenir le SHA du commit qui l'introduit) |

## 0. Remédiation — ce qui a changé depuis `722e6360`

| Blocker Chateaubriand | Traitement | Code runtime touché ? |
|---|---|---|
| **B1-EVIDENCE-10-14** | Cause identifiée et prouvée : **clone git shallow** (§7). Logs bruts, identités normalisées, diffs et environnement livrés sous `supabase/evidence/delivery-pricing-v2-b1/` | **Non** |
| **B1-T16-CONTRACT** | Arbitrage CIO appliqué. B1-T-16 est reformulé en (a)/(b)/(c). Le contre-exemple exact de l'audit est ajouté, ainsi qu'une simulation B5 (c) sur une base clone (§4-5, §14.5) | **Non** — migration et rollback identiques octet pour octet à `722e6360` |
| Portabilité CRLF (non bloquant) | Le test structurel normalise `\r\n` → `\n` à la lecture. Validé sur une copie CRLF de l'arbre : 10/10. L'ancien test échoue au chargement sur cette même copie, ce qui reproduit le constat | **Non** (test uniquement) |

Fichiers modifiés depuis `722e6360` :
- le harnais SQL (B1-T-16) ;
- le test structurel (CRLF) ;
- ce dossier ;
- l'ajout de `supabase/evidence/delivery-pricing-v2-b1/*`.

## 1-2. Fichiers du lot (depuis la base)

Uniquement des ajouts ; aucun fichier existant modifié, aucun code applicatif TS modifié.

```
A  supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql
A  supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1-ROLLBACK.sql
A  supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1-EVIDENCE.md
A  supabase/tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh
A  tests/delivery-pricing-v2-b1-order-snapshot-v1-structural.test.ts
A  supabase/evidence/delivery-pricing-v2-b1/   (preuves : logs bruts .gz, identités, diffs, normaliseur)
```

## 3. Autorité de rebase (G-1), preflight et migration

Le harnais rejoue la chaîne du dépôt dans un PostgreSQL jetable et mesure `md5(pg_get_functiondef(...))` après chaque redéfinition candidate de `create_order` :

| Après | md5 `create_order` |
|---|---|
| `…cgv-engine-v1-1.sql` | `bc50e83c…` |
| `…n1a-…-foundation-v1.sql` | `3a46761d…` |
| `…cgv-engine-v2-5.sql` | `1358f172…` |
| `…customer-followup-tracking-email-v1.sql` | `a9aed17c…` |
| `…delivery-country-scope-v1.sql` | `5f5d0611…` |
| **`…product-service-modes-v1.sql`** | **`cb49eebb3b3119d3d76473af480e78d8`** = valeur Production G-1 |

`resolve_delivery_fulfillment` : `0277502f9f1647d6866b2b1d5fd2a994` = valeur Production G-1.

Le delta §7.2 est donc rebasé sur le corps de `DRAFT-lot-product-service-modes-v1.sql` (section F), repris octet pour octet. Dans le harnais, les contrôles G1a et G1b rejouent cette mesure à chaque exécution.

Migration : une seule transaction (`begin` … `commit`).
- Préflight fail-closed P-1..P-7 (§7.3), avec les valeurs G-1 épinglées pour P-3 et P-6.
- Table verbatim §6.
- Commentaires, dont la sémantique de l'absence (§8.2).
- RLS et privilèges verbatim §12.
- `create or replace` de `create_order`.
- Post-contrôles P-8 : aucun droit d'écriture pour `anon`, `authenticated` ou `service_role` ; SELECT pour `authenticated` seul ; RLS active ; `create_order` en une seule surcharge, même retour, EXECUTE conservé, une seule écriture d'instantané ; table vide.

Contrôles négatifs du préflight, prouvés par le harnais :
- 2 surcharges → **P-5** refuse (B1-X-15).
- Double application → **P-7** refuse (B1-X-16).
- Mutant qui accorde `UPDATE` à `authenticated` → **P-8** refuse, rien n'est appliqué (vérifié hors harnais).

## 4-5. Harnais PostgreSQL jetable — `supabase/tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh`

**154 PASS / 0 FAIL.** Commande : `su postgres -c "bash supabase/tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh"` (depuis la racine, cluster PostgreSQL local démarré). Le log brut de cette exécution est dans `supabase/evidence/delivery-pricing-v2-b1/harness-sql-run.log.gz`.

| Groupe | Contrôles |
|---|---|
| Ancrage G-1 | G1a-c |
| Migration, contrat `create_order` | M1, P8a, P9a-d |
| Corps inchangé hors delta | C1 : `prosrc` post-B1 privé du seul bloc §7.2 = `prosrc` pré-B1 octet pour octet ; C2 résolveur inchangé ; C3 aucune autre fonction publique modifiée ; C4 `orders` inchangée (colonnes, contraintes, déclencheurs) ; C5-C7 aucune FK vers la configuration, aucun CHECK énuméré ni iff |
| Régression B1-T-01..16 | tous, sauf T-20/T-22 (traités en TS, ci-dessous) |
| Adversariaux B1-X-01..18 | tous (X-03e MAINTAIN : voir limitations) |
| Non-régression | B1-T-21 (suivi : 14 colonnes), B1-T-23 (ventilation TVA identique avec et sans B1 : `4.90 → 10.00 % : 4.45 HT + 0.45 TVA`), B1-T-24 (`amount = orders.total`) |
| Invariants | B1-I-03 sur toutes les lignes, B1-I-04 dans les deux sens |

### B1-T-16 — formulation clarifiée (arbitrage Ravel / CIO)

L'arbitrage CIO tranche l'ambiguïté du contrat :
- **§8.3 B1-A-01 fait autorité à l'exécution.** Un `pricing_mode` que B1-A-01 ne sait pas encore tarifer fait **échouer** `create_order` (fail-closed).
- **B5 doit mettre à jour le résolveur ET la transcription B1-A-01 atomiquement**, dans la même livraison, avant tout usage de ce mode au checkout.
- **§6.2 est inchangé** : la table ne porte aucun CHECK énuméré.

| Volet | Attendu | Contrôles |
|---|---|---|
| **(a)** | La table accepte isolément un `pricing_mode` non-v1 | B1-T-16a |
| **(b)** | `create_order` rejette un mode inconnu de B1-A-01. Le rejet vient de B1-A-01 (`22023`), pas d'une contrainte de vocabulaire. Le contre-exemple exact de l'audit (`pricing_mode='percentage_b5'`, `delivery_fee=0`) est rejeté. Aucun rejet ne laisse de commande ni de ligne | B1-T-16b-f |
| **(c)** | Simulation B5, dans le harnais seulement, sur une base clone. `create_order` est régénéré avec **une seule** branche ajoutée à B1-A-01, et le résolveur substitué renvoie ce mode avec un frais cohérent. Résultat : le checkout **passe** et l'instantané porte `percentage_b5`. Avec un frais incohérent, le rejet persiste | B1-T-16g-k |

La migration B1 n'est pas modifiée ; (c) ne sert qu'à prouver le chemin B5.

Test de mutation (hors harnais, non commité) : un mutant qui relit la règle depuis `restaurant_sale_mode_fulfillments` au lieu de `v_resolved` est **attrapé par B1-X-10**. Il instantane le nouveau tarif (9.99) à côté d'un frais calculé sur l'ancien (4.90), ce qui reproduit la course de l'Option 2 du contrat. Il est aussi attrapé par C1.

B1-T-20 / B1-T-22 sont couverts par `tests/delivery-pricing-v2-b1-order-snapshot-v1-structural.test.ts` (10/10, en LF comme en CRLF) :
- `CreatedOrder` inchangé ;
- colonnes de `getDashboardOrders` figées (empreinte sha256 prise sur la base) ;
- aucune surface `app/`, `components/` ou `lib/` ne lit l'instantané.

Le même fichier fige aussi :
- le delta unique ancré (corps live + bloc §7.2) ;
- un rollback égal au corps live ;
- l'atomicité ;
- les interdits du contrat : pas de backfill, pas de FK, pas de CHECK énuméré, pas de CHECK iff, pas de déclencheur, résolveur et purge non redéfinis ;
- le §12.

## 6. tsc

`rm -f tsconfig.tsbuildinfo && npx tsc --noEmit` → rc 0, aucune sortie, sur la base comme sur le candidat.

## 7. Suite complète — réconciliation 10 / 14 (B1-EVIDENCE-10-14)

### Cause

Le dossier précédent a été produit dans un **clone git shallow** : `git rev-parse --is-shallow-repository` renvoyait `true`, avec 122 commits disponibles. Trois fichiers de tests comparent l'arbre à des commits de référence **codés en dur** :
- `tests/ob1-non-modification-proof.test.ts:29` : `BASELINE_SHA = "7dde570988105a8522441fda57b75ef68343a769"`, également utilisé par `ob1-harness-allowlist-narrowness-check.test.ts` ;
- `tests/v91-lot2b4a2-structural.test.ts:61` : `LOT_2B4A2_PARENT = "70d69914cd232d018162ddbf2668876a178e879a"`.

Ces commits sont des ancêtres de `497efb9` (`git merge-base --is-ancestor` → vrai), mais ils étaient **absents du clone shallow**. `git diff` y échouait donc sur `fatal: bad object …`. Le log shallow de la base contient 25 occurrences : 21 pour `7dde5709…`, 4 pour `70d69914…`.

Les 4 échecs en plus sont donc des **artefacts d'environnement**, pas des échecs d'assertion.

### Preuve

L'historique complet a été récupéré (`git fetch --unshallow origin`). Les deux commits de référence sont alors présents. La suite a été rejouée sur la base et sur le candidat `722e6360`, avec **les deux invocations** :

| Arbre | Invocation | tests | pass | fail |
|---|---|---|---|---|
| Base `497efb9` | `npm test` (celle de Pauli) | 4446 | 4436 | **10** |
| Base `497efb9` | `npm test -- --test-concurrency=1` | 4446 | 4436 | **10** |
| Candidat `722e6360` | `npm test` | 4456 | 4446 | **10** |
| Candidat `722e6360` | `npm test -- --test-concurrency=1` | 4456 | 4446 | **10** |
| Base, clone **shallow** (dossier précédent) | `--test-concurrency=1` | 4446 | 4432 | 14 |
| Candidat, clone **shallow** (dossier précédent) | `--test-concurrency=1` | 4456 | 4442 | 14 |

Avec l'historique complet, on retrouve **exactement** les chiffres de Pauli (4446 / 4436 / 10), et l'invocation ne change rien. Les ensembles d'identités sont identiques entre base et candidat pour chaque invocation (`suite-identity-diffs.txt`).

### Les 10 échecs de base = liste de Pauli

Identités normalisées de la forme `fichier:ligne | nom`, extraites par `failure-identities.mjs` :

| Pauli | Identités (historique complet, base = candidat) |
|---|---|
| 5 × `ob1-non-modification-proof` | `:201`, `:212`, `:218`, `:233`, `:241` |
| 2 × `v110c-payment-p3a1-structural` | `:179`, `:322` |
| 1 × `v111h-payment-p3a2-structural` | `:221` |
| 1 × `v149-operator-dashboard-context-v1.dom` | `:570` (Scénario 16) |
| 1 × `cfte-v1-customer-name-and-email` | `:1` : échec de chargement du fichier, variables d'environnement Supabase absentes (`lib/supabase.ts:7`) |

### Les 4 écarts du clone shallow

Chacun **passe** avec l'historique complet, sur la base comme sur le candidat :

| Identité | Erreur en shallow | Historique complet |
|---|---|---|
| `ob1-harness-allowlist-narrowness-check.test.ts:68` (EMAIL-V1-OB1-HARNESS-01 negative control) | `fatal: bad object 7dde5709…` | `ok` |
| `ob1-non-modification-proof.test.ts:301` (non-régression DashboardNav / dashboard.ts) | `fatal: bad object 7dde5709…` | `ok` |
| `v91-lot2b4a2-structural.test.ts:128` | `fatal: bad object 70d69914…` | `ok` |
| `v91-lot2b4a2-structural.test.ts:143` | `fatal: bad object 70d69914…` | `ok` |

**Aucun des 14 échecs n'est lié à B1.** Tous existent à l'identique sur la base.

Remarque : les 5 gardes `ob1-non-modification-proof` qui échouent déjà sur la base énumèrent dans leur message tous les fichiers ajoutés depuis `7dde5709`. Les fichiers B1 y apparaissent donc aussi sur le candidat. L'identité de ces échecs (fichier, ligne, nom) ne change pas.

### Environnement et commandes exactes

- **Système** : Ubuntu 24.04.4 LTS, Linux 6.18.44 x86_64 (conteneur cloud) ; Node v22.22.2 ; npm 10.9.7 ; git 2.43.0.
- **Dépendances** : `npm ci` depuis `package-lock.json`.
- **Environnement** : `NODE_OPTIONS=--max-old-space-size=8192` ; aucun `.env.local`, seul `.env.example` est présent, d'où l'échec `cfte-…` ; aucune variable `CI`.
- **Arbres** : chaque arbre est un worktree détaché (`git worktree add --detach <dir> <sha>`) ; `node_modules` est lié symboliquement depuis le clone principal.
- **Commandes** : `npm test > <log> 2>&1` et `npm test -- --test-concurrency=1 > <log> 2>&1`, soit `node --experimental-strip-types --import ./tests/register.mjs --test tests/*.test.ts`.
- **Normalisation** : `node supabase/evidence/delivery-pricing-v2-b1/failure-identities.mjs <log.gz>`.

### Fichiers de `supabase/evidence/delivery-pricing-v2-b1/`

- `suite-{base,cand}-{npmtest,conc1}.log.gz` : logs bruts, historique complet ;
- `suite-shallow-{base,cand}-conc1.log.gz` : logs bruts du dossier précédent (clone shallow) ;
- `*.failures.txt` : identités normalisées ;
- `suite-identity-diffs.txt` : diffs des ensembles ;
- `failure-identities.mjs` : normaliseur ;
- `harness-sql-run.log.gz` : exécution du harnais SQL.

## 8-13. Preuves demandées

| # | Preuve | Contrôles |
|---|---|---|
| 8 | `create_order` = 1 surcharge | G1c, P8a, B1-X-17b/g, B1-T-16g, P-8 dans la migration |
| 9 | signature et retour inchangés | P9a-d (arguments, retour, ACL, `security definer`, `search_path`) |
| 10 | aucun backfill | B1-T-14a-c, B1-X-17i, P-8 (table vide), structurel (aucun `insert … select`) |
| 11 | aucun INSERT/UPDATE/DELETE/TRUNCATE applicatif | B1-X-01..04, B1-X-03b-d (`service_role`), `has_table_privilege` sur 6 privilèges × 3 rôles |
| 12 | édition ou suppression tarifaire sans effet sur l'instantané | B1-T-13a-g, B1-T-12a-g, B1-X-10 |
| 13 | `matched_prefix` conservé comme fait historique | B1-T-05, P13a (`92` dans l'instantané, `92100` dans `delivery_zone`), B1-X-18c (survit à la purge) |

## 14. Limitations explicites

1. **PostgreSQL 16.13 dans le harnais, 17.6 en Production.**
   - Le `revoke maintain` (PG ≥ 17) n'est pas exercé ici : son bloc conditionnel est sans effet, et B1-X-03e est journalisé en INFO, non affirmé.
   - Chateaubriand a constaté en lecture seule que les rôles Production ne sont pas membres de `pg_maintain`.
   - L'égalité des md5 de `pg_get_functiondef` entre 16.13 et 17.6 est constatée, pas garantie par PostgreSQL.
2. **Preuve Production G-1** : fournie par Ravel et recoupée en lecture seule par Chateaubriand. Elle n'a pas été recoupée depuis cet environnement, faute d'accès Supabase.
3. **B1-T-23** est exercée en appliquant `DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql` sur un gabarit, alors que son état en Production n'est pas établi. La preuve montre que B1 n'altère pas la ventilation *si* ce lot est présent.
4. **B1-X-10** force l'entrelacement par un déclencheur de harnais temporaire (`pg_sleep`), retiré ensuite (B1-X-10d). Ce n'est pas une course aléatoire.
5. **B1-T-16 / B5 (arbitrage CIO).**
   - La décision est enregistrée : B1-A-01 fait autorité et échoue fermé sur un mode inconnu.
   - B5 devra étendre résolveur et B1-A-01 **atomiquement**.
   - La faisabilité de cette extension est prouvée par la simulation (c). Cette simulation n'est **pas** livrée par B1, et B1 ne contient rien de B5.
6. **Suite complète** : les chiffres ci-dessus supposent un clone à **historique complet**. En clone shallow, 4 gardes git-diff échouent pour raison d'environnement (§7).
7. **Aucune exécution en Production ou en PREPROD, aucun merge, aucun backfill.** G-2 (Q-B1-2) reste une décision de rétention séparée : `purge_old_customer_data` n'est pas étendue.
