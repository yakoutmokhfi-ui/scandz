/**
 * Validation des URLs de réseaux sociaux (LOT 1A).
 *
 * MÊME CONTRAT que la validation SQL (update_restaurant_social_links,
 * supabase/migration-v80-lot1a-identity-social-languages.sql) --
 * jamais une regex divergente maintenue séparément. Cette validation
 * côté client sert uniquement à donner un retour immédiat avant tout
 * appel réseau ; la validation SQL reste la seule qui compte pour la
 * sécurité (jamais de confiance dans le seul frontend).
 */

export const INSTAGRAM_URL_RE = /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._]{1,30}\/?$/;
export const TIKTOK_URL_RE = /^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]{1,30}\/?$/;
export const FACEBOOK_URL_RE = /^https:\/\/(www\.)?facebook\.com\/[A-Za-z0-9.]{1,50}\/?$/;

export function isValidInstagramUrl(raw: string): boolean {
  return INSTAGRAM_URL_RE.test(raw);
}

export function isValidTiktokUrl(raw: string): boolean {
  return TIKTOK_URL_RE.test(raw);
}

export function isValidFacebookUrl(raw: string): boolean {
  return FACEBOOK_URL_RE.test(raw);
}
