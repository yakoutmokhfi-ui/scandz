# MERCHANT CUSTOMER COMMUNICATIONS v1.1 — paquet de preuves
## Recomposition sur `origin/main` courant

Ce paquet accompagne le candidat **`197529defa0939fc316148edf40e2811e89400ed`**, qui
repose sur `origin/main` courant **`6a5d226`**. Il remplace le paquet du
candidat `bfcd3a0` (base `7bbb70b`), dont le re-audit indépendant a conclu
**PASS** et qui reste intact sur sa branche d'origine.

---

## §0 — Ce que cette recomposition est, et ce qu'elle n'est pas

Elle **n'est pas** une nouvelle version du lot. Les 44 fichiers
d'implémentation sont repris **octet pour octet** depuis le candidat audité :
même empreinte de blob git, un par un, 0 divergence sur 44. Aucune
fonctionnalité nouvelle, aucun redesign, aucun refactor hors périmètre.

Elle **est** le même code posé sur un contexte plus récent. `main` a avancé
de 3 commits depuis la base auditée, en n'ajoutant que des fichiers (lot
*Au Lait Cru delivery zone remediation v1* : un DRAFT SQL et son rollback,
un paquet de preuves, deux fichiers sous `supabase/tests/`). Aucun de ces
22 fichiers ne figure parmi les 44 du lot, et aucun des 26 fichiers que ce
lot **modifie** n'a été touché par `main` — leur blob est identique entre
`7bbb70b` et `6a5d226`, vérifié un par un. La recomposition est donc sans
conflit *par construction*, et pas seulement en pratique.

Deux méthodes indépendantes le prouvent, et elles concordent :

1. **identité de blob**, fichier par fichier (`equivalence-vs-audited-candidate.txt`) ;
2. **rebase réel** : `git rebase --onto 6a5d226 7bbb70b bfcd3a0` dans un
   clone jetable se termine sans conflit et produit un arbre qui ne diffère
   de celui du candidat recomposé par **aucun** fichier hors paquet de
   preuves.

---

## §1 — Comportement audité préservé

| Propriété auditée | Fichier | Preuve |
|---|---|---|
| garde génération + identité de commande sur l'éligibilité de rétractation | `components/MenuView.tsx` | blob identique ; 5 tests `[RACE-1..5]` |
| cartographie événement → gabarit spécifique, miroir SQL/TS | `lib/communications/events.ts`, `notification-worker.ts`, DRAFT SQL | blobs identiques ; `§EVENT-TEMPLATE-1..7`, `MIRROR-7/8`, `§[14]` du harnais |
| modèle de sûreté du harnais PostgreSQL | les deux scripts `supabase/tests/` | blobs identiques ; 47 preuves comportementales |
| tout le comportement MCC v1 déjà audité | les 44 fichiers | 169 tests dédiés, 101 preuves SQL |

---

## §2 — Résultats mesurés sur le candidat recomposé

| Vérification | Résultat |
|---|---|
| tests MCC dédiés | **169 / 0** (32 + 28 + 21 + 5 + 41 + 42) |
| TypeScript `tsc --noEmit` | **0 diagnostic** |
| build (env de substitution) | base **EXIT 0**, candidat **EXIT 0** ; +1 route (`/api/checkout/withdrawal-eligibility`, celle du lot), 0 retirée |
| harnais PostgreSQL du lot | **101 preuves / 0 échec** |
| harnais de sûreté | **47 preuves / 0 échec** |
| refus sans consentement | **EXIT 2**, aucune opération destructive tentée |
| suite complète, base `6a5d226` | 4632 réussites / 10 échecs |
| suite complète, candidat recomposé | **4768 réussites / 10 échecs** |
| identités d'échec | **0 apparue, 0 disparue** |

Les **quatre** jeux d'identités d'échec — base auditée `7bbb70b`, candidat
audité `bfcd3a0`, base courante `6a5d226`, candidat recomposé — sont
**octet-identiques** (md5 `d788b58cd63f6c59be1b1195c76bc1c5`). Les 10 échecs
sont les 10 échecs préexistants du dépôt : ni plus, ni moins, ni autres.
Les comptes ne sont jamais invoqués seuls ; les quatre listes sont dans ce
paquet et se comparent au `diff`.

Premiers chargements, base → candidat : `/r/[slug]` 243 → 248 kB,
`/dashboard/settings` 229 → 234 kB, `/track/[orderId]` 153 → 155 kB. Les
valeurs **absolues** sont celles du candidat audité : l'empreinte du lot
n'a pas bougé en recomposant.

---

## §3 — Observations non bloquantes relevées en vérifiant

Elles sont consignées ici parce qu'elles sont vraies, et qu'un auditeur
doit pouvoir les trouver sans les redécouvrir. Aucune ne remet en cause le
comportement livré.

1. **Deux des cinq tests de course ne discriminent pas la course.** Un
   contrôle de mutation indépendant (garde de péremption et trois
   comparaisons d'identité retirées du composant réel) fait bien échouer
   `[RACE-1]` et `[RACE-2]` — les deux scénarios que le mandat nomme — mais
   laisse `[RACE-3]` et `[RACE-4]` au vert : ce sont des tests
   d'appartenance et de remise à zéro, pas des tests de course.
2. **La moitié « remise à zéro » de `closeConfirmation()` n'est couverte
   par aucun test en échec.** En ne gardant que l'incrément de génération
   et en retirant l'effacement de la preuve et de l'identité, les cinq
   tests restent verts. L'incrément suffit en effet à rendre orpheline
   toute réponse en vol : l'effacement est une défense redondante. Elle est
   donc correcte mais non gardée — une suppression future passerait
   inaperçue.
3. **Le filtre de noms protégés du harnais sur-refuse.** `(prod|production|live|preprod|staging|recette)`
   en correspondance partielle : une base nommée `delivery_test` contient
   `live` et fait refuser le cluster. Le sens du refus est le bon (refuser
   plutôt que détruire), et la correction n'appartient pas à ce lot.
4. **Le mode « cluster désigné » ne prouve pas l'identité du serveur.** La
   preuve `data_directory` n'est exigée que si le harnais a créé le
   cluster lui-même ; avec `SCANYM_HARNESS_PGHOST`, l'opérateur se porte
   garant, et il ne reste que socket UNIX absolue, serveur local,
   superutilisateur et balayage des noms protégés. C'est la limite propre
   à ce mode, héritée du harnais de référence Translations v2.3.
5. **`[RACE-5]` dépend d'une chaîne source exacte.** Le contrôle négatif
   cherche littéralement la ligne de garde dans `MenuView.tsx` ; un
   reformatage de cette ligne ferait échouer le test. L'échec serait
   bruyant, donc du bon côté.
6. **Deux gabarits d'événement sont dans la projection publique anon.**
   `confirmation_delivery_carrier` et `confirmation_delivery_local` sont
   lisibles par `anon`, parce que l'écran de confirmation les affiche
   aussi ; `confirmation_withdrawal_request` ne l'est pas. C'est documenté
   et voulu, mais c'est une asymétrie qu'un auditeur doit connaître.
7. **Le nouveau test de `main` n'est pas exécuté par la suite.**
   `supabase/tests/au-lait-cru-delivery-zone-remediation-v1.test.mjs` ne
   correspond pas au motif `tests/*.test.ts` de `npm test` : c'est pourquoi
   la suite compte exactement autant de tests sur `6a5d226` que sur
   `7bbb70b`. Signalé, non corrigé — élargir le motif serait un refactor
   hors périmètre de ce lot.

---

## §4 — Contenu du paquet

| Fichier | Contenu |
|---|---|
| `manifest.json` | identités, delta de main, preuve d'équivalence, résultats |
| `CANDIDATE.txt` | identités et les trois contrôles de l'auditeur |
| `equivalence-vs-audited-candidate.txt` | les 44 empreintes de blob, les deux méthodes |
| `main-delta-7bbb70b-to-6a5d226.txt` | ce que `main` a apporté, et l'absence de recoupement |
| `implementation-vs-base.patch` | les 44 fichiers du lot vs `6a5d226` |
| `targeted.tap.gz` | TAP des 6 fichiers de tests dédiés |
| `baseline.tap.gz`, `candidate.tap.gz` | TAP des deux suites complètes |
| `baseline-failures-sorted.txt`, `candidate-failures-sorted.txt` | identités d'échec, base courante et candidat |
| `previous-baseline-failures-sorted.txt`, `audited-candidate-failures-sorted.txt` | les mêmes, rejouées sur `7bbb70b` et `bfcd3a0` |
| `sql-harness.txt` | 101 preuves PostgreSQL |
| `harness-safety.txt` | 47 preuves de sûreté |
| `harness-refusal-no-consent.txt` | le refus sans consentement, capturé |
| `build-baseline.txt`, `build-candidate.txt` | les deux builds |
| `typescript.txt` | `tsc --noEmit` |
| `SHA256SUMS.txt` | empreintes de tous les fichiers ci-dessus |

---

## §5 — Limites

SQL **DRAFT** uniquement : rien n'a été appliqué à un Supabase hébergé.
Aucun merge, aucun déploiement, aucun PREPROD, aucune mutation
Production/Vault, aucun e-mail fournisseur. Le candidat n'est pas poussé :
le proxy git de la session refuse l'écriture sur ce dépôt (403, `GH_TOKEN`
invalide) ; la lecture fonctionne, comme le prouve le `fetch` de `main` à
l'origine de cette recomposition.
