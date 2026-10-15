# CSDJ-BO-1 — CONTRAT D'ÉCRITURE `save_fulfillment_configuration` (v1)

**Auteur** : Boulez (moteur de planification). **Mandat** : issue #148.
**Répond à** : `docs/scheduling/csdj-bo1-write-contract-request.md` (option A).
**Destinataire de l'intégration** : Nougaro (issue #149).
**Statut** : CANDIDAT POUR AUDIT INDÉPENDANT (Cat Greco). **Non fusionné,
non déployé, aucun SQL hébergé.** Les fichiers SQL sont des `DRAFT-lot-*` :
rien ne les applique sans GO CIO/CTO et audit.

> `CSDJ_BO1_WRITE_CONTRACT.available` **reste `false`** dans ce lot. Le
> basculer est la décision de l'interface, **après** audit, GO et
> application du SQL — jamais avant (issue #149).

---

## 1. Ce que livre ce lot

Trois fonctions dans `public`, rien de plus (aucune table, colonne,
contrainte, politique RLS, déclencheur, droit ni fonction existante n'est
créé, modifié ou supprimé — le pré-vol relève une empreinte de toute la
surface existante et le post-vol **annule tout** si elle a bougé d'un octet) :

| Fonction | Rôle | Qui peut l'exécuter |
|---|---|---|
| `save_fulfillment_configuration(p_restaurant_id uuid, p_payload jsonb) returns jsonb` | **Écrit** l'état voulu d'une portée **en entier**, en une transaction | `authenticated` seulement ; **owner** ou **manager** de l'établissement |
| `get_fulfillment_configuration(p_restaurant_id uuid, p_mode_code text, p_fulfillment_rule_id uuid default null) returns jsonb` | **Lit** la même configuration (même forme), avec ses deux jetons | `authenticated` ; **membre** de l'établissement ou opérateur Scanym (mêmes droits que les lectures existantes) |
| `csdjbo1_persisted_configuration(uuid, text, uuid) returns jsonb` | Constructeur **interne** partagé (la lecture et la réponse d'écriture ne peuvent pas diverger) | **personne** (fermé à tous les rôles applicatifs) |

Toutes trois : `SECURITY DEFINER`, `search_path = ''`, propriétaire = celui de
`mutate_merchant_fulfillment_schedule`, aucun droit pour `PUBLIC`, `anon` ni
`service_role`.

Pourquoi une fonction de lecture en plus ? Sans elle l'éditeur n'aurait
**aucun jeton d'anti-concurrence avant sa première sauvegarde**. L'ajouter
évite de modifier `get_merchant_fulfillment_schedules` (aucune lecture
existante n'est touchée — demande §2.3, seconde branche).

## 2. Appel

```ts
// Lecture (jeton initial) puis écriture, via PostgREST
const { data: current } = await supabase.rpc("get_fulfillment_configuration", {
  p_restaurant_id, p_mode_code: "pickup", p_fulfillment_rule_id: null,
}); // null si la portée n'existe pas encore

const { data, error } = await supabase.rpc("save_fulfillment_configuration", {
  p_restaurant_id,
  p_payload: { ...desiredConfiguration,
               expectedUpdatedAt: current?.updatedAt,   // tel quel, jamais re-formaté
               expectedRevision:  current?.revision },
});
```

Aucun SQL n'est jamais écrit par le navigateur. L'écriture n'est offerte
**qu'à travers cette fonction** : les six tables de planification n'ont
aucun droit d'écriture pour un rôle applicatif (prouvé, §10).

## 3. Charge d'écriture — l'état voulu, en entier

Remplacement **intégral** : toute liste absente est un **refus**
(`CSDJ1_INVALID_PAYLOAD`), jamais « inchangée ». Pour vider une liste, envoyer
`[]` explicitement. Toute clé inconnue est refusée (une faute de frappe n'est
jamais ignorée en silence). Aucune valeur par défaut côté serveur : le
serveur n'invente rien.

| Champ | Type | Obligatoire | Règle |
|---|---|---|---|
| `modeCode` | texte | oui | un mode du catalogue (`sale_mode_catalog`) |
| `fulfillmentRuleId` | uuid ou `null` | non (`null` = portée de mode) | une règle **de cet établissement et de ce mode** ; le zéro UUID est réservé |
| `method` | `"v1"` ou `"v1.2"` | oui | voir §3.1 |
| `enabled` | booléen | oui | **jamais implicite** ; `true` est **validé** (§6) |
| `expectedUpdatedAt` | texte ISO 8601 UTC ou absent/`null` | création : absent | **valeur rendue par le serveur, renvoyée telle quelle** (§5) |
| `expectedRevision` | texte (32 hex) ou absent/`null` | recommandé | **à toujours envoyer** (§5) |
| `policy` | objet | oui | voir ci-dessous |
| `windows` | tableau | oui | `[{weekday, startsAt, endsAt, displayOrder?}]`, 100 au plus |
| `slots` | tableau | oui | `[{weekday, slotKey, startsAt, endsAt, displayOrder?}]`, 200 au plus |
| `closures` | tableau | oui | `[{closedOn, label?}]`, 731 au plus |
| `preparation` | objet | **v1.2 : oui ; v1 : interdit** | `{weekdays: [0..6], closures: [{closedOn, label?}]}` |
| `holidays` | objet | **v1.2 : oui ; v1 : interdit** | `{calendarId, preparationOnHolidays, availabilityOnHolidays}` (`open`/`closed`) |
| `capacity` | objet | **v1.2 : oui ; v1 : interdit** | `{enabled, maxOrders}` ; `maxOrders` = LIMITE configurée (1 à 1 000 000) ou `null` |

`policy` : `timezone` (fuseau IANA connu du serveur), `dateSelectionMode`,
`slotSelectionMode`, `timeGranularityMinutes` (`null` ou 5 à 240),
`leadTimeMinutes` (entier ≥ 0), `minLeadDays` (0 à 365), `cutoffTime`
(`"HH:MM"` ou `null`), `cutoffOffsetDays` (v1 : **obligatoire**, 0 à 30 ; v1.2 :
absent ou `0`), `bookingHorizonDays` (0 à 365). **Toutes obligatoires** (sauf
`cutoffOffsetDays` en v1.2).

Heures à la **minute** (`"HH:MM"`), jours `0` (dimanche) à `6` (samedi),
`slotKey` : `a-z 0-9 _ -`, 1 à 40 caractères, unique par jour. Deux fenêtres du
même jour ne se superposent pas (le contact fin = début est permis ; même verdict
que le mutateur existant).

### 3.1 Méthode

* `"v1"` : fenêtres/créneaux, `cutoffOffsetDays` possible. Ni `preparation`,
  ni `holidays`, ni `capacity` (→ `CSDJBO1_METHOD_MISMATCH`).
* `"v1.2"` : calendrier de préparation, fériés, capacité. `cutoffOffsetDays`
  non nul → `CSDJBO1_METHOD_MISMATCH`.
* Changer de méthode = envoyer l'autre forme : la portée est **réécrite en
  entier** (les sections de l'ancienne méthode sont remises à leur valeur
  neutre, sans résidu).

## 4. Réponse — la configuration relue

Mêmes clés que la charge (sans les jetons attendus) **plus** :

* `updatedAt` : jeton de version, **microsecondes**, UTC (`2026-10-13T09:41:12.310417Z`),
  strictement croissant à chaque écriture de cette fonction ;
* `revision` : empreinte (32 hex) du **contenu** relu.

La section `preparation`, `holidays`, `capacity` n'est rendue **qu'en v1.2**.
**Aucun compte** : pas de remplissage, de places restantes, de réservations
(`capacity.maxOrders` est la limite configurée, pas un compteur). Aucun
secret, aucun SQLSTATE, aucun identifiant sensible hors `fulfillmentRuleId`
que l'appelant a lui-même fourni. `get_fulfillment_configuration` rend
exactement la même forme (ou `null` si la portée n'a pas de configuration).

## 5. Concurrence — le protocole que l'interface DOIT suivre

1. À l'ouverture d'une portée : `get_fulfillment_configuration` → garder
   `updatedAt` **et** `revision` (ou `null` : création).
2. À l'enregistrement : les renvoyer **tels quels** dans `expectedUpdatedAt`
   et `expectedRevision`. **Ne jamais** les passer par `Date` ou `toISOString()`
   (la précision est la microseconde ; JavaScript tronque à la milliseconde).
3. Succès : remplacer l'état local par la réponse (nouveaux jetons).
4. `CSDJBO1_STALE_CONFIGURATION` : **relire**, montrer la version du
   serveur, laisser le commerçant rejouer sa modification. Ne jamais
   rejouer automatiquement.

Pourquoi **deux** jetons : les actions historiques `replace_*` ne font pas
bouger `updated_at`. `updatedAt` seul laisserait passer l'écrasement d'une
modification faite par un chemin historique ; `revision` (empreinte du contenu) la
détecte. Sans `expectedRevision`, **seul `updatedAt` est comparé** (limite
connue, §9).

Motifs (`DETAIL`, `reason=`) : `expectedUpdatedAt_required` (la portée existe
et aucun jeton n'est fourni — dont la **double création**), `updated_at_changed`,
`revision_changed`, `scope_missing` (jeton fourni pour une portée disparue).

Le **double clic** est sûr : la seconde soumission, portant l'ancien jeton,
est refusée sans rien écrire (prouvé, y compris en deux sessions simultanées).

## 6. Activation : validée, pas déclarée

`enabled: true` est refusé — dans la même transaction, avant toute écriture —
par `CSDJBO1_INCOMPLETE_CONFIGURATION` si la configuration résultante ne peut
pas proposer de date. Le `DETAIL` porte `blockers=` et la liste (dans cet
ordre), exactement les cinq conditions de `publishBlockersOf` :

| Bloqueur | Condition |
|---|---|
| `offer_missing` | date choisie ou dérivée, et aucun créneau (créneaux nommés) / aucune fenêtre (autres) |
| `granularity_missing` | politique « heure libre » sans pas de grille |
| `preparation_missing` | méthode v1.2 sans aucun jour de préparation |
| `capacity_incomplete` | capacité activée sans maximum ≥ 1 |
| `capacity_needs_date` | capacité activée en politique purement informative |

Un **brouillon** (`enabled: false`) peut être incomplet, jamais incohérent :
une capacité activée sans maximum, ou sur date informative, est refusée même
en brouillon (la table ne peut pas la stocker), de même que « heure libre » sans pas.

## 7. Catalogue des refus

Le message du serveur commence par `CODE: …`. **L'interface ne montre jamais ce
texte** : elle extrait `CODE` (jusqu'au premier `:`) et affiche sa propre phrase.
PostgREST rend `{code: <SQLSTATE>, message, details, hint}` ; le statut HTTP
est indicatif, **c'est `CODE` qui fait foi**.

| `CODE` | SQLSTATE | Quand |
|---|---|---|
| `CSDJ1_AUTH_REQUIRED` | 28000 | pas de session |
| `CSDJ1_FORBIDDEN` | 42501 | ni owner ni manager (écriture) / ni membre ni opérateur (lecture) ; établissement inexistant : **même** refus |
| `CSDJ12_ISOLATION_REQUIRED` | 55000 | transaction englobante hors READ COMMITTED |
| `CSDJ1_INVALID_PAYLOAD` | 22023 | forme : non-objet, clé inconnue ou absente, type, borne, doublon, trop d'éléments |
| `CSDJ1_UNKNOWN_MODE` | 22023 | mode hors catalogue |
| `CSDJ1_RESERVED_RULE_ID` | 22023 | zéro UUID |
| `CSDJ1_FOREIGN_RULE` | 42501 | règle d'un autre établissement/mode, ou inexistante |
| `CSDJ1_INVALID_TIMEZONE` | 22023 | fuseau inconnu |
| `CSDJ1_INVALID_POLICY` | 22023 | mode de date/créneau hors catalogue ou incohérent |
| `CSDJ1_SUBMINUTE_TIME` | 22023 | secondes dans une heure |
| `CSDJ1_WINDOW_OVERLAP` | 23514 | fenêtres du même jour superposées |
| `CSDJ12_INVALID_WEEKDAY` | 22023 | jour hors 0–6 |
| `CSDJ12_TOO_MANY_CLOSURES` | 22023 | plus de 731 fermetures |
| `CSDJ12_UNKNOWN_CALENDAR` | 22023 | calendrier férié inconnu |
| `CSDJ12_INVALID_HOLIDAY_POLICY` | 22023 | ni `open` ni `closed` |
| `CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR` | 22023 | `closed` sans calendrier |
| `CSDJ12_INVALID_CAPACITY` | 22023 | maximum hors 1–1 000 000, ou capacité activée sans maximum (brouillon) |
| `CSDJ12_CAPACITY_NEEDS_DATE` | 22023 | capacité sur date informative (brouillon) |
| `CSDJBO1_METHOD_MISMATCH` | 22023 | sections d'une autre méthode (`sections=…` / `field=…`) |
| `CSDJBO1_INCOMPLETE_CONFIGURATION` | 23514 | activation impossible (`blockers=…`), ou « heure libre » sans pas en brouillon (`blockers=granularity_missing`) |
| `CSDJBO1_STALE_CONFIGURATION` | 23505 | édition concurrente / jeton absent / portée disparue (`reason=…`) |
| `SCANYM_CSDJBO1_POSTCHECK` | XX000 | défaut interne (relecture introuvable) : à traiter comme panne |

La lecture ajoute : `CSDJ1_AUTH_REQUIRED`, `CSDJ1_FORBIDDEN`,
`CSDJ1_UNKNOWN_MODE`, `CSDJ1_RESERVED_RULE_ID`, `CSDJ1_FOREIGN_RULE`.

Le SQLSTATE de la concurrence est 23505 (HTTP 409 chez PostgREST) et non
40001 : PostgREST rend 500 pour 40001.

## 8. Règles propres à chaque commerçant

* Une **portée** = (établissement, mode, règle de livraison). Chaque
  commerçant a **ses** règles et **ses** configurations : rien n'est un défaut
  global. **Ce lot n'insère aucune ligne** (post-vol : contenu des neuf
  tables de configuration inchangé).
* Un nouveau mode ou une nouvelle option de livraison « manuelle » **réutilise
  les modèles de données existants** (`restaurant_sale_mode_fulfillments` : une
  règle, avec son `provider` : `internal`, `stuart`, `chronofresh`,
  `other_external`) ; sa planification est une portée de plus, indépendante des
  autres. **Aucune API de transporteur n'est intégrée** (Stuart et Chronofresh
  restent des portées indépendantes, sans lien technique).
* Les règles d'Au Lait Cru (ALC) vivent dans **ses** lignes uniquement. L'exemple
  ci-dessous est une **fixture de test et de documentation** : aucun script
  du lot ne l'applique, nulle part.

## 9. Limites connues — à trancher par le CTO

1. **Les mutateurs historiques restent appelables** (`mutate_merchant_fulfillment_schedule`,
   `_v12`) par `authenticated`. Ils peuvent encore activer une portée
   incomplète (prouvé par le harnais, §10, comme **résidu connu**) et leurs
   actions `replace_*` ne font pas bouger `updated_at`. Les fermer exigerait de
   modifier ou révoquer des fonctions existantes (hors mandat). Mitigation
   livrée : la révision de contenu ; l'interface **n'appelle que** la nouvelle
   fonction. Décision requise : révoquer/encadrer les mutateurs après la mise en
   service de l'interface.
2. **Suppression** : cette fonction n'en offre pas (« désactiver » = brouillon,
   `enabled: false`, configuration conservée). Supprimer une portée reste
   `mutate_merchant_fulfillment_schedule('delete_schedule')`, qui prend le
   **même** verrou. Décision requise : l'ajouter à la nouvelle fonction (une
   quatrième fonction) ou conserver l'action historique.
3. **Pas de transaction multi-portées** : une écriture = une portée. Enregistrer
   plusieurs portées = plusieurs appels, chacun atomique.
4. **Analyse statique du retour arrière** : le retour refuse si une routine, un
   objet ou une tâche `pg_cron` cite les fonctions ; il ne voit ni SQL dynamique à
   nom recomposé, ni clients externes. **Retirer l'interface avant** le retour
   (`CSDJ_BO1_WRITE_CONTRACT.available = false`).
5. Aucun calendrier férié n'est peuplé (décision du jeu de données ouverte).
6. `get_fulfillment_configuration` est `STABLE` : les appels REST la rendent
   en lecture seule ; elle ne verrouille pas (le jeton protège l'écriture).

## 10. Exemple — retrait, 2 créneaux, mardi–samedi, heure limite 16 h la veille

Fixture **non globale**, appliquée par le harnais sur UN établissement de test.
Lecture : « retrait possible du mardi au samedi, créneau midi 11–14 h et soir
16–20 h ; commander au plus tard la **veille à 16 h** ; préparation du lundi au
vendredi ». `minLeadDays: 1` + `cutoffTime: "16:00"` + `cutoffOffsetDays: 0`
(méthode v1.2). Preuve : le lundi à 15:59 (heure de Paris) le premier retrait
est le mardi ; à 16:00 c'est le mercredi.

<!-- example:alc-pickup:begin -->
```json
{
  "modeCode": "pickup",
  "fulfillmentRuleId": null,
  "method": "v1.2",
  "enabled": true,
  "policy": {
    "timezone": "Europe/Paris",
    "dateSelectionMode": "customer_selectable",
    "slotSelectionMode": "fixed_slots",
    "timeGranularityMinutes": null,
    "leadTimeMinutes": 0,
    "minLeadDays": 1,
    "cutoffTime": "16:00",
    "cutoffOffsetDays": 0,
    "bookingHorizonDays": 14
  },
  "windows": [],
  "slots": [
    {
      "weekday": 2,
      "slotKey": "midi",
      "startsAt": "11:00",
      "endsAt": "14:00",
      "displayOrder": 0
    },
    {
      "weekday": 2,
      "slotKey": "soir",
      "startsAt": "16:00",
      "endsAt": "20:00",
      "displayOrder": 1
    },
    {
      "weekday": 3,
      "slotKey": "midi",
      "startsAt": "11:00",
      "endsAt": "14:00",
      "displayOrder": 0
    },
    {
      "weekday": 3,
      "slotKey": "soir",
      "startsAt": "16:00",
      "endsAt": "20:00",
      "displayOrder": 1
    },
    {
      "weekday": 4,
      "slotKey": "midi",
      "startsAt": "11:00",
      "endsAt": "14:00",
      "displayOrder": 0
    },
    {
      "weekday": 4,
      "slotKey": "soir",
      "startsAt": "16:00",
      "endsAt": "20:00",
      "displayOrder": 1
    },
    {
      "weekday": 5,
      "slotKey": "midi",
      "startsAt": "11:00",
      "endsAt": "14:00",
      "displayOrder": 0
    },
    {
      "weekday": 5,
      "slotKey": "soir",
      "startsAt": "16:00",
      "endsAt": "20:00",
      "displayOrder": 1
    },
    {
      "weekday": 6,
      "slotKey": "midi",
      "startsAt": "11:00",
      "endsAt": "14:00",
      "displayOrder": 0
    },
    {
      "weekday": 6,
      "slotKey": "soir",
      "startsAt": "16:00",
      "endsAt": "20:00",
      "displayOrder": 1
    }
  ],
  "closures": [],
  "preparation": {
    "weekdays": [
      1,
      2,
      3,
      4,
      5
    ],
    "closures": []
  },
  "holidays": {
    "calendarId": null,
    "preparationOnHolidays": "open",
    "availabilityOnHolidays": "open"
  },
  "capacity": {
    "enabled": false,
    "maxOrders": null
  }
}
```
<!-- example:alc-pickup:end -->

## 11. Preuves

Harnais : `supabase/tests/csdj-bo1-save-configuration-check.sh` (cluster
PostgreSQL 16 jetable, utilisateur système non privilégié). Moteur CSDJ v1.2
chargé depuis un arbre désigné par `SCANYM_V12_SOURCE_DIR` et **refusé** si son
identité git n'est pas épinglée. Il couvre : pré-vol et atomicité de la
migration, périmètre exact (3 fonctions ajoutées, rien d'autre), posture de
sécurité, matrice d'autorisation, chemins nominaux, ~190 cas de validation +
fuzz déterministe (aucune erreur brute), complétude, remplacement intégral,
concurrence à deux sessions réelles (attentes observées dans `pg_locks`), pannes
injectées, processus tué en transaction, cohérence des lecteurs, absence de
contournement, isolation entre commerçants, non-régression jumelle CSDJ-1 /
v1.2 / CSDJ-3, mutations de chaque garde, retour arrière aller-retour-aller, et
exemple de ce document.

Les valeurs exactes (SHA, journaux, empreintes) sont dans le dossier de preuves
joint au rapport de livraison de l'issue #148.

## 12. Ordre d'application (après audit et GO — jamais avant)

1. Pré-requis : CSDJ-1, CSDJ v1.2 et CSDJ-3 déjà appliqués (ils le sont sur
   l'hébergé). **Ce lot ne les réapplique pas.**
2. Appliquer `DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1.sql`
   (une transaction ; pré-vol et post-vol intégrés ; non ré-exécutable).
3. Brancher l'interface (issue #149), puis seulement alors basculer
   `CSDJ_BO1_WRITE_CONTRACT.available`.
4. Retour : retirer l'interface, puis
   `DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1-rollback.sql`. Les
   données écrites restent, lisibles et modifiables par les mutateurs historiques.
