# Traduction des tags de la vitrine

Cette consigne prépare le développement. La fonctionnalité et ses tests restent à réaliser sur cette branche.

## Besoin
Permettre au commerçant de traduire les tags affichés aux clients, par exemple « Pasteurisé », « Bretagne », « Truffe » et « Bio », dans les langues actives de sa boutique. Les noms sont propres à chaque commerçant et ne doivent pas être codés en dur.

## Investigation
Examiner d'abord le modèle réel des tags, les collections et leur affichage dans la vitrine, les fiches produit, le filtre, les traductions validées, l'import/export Excel et les règles d'accès au catalogue public. Réutiliser le mécanisme existant lorsqu'il est adapté et documenter toute limite. Vérifier si une fonctionnalité existante couvre déjà le besoin avant d'en créer une nouvelle.

## Attendus
- Rendre le libellé du tag traduisible dans « Langues & traductions », avec les langues actives par établissement et le cycle de validation existant.
- Afficher la traduction validée courante dans le filtre et sur les fiches produit ; si absente ou périmée, afficher le libellé source. Les filtres restent fondés sur l'identité stable du tag, jamais sur le texte traduit.
- Couvrir l'import/export Excel si la structure existante le permet, le texte source modifié, les langues FR/EN/AR/NL, le retour à la langue source, l'absence de traduction, la recherche de produits en cours et l'isolation entre établissements.
- Si une migration est nécessaire, fournir précontrôles, permissions, tests en base jetable et rollback documenté ; ne pas appliquer de SQL hébergé.

## Livraison
Développer sur cette branche, fournir les tests ciblés, TypeScript, build et les limites, puis demander un audit indépendant. Cette PR est en brouillon ; aucun merge, déploiement, SQL hébergé ou modification de données réelles.
