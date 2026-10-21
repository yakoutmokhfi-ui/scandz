# Configurer Monetico en TEST pour Au Lait Cru

Ce petit outil ponctuel inscrit le credential Monetico du TPE Au Lait Cru dans le coffre Supabase Vault du projet Scanym.

## Garde-fous

- Le code cible uniquement le projet Supabase `ctqfpszwunfomrbxgigu` et le slug `au-lait-cru`.
- Il refuse d'écraser une configuration Monetico déjà présente.
- Il appelle uniquement `set_payment_provider_credentials` avec `mode = test`.
- La clé Monetico et la clé secrète Supabase sont demandées au clavier sans écho. Le script accepte la clé actuelle `sb_secret_…` ou l’ancienne clé JWT `service_role`. Elles ne sont ni arguments de commande, ni affichées, ni sauvegardées dans un fichier.
- Il vérifie après l'écriture que le statut est `configured`, le mode `test` et `is_enabled = false`.
- Il ne valide aucun paiement, ne crée aucune commande et n'active pas le checkout.

Le code `aulaitcru` est proposé par défaut, car l'application utilise actuellement le paiement hébergé par redirection, pas Hosted Fields. Le code `aulaitcru_hf` n'est prévu que pour Hosted Fields. Si l'écran Monetico indique explicitement un autre code pour le TPE choisi, ne poursuivez pas avant d'avoir clarifié cette correspondance.

## Exécution

Depuis un terminal interactif sur un ordinateur de confiance, avec Node.js 18.18+ :

```sh
node .\scripts\monetico-test-setup.mjs
```

Saisir l’URL du projet Scanym affichée sur la page du projet Supabase. À l’invite de clé Supabase, saisis la clé `sb_secret_…` affichée dans Settings → API Keys (ou l’ancienne `service_role` si elle est encore disponible) : la saisie est masquée. Cette clé donne des droits élevés ; ne la partage pas et ne la mets pas dans le chat. Ne pas la passer dans la commande, ne pas l'ajouter à `.env`, ne pas l'envoyer dans le chat.

Confirmer le TPE `35VV71I`, le code société exact du portail Monetico (`aulaitcru` pour la redirection hébergée), puis saisir la clé de sécurité à l'invite masquée.

Le succès attendu est `monetico, mode test, statut configured, activé=false`. Toute erreur interrompt le script ; le message ne contient jamais la clé. Si une configuration Monetico est déjà présente, le script s'arrête sans la remplacer.

## Vérifications après configuration

La configuration seule ne permet pas encore au client de payer : le checkout exige `is_enabled = true`, `configuration_status = verified` et le coupe-circuit de runtime activé. Cet outil ne fait aucune de ces activations. La validation d'un paiement de test nécessite une étape séparée et des URLs de retour/callback déjà configurées chez Monetico.

Les tests locaux (sans accès réseau ni clé réelle) se lancent avec `node --test .\scripts\test-monetico-test-setup.mjs`.
