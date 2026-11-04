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

**Destinataires** : un **seul message** : À = adresse saisie par le client ; Cc = `merchant_legal_profile.customer_service_email`. Un seul message évite la double émission et garantit que le client et le commerçant reçoivent exactement le même contenu. Pas de Cc si l'adresse est absente, invalide ou identique à celle du client.

**Au Lait Cru** : `contact@aulaitcru.com` n'est **écrit nulle part dans le code ni dans les scripts SQL** (un test le vérifie). Il se règle comme pour tout commerçant, dans son profil légal (`customer_service_email`). Vérification avant ouverture : requête 4 du diagnostic (recherche par nom, motif à adapter). Je n'ai pas lu la base hébergée (interdit) : la valeur actuelle de cette configuration reste **à constater** par le diagnostic.

**Interrupteur** : table singleton `scanym_ack_merchant_mailer_activation` (fermée par défaut, aucun droit, écriture par SQL opérateur). Fermé ou illisible (RPC absente, erreur) ⇒ canal historique **strictement inchangé**. Ouvert ⇒ messagerie du commerçant. Le choix se fait une fois par demande, avant la revendication ; **aucun repli** d'un canal sur l'autre (jamais deux identités pour un même accusé).

**Statut à la création** : un déclencheur `BEFORE INSERT` passe `unavailable_no_channel` → `pending` **seulement** si l'interrupteur est ouvert **et** si la messagerie de cet établissement est prête (coffre actif avec secret + profil d'envoi activé avec nom et adresse). `submit_withdrawal_request_by_capability` n'est **pas réécrite** (pas de dérive possible de sa définition).

**Statut fidèle** :
- l'envoi est lancé après l'enregistrement, via `after()` (Next 15.1+) : il se poursuit après la réponse (`maxDuration = 90`). Remplace un `void` non attendu, qui pouvait être coupé ;
- la réponse attend au plus 8 s le résultat : `sent` / `failed` seulement s'il est connu, sinon l'état enregistré (`pending`). Jamais `sent` sans envoi confirmé ;
- l'enregistrement du résultat est conditionnel à l'état `sending` ; l'erreur est normalisée en classe fermée (rien de brut en base) ;
- une exception du fournisseur devient un échec enregistré, jamais une demande laissée à `sending` ;
- le tableau de bord affiche « Copie envoyée à » **uniquement** pour `sent`, et la cause pour `failed` ; la page publique a un libellé `failed` (FR/EN/AR) qui ne promet pas de notification du vendeur.

**Isolation entre commerçants** : l'établissement vient de la ligne de la demande lue en base, jamais du client ; `resolveProvider` n'est appelé qu'avec cet identifiant ; le secret du coffre est lié à l'établissement (AAD) : copié dans une autre ligne, il ne se déchiffre pas (contrôle négatif testé). Le lot ne contient aucune politique RLS ni droit pour `anon`/`authenticated`.

**Doublons** : claim atomique (`pending`, ou `sending` périmé) ; une demande `sent`, `failed` ou `unavailable_no_channel` n'est jamais reprise ; un rejeu de la déclaration (`replayed`) ne relance pas l'envoi ; clé d'idempotence stable `scanym:withdrawal-ack:<id>`.

**Sécurité de l'adresse** : l'adresse du client est validée strictement (pas d'espace, de CR/LF, de chevrons, de guillemets) à la route **et** avant tout envoi — fermeture d'une injection de commandes SMTP.

## 3. Demandes déjà enregistrées sans accusé

**Aucun envoi automatique, aucun backfill.**
- Le lot ne modifie aucune ligne existante.
- Le claim v2 ne prend que `pending` (ou `sending` périmé) : les demandes `unavailable_no_channel` et `failed` historiques ne sont **jamais** envoyées par ce chemin (testé en PostgreSQL réel).
- `DRAFT-diagnostic-withdrawal-ack-backlog-v1-READONLY.sql` (SELECT uniquement) liste ces demandes par établissement et par état, indique si la messagerie de chaque établissement est prête, le Cc prévu, et si les CGV publiées annoncent `retractation@scanym.com`.

**Décision à prendre (CIO) avant tout envoi rétroactif**, car un accusé tardif est un acte juridique et un e-mail réel :
1. liste des demandes concernées (diagnostic) ;
2. texte et expéditeur de l'accusé tardif (le contenu garde la date et l'heure réelles de la demande) ;
3. si accord : **action manuelle, demande par demande**, validée par le commerçant (suite recommandée : une action « renvoyer l'accusé » dans le back-office, avec journal). Hors périmètre de cette PR.

## 4. Prérequis juridique : CGV v7

La clause v7 promet un accusé envoyé depuis `retractation@scanym.com` (avec contrôle post-commit). Envoyer depuis la messagerie du commerçant la contredit pour les commerçants qui l'ont publiée. **Ne pas ouvrir l'interrupteur avant revue juridique et republication.** Formulation neutre proposée (à valider, aucun SQL de CGV v8 n'est rédigé ici) :

> « Un accusé de réception de votre demande, mentionnant sa date et son heure, vous est envoyé par courrier électronique à l'adresse que vous avez indiquée, depuis l'adresse électronique du vendeur ; le vendeur en reçoit une copie. »

## 5. Mise en service (ordre)

1. Revue et audit de cette PR (Draft).
2. **GO explicite** : appliquer `DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql` (n'ouvre pas l'interrupteur ; vérifie en fin de lot que l'interrupteur reste fermé et que la valeur de la garde CGV est inchangée). Rollback : `…-ROLLBACK.sql` (refuse si l'interrupteur est ouvert ou si des colonnes de preuve sont remplies).
3. Déployer le code. Sans le lot SQL, la RPC est inconnue et le code reste sur le canal historique.
4. **GO séparé**, après : diagnostic, test de connexion SMTP réussi dans l'onglet E-mails de chaque établissement concerné, `customer_service_email` renseigné, CGV revues et republiées.
5. Ouvrir l'interrupteur (snippet commenté en fin de lot). Fermeture immédiate possible sans rollback.

## 6. Résultats

- Harnais PostgreSQL réel (`supabase/tests/withdrawal-ack-merchant-mailer-v1-check.sh`, base jetable, lots GAP-01, e-mail obligatoire, #180 et SMTP-marchand réellement appliqués) : **84 PASS, 0 FAIL** — interrupteur fermé/ouvert, isolation A/B, absence de renvoi automatique, fidélité de l'enregistrement, reprise d'un `sending` périmé, privilèges, canal plateforme sain, garde-fous du rollback.
- `tests/withdrawal-ack-merchant-mailer.test.ts` : **33 tests**. Contrôle négatif : trois défauts introduits volontairement (Cc perdu, messagerie résolue pour un autre établissement, `void` non attendu) sont chacun détectés, puis le code est restauré.
- Tests voisins relancés (ack-mailer, back-office rétractations, cookie/chemin, fournisseur/transport/classification SMTP, e-mail marchand, MCC e-mails, taxonomie, idempotence, worker, i18n) : **0 échec**. `tsc` : 0 erreur.
- La suite complète et `next build` n'ont **pas** été relancés (pas de risque précis identifié ; consigne).

## 7. Limites connues

- **Pas de reprise automatique** : `failed` est terminal. Une demande reste `pending` si le processus meurt avant l'envoi (elle reste revendicable, de même qu'un `sending` périmé après 120 s, mais rien ne la relance seul).
- La garde de publication des CGV (`_scanym_has_online_withdrawal_runtime`) lit toujours la santé du canal **plateforme**, volontairement non modifiée : elle peut continuer à bloquer la publication tant que ce canal est indisponible. À traiter dans le lot CGV v8.
- La langue du client n'est pas transmise : accusé toujours en français.
- Le fournisseur marchand est **suspendu** sur échec d'authentification permanent : cela affecte aussi ses autres e-mails (commandes).
- L'adresse d'expéditeur doit être autorisée par le compte SMTP du commerçant (souvent identique à l'identifiant) : sinon l'hébergeur refuse, la demande passe `failed`.
- Sous un régime exigeant l'accusé, un contact **présent mais invalide** donne un envoi sans copie (et `copie_vers` vide), pas un échec ; seul le contact absent est un échec (garde héritée).
- `after()` : l'envoi peut être interrompu si la fonction est arrêtée avant la fin ; le résultat n'est alors pas enregistré.
- Le canal historique n'a toujours pas de validation CR/LF dans son transport (la route la fait désormais en amont).
- Le harnais PostgreSQL ne remplace pas un test sur la base hébergée : aucun SQL hébergé n'a été exécuté.
