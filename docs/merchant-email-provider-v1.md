# Réglage SMTP marchand — v1 (révision R2 : corrections de l'audit PR #196 puis du contre-audit de `7cb60a8`)

L'onglet **E-mails** du tableau de bord permet à chaque propriétaire ou gérant de régler son propre serveur SMTP. Les confirmations utilisent le suivi réutilisable de la commande ; le lien de rétractation apparaît uniquement pour une commande éligible.

## Configuration de la plateforme

1. Appliquer `supabase/DRAFT-lot-merchant-smtp-notifications-v1.sql` **après** le lot N1-A (notifications) et le lot « ORDER_RECEIVED PAYMENT GATE » (#180) dont il dépend : le lot vérifie à l'identique (corps **sur les octets exacts**, commentaire, attributs, arguments, colonnes retournées, propriétaire, droits) le claim posé par #180 et **refuse** (`SCANYM_PREDECESSOR_DRIFT`, rien n'est modifié) toute variante. Seules deux formes d'octets du corps sont admises : LF, ou CRLF intégral (extraction Windows du dépôt) ; tout CR isolé ou fins de ligne mixtes sont refusés (aucun littéral des corps ne contient de saut de ligne : un test le vérifie).
2. Configurer côté serveur `MERCHANT_SMTP_ENCRYPTION_KEY` avec 32 octets encodés en base64 (`openssl rand -base64 32`). Ne jamais préfixer cette variable par `NEXT_PUBLIC_` ni la mettre dans le dépôt.
3. Configurer `CRON_SECRET` sur le projet Vercel. Le Cron appelle `/api/internal/notifications/send` toutes les cinq minutes avec l'en-tête `Authorization: Bearer <CRON_SECRET>` ; tout autre schéma (secret nu, `bearer` en minuscules…) est refusé (401).
4. Laisser `NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED` absent ou différent de `true` pendant la recette. La route répond alors `{"ok":true,"status":"disabled"}` sans toucher à la base : ni reprise de bail, ni réclamation. L'activation des vrais envois est une décision de mise en production séparée.

### Retour arrière (ordre impératif)

Lancer le retour arrière **Cron arrêté** (`NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED` absent) et hors d'un enregistrement en cours : le claim du Cron lit aussi la table du coffre, que le retour arrière verrouille.

1. `supabase/DRAFT-lot-merchant-smtp-notifications-v1-rollback.sql` d'abord. Il prend d'abord un **verrou exclusif sur la table du coffre** (délai maximal 10 s, `lock_timeout`) : un enregistrement en cours est donc attendu, puis le contrôle « coffre vide » voit sa configuration validée et refuse (`SCANYM_ROLLBACK_DATA_LOSS`) au lieu de la perdre ; si le verrou ne peut pas être pris en 10 s, le rollback échoue sans rien modifier et peut être relancé. Il refuse aussi si le claim a dérivé depuis le lot (mêmes pré-vols exacts que l'application), puis restaure le claim de #180 **octet pour octet** (même corps, mêmes attributs, mêmes droits, même commentaire) et supprime le coffre.
2. `supabase/DRAFT-lot-order-received-payment-gate-v1-rollback.sql` ensuite, si nécessaire. Ce rollback reste possible parce que l'étape 1 a rendu à #180 le claim qu'il attend.

## Réglage par commerce

Dans **E-mails**, le propriétaire ou le gérant saisit l'hôte SMTP, le port TLS direct 465, l'adresse utilisateur et le mot de passe de la boîte, ainsi que l'identité expéditeur déjà utilisée dans le profil de notification. Pour IONOS : `smtp.ionos.fr`, `465`, et l'adresse complète comme nom d'utilisateur. Le bouton de test vérifie la connexion et l'authentification SMTP sans envoyer de message.

- **Le mot de passe suit sa cible.** Un secret déjà enregistré n'est conservé que si l'hôte et l'identifiant sont inchangés. Changer l'un ou l'autre exige de ressaisir le mot de passe (`400 SMTP_PASSWORD_REQUIRED`) : un rôle autorisé à modifier la cible ne peut donc pas faire présenter le mot de passe d'un autre à un serveur de son choix (A196-01).
- **Enregistrement fermé.** Tout est validé avant la moindre écriture (mot de passe ≤ 512 caractères, nom d'expéditeur ≤ 120 sans caractère de contrôle, adresses). Le coffre est d'abord enregistré **désactivé**, puis le profil est écrit, puis le coffre est activé ; si le profil est refusé, l'état précédent du coffre est restauré à l'identique. **Un enregistrement prend un bail** (jeton + échéance de 60 s, colonnes `save_token` / `save_lease_until`) en une seule écriture conditionnelle (la ligne doit être exactement dans l'état lu et sans bail valide) ; l'activation et la restauration ne s'appliquent que si la ligne porte encore **son** jeton. Un enregistrement concurrent reçoit donc `409 EMAIL_PROVIDER_CONFLICT` (première configuration : arbitrée par la clé primaire) ; une restauration tardive n'écrase jamais la configuration d'un autre enregistrement réussi ; un bail orphelin (plantage) expire seul. Une modification concurrente de la cible renvoie `409 EMAIL_PROVIDER_CONFLICT`.
- **Test de connexion limité.** Un test par établissement et par fenêtre de 30 secondes (réservation atomique en base) ; au-delà : `429 EMAIL_PROVIDER_TEST_RATE_LIMITED`. La réponse ne contient jamais le texte renvoyé par le serveur SMTP, uniquement une classe normalisée.
- Le mot de passe est chiffré en AES-256-GCM avant stockage, **lié à l'établissement** (données authentifiées `scanym:merchant-smtp:v2:<restaurant_id>`) : un chiffré copié vers un autre restaurant ne se déchiffre pas. Il n'est jamais renvoyé au navigateur. L'accès à la table du coffre est refusé aux rôles `anon` et `authenticated` ; `service_role` peut lire, insérer et modifier mais pas supprimer.

## Comportement du worker

- **Éligibilité.** Une notification n'est réclamée que si le coffre de son établissement est activé avec un secret **et** si le commerçant a activé l'envoi dans son profil, en plus de la porte de paiement de #180. Les autres restent en attente sans consommer de tentative.
- **Classification des échecs.** Chaque échec SMTP est rangé dans la taxonomie fermée existante, selon l'étape du dialogue : délai → `PROVIDER_TIMEOUT` ; refus d'authentification permanent (5xx) → `PROVIDER_AUTHENTICATION_FAILED` ; indisponibilité temporaire (4xx, connexion) → `PROVIDER_TEMPORARY_UNAVAILABLE` ; serveur, certificat ou secret inutilisable → `PROVIDER_CONFIGURATION_ERROR` ; destinataire refusé (RCPT 5xx) → `INVALID_RECIPIENT` (non réessayé). Aucun texte du serveur n'est conservé.
- **Suspension automatique.** Un refus d'authentification permanent, ou un secret illisible (clé remplacée, donnée altérée), **suspend** le fournisseur (`enabled = false`) et enregistre la classe dans `last_error_class` / `last_error_at`. Les notifications restent en file (le claim exige un coffre activé) : plus de rafale de connexions échouées vers la boîte du commerçant. Le tableau de bord affiche l'incident ; le commerçant ressaisit son mot de passe et réactive. Un envoi réussi efface l'incident.
- **Réponses SMTP.** Le dialogue lit des réponses complètes même si le serveur les fragmente en plusieurs paquets TLS ou répond sur plusieurs lignes (`250-…` puis `250 …`) ; une réponse est bornée à 64 Kio (`SMTP_REPLY_TOO_LARGE`) ; une connexion fermée au milieu d'une réponse est une indisponibilité temporaire.
- **Budget temps.** Lot de 25, bail de 300 s, `maxDuration` 300 s. Aucun nouvel envoi n'est démarré après 150 s — la date limite est revérifiée **immédiatement avant** `provider.send` (après la lecture du coffre, le déchiffrement et l'émission de la capacité de suivi, dont la durée n'est pas bornée), sans aucun `await` entre le contrôle et l'envoi ; une session SMTP est bornée à 60 s au total (DNS + connexion + dialogue) et une session dépassée ne poursuit jamais le dialogue en arrière-plan. Invariant vérifié par test : `150 s + 60 s < 300 s`. Les lignes réclamées mais non traitées voient leur bail expirer ; `reap_stale_notification_claims` les remet en attente sans consommer de tentative.

## Avant d'activer les vrais envois (arriéré)

Un commerce dont le profil e-mail était déjà activé avant la configuration du coffre garde des lignes `pending` sans limite d'âge : dès que `NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED=true` et que le coffre est activé, **toutes** partent, y compris d'anciennes commandes (constat A196-10-3, non corrigé par le code : l'âge utile d'un « commande reçue » dépend de la porte de paiement). Avant l'activation, mesurer l'arriéré en lecture seule et décider (requalifier ou laisser partir) :

```sql
select restaurant_id, count(*) as pending, min(created_at) as oldest
from public.notification_outbox
where status in ('pending', 'failed_retryable')
group by restaurant_id
order by oldest;
```

## Limites actuelles

- Le transport v1 accepte SMTP avec TLS direct sur le port 465. STARTTLS sur le port 587 et les fournisseurs à authentification OAuth ne sont pas pris en charge.
- Le test de connexion envoie zéro e-mail. Il ne valide ni SPF/DKIM/DMARC ni la réception dans la boîte du client.
- **Pas de procédure de rotation de clé.** Le secret de chiffrement doit rester stable ; le format AAD est versionné (`v2`) pour permettre une migration future, mais aucun identifiant de clé n'est stocké et aucun outil de rechiffrement n'existe. Une rotation exige une procédure dédiée (déchiffrer puis rechiffrer avant de remplacer la clé) à écrire avant toute rotation.
- Il n'y a pas d'action « supprimer la configuration » : `service_role` n'a pas le droit `DELETE` sur le coffre. Désactiver suffit à stopper les envois.
- SMTP ne garantit pas l'idempotence native : une panne ou un délai après acceptation du message par le serveur, mais avant l'enregistrement du succès, peut entraîner un renvoi. Le budget temps ci-dessus supprime la cause de doublon liée à l'expiration du bail en régime normal ; le risque résiduel inhérent (message accepté puis perte de la réponse) demeure.
- Le profil (`merchant_notification_profile`) et le coffre sont deux écritures distinctes, non transactionnelles. Le bail les sérialise en fonctionnement normal ; si un enregistrement dépasse 60 s (bail repris par un autre), il reçoit `409` à l'activation et ne touche pas au coffre de l'autre, mais le profil qu'il a écrit peut alors précéder celui de l'autre enregistrement (dernier écrit gagnant).
- Une suspension automatique du fournisseur (`enabled = false`) survenue entre la lecture du coffre et la mise en préparation fait échouer celle-ci en `409` (la ligne n'est plus dans l'état lu) ; survenue pendant un enregistrement qui échoue ensuite, elle serait annulée par la restauration (fenêtre de quelques millisecondes) — le worker la reconstate à la tentative suivante.
- Le pré-vol de #180 lui-même (déjà fusionné) normalise encore les CR avant son empreinte ; ce lot ne peut pas le corriger, seulement ne plus en dépendre.
