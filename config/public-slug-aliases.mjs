// Données de routage public (issue #159) — SOURCE UNIQUE partagée par :
//   - next.config.mjs            : règles de réécriture `/{slug}` -> `/r/{slug}` ;
//   - lib/public-menu-url.ts     : URL publique définitive affichée/ouverte
//                                  par le back-office (« Voir le menu », cockpit).
// Ce fichier est de la CONFIGURATION (comme next.config.mjs), pas du code
// applicatif : aucune branche métier ne nomme de marchand dans lib/,
// components/ ou app/ (garde [NO-HARDCODE]).
//
// Ajouter un marchand = UNE entrée dans PUBLIC_SLUG_ALIASES (+ le test).
// L'hôte est celui dont le CNAME est déjà configuré ; ce fichier ne
// touche ni au DNS ni à la configuration de domaine Vercel.

/** Origine publique définitive des menus à URL courte. */
export const PUBLIC_MENU_HOST = "https://shop.scanym.com";

/** Slugs servis à la racine (`/{slug}`) en plus de `/r/{slug}`. */
export const PUBLIC_SLUG_ALIASES = Object.freeze(["au-lait-cru"]);
