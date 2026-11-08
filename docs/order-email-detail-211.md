# E-mail de confirmation complet (issue #211)

L'e-mail « commande reçue » doit suffire à retrouver sa commande et son rendez-vous : articles, options, quantités,
montants, mode de remise, jour et créneau réellement retenus, lien de suivi réutilisable **et** action distincte de
rétractation lorsque l'éligibilité le permet.

## Ce qui change

| Couche | Fichier | Changement |
| --- | --- | --- |
| SQL (brouillon, jamais appliqué) | `supabase/DRAFT-lot-order-email-detail-v1.sql` | `create_order_received_notification(uuid, uuid)` : le `payload_snapshot` gagne des clés **additives** (`order_email_detail_v1`, `items`, `subtotal`, `delivery_fee`, `schedule`, `fulfillment_date`, `fulfillment_slot`). Le CHECK de `notification_outbox.locale` accepte `nl`. |
| SQL (retour arrière) | `supabase/DRAFT-lot-order-email-detail-v1-rollback.sql` | Restaure l'état d'avant, octet pour octet ; refuse toute dérive et toute ligne `nl`. |
| Lecture du snapshot | `lib/server/notifications/order-received-detail.ts` | Lecteur défensif pur (aucune base, aucun réseau, aucune horloge). |
| Gabarit | `lib/server/notifications/order-received-template.ts` | HTML **et** texte, échappement HTML, FR/EN/AR/NL, RTL (arabe), action de rétractation distincte du lien de suivi. |
| Worker | `lib/server/notifications/notification-worker.ts` | Passe le détail au gabarit ; variables marchandes `{fulfillment_date}` / `{fulfillment_slot}` alimentées par les valeurs persistées. |
| i18n | `lib/i18n.ts` | Libellés fr/en/ar, jeu complet nl. |

## Source des données et ordre de persistance

Le contenu vient **uniquement** du snapshot figé à l'enfilement ; le worker ne lit ni le catalogue courant ni les tables de
commande. Un produit renommé, repricé ou supprimé après la commande ne change donc rien.

`create_order` écrit `orders` → `order_items` → … → `order_fulfillment_schedule_snapshot` dans **une seule transaction** et
n'enfile rien. L'enfilement est fait par le déclencheur de contrainte **différé** de #205 (`DEFERRABLE INITIALLY
DEFERRED`), appelé à la fin de la transaction : lignes et planning sont déjà écrits. La reprise #205 relit les mêmes
tables déjà commitées. Les deux chemins appellent la même fonction, donc le même snapshot.

## Affichage du jour et du créneau

* Jour : date civile persistée (`scheduled_date`), jamais convertie par un fuseau local ; fuseau affiché avec l'heure.
* Heure : `selected_time` s'il existe, sinon la fenêtre `début–fin`, sinon rien. **Aucune heure n'est inventée** : un jour
  seul (Chronofresh) s'affiche sans créneau.
* Mode table, ou planning informatif sans date : aucune ligne de jour/créneau.
* La clé interne de créneau (`slot_key`) n'est jamais recopiée ni lue.
* Sur un snapshot au format #211 (marqueur `order_email_detail_v1` ou clé `schedule`, même `null`), `schedule` est la
  **seule** autorité de jour/créneau. Un planning rejeté (date impossible comme le 30 février, mode contradictoire, forme
  inconnue) n'est ni affiché, ni réinterprété (le 30 février ne devient jamais le 2 mars), ni relu via les clés « à plat »
  `fulfillment_date` / `fulfillment_slot`, et les variables marchandes correspondantes sont vides. Le repli antérieur (#172)
  ne s'applique qu'aux lignes antérieures au lot ; il rejette lui aussi une date civile impossible.
* Base non UTF-8 : la fonction SQL utilise un tiret ASCII au lieu du tiret demi-cadratin, afin de ne **jamais** lever
  d'erreur d'encodage dans le déclencheur différé (une exception y annulerait la création de la commande).

## Rétractation

* Éligibilité = au moins une ligne dont `withdrawal_eligible_at_order_time` est vrai (même autorité que la page de suivi) ;
  clé `withdrawal_eligible` du snapshot, inchangée.
* Si éligible : le lien de suivi réutilisable reste, et une action distincte « Demander une rétractation » pointe vers la
  même cible serveur, accompagnée d'une note de portée : le lien ne vaut ni acceptation ni promesse de remboursement.
* Si non éligible : aucune action de rétractation.
* Le lien ne donne aucun droit à lui seul ; la page de suivi et le service de rétractation restent l'autorité (produits
  concernés, quantités restantes, délais).

## Compatibilité

* Ancien code + nouveau snapshot : les clés ajoutées sont ignorées, rendu antérieur inchangé.
* Nouveau code + ancien snapshot : e-mail **sans** récapitulatif, jamais de valeur devinée ; l'envoi n'échoue pas.
* Les lignes déjà en file ne sont ni réécrites, ni renvoyées, ni rouvertes.

## Ordre de mise en service (aucune étape n'est exécutée par la PR)

1. SQL : `DRAFT-lot-order-email-detail-v1.sql` (pré-vol intégré ; refuse toute dérive du prédécesseur et du schéma).
   Le CHECK de locale est comparé **exactement** (squelette de la définition ET littéraux, octet pour octet) : une valeur
   qui ne diffère que par une espace (`'f r'`, `' fr'`, `'fr '`), une valeur en plus, en moins ou dans un autre ordre est refusée.
   Seules les espaces de structure entre éléments sont ignorées. Même règle dans le rollback et dans les post-contrôles.
2. Code applicatif de la PR.

L'ordre inverse est sans danger (le code traite l'absence de clés comme « pas de récapitulatif ») mais enverrait des
e-mails sans détail jusqu'à l'application du SQL. Le lot est à appliquer cron arrêté (verrou exclusif 10 s maximum).

## Retour arrière

`DRAFT-lot-order-email-detail-v1-rollback.sql` restaure la fonction, son commentaire, ses droits et le CHECK d'avant. Il
refuse, avant toute écriture : corps ou attributs modifiés, propriétaire ou droits différents, commentaire modifié, CHECK
de locale différent de `('fr','en','ar','nl')`, et toute ligne de file en `nl` (les ramener à `fr` réécrirait des
instantanés figés). Il ne supprime aucun snapshot ni aucune décision et ne rouvre aucune file.

## Limites connues et points à traiter à part

* **Page de suivi** : l'explication des cas inéligible/expiré sur la page elle-même n'est pas modifiée ici
  (`app/track/[orderId]/page.tsx` est en conflit avec la PR #163 encore ouverte).
* `?lang=` est perdu par `history.replaceState` après l'échange de capacité sur la page de suivi (connu, non corrigé).
* `create_order_communication_notification` (événements additionnels) continue de rattacher `nl` à `fr` : inchangé.
* Prix côté client en `nl` : formatage `formatPrice` (fr-FR) inchangé, autorité partagée.
* Les textes marchands hébergés ne sont pas auditables depuis le dépôt : un test de garde vérifie seulement qu'aucun texte
  plateforme n'annonce « un e-mail va vous être envoyé ». Les textes marchands éventuellement circulaires sont à corriger
  par les commerçants, sans modification en Production par cette PR.

## Preuves

* `tests/order-email-detail.test.ts` — lecteur, gabarit (HTML/texte, échappement, FR/EN/AR/NL, RTL, rétractation), worker de
  bout en bout avec fournisseur intercepté, valeurs historiques, isolation entre commerces, rejeu sans double envoi.
* `tests/order-email-detail-pg.test.ts` — PostgreSQL réel (bases jetables, opt-in `SCANYM_TEST_PG_ADMIN_URL`) : ordre de
  persistance via le vrai déclencheur différé de #205, reprise #205, snapshot (retrait, livraison, jour seul, table),
  valeurs historiques, isolation, idempotence, `nl`, compatibilité ascendante, refus du pré-vol (ON_ERROR_STOP=1 et 0),
  rollback nominal et refus, base non UTF-8, et snapshot PostgreSQL réel → vrai worker → fournisseur intercepté.
