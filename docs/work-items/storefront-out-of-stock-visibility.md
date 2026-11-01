# Produits en rupture dans la vitrine

Responsable : Marie Curie. Livrable : implémentation sur cette branche et PR en brouillon pour audit indépendant. Ce document est une consigne ; la fonctionnalité reste à développer.

## Besoin
Permettre à chaque commerçant de choisir si les produits indisponibles restent visibles en vitrine. S'ils sont affichés, le client voit « En rupture » et ne peut pas les ajouter au panier. Le choix est propre à chaque établissement.

## Attendus
- Examiner d'abord la différence entre indisponible, archivé et supprimé, le catalogue public et les validations serveur. Préserver la confidentialité et l'isolation des établissements.
- Ajouter un réglage compréhensible dans le back-office pour le propriétaire/gérant. Par défaut préserver le comportement actuel de chaque établissement ; ne modifier aucune donnée de production.
- Afficher clairement la rupture en FR/EN/AR/NL, retirer ou désactiver l'ajout et empêcher aussi toute commande forgée côté serveur avec un produit indisponible. Un produit archivé reste exclu.
- Vérifier l'effet d'un passage en rupture sur un panier déjà chargé et sur sa restauration après actualisation (#199) : le client reçoit un message clair et ne peut pas commander l'article indisponible.
- Coordonner avec Boulez : les résultats de recherche respectent ce réglage. Préparer une validation combinée quand les deux branches seront disponibles.
- Si le modèle exige une migration, livrer SQL, contrôle préalable et retour arrière documentés, avec isolation des données et tests en base jetable. Aucun SQL hébergé durant ce travail.

## Livraison et contrôle
Partir du main courant, développer sur cette branche, ajouter des tests ciblés vitrine, back-office, serveur et multi-établissements, puis TypeScript et build. Signaler les échecs préexistants avec leur base. Publier le SHA et les limites pour audit indépendant. Aucun merge, déploiement, SQL hébergé, commande ou paiement réel durant ce travail.
