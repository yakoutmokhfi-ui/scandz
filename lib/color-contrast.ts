/**
 * Couleurs personnalisées d'établissement (V69) — validation et
 * accessibilité.
 *
 * Module autonome (aucune dépendance vers lib/themes.ts, pour éviter
 * tout cycle d'import : c'est themes.ts qui importe celui-ci).
 *
 * RÈGLE DE CONTRASTE — WCAG 2.1 (relative luminance / contrast ratio,
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance) : pour une
 * couleur de fond donnée, on calcule le ratio de contraste contre le
 * blanc pur et contre le noir pur, et on retient celui des deux qui
 * offre le MEILLEUR contraste. Méthode standard, déterministe,
 * indépendante de toute bibliothèque externe. Le commerçant ne choisit
 * jamais directement la couleur du texte : elle est TOUJOURS dérivée
 * automatiquement de la couleur de fond choisie.
 */

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** Format strict #RRGGBB uniquement (pas de forme courte #RGB, pas de nom CSS, pas de rgb()). */
export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function srgbChannelToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** Luminance relative WCAG (0 = noir, 1 = blanc). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** Ratio de contraste WCAG entre deux couleurs (1 à 21). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Couleur de texte lisible (noir ou blanc pur) sur un fond donné :
 * celle des deux qui obtient le meilleur ratio de contraste WCAG.
 * Le commerçant ne contrôle jamais cette valeur directement.
 */
export function readableTextColor(backgroundHex: string): "#000000" | "#ffffff" {
  const contrastWithWhite = contrastRatio(backgroundHex, "#ffffff");
  const contrastWithBlack = contrastRatio(backgroundHex, "#000000");
  return contrastWithWhite >= contrastWithBlack ? "#ffffff" : "#000000";
}

/**
 * Couleur ACCENT (ex. --sc-ink utilisée comme TEXTE, pas comme fond)
 * sur un fond CONNU et FIXE : conserve la couleur d'origine si son
 * contraste réel contre ce fond est suffisant (WCAG AA, 4.5:1),
 * sinon substitue une couleur garantie lisible (noir ou blanc, celle
 * qui contraste le mieux contre ce même fond).
 *
 * Corrige V72-03 (contre-audit Work, 3e tour) : "text-espresso sur
 * bg-crema" -- --sc-bg (crema) est FIXE (jamais personnalisable),
 * mais --sc-ink (espresso, utilisée ici comme COULEUR DE TEXTE, pas
 * comme fond) l'est via secondary_color. Un commerçant choisissant
 * secondary_color proche de la couleur de page (--sc-bg) rendait ce
 * texte quasi invisible. Le repli est TOUJOURS calculé, jamais
 * choisi par le commerçant.
 */
export function readableAccentOnBg(accentHex: string, bgHex: string, minRatio = 4.5): string {
  return contrastRatio(accentHex, bgHex) >= minRatio ? accentHex : readableTextColor(bgHex);
}

/**
 * Variante "atténuée" d'une couleur de texte déjà protégée
 * (ex. --sc-ink-on-bg), pour la hiérarchie visuelle (texte
 * secondaire) SANS recourir à une opacité Tailwind qui dégraderait la
 * garantie de contraste (voir le raisonnement dans lib/themes.ts,
 * corrige V73-02). Mélange RÉEL vers le fond à un taux fixe
 * (`strength`), mais REVIENT à la couleur pleine puissance si ce
 * mélange ferait tomber le contraste sous le seuil WCAG AA -- jamais
 * un compromis silencieux.
 */
export function mutedOnBg(textHex: string, bgHex: string, strength = 0.7, minRatio = 4.5): string {
  const candidate = compositeOver(textHex, bgHex, strength);
  return contrastRatio(candidate, bgHex) >= minRatio ? candidate : textHex;
}

/** Assombrit une couleur d'un facteur (0 à 1) — pour dériver un état "actif/pressé" cohérent d'une couleur personnalisée. */
export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const factor = 1 - amount;
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r * factor)}${toHex(g * factor)}${toHex(b * factor)}`;
}

/**
 * Composite `fgHex` par-dessus `bgHex` à l'opacité `alpha` (0 à 1) et
 * renvoie la couleur RÉELLEMENT visible qui en résulte — alpha
 * blending standard, canal par canal.
 *
 * Corrige V71-02 (contre-audit Work, 2e tour) : une classe comme
 * `bg-espresso/20` n'affiche PAS la couleur `--sc-ink` telle quelle,
 * mais un MÉLANGE avec ce qui se trouve derrière (ici 20% ink + 80%
 * du fond). Calculer la lisibilité du texte contre `--sc-ink` pur
 * pour un élément à opacité réduite serait donc incorrect : c'est
 * exactement le piège qu'une simple substitution de classe aurait pu
 * dissimuler sans le prouver. Utilisée uniquement quand le fond
 * RÉEL derrière l'élément translucide est connu avec certitude (une
 * couleur de page fixe, jamais une photo dont le contenu est
 * arbitraire — voir la limite documentée dans lib/themes.ts pour les
 * éléments positionnés sur la bannière photo).
 */
export function compositeOver(fgHex: string, bgHex: string, alpha: number): string {
  const [fr, fg, fb] = hexToRgb(fgHex);
  const [br, bg, bb] = hexToRgb(bgHex);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  const mix = (f: number, b: number) => f * alpha + b * (1 - alpha);
  return `#${toHex(mix(fr, br))}${toHex(mix(fg, bg))}${toHex(mix(fb, bb))}`;
}
