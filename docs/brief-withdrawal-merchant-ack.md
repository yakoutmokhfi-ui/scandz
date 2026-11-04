# Accusés de rétractation — mandat de développement

État : consigne initiale, aucun correctif livré.

## Décision produit

Utiliser la messagerie configurée par chaque commerçant pour adresser au client l'accusé de sa demande de rétractation, avec une copie au commerçant. Au Lait Cru souhaite utiliser contact@aulaitcru.com ; cette adresse est un exemple de configuration, pas une constante du code.

## Travail demandé à Boulez

- Cartographier les chemins existants de déclaration, d'accusé, de notification et de configuration SMTP marchande, ainsi que les textes et CGV existants ; documenter les changements éventuels nécessaires.
- Préserver la déclaration même en cas d'échec d'envoi ; afficher un état honnête fondé sur le résultat réel. La page commerçant reste accessible et isolée par établissement.
- Définir et tester les gardes d'activation, d'isolation, de concurrence, d'idempotence et de reprise. Ne pas en déduire qu'un message est livré à partir de la seule acceptation SMTP.
- Examiner les demandes antérieures sans accusé ; ne pas les envoyer automatiquement. Documenter une éventuelle procédure de reprise distincte.
- Fournir si nécessaire SQL et rollback en brouillon, avec contrôles d'identité, prévol et preuve sur base jetable. Aucun changement de production.
- Tester l'envoi au fournisseur intercepté, les échecs, la reprise, les doublons, les changements de commerçant, la confidentialité et les configurations absentes. Fournir preuve négative, tests ciblés, TypeScript et build ; ne pas lancer de suite complète sans risque précis.
- Donner SHA, arbre, limites, ordre de mise en service et demander audit indépendant. Aucun secret, e-mail réel, SQL hébergé, merge ou déploiement.
