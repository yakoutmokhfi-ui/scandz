# CATALOGUE PRODUCT REORDER v1.1 — remédiation de l'audit indépendant

Paquet de preuves du mandat **VIVALDI — TARGETED REMEDIATION — LOT:
CATALOGUE PRODUCT REORDER v1 — AUDIT RESULT: FAIL**.

| | |
|---|---|
| Base | `412dbb53c5f180983860852b79425209c04b9c42` |
| Candidat refusé | `a1185224f2bfe24fefd81f4057c6cdbd205939f1` (arbre `73d2614a27108efac6619cf2a4f050bc05f93779`) |
| Tête de preuves précédente | `9661632d41aa3dd4cdbde52ec2695b684a9e070c` |
| **Nouveau candidat** | **`46bc04f2905fde2b652c5ea0535f4090ce17bcbd`** (arbre `ed142021a0a00322a5e39890aa4eb3698905955e`) |
| Branche | `feature/catalogue-product-reorder-v1` |
| Statut | **READY FOR DELTA RE-AUDIT** |

Le nouveau candidat est un commit NEUF posé sur `9661632` : le candidat
refusé n'a pas été amendé. Le commit de tête de la branche scelle ce
paquet et ne touche que `supabase/evidence/catalogue-product-reorder-v1.1/`.
Le paquet `catalogue-product-reorder-v1/` (candidat refusé) est laissé
tel quel.

**Rien n'a été fusionné, rien n'a été déployé, aucun SQL n'a été exécuté
sur une base hébergée.**

---

## §1 — Portée

Remédiation ÉTROITE : trois sujets, douze fichiers, tous propres au lot.

| Fichier | Nature du changement |
|---|---|
| `supabase/DRAFT-lot-catalogue-product-reorder-v1.sql` | CPR-01 : contrat de fraîcheur de `move_product_order` |
| `supabase/DRAFT-lot-catalogue-product-reorder-v1-ROLLBACK.sql` | signature de la fonction retirée |
| `lib/catalogue-product-order.ts` | `scope.expected` : la vue transmise |
| `lib/services/catalogue-product-order.ts` | paramètre `p_expected_scope` |
| `app/dashboard/catalogue/page.tsx` | **une ligne** : `scope.orderedIds` → `scope.expected` (+ commentaire) |
| `supabase/tests/catalogue-product-reorder-v1-check.sh` | CPR-02 : plus aucun défaut ambiant ; CPR-01 : section 8F |
| `supabase/tests/catalogue-product-reorder-v1-harness-lib.sh` | **nouveau** — bibliothèque de sûreté du harnais |
| `supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh` | **nouveau** — sondes HARNESS-01..08 |
| `tests/helpers/catalogue-product-reorder-rpc-model.ts` | **nouveau** — modèle du contrat RPC (faux serveur fidèle) |
| `tests/catalogue-product-reorder-v1.test.ts` | +16 tests (vue transmise, contrat, structure du harnais) |
| `tests/catalogue-product-reorder-v1-sql.test.ts` | +13 tests (dix cas du mandat, différentiel modèle/SQL) |
| `tests/catalogue-product-reorder-v1.dom.test.ts` | +11 tests ; faux serveur = contrat réel ; chargement sans esbuild/`fflate` |

`changed-files.txt` et `remediation-vs-failed-candidate.patch` donnent le
diff exact `9661632..46bc04f` (le commit `9661632` n'ayant touché que
`supabase/evidence/`, c'est le diff depuis le candidat refusé).

**Non modifié** : `lib/catalogue-subcategory-grouping.ts` (comparateur de
la carte client), `lib/catalogue-management/*` (filtres, export),
`lib/catalogue-import/*`, `lib/i18n.ts`, `lib/services/dashboard.ts`,
`get_merchant_catalogue`, `set_product_order`, `assert_product_role`, les
douze tests DOM existants touchés par la première version, et tout le
reste du dépôt.

---

## §2 — CPR-AUDIT-01 : fraîcheur de la vue

### Le constat, reproduit

`audit-reproduction.txt` rejoue le scénario de l'audit sur les deux
versions du DRAFT, dans la même base locale :

```
CANDIDAT REFUSÉ a118522 -- move_product_order(uuid, text, uuid[])
1. état initial                       : Comté=1|Beaufort=2|Abondance=3
2. un autre utilisateur : Comté -> 2  : Beaufort=2|Comté=2|Abondance=3
3. client périmé : « Abondance UP »   : ACCEPTÉ (position 2)
4. état final                         : Comté=1|Abondance=2|Beaufort=3   -> ÉCRASÉ

REMÉDIATION -- move_product_order(uuid, text, jsonb)
3. client périmé : « Abondance UP »   : REFUSÉ -- P0001 SCANYM_PRODUCT_ORDER_STALE
4. état final                         : Beaufort=2|Comté=2|Abondance=3   -> INTACT
```

La cause : la première version vérifiait les identifiants et la
**monotonie des `display_order` STOCKÉS** le long de la liste reçue. La
vue périmée `[Comté, Beaufort, Abondance]` lue contre l'état `2, 2, 3`
est non décroissante : elle passait.

### Le contrat corrigé

`move_product_order(p_product_id uuid, p_direction text, p_expected_scope jsonb)`

`p_expected_scope` est la **représentation canonique du périmètre telle
que le serveur l'a fournie** à l'appelant avec le catalogue
(`get_merchant_catalogue` : `product_id`, `display_order`, `name`) et que
l'appelant **renvoie inchangée** — un tableau JSON, dans l'ordre affiché :

```json
[ { "id": "<uuid>", "display_order": 1, "name": "Comté" }, … ]
```

Ce sont **tous** les champs qui déterminent l'ordre visible d'un
périmètre : l'appartenance (l'ensemble des `id`), `display_order`, et les
deux champs de départage de `compareProductsWithinDisplayGroup` (`name`,
puis `id`). Un test structurel le vérifie dans les deux sens (les champs
lus par le comparateur = les champs transmis).

Après le verrou d'établissement et le verrou de TOUTES les lignes du
périmètre, le serveur exige :

| | Exigence | Refuse |
|---|---|---|
| (a) | même ENSEMBLE exact d'identifiants | produit inséré, archivé, sorti, entré, étranger, doublon |
| (b) | pour CHAQUE produit, `display_order` reçu = stocké | ex æquo créé ou supprimé, renumérotation |
| (c) | pour CHAQUE produit, `name` reçu = stocké, **octet pour octet** (`collate "C"`) | renommage, casse, espace, forme Unicode |
| (d) | `display_order` non décroissant le long de la liste | ordre contraire à la base (défense en profondeur) |

Le moindre écart : `SCANYM_PRODUCT_ORDER_STALE` (P0001), **aucune
écriture**. Aucune valeur reçue n'est convertie (ni `::uuid`, ni
`::integer`) : une charge mal formée est refusée comme périmée, jamais
par une erreur de conversion.

### Pourquoi pas une empreinte hachée — et pourquoi c'est équivalent

Le mandat recommande une empreinte de périmètre calculée par le serveur
et renvoyée par le client, ou tout mécanisme dont l'équivalence est
prouvée. Le mécanisme retenu est le second ; il est délibéré.

- Une empreinte opaque devrait être délivrée **avec** le catalogue, donc
  par `get_merchant_catalogue` — fonction que ce lot ne modifie pas, et
  qu'une remédiation étroite n'a pas à redéfinir. Délivrée par un appel
  séparé, elle ne décrirait plus la vue affichée.
- Calculée par le client, elle exigerait que client et serveur
  sérialisent à l'identique — exactement le risque que le mandat écarte.

La vue transmise est donc **la pré-image elle-même**. Soit `S` l'état
stocké du périmètre sous verrou et `E` l'état reçu, vus comme ensembles
de triplets `(id, display_order, name)`. Une empreinte `H(canon(E))`
comparée à `H(canon(S))` accepte si et seulement si `canon(E) = canon(S)`,
aux collisions de `H` près. (a) + (b) + (c) décident directement `E = S`,
triplet par triplet : **même décision, sans collision possible et sans
sérialisation à faire coïncider**. Le client ne hache rien, ne normalise
rien, ne recalcule rien.

Cette équivalence n'est pas seulement argumentée, elle est testée :

- `[J] ÉQUIVALENCE AVEC UNE EMPREINTE DE PÉRIMÈTRE` — 4 000 couples
  (vue, état) : le contrat accepte **si et seulement si**
  `empreinte(vue) = empreinte(état)` et la liste est non décroissante ;
- `[MODÈLE]` — la même propriété, vérifiée sur le **SQL réel** pour
  chacun des 600 scénarios du test différentiel (« accepté ⇒ empreintes
  égales », « empreintes différentes ⇒ périmé », « empreintes égales et
  liste monotone ⇒ jamais périmé »).

L'ordre visible étant une fonction déterministe de cet état
(`display_order`, nom normalisé, `id`), état identique ⇒ ordre visible
identique : une vue périmée ne peut plus imposer son ordre, ni entre
valeurs distinctes, ni entre ex æquo.

### Les dix cas du mandat, à trois niveaux

| # | Cas | SQL réel via le vrai service (PGlite) | PostgreSQL réel (`sql-harness.txt`) | Écran réel (DOM) |
|---|---|---|---|---|
| 1 | Reproduction exacte de l'audit | `[CPR-01] 1.` | `8F-1a…1g` (9) | `[H] CPR-01 / 1.` |
| 2 | Ex æquo introduit | `[CPR-01] 2.` | `8F-2a…2b` (3) | `[H] CPR-01 / 2.` |
| 3 | Ex æquo supprimé | `[CPR-01] 3.` | `8F-3a…3c` (5) | `[H] CPR-01 / 3.` |
| 4 | Départage modifié, `display_order` identiques | `[CPR-01] 4.` | `8F-4a…4d` (5) | `[H] CPR-01 / 4.` |
| 5 | Produit inséré | `[CPR-01] 5.` | `8F-5a…5d` (6) | `[H] CPR-01 / 5.` |
| 6 | Produit archivé / retiré | `[CPR-01] 6.` | `8F-6a…6e` (8) | `[H] CPR-01 / 6.` |
| 7 | Produit renommé | `[CPR-01] 7.` | `8F-7a…7c` (4) | `[H] CPR-01 / 7.` |
| 8 | La vue fraîche autorise le déplacement | `[CPR-01] 8.` | `8F-8a…8f` (6) | `[H] CPR-01 / 8.` |
| 9 | Un refus ne change aucun `display_order` | `[CPR-01] 9.` + chaque cas | `8F-9a…9c` (3) + chaque cas | `[H] CPR-01 / 9.` + chaque cas |
| 10 | Déplaceurs concurrents : 1er accepté, 2nd refusé | `[CPR-01] 10.` | `8F-10a…10h` (8, **sessions parallèles**) | `[H] CPR-01 / 10.` |

« Octet pour octet » (cas 9) est affirmé dans **chaque** cas de refus, pas
seulement dans le neuvième : l'instantané comparé avant/après porte, pour
tous les produits de la base, `id`, `display_order` **et la version de
ligne (`xmin`)** — aucune valeur changée, aucune ligne réécrite, pas même
avec la même valeur.

Le cas 3 comporte la variante qui importe le plus : un ex æquo supprimé
**sans changer l'ordre visible** (Banon 0 → −1, toujours premier). La
vue périmée y reste monotone ; seule la comparaison des valeurs reçues la
refuse. Le cas 10 comporte la symétrie de l'audit en vraie concurrence :
l'« autre utilisateur » valide `set_product_order` **pendant** que le
déplaceur attend le verrou de ligne (`8F-10f…10h`).

### Le faux serveur exécute le vrai contrat

L'audit a relevé que le faux serveur des tests DOM était **plus strict**
que le SQL (il comparait la liste d'identifiants à l'ordre courant) et
masquait donc la faille.

- `tests/helpers/catalogue-product-reorder-rpc-model.ts` transcrit la
  fonction SQL étape par étape (mêmes refus, même ordre).
- `[MODÈLE]` l'oppose au **SQL réel** sur 600 scénarios tirés
  (déterministes) : vues fraîches, périmées, permutées, d'un autre
  périmètre, altérées de 22 façons, charges non conformes. Pour chaque
  scénario : **même décision, même position rendue, mêmes `display_order`
  dans toute la table, rien d'autre de modifié**. Répartition du tirage :
  165 déplacements, 189 « périmé », 76 bornes, 48 directions invalides,
  122 introuvables/archivés ; 75 déplacements acceptés sur un périmètre
  contenant des ex æquo ; 51 vues périmées portant exactement les bons
  identifiants.
- Le faux serveur DOM n'exécute plus que ce modèle. Il n'est ni plus
  strict ni plus laxiste que la base.

---

## §3 — CPR-AUDIT-02 : sûreté du harnais PostgreSQL

Le harnais appelait `psql`, `createdb` et `drop database if exists` avec
la configuration de connexion ambiante. Toute la logique de sûreté est
désormais dans `catalogue-product-reorder-v1-harness-lib.sh` ; le harnais
ne contient plus une seule commande PostgreSQL appelée par son nom.

### Stratégie d'isolement

| # | Exigence du mandat | Mise en œuvre |
|---|---|---|
| 1 | Consentement explicite | `SCANYM_DISPOSABLE_CLUSTER=1`, valeur exacte ; sinon refus (code 2) |
| 2 | Cluster créé par le harnais | `mktemp -d` (0700) → `initdb` → socket UNIX dans ce répertoire, `listen_addresses = ''`, port explicite. **Aucun mode « cluster désigné »** |
| 3 | Variables héritées | `PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGCLUSTER` + URL usuelles : **refus**, par NOM seul. Toute autre `PG*` : retirée |
| 4 | Aucun défaut ambiant | chaque appel passe par `hpsql` : binaire `psql` RÉEL (chemin absolu, jamais le `pg_wrapper` de Debian) lancé par `env -i`, cible fixée par variables **et** par options |
| 5 | Identité prouvée avant toute destruction | voir ci-dessous |
| 6 | Noms aléatoires | étiquette de 48 bits tirée de `/dev/urandom` ; plus aucun nom dérivé du PID |
| 7 | Jamais de suppression d'une base préexistante | `harness_create_db` refuse un nom déjà pris ; `harness_drop_db` refuse tout nom hors registre ; **aucun `drop database if exists`** |
| 8 | Ressources tracées | registre `H_CREATED_DBS`, alimenté après création réussie seulement |
| 9 | Nettoyage borné à l'exécution | arrête le postmaster de SON répertoire, supprime SON répertoire, rien d'autre |
| 10 | Sûr après échec partiel | chaque étape du nettoyage est conditionnée à ce qui existe ; trappes `EXIT/HUP/INT/TERM` armées avant la création du cluster |
| 11 | Aucun secret journalisé | seuls des noms de variables et des chemins temporaires sont écrits |
| 12 | Aucune base hébergée atteignable | aucun TCP : le serveur n'écoute sur aucune adresse, le client ne parle qu'à un socket dans un répertoire privé |

### Preuve d'identité de la destination

Chaque `create database` / `drop database` est envoyé dans **la même
session psql** qu'un bloc de preuve, sous `ON_ERROR_STOP` : si la preuve
échoue, psql s'arrête avant d'envoyer l'instruction suivante. Il n'y a
pas de fenêtre entre la preuve et l'acte. Le bloc lève
`SCANYM_HARNESS_IDENTITY_MISMATCH` si l'une de ces conditions manque :

- le serveur rend le **nonce de 128 bits** tiré par cette exécution, et
  le relit dans SON fichier de configuration (`pg_file_settings`, avec le
  chemin du fichier) ;
- `config_file` et `data_directory` sont dans le répertoire créé par
  cette exécution ;
- la connexion est un socket UNIX (`inet_server_addr()` nul) et le
  serveur n'a aucune écoute réseau ;
- l'utilisateur est superutilisateur de ce cluster.

### Sûreté du nettoyage

Le nettoyage **n'ouvre aucune connexion** et n'envoie aucun `DROP` : le
cluster entier est jetable. Il arrête le postmaster dont le
`postmaster.pid` est dans SON répertoire **et** dont la ligne de commande
désigne ce répertoire, puis supprime ce répertoire — à condition que le
marqueur de propriété qu'il contient porte le nonce de CETTE exécution,
que le nom ait la forme attendue et que ce ne soit pas un lien
symbolique. Faute de preuve, il ne supprime rien et le dit.

### Sondes HARNESS-01..08 (`harness-safety.txt` : 92 PASS, 0 FAIL, 0 SKIP)

Trois instruments de mesure :

- **le témoin** — un second cluster, « serveur de quelqu'un d'autre »,
  avec cinq bases aux noms semblables à ceux du harnais (dont le schéma
  de nommage de la première version), une sentinelle dans chacune, et le
  journal de chaque connexion et de chaque instruction ;
- **le fil-piège** — de faux binaires `psql`, `createdb`, `dropdb`,
  `initdb`… qui consignent leur appel : un journal vide prouve qu'aucune
  commande PostgreSQL n'a été lancée avant un refus ;
- **l'appât** — le témoin écoute aussi à l'emplacement par défaut du
  poste (`/var/run/postgresql:5432`), là où aboutit un `psql` sans
  paramètre. Actif dans cette exécution.

Chaque instrument a son **contrôle positif** (le fil-piège se déclenche
dès le verrou franchi ; le fichier de service route bien un `psql`
ordinaire vers le témoin ; un `psql` nu aboutit bien au témoin).

| Sonde | Ce qui est prouvé | Preuves |
|---|---|---|
| HARNESS-01 | sans consentement (absent, `0`, `true`, `yes`, vide, `11`) : code 2, fil-piège muet, aucun fichier créé | 7 |
| HARNESS-02 | `PGHOST`+`PGPORT` vers le témoin, puis `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGCLUSTER` seuls : refus avant toute commande, témoin sans connexion | 7 |
| HARNESS-03 | `PGSERVICE`+`PGSERVICEFILE`, chacun seul, `PGSYSCONFDIR` : refus ; témoin sans connexion | 5 |
| HARNESS-04 | `PGPASSWORD`, `PGPASSFILE`, `DATABASE_URL`, `SUPABASE_DB_URL` : refus ; le secret, l'URL et le chemin n'apparaissent dans aucune sortie | 6 |
| seconde barrière | variables hostiles exportées **après** le verrou : le serveur joint reste celui de l'exécution (nonce, `data_directory`) ; témoin sans connexion | 8 |
| HARNESS-05 | base préexistante portant EXACTEMENT le nom que le harnais va utiliser : création refusée, suppression refusée, même OID, sentinelle intacte ; `postgres`, `template1`, nom forgé : refusés | 10 |
| HARNESS-06 | garde du nettoyage (autre nonce, sans marqueur, nom non conforme) ; échec d'`initdb` ; **échec réel de la chaîne en cours d'exécution** ; **SIGTERM en cours d'exécution** : seul le répertoire de l'exécution disparaît, le répertoire d'une « autre exécution » et le témoin sont intacts | 17 |
| HARNESS-07 | connexion aboutissant à un autre serveur, nonce non conforme, `data_directory` non conforme, serveur injoignable : `DROP DATABASE` **non envoyé** (journal d'instructions du serveur tiers), base homonyme intacte ; identité rétablie : accepté | 12 |
| HARNESS-08 | exécution normale : code 0, 263 preuves, concurrence 9A–9E et 8F-10 comprises ; cluster retiré ; témoin (y compris à l'emplacement par défaut) sans une seule connexion | 18 |
| bilan | sur tout le script, les seules instructions `CREATE/DROP/ALTER DATABASE` reçues par le témoin sont ses cinq créations ; aucun `DROP DATABASE` | 2 |

HARNESS-07 est exercée au niveau de la bibliothèque, en redirigeant ses
variables de connexion vers le témoin : dans une exécution de bout en
bout, la situation ne peut pas se produire (c'est l'objet des sondes
01–04 et de la seconde barrière). C'est la seule façon d'éprouver la
garde elle-même.

Sept tests `[K]`, exécutables sur tout poste **sans PostgreSQL**,
verrouillent la structure : aucune commande PostgreSQL appelée par son
nom, verrou d'entrée avant tout, variables refusées par nom seul,
`CREATE/DROP DATABASE` uniquement derrière la preuve, nettoyage sans
connexion.

---

## §4 — Chargement du test DOM (`fflate`)

**Cause.** `tests/catalogue-product-reorder-v1.dom.test.ts` est le seul
test DOM du dépôt qui n'isole pas `lib/catalogue-management/export.ts`
(il relit le vrai classeur exporté) : c'était donc le seul à faire
résoudre le paquet `fflate` par esbuild. Sur un poste où le résolveur de
paquets d'esbuild n'y parvient pas, le fichier ne se chargeait pas.

**Correctif (test uniquement, minimal).** Dans le greffon esbuild du
test, tout spécificateur « nu » est **externalisé** et chargé par Node au
moment de l'import — comme `react` l'était déjà. esbuild ne lit plus rien
dans `node_modules` ; un paquet non déclaré fait échouer le bundling avec
un message explicite plutôt que d'être résolu en silence.

**Rien n'est affaibli.** La fonction d'export réelle s'exécute toujours,
avec la bibliothèque réelle ; le classeur est toujours relu
(`[G] NON-RÉGRESSION EXPORT`). Un test `[I]` ajoute la preuve que le
bundle ne contient aucun fichier de `node_modules`.

**Preuve** (`dom-fflate-resolution-simulation.txt`). Dans une copie du
dépôt où `fflate` n'expose plus que la condition d'export `node` —
esbuild ne peut plus le résoudre, Node le résout toujours — et avec la
commande standard :

```
CANDIDAT REFUSÉ a118522 : ✘ Could not resolve "fflate"  ->  tests 1, pass 0, fail 1
REMÉDIATION             :                                   tests 37, pass 37, fail 0
```

**Limite, dite clairement :** cet environnement est Linux. Le symptôme de
l'audit (« fails to load because of fflate resolution ») est reproduit
par simulation, et le correctif retire la dépendance qui échouait ;
**le test n'a pas été exécuté sous Windows ici.** Les chemins du test
sont construits par `path.join` / `pathToFileURL`, et le test `[I]`
normalise les séparateurs.

---

## §5 — Zones validées par l'audit : préservées

| Zone | Ce qui change | Preuve de non-régression |
|---|---|---|
| Modèle d'ordre | rien : `menu_items.display_order`, aucune colonne, aucun flottant, aucun backfill, échange + 1..N denses | sections 1, 3, 4, 10 du harnais ; `[D]`, `[G] SQL` |
| Périmètre | rien : sous-catégorie, sinon produits directs | sections 3–5 ; `[C]` |
| Isolation entre établissements | rien : tenant dérivé du produit ; un identifiant étranger est « périmé », qu'il existe ou non (aucun oracle) | section 6 ; `ISOLATION` (PGlite) |
| Rôles | rien : owner/manager (ou opérateur), jamais staff | 6a–6l |
| Écran | une ligne (`scope.expected`) ; mêmes boutons, mêmes bornes, même focus, même annonce, aucun glisser-déposer | les 26 tests DOM d'origine passent, sous les mêmes titres |
| Carte client | rien : comparateur non modifié | `[A]`, section 11 |
| Contrat XLSX | rien | `[H]`, `[G] NON-RÉGRESSION EXPORT` |
| Intégrité des assertions existantes | aucune preuve retirée (détail ci-dessous) | diff des trois fichiers de test |

**Ce qui a été touché dans les 95 tests d'origine**, et pourquoi :

- les appels passent la vue (`{ id, display_order, name }`) au lieu de la
  liste d'identifiants — c'est le changement de contrat lui-même ; les
  scénarios, les états attendus et les refus attendus sont les mêmes ;
- les assertions qui citaient l'ancien contrat par son nom (paramètre
  `p_expected_order`, signature `uuid[]`, `scope.orderedIds` dans
  l'écran) citent le nouveau ;
- dans le test DOM, deux assertions sur l'appel enregistré sont réécrites
  pour la nouvelle forme de l'enregistrement, avec les mêmes valeurs
  attendues, et complétées par la charge exacte partie sur le réseau ;
- trois tests changent de titre, à scénario constant :
  `[G] écran : … (scope.orderedIds)` → `(scope.expected : id,
  display_order, name)` ; `ANTI-DÉRIVE : sur une base non conforme…`
  (deux cas de dérive ajoutés) ; `l'appelant ne choisit QUE l'ordre entre
  ex æquo…` → `ex æquo d'un état FRAIS : l'ordre affiché est celui de
  l'appelant…` (même scénario, formulé pour le contrat corrigé, avec en
  plus la preuve qu'aucun refus n'écrit) ;
- le faux serveur DOM est remplacé par le modèle du contrat réel (§2).

Les 92 autres titres sont inchangés ; tous les tests de la base passent
toujours (§6).

Deux changements de comportement, tous deux voulus par la remédiation :

1. une vue périmée que la première version acceptait est refusée (c'est
   le correctif) ;
2. **tout** renommage ou toute renumérotation dans le périmètre entre le
   chargement et le clic rend la vue périmée, même quand l'ordre visible
   n'a pas changé. L'écran recharge et le marchand refait son geste — le
   parcours « vue périmée » existant, inchangé.

Enchaîner des déplacements sans recharger ne produit jamais de faux
« périmé » : après un déplacement accepté, la vue locale est déjà la vue
du serveur (prouvé à chaque pas d'une marche de 80 déplacements).

---

## §6 — Résultats mesurés sur `46bc04f`

| Mesure | Résultat |
|---|---|
| Tests dédiés (`dedicated.tap.gz`) | **135 / 135** — 61 logique et structure, 37 RPC réelle (PGlite), 37 écran réel |
| Harnais PostgreSQL réel (`sql-harness.txt`) | **263 PASS, 0 FAIL** — dont 58 preuves de fraîcheur (8F) et 33 preuves de concurrence en sessions parallèles (9A–9E), plus les 8 de 8F-10 |
| Sondes de sûreté (`harness-safety.txt`) | **92 PASS, 0 FAIL, 0 SKIP** |
| Tests ciblés, 33 fichiers (`targeted.tap.gz`) | 623 tests, 622 PASS, 1 FAIL — l'échec est une identité de la base (« Scénario 16 — Delivery pricing ») |
| TypeScript | base **0**, candidat **0** |
| Build `next build` (env de substitution) | base **EXIT 0**, candidat **EXIT 0** ; 38 routes de part et d'autre, aucune ajoutée ni retirée ; `/dashboard/catalogue` 15 → 16,6 kB (16,5 kB pour le candidat refusé) |
| Suite complète, base `412dbb5` | 4 778 tests, **4 768 PASS, 10 FAIL** |
| Suite complète, candidat `46bc04f` | 4 913 tests, **4 903 PASS, 10 FAIL** |
| Identités d'échec | **identiques** : 0 apparue, 0 disparue (md5 `d788b58cd63f6c59be1b1195c76bc1c5` des deux côtés) |
| Tests de la base absents du candidat | **0** ; 135 tests en plus, tous du lot |

La base a été ré-exécutée pour ce paquet (arbre de travail propre sur
`412dbb5`, mêmes `node_modules`) ; ses dix identités sont celles déjà
publiées dans `catalogue-product-reorder-v1/` et
`merchant-customer-communications-v1/`.

**Stabilité de la suite complète — à lire avant une contre-exécution.**
Trois exécutions supplémentaires (deux sur la tête de branche, une sur
la base) ont montré, en plus des dix identités, des échecs
**intermittents** de tests DOM à temporisation préexistants — un à deux
par exécution, différents d'une fois à l'autre, **y compris sur la base
inchangée** (12 échecs au second passage de la base). Aucun n'est dans un
fichier modifié par la branche ; aucun test du lot n'échoue dans aucune
exécution. Mesuré en isolement, base et tête alternées : le test
`gap-01-withdrawal-requests-backoffice` échoue 13 fois sur 30 sur la
base et 12 fois sur 30 sur la tête. Détail, identités et TAP :
`stability/README.txt`.

---

## §7 — Contrôles de mutation (`mutation/`)

Les preuves ont été éprouvées sur l'arbre du candidat : chaque mutant vit
dans une copie du dépôt, le dépôt n'est jamais modifié. Les scripts sont
dans le paquet (`mutations.py`, `run-mutations.sh`).

**SQL — 15 mutants du contrôle de fraîcheur** (le contrôle
post-application du lot, qui refuserait de les installer, est neutralisé
pour mesurer les preuves comportementales) :

| Mutant | PGlite (37) | PostgreSQL réel (263) |
|---|---|---|
| M01 `display_order` non comparé | 7 échecs | 19 échecs |
| M02 `name` non comparé | 3 | 9 |
| M03 `name` insensible à la casse | 2 | 4 |
| M04 compteur de fraîcheur ignoré | 9 | 24 |
| M05 compteur de lignes distinctes ignoré | 1 | 18 |
| M06 monotonie ignorée | 2 | 8 |
| M07 sans garde de taille | **0** | **0** |
| M08 jointure acceptant les archivés | 3 | 9 |
| M09 jointure ignorant la sous-catégorie | 2 | 7 |
| M10 type JSON de `display_order` non vérifié | 2 | 4 |
| M11 type JSON de `name` non vérifié | 1 | 3 |
| M12 réécrit les lignes inchangées | 1 | 1 |
| M13 type JSON de `id` non vérifié | **0** | **0** |
| M14 `display_order` comparé en numérique | 1 | 4 |
| M15 `name` comparé après rognage | 2 | 4 |

13 tués. Les deux survivants sont **équivalents** : M07 retire une garde
de coût (la charge de mauvaise taille est de toute façon refusée par le
contrôle de cardinalité qui suit) ; M13 retire un test de type que rien
ne peut franchir (aucune valeur JSON non-chaîne ne s'écrit comme un
uuid). Les deux gardes restent verrouillées par un test structurel.

Trois de ces mutants avaient d'abord survécu (M11, M12, M14) ; les tests
qui les tuent ont été ajoutés en conséquence (`[CPR-01] la vue doit être
CELLE REÇUE, type JSON compris`, `… ne réécrit QUE les lignes dont la
valeur change`, `7t-bis`, `7ag-bis`).

**Bibliothèque de sûreté — 14 mutants, 14 tués** par les sondes : PGHOST
non refusé, preuve d'identité neutralisée, suppression hors registre,
nettoyage sans preuve de propriété, `hpsql` héritant de l'environnement,
consentement retiré, création sans contrôle d'existence, PGPASSWORD non
refusé, PGSERVICE non refusé, refus affichant la valeur, preuve sans
nonce, preuve sans répertoire de données, `DROP` sans preuve, écoute
réseau. Le mutant « `DROP` sans preuve » supprime réellement une base du
témoin : c'est ce que les sondes mesurent.

---

## §8 — Limites connues et points d'attention

1. **Pas d'exécution sous Windows** (§4). Le correctif `fflate` est
   prouvé par simulation du symptôme, pas sur le poste de l'audit.
2. **Ordre entre ex æquo d'un état frais.** Il reste celui que
   l'appelant affiche, comme dans le modèle d'ordre validé par l'audit :
   le départage de la carte client est du JavaScript que SQL ne peut pas
   reproduire à l'identique sur tous les caractères. Ce qui change : cet
   ordre ne peut plus venir d'un état périmé. Un propriétaire qui
   forgerait une requête avec les valeurs courantes obtiendrait un ordre
   qu'il a de toute façon le droit de poser en deux déplacements.
3. **Sévérité assumée.** Un renommage ou une renumérotation dans le
   périmètre périme la vue même si l'ordre visible n'a pas bougé (§5).
   `display_order` est comparé textuellement : `3.0` n'est pas `3`
   (aucun client JavaScript n'émet `3.0`).
4. **Signature modifiée.** `(uuid, text, uuid[])` devient
   `(uuid, text, jsonb)`. Le DRAFT précédent n'a jamais été appliqué sur
   une base hébergée : rien à migrer. L'anti-dérive refuse l'ancienne
   signature si elle existait.
5. **Le harnais exige des binaires PostgreSQL locaux et un utilisateur
   non root.** Il ne sait plus s'exécuter contre un serveur existant :
   c'est le but. `SCANYM_PG_BINDIR` désigne les binaires s'ils ne sont
   pas trouvés.
6. **L'appât « emplacement par défaut »** occupe le socket par défaut du
   poste : il n'est activé que sur demande explicite
   (`SCANYM_HARNESS_DEFAULT_SOCKET_BAIT=1`) et seulement si ce socket est
   libre. Sans lui, la sonde est notée SKIP et l'absence de défaut
   ambiant reste prouvée par le fil-piège et la seconde barrière.
7. **PGlite n'a qu'une connexion.** Dans `npm test`, la concurrence est
   rejouée par entrelacements ; le blocage réel de sessions parallèles
   est prouvé par le harnais PostgreSQL (9A–9E, 8F-10).
8. **Le modèle ne couvre pas l'autorisation** (`assert_product_role`),
   qui précède tout et ne dépend pas de la vue ; elle est prouvée sur le
   SQL réel.
9. **Tests DOM intermittents de la base** (§6, `stability/`). Une
   suite complète peut montrer un ou deux échecs de plus que les dix
   identités de la base, dans des tests à temporisation sans rapport
   avec ce lot. Constaté aussi sur la base inchangée.
10. **Création strictement simultanée à un déplacement — fenêtre
    résiduelle, héritée, non fermée ici.** La fraîcheur est prouvée sous
    verrou, à l'instant de la validation. Les écritures sur les lignes du
    périmètre (renumérotation, renommage, archivage, changement de
    sous-catégorie) attendent alors la fin du déplacement. Une
    **insertion** — ou l'arrivée dans le périmètre d'un produit venu d'une
    autre sous-catégorie, qui n'était donc pas une ligne du périmètre —
    n'est bloquée par aucun de ces verrous de ligne : `create_product` et
    `update_product` ne prennent pas le verrou d'établissement, et ce lot
    s'interdit de les redéfinir. Si une création est validée **entre** la
    validation d'un déplacement et son `commit` (quelques millisecondes),
    les deux réussissent : les produits existants sont dans l'ordre voulu
    par le déplaceur, et le nouveau produit porte le `max + 1` que
    `create_product` a calculé avant la renumérotation. Conséquence
    bornée : dans une catégorie historique dont toutes les valeurs
    étaient basses (ex æquo à 0), ce nouveau produit peut se retrouver ex
    æquo avec un produit renuméroté au lieu d'être dernier, jusqu'au
    déplacement suivant. Aucun ordre validé n'est écrasé, aucune position
    existante n'est dupliquée. Un produit créé **avant** que le déplaceur
    ne valide est, lui, toujours détecté (cas 5). Fermer cette fenêtre
    demande que ces deux RPC participent au verrou d'établissement :
    c'est une décision hors du périmètre de cette remédiation, signalée
    ici pour qu'elle soit prise en connaissance de cause.

---

## §9 — Reproduire

```bash
# tests dédiés (commande standard, fichier par fichier)
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
#   (+ SCANYM_HARNESS_DEFAULT_SOCKET_BAIT=1 pour l'appât, si le socket
#      par défaut du poste est libre)

# contrôles de mutation
SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/evidence/catalogue-product-reorder-v1.1/mutation/run-mutations.sh pglite
SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/evidence/catalogue-product-reorder-v1.1/mutation/run-mutations.sh realpg
SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/evidence/catalogue-product-reorder-v1.1/mutation/run-mutations.sh lib

# suite, types, build
npm test
npx tsc --noEmit -p tsconfig.json
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npx next build
```

Les deux scripts shell s'exécutent sous un utilisateur ordinaire (depuis
root : `su postgres -c "SCANYM_DISPOSABLE_CLUSTER=1 bash …"`), dans un
environnement sans variable de connexion PostgreSQL.

## §10 — Contenu du paquet

| Fichier | Contenu |
|---|---|
| `manifest.json` | identités, environnement, résultats |
| `SHA256SUMS.txt` | empreintes des fichiers du paquet |
| `audit-reproduction.txt` | CPR-AUDIT-01 rejoué sur le candidat refusé et sur la remédiation |
| `sql-harness.txt` | sortie complète du harnais PostgreSQL réel (263 preuves) |
| `harness-safety.txt` | sortie complète des sondes HARNESS-01..08 (92 preuves) |
| `dom-fflate-resolution-simulation.txt` | chargement du test DOM, candidat refusé puis remédiation |
| `dedicated.tap.gz` | TAP des trois fichiers de test du lot |
| `targeted.tap.gz` | TAP des 33 fichiers ciblés (catalogue, XLSX, contexte d'établissement, DOM) |
| `baseline.tap.gz`, `candidate.tap.gz` | TAP de la suite complète, base et candidat |
| `baseline-failures-sorted.txt`, `candidate-failures-sorted.txt`, `failure-delta.json` | identités d'échec et leur comparaison |
| `typescript.txt` | `tsc`, base et candidat |
| `build-baseline.txt`, `build-candidate.txt` | les deux builds |
| `mutation/` | scripts et résultats des contrôles de mutation |
| `stability/` | exécutions supplémentaires de la suite complète (tête ×2, base ×1) et mesure des tests intermittents |
| `changed-files.txt`, `remediation-vs-failed-candidate.patch` | diff `9661632..46bc04f` |
