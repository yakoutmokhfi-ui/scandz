# Factures manuelles — modèle marchand A4

## Demande et portée

Évolution de #225 sur main `f1722ca0b3ea4ae34db762d3e6433c382b112922`.
Le modèle fourni par Emmanuel sert de référence de mise en page. Le fichier Pages et ses données de client ne sont pas ajoutés au dépôt.

- Sur une commande payée avec demande de facture : **Générer la facture**, puis **Envoyer par e-mail**. Le premier clic télécharge le PDF pour relecture. Après génération, il devient **Télécharger** ; **Ouvrir / imprimer** reste disponible.
- Le destinataire est celui de la source de facturation archivée. Il est affiché et repris dans la confirmation d'envoi. Le navigateur ne peut pas fournir une autre adresse.
- La génération ne soumet aucun message. L'envoi refuse de générer implicitement un document : une archive PDF doit déjà exister.
- Le numéro et le PDF sont réutilisés à l'identique. Aucun ancien document n'est régénéré pour modifier son apparence.
- L'historique du dernier envoi est relu depuis `invoice_pdf_deliveries` : état et date. `accepted` signifie acceptation SMTP, jamais réception dans la boîte du client. Une lecture impossible de cet historique est une erreur, pas un faux état « jamais envoyé ».
- Un essai HTTP incertain garde sa clé, y compris après `already_claimed`. Une nouvelle demande après un résultat terminal reste une action explicite confirmée. Un rechargement peut perdre cette clé locale : le dernier état serveur et l'avertissement avant tout renvoi restent affichés ; pas de garantie universelle d'envoi exactement une fois.

## Modèle partagé et identité de chaque établissement

Structure A4 noir/gris : logo/contact à gauche, numéro/dates/référence commande à droite, blocs Émetteur et Facturé à, tableau désignation/quantité/PU HT/TVA/total HT, totaux HT/TVA/TTC et mentions vendeur.

- Identité juridique, facturation, prix et TVA : source historique déjà utilisée par #225. Aucun changement d'arithmétique ni de source fiscale.
- Logo et téléphone : réglages existants `restaurant_configs`, lus uniquement pour le restaurant de la facture lors du premier rendu. Ils sont ensuite figés dans les octets du PDF archivé.
- Logo PNG/JPEG du bucket `establishment-assets`, chemin strict `{restaurantId}/logo/{fichier}` du projet configuré ; aucun téléchargement d'une URL arbitraire. Taille maximale 512 Ko et dimensions maximales 2000 × 2000. Pas de SVG, pas de lien externe PDF. Un logo absent, WebP, invalide ou indisponible donne une identité textuelle de repli.
- Pas de logo ni d'adresse Au Lait Cru codé en dur, pas de reprise des données de la facture exemple.
- Pas d'unité physique (kg, litre) inventée lorsque l'instantané ne la contient pas ; l'option historique reste dans la désignation. Pas de date d'échéance/livraison inventée. Les factures déjà acquittées indiquent le paiement confirmé.
- Périmètre fiscal de #225 inchangé : commerçant FR assujetti à TVA, EUR, paiement en ligne confirmé et instantanés complets. Ce lot ne généralise pas les régimes fiscaux aux autres pays. Il ne crée pas non plus de mécanisme d'avoirs.

## Arrêt du chemin automatique

- Le cron `/api/internal/invoices/send` est retiré de `vercel.json`.
- Son ancien point d'entrée reste authentifié et répond `manual_only`, même lorsque les portes sont ouvertes.
- `runInvoiceWorker` est également inerte : aucun candidat, numéro, PDF ou message.
- Les crons de notifications de commande et Monetico sont inchangés.
- Aucun SQL n'est modifié par ce lot. Les tables/RPC, leurs droits, gardes d'archive et mécanismes de numérotation de #225 restent intacts.

## Mise en service et retour arrière

Ce développement n'applique pas de SQL, ne modifie aucune porte hébergée, ne crée aucune commande et n'envoie aucun e-mail réel.

Avant déploiement : vérifier les deux projets, les réglages #225, le destinataire figé, le logo de l'établissement et les rôles réels. Arrêter les invocations de l'ancien cron de factures sur les deux projets et laisser finir les exécutions déjà parties ; retirer une planification ne peut pas annuler une exécution de l'ancien code. Puis déployer les deux projets et vérifier que l'ancien endpoint répond `manual_only` avec une autorisation valide. Aucun renvoi historique implicite.

Un rollback du code vers #225 réintroduirait l'envoi automatique si ses portes restent ouvertes : fermer `INVOICE_PDF_ENABLED` sur les deux projets et arrêter les crons factures avant ce rollback. Conserver les factures et les traces. Pas de suppression ni renumérotation pour revenir en arrière.

## Rejeu et limites

Tests ciblés :

```sh
node --experimental-strip-types --import ./tests/register.mjs --test tests/invoice-branding.test.ts tests/invoice-pdf-actions.dom.test.ts tests/invoice-pdf-cron.test.ts tests/invoice-pdf-model.test.ts tests/invoice-pdf-render.test.ts tests/invoice-pdf-route.test.ts tests/invoice-pdf-service.test.ts tests/invoice-pdf-mime.test.ts
```

Les tests DOM utilisent le vrai composant avec authentification et HTTP synthétiques. Les tests de route vérifient les autorisations avant accès privilégié ; le PDF est réellement produit par PDFKit. Les fournisseurs SMTP sont interceptés. Le schéma SQL existant n'est pas modifié.

Lancement de Chromium local tenté : bloqué au démarrage par `socket() failed: Operation not permitted` (process singleton). Ne pas présenter les tests DOM comme un navigateur réel. L'auditeur doit rejouer le parcours dans un vrai navigateur, la vraie session Supabase et sur le Mac d'impression.

Contrôles PDF : modèle synthétique ordinaire et commande de 65 articles longs, rendu avec Poppler et inspection de chaque page. Le modèle fourni est une référence visuelle, pas une promesse de conformité comptable universelle. Aucun envoi réel ni impression physique n'est prouvé par ces essais.

### Bilan auteur

- 78/78 tests ciblés et voisins sur 11 fichiers, aucun ignoré/annulé ; `tsc --noEmit` et build Next réussis avec environnement synthétique.
- Contrôle négatif sur la base exacte : nouveaux tests du cron manuel et du logo, 5 PASS / 4 FAIL ; les quatre nouveaux comportements échouent sur l'ancienne version. Les PDF générés pour les tests ne contiennent que des données synthétiques.
- Exemple : `docs/examples/manual-invoice-merchant-template-demo.pdf`, avec logo fictif. Le fichier utilisateur, son logo et les coordonnées de son client ne sont pas publiés.
- Tests existants actualisés : le cron doit être absent/inactif ; le composant charge maintenant un statut en lecture seule, puis permet génération et envoi distincts. Les gardes d'accès, d'immutabilité, de contenu MIME et de finalisation SMTP restent testées.
- Premier build sans variables : échec de collecte des pages pour configuration Supabase absente. Build rejoué avec valeurs synthétiques : réussite. Aucun secret de production n'a été chargé.
