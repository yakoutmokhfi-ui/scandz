# CHECKOUT SCHEDULING FOUNDATION v1.1 (CSDJ-1) — paquet de preuves
## Remédiation ciblée des six blockers d'audit

Verdict d'audit indépendant sur `091c3f0` : **FAIL**, six blockers. Ce
paquet accompagne le candidat de remédiation. Le candidat refusé reste
**intact** dans l'historique de la branche, comme grand-parent du
nouveau.

Remédiation **ciblée** : aucun redesign, aucun élargissement de portée,
aucune interface de paiement, aucun instantané de commande, aucune
surface Theme/MCC. **CSDJ-2 n'est pas commencé.**

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
`ok` / `nonexistent` / `ambiguous`, et `checkout_wall_time_instant()`
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
| tests ciblés CSDJ-1 | **121 / 0** (10 + 63 + 48) |
| régressions exigées | **285 / 0** (12 fichiers : tarification, zones, isolation, MCC) |
| harnais PostgreSQL du lot | **140 preuves / 0 échec** (18 sections) |
| harnais de restauration de rôles | **22 preuves / 0 échec** |
| contrôle de mutation AUD-06 | **13 échecs** avec le défaut réinjecté — le harnais discrimine |
| refus sans consentement | **EXIT 2** |
| refus d'un `PGPASSWORD` hérité | **EXIT 2**, valeur **jamais** journalisée |
| TypeScript | **0 diagnostic** |
| build | **EXIT 0**, 0 route ajoutée, premiers chargements inchangés |
| suite complète, base `412dbb5` | 4768 / 10 |
| suite complète, candidat | **4889 / 10** |
| identités d'échec | **0 apparue, 0 disparue** |

Les deux jeux d'identités d'échec sont **octet-identiques** (md5
`d788b58cd63f6c59be1b1195c76bc1c5`). Le delta de **+121** réussites est
exactement le nombre de tests ciblés de ce lot : aucun test existant n'a
changé de verdict, et **aucun échec déterministe n'est imputable au
candidat**.

Aucun non-déterminisme n'a été constaté : les deux exécutions sont
séquentielles et leurs jeux d'identités coïncident à l'octet. Les
preuves **par fichier** sont néanmoins fournies (`targeted.tap.gz`,
`regressions.tap.gz`) pour que chaque identité soit reproductible sans
rejouer la suite entière.

---

## §6 — Ce qui n'a pas régressé

L'audit avait validé quatre domaines : isolation multi-locataires,
réutilisation du moteur de tarification, retour arrière, frontière de
propriété Debussy. Tous sont conservés et **reprouvés** par le harnais
et par les tests structurels. Aucune fonction préexistante n'est
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
