/**
 * Thèmes visuels par établissement.
 *
 * Les composants continuent d'utiliser les mêmes noms de couleurs
 * (espresso, crema, caramel…) ; seules les valeurs changent, injectées
 * en variables CSS sur la page. Aucun composant n'a de couleur en dur.
 *
 * Les palettes sont préparées et vérifiées pour rester lisibles :
 * le commerçant choisit un thème, il ne choisit pas des couleurs.
 */
/** Composantes RVB d'une couleur hexadécimale. */
export function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

export interface Theme {
  /** Texte et fonds sombres */
  ink: string;
  /** Fond de page */
  bg: string;
  /** Boutons et éléments actifs */
  accent: string;
  /** Variante foncée de l'accent (états pressés) */
  accentDark: string;
  /** Filets et détails précieux */
  highlight: string;
}

export const THEMES: Record<string, Theme> = {
  // Café italien, chocolat, boulangerie
  cafe: {
    ink: "#221510",
    bg: "#F6F2EC",
    accent: "#A3651F",
    accentDark: "#8A5322",
    highlight: "#C6A15B",
  },
  // Bar d'hôtel, restaurant du soir : bleu nuit et laiton.
  // Fond très clair légèrement bleuté : les cartes blanches s'en
  // détachent par leur ombre plutôt que par le contraste.
  nuit: {
    ink: "#1C1A17",
    bg: "#F5F0E8",
    accent: "#4A3927",
    accentDark: "#2D241B",
    highlight: "#B08D57",
  },
  // Terrasse méditerranéenne de nuit : bleu soutenu et or.
  // Fond plus dense que le thème nuit — les cartes blanches s'en
  // détachent nettement (rapport 1,53 contre 1,12).
  terrasse: {
    ink: "#12243D",
    bg: "#C1D3E7",
    accent: "#1B4E86",
    accentDark: "#143A64",
    highlight: "#C9A227",
  },
  // Glacier, poissonnerie, primeur
  frais: {
    ink: "#10312B",
    bg: "#F3F8F5",
    accent: "#1F7A63",
    accentDark: "#175B4A",
    highlight: "#7FB69F",
  },
  // Pâtisserie, salon de thé
  gourmand: {
    ink: "#3A1220",
    bg: "#FBF3F5",
    accent: "#B03A5B",
    accentDark: "#8A2B46",
    highlight: "#E0A0B4",
  },
};

export const DEFAULT_THEME = "cafe";

export function getTheme(name: string | undefined): Theme {
  return THEMES[name ?? ""] ?? THEMES[DEFAULT_THEME];
}

/** Variables CSS à poser sur le conteneur de la page. */
export function themeStyle(name: string | undefined): Record<string, string> {
  const t = getTheme(name);
  const [r, g, b] = rgbOf(t.ink);
  return {
    // Voile de la bannière : teinte sombre du thème, et non une
    // valeur figée qui laisserait un brun de café sur un bar bleu.
    // Volontairement léger : la photo doit rester visible. La
    // lisibilité du titre est assurée par une ombre portée sur le
    // texte (voir RestaurantHeader) plutôt qu'en assombrissant
    // toute l'image — une photo de terrasse comporte des zones
    // claires, ciel et lumières, qu'un voile uniforme éteindrait.
    "--sc-veil-soft": `rgba(${r}, ${g}, ${b}, 0.2)`,
    "--sc-veil-strong": `rgba(${r}, ${g}, ${b}, 0.32)`,
    "--sc-ink": t.ink,
    "--sc-bg": t.bg,
    "--sc-accent": t.accent,
    "--sc-accent-dark": t.accentDark,
    "--sc-highlight": t.highlight,
  };
}
