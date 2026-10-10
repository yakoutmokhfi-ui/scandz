/**
 * Scanym — THEME & CONTENT SETTINGS v1 — jetons de surface configurables.
 *
 * Logique PURE (aucun réseau, aucun React, aucune dépendance Supabase).
 *
 * CE QUE CE MODULE EST, ET CE QU'IL N'EST PAS
 * -------------------------------------------
 * Il ne crée PAS un second système de thème. Le thème de la vitrine reste
 * `lib/themes.ts` (+ les quatre couleurs déjà portées par
 * `restaurant_configs` : primary_color / secondary_color / accent_color /
 * bg_color). Ce module n'ajoute que ce que ces quatre couleurs ne
 * couvrent pas : la couleur de TROIS surfaces d'information qui, pour
 * certains commerçants, doivent se détacher du fond de page (ex. un fond
 * de page sombre avec un panneau adresse/horaires blanc à texte noir).
 *
 * Couverture du mandat (aucun doublon avec l'existant) :
 *
 *   fond principal ...................... EXISTANT  bg_color
 *   texte principal / secondaire (page) . EXISTANT  dérivés de ink/bg
 *                                         (--sc-ink-on-bg, --sc-ink-on-bg-muted)
 *   accent / or ......................... EXISTANT  accent_color (--sc-highlight)
 *   fond de bouton ...................... EXISTANT  primary_color (--sc-accent)
 *   texte de bouton ..................... EXISTANT  TOUJOURS calculé
 *                                         (--sc-accent-text) : volontairement
 *                                         non configurable, voir V70-03 dans
 *                                         lib/themes.ts -- un texte de bouton
 *                                         choisi à la main peut devenir
 *                                         illisible, un texte calculé non.
 *   panneau adresse / horaires .......... NOUVEAU   info_panel_bg / info_panel_text
 *   popup d'information ................. NOUVEAU   popup_bg / popup_text
 *   cartes tarifs de livraison .......... NOUVEAU   delivery_card_bg / delivery_card_text
 *   bordure de ces surfaces ............. NOUVEAU   surface_border
 *   texte SECONDAIRE d'une surface ...... DÉRIVÉ    mutedOnBg(texte, fond) --
 *                                         jamais saisi, donc jamais illisible.
 *
 * SÛRETÉ (mandat §D) : valeurs TYPÉES, jamais du CSS, du HTML, une URL ou
 * du JavaScript. Un jeton est exactement `#RRGGBB`. Le jeu de clés est
 * FERMÉ : une clé inconnue est refusée à l'écriture et ignorée à la
 * lecture. Un fond et son texte vont TOUJOURS ensemble (une paire
 * incomplète est refusée) et leur contraste WCAG doit atteindre 4,5:1 :
 * c'est ce qui garantit qu'une configuration valide ne peut pas rendre une
 * surface illisible.
 *
 * DÉFAUT (mandat §F) : absence de configuration = AUCUNE variable posée,
 * AUCUN attribut posé -> les règles CSS de ce lot ne s'appliquent pas ->
 * rendu strictement identique à avant.
 */

import {
  contrastRatio,
  isValidHexColor,
  mutedOnBg,
  readableAccentOnBg,
} from "@/lib/color-contrast";

/** Jeu FERMÉ de jetons. Ordre = ordre du formulaire back-office. */
export const THEME_TOKEN_KEYS = [
  "info_panel_bg",
  "info_panel_text",
  "popup_bg",
  "popup_text",
  "delivery_card_bg",
  "delivery_card_text",
  "surface_border",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

/** Jetons sains : sous-ensemble des clés, valeurs `#RRGGBB` majuscules. */
export type ThemeTokens = Partial<Record<ThemeTokenKey, string>>;

/** Ratio de contraste WCAG minimal fond/texte d'une surface (AA, texte courant). */
export const THEME_TOKEN_MIN_CONTRAST = 4.5;

export type ThemeSurface = "info-panel" | "popup" | "delivery-card";

/** Les trois surfaces et leurs deux jetons. Source UNIQUE des paires. */
export const THEME_SURFACES: ReadonlyArray<{
  readonly surface: ThemeSurface;
  readonly bg: ThemeTokenKey;
  readonly text: ThemeTokenKey;
  /** Préfixe des variables CSS posées pour cette surface. */
  readonly cssPrefix: string;
  /**
   * Couleur d'accent du thème que la surface affiche DÉJÀ aujourd'hui en
   * texte d'accent, à ramener à un contraste lisible contre son nouveau
   * fond : le panneau adresse/horaires affiche ses libellés et icônes en
   * « laiton » (--sc-highlight), les fenêtres et cartes leurs liens en
   * « accent foncé » (--sc-accent-dark). Le choix reproduit l'existant.
   */
  readonly accent: "highlight" | "accentDark";
  /** La surface affiche un texte SECONDAIRE (text-ink-on-bg-muted) à dériver. */
  readonly hasMutedText: boolean;
}> = [
  { surface: "info-panel", bg: "info_panel_bg", text: "info_panel_text", cssPrefix: "--sc-info-panel", accent: "highlight", hasMutedText: false },
  { surface: "popup", bg: "popup_bg", text: "popup_text", cssPrefix: "--sc-popup", accent: "accentDark", hasMutedText: true },
  { surface: "delivery-card", bg: "delivery_card_bg", text: "delivery_card_text", cssPrefix: "--sc-delivery-card", accent: "accentDark", hasMutedText: true },
];

export function isThemeTokenKey(value: unknown): value is ThemeTokenKey {
  return typeof value === "string" && (THEME_TOKEN_KEYS as readonly string[]).includes(value);
}

export type ThemeTokenErrorCode =
  | "UNKNOWN_KEY"
  | "INVALID_COLOR"
  | "PAIR_INCOMPLETE"
  | "LOW_CONTRAST"
  | "NOT_AN_OBJECT";

export interface ThemeTokenError {
  readonly key: string;
  readonly code: ThemeTokenErrorCode;
}

export type ThemeTokensValidation =
  | { readonly ok: true; readonly tokens: ThemeTokens }
  | { readonly ok: false; readonly errors: readonly ThemeTokenError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validation STRICTE (chemin d'écriture : formulaire et miroir du RPC SQL).
 *
 *   - `null` / `undefined` / `{}`  -> valide, aucun jeton (= « par défaut ») ;
 *   - valeur `null` ou chaîne vide pour une clé -> clé ABSENTE (réinitialisation) ;
 *   - clé hors catalogue -> UNKNOWN_KEY ;
 *   - valeur non chaîne, ou chaîne autre que `#RRGGBB` exact (pas de
 *     blancs, pas de forme courte, pas de nom CSS, pas de rgb()/url()/
 *     expression) -> INVALID_COLOR ;
 *   - fond sans texte (ou l'inverse) -> PAIR_INCOMPLETE sur la clé manquante ;
 *   - contraste fond/texte < 4,5 -> LOW_CONTRAST sur la clé de texte.
 *
 * Seules les propriétés PROPRES sont lues. L'entrée n'est jamais modifiée.
 */
export function validateThemeTokens(raw: unknown): ThemeTokensValidation {
  if (raw === null || raw === undefined) return { ok: true, tokens: {} };
  if (!isPlainObject(raw)) return { ok: false, errors: [{ key: "*", code: "NOT_AN_OBJECT" }] };

  const errors: ThemeTokenError[] = [];
  const tokens: ThemeTokens = {};

  for (const key of Object.keys(raw)) {
    if (!isThemeTokenKey(key)) {
      errors.push({ key, code: "UNKNOWN_KEY" });
      continue;
    }
    const value = raw[key];
    if (value === null || value === "") continue;
    if (typeof value !== "string" || !isValidHexColor(value)) {
      errors.push({ key, code: "INVALID_COLOR" });
      continue;
    }
    tokens[key] = value.toUpperCase();
  }

  for (const { bg, text } of THEME_SURFACES) {
    const hasBg = tokens[bg] !== undefined;
    const hasText = tokens[text] !== undefined;
    const alreadyInvalid = (k: string) => errors.some((e) => e.key === k);
    if (hasBg && !hasText && !alreadyInvalid(text)) errors.push({ key: text, code: "PAIR_INCOMPLETE" });
    else if (hasText && !hasBg && !alreadyInvalid(bg)) errors.push({ key: bg, code: "PAIR_INCOMPLETE" });
    else if (hasBg && hasText && contrastRatio(tokens[bg]!, tokens[text]!) < THEME_TOKEN_MIN_CONTRAST) {
      errors.push({ key: text, code: "LOW_CONTRAST" });
    }
  }

  return errors.length === 0 ? { ok: true, tokens } : { ok: false, errors };
}

/**
 * Lecture TOLÉRANTE (chemin de rendu public) : ne lève jamais, ne rend
 * jamais une configuration invalide. Une paire invalide (couleur
 * incorrecte, paire incomplète, contraste insuffisant) est ÉCARTÉE en
 * entier -> cette surface retombe sur son rendu historique ; les autres
 * surfaces ne sont pas affectées. Une clé inconnue est ignorée.
 */
export function sanitizeThemeTokens(raw: unknown): ThemeTokens {
  if (!isPlainObject(raw)) return {};
  const colorOf = (key: ThemeTokenKey): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
    const value = raw[key];
    return typeof value === "string" && isValidHexColor(value) ? value.toUpperCase() : undefined;
  };
  const safe: ThemeTokens = {};
  for (const { bg, text } of THEME_SURFACES) {
    const b = colorOf(bg);
    const t = colorOf(text);
    if (b && t && contrastRatio(b, t) >= THEME_TOKEN_MIN_CONTRAST) {
      safe[bg] = b;
      safe[text] = t;
    }
  }
  const border = colorOf("surface_border");
  if (border) safe.surface_border = border;
  return safe;
}

/** Surfaces effectivement configurées, dans l'ordre du catalogue. */
export function themedSurfaces(tokens: ThemeTokens): ThemeSurface[] {
  return THEME_SURFACES.filter(({ bg, text }) => tokens[bg] && tokens[text]).map((s) => s.surface);
}

/**
 * Valeur de l'attribut `data-sc-themed` posé sur le conteneur de la
 * vitrine : liste séparée par des espaces des surfaces configurées (+
 * `border`). `undefined` quand rien n'est configuré -> aucun attribut ->
 * aucune règle CSS du lot ne s'applique (rendu historique exact).
 */
export function themedAttribute(tokens: ThemeTokens): string | undefined {
  const parts: string[] = themedSurfaces(tokens);
  if (tokens.surface_border) parts.push("border");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Variables CSS des surfaces configurées. Vide quand rien n'est configuré.
 *
 * Pour chaque surface : fond, texte, texte secondaire (DÉRIVÉ par le
 * mécanisme déjà audité `mutedOnBg`) et couleur de lien (accent foncé du
 * thème ramené à un contraste lisible CONTRE LE FOND DE LA SURFACE, et non
 * contre le fond de page -- c'est le défaut qu'évite le recalcul : un lien
 * calculé pour un fond sombre serait illisible sur un panneau blanc).
 */
export function themeSurfaceStyle(
  tokens: ThemeTokens,
  accentDark: string,
  highlight: string = accentDark
): Record<string, string> {
  const style: Record<string, string> = {};
  for (const { bg, text, cssPrefix, accent, hasMutedText } of THEME_SURFACES) {
    const b = tokens[bg];
    const t = tokens[text];
    if (!b || !t) continue;
    style[`${cssPrefix}-bg`] = b;
    style[`${cssPrefix}-text`] = t;
    if (hasMutedText) style[`${cssPrefix}-text-muted`] = mutedOnBg(t, b);
    // Accent préféré de la surface (celui qu'elle affiche déjà) ; à défaut
      // l'autre accent du thème s'il est lisible (un laiton clair sur panneau
      // blanc retombe sur l'accent foncé de la MÊME famille, pas sur du
      // noir) ; à défaut seulement, noir/blanc lisible (readableAccentOnBg).
      const first = accent === "highlight" ? highlight : accentDark;
      const second = accent === "highlight" ? accentDark : highlight;
      style[`${cssPrefix}-link`] =
        contrastRatio(first, b) >= THEME_TOKEN_MIN_CONTRAST
          ? first
          : contrastRatio(second, b) >= THEME_TOKEN_MIN_CONTRAST
            ? second
            : readableAccentOnBg(first, b);
  }
  if (tokens.surface_border) style["--sc-surface-border"] = tokens.surface_border;
  return style;
}

/** Forme canonique stable (clés triées) -- comparaison « modifié ? » du back-office. */
export function canonicalThemeTokens(tokens: ThemeTokens): string {
  return JSON.stringify(
    THEME_TOKEN_KEYS.filter((k) => tokens[k] !== undefined).map((k) => [k, tokens[k]])
  );
}
