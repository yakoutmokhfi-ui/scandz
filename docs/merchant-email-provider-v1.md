# Réglage SMTP marchand — v1

L'onglet **E-mails** du tableau de bord permet à chaque propriétaire ou gérant de régler son propre serveur SMTP. Les confirmations utilisent le suivi réutilisable de la commande ; le lien de rétractation apparaît uniquement pour une commande éligible.

## Configuration de la plateforme

1. Appliquer `supabase/DRAFT-lot-merchant-smtp-notifications-v1.sql` après les lots de notifications, du suivi et du paiement dont il dépend.
2. Configurer côté serveur `MERCHANT_SMTP_ENCRYPTION_KEY` avec 32 octets encodés en base64 (`openssl rand -base64 32`). Ne jamais préfixer cette variable par `NEXT_PUBLIC_` ni la mettre dans le dépôt.
3. Configurer `CRON_SECRET` sur le projet Vercel. Le Cron appelle `/api/internal/notifications/send` toutes les cinq minutes.
4. Laisser `NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED` absent ou `false` pendant la recette. Le worker ne réclame alors aucune notification. L'activation des vrais envois est une décision de mise en production séparée.

## Réglage par commerce

Dans **E-mails**, le propriétaire ou le gérant saisit l'hôte SMTP, le port TLS direct 465, l'adresse utilisateur et le mot de passe de la boîte, ainsi que l'identité expéditeur déjà utilisée dans le profil de notification. Pour IONOS : `smtp.ionos.fr`, `465`, et l'adresse complète comme nom d'utilisateur. Le bouton de test vérifie la connexion et l'authentification SMTP sans envoyer de message.

Le mot de passe est chiffré en AES-256-GCM avant stockage. Il n'est jamais renvoyé au navigateur. L'accès à la table du coffre est refusé aux rôles `anon` et `authenticated`; seules les routes serveur et le worker y accèdent. Un commerce sans configuration active (ou avec l'option d'e-mails désactivée) garde ses notifications en attente sans consommer de tentative.

## Limites actuelles

- Le transport v1 accepte SMTP avec TLS direct sur le port 465. STARTTLS sur le port 587 et les fournisseurs à authentification OAuth ne sont pas pris en charge.
- Le test de connexion envoie zéro e-mail. Il ne valide ni SPF/DKIM/DMARC ni la réception dans la boîte du client.
- Le secret de chiffrement doit rester stable. Une rotation exige de déchiffrer puis rechiffrer les configurations par une procédure dédiée avant de remplacer la clé.
- SMTP ne garantit pas l'idempotence native : une panne après acceptation du message par le serveur, mais avant l'enregistrement du succès, peut entraîner un renvoi après expiration du bail.
