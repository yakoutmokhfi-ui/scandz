# CATALOGUE PRODUCT REORDER v1.1 — recomposition sur main courant

Paquet de preuves du mandat **VIVALDI — INTEGRATION / RECOMPOSITION — LOT:
CATALOGUE PRODUCT REORDER v1.1**.

| | |
|---|---|
| Candidat audité (source) | `46bc04f2905fde2b652c5ea0535f4090ce17bcbd` — arbre `ed142021a0a00322a5e39890aa4eb3698905955e` |
| Verdict d'audit | PASS WITH NON-BLOCKING OBSERVATIONS — CPR-AUDIT-01 CLOSED, CPR-AUDIT-02 CLOSED |
| Main courant (base) | `2f45df7717b16b08075b51aabf9cec4afd4b2741` — contient THEME & CONTENT SETTINGS v1 |
| **Candidat intégré** | **`bc045f28b08d11e896dd3b84874cbbf428acc608`** — arbre `f4d70c5aa1fdb9d90fe5356c10f13823663aa381` |
| Branche | `feature/catalogue-product-reorder-v1-integration` (créée depuis `2f45df7`) |
| Statut | **READY FOR INTEGRATION AUDIT** |

La branche porte trois commits au-dessus de main :

1. `b081cec` — **recomposition pure** : le candidat audité réappliqué sur
   main courant ;
2. `bc045f2` — **candidat intégré** : le harnais PostgreSQL rejoue la chaîne
   de main courant (THEME) ; seul écart d'intégration ;
3. le commit de tête scelle ce paquet et ne touche que
   `supabase/evidence/catalogue-product-reorder-v1.1/`.

**Rien n'a été fusionné, rien n'a été déployé, aucun SQL n'a été exécuté sur
une base hébergée, aucune PR n'a été ouverte. L'historique de main n'est pas
réécrit.**

Les paquets de la branche d'audit `feature/catalogue-product-reorder-v1`
(`catalogue-product-reorder-v1/` pour le candidat refusé, puis
`catalogue-product-reorder-v1.1/` pour le candidat audité, tête `5364c8a`) n'y
sont pas repris : ils restent consultables sur cette branche. Ce paquet-ci est
entièrement régénéré depuis le candidat intégré.

---

## §1 — Recomposition

**Aucun redesign, aucune fonctionnalité nouvelle, aucun refactor hors
périmètre.** Le lot compte 28 fichiers d'implémentation (16 modifiés, 12
ajoutés par rapport à main).

| | Fichiers | Preuve |
|---|---|---|
| Repris **octet pour octet** du candidat audité | **26** | même empreinte de blob git (`equivalence-vs-audited-candidate.txt`, méthode 1) |
| Fusion à trois voies sans conflit | 1 — `lib/i18n.ts` | seul fichier touché par les deux lots (§2) |
| Étendu pour l'intégration | 1 — `supabase/tests/catalogue-product-reorder-v1-check.sh` | chaîne de main courant + preuves d'interaction (§2) ; +128 / −3 |

Sont donc **identiques au candidat audité**, entre autres : les deux fichiers
SQL (DRAFT et ROLLBACK), l'écran `app/dashboard/catalogue/page.tsx`, la
logique pure, le service, le comparateur de la carte client, la bibliothèque
de sûreté du harnais, les sondes HARNESS-01..08, le modèle du contrat RPC et
**les trois fichiers de test du lot** (135 tests).

**Contre-épreuve.** Les deux commits fonctionnels de la branche d'audit
(`a118522` puis `46bc04f`) ont été appliqués par un `git cherry-pick` réel sur
`2f45df7` : **0 conflit**, et l'arbre obtenu est **le même arbre git**
(`e0c27a032bc62e042f09e15bb4965e3f05f78879`) que celui de la recomposition pure
`b081cec`.

**Précondition vérifiée fichier par fichier**
(`main-delta-412dbb5-to-2f45df7.txt`) : sur les 28 fichiers du lot, 15 ont un
blob identique entre l'ancienne base `412dbb5` et main courant, 12 sont
absents des deux (ajouts du lot), 1 seul a été modifié par main :
`lib/i18n.ts`.

### Conflits rencontrés

**Aucun conflit textuel.** Un seul fichier était concurrent, et sa fusion est
automatique.

---

## §2 — Interaction avec THEME & CONTENT SETTINGS v1

Main a apporté 35 fichiers (2 commits). `theme-interaction.txt` donne le
détail vérifié ; en résumé :

| Point demandé | Constat |
|---|---|
| `app/dashboard/catalogue/page.tsx` | **non touché par THEME** (blob de main = blob de l'ancienne base) ; le blob intégré est celui du candidat audité. L'écran que THEME modifie est `app/dashboard/settings/page.tsx`, que ce lot ne touche pas : blob intégré = blob de main |
| `lib/i18n.ts` | THEME +48 lignes, ce lot +37 lignes, **aucune ligne retirée**, emplacements disjoints. Le fichier intégré est exactement « main + les 37 lignes de ce lot » **et** exactement « candidat audité + les 48 lignes de THEME ». Par langue (fr / en / ar) : 763 clés de base + 16 (THEME) + 11 (ce lot) = 790, aucune clé commune, aucun doublon |
| Dépendances | `package.json` et `package-lock.json` identiques dans la base, main, le candidat audité et le candidat intégré |
| Tests catalogue / dashboard | aucun fichier de test n'est commun aux deux lots ; les tests de THEME (`theme-content-settings-v1*.test.ts`, `settings-save-reliability-v1.dom.test.ts`, `mcc-v1-*.test.ts`) passent sur le candidat intégré comme sur main (§4) |
| Imports | aucun des 12 fichiers source de THEME ne référence un symbole de ce lot ; aucun des 6 fichiers source de ce lot ne référence un symbole de THEME |
| Fichiers de main | aucun supprimé ni renommé ; les 16 fichiers de main modifiés par le candidat intégré sont tous des fichiers de ce lot ; le seul fichier de THEME dont le blob diffère de main est `lib/i18n.ts` |

### SQL

Les deux fichiers SQL du lot sont **octet pour octet** ceux du candidat
audité. Ils restent des DRAFT, jamais appliqués sur une base hébergée.

Le SQL de THEME crée ou remplace : `restaurant_configs.theme_tokens`, quatre
fonctions `theme_token*`, `update_restaurant_theme_tokens`, et les trois
fonctions de catalogue MCC (`communication_text_keys`,
`public_communication_text_keys`, `communication_text_max_length`). Le SQL de
ce lot crée **une** fonction, `move_product_order`. **Aucun objet commun** ;
aucun des deux fichiers ne mentionne les objets de l'autre.

Le harnais PostgreSQL réel rejoue désormais la chaîne de main courant, THEME
compris, et le prouve par l'exécution (`sql-harness.txt`, 298 preuves) :

| Confirmation demandée | Preuves |
|---|---|
| L'anti-dérive vise toujours le bon schéma courant | le lot s'applique sur la chaîne complète de main (`1a`) ; les 11 cas de dérive sont toujours refusés sans rien créer (`15a`…`15k`) |
| Aucun objet de THEME n'est écrasé | `0c`, `1h` : catalogue MCC 17/14, 7 jetons, colonne, RPC — avant et après ; `1i` : empreinte de **tout** le schéma public hors `move_product_order` (fonctions avec leur définition complète et leurs ACL, colonnes, contraintes, policies, index, triggers, droits, RLS) identique avant et après |
| Aucun catalogue de fonctions MCC / THEME remplacé | `1f` (nom, signature et corps de toutes les fonctions préexistantes), `1i`, `17k` |
| Le rollback reste valide sur le schéma courant | `16a`…`16j` sur la chaîne de main ; `16e-bis` : après rollback, tout le schéma public revient à l'empreinte d'avant ; `16e-ter` : THEME intact |
| **Indépendance** (section 17, 30 preuves) | ce lot s'applique **sans** THEME (`17e`) et y installe la même fonction (`17g`) ; THEME s'applique avec ce lot **déjà installé** (`17i`) ; les deux ordres d'application aboutissent au **même schéma** (`17l`) ; les deux RPC d'écriture coexistent sans se toucher (`17o`…`17s`) ; rollback de THEME avec ce lot installé (`17t`…`17v`) ; rollback de ce lot avec THEME installé (`17aa`…`17ac`) ; les deux rollbacks ramènent exactement le schéma d'avant (`17y`) |

Aucune des 263 preuves auditées n'est modifiée ni retirée : elles s'exécutent
simplement sur le schéma de main courant. Le harnais d'origine, inchangé,
passe lui aussi sur la recomposition pure (263 / 0).

**THEME INTERACTION : PASS.**

---

## §3 — Ce que fait le lot (comportement audité, inchangé)

- **Ordre.** Colonne existante `menu_items.display_order`. Aucune colonne,
  aucun flottant, aucun backfill. Un déplacement échange deux voisins et
  renumérote le périmètre en positions entières denses 1..N.
- **Périmètre.** La sous-catégorie du produit, sinon les produits directs de
  sa catégorie (non archivés).
- **Écran.** Tri « Ordre de la carte » ; boutons Monter / Descendre, bornes
  désactivées, focus conservé, annonce `aria-live` ; aucun glisser-déposer.
- **Fraîcheur (CPR-AUDIT-01).** `move_product_order(uuid, text, jsonb)`.
  L'écran renvoie, inchangée, la vue reçue du serveur :
  `[{ id, display_order, name }]` dans l'ordre affiché. Sous verrou, le
  serveur exige le même ensemble exact d'identifiants et, pour chaque
  produit, `display_order` et `name` égaux à l'état stocké (`name` octet pour
  octet). Tout écart : `SCANYM_PRODUCT_ORDER_STALE`, **aucune écriture**.
- **Concurrence.** Verrou transactionnel d'établissement, puis
  `FOR NO KEY UPDATE` sur tout le périmètre, avant la validation.
- **Isolation.** Établissement dérivé du produit (`assert_product_role`,
  owner / manager, ou opérateur ; jamais staff).
- **Carte client.** Un seul comparateur, extrait et partagé ; non modifié par
  la recomposition.
- **XLSX.** Contrat de colonnes inchangé ; l'export complet suit l'ordre
  persisté ; l'import n'écrit jamais l'ordre d'un produit existant.
- **Sûreté du harnais (CPR-AUDIT-02).** Consentement explicite ; refus par
  nom seul des variables de connexion héritées ; cluster créé par l'exécution
  (socket privé, aucune écoute réseau) ; identité du serveur prouvée sur la
  même connexion avant chaque `CREATE` / `DROP DATABASE` ; registre des bases ;
  nettoyage sans connexion, borné au répertoire marqué.
- **Chargement du test DOM.** Tout paquet importé est externalisé et chargé
  par Node ; esbuild ne lit rien dans `node_modules`.

---

## §4 — Résultats mesurés sur `bc045f2`

| Mesure | Résultat |
|---|---|
| 135 tests dédiés (`dedicated.tap.gz`) | **135 / 135** — 61 logique et structure, 37 RPC réelle (PGlite), 37 écran réel |
| Harnais PostgreSQL réel (`sql-harness.txt`) | **298 PASS, 0 FAIL** — les 263 preuves auditées + 35 d'intégration ; 58 preuves de fraîcheur (8F), 33 de concurrence en sessions parallèles (9A–9E) |
| Sondes de sûreté HARNESS-01..08 (`harness-safety.txt`) | **92 PASS, 0 FAIL, 0 SKIP** (appât « emplacement par défaut » actif) |
| Tests ciblés, 38 fichiers (`targeted.tap.gz`) : catalogue, XLSX, contexte d'établissement, DOM, **THEME et MCC** | 816 tests, 815 PASS, 1 FAIL — l'échec est une identité de main (« Scénario 16 — Delivery pricing ») |
| Même jeu sur main, sans les 3 fichiers du lot (`targeted-baseline.tap.gz`) | 681 tests, 680 PASS, 1 FAIL — la même identité ; 816 − 681 = 135 |
| CPR-AUDIT-01, scénario de l'audit (`audit-reproduction.txt`) | candidat refusé : ACCEPTÉ, ordre écrasé ; candidat intégré : `SCANYM_PRODUCT_ORDER_STALE`, aucune écriture |
| Chargement du test DOM sans résolution de `fflate` par esbuild (`dom-fflate-resolution-simulation.txt`) | candidat refusé 0 / 1 (fichier non chargé) ; candidat intégré 37 / 37 |
| TypeScript (`typescript.txt`) | main **0**, candidat **0** |
| Build `next build`, env de substitution | main **EXIT 0**, candidat **EXIT 0** ; 38 routes de part et d'autre, aucune ajoutée ni retirée ; `/dashboard/catalogue` 14,9 → 16,6 kB ; `/dashboard/settings` (THEME) 12,7 kB des deux côtés |
| Suite complète, main `2f45df7` | 4 856 tests, **4 846 PASS, 10 FAIL** |
| Suite complète, candidat `bc045f2` | 4 991 tests, **4 981 PASS, 10 FAIL** |
| Identités d'échec | **identiques** : 0 apparue, 0 disparue |
| Tests de main absents du candidat | **0** ; 135 tests en plus, tous du lot |

### Les neuf rubriques du mandat

| Rubrique | Verdict | Sur quoi il repose |
|---|---|---|
| THEME INTERACTION | **PASS** | §2 |
| PRODUCT REORDER BEHAVIOR PRESERVED | **PASS** | 26 fichiers sur 28 au même blob que le candidat audité, dont l'écran, le SQL et les trois fichiers de test ; 135 / 135 |
| CPR-AUDIT-01 REGRESSION | **PASS** | SQL et tests identiques ; dix cas du mandat à trois niveaux ; modèle == SQL réel sur 600 scénarios ; 13 mutants tués sur 15, 2 équivalents |
| CPR-AUDIT-02 REGRESSION | **PASS** | bibliothèque et sondes identiques ; 92 / 0 ; 14 mutants tués sur 14 |
| TENANT ISOLATION | **PASS** | section 6 du harnais ; tests `ISOLATION` et `RÔLES` |
| STOREFRONT ORDER | **PASS** | tests `[A]`, section 11 ; `lib/services/restaurant.ts` non touché par aucun des deux lots |
| XLSX CONTRACT | **PASS** | tests `[H]`, `[G] NON-RÉGRESSION EXPORT` ; aucun fichier d'import / export modifié par THEME |
| SQL ANTI-DRIFT | **PASS** | section 15 sur la chaîne de main courant ; `17e` |
| ROLLBACK | **PASS** | section 16 ; `16e-bis`, `17t`…`17ad` |

---

## §5 — Identités d'échec : quatre jeux

| Jeu | Tests | FAIL | md5 de la liste triée |
|---|---|---|---|
| Ancienne base `412dbb5` (`previous-baseline-failures-sorted.txt`, repris du paquet audité) | 4 778 | 10 | `d788b58cd63f6c59be1b1195c76bc1c5` |
| Candidat audité `46bc04f` (`audited-candidate-failures-sorted.txt`, repris du paquet audité) | 4 913 | 10 | `d788b58cd63f6c59be1b1195c76bc1c5` |
| **Main courant `2f45df7`** (`baseline-failures-sorted.txt`) | 4 856 | 10 | `d788b58cd63f6c59be1b1195c76bc1c5` |
| **Candidat intégré `bc045f2`** (`candidate-failures-sorted.txt`) | 4 991 | 10 | `d788b58cd63f6c59be1b1195c76bc1c5` |

Les quatre listes sont identiques. THEME a ajouté 78 tests à main
(4 778 → 4 856) sans changer ses dix identités ; ce lot en ajoute 135 sans en
changer aucune.

**Tests DOM intermittents de la base — à lire avant une contre-exécution.**
Le paquet du candidat audité (`stability/README.txt`, branche d'audit) a
établi que quelques tests DOM à temporisation, préexistants et sans rapport
avec ce lot, échouent par intermittence — **y compris sur la base
inchangée** (`gap-01-withdrawal-requests-backoffice`, 13 échecs sur 30 en
isolement sur la base, 12 sur 30 sur la branche ;
`tracking-freshness-v1-audit-remediation [E4]` ;
`v155-admin-catalogue-import-entry-point`). Une suite complète peut donc
montrer un ou deux échecs de plus que les dix identités. Les deux exécutions
de référence de ce paquet n'en ont montré aucun. Ce n'est pas une régression
de ce lot si le fichier n'est pas modifié par la branche et si le test se
comporte de même sur main.

---

## §6 — Contrôles de mutation (`mutation/`, régénérés sur le candidat intégré)

Chaque mutant vit dans une copie du dépôt ; le dépôt n'est jamais modifié.

**SQL — 15 mutants du contrôle de fraîcheur** : 13 tués par les preuves
comportementales (PGlite et PostgreSQL réel), 2 survivants **équivalents**
(M07 : garde de coût, la charge de mauvaise taille est de toute façon refusée
par le contrôle de cardinalité ; M13 : test de type que rien ne peut franchir).
Résultats identiques, mutant par mutant, à ceux du paquet audité.

**Bibliothèque de sûreté — 14 mutants, 14 tués** par les sondes
HARNESS-01..08.

---

## §7 — Limites connues et points d'attention

Écarts propres à la recomposition :

1. **Le harnais n'est plus octet pour octet celui du candidat audité** (§1).
   C'est un choix : confirmer l'anti-dérive et le rollback « sur le schéma
   courant » demande de rejouer la chaîne de main, THEME compris. Le diff
   complet est dans `equivalence-vs-audited-candidate.txt` §4 ; il n'ajoute
   que des preuves.
2. **L'en-tête du DRAFT SQL nomme toujours `412dbb5` comme base requise.**
   Les deux fichiers SQL sont volontairement laissés identiques au candidat
   audité (même empreinte) : la mention reste exacte comme prérequis minimal —
   le lot ne dépend pas de THEME (`17e`) — et la modifier aurait changé
   l'empreinte d'un fichier audité pour un commentaire.
3. **Les observations non bloquantes de l'audit ne figurent pas dans le
   mandat de recomposition.** Aucune n'a donc été traitée ici ; le
   comportement audité est repris tel quel.
4. **Aucun test permanent d'interaction n'a été ajouté côté `npm test`.** Les
   vérifications croisées (clés i18n, imports, objets SQL) sont des constats
   datés, consignés dans `theme-interaction.txt`. Chaque lot garde ses propres
   tests ; l'interaction SQL, elle, est prouvée à chaque exécution du harnais
   (section 17).

Limites héritées du candidat audité, inchangées :

5. **Pas d'exécution sous Windows.** Le chargement du test DOM sans
   résolution de `fflate` par esbuild est prouvé par simulation du symptôme.
6. **Ordre entre ex æquo d'un état frais** : il reste celui que l'appelant
   affiche (le départage de la carte client est du JavaScript que SQL ne
   reproduit pas à l'identique). Il ne peut plus venir d'un état périmé.
7. **Sévérité assumée** : un renommage ou une renumérotation dans le
   périmètre périme la vue même si l'ordre visible n'a pas bougé ;
   `display_order` est comparé textuellement (`3.0` n'est pas `3`).
8. **Création strictement simultanée à un déplacement — fenêtre résiduelle,
   non fermée.** Une insertion, ou l'arrivée d'un produit venu d'une autre
   sous-catégorie, validée entre la validation d'un déplacement et son
   `commit` n'est bloquée par aucun verrou de ligne : `create_product` et
   `update_product` ne prennent pas le verrou d'établissement, et ce lot
   s'interdit de les redéfinir. Les deux opérations réussissent ; dans une
   catégorie historique aux valeurs basses, le nouveau produit peut se
   retrouver ex æquo avec un produit renuméroté au lieu d'être dernier,
   jusqu'au déplacement suivant. Aucun ordre validé n'est écrasé. La fermer
   demande que ces deux RPC participent au verrou : décision hors périmètre.
9. **Le harnais exige des binaires PostgreSQL locaux et un utilisateur non
   root** ; il ne sait pas s'exécuter contre un serveur existant.
10. **PGlite n'a qu'une connexion** : dans `npm test`, la concurrence est
    rejouée par entrelacements ; le blocage réel de sessions parallèles est
    prouvé par le harnais PostgreSQL.
11. **Le modèle du contrat ne couvre pas l'autorisation**, qui précède tout
    et est prouvée sur le SQL réel.
12. **Ordre d'installation.** SQL d'abord, application ensuite. Dans l'ordre
    inverse, un clic sur Monter / Descendre affiche le message d'échec et
    recharge ; rien d'autre n'est affecté. Ce lot et THEME peuvent être
    appliqués dans n'importe quel ordre (`17l`).

---

## §8 — Reproduire

```bash
# depuis la branche feature/catalogue-product-reorder-v1-integration

# tests dédiés (commande standard)
node --experimental-strip-types --import ./tests/register.mjs --test \
  tests/catalogue-product-reorder-v1.test.ts \
  tests/catalogue-product-reorder-v1-sql.test.ts \
  tests/catalogue-product-reorder-v1.dom.test.ts

# harnais PostgreSQL réel -- crée et détruit SON cluster jetable
SCANYM_DISPOSABLE_CLUSTER=1 \
  bash supabase/tests/catalogue-product-reorder-v1-check.sh

# sondes de sûreté HARNESS-01..08
SCANYM_DISPOSABLE_CLUSTER=1 \
  bash supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh

# équivalence avec le candidat audité (la branche d'audit doit être rapatriée)
git fetch origin feature/catalogue-product-reorder-v1
for f in $(git diff --name-only 412dbb5 46bc04f -- . ':!supabase/evidence'); do
  [ "$(git rev-parse 46bc04f:$f)" = "$(git rev-parse bc045f2:$f)" ] || echo "DIVERGENT $f"
done        # attendu : lib/i18n.ts et supabase/tests/catalogue-product-reorder-v1-check.sh

# suite, types, build
npm test
npx tsc --noEmit -p tsconfig.json
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npx next build
```

Les deux scripts shell s'exécutent sous un utilisateur ordinaire (depuis root :
`su postgres -c "SCANYM_DISPOSABLE_CLUSTER=1 bash …"`), dans un environnement
sans variable de connexion PostgreSQL.

## §9 — Contenu du paquet

| Fichier | Contenu |
|---|---|
| `CANDIDATE.txt`, `manifest.json` | identités, environnement, résultats |
| `SHA256SUMS.txt` | empreintes des fichiers du paquet |
| `equivalence-vs-audited-candidate.txt` | 28 empreintes de blob, contre-épreuve par cherry-pick réel, diff des deux fichiers divergents |
| `main-delta-412dbb5-to-2f45df7.txt` | ce que main a apporté, et l'état de chacun des 28 fichiers du lot |
| `theme-interaction.txt` | recoupement de fichiers, fusion de `lib/i18n.ts`, imports, dépendances, objets SQL |
| `sql-harness.txt` | sortie complète du harnais PostgreSQL réel (298 preuves) |
| `harness-safety.txt` | sortie complète des sondes HARNESS-01..08 (92 preuves) |
| `audit-reproduction.txt` | CPR-AUDIT-01 rejoué sur le candidat refusé et sur le candidat intégré |
| `dom-fflate-resolution-simulation.txt` | chargement du test DOM, candidat refusé puis candidat intégré |
| `dedicated.tap.gz` | TAP des trois fichiers de test du lot |
| `targeted.tap.gz`, `targeted-baseline.tap.gz` | TAP des 38 fichiers ciblés sur le candidat, et du même jeu sur main |
| `baseline.tap.gz`, `candidate.tap.gz` | TAP de la suite complète, main et candidat |
| `baseline-failures-sorted.txt`, `candidate-failures-sorted.txt`, `previous-baseline-failures-sorted.txt`, `audited-candidate-failures-sorted.txt`, `failure-delta.json` | les quatre jeux d'identités d'échec et leur comparaison |
| `typescript.txt` | `tsc`, main et candidat |
| `build-baseline.txt`, `build-candidate.txt` | les deux builds |
| `mutation/` | scripts et résultats des contrôles de mutation |
| `changed-files.txt`, `implementation-vs-base.patch` | diff `2f45df7..bc045f2` (`--text`) |
