# UX LOT 2026-10 — preuve navigateur réel (Chromium / Playwright)

Retour de vérification en production (PR #166) : les retouches « centrage de la
liste des tags » et « Comment commander ? ouvert en haut » étaient présentes dans
le code mais **non conformes à l'écran**. Cause : mauvais éléments visés.

| Défaut constaté | Élément réellement visé | Correctif |
|---|---|---|
| Liste alignée à gauche | `components/CollectionNav.tsx` (rangée **Collections** sous l'en-tête : Bio / Bretagne / Pasteurisé / Truffe) — pas les pastilles des cartes produit | `w-fit mx-auto max-w-full` sur la rangée : centrée quand elle tient, défilante depuis la gauche quand elle déborde |
| Fenêtre ouverte en bas | `components/DeliveryConditions.tsx` (`DeliveryDialog`, titre i18n `deliveryConditionsTitle`) — pas `OrderHelpButton` (Au Lait Cru n'a aucun texte MCC) | plus d'`autoFocus` sur « Fermer » ; `scrollTop = 0` + focus sur le titre à l'ouverture |

Script : `node scripts/ux-real-browser-check.mjs` (après `next build`). Il monte les
composants réels avec la CSS de production dans Chromium, mesure à 390 / 768 /
1280 px et échoue si la rangée n'est pas centrée (marges gauche/droite égales à
1 px près), si une rangée débordante masque sa première pastille, ou si le
dialogue ne s'ouvre pas en haut avec le focus sur le titre.

Mesures (390 px) :

| | avant (`main` 8a51783) | après |
|---|---|---|
| Collections : marge gauche / droite | 0 / 26,7 px | 13,3 / 13,3 px |
| Collections (12, débordante) : 1re pastille visible, scrollLeft | oui, 0 | oui, 0 |
| Pastilles produit (ProductTags) | 7,1 / 7,1 px (déjà centrées) | 7,1 / 7,1 px |
| Dialogue : scrollTop à l'ouverture | **1279** (bas) | **0** |
| Dialogue : titre visible / focus | non / « Fermer » | oui / titre |

Captures : `before-main-8a51783-*.png` et `after-*.png` (390 et 768 px) ; mesures
complètes après correctif : `after-measures.json`. Données synthétiques, aucun
accès réseau, aucune commande.
