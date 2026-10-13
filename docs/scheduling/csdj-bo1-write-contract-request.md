# CSDJ-BO-1 — DEMANDE DE CONTRAT D'ÉCRITURE TRANSACTIONNEL

**Demandeur** : CSDJ-BO-1 (interface marchande « Mise à disposition »).
**Destinataire** : Boulez, propriétaire de CSDJ v1.2 (PR #146).
**Décision à l'origine** : revue CTO de la phase d'implémentation —
*« Do not implement the multi-RPC suspend/edit/reactivate sequence as a
production-ready save guarantee. The CTO requests a transactionally safe
full-configuration write contract, or an independently justified
equivalent that prevents incomplete configuration and checkout
bypass. »*

**Statut de ce document** : DEMANDE. Il ne modifie rien, n'applique rien
et **ne touche pas la PR #146**. Aucun SQL n'est écrit par CSDJ-BO-1 :
le lot d'écriture, s'il est approuvé, appartient au propriétaire du
moteur.

**Base de référence** : `main` après PR #145 (`03441a5`), socle CSDJ-1
v1.10 appliqué en PROD ; PR #146 (`feature/csdj-v1.2-scheduling-engine`,
tête `afbee37`) **ouverte, non fusionnée, non appliquée** — lue, jamais
modifiée.

---

## 1. Ce qui existe aujourd'hui, et pourquoi cela ne suffit pas

Enregistrer **une** portée complète demande aujourd'hui jusqu'à **six**
appels, chacun dans sa propre transaction :

| # | Appel | Action | Lot |
|---|---|---|---|
| 1 | `mutate_merchant_fulfillment_schedule` | `save_schedule` | v1, appliqué |
| 2 | `mutate_merchant_fulfillment_schedule` | `replace_windows` | v1, appliqué |
| 3 | `mutate_merchant_fulfillment_schedule` | `replace_slots` | v1, appliqué |
| 4 | `mutate_merchant_fulfillment_schedule` | `replace_closures` | v1, appliqué |
| 5 | `mutate_merchant_fulfillment_schedule_v12` | `save_schedule_v12` | v1.2, livré non appliqué |
| 6 | `mutate_merchant_fulfillment_schedule_v12` | `replace_prep_days`, `replace_prep_closures` | v1.2, livré non appliqué |

Chaque appel est **intégralement** appliqué ou pas du tout — ce point
n'est pas contesté, il est même soigneusement construit (vider puis
réinsérer dans une transaction, non-superposition vérifiée dans la même
transaction). Ce qui n'existe pas, c'est une transaction **entre** deux
appels. PostgREST n'en offre aucune : deux `rpc()` sont deux
transactions, et aucun paramètre ne les regroupe.

### 1.1 Pourquoi la séquence « suspendre → écrire → réactiver » ne vaut pas garantie

La conception R2 proposait de faire de l'activation le commit :
désactiver la portée, écrire les listes, réactiver en dernier. Elle
réduit réellement le risque, et c'est pourquoi elle avait été proposée.
Elle ne le **supprime** pas, et le CTO a raison de refuser qu'elle soit
présentée comme une garantie :

1. **Elle n'est pas atomique non plus.** La désactivation est elle-même
   un appel. Entre elle et la réactivation, il reste un état
   intermédiaire réel en base. Il est *inoffensif pour le client*
   (portée désactivée ⇒ parcours d'avant, état prévu par
   `CSDJ-V1-SCHEDULE-ABSENT-01`), mais il est *visible pour le
   commerçant* et il **survit** à une perte de session : le commerçant
   retrouve sa portée en pause sans l'avoir voulu, et c'est l'interface,
   non le serveur, qui est censée l'en sortir.
2. **Elle fait reposer une propriété serveur sur un client.** Fermer la
   fenêtre, perdre le réseau, voir le jeton expirer, ou simplement tuer
   l'onglet entre deux appels suffit à interrompre la séquence. Une
   garantie qui dépend du navigateur n'est pas une garantie.
3. **Elle est contournable par construction.** Rien n'empêche un autre
   client — un script, une autre version de l'interface, un appel
   manuel — d'appeler les actions dans un autre ordre, ou d'activer une
   portée dont les listes n'ont pas été écrites. Le verrou consultatif
   par établissement (graine 1104) **sérialise** deux éditeurs, il ne
   leur impose aucun ordre.
4. **Elle ne couvre pas le cas qui compte vraiment** : la modification
   d'une portée **déjà active** par un commerçant qui refuse la mise en
   pause (pour ne pas fermer sa boutique dix secondes). La séquence
   dégénère alors en « écrire les listes en direct », c'est-à-dire
   exactement le risque que l'on voulait éliminer.

### 1.2 Les trois fenêtres de défaillance, nommées

Ce sont les trois seules qu'un contrat d'écriture doit fermer. Elles
sont décrites ici pour qu'une solution puisse être **jugée**, pas pour
dramatiser.

**(A) Offre servie depuis une configuration que personne n'a approuvée
en entier** — la seule qui soit *fail-open*, et donc la seule vraiment
grave. Portée active, politique « créneaux nommés », le commerçant
remplace ses créneaux et ses fermetures. Entre l'appel 3 et l'appel 4,
le parcours de commande lit des créneaux **nouveaux** avec des
fermetures **anciennes**. Un client peut réserver une date que le
commerçant venait de fermer. Rien ne le signale, personne ne le sait, et
la commande est valide.

**(B) Indisponibilité silencieuse après un changement de politique** —
*fail-closed*, donc sans surréservation, mais visible du client. L'appel
1 pose `slot_selection_mode = 'fixed_slots'` ; l'autorité devient la
table des créneaux, qui est encore vide jusqu'à l'appel 3. Entre les
deux, le serveur rend honnêtement `no_offer_configured` : la boutique
n'offre plus aucune date. Même scénario pour la bascule v1 → v1.2
(appel 5 pose la méthode ; sans l'appel 6, le serveur rend
`preparation_calendar_missing`).

**(C) Écrasement d'une édition concurrente** — deux responsables
éditent le même établissement. Le verrou 1104 garantit qu'ils ne
s'entrelacent pas, pas que le second **voie** le travail du premier :
chaque action porte l'état voulu en entier, donc la dernière séquence
écrase la précédente, sans que personne ne soit averti.

---

## 2. Ce qui est demandé

### 2.1 Option A — PRÉFÉRÉE : une écriture, une transaction, une portée entière

```
public.save_fulfillment_configuration(
  p_restaurant_id uuid,
  p_payload       jsonb
) returns jsonb
```

Une seule fonction, `security definer`, `volatile`, `set search_path =
''`, accordée à `authenticated` uniquement, contrôle de rôle **dans le
corps** (`has_role_in(p_restaurant_id, array['owner','manager'])`),
verrou consultatif de tenant **déjà existant** (graine 1104, pour se
sérialiser avec les deux mutateurs actuels plutôt que de créer une
deuxième file).

**Charge** — l'état VOULU de la portée, en entier, jamais un delta :

```jsonc
{
  "modeCode": "pickup",
  "fulfillmentRuleId": null,            // null = portée de mode
  "expectedUpdatedAt": "2026-10-13T09:41:12.310Z",  // voir §2.3
  "method": "v1.2",                     // "v1" | "v1.2"
  "enabled": true,                      // l'activation est DANS la transaction
  "policy": {
    "timezone": "Europe/Paris",
    "dateSelectionMode": "customer_selectable",
    "slotSelectionMode": "fixed_slots",
    "timeGranularityMinutes": null,
    "leadTimeMinutes": 0,
    "minLeadDays": 2,
    "cutoffTime": "12:00",
    "cutoffOffsetDays": 0,              // refusé si <> 0 en v1.2 (contrainte existante)
    "bookingHorizonDays": 14
  },
  "windows":  [ { "weekday": 2, "startsAt": "11:00", "endsAt": "14:00", "displayOrder": 0 } ],
  "slots":    [ { "weekday": 2, "slotKey": "matin", "startsAt": "09:00", "endsAt": "12:00", "displayOrder": 0 } ],
  "closures": [ { "closedOn": "2026-12-25", "label": "Noël" } ],
  "preparation": {                      // ignoré (et refusé si présent) en méthode v1
    "weekdays": [1, 2, 3, 4, 5],
    "closures": [ { "closedOn": "2026-10-14", "label": "Entretien four" } ]
  },
  "holidays": {
    "calendarId": null,
    "preparationOnHolidays": "open",
    "availabilityOnHolidays": "open"
  },
  "capacity": { "enabled": false, "maxOrders": null }
}
```

**Propriétés exigées** (ce sont les critères d'acceptation, §4) :

1. **Une transaction.** Politique, listes, calendrier de préparation,
   fériés, capacité et activation sont écrits ensemble ou pas du tout.
   Aucun état intermédiaire n'est jamais lisible par le parcours de
   commande.
2. **L'activation est validée, pas déclarée.** `"enabled": true` est
   **refusé** — dans la même transaction, avec un nom — si la
   configuration résultante ne peut pas proposer de date. Les cinq
   conditions sont déjà implémentées côté interface à titre explicatif
   (`publishBlockersOf`, `lib/availability-editor.ts`) et doivent
   devenir des **refus serveur** :
   - aucune plage ni aucun créneau dans la table qui fait autorité pour
     la politique choisie (hors politique purement informative) ;
   - politique « heure libre » sans pas de grille ;
   - méthode v1.2 sans aucun jour de préparation ;
   - capacité active sans maximum strictement positif ;
   - capacité active en politique purement informative.
   C'est ce point qui ferme la fenêtre (A) **et** la fenêtre (B) : une
   portée ne peut plus devenir active, ni rester active, sur une
   configuration incomplète.
3. **Remplacement intégral, jamais de delta.** Chaque liste absente de
   la charge est traitée comme **vide** et non comme « inchangée », ou
   bien sa clé est obligatoire — à trancher par le propriétaire du
   moteur, mais l'ambiguïté doit être levée dans le contrat, pas dans
   l'appelant.
4. **Aucun compte ne sort.** La réponse ne contient ni remplissage, ni
   places restantes, ni compteur de capacité — la règle
   « le client ne voit jamais les places restantes » vaut aussi pour le
   back-office, et le compteur n'est accordé à aucun rôle applicatif.
5. **La réponse est la configuration relue**, telle qu'elle vient d'être
   écrite, dans la même transaction. L'interface n'a donc pas besoin
   d'une seconde lecture qui pourrait déjà être périmée.

### 2.2 Catalogue de refus demandé

Nommés, stables, et traduisibles — même convention que les douze refus
de `mutate_merchant_fulfillment_schedule` et les vingt de sa variante
v1.2. Les refus existants doivent être **réutilisés tels quels** quand
ils s'appliquent (session, rôle, mode hors catalogue, règle étrangère,
UUID sentinelle, fuseau inconnu, politique hors catalogue, secondes,
chevauchement de plages, décalage d'heure limite en v1.2, politique
fériée sans calendrier, capacité invalide, capacité sans date, jour de
semaine invalide, trop de fermetures). Trois refus **nouveaux** sont
nécessaires :

| Refus demandé | Quand | Pourquoi il n'existe pas déjà |
|---|---|---|
| `CSDJBO1_INCOMPLETE_CONFIGURATION` | `enabled` vrai alors qu'une des cinq conditions de §2.1-2 manque, avec le détail de la condition | aujourd'hui, l'activation n'est jamais confrontée au contenu des listes |
| `CSDJBO1_STALE_CONFIGURATION` | `expectedUpdatedAt` ne correspond plus à la ligne en base | aucune détection d'édition concurrente n'existe (fenêtre C) |
| `CSDJBO1_METHOD_MISMATCH` | charge v1 portant une section `preparation`/`capacity`, ou charge v1.2 portant un décalage d'heure limite non nul | aujourd'hui, le mélange se solde par une violation de contrainte brute, non par un refus nommé |

### 2.3 Concurrence — fermer la fenêtre (C)

`expectedUpdatedAt` reprend l'horodatage `updated_at` de la portée tel
que la lecture marchande l'a rendu. S'il ne correspond plus, la fonction
**refuse** avec `CSDJBO1_STALE_CONFIGURATION` au lieu d'écraser : le
commerçant est averti qu'un collègue a modifié la portée, recharge, et
rejoue sa modification en connaissance de cause. Pour une **création**,
la clé est absente.

Cela demande que `updated_at` soit exposé par la lecture marchande, ce
qui n'est pas le cas aujourd'hui (`get_merchant_fulfillment_schedules`
rend 15 colonnes, sans `updated_at`). **C'est la seule modification
demandée à une lecture existante**, et elle est additive. Si le
propriétaire du moteur préfère ne pas y toucher, un compteur de version
dédié rendu par la nouvelle fonction convient aussi bien ; l'important
est qu'une détection existe.

---

## 3. Équivalents envisagés, et pourquoi ils sont plus faibles

**Option B — brouillon serveur puis promotion atomique.** Les listes
sont écrites dans des tables de brouillon par les actions existantes,
puis une fonction `promote_fulfillment_configuration` les bascule en une
transaction. *Avantage* : les actions actuelles ne changent pas.
*Inconvénients* : double jeu de tables à maintenir et à sécuriser (RLS,
grants, cascades), une surface d'attaque et de dérive bien plus large
qu'une fonction, et la fenêtre (A) n'est fermée que si la promotion
valide aussi la complétude — soit tout le travail de l'option A, en
plus du reste. Non recommandée.

**Option C — rendre le résolveur fail-closed sur l'incomplétude.** Le
résolveur refuse de proposer des dates quand la configuration est
incomplète. *C'est déjà largement le cas* (`no_offer_configured`,
`granularity_missing`, `preparation_calendar_missing`) et c'est une
bonne propriété, mais elle ne ferme **pas** la fenêtre (A) : une liste
de créneaux nouvelle avec des fermetures anciennes est une
configuration *complète* et *cohérente* — simplement pas celle que le
commerçant a approuvée. Nécessaire, insuffisant.

**Option D — garder la séquence et l'annoncer honnêtement.** Écrire dans
l'interface « vos modifications s'appliquent une par une ». Rejetée par
le CTO, et à raison : une garantie de production ne se remplace pas par
un avertissement.

---

## 4. Critères d'acceptation côté CSDJ-BO-1

L'interface activera ses contrôles d'écriture quand, et seulement quand,
les six points suivants seront vrais — ils sont vérifiables, et les
tests correspondants sont déjà nommés dans ce lot (voir
`tests/csdj-bo1-availability-contract.test.ts`) :

1. Une portée complète s'enregistre en **un** appel.
2. Une interruption réseau à n'importe quel instant laisse la base dans
   l'état **avant** l'appel, jamais entre deux.
3. `enabled: true` sur une configuration incomplète est **refusé** avec
   un nom, pas accepté puis rendu invisible.
4. Une édition concurrente est **refusée** avec un nom, pas écrasée.
5. La réponse ne contient aucun compte de capacité.
6. Les refus sont nommés et stables, pour qu'une phrase lisible puisse
   être affichée au commerçant sans jamais montrer un message serveur
   brut, un SQLSTATE, un nom de table ou un identifiant d'établissement.

Tant que ces points ne sont pas tenus, l'état du lot est inchangé :
`CSDJ_BO1_WRITE_CONTRACT.available === false`
(`lib/availability-editor.ts`), **aucun site d'appel d'écriture
n'existe** dans le code — pas seulement des contrôles grisés — et la
page reste pleinement utilisable en lecture, aperçu serveur compris.

## 5. Ce que CSDJ-BO-1 ne demande PAS

- Aucune modification de la PR #146, de ses migrations, de son contrat
  de réservation ou de ses tests.
- Aucun accès au compteur de capacité, à `resolve_fulfillment_schedule`
  ou à `reserve_fulfillment_capacity`.
- Aucune dérogation opérateur sur l'écriture : l'autorité d'écriture
  reste propriétaire ou responsable de l'établissement, et l'interface
  le reflète déjà (`canWriteFulfillmentSchedules`).
- Aucun calendrier férié peuplé : la décision du jeu de données reste
  ouverte, et l'interface l'affiche comme telle.
