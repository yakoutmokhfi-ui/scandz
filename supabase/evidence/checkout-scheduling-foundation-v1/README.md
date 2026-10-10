# CHECKOUT SCHEDULING FOUNDATION v1.2 (CSDJ-1) — paquet de preuves
## Seconde remédiation ciblée : CSDJ1-AUD-02 et CSDJ1-AUD-07

Deux verdicts se sont succédé sur ce lot.

| candidat | verdict | ce qu'il reste |
| --- | --- | --- |
| `091c3f0` | **FAIL** — six blockers | — |
| `d94a110` (première remédiation) | **FAIL** — six clos, deux restants | AUD-02 incomplet, AUD-07 nouveau |
| `993cb7b` (ce candidat) | prêt pour second re-audit delta | — |

Aucun des deux candidats refusés n'est amendé ni réécrit : ils restent
**intacts** dans l'historique, en ancêtres de celui-ci.

Remédiation **narrow** : aucun redesign, aucun élargissement de portée,
aucun contrat déjà clos modifié au-delà du strict nécessaire.
**CSDJ-2 n'est pas commencé.**

§0 ci-dessous traite les deux blockers de ce tour. §1 à §7 décrivent les
six blockers du tour précédent et restent valables : ils ont tous été
**re-prouvés** après la correction d'isolation d'AUD-07 (voir §0.3).

---

## §0 — Les deux blockers de ce tour

### §0.1 CSDJ1-AUD-02 (P1) — la validation d'heure murale était incomplète

Le re-audit delta a produit trois reproductions, et deux reproches
distincts se cachaient derrière.

| reproduction | comportement fautif |
| --- | --- |
| `Europe/Paris 2026-03-29` fenêtre `01:30–02:30` | offerte, **fin comprise**, alors que 02:30 n'existe pas |
| `Europe/Paris 2026-03-29` fenêtre `01:30–03:30` | pouvait exposer des points de grille inexistants, **au choix du client** |
| `Australia/Lord_Howe 2026-04-05 01:45` | traitée comme valide alors qu'elle est **ambiguë** |

**Premier reproche : une hypothèse de taille.** La version précédente
cherchait l'ambiguïté en comparant à **plus ou moins une heure**. Lord
Howe recule de **trente** minutes : 01:45 y est vécue deux fois, et ce
test ne pouvait pas la voir. L'audit l'a dit en une phrase — « DST
transitions are NOT always exactly 60 minutes » — et c'est la phrase qui
condamne toute la méthode, pas seulement sa constante.

La classification n'émet donc plus **aucune** hypothèse sur la durée
d'une transition :

1. lire le décalage UTC en vigueur à cinq sondes autour de l'instant
   naïf — `−1 jour`, `−4 h`, `0`, `+4 h`, `+1 jour` — et ne retenir que
   les décalages **distincts** ;
2. pour chaque décalage distinct, construire un instant candidat
   `heure murale − décalage` ;
3. ne garder que les candidats qui, **re-rendus dans le fuseau**,
   redonnent exactement la date et la minute demandées ;
4. **compter** : zéro candidat → `nonexistent`, un → `valid_unique`,
   deux ou plus → `ambiguous`.

L'étape 3 est ce qui interdit la normalisation silencieuse : on ne fait
jamais confiance au résultat d'une conversion, on vérifie l'aller-retour.
L'étape 4 est ce qui remplace l'hypothèse : la réponse est un
**comptage**, et aucune durée n'y intervient. `[AUD02-SQL-2]` interdit
structurellement toute constante d'une heure (`1 hour`, `3600`,
`interval '01:00'`, `hours => 1`, `3_600_000`) dans la décision, des
deux côtés.

Le classement est un **catalogue fermé de trois valeurs**,
`public.checkout_wall_time_statuses()`, miré par `[MIRROR-9]`. Le statut
`ok` de la version précédente est devenu `valid_unique` : « ok » ne
disait pas *ce qui* était vrai. Il n'était exposé par aucune surface
publique, donc rien ne change pour un client.

**Second reproche : une hypothèse de suffisance.** Valider le seul
**début** laissait passer une fin inexistante et des points de grille
inexistants. `CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01` : une occurrence est
exposée **en entier ou pas du tout**. Début, fin et **chaque** point de
la grille sélectionnable doivent être `valid_unique` ; un seul point non
univoque et l'occurrence disparaît **ce jour-là**. Aucune heure de
remplacement n'est inventée.

Le refus porte sur l'**occurrence d'une date**, jamais sur la
configuration : la même fenêtre reste valide les 364 autres jours. C'est
pourquoi il ne peut pas être prononcé à l'écriture — et `[AUD02-10]` le
prouve.

Tous les points de la grille sont validés, pas seulement la part encore
réalisable : sur une date ordinaire, le client pourrait choisir
n'importe lequel d'entre eux.

**Résultat sur Lord Howe** (`wall-time-three-way-agreement.txt`) :

| instant | classement |
| --- | --- |
| `2026-04-05 01:00` | `valid_unique` |
| `2026-04-05 01:30` | `ambiguous` |
| `2026-04-05 01:45` | `ambiguous` ← le cas exact du re-audit |
| `2026-04-05 01:59` | `ambiguous` |
| `2026-04-05 02:00` | `valid_unique` |
| `2026-10-04 02:00 / 02:10 / 02:29` | `nonexistent` (saut de trente minutes) |
| `2026-05-03 01:45` | `valid_unique` — la politique ne **sur-refuse** pas |

Côté offres : `aud02-lord-howe-autumn-30min-ambiguous` n'expose plus que
`t0100` et `t0200` — **`t0145` a disparu**.

**Accord à trois voies.** Les trois implémentations — Python
(`resolve_wall`), TypeScript (`resolveWallTime`) et le SQL du lot
(`checkout_wall_time_status`, extraite **littéralement** du fichier et
créée dans un cluster jetable) — s'accordent sur **38 points de
classification** et sur les **48 cas de fixture**, avec **zéro**
divergence. Zones couvertes : Europe/Paris, Australia/Lord_Howe (30 min),
UTC (aucune transition), Pacific/Kiritimati (UTC+14),
America/Los_Angeles et America/New_York (décalages négatifs),
Pacific/Chatham et Asia/Kathmandu (décalages à 45 minutes de l'heure).

### §0.2 CSDJ1-AUD-07 (P1) — le harnais de rôles n'était pas isolé

`q()` héritait des variables libpq de l'environnement appelant.
**`PGHOSTADDR` l'emporte sur un `-h` explicite** : le harnais pouvait
donc muter les rôles **globaux** d'un autre serveur que celui que le
verrou de sûreté avait constaté — et ne s'en apercevoir qu'après.

Trois défenses, dans cet ordre.

**1. Refus par le nom.** 27 variables de routage, refusées dès le
démarrage avec le code 2 : `PGHOST`, `PGHOSTADDR`, `PGPORT`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`,
`PGSERVICEFILE`, `PGSYSCONFDIR`, `PGCLUSTER`, `PGREQUIRESSL`,
`PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`, `PGOPTIONS`,
`PGCONNECT_TIMEOUT`, `PGTARGETSESSIONATTRS`, `PGDATA`, `DATABASE_URL`,
`POSTGRES_URL`, `POSTGRESQL_URL`, `PG_URL`, `SUPABASE_DB_URL`,
`SCANYM_DB_URL`, `SCANYM_DATABASE_URL`. Puis un balayage défensif retire
toute autre `PG*` héritée, pour qu'un oubli de la liste ne subsiste pas.

Le refus **nomme la variable et jamais sa valeur** : une valeur peut
être un secret. `harness-refusal-redirect-var.txt` le montre, et chaque
vecteur hostile vérifie que la valeur n'apparaît nulle part dans la
sortie.

**2. Isolation.** Chaque appel client s'exécute en
`env -i PATH=<sûr> HOME=<jetable>`, avec un binaire résolu en chemin
**absolu** (un binaire résolu par le `PATH` est un binaire que le `PATH`
peut remplacer) et une destination entièrement explicite
`-h/-p/-U/-d`. `[E]` le vérifie **structurellement** : il reconstitue
les lignes **logiques** du fichier — continuations recollées, car
`env -i … \` suivi de `"$PSQL" …` est une seule commande et un contrôle
ligne à ligne la déclarerait faussement nue — et compte ce qu'il examine,
parce qu'un détecteur qui ne trouve rien passerait pour vert.

**3. Preuve d'identité, immédiatement avant chaque mutation.** Sept
faits comparés : socket unix (donc **aucune** destination réseau),
`data_directory`, `config_file`, port, `current_user`, `is_superuser`, et
un **nonce** que seul le cluster créé par ce fichier porte. Si la preuve
échoue : **abandon avant mutation**. La même preuve adressée au cluster
témoin échoue — elle **discrimine**.

Le harnais principal ferme le même trou côté nettoyage : destination
changée ⇒ `RESTAURATION DE RÔLES ABANDONNÉE`, plutôt que muter le mauvais
serveur. Un rôle non restauré est un désagrément ; un rôle muté sur le
mauvais serveur est un dégât.

**Un défaut trouvé dans la preuve elle-même.** `pg_catalog.current_user`
n'est pas une fonction qualifiable : c'est un **constructeur du
parseur**, lu comme la colonne `current_user` d'une table `pg_catalog`,
et la requête échouait (`missing FROM-clause entry for table
pg_catalog`, vérifié empiriquement dans un cluster jetable). Même
famille que `coalesce`, `nullif`, `extract` et `unnest` multi-tableaux.

Une preuve **cassée** se comporte comme une preuve **échouée** : elle
abandonne la restauration. Fermé, donc sans danger — mais **muet**, et
le chemin de restauration aurait été mort sans que rien ne le dise.
`[A]` exige désormais qu'une exécution **nominale** ne l'abandonne
jamais, et le contrôle de mutation M4 prouve que cette garde voit une
preuve cassée.

**La menace est démontrée, pas déclarée.** Un refus qui protège d'un
danger inexistant ne prouve rien. Le fichier crée donc un **cluster
témoin** qui écoute en TCP sur `127.0.0.1` au **même numéro de port** que
le cluster sous test — lequel n'écoute **aucun** TCP, n'occupant que sa
socket privée. La redirection est ainsi réellement possible, et `[F]` la
reproduit en **lecture seule** :

| appel | destination atteinte |
| --- | --- |
| `PGHOSTADDR=127.0.0.1 PGPORT=<port>` + `-h <socket privée>` | **le témoin** |
| le même, sous `env -i` | le cluster sous test |

Onze variables hostiles sont ensuite éprouvées une par une, le harnais
étant relancé **en enfant** avec la variable pointant vers le témoin.
Pour chacune : refus avec le code 2, le refus **nomme** la variable, la
valeur n'apparaît **nulle part**, et le témoin subit **zéro** mutation.
Puis le vecteur complet `PGHOSTADDR + PGPORT` ensemble. Puis un
**contrôle positif** : un environnement propre ne déclenche pas ce refus
et atteint bien le cluster sous test — sans quoi un harnais qui refuserait
tout passerait pour protégé.

**87 preuves, 0 échec** (`harness-role-restoration.txt`).

### §0.3 Contrôles de mutation, et AUD-06 re-prouvé

Un harnais vert ne prouve rien si le défaut qu'il interdit peut être
réinjecté sans qu'il échoue.
`supabase/tests/checkout-scheduling-foundation-v1-mutation-controls.sh`
est **versionné** pour que l'audit le rejoue
(`harness-mutation-controls.txt`) :

| contrôle | défaut réinjecté | résultat |
| --- | --- | --- |
| **M1** | un `env -i` retiré devant un appel `psql` | **détecté** — « appel non isolé », code 1 |
| **M2** | — | la nocivité de `PGHOSTADDR` est prouvée par **démonstration directe** en lecture seule (`[F]`), non par mutation : muter le harnais aurait supprimé son propre garde-fou de récursion et prouvé moins |
| **M3** | l'instantané de rôle en `::text` comparé à `'t'` — le défaut d'**AUD-06** | **détecté** — 13 échecs décrivant `LOGIN → NOLOGIN` et `BYPASSRLS → NOBYPASSRLS` |
| **M4** | preuve d'identité tardive cassée | **dénoncée** — « la restauration a été ABANDONNÉE sur le cluster désigné » |

`harness-role-restoration-mutation.txt` est conservé : c'est le contrôle
de mutation du tour **précédent**, conduit sur le harnais d'alors. M3 le
reconduit sur le harnais **réécrit**, et c'est M3 qui fait foi pour ce
candidat.

M3 est la réponse à l'exigence du mandat : **AUD-06 reste clos**
après la correction d'isolation d'AUD-07. Les quatre combinaisons
`LOGIN × BYPASSRLS` et le rôle initialement **absent** sont restaurés
exactement, en mode cluster **désigné** — le seul où la restauration a
des conséquences durables — et le harnais voit encore le défaut quand on
le réinjecte.

### §0.4 Discipline de portée

Aucun redesign. Aucun contrat déjà clos modifié, à une exception près et
strictement nécessaire : l'ajout du catalogue des trois statuts d'heure
murale et le renommage de `ok` en `valid_unique`, qu'aucune surface
publique n'expose. CSDJ-2 **non commencé**.

Le défaut d'isolation d'environnement existe **aussi** dans
`supabase/tests/merchant-customer-communications-v1-check.sh`, dont ce
harnais est dérivé. **Non corrigé ici** : le mandat interdit d'élargir la
portée. Signalé dans `aud06-same-defect-elsewhere.txt`.

---

## §1 — Les six blockers, et ce qui les ferme

### CSDJ1-AUD-01 (P1) — le délai filtrait des dates, pas des offres

Le délai de préparation n'était appliqué qu'à la **date de départ**. Un
créneau 09:00–11:00 avec 120 minutes de délai restait donc proposé à
15:00 : la date passait le filtre, et personne ne regardait l'offre.

`CSDJ-V1-OFFER-START-INSTANT-01` : chaque offre est désormais comparée
en **instant** à `max(now + lead_time_minutes, plancher de (today +
min_lead_days) dans le fuseau)`. Une offre dont le **début** tombe avant
est écartée — y compris un créneau déjà commencé, qui n'est plus
honorable en entier. Une date dont toutes les offres sont écartées cesse
d'être éligible.

Aucune offre n'est fabriquée. Pour `time_within_window`, le début est
**avancé** le long de la grille de granularité du commerçant jusqu'au
premier point utilisable, et la fenêtre disparaît si la grille en sort :
c'est la part encore utilisable d'une fenêtre existante, pas un créneau
nouveau. La grille reste ancrée sur le début **configuré**, pour rester
celle que le commerçant a décrite.

Nouveau motif `no_offer_in_horizon`, distinct de `horizon_exhausted` :
dans le premier cas des dates étaient ouvertes et ce sont les **offres**
qui ne tenaient plus — on desserre le délai ou on attend ; dans le
second la première date possible est au-delà de l'horizon — on allonge
l'horizon. Les confondre livrerait au commerçant un refus qu'il ne sait
pas corriger.

### CSDJ1-AUD-02 (P1) — heure murale inexistante ou ambiguë

Le serveur acceptait `Europe/Paris 2026-03-29 02:10–02:50`, un intervalle
qui **n'a pas eu lieu** : PostgreSQL le normalisait en silence. Une
normalisation de moteur n'est pas une politique commerciale.

`CSDJ-V1-WALL-TIME-FAIL-CLOSED-01` : **refus fermé des deux cas** —
l'heure inexistante du saut de printemps et l'heure ambiguë du recul
d'automne. Pour une heure ambiguë, « nous vous livrons à 02:30 »
désignerait deux instants distants d'une heure, et personne n'aurait
choisi lequel. Un refus, lui, est visible et corrigeable.

Deux autorités nouvelles : `checkout_wall_time_status()` classe
`valid_unique` / `nonexistent` / `ambiguous` (nommé `ok` au tour
précédent, voir §0.1), et `checkout_wall_time_instant()`
rend `NULL` dès que l'heure n'est pas univoque. Ce `NULL` est un
**refus**, jamais une absence de valeur — c'est pour cela qu'il n'y a
pas de repli. Miroir TypeScript : `resolveWallTime()`.

Le refus porte sur l'**occurrence** d'une date, pas sur la
configuration : une fenêtre 02:00–03:00 reste valide les 364 autres
jours de l'année, et c'est précisément pourquoi ce refus ne peut pas
être prononcé à l'écriture.

### CSDJ1-AUD-03 (P1) — mode de vente désactivé encore exposé

`restaurant_sale_modes.enabled = false`, et la lecture publique
projetait quand même : l'activation n'était vérifiée qu'indirectement,
pour la livraison, via l'autorité de tarification.

`CSDJ-V1-MODE-ENABLED-GATE-01` : la garde précède **toute** projection,
pour tous les modes. La réponse est celle d'une absence,
**volontairement indiscernable** de « aucune planification » et de
« planification désactivée » : un statut distinct ferait de la surface
publique un moyen de sonder la configuration d'un commerçant. Ni
fuseau, ni politique, ni granularité, ni date, ni offre ne traversent.

### CSDJ1-AUD-04 (P2) — précision perdue à la sérialisation

Un créneau `09:00:01–09:00:59` se publiait « 09:00–09:00 » tout en
restant disponible : une offre de **durée nulle** affichée comme
réservable.

`CSDJ-V1-MINUTE-PRECISION-01` : toute heure de configuration est à la
minute, secondes exactement `00`. Une valeur sous-minute est **refusée,
jamais tronquée** — tronquer était le défaut, parce que la configuration
disait une chose et la projection une autre. Contrainte sur **chaque**
colonne `time` des trois tables, refus nommé `CSDJ1_SUBMINUTE_TIME` dans
la RPC d'écriture, et `parseScheduleTime` qui refuse au lieu d'arrondir.

`CSDJ-V1-NO-24H-01` : `24:00` est refusé explicitement. Une fin de
journée se déclare `23:59`, sinon chaque comparaison, chaque formatage
et chaque calcul d'instant devrait connaître ce cas particulier — et il
suffit d'un endroit qui l'oublie pour décaler une date d'un jour.

### CSDJ1-AUD-05 (P2) — anti-dérive qui acceptait les sosies

Le pré-vol cherchait les colonnes par **sous-chaîne** dans le texte de
la signature : `not_eligible` contient « eligible », `not_block`
contient « block ». Le lot s'appliquait, puis échouait en `42703` à la
première lecture — c'est-à-dire en production, et non à l'application.

`CSDJ-V1-RESOLVER-EXACT-SHAPE-01` : vérification par **introspection du
catalogue**. Nom exact et type exact de chaque colonne de sortie, lus
dans `pg_proc` via `unnest(proargnames, proargmodes, proallargtypes)` en
ne retenant que les colonnes de mode `t`. Plus l'exigence d'une
surcharge **unique**, sans laquelle le contrôle serait ambigu. Aucune
heuristique textuelle.

Cinq mutations prouvent le refus — sosie par sous-chaîne, colonne
renommée, mauvais type, colonne absente, surcharge supplémentaire — et
chacune vérifie en outre qu'**aucun objet du lot n'a été créé** avant le
refus. Un **contrôle positif** prouve qu'une forme conforme s'applique :
sans lui, un garde qui refuserait tout passerait pour un garde correct.

### CSDJ1-AUD-06 (P2) — restauration de rôles corrompue

`boolean::text` rend « true », jamais « t » — « t » est la forme de
l'affichage **aligné** de psql. La capture employait `::text` et la
comparaison testait « t » : elle échouait toujours, et la branche de
repli restaurait `NOLOGIN NOBYPASSRLS`. Invisible sur un cluster jetable
détruit juste après ; **durable** sur un cluster désigné par
l'opérateur.

L'instantané encode désormais `1`/`0`, la restauration compare à
`1`/`0`, et le verrou de sûreté n'accepte que les quatre instantanés
bien formés : un instantané d'une autre forme fait **refuser**
l'exécution plutôt que muter un cluster non restaurable.

Un harnais dédié prouve la restauration **exacte** des quatre
combinaisons `LOGIN × BYPASSRLS` sur les trois rôles, en mode **cluster
désigné** — le seul où la restauration a des conséquences durables —
plus le cas du rôle initialement absent.

Et un **contrôle de mutation** : le défaut réinjecté dans une copie hors
dépôt produit **13 échecs** décrivant exactement la corruption que
l'audit a décrite (`LOGIN → NOLOGIN`, `BYPASSRLS → NOBYPASSRLS`). Sans
ce contrôle, 22 preuves vertes ne diraient pas si le harnais sait
détecter quoi que ce soit.

**Le même défaut existe ailleurs** : `merchant-customer-communications-v1-check.sh`
(lignes 340 et 376), d'où ce harnais a été dérivé. Non corrigé ici — le
mandat interdit d'élargir la portée — et signalé dans
`aud06-same-defect-elsewhere.txt` pour planification.

---

## §2 — Observations étroites closes

**Zéro UUID réservé.** La sentinelle interne de « portée de mode » est
désormais interdite comme `fulfillment_rule_id` : contrainte
`rfs_rule_id_not_sentinel` et refus nommé `CSDJ1_RESERVED_RULE_ID`. Sans
cela, « portée de mode » et « portée de cette règle-là » deviendraient
indiscernables le jour où une règle porterait cette valeur.

**Horizon 0.** L'horizon accepte désormais `0`, « aujourd'hui
seulement » : c'est un cas commerçant réel, et la forme minimale dans
laquelle se reproduit AUD-01.

---

## §3 — Observations laissées ouvertes, et pourquoi

**`display_order` n'ordonne rien.** L'ordre des offres est celui des
heures de début : déterministe, et indépendant d'une saisie. La colonne
est réservée à l'éditeur back-office, hors CSDJ-1. Aucun invariant v1
n'est violé — le redesigner serait élargir la portée.

**Créneaux nommés qui se chevauchent.** Autorisé, et voulu : « matin »
09:00–13:00 et « midi » 12:00–14:00 sont une offre commerciale
légitime. Les **fenêtres**, elles, ne peuvent pas se superposer, parce
qu'elles décrivent une ouverture et non un choix. Aucun invariant v1
n'est violé.

**Coordination du retour arrière avec CSDJ-3.** Le point d'extension
existe déjà : le retour **refuse** de passer si
`public.order_fulfillment_schedule_snapshot` est présente, avec
`SCANYM_ROLLBACK_REFUSED`. CSDJ-3 n'est pas implémenté.

---

## §4 — Preuve de la fixture Python

L'audit a eu raison : une preuve « indépendante » dont la source n'est
pas livrable n'est pas vérifiable. La revendication est **maintenue** et
désormais vérifiable.

| | |
|---|---|
| source | `tests/fixtures/build-checkout-scheduling-cases.py`, versionnée au dépôt |
| commande | `python3 -I tests/fixtures/build-checkout-scheduling-cases.py` |
| journal | `fixture-generation.log` |
| Python | 3.13.16 (CPython) |
| base de fuseaux | **tzdata 2026c** (`/usr/share/zoneinfo`, paquet système `2026c-0ubuntu0.24.04.1`) |

Relancer le générateur reproduit `checkout-scheduling-cases.json` **à
l'octet** — vérifié par comparaison d'empreinte avant/après. Un test
structurel `[FIXTURE-SOURCE-1]` vérifie qu'il ne **lit** ni n'**exécute**
aucune des deux implémentations qu'il juge, et qu'il tire ses fuseaux de
la bibliothèque standard.

La fixture passe de 20 à **36 cas**, dont neuf pour AUD-01 et six pour
AUD-02 (Paris printemps et automne, UTC, UTC+14, décalage négatif dans
les deux sens).

---

## §5 — Résultats mesurés

| Vérification | Résultat |
|---|---|
| tests ciblés CSDJ-1 | **140 / 0** (10 + 78 + 52) |
| régressions exigées | **285 / 0** (12 fichiers : tarification, zones, isolation, MCC) |
| harnais PostgreSQL du lot | **152 preuves / 0 échec** (18 sections, dont 18 cas `aud02-*` rejoués) |
| harnais d'isolation et de restauration de rôles | **87 preuves / 0 échec** (sections `[A]`–`[F]`) |
| contrôles de mutation M1 / M3 / M4 | **3 concluants / 0 manquant** — les harnais voient ce qu'ils interdisent |
| accord à trois voies, classification | **38 points / 0 divergence** |
| accord à trois voies, fixture | **48 cas / 0 divergence** |
| fixture reproductible | **à l'octet** (`sha256 0601c074…`, python 3.13.16 / tzdata 2026c) |
| refus sans consentement | **EXIT 2**, « aucune mutation n'a été tentée » |
| refus d'un `PGHOSTADDR` hérité | **EXIT 2**, valeur **jamais** journalisée (0 occurrence) |
| TypeScript | **0 diagnostic** |
| build | **EXIT 0**, 39 routes, aucune route ajoutée |
| suite complète, base `412dbb5` | 4768 / 10 |
| suite complète, première remédiation `d94a110` | 4889 / 10 |
| suite complète, ce candidat `993cb7b` | **4918 tests, 4908 / 10** |
| identités d'échec | **0 apparue, 0 disparue** |

Les jeux d'identités d'échec de la **base**, de la **première
remédiation** et de **ce candidat** sont **octet-identiques** (md5
`d788b58cd63f6c59be1b1195c76bc1c5`). Le delta de **+19** réussites par
rapport à la première remédiation est exactement le nombre de tests
ciblés ajoutés ce tour (+15 en éligibilité, +4 en structurel) : aucun
test existant n'a changé de verdict, et **aucun échec déterministe n'est
imputable au candidat**.

Les dix échecs sont les dix échecs **préexistants** de la base. Aucun
non-déterminisme n'a été constaté au cours de ce tour : l'exécution est
séquentielle (`--test-concurrency=1`) et les jeux d'identités coïncident
à l'octet. Les preuves **par fichier** sont néanmoins fournies
(`targeted.tap.gz`, `regressions.tap.gz`) pour que chaque identité soit
reproductible sans rejouer la suite entière.

Le build exige la **présence** des variables d'environnement Supabase à
la collecte des pages. Il a été lancé avec des valeurs **synthétiques et
non fonctionnelles** ; aucun secret réel n'intervient, et les 39 routes
sont identiques à celles de la première remédiation.

---

## §6 — Ce qui n'a pas régressé

Le second re-audit delta a déclaré **onze** domaines clos. Tous sont
conservés et **re-prouvés** après la correction d'isolation d'AUD-07 :

| domaine clos | preuve de non-régression |
| --- | --- |
| CSDJ1-AUD-01 | fixtures `aud01-*` rejouées (TypeScript **et** SQL), `[AUD01-1..5]`, `[AUD01-SQL]` |
| CSDJ1-AUD-03 | harnais `[15a]`–`[15g]`, `[AUD03-SQL]` |
| CSDJ1-AUD-04 | harnais `[16a]`–`[16i]`, `[MODEL-8]`, `[MODEL-10]`, `[AUD04-1..2]` |
| CSDJ1-AUD-05 | harnais `[18]` : contrôle positif + cinq sosies, `[AUD05-SQL]` |
| CSDJ1-AUD-06 | 87 preuves du harnais de rôles **après** la correction d'AUD-07, + contrôle de mutation M3 |
| zéro UUID réservé | harnais `[17]`, `[SENTINEL-1]` |
| indépendance de la fixture Python | §4, reproductibilité à l'octet re-vérifiée, `[FIXTURE-SOURCE-1]` |
| isolation multi-locataires | harnais `[3]`, tests de tenant obsolète dans les régressions |
| réutilisation de l'autorité de tarification | harnais `[10]`, `[13e]` empreinte inchangée, `[NO-SECOND-ENGINE-1..2]` |
| retour arrière | harnais `[13a]`–`[13g]` : retour, refus CSDJ-3, second retour refusé, seconde application refusée |
| frontière de propriété Debussy | `[OWNERSHIP-1..3]` : aucune clé `how_to_order_*`, catalogue MCC toujours exactement 14 clés, aucun import i18n |

Aucune fonction préexistante n'est redéfinie : `create_order` et
`resolve_delivery_fulfillment` sont intactes, et le post-vol comme le
harnais le constatent. Aucune fonction préexistante n'est
redéfinie : `create_order` et `resolve_delivery_fulfillment` sont
intactes, et le post-vol comme le harnais le constatent.

Préservés également : aucune fuite de fournisseur, aucun second moteur
de prix, aucun texte Theme/MCC, aucune interface de paiement, aucun
instantané de commande, aucune API transporteur, aucune application
hébergée, aucun merge, aucun déploiement.

---

## §7 — Limites

SQL **DRAFT** uniquement. Aucun merge, aucun déploiement, aucun PREPROD,
aucune mutation Production, aucune modification de `main`. Le candidat
n'est pas poussé : le proxy git de la session refuse l'écriture sur ce
dépôt.
