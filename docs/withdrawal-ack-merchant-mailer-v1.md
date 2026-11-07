# Accusé de rétractation par la messagerie du commerçant (v1) — DRAFT

Statut : **Draft**. Rien n'est appliqué en base hébergée, rien n'est déployé, aucun e-mail réel n'a été envoyé.
Le comportement par défaut après déploiement est **identique à celui d'avant** : l'interrupteur opérateur est fermé.

## 1. Constat (étude avant code)

| Sujet | Existant |
|---|---|
| Canal de l'accusé | `lib/server/ack-mailer.ts` : SMTP **unique de la plateforme** (`SMTP_HOST/PORT/USER/PASSWORD/FROM`), expéditeur forcé `retractation@scanym.com`. |
| Statut à la création | `submit_withdrawal_request_by_capability` écrit `pending` si `_scanym_has_operational_durable_ack_channel()` (santé **globale** du canal plateforme) est vrai, sinon `unavailable_no_channel`. |
| Conséquence | Canal plateforme indisponible ⇒ **toute** demande naît `unavailable_no_channel` et n'est jamais revendicable : un changement TypeScript seul ne peut pas fonctionner. |
| Messagerie du commerçant | Onglet E-mails : coffre `merchant_email_provider_config` (SMTP 465, secret AES-256-GCM lié à `restaurant_id`) + `merchant_notification_profile` (nom, adresse d'expéditeur, reply-to). `resolveMerchantSmtpProvider(restaurantId)` la résout. |
| Contact du commerçant | `merchant_legal_profile.customer_service_email` (déjà montré au client dans les CGV). Sous `STANDARD_14_DAYS` / `MIXED`, son absence est un échec explicite (décision CIO, issue #11). |
| Texte CGV v7 | `DRAFT-lot-gap-01-cgv-template-v7.sql` annonce un accusé « envoyé depuis l'adresse retractation@scanym.com ». |
| `failed` | État terminal : aucun mécanisme de reprise n'existe. |
| Événement MCC `withdrawal_request_received` | E-mail opt-in de texte libre du commerçant (outbox + worker). **Sans rapport** avec l'accusé légal : non réutilisé. |

## 2. Choix retenus

**Expéditeur** : l'identité d'expéditeur du profil de notification de **l'établissement de la demande** (`sender_name`, `sender_email`, `reply_to`), envoyée par **sa** messagerie. Jamais l'adresse de la plateforme, jamais une adresse d'un autre établissement. L'adresse réellement utilisée est enregistrée (`acknowledgement_sender`) comme preuve.

**Destinataires** : un **seul message** : À = adresse saisie par le client ; Cc = `merchant_legal_profile.customer_service_email`. Un seul message évite la double émission et garantit que le client et le commerçant reçoivent exactement le même contenu.
**Contrat de la copie (corrigé après audit, P2-1)** : les **deux** adresses sont validées *avant* toute résolution de messagerie ou envoi (pas d'espace, de CR/LF, de chevrons, de guillemets, de virgule). Copie **absente** (null, vide, espaces) ⇒ échec explicite `ACK_COPY_RECIPIENT_MISSING` ; copie **invalide** ⇒ `ACK_COPY_RECIPIENT_INVALID` ; dans les deux cas **pour tout régime**, rien n'est envoyé, la cause est visible au back-office. Plus aucun accusé « envoyé » sans copie. Seule exception : contact identique à l'adresse du client (casse ignorée) → le commerçant reçoit le message en À, sans Cc dupliqué. Un Cc refusé par le serveur SMTP (RCPT) fait échouer l'envoi entier (`failed`), jamais un succès partiel.

**Au Lait Cru** : `contact@aulaitcru.com` n'est **écrit nulle part dans le code ni dans les scripts SQL** (un test le vérifie). Il se règle comme pour tout commerçant, dans son profil légal (`customer_service_email`). Vérification avant ouverture : requête 4 du diagnostic (recherche par nom, motif à adapter). Je n'ai pas lu la base hébergée (interdit) : la valeur actuelle de cette configuration reste **à constater** par le diagnostic.

**Interrupteur** : table singleton `scanym_ack_merchant_mailer_activation` (fermée par défaut, aucun droit, écriture par SQL opérateur). Fermé ou illisible (RPC absente, erreur) ⇒ canal historique **strictement inchangé**. Ouvert ⇒ messagerie du commerçant. Le choix se fait une fois par demande, avant la revendication ; **aucun repli** d'un canal sur l'autre (jamais deux identités pour un même accusé).

**Statut à la création** : un déclencheur `BEFORE INSERT` passe `unavailable_no_channel` → `pending` **seulement** si l'interrupteur est ouvert **et** si la messagerie de cet établissement est prête (coffre actif avec secret + profil d'envoi activé avec nom et adresse). `submit_withdrawal_request_by_capability` n'est **pas réécrite** (pas de dérive possible de sa définition).

**Statut fidèle** :
- l'envoi est lancé après l'enregistrement, via `after()` (Next 15.1+) : il se poursuit après la réponse (`maxDuration = 90`). Remplace un `void` non attendu, qui pouvait être coupé ;
- la réponse attend au plus 8 s le résultat : `sent` / `failed` seulement s'il est connu **et écrit en base**, sinon l'état enregistré. Jamais `sent` sans envoi confirmé ;
- **résultat non enregistré (P2-2)** : l'écriture est faite par la RPC `record_..._v2`, dont l'erreur réelle est **propagée** (plus avalée). En cas d'erreur, 3 tentatives bornées (250 ms, 750 ms) — jamais d'envoi rejoué. Si l'écriture n'est pas confirmée (erreur persistante, ou `false` = ligne plus `sending`), le résultat est rapporté `resultPersisted:false` et la réponse dit **`unconfirmed`** (« l'envoi est en cours ou n'a pas pu être confirmé… vérifiez votre boîte »), jamais `sent`. Un échec d'envoi dont l'écriture échoue est rapporté `failed` (fait observé) ;
- une exception du fournisseur devient un échec enregistré, jamais une demande laissée à `sending` sans trace ;
- le tableau de bord affiche « Copie envoyée à » **uniquement** pour `sent`, la cause pour `failed`, et pour `sending` un avertissement avec le Message-ID à chercher dans le dossier « Envoyés » ; libellés publics FR/EN/AR.

**Isolation entre commerçants** : l'établissement vient de la ligne de la demande lue en base, jamais du client ; `resolveProvider` n'est appelé qu'avec cet identifiant ; le secret du coffre est lié à l'établissement (AAD) : copié dans une autre ligne, il ne se déchiffre pas (contrôle négatif testé). Le lot ne contient aucune politique RLS ni droit pour `anon`/`authenticated`.

**Doublons et issue ambiguë (P2-2)** : claim atomique de `pending` **uniquement**. **Un `sending` n'est plus jamais repris** par le canal marchand (la v1 le reprenait après 120 s). Raison : une clé d'idempotence stable (`scanym:withdrawal-ack:<id>`, Message-ID dérivé) n'a **aucun effet sur un serveur SMTP** — rien ne déduplique un second envoi ; reprendre un `sending` après un envoi accepté dont le résultat n'a pas pu être écrit enverrait un doublon. Une demande `sent`, `failed`, `sending` ou `unavailable_no_channel` n'est jamais reprise ; un rejeu de la déclaration (`replayed`) ne relance pas l'envoi ; l'enregistrement v2 n'accepte qu'une ligne `sending` revendiquée **par ce canal** (`acknowledgement_transport = 'merchant_smtp'`).

**Garantie réelle** : *au plus un envoi par demande côté application* (pas de renvoi automatique, pas de reprise de bail) — **pas** un « exactly-once » et **pas** une garantie de remise. `sent` = le serveur SMTP du commerçant a accepté le message pour tous les destinataires (pas : lu, ni même remis). `failed` = acceptation non confirmée : dans de rares cas (réponse perdue après DATA) le message a pu partir. C'est pourquoi `failed` n'est jamais renvoyé automatiquement.

**Traitement d'un `sending` (humain, sur GO explicite)** : (1) requête 5 du diagnostic : liste, ancienneté, `message_id_recherche` ; (2) chercher ce Message-ID dans le dossier « Envoyés » de la messagerie du commerçant ; (3) *trouvé* → régulariser en `sent` (horodatage et expéditeur relevés dans le message) ; *introuvable* → régulariser en `failed` (cause `OPERATOR_CONFIRMED_NOT_SENT`) ; (4) un renvoi éventuel est une décision distincte (action manuelle, hors périmètre). Ces écritures sont du SQL hébergé : aucune n'est faite ni fournie comme script automatique ici. Contrepartie assumée : une demande dont le processus disparaît **avant** l'envoi reste aussi `sending` (jamais envoyée toute seule).

**Sécurité de l'adresse** : l'adresse du client est validée strictement (pas d'espace, de CR/LF, de chevrons, de guillemets) à la route **et** avant tout envoi — fermeture d'une injection de commandes SMTP.

## 3. Demandes déjà enregistrées sans accusé

**Aucun envoi automatique, aucun backfill.**
- Le lot ne modifie aucune ligne existante.
- Le claim v2 ne prend que `pending` : les demandes `unavailable_no_channel`, `failed` et `sending` historiques ne sont **jamais** envoyées par ce chemin (testé en PostgreSQL réel).
- `DRAFT-diagnostic-withdrawal-ack-backlog-v1-READONLY.sql` (SELECT uniquement) liste ces demandes par établissement et par état, indique si la messagerie de chaque établissement est prête, le Cc prévu, et si les CGV publiées annoncent `retractation@scanym.com`.

**Décision à prendre (CIO) avant tout envoi rétroactif**, car un accusé tardif est un acte juridique et un e-mail réel :
1. liste des demandes concernées (diagnostic) ;
2. texte et expéditeur de l'accusé tardif (le contenu garde la date et l'heure réelles de la demande) ;
3. si accord : **action manuelle, demande par demande**, validée par le commerçant (suite recommandée : une action « renvoyer l'accusé » dans le back-office, avec journal). Hors périmètre de cette PR.

## 4. Prérequis juridique : CGV v7

La clause v7 promet un accusé envoyé depuis `retractation@scanym.com` (avec contrôle post-commit). Envoyer depuis la messagerie du commerçant la contredit pour les commerçants qui l'ont publiée. **Ne pas ouvrir l'interrupteur avant revue juridique et republication.** Formulation neutre proposée (à valider, aucun SQL de CGV v8 n'est rédigé ici) :

> « Un accusé de réception de votre demande, mentionnant sa date et son heure, vous est envoyé par courrier électronique à l'adresse que vous avez indiquée, depuis l'adresse électronique du vendeur ; le vendeur en reçoit une copie. »

## 5. Mise en service (ordre) — rien de ceci n'est autorisé par cette PR

1. Revue et contre-audit de cette PR (Draft).
2. **GO explicite** : appliquer `DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql` (n'ouvre pas l'interrupteur ; vérifie en fin de lot que l'interrupteur reste fermé et que la valeur de la garde CGV est inchangée).
3. Déployer le code. Sans le lot SQL, la RPC est inconnue et le code reste sur le canal historique.
4. **GO séparé**, après : diagnostic (requêtes 2 et 4 : `copie_etat = OK` pour chaque établissement concerné), test de connexion SMTP réussi dans l'onglet E-mails, `customer_service_email` renseigné **et valide**, CGV revues et republiées (§4), décision sur la garde de publication des CGV (§7).
5. Ouvrir l'interrupteur (snippet commenté en fin de lot). Fermeture immédiate possible sans rollback.

## 6. Résultats (HEAD de la livraison, voir la PR pour le SHA)

- **Reproductions rouges sur le parent `b90b48fc`** : 9 des 13 tests de comportement de `tests/withdrawal-ack-merchant-mailer-p2.test.ts` échouent (contact invalide/absent envoyé sans copie ; écriture du résultat avalée ou fatale ; aucun état « non confirmé ») ; harnais PostgreSQL : le `sending` périmé est repris et son compteur passe à 2, une écriture v2 finalise un `sending` posé par le canal historique, et le **rollback du parent supprime sans broncher une fonction falsifiée** (`rc=0`), même avec des accusés en vol.
- **Verts sur le correctif** : 48/48 (`withdrawal-ack-merchant-mailer-p2` + `withdrawal-ack-merchant-mailer`), 298/298 sur 18 fichiers voisins, `tsc` 0 erreur, `next build` de production OK (env Supabase factice), harnais PostgreSQL réel **158 PASS, 0 FAIL**.
- Le harnais PostgreSQL applique les vrais lots (chaîne GAP-01, e-mail obligatoire, #180, SMTP marchand), y compris 25 contre-exemples de dérive du rollback (plus 3 refus d'état : interrupteur ouvert, preuves, accusés en vol) (corps, propriétaire, droits, attributs, signature, dépendances, déclencheurs, table, colonnes), chacun avec **empreinte d'état inchangée** après refus, un rollback nominal avec corps stockés en **CRLF**, puis le second rollback (refusé : sans objet) et la ré-application.
- La suite complète n'a **pas** été relancée (aucun risque précis ; consigne).

## 7. Limites et conditions qui empêchent encore l'activation

Conditions de mise en service **non traitées par ce correctif** :
- **Textes / CGV** : la clause v7 promet `retractation@scanym.com` ; à revoir et republier avant l'interrupteur (§4).
- **Garde de publication des CGV** (`_scanym_has_online_withdrawal_runtime`) : lit toujours la santé du canal **plateforme**, volontairement non modifiée. Tant que ce canal est indisponible, elle peut bloquer la publication des CGV même si les messageries marchandes fonctionnent. À traiter dans le lot CGV v8.

Limites du fonctionnement :
- **Pas d'« exactly-once »**, pas de garantie de remise (voir « Garantie réelle », §2).
- **Issue ambiguë = humaine** : un `sending` (écriture non confirmée, ou processus disparu) n'est jamais repris ; il reste visible au back-office et au diagnostic. Aucun outil de régularisation n'est fourni (SQL hébergé).
- **Pas de reprise automatique** : `failed` est terminal.
- Un échec de **revendication** dont la réponse est perdue (RPC exécutée côté base, réponse non reçue) laisse la ligne `sending` sans envoi : même traitement humain.
- La langue du client n'est pas transmise : accusé toujours en français.
- Le fournisseur marchand est **suspendu** sur échec d'authentification permanent : cela affecte aussi ses autres e-mails (commandes).
- L'adresse d'expéditeur doit être autorisée par le compte SMTP du commerçant : sinon l'hébergeur refuse, la demande passe `failed`.
- Un Reply-To invalide est ignoré (champ non contractuel) ; l'expéditeur invalide, lui, est un échec.
- `after()` : si la fonction est arrêtée avant la fin, le résultat n'est pas écrit : la ligne reste `sending` (issue ambiguë ci-dessus).
- Le canal historique n'a toujours pas de validation CR/LF dans son transport (la route la fait désormais en amont) ni de propagation des erreurs d'écriture (§9).
- Le harnais PostgreSQL ne remplace pas un contrôle sur la base hébergée : aucun SQL hébergé n'a été exécuté.

## 8. Rollback (P2-3)

`DRAFT-lot-withdrawal-ack-merchant-mailer-v1-ROLLBACK.sql` pose un verrou sur `withdrawal_requests`, puis vérifie **tout avant la première mutation** et s'arrête sans rien modifier à la moindre dérive : interrupteur fermé (ligne unique, RLS, aucun droit) ; aucune preuve d'envoi ; aucun accusé `pending`/`sending` (un retrait ne doit pas rouvrir d'arriéré revendicable) ; pour **chaque** fonction : existence, signature, type de retour, langage, volatilité, `SECURITY DEFINER`, `search_path`, propriétaire (= celui de `withdrawal_requests`), droits d'exécution exacts, **corps** (MD5 après normalisation CRLF→LF, recalculée si le lot change : un test compare les empreintes au fichier du lot en LF et en CRLF) ; déclencheur exact ; colonnes et contrainte exactes ; aucun objet dépendant ni fonction tierce qui les nomme ; GAP-01 présent. Les suppressions n'utilisent plus `IF EXISTS`. Conséquence assumée : **le rollback est impossible une fois le canal utilisé** (preuves) ; la voie normale est de fermer l'interrupteur.

## 9. Défaut PRÉEXISTANT de finalisation des baux (GAP-01, canal historique) — décrit à part

**Où** : `record_withdrawal_acknowledgement_result` (v1, `DRAFT-lot-gap-01-ack-transport-v1.sql`) fait `update … where id = p_id` **sans condition d'état ni identité de bail**, et `claim_withdrawal_acknowledgement_send` reprend tout `sending` périmé (120 s). **Effets reproduits** (sonde `lease_probe` du harnais, sur l'état *parent* avant le lot puis sur le *candidat*, résultats identiques `sent|<m2>|2|sent`) :
- a. un résultat « ok » sur une ligne `unavailable_no_channel` la fabrique en `sent` (faux succès) ;
- b. deux résultats « ok » successifs (processus périmé puis repreneur) : l'identifiant de message et l'horodatage de la **première preuve sont écrasés** ;
- c. deux revendications successives de la même demande après péremption : **deux envois possibles** ;
- d. un résultat « échec » tardif sur une ligne `sent` n'est refusé que par la contrainte de table `withdrawal_requests_ack_sent_requires_timestamp` (pas par la fonction).

**Couplage avec le nouveau parcours** : ce lot ne modifie pas ces fonctions (le défaut est identique avant/après). Le parcours marchand v2 n'en dépend pas : il ne reprend jamais un `sending`, et son enregistrement est conditionnel à `sending` + canal marchand (testé : écriture tardive refusée). Le défaut reste atteignable **par le canal historique** (interrupteur fermé) et par une éventuelle double invocation du canal historique sur une demande déjà revendiquée par v2 — aucun code ne le fait aujourd'hui (l'envoi n'est lancé qu'à la création, jamais au rejeu). Il **n'empêche donc pas** de garantir le nouveau parcours, mais il n'est pas pour autant « accepté ».

**Correction proposée (à décider, PR séparée, non incluse ici)** : `create or replace` de `record_withdrawal_acknowledgement_result` avec `and acknowledgement_status = 'sending'` et `acknowledgement_transport is distinct from 'merchant_smtp'`, et de `claim_withdrawal_acknowledgement_send` avec `acknowledgement_transport is distinct from 'merchant_smtp'` (et, si le CIO veut supprimer aussi le risque de double envoi du canal historique, retrait de la reprise du `sending` périmé, comme en v2). Cette correction dépend du présent lot (colonne `acknowledgement_transport`) et exige son propre contre-audit : changement de comportement du canal historique actuellement en production.
