import { PUBLIC_MENU_HOST, PUBLIC_SLUG_ALIASES } from "../config/public-slug-aliases.mjs";

/**
 * URL publique d'un menu (issue #159, suite de la PR #161).
 *
 * Source de vérité UNIQUE « slug -> URL publique définitive » pour les
 * liens du back-office (bouton « Voir le menu » du tableau de bord,
 * URL publique du cockpit marchand). Aucun test `slug === "..."` dans
 * les composants (cf. components/MenuView.tsx) : un composant appelle
 * cette fonction et reçoit l'URL à ouvrir.
 *
 * - Marchand ayant une URL définitive (alias de
 *   config/public-slug-aliases.mjs) : cette URL absolue (indépendante du domaine depuis lequel le back-office est
 *   consulté).
 * - Tout autre marchand : comportement historique inchangé,
 *   `{origin}/r/{slug}` (relatif quand `origin` est vide).
 *
 * `/r/{slug}` reste servi pour TOUS les marchands, Au Lait Cru
 * compris : seule la destination du lien du back-office change, aucune
 * route n'est touchée. Ajouter un marchand = UNE entrée dans
 * `PUBLIC_SLUG_ALIASES` : la même liste pilote la règle de réécriture
 * (next.config.mjs) et l'URL du back-office, donc un lien définitif ne
 * peut pas exister sans sa route.
 */
// Données dans config/public-slug-aliases.mjs (configuration partagée
// avec next.config.mjs) : ce module ne nomme aucun marchand.
export { PUBLIC_MENU_HOST };

/** slug -> URL publique définitive, dérivée de la liste d'alias. */
export const PUBLIC_MENU_URLS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    PUBLIC_SLUG_ALIASES.map((slug) => [slug, `${PUBLIC_MENU_HOST}/${slug}`])
  )
);

/**
 * @param slug   slug du marchand (bordures nettoyées ; vide -> `null`).
 * @param origin origine à préfixer pour les marchands sans URL
 *               définitive ("" = lien relatif `/r/{slug}`).
 */
export function publicMenuUrlForSlug(
  slug: string | null | undefined,
  origin = ""
): string | null {
  if (typeof slug !== "string") return null;
  const normalizedSlug = slug.trim();
  if (!normalizedSlug) return null;
  // Object.hasOwn : un slug comme "constructor" ou "__proto__" ne doit
  // jamais retrouver une propriété héritée de l'objet.
  if (Object.hasOwn(PUBLIC_MENU_URLS, normalizedSlug)) {
    return PUBLIC_MENU_URLS[normalizedSlug];
  }
  return `${origin}/r/${encodeURIComponent(normalizedSlug)}`;
}
