/**
 * Scanym — STOREFRONT PHOTO OVERLAY CONFIGURATION v1.
 *
 * Réglage PAR ÉTABLISSEMENT du voile sombre posé sur la photo principale
 * de la vitrine (restaurant_configs.storefront_photo_overlay).
 *
 * D'où vient l'assombrissement (investigation) : un `linear-gradient`
 * EMPILÉ au-dessus de l'image dans le `backgroundImage` du <header> de
 * components/RestaurantHeader.tsx -- teinte « ink » du thème, alpha
 * 0,20 -> 0,32 de haut en bas (variables --sc-veil-soft/--sc-veil-strong
 * de lib/themes.ts). Ni opacité, ni traitement d'image. Les panneaux
 * opaques (titre, langues, infos) sont d'AUTRES éléments, non concernés.
 *
 * Valeurs (jeu FERMÉ) :
 *   - "standard" : le voile historique, octet pour octet (références aux
 *                  variables de thème, repli rgba(23,13,9,…)) ;
 *   - "light"    : même teinte, environ 40 % de l'intensité ;
 *   - "none"     : aucun voile, la photo est affichée telle quelle.
 *
 * SÛRETÉ DE REPLI : toute valeur absente, inconnue ou non textuelle
 * (colonne pas encore appliquée, donnée corrompue) donne "standard",
 * c'est-à-dire EXACTEMENT le rendu d'avant ce lot. Aucun marchand n'est
 * nommé ici : la configuration est générique.
 *
 * DÉFAUT PAR LA BASE (voir le DRAFT SQL) : les lignes existantes sont
 * remplies avec "standard" ; les nouvelles lignes reçoivent "none".
 */
import { isValidHexColor } from "@/lib/color-contrast";

export const STOREFRONT_PHOTO_OVERLAY_VALUES = ["none", "light", "standard"] as const;
export type StorefrontPhotoOverlay = (typeof STOREFRONT_PHOTO_OVERLAY_VALUES)[number];

/** Repli de LECTURE : le rendu historique. Distinct du défaut d'un NOUVEAU marchand ("none", porté par la base). */
export const LEGACY_STOREFRONT_PHOTO_OVERLAY: StorefrontPhotoOverlay = "standard";

/** Teinte de repli du voile (identique au repli historique rgba(23,13,9,…)). */
const FALLBACK_INK_RGB: readonly [number, number, number] = [23, 13, 9];

/** Alpha (haut, bas) de chaque voile. "standard" DOIT rester égal à lib/themes.ts (un test le garde). */
export const PHOTO_OVERLAY_ALPHA = {
  standard: [0.2, 0.32],
  light: [0.08, 0.13],
} as const;

export function isStorefrontPhotoOverlay(value: unknown): value is StorefrontPhotoOverlay {
  return typeof value === "string" && (STOREFRONT_PHOTO_OVERLAY_VALUES as readonly string[]).includes(value);
}

/** Lecture TOLÉRANTE : jamais d'exception, valeur inconnue -> "standard". */
export function normalizeStorefrontPhotoOverlay(raw: unknown): StorefrontPhotoOverlay {
  return isStorefrontPhotoOverlay(raw) ? raw : LEGACY_STOREFRONT_PHOTO_OVERLAY;
}

function inkRgb(ink: string | null | undefined): readonly [number, number, number] {
  if (typeof ink !== "string" || !isValidHexColor(ink)) return FALLBACK_INK_RGB;
  const h = ink.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as [number, number, number];
}

/**
 * Couche de dégradé à empiler SOUS les panneaux, AU-DESSUS de la photo,
 * ou `null` quand aucun voile ne doit être posé.
 *
 * "standard" renvoie la chaîne HISTORIQUE (variables de thème + repli) :
 * le rendu des marchands existants ne dépend d'aucun calcul nouveau.
 * "light" calcule la teinte à partir de la même couleur « ink » que le
 * thème (`ink`), repli sur la teinte historique si elle est invalide.
 */
export function photoOverlayLayer(mode: StorefrontPhotoOverlay, ink?: string | null): string | null {
  if (mode === "none") return null;
  if (mode === "standard") {
    return "linear-gradient(var(--sc-veil-soft, rgba(23,13,9,0.2)), var(--sc-veil-strong, rgba(23,13,9,0.32)))";
  }
  const [r, g, b] = inkRgb(ink);
  const [top, bottom] = PHOTO_OVERLAY_ALPHA.light;
  return `linear-gradient(rgba(${r}, ${g}, ${b}, ${top}), rgba(${r}, ${g}, ${b}, ${bottom}))`;
}

/**
 * Même couche avec des valeurs EXPLICITES (sans variable CSS), pour
 * l'aperçu du back-office, où les variables de thème de la vitrine ne
 * sont pas définies.
 */
export function photoOverlayLayerResolved(mode: StorefrontPhotoOverlay, ink?: string | null): string | null {
  if (mode === "none") return null;
  const [r, g, b] = inkRgb(ink);
  const [top, bottom] = PHOTO_OVERLAY_ALPHA[mode];
  return `linear-gradient(rgba(${r}, ${g}, ${b}, ${top}), rgba(${r}, ${g}, ${b}, ${bottom}))`;
}

/** `backgroundImage` du header : [voile,] photo. "standard" = chaîne historique à l'identique. */
export function headerBackgroundImage(
  mode: StorefrontPhotoOverlay,
  imageUrl: string,
  ink?: string | null
): string {
  const layer = photoOverlayLayer(mode, ink);
  const photo = `url('${imageUrl}')`;
  return layer ? `${layer}, ${photo}` : photo;
}
