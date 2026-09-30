# Delivery Pricing v2 — B2+B3+B4 audit candidate

Base exacte : `74b83a3cf21784066c3704156cadf80655598df6` (B1 / PR #121).
Branche : `maxwell/delivery-pricing-b234`. SHA/tree candidats publiés dans la PR draft et l’issue orchestrateur. Aucun merge, aucune exécution Production/PREPROD.

Pour un futur déploiement autorisé : installer cette migration après B1 et les colonnes de traduction, puis livrer l’interface.

## Livraison

- B2 : migration `20260930173129_delivery_pricing_b234.sql`, sans nouvelle table métier. Lecture enrichie `get_merchant_delivery_fulfillment_pricing`; nouvelle RPC `mutate_merchant_delivery_rule` (`save` création/édition/désactivation, `move` priorité); nouvelle RPC de lecture `test_merchant_delivery_postcode`.
- B3 : écran existant étendu, saisie de préfixes normalisée, gratuit/fixe/seuil existant, prestataire/libellé, repli, activation, monter/descendre. Relecture serveur après sauvegarde. Erreurs marchandes FR/EN/AR; données de traduction conservées, hash source recalculé par la colonne existante.
- B4 : même `resolve_delivery_fulfillment` que le checkout, appelé en SQL, sans calcul de tarif client ni création de commande. Panier et pays sélectionnables si nécessaire. Réponses tardives invalidées après changement d’entrée ou de tenant.

Owner/manager ou opérateur Scanym peuvent écrire; staff peut lire/tester. Contrôle tenant et authentification dans les RPC, aucun droit direct d’écriture ajouté. L’opérateur fonctionne sans membership. L’ancienne RPC de prix reste disponible, couverte par les mêmes triggers de validation.

Les helpers privés SQL appliquent les décisions **bloquantes** B0, vérifiées contre toutes les fixtures B0 et 160 configurations générées. Aucun calcul de prix n’y figure. Les écritures prennent un verrou transactionnel par tenant; les triggers différés valident l’ensemble final, y compris les changements de pays ou d’activation du mode parent. Les contraintes d’unicité existantes restent actives.

Un ensemble sans règle active reste autorisé : checkout historique inchangé, testeur explicite `legacy`, sans tarif simulé. Une règle non-default active sans zone est refusée. `create_order`, resolver et snapshots B1 ne sont pas modifiés. B5 (remise 50 %, pourcentage, B1-A-01) reste hors périmètre.

## Vérifications

`tsc --noEmit` et `git diff --check` : PASS. Suite ciblée : **52/52**, dont 17 scénarios SQL et 6 parcours React → vrais services → vrai SQL. Les tests couvrent notamment les ACL, les écritures atomiques, les chevauchements, le repli unique, les priorités, les changements de tenant et les snapshots d’une vraie commande B1 après édition/désactivation. Fixtures Au Lait Cru : 6,90 / 10,90 / 13,90 / 15,90 / repli 18,90; pickup gratuit.

Contrôle navigateur local : `75018` → règle dédiée / 6,90; `69001` → Chronofresh / repli / 18,90; aucune erreur ou alerte console capturée. Page et services réels, transport local PGlite, shell de navigation/authentification de démonstration.

Les résultats complets et empreintes SHA-256 se trouvent dans `manifest.json`; `failure-delta.json` compare les **identités** d’échec, pas seulement les comptes. Logs TAP compressés : base exacte, candidat et suite ciblée. Deux assertions v1 interdisant l’édition des zones/prestataires ont été retirées car B234 exige précisément cette capacité; leurs garanties d’autorisation restent testées.

| Suite générale, même environnement Windows / Node 24.18.0 | Total | PASS | FAIL |
| --- | ---: | ---: | ---: |
| Base B1 exacte | 4217 | 4183 | 34 |
| Candidat B234 | 4238 | 4204 | 34 |

**Aucune nouvelle identité d’échec**, aucune retirée. Delta : 23 nouveaux scénarios comportementaux, 2 assertions de périmètre v1 devenues obsolètes retirées. Les fichiers de fixture sont lus avec les fins de ligne exactes de Git (LF), comme sur la copie intacte de la base.

Diagnostic complémentaire du vieux test opérateur v149 : sur des copies temporaires où seul `fflate` est externalisé pour éviter le blocage esbuild local, base et candidat donnent chacun 17/18. Le même scénario 16 attend encore l’interdiction de l’opérateur sans membership, contrat remplacé avant B234. Cette assertion historique n’est pas modifiée; les exports de mock nécessaires au nouvel écran sont ajoutés. La matrice opérateur actuelle v1.2 passe 8/8.

Reproduction après `npm ci` :

```sh
npx tsc --noEmit
node --experimental-strip-types --import ./tests/register.mjs --test --test-reporter=tap --test-concurrency=1 tests/*.test.ts
```

## Limites explicites

- Validation adaptée aux formats numériques fixes L1 (FR 5 chiffres, BE 4). Autre grammaire : erreur explicite, aucune approximation. Pour plusieurs pays, une zone reste valide si atteignable dans au moins un domaine autorisé. Sans pays livrable, la validation est reportée au changement du périmètre de pays.
- Désactivation uniquement, pas de suppression physique. Repli unique y compris désactivé, conformément à l’index existant. Pas de migration/backfill des anciens snapshots ni de scan bloquant de tous les tenants à l’installation.
- PGlite exécute le PostgreSQL réel et la chaîne B1; les tables/helpers d’auth sont ceux du harnais B1. Le DDL exact des traductions de fulfillment est rejoué seul, les prérequis catalogue sans rapport étant absents. Aucun test PostgREST/JWT distant ni de concurrence PostgreSQL multi-session; le verrou est destiné au niveau d’isolation READ COMMITTED de la RPC.
- Suite générale non verte sur la base Windows : restrictions de résolution esbuild, configuration Supabase absente dans un ancien test, assertions historiques de chemins/inventaires/périmètre Git. Ces limites et le delta exact sont conservés dans les preuves. Pas de validation sur Production/PREPROD.
