# CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1) — paquet de preuves

Premier des trois sous-lots imposés par la décision CIO sur
*CHECKOUT SCHEDULING & DELIVERY JOURNEY v1*. Il ne touche **aucun
parcours client** : il pose le modèle de données, l'autorité de calcul
serveur et la lecture publique sûre dont CSDJ-2 aura besoin.

---

## §1 — Ce que ce lot livre

Quatre tables, portées par le triplet **exact** *(restaurant, mode de
vente, règle de fulfillment)* : la politique de planification, les
fenêtres hebdomadaires, les créneaux nommés à identifiant stable, les
fermetures exceptionnelles. Chaque portée a son **fuseau IANA**, son
heure limite avec un décalage en jours, son délai de préparation, son
minimum de jours, son horizon de réservation et sa granularité.

Une autorité de calcul en SQL, `public.resolve_fulfillment_schedule()`,
qui lit l'**horloge du serveur** et le fuseau du **commerçant**, et
énumère les dates et offres éligibles. Elle n'est accordée à aucun rôle
applicatif : personne ne peut lui choisir son « maintenant ».

Une lecture publique, `public.get_checkout_fulfillment_schedule()`,
accordée à `anon`. Elle **appelle** l'autorité de tarification existante
`public.resolve_delivery_fulfillment` sans la modifier ni recopier sa
formule, et expose **strictement moins** que la projection publique
actuelle : ni `provider`, ni `fulfillment_code`, ni
`fulfillment_rule_id`, ni `zone_prefixes`. Le client ne choisit donc pas
son transporteur — c'est une configuration métier.

Une seule RPC d'écriture, réservée à **owner/manager**, sous verrou
consultatif par tenant, qui valide le fuseau contre `pg_timezone_names`,
les politiques contre les catalogues fermés, l'appartenance d'une règle
de livraison à l'établissement **et** au mode, et la non-superposition
des fenêtres d'un même jour. Les tables n'ont **aucun** grant
d'écriture : il n'existe aucun autre chemin.

---

## §2 — Les deux invariants que le CIO a nommés

**Absence de configuration = comportement actuel.**
`CSDJ-V1-SCHEDULE-ABSENT-01` : sans ligne de planification, et avec une
ligne `enabled = false`, le statut rendu est `absent` et **rien
d'autre** — pas même le fuseau. Les deux cas rendent le *même* objet,
sinon activer puis désactiver laisserait une trace de comportement.
C'est l'état de 100 % des commerçants au moment de ce lot.

**Configuré mais infaisable = échec explicite.**
`CSDJ-V1-UNFULFILLABLE-EXPLICIT-01` : une planification activée dont la
politique **exige** une date, et pour laquelle aucune date n'est
éligible, rend `unfulfillable` avec un motif du catalogue fermé, et
**aucune date**. Jamais une date de repli, jamais la date du jour,
jamais « dès que possible ». Les motifs distinguent « tout est fermé »
(qui se corrige en retirant une fermeture) de « horizon épuisé » (qui se
corrige en allongeant l'horizon) : un refus dont on ne sait pas dire la
cause est un refus qu'on ne saura pas corriger.

Les cinq autres invariants nommés sont dans `manifest.json` et en tête
du fichier SQL.

---

## §3 — La preuve croisée à trois implémentations

`tests/fixtures/checkout-scheduling-cases.json` porte **20 cas**. Leurs
attendus ont été produits par une **troisième implémentation
indépendante**, en Python avec `zoneinfo`, précisément pour qu'aucune des
deux implémentations livrées ne soit juge de sa propre sortie. Les mêmes
cas sont ensuite rejoués par `lib/scheduling/eligibility.ts` et par
l'autorité SQL.

Le 20e cas décrit un état que les **contraintes de table** rendent
impossible. Le TypeScript le joue quand même, pour prouver que le calcul
refuse au lieu de deviner ; le harnais SQL, lui, prouve que
l'**insertion** est refusée — preuve plus forte, puisque l'état n'est pas
seulement mal calculé, il est inatteignable.

Les cas couvrent : première date éligible, heure limite une seconde
avant, heure limite **pile**, jours de semaine fermés, fermeture
exceptionnelle, délai de préparation repoussant le jour, créneaux fixes
sans jour même, transporteur informatif, date dérivée unique, aucune
offre configurée, toutes les dates fermées, horizon épuisé, granularité
manquante, les deux bascules d'heure européennes de 2026, un fuseau à
UTC+14 et un fuseau à l'ouest d'UTC.

---

## §4 — Résultats mesurés

| Vérification | Résultat |
|---|---|
| tests ciblés CSDJ-1 | **83 / 0** (9 + 34 + 40) |
| régressions tarification et isolation | **199 / 0** (8 fichiers) |
| harnais PostgreSQL du lot | **94 preuves / 0 échec** |
| refus sans consentement | **EXIT 2**, aucune opération destructive |
| refus d'un `PGPASSWORD` hérité | **EXIT 2**, valeur **jamais** journalisée |
| TypeScript `tsc --noEmit` | **0 diagnostic** |
| build base / candidat | **EXIT 0 / EXIT 0**, 0 route ajoutée |
| suite complète, base `412dbb5` | 4768 / 10 |
| suite complète, candidat | **4851 / 10** |
| identités d'échec | **0 apparue, 0 disparue** |

Les deux jeux d'identités d'échec sont **octet-identiques** (md5
`d788b58cd63f6c59be1b1195c76bc1c5`). Les dix échecs sont les dix échecs
préexistants du dépôt. Le delta de réussites, **+83**, est exactement le
nombre de tests ajoutés par ce lot — aucun test existant n'a changé de
verdict.

Les premiers chargements sont **inchangés au kilooctet** (`/r/[slug]`
248 kB, `/dashboard/settings` 234 kB, `/track/[orderId]` 155 kB) : ce lot
n'ajoute aucun octet au navigateur, puisqu'il ne pose aucun composant et
que ses deux modules TypeScript ne sont importés par aucune page. C'est
le signe attendu d'un sous-lot de fondation.

---

## §5 — Bornes de propriété respectées

Ajustement obligatoire n°1 de la décision CIO : la surface éditoriale et
visuelle du bouton « Comment passer commande ? » appartient à
*THEME & CONTENT SETTINGS v1* (Debussy). Ce lot n'ajoute **aucune** clé
MCC `how_to_order_*`, **aucun** texte client, **aucune** clé i18n, et ne
modifie ni `DeliveryConditions` ni son style. Trois gardes structurelles
`[OWNERSHIP-1..3]` le vérifient, dont une qui constate que le catalogue
MCC porte toujours exactement 14 emplacements.

Le point d'intégration dont CSDJ-2 aura besoin est l'interface étroite
déjà existante : la vitrine appellera
`public.get_checkout_fulfillment_schedule`, et rien d'autre de ce lot.
Aucune seconde interface n'est créée.

---

## §6 — Observations non bloquantes

1. **Heures murales dans une heure de transition.** Pour une heure
   inexistante (saut de printemps) ou ambiguë (recul d'automne),
   PostgreSQL retient l'interprétation en heure normale tandis que le
   résolveur TypeScript retient la première occurrence : les deux côtés
   diffèrent d'une heure dans cette seule heure de l'année. La fixture
   n'emploie donc volontairement aucune heure murale située dans une
   heure de transition, et les deux bascules de 2026 sont néanmoins
   couvertes sur des heures non ambiguës. En pratique une heure limite
   ou une fenêtre à 02:30 est invraisemblable ; la refuser à l'écriture
   serait le correctif, et il appartient à un lot ultérieur.
2. **Pas d'éditeur back-office.** CSDJ-1 livre le modèle et ses RPC,
   mais aucune page de dashboard : aucun des trois sous-lots du mandat
   n'en nomme un, et en ajouter une serait une surface d'interface non
   arbitrée. Signalé plutôt que glissé dans ce lot. Tant qu'il n'existe
   pas, la configuration se pose par la RPC d'écriture.
3. **Fermetures de journée entière seulement.** Une fermeture partielle
   (« fermé l'après-midi du 24 ») n'est pas modélisée en v1 ; elle
   s'exprime aujourd'hui en remplaçant les fenêtres du jour concerné,
   ce qui est moins commode mais jamais ambigu.
4. **Portée exacte, sans héritage.** Un commerçant à cinq zones de
   livraison doit poser cinq planifications. C'est volontaire
   (`CSDJ-V1-SCOPE-EXACT-01`) : un héritage silencieux appliquerait au
   client les créneaux d'une zone qu'il n'habite pas. L'ergonomie de
   cette répétition appartient à l'éditeur back-office.
5. **Colonnes de remise non lues.** `CSDJ1-V1-RESOLVER-COMMON-COLUMNS-01` :
   les trois colonnes de remise n'existent que dans la variante
   *DELIVERY PRICING v2-B5* du résolveur, encore DRAFT non appliquée.
   Les lire ferait échouer l'application de CSDJ-1 sur l'état réel de la
   base. L'affichage de la remise est de toute façon le périmètre de
   CSDJ-2, qui lira la projection publique des règles — déjà porteuse de
   la remise, exactement comme la vitrine aujourd'hui.

---

## §7 — Limites

SQL **DRAFT** uniquement : rien n'a été appliqué à un Supabase hébergé.
Aucun merge, aucun déploiement, aucun PREPROD, aucune mutation
Production, aucune modification de `main`. Le candidat n'est pas poussé :
le proxy git de la session refuse l'écriture sur ce dépôt.
