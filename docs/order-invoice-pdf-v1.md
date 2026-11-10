# Facture PDF A4 v1 — développement, non activé

## Périmètre

- Nouvelle facture détaillée pour une commande avec demande de facture, paiement en ligne confirmé, commerçant français assujetti à TVA, montants EUR / prix TTC et instantanés complets. Les commandes sans facture demandée ou à paiement sur place ne sont pas facturées par cette version.
- PDF A4 français : identité juridique et adresse vendeur, coordonnées de facturation client/société, numéro, date de commande et d'émission, paiement confirmé, lignes historiques, quantité, prix unitaire HT (jusqu’à 8 décimales), taux et TTC, livraison, HT/TVA/TTC, mentions vendeur.
- Le titre utilise la raison sociale comme identité visuelle. Logo image, couleurs personnalisées et versions PDF EN/AR/NL ne sont pas inclus. La police embarquée couvre les caractères des noms de produits ; ce n'est pas une promesse de mise en page RTL intégrale. Les boutons du back-office sont FR/EN/AR/NL.
- Un e-mail dédié avec PDF attaché, distinct de l'actuelle confirmation de commande. Destinataire figé : contact_email de la demande de facture, sinon customer_email. Aucun destinataire n'est fourni par le navigateur.
- Boutons Télécharger, Ouvrir/imprimer (lecteur PDF du navigateur), Renvoyer. Pas d'impression silencieuse. Renvoi propriétaire/gérant ; consultation/préparation également personnel autorisé.
- Aucun SQL hébergé, activation, paiement réel, e-mail réel ou déploiement réalisé pendant le développement.

## Architecture et immutabilité

1. Un nouveau cron `/api/internal/invoices/send` toutes les 2 minutes, protégé par CRON_SECRET. Les crons de confirmation (2 min) et Monetico (5 min) restent identiques. Budget monotone 130 s dans une fonction maxDuration 180 s. Lot borné à 2, délai SMTP total 60 s. Une cadence de 2 min ne garantit pas une réception dans ce délai.
2. Deux portes plateforme : INVOICE_PDF_ENABLED=true et NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED=true ; chiffrement SMTP requis. Elles sont fermées par défaut. Opt-in supplémentaire par restaurant dans invoice_pdf_settings, vide à l'installation. Aucun effet sur les autres envois existants.
3. La limite activated_at est estampillée en base à chaque activation. Commande ET demande de facture doivent avoir été créées après. Aucun backfill ni renvoi historique.
4. invoice_pdf_source projette des champs explicitement autorisés : aucun jeton de commande/suivi, secret bancaire ou donnée de catalogue courant. La facture n'écrit jamais orders, paiements ou livraison. Les informations juridiques du vendeur et de facturation sont celles lues à l'émission ; elles ne sont ensuite jamais relues pour une réimpression.
5. Validation de la complétude et des montants avant réservation. Réutilisation du contrat computeOrderFiscalSummary et de sa répartition exacte des HT par ligne, sans modification de son arithmétique. Les taux 0/exonérations et historiques fiscaux incomplets sont bloqués dans cette version plutôt qu'interprétés.
6. Série explicite et globalement unique par établissement (ex. ALC), puis numéro FAC-ALC-2026-000001. Compteur transactionnel verrouillé, unique par commande, incrément après insertion. L'année ne remet pas le compteur à zéro. La série ne change plus après émission, le compteur ne recule pas. Cela évite des doublons entre établissements d'une même entité.
7. Source attendue comparée à nouveau en SQL lors de l'émission. Après réservation, source et numéro sont immuables. Le premier rendu PDF archivé gagne ; un autre processus relit ses octets. Base64 privé en base (2 Mo PDF maximum), empreinte MD5 de contrôle d'intégrité accidentelle, non signature électronique.
8. Une source inexploitable est mise à l'écart par empreinte pour ne pas bloquer les commandes suivantes. Une source modifiée est réexaminée ; un échec d'une ancienne lecture ne bloque pas une source nouvelle. Une panne technique (rendu, stockage) reste à diagnostiquer : pas de suppression d'une facture numérotée.
9. Soumission SMTP indépendante avec pièce jointe MIME multipart/mixed, contenu PDF base64 à 76 caractères/ligne. Les messages sans pièce jointe gardent leur structure précédente.
10. Claim de soumission atomique et permanent, même si l'exécution expire. Identifiant automatique = identifiant de facture. Résultat enregistré conditionnellement au jeton. Jamais de reprise automatique de `sending`/échec ambigu. Un succès SMTP sans résultat enregistré est « non confirmé », jamais « envoyé/reçu ». Ce choix privilégie l'absence de doublons à la relance automatique.
11. Un renvoi manuel exige confirmation et nouvelle clé d'idempotence ; une répétition HTTP incertaine conserve la même clé. Limite en base d'un renvoi par facture par minute. Une acceptation SMTP n'est PAS une preuve de réception (les rebonds, notamment Free, restent possibles).

## Contrôles d'accès

Toutes les tables sont RLS, sans droits anon/authenticated directs. Les RPC d'écriture/lecture interne sont service_role seulement. L'API vérifie `auth.getUser`, lit la commande avec le client du demandeur, puis contrôle has_role_in sur l'établissement stocké avant de consulter l'archive avec service_role. Un opérateur sans rôle commerçant n'obtient pas automatiquement les données. En-têtes no-store, no-referrer, nosniff. Pas d'URL publique de facture. L'API ne reçoit jamais de montant, d'adresse destinataire, de numéro ou de PDF fourni par le navigateur.

## Installation — à réaliser seulement après audit et GO SQL distinct

1. Confirmer le HEAD/tree exact audité et les prérequis sur la base cible, en lecture seule. Valider les colonnes/types, données fiscales réelles, identité juridique, contrat SMTP et mode Monetico live. Le harnais de développement utilise un schéma minimal : il ne prouve pas la compatibilité hébergée.
2. Garder INVOICE_PDF_ENABLED absent/false sur les DEUX projets ; ne pas modifier les portes des e-mails actuels. Appliquer atomiquement `supabase/DRAFT-lot-order-invoice-pdf-v1.sql`. Vérifier tables, ACL, RLS, fonctions et manifeste, aucune ligne de facture.
3. Déployer le code sur les deux projets et vérifier le font tracing dans leurs builds. Ne pas ouvrir la porte à ce stade.
4. Faire valider par le commerçant/comptable les mentions de facture, notamment sa forme juridique, capital/registre si applicables, régime TVA et mentions B2B. Configurer une série explicite non réutilisée et legal_footer. V1 ne prétend pas remplacer les obligations de facturation électronique B2B. Le suivi des avoirs/remboursements n'est pas développé ici et doit être organisé avant exploitation comptable.
5. Après GO activation distinct, enregistrer la configuration du seul commerçant autorisé, puis ouvrir sa porte et INVOICE_PDF_ENABLED sur le seul projet qui doit envoyer (garder les portes de l'autre fermées). Le trigger fixe la borne ; ne pas la contourner pour réémettre l'historique.
6. Une commande réelle de validation ou un renvoi réel exigent leur propre autorisation. Vérifier le PDF, la numérotation, le destinataire, la pièce jointe reçue et la présence en back-office ; pas seulement le succès SMTP.

Exemple de configuration, volontairement NON exécutable sans remplacement et revue :

```sql
-- INSERT, gate fermée ; série unique, mentions validées pour CE vendeur.
insert into public.invoice_pdf_settings(restaurant_id,series,legal_footer)
values ('<UUID_COMMERÇANT>', '<SERIE_UNIQUE>', '<MENTIONS_VALIDEES>');
-- Seulement après GO d'activation + déploiement vérifié :
update public.invoice_pdf_settings set enabled=true where restaurant_id='<UUID_COMMERÇANT>';
```

## Retour arrière

- Fermer INVOICE_PDF_ENABLED sur les deux projets, arrêter les nouveaux crons, attendre la fin des exécutions. Aucune modification concurrente du schéma. Ne pas suspendre les confirmations de commande pour ce seul lot.
- `DRAFT-lot-order-invoice-pdf-v1-rollback.sql` : transaction et verrous, comparaison indépendante des définitions de fonctions (avec attributs/propriétaires/ACL), colonnes/contraintes/index/triggers/policies/RLS. Contrôle de consommateurs textuels tiers. Aucun CASCADE. Une dépendance référencée bloque également le DROP.
- Si une facture/trace d'envoi/blocage existe, une porte est ouverte ou le compteur a bougé : REFUS. Ne pas supprimer une facture pour rendre le rollback possible. Garder les archives et couper le worker ; restaurer le code sans purger les données.
- Une dérive ou un consommateur tiers entraîne un refus sans mutation. Le manifeste est créé à l'installation (LF/CRLF pris en compte). La requête de vérification du rollback ne fait pas confiance à la fonction de calcul elle-même.
- **R2 (audit 8c874d9)** : l'empreinte (SHA-256, identique à l'installation et dans le rollback) couvre désormais l'état d'activation des déclencheurs (`tgenabled` : un `DISABLE/ENABLE REPLICA/ENABLE ALWAYS TRIGGER` est refusé), les statistiques étendues, les règles, `reloptions`, l'identité de réplication et les commentaires de tables/colonnes. Un contrôle séparé `SCANYM_INVOICE_ROLLBACK_DEPENDENCY` refuse tout objet qui dépend des tables (statistique, règle, publication, séquence, vue, clé étrangère externe), hors contraintes/index/défauts/déclencheurs/policies propres au lot, car `DROP TABLE` supprimerait en silence les uns et échouerait pour les autres. Un objet tiers sur une table sans rapport n'empêche pas le rollback et n'est pas supprimé.
- **R2 (helper de test)** : « aucune mutation » est établi par un instantané INDÉPENDANT du catalogue (fonctions complètes, relations, colonnes, contraintes, index, défauts de colonnes (`pg_attrdef`), propriétés de colonnes (identité, génération, collation, stockage, cible de statistiques, options), déclencheurs avec `tgenabled`, statistiques, règles, policies, commentaires), recalculé avant/après, jamais par le manifeste stocké. Contrôles négatifs : modification persistée + exception, déclencheur désactivé (invisible au manifeste), `DEFAULT`/cible de statistiques/stockage/options de colonne persistés (R2bis, réaudit 95c6ebc), et refus pour une mauvaise raison. L'empreinte du rollback couvre aussi ces propriétés de colonne (identité, génération, collation, stockage, cible de statistiques, options).
- Limite : aucun script ne peut déduire tous les consommateurs de SQL dynamique construit à l'exécution. Fenêtre sans DDL et revue opérateur des consommateurs obligatoires. Pas de promesse contre un administrateur qui modifierait volontairement le manifeste et les objets.

## Audit demandé

- PostgreSQL natif : deux connexions concurrentes pour numérotation, première persistance du PDF et claim ; RLS/ACL sous vrais rôles ; rollback nominal, dérives des fonctions/contraintes/ACL/propriétaires/consommateurs et CRLF.
- Vrais types et privilèges Supabase/PostgREST, frais et TVA mixtes, régime légal vendeur, cohérence des sources historiques et des arrondis ; aucune facture fabriquée depuis des données manquantes.
- Navigateur réel : téléchargement/impression, langues boutons, mobile, changement d'établissement pendant une requête et renvoi HTTP incertain.
- Interception SMTP locale : PDF MIME décodable identique à l'archive, aucun doublon après finalisation perdue, refus/exception/expiration de session, rattachement strict au bon établissement.
- Pas d'activation ni de message réel pendant l'audit, sans GO explicite.

## Vérifications auteur

Sur la base main dcdf084a31d296430cf1bdc20b2318ec39c5cca1 :
- 186/186 tests runtime/UI/voisins (17 fichiers), dont 51 tests dédiés hors SQL.
- 17/17 tests SQL PGlite : source, idempotence, compteurs, immutabilité, claim, jeton de finalisation, borne d'activation, blocages de données, rollback nominal/dérives/consommateurs/CRLF. Ce n'est PAS PostgreSQL natif ni une preuve de concurrence à deux connexions.
- 4 mutations détectées par échec d'assertion : contrôle destinataire, porte fermée, perte de pièce jointe dans le fournisseur, fausse réussite après perte de finalisation. Fichiers restaurés puis lot ciblé rejoué.
- TypeScript et next build réussis. Police embarquée présente dans les traces des deux routes serveur.
- 4 sondes HTTP sur build de production local : cron sans autorisation 401, cron autorisé mais fermé 200 disabled, archive sans session 403, préparation désactivée 503. Valeurs d'environnement synthétiques et aucune connexion métier.
- PDF synthétique A4 vérifié avec Poppler : une page pour une ligne ; six pages pour 65 produits longs, dernière ligne/total/pagination présents. Première et dernière pages inspectées visuellement.
- Exemple fictif : docs/examples/order-invoice-pdf-v1-demo.pdf. Ne pas l'utiliser comme pièce comptable.
- Non exécutés : suite complète, navigateur réel, PostgreSQL natif, Supabase hébergé, SMTP IONOS réel. Aucune activation ou donnée réelle.
