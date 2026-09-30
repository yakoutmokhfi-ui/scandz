# DELIVERY PRICING v2 — B1 — ORDER DELIVERY FULFILLMENT SNAPSHOT v1 — dossier de preuves

Candidat à l'audit indépendant. **DRAFT — non appliqué en Production ni en PREPROD. Non mergé.**

| | |
|---|---|
| Mandat | `yakoutmokhfi-ui/scanym-orchestrator` issue #17, `IMPLEMENTATION_GO` (Ravel / CIO) |
| Contrat | Debussy, `DESIGN APPROVED — READY FOR IMPLEMENTATION`, CONTRACT_SHA256 `aac856732ff48aef5b69bcf6c65fb91a88754e95756587512ed0b453e28ec517` (recalculé : les deux commentaires de l'issue réassemblés donnent exactement ce hash) |
| Base | `497efb9af3288ae63d2bed500b361a3dab9a7f8c`, tree `faf1d51e5ff437dc465e6e7085329a588a843d26` |
| Candidat | SHA du commit et tree : voir la PR (un fichier ne peut pas contenir le SHA du commit qui l'introduit) |

## 1-2. Fichiers modifiés

Uniquement des ajouts ; aucun fichier existant modifié, aucun code applicatif TS modifié.

```
A  supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql
A  supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1-ROLLBACK.sql
A  supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1-EVIDENCE.md
A  supabase/tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh
A  tests/delivery-pricing-v2-b1-order-snapshot-v1-structural.test.ts
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

**147 PASS / 0 FAIL.** Commande : `su postgres -c "bash supabase/tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh"`.

| Groupe | Contrôles |
|---|---|
| Ancrage G-1 | G1a-c |
| Migration, contrat `create_order` | M1, P8a, P9a-d |
| Corps inchangé hors delta | C1 : `prosrc` post-B1 privé du seul bloc §7.2 = `prosrc` pré-B1 octet pour octet ; C2 résolveur inchangé ; C3 aucune autre fonction publique modifiée ; C4 `orders` inchangée (colonnes, contraintes, déclencheurs) ; C5-C7 aucune FK vers la configuration, aucun CHECK énuméré ni iff |
| Régression B1-T-01..16 | tous, sauf T-20/T-22 (traités en TS, ci-dessous) |
| Adversariaux B1-X-01..18 | tous (X-03e MAINTAIN : voir limitations) |
| Non-régression | B1-T-21 (suivi : 14 colonnes), B1-T-23 (ventilation TVA identique avec et sans B1 : `4.90 → 10.00 % : 4.45 HT + 0.45 TVA`), B1-T-24 (`amount = orders.total`) |
| Invariants | B1-I-03 sur toutes les lignes, B1-I-04 dans les deux sens |

Test de mutation (hors harnais, non commité) : un mutant qui relit la règle depuis `restaurant_sale_mode_fulfillments` au lieu de `v_resolved` est **attrapé par B1-X-10**. Il instantane le nouveau tarif (9.99) à côté d'un frais calculé sur l'ancien (4.90). C'est la course de l'Option 2 du contrat, reproduite. Il est aussi attrapé par C1.

B1-T-20 / B1-T-22 sont couverts par `tests/delivery-pricing-v2-b1-order-snapshot-v1-structural.test.ts` (10/10) :
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

## 7. Suite complète — delta d'identités d'échec

`npm test -- --test-concurrency=1` :

| | tests | pass | fail |
|---|---|---|---|
| Base `497efb9` | 4446 | 4432 | 14 |
| Candidat | 4456 | 4442 | 14 |

Les identités d'échec sont **identiques** (`diff` vide, 17 lignes `not ok` dont les sous-tests). Aucune nouvelle identité d'échec. Les 14 échecs préexistants sont des gardes git-diff ou de périmètre d'autres lots, rouges sur la base elle-même. B1 ajoute 10 tests, tous verts.

## 8-13. Preuves demandées

| # | Preuve | Contrôles |
|---|---|---|
| 8 | `create_order` = 1 surcharge | G1c, P8a, B1-X-17b/g, P-8 dans la migration |
| 9 | signature et retour inchangés | P9a-d (arguments, retour, ACL, `security definer`, `search_path`) |
| 10 | aucun backfill | B1-T-14a-c, B1-X-17i, P-8 (table vide), structurel (aucun `insert … select`) |
| 11 | aucun INSERT/UPDATE/DELETE/TRUNCATE applicatif | B1-X-01..04, B1-X-03b-d (`service_role`), `has_table_privilege` sur 6 privilèges × 3 rôles |
| 12 | édition ou suppression tarifaire sans effet sur l'instantané | B1-T-13a-g, B1-T-12a-g, B1-X-10 |
| 13 | `matched_prefix` conservé comme fait historique | B1-T-05, P13a (`92` dans l'instantané, `92100` dans `delivery_zone`), B1-X-18c (survit à la purge) |

## 14. Limitations explicites

1. **PostgreSQL 16.13 dans le harnais, 17.6 en Production.**
   - Le `revoke maintain` (PG ≥ 17) n'est pas exercé ici : son bloc conditionnel est sans effet, B1-X-03e est journalisé en INFO et non affirmé.
   - L'égalité des md5 de `pg_get_functiondef` entre 16.13 et 17.6 est constatée, pas garantie par PostgreSQL.
2. **La preuve Production G-1 (md5, signatures) est celle fournie par Ravel.** Elle n'a pas été recoupée directement : aucun accès Supabase depuis cet environnement.
3. **B1-T-23 est exercée en appliquant `DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql` sur un gabarit.** Son état en Production n'est pas établi. La preuve montre que B1 n'altère pas la ventilation *si* ce lot est présent.
4. **B1-X-10** force l'entrelacement par un déclencheur de harnais temporaire (`pg_sleep`), retiré ensuite (B1-X-10d). Ce n'est pas une course aléatoire.
5. **B1-T-16, constat à porter au contrat B5.**
   - Aucune contrainte de vocabulaire ne bloque l'écriture (B1-T-16a).
   - En revanche, un `pricing_mode` inconnu de la formule v1 fait **toujours** lever B1-A-01 (B1-T-16b/c), puisque le frais ne peut pas être corroboré.
   - B5 devra donc étendre la transcription B1-A-01 en même temps que le résolveur. Sinon le checkout échoue fermé pour le nouveau mode.
   - C'est conforme au §8.3 (« elle échoue si `resolve_delivery_fulfillment` est un jour modifié sans que B1 le soit »), mais c'est dit ici explicitement.
6. **Aucune exécution en Production ou en PREPROD, aucun merge, aucun backfill.** G-2 (Q-B1-2) reste une décision de rétention séparée : `purge_old_customer_data` n'est pas étendue.
