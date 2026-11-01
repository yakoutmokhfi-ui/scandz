# Recherche de produits dans la vitrine — issue #169

Responsable : Boulez. Livrable : implémentation sur cette branche et PR en brouillon pour audit indépendant. Ce document est une consigne ; la fonctionnalité reste à développer.

## Besoin
Permettre aux clients de rechercher rapidement un produit par son nom dans le catalogue de l'établissement affiché, sur mobile et ordinateur.

## Attendus
- Recherche limitée à l'établissement courant ; filtrage sans distinction de casse ni d'accents lorsque les données le permettent.
- Résultats lisibles, message si aucun résultat, effacement simple de la recherche et libellés traduits FR/EN/AR/NL. Préciser et tester le comportement combiné avec catégories, sous-catégories et tags, sans perdre le panier.
- Respecter les modes de vente, options, produits archivés et règles de disponibilité existants. Les informations retournées ne doivent pas exposer d'autres établissements ni de données privées.
- Coordonner avec la PR de Marie Curie sur les ruptures : la recherche respecte le réglage de visibilité des produits indisponibles ; préparer un test combiné après disponibilité des deux branches.
- Examiner performance et photos différées pour les grands catalogues. N'ajouter aucune dépendance externe ou modification de schéma sans justification et migration documentée si nécessaire.

## Livraison et contrôle
Partir du main courant, développer sur cette branche, ajouter des tests ciblés réels du parcours, contrôle TypeScript et build. Tester notamment accents, absence de résultat, filtres, panier et isolation entre établissements ; signaler les échecs préexistants avec leur base. Publier le SHA et les limites pour audit indépendant. Aucun merge, déploiement, SQL hébergé, commande ou paiement réel durant ce travail.
