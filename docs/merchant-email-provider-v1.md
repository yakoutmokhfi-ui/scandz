# Réglage SMTP marchand — v1 (révision R1, corrections de l'audit PR #196)

L'onglet **E-mails** du tableau de bord permet à chaque propriétaire ou gérant de régler son propre serveur SMTP. Les confirmations utilisent le suivi réutilisable de la commande ; le lien de rétractation apparaît uniquement pour une commande éligible.

## Configuration de la plateforme

1. Appliquer `supabase/DRAFT-lot-merchant-smtp-notifications-v1.sql` **après** le lot N1-A (notifications) et le lot « ORDER_RECEIVED PAYMENT GATE » (#180) dont il dépend : le lot vérifie à l'identique (corps, attributs, arguments, colonnes retournées, propriétaire, droits) le claim posé par #180 et **refuse** (`SCANYM_PREDECESSOR_DRIFT`, rien n'est modifié) toute variante.
2. Configurer côté serveur `MERCHANT_SMTP_ENCRYPTION_KEY` avec 32 octets encodés en base64 (`openssl rand -base64 32`). Ne jamais préfixer cette variable par `NEXT_PUBLIC_` ni la mettre dans le dépôt.
3. Configurer `CRON_SECRET` sur le projet Vercel. Le Cron appelle `/api/internal/notifications/send` toutes les cinq minutes avec l'en-tête `Authorization: Bearer <CRON_SECRET>` ; tout autre schéma (secret nu, `bearer` en minuscules…) est refusé (401).
4. Laisser `NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED` absent ou différent de `true` pendant la recette. La route répond alors `{"ok":true,"status":"disabled"}` sans toucher à la base : ni reprise de bail, ni réclamation. L'activation des vrais envois est une décision de mise en production séparée.

### Retour arrière (ordre impératif)

1. `supabase/DRAFT-lot-merchant-smtp-notifications-v1-rollback.sql` d'abord : il refuse (`SCANYM_ROLLBACK_DATA_LOSS`) s'il reste des identifiants enregistrés, refuse si le claim a dérivé depuis le lot, puis restaure le claim de #180 **octet pour octet** (même corps, mêmes attributs, mêmes droits, même commentaire) et supprime le coffre.
2. `supabase/DRAFT-lot-order-received-payment-gate-v1-rollback.sql` ensuite, si nécessaire. Ce rollback reste possible parce que l'étape 1 a rendu à #180 le claim qu'il attend.

## Réglage par commerce

Dans **E-mails**, le propriétaire ou le gérant saisit l'hôte SMTP, le port TLS direct 465, l'adresse utilisateur et le mot de passe de la boîte, ainsi que l'identité expéditeur déjà utilisée dans le profil de notification. Pour IONOS : `smtp.ionos.fr`, `465`, et l'adresse complète comme nom d'utilisateur. Le bouton de test vérifie la connexion et l'authentification SMTP sans envoyer de message.

- **Le mot de passe suit sa cible.** Un secret déjà enregistré n'est conservé que si l'hôte et l'identifiant sont inchangés. Changer l'un ou l'autre exige de ressaisir le mot de passe (`400 SMTP_PASSWORD_REQUIRED`) : un rôle autorisé à modifier la cible ne peut donc pas faire présenter le mot de passe d'un autre à un serveur de son choix (A196-01).
- **Enregistrement fermé.** Tout est validé avant la moindre écriture (mot de passe ≤ 512 caractères, nom d'expéditeur ≤ 120 sans caractère de contrôle, adresses). Le coffre est d'abord enregistré **désactivé**, puis le profil est écrit, puis le coffre est activé ; si le profil est refusé, l'état précédent du coffre est restauré à l'identique. Une modification concurrente de la cible renvoie `409 EMAIL_PROVIDER_CONFLICT`.
- **Test de connexion limité.** Un test par établissement et par fenêtre de 30 secondes (réservation atomique en base) ; au-delà : `429 EMAIL_PROVIDER_TEST_RATE_LIMITED`. La réponse ne contient jamais le texte renvoyé par le serveur SMTP, uniquement une classe normalisée.
- Le mot de passe est chiffré en AES-256-GCM avant stockage, **lié à l'établissement** (données authentifiées `scanym:merchant-smtp:v2:<restaurant_id>`) : un chiffré copié vers un autre restaurant ne se déchiffre pas. Il n'est jamais renvoyé au navigateur. L'accès à la table du coffre est refusé aux rôles `anon` et `authenticated` ; `service_role` peut lire, insérer et modifier mais pas supprimer.

## Comportement du worker

- **Éligibilité.** Une notification n'est réclamée que si le coffre de son établissement est activé avec un secret **et** si le commerçant a activé l'envoi dans son profil, en plus de la porte de paiement de #180. Les autres restent en attente sans consommer de tentative.
- **Classification des échecs.** Chaque échec SMTP est rangé dans la taxonomie fermée existante, selon l'étape du dialogue : délai → `PROVIDER_TIMEOUT` ; refus d'authentification permanent (5xx) → `PROVIDER_AUTHENTICATION_FAILED` ; indisponibilité temporaire (4xx, connexion) → `PROVIDER_TEMPORARY_UNAVAILABLE` ; serveur, certificat ou secret inutilisable → `PROVIDER_CONFIGURATION_ERROR` ; destinataire refusé (RCPT 5xx) → `INVALID_RECIPIENT` (non réessayé). Aucun texte du serveur n'est conservé.
- **Suspension automatique.** Un refus d'authentification permanent, ou un secret illisible (clé remplacée, donnée altérée), **suspend** le fournisseur (`enabled = false`) et enregistre la classe dans `last_error_class` / `last_error_at`. Les notifications restent en file (le claim exige un coffre activé) : plus de rafale de connexions échouées vers la boîte du commerçant. Le tableau de bord affiche l'incident ; le commerçant ressaisit son mot de passe et réactive. Un envoi réussi efface l'incident.
- **Budget temps.** Lot de 25, bail de 300 s, `maxDuration` 300 s. Aucun nouvel envoi n'est démarré après 150 s ; une session SMTP est bornée à 60 s au total (DNS + connexion + dialogue) et une session dépassée ne poursuit jamais le dialogue en arrière-plan. Invariant vérifié par test : `150 s + 60 s < 300 s`. Les lignes réclamées mais non traitées voient leur bail expirer ; `reap_stale_notification_claims` les remet en attente sans consommer de tentative.

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
- La restauration de l'état précédent après un refus du profil réécrit la ligne du coffre lue juste avant : une modification concurrente dans cette fenêtre de quelques millisecondes serait écrasée.
