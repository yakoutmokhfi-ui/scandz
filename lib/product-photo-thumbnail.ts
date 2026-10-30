// Issue #188 — vignettes des photos produit via les transformations
// d'images Supabase Storage. Les ORIGINAUX ne sont jamais modifiés :
// seule l'URL d'affichage change (endpoint /render/image, calculé à
// la volée côté Supabase, WebP automatique selon le navigateur).
//
// Désactivé par défaut : actif seulement si
// NEXT_PUBLIC_PRODUCT_PHOTO_THUMBNAILS === "1" (activation en
// production = décision distincte, après vérification du quota Pro :
// 100 images d'origine incluses/cycle, puis 5 $ / 1000).

export const THUMBNAIL_WIDTH_CARD = 256; // cartes affichées à 96-112 px (x2 écrans denses)
export const THUMBNAIL_WIDTH_WIDE = 384; // bandeau de la fenêtre pâtisserie (pleine largeur)
export const THUMBNAIL_QUALITY = 70;

const OBJECT_MARKER = "/storage/v1/object/public/";
const RENDER_MARKER = "/storage/v1/render/image/public/";

export function thumbnailsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PRODUCT_PHOTO_THUMBNAILS === "1";
}

/**
 * URL de vignette d'une photo du stockage Supabase, ou l'URL d'origine
 * inchangée si les vignettes sont désactivées ou si l'URL n'est pas
 * une URL publique de stockage (photo externe, chemin local, etc.).
 */
export function productPhotoThumbnailUrl(
  url: string,
  width: number = THUMBNAIL_WIDTH_CARD,
  enabled: boolean = thumbnailsEnabled()
): string {
  if (!enabled) return url;
  const idx = url.indexOf(OBJECT_MARKER);
  if (idx === -1) return url;
  const base = url.slice(0, idx) + RENDER_MARKER + url.slice(idx + OBJECT_MARKER.length);
  if (base.includes("?")) return url;
  // Carré explicite : avec `width` seul, Supabase conserve la hauteur
  // d'origine et découpe une lamelle (constaté sur une vraie photo,
  // issue #188). Les cases d'affichage recadrent déjà le centre
  // (object-cover) : un carré centré donne le même rendu.
  return `${base}?width=${width}&height=${width}&quality=${THUMBNAIL_QUALITY}&resize=cover`;
}
