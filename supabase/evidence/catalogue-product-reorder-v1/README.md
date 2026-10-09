# CATALOGUE PRODUCT REORDER v1 — paquet de preuves

Mandat VIVALDI « LOT: CATALOGUE PRODUCT REORDER v1 ».

| | |
|---|---|
| Base | `412dbb53c5f180983860852b79425209c04b9c42` (`origin/main`) |
| Candidat (implémentation) | `a1185224f2bfe24fefd81f4057c6cdbd205939f1` |
| Arbre du candidat | `73d2614a27108efac6619cf2a4f050bc05f93779` |
| Branche | `feature/catalogue-product-reorder-v1` |
| SQL requis | **OUI** — une fonction, DRAFT, **non exécuté sur une base hébergée** |
| Statut | **READY FOR INDEPENDENT AUDIT** — ni fusionné, ni déployé |

Le candidat est le commit d'**implémentation** (`HEAD~1` de la branche). `HEAD`
est le commit de scellement de ce paquet et ne touche **que**
`supabase/evidence/catalogue-product-reorder-v1/` — même convention que les
lots précédents : un manifeste ne peut pas contenir l'empreinte du commit qui
le contient.

---

## §1 — Ce que fait le lot

Le marchand réordonne ses produits avec deux boutons, **Monter** et
**Descendre**. L'ordre est enregistré, et la carte client l'applique tel quel.

**Périmètre d'un produit** (règle fonctionnelle du mandat) :

1. il appartient à une sous-catégorie → il se réordonne parmi les produits de
   **cette** sous-catégorie ;
2. sinon → parmi les produits rattachés **directement** à sa catégorie.

C'est exactement le groupe que la carte client affiche d'un bloc (produits
directs, puis chaque sous-catégorie). Le lot change un **ordre**, jamais une
taxonomie : la seule colonne écrite est `menu_items.display_order`.

## §2 — Modèle d'ordre

`menu_items.display_order` (`integer NOT NULL DEFAULT 0`, présent depuis
`schema.sql`) est **déjà** le champ que la carte client trie
(`lib/services/restaurant.ts` → `compareMenuItemsForPublicDisplay` :
`display_order`, puis nom normalisé, puis `id`, à l'intérieur d'un groupe).
Il est sémantiquement exact et il est **réutilisé**. Aucune colonne, aucune
table, aucun index, aucun ordre flottant.

Un déplacement accepté échange le produit avec son voisin immédiat, puis
renumérote le périmètre en **positions entières denses et distinctes 1..N**.
Seules les lignes dont la valeur change sont écrites (deux lignes pour un
périmètre déjà dense — prouvé par `xmin`, harnais 3e).

## §3 — Stratégie de concurrence

Une seule fonction, `move_product_order(p_product_id, p_direction,
p_expected_order)`, trois mécanismes :

1. **Verrou transactionnel d'établissement** —
   `pg_advisory_xact_lock(hashtextextended(restaurant_id, 2701))`, la
   convention de `mutate_merchant_delivery_rule` (graine 234), avec une graine
   distincte. Les déplacements d'un établissement sont sérialisés.
2. **`FOR NO KEY UPDATE` sur le produit puis sur tout le périmètre** — toute
   autre écriture sur ces lignes (`set_product_order`, `update_product`,
   `archive_product`) attend la fin du déplacement. *No key* : ne bloque pas le
   `FOR KEY SHARE` d'une commande en cours d'insertion.
3. **Contrôle optimiste** — l'appelant transmet l'ordre qu'il **affiche** ;
   il est validé **après** prise des verrous. Une vue périmée est refusée
   (`SCANYM_PRODUCT_ORDER_STALE`, `P0001`) sans rien écrire.

Conséquence : deux déplacements concurrents ne peuvent ni se perdre en
silence, ni produire de positions dupliquées. Le résultat de tout déplacement
accepté est 1..N.

Preuve sur PostgreSQL réel, sessions `psql` parallèles (harnais §9) : la
seconde session **attend** le verrou (9A-c, 9A-d), puis est refusée comme
périmée (9A-e) ; rafale de 8 sessions sur la même vue → exactement 1 acceptée,
7 périmées, 0 autre erreur (9D) ; 48 tentatives entrelacées → périmètre final
dense (9E).

## §4 — Rétrocompatibilité : matérialisation au premier usage

Le lot n'exécute **aucun** backfill. L'installation ne modifie aucune ligne :
le DRAFT relève l'empreinte `(id, display_order)` de tous les produits avant
de créer la fonction et la compare avant `commit` ; tout écart avorte la
transaction. Un marchand qui n'utilise jamais Monter/Descendre garde ses
valeurs, donc son ordre.

Un catalogue historique porte des **ex æquo** (plusieurs produits au même
`display_order`). L'ordre que le client voit alors est celui du départage
JavaScript de la carte. Faire recalculer ce départage par SQL aurait reposé
sur une équivalence non garantie (collation, `lower()` vs `toLowerCase()`,
UTF-16 vs points de code). Le lot ne le fait pas :

- le back-office trie avec **le comparateur de la carte lui-même**
  (`compareProductsWithinDisplayGroup`, extrait de
  `compareMenuItemsForPublicDisplay` qui l'appelle désormais — une règle, pas
  deux copies) ;
- il transmet cet ordre affiché ; le serveur l'accepte **seulement si** c'est
  le même ensemble exact que le périmètre non archivé **et** si les
  `display_order` stockés sont non décroissants le long de la liste.

Le serveur ne laisse donc à l'appelant que le choix de l'ordre **entre ex
æquo** ; partout où les valeurs stockées sont distinctes, c'est la base qui
fait autorité. Au premier déplacement, le groupe est matérialisé dans l'ordre
que le client voyait déjà, plus le seul échange demandé.

## §5 — Import / export

**Décision : l'ordre n'entre pas dans le contrat XLSX.** Aucune colonne
ajoutée, aucune retirée ; `IMPORT_COLUMNS` et `EXPORT_COLUMNS` sont figées par
test.

| Situation | Comportement | Preuve |
|---|---|---|
| Export complet | lignes émises dans l'ordre persisté de la carte | test `[H]`, test DOM `[G] EXPORT` (relu par le lecteur d'import de production) |
| Export des résultats | la liste affichée, tri courant — inchangé | idem |
| Réimport sur le même catalogue | aucune écriture d'ordre ; `update_product` n'écrit pas `display_order` | `[H] ALLER-RETOUR`, harnais 12h |
| Import d'un fichier aux lignes mélangées | l'ordre persisté ne bouge pas | `[H] MÉLANGÉ` |
| Export → import dans un catalogue vide | `create_product` place chaque produit en fin de groupe, dans l'ordre du fichier : l'ordre de la carte est reconstitué | `[H] CATALOGUE VIDE`, harnais 12a-c |

**Un changement à signaler** : avant ce lot, l'export complet suivait l'ordre
des lignes renvoyées par `get_merchant_catalogue` (`display_order`, puis nom
selon la collation de la base). Il suit maintenant le comparateur de la carte.
Les deux ne diffèrent que pour des ex æquo historiques dont le nom se classe
différemment selon la collation (accents, casse). C'est voulu : sans cela,
exporter puis réimporter pouvait recréer ces produits dans un ordre que le
client n'avait jamais vu.

Aucune correction de normalisation d'import n'est mêlée au lot.

## §6 — Multi-tenant

L'établissement n'est jamais fourni par l'appelant : il est dérivé du produit
par `assert_product_role` (owner/manager, ou opérateur Scanym selon la version
installée ; jamais staff). Tout identifiant de la liste qui n'appartient pas
au périmètre du produit fait échouer l'appel entier, y compris quand la liste
a exactement la taille du périmètre (substitution — harnais 5f-5i, 6e-bis).
`anon` et `service_role` n'ont pas le droit d'exécuter la fonction ; aucun
rôle applicatif n'a de droit d'écriture direct sur `menu_items` (harnais 2e).

## §7 — Back-office

- Un tri **« Ordre de la carte »** est ajouté **en dernier** dans le sélecteur.
  Le tri par défaut reste « Nom A → Z » : l'écran d'un marchand qui ne
  réordonne pas est inchangé, champ numérique « Ordre » compris.
- Sous ce tri, chaque produit porte **↑ Monter** / **↓ Descendre** et sa
  position (« 2 / 5 »). Le premier ne monte pas, le dernier ne descend pas
  (`disabled`).
- Un déplacement accepté est appliqué sur place, sans recharger le catalogue :
  la liste ne disparaît pas, le défilement ne bouge pas, le focus reste sur le
  produit. Tout refus recharge et affiche un message.
- Les boutons ne sont proposés que si chaque périmètre est affiché en entier :
  une recherche ou un filtre tag / disponibilité / rétractable les retire, et
  une ligne d'aide dit pourquoi. Les filtres catégorie / sous-catégorie les
  conservent.
- Accessibilité : vrais `<button>`, nom accessible « Monter {produit} », zone
  `aria-live` annonçant la nouvelle position ou le refus, `aria-disabled`
  (jamais `disabled`) pendant un appel pour ne pas perdre le focus. Aucun
  glisser-déposer.

Vérifié dans Chromium sur l'écran réel (services simulés, hors dépôt) : clic,
Entrée et Espace déplacent ; le focus suit le produit et passe au bouton
opposé à la borne ; `scrollY` identique avant/après ; aucun débordement
horizontal à 390 px ; libellés arabes et `dir="rtl"`.

---

## §8 — Résultats mesurés sur le candidat `a118522`

| Vérification | Résultat |
|---|---|
| Tests dédiés (`npm test`, 3 fichiers) | **95 / 0** (45 logique + contrat ; 24 RPC réelle sur PGlite ; 26 écran réel) |
| Harnais PostgreSQL réel du lot | **174 preuves / 0 échec** (PostgreSQL 16.15) |
| TypeScript `tsc --noEmit` | base **0**, candidat **0** |
| Build `next build` (env de substitution) | base **EXIT 0**, candidat **EXIT 0** ; mêmes routes ; `/dashboard/catalogue` 14,9 → 16,5 kB |
| Suite complète, base `412dbb5` | 4778 tests : 4768 réussites / **10 échecs** |
| Suite complète, candidat | 4873 tests : 4863 réussites / **10 échecs** |
| Identités d'échec | **0 apparue, 0 disparue** (`diff` des deux listes triées : vide) |
| Tests réussis en base et absents ou en échec au candidat | **0** |

Les 10 échecs sont ceux déjà consignés par le lot précédent
(`supabase/evidence/merchant-customer-communications-v1/baseline-failures-sorted.txt`) :
les trois listes sont octet-identiques (md5 `d788b58cd63f6c59be1b1195c76bc1c5`).

## §9 — Matrice du mandat

| Exigence | `npm test` | Harnais PostgreSQL |
|---|---|---|
| milieu vers le haut | `[B]`, SQL, DOM `[C]` | 3b-3e |
| milieu vers le bas | `[B]`, SQL, DOM `[C]` | 3f-3h |
| le premier ne monte pas | `[B]`, SQL (erreur typée), DOM `[B]` | 3i |
| le dernier ne descend pas | `[B]`, SQL, DOM `[B]` | 3j |
| périmètre sous-catégorie | `[C]`, SQL, DOM `[D]` | 4a-4i |
| repli catégorie | `[C]`, SQL, DOM `[D]` | 3l-3n |
| aucun déplacement entre catégories | `[C]` (500 déplacements), `[G]` SQL, DOM `[D]` | 5a-5l |
| isolation entre établissements | SQL ×3 | 6a-6l |
| ordre déterministe après rechargement | `[D]`, SQL (80 déplacements : écran == base), DOM `[G]` | 10a-10c |
| concurrence sans doublon | SQL ×4 (entrelacements) | 9A-9E (sessions parallèles) |
| marchand historique inchangé | `[E]`, SQL, DOM `[A]` `[G]` | 1d, 14a-14c |
| la carte suit le back-office | `[A]` ×6, SQL, DOM `[G]` | 11a-11b |
| non-régression import / export | `[H]` ×7, DOM `[G]` | 12a-12h |
| non-régression disponibilité | `[D]`, DOM `[G]` | 13a, 13e-13f |
| non-régression modes de vente | `[D]`, DOM `[G]` | 13b-13c, 13g-13h |

## §10 — Contrôles de mutation effectués

Chaque ligne : la protection retirée du code, puis ce qui échoue.

| Mutation | Détectée par |
|---|---|
| contrôle « non décroissant » retiré | harnais : 11 échecs (7h, 8b, 8f, 9A-e…) |
| appartenance au périmètre : sous-catégorie ignorée | harnais : 9 échecs (5f, 5i…) |
| appartenance : catégorie ignorée | harnais : 12 échecs (5g, 6e-bis…) |
| appartenance : archivage ignoré | harnais : 7 échecs (5h…) |
| contrôle de doublon retiré | harnais : 2 échecs (7f, 7i) |
| borne haute décalée d'un cran | harnais : 2 échecs (3i, 3k) |
| borne basse décalée d'un cran | harnais : 2 échecs (3j, 3k) |
| mauvais voisin échangé | harnais : 33 échecs |
| comptage du périmètre incluant les archivés | harnais : 18 échecs |
| verrou d'établissement retiré | harnais : 1 échec (9A-c) |
| verrou des lignes du périmètre retiré | harnais : 1 échec (9C-bis-d) |
| rôle autorisé modifié (`owner` seul, ou `staff` ajouté) | le contrôle post-application refuse l'installation (harnais : 1a, puis tout le reste) |
| écran : focus non rendu | DOM `[C] FOCUS` |
| écran : garde de changement d'établissement retirée | DOM `[E] CHANGEMENT` |
| écran : pas de rechargement après refus | DOM `[E] VUE PÉRIMÉE` |
| écran : la recherche ne retire plus les boutons | DOM `[F]`, test `[E]` |
| écran : liste filtrée transmise au lieu du périmètre | 13 tests DOM |
| écran : les deux gardes « un seul déplacement » retirées | DOM `[E] UN SEUL` |

**Mutations non détectées, et pourquoi** — ce sont des protections
redondantes par construction, pas des trous de couverture :

1. *Garde de taille retirée* (`cardinality(...) <> v_scope_count`). Le contrôle
   complet qui suit refuse les mêmes listes ; la garde ne sert qu'à ne pas
   parcourir un tableau démesuré.
2. *Une seule des deux gardes « un seul déplacement » retirée* (le `useRef` de
   l'écran, ou le test `pending` du bouton). Chacune suffit seule ; il faut
   retirer les deux pour faire échouer le test.
3. *`canEdit` retiré de `reorderEnabled`*. Les boutons sont déjà rendus à
   l'intérieur du bloc d'actions réservé à `canEdit`.
4. *Clauses de périmètre retirées du `WHERE` de l'`UPDATE`*. Le contrôle
   d'appartenance en amont refuse déjà toute liste étrangère ; ces clauses
   sont une défense en profondeur.

## §11 — Limites connues et points d'attention

1. **Le réordonnancement n'est proposé que sous le tri « Ordre de la carte ».**
   Choix délibéré pour ne pas changer l'écran par défaut. Contrepartie : il
   faut choisir ce tri ; une ligne d'aide le dit sous le sélecteur.
2. **`set_product_order` (champ numérique, V67b) est conservé à l'identique.**
   Il ne prend pas le verrou d'établissement et peut créer des ex æquo. Ils
   restent départagés de façon déterministe, et le déplacement suivant
   redensifie (harnais 9C, test SQL dédié).
3. **Un produit créé, restauré ou changé de sous-catégorie** garde sa valeur
   et peut se retrouver ex æquo avec un produit déjà numéroté. Même
   résolution. `create_product` place toujours un nouveau produit en fin de
   catégorie (harnais 12a-12c).
4. **Le second de deux utilisateurs simultanés est refusé**, pas fusionné : il
   voit la liste à jour et recommence. C'est le prix d'aucune écriture perdue.
5. **Interblocage théorique** entre un déplacement et une réinitialisation de
   catalogue par un opérateur exécutés au même instant sur le même
   établissement (verrous de lignes pris dans des ordres différents).
   PostgreSQL en annule un ; l'écran affiche alors le message d'échec
   générique et recharge. Non reproduit, non testé.
6. **Chaîne du harnais.** Elle rejoue tous les lots catalogue dans l'ordre
   historique, jusqu'à MERCHANT CUSTOMER COMMUNICATIONS v1, sauf
   `DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql`, dont le
   contrôle de dérive exige une version intermédiaire de `set_product_photo`
   absente du dépôt. Ce lot n'ajoute que `assert_product_role_for` et ne
   touche rien dont dépende celui-ci.
7. **La vraie concurrence n'est pas dans `npm test`.** PGlite n'a qu'une
   connexion : la suite y rejoue les entrelacements. Le blocage de sessions
   réellement parallèles n'est prouvé que par le harnais shell, que le
   workflow CI n'exécute pas (comme pour les lots précédents).
8. **Contrôles post-application par sous-chaîne.** Ils lisent le corps
   installé, commentaires compris : un verrou mis en commentaire les
   satisferait. Le harnais, lui, le détecte (mutation « verrou
   d'établissement retiré » ci-dessus).
9. **`lib/catalogue-management/filtering.ts` est vu comme binaire par git** :
   il contient un octet NUL depuis la base (`.join(" \0 ")`), non introduit
   par ce lot et non corrigé ici. `implementation-vs-base.patch` est produit
   avec `--text` pour que son diff soit lisible.
10. **Douze tests DOM existants sont modifiés**, d'une entrée de mock chacun :
    ils empaquettent l'écran catalogue en remplaçant ses services, et l'écran
    en importe un de plus. Sans cette entrée, l'écran y charge le vrai client
    Supabase ; six de ces tests n'ont pas de démontage des poignées ouvertes,
    et le premier rencontré (`online-withdrawal-catalogue-v1-dom`) ne se
    terminait pas (constaté). Même patron que le commit
    `d4c1d31` (PRODUCT SERVICE MODES v1) pour `sale-modes-public`. Aucune
    assertion existante n'est modifiée.
11. **Ordre d'installation.** SQL d'abord, application ensuite. Dans l'ordre
    inverse, un clic sur Monter/Descendre affiche le message d'échec et
    recharge ; rien d'autre n'est affecté.
12. **Rollback.** Il retire la fonction et conserve les ordres déjà
    enregistrés : ce sont des entiers ordinaires que la carte continue
    d'honorer. Il doit accompagner le retour du code applicatif.

## §12 — Reproduire

```bash
npm ci
# tests dédiés
node --experimental-strip-types --import ./tests/register.mjs --test \
  tests/catalogue-product-reorder-v1.test.ts \
  tests/catalogue-product-reorder-v1-sql.test.ts \
  tests/catalogue-product-reorder-v1.dom.test.ts
# harnais PostgreSQL réel (bases jetables, aucune base hébergée)
su postgres -c "bash supabase/tests/catalogue-product-reorder-v1-check.sh"
# suite, types, build
npm test
npx tsc --noEmit -p tsconfig.json
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npx next build
```

## §13 — Contenu du paquet

| Fichier | Contenu |
|---|---|
| `manifest.json` | identités, environnement, résultats |
| `implementation-vs-base.patch` | les 25 fichiers du lot vs `412dbb5` (`git diff --text`) |
| `changed-files.txt` | liste des fichiers ajoutés / modifiés |
| `targeted.tap.gz` | TAP des 3 fichiers de tests dédiés |
| `sql-harness.txt` | les 174 preuves PostgreSQL |
| `baseline.tap.gz`, `candidate.tap.gz` | TAP des deux suites complètes |
| `baseline-failures-sorted.txt`, `candidate-failures-sorted.txt` | identités d'échec |
| `failure-delta.json` | comparaison des deux listes |
| `typescript.txt` | `tsc --noEmit`, base et candidat |
| `build-baseline.txt`, `build-candidate.txt` | les deux builds |
| `SHA256SUMS.txt` | empreintes de tous les fichiers ci-dessus |
