/**
 * Thèmes visuels par établissement.
 *
 * Les composants continuent d'utiliser les mêmes noms de couleurs
 * (espresso, crema, caramel…) ; seules les valeurs changent, injectées
 * en variables CSS sur la page. Aucun composant n'a de couleur en dur.
 *
 * Les palettes sont préparées et vérifiées pour rester lisibles :
 * le commerçant choisit un thème, il ne choisit pas des couleurs.
 *
 * V69 — un établissement peut SURCHARGER trois couleurs du thème
 * (restaurant_configs.primary_color/secondary_color/accent_color,
 * voir lib/color-contrast.ts) sans changer de thème ni introduire un
 * nouveau système : ce sont les mêmes variables CSS --sc-accent/
 * --sc-ink/--sc-highlight que themeStyle() posait déjà, simplement
 * réalimentées par la config établissement quand elle est renseignée.
 * `null`/absent = comportement exactement identique à avant V69.
 */
import { darken, readableTextColor, compositeOver, readableAccentOnBg, mutedOnBg } from "@/lib/color-contrast";

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

/** Surcharges de couleur établissement (V69) — voir restaurant_configs. `null`/absent = thème inchangé. */
export interface ThemeColorOverrides {
  primary?: string | null;
  secondary?: string | null;
  accent?: string | null;
  /** Corrige LOT 1A : couleur de fond personnalisée (restaurant_configs.bg_color), #RRGGBB. NULL/absent = fond du thème par défaut, rendu inchangé. Réutilise intégralement le mécanisme de contraste déjà audité (readableAccentOnBg/mutedOnBg) : aucune nouvelle logique de contraste. */
  bg?: string | null;
}

/**
 * Variables CSS à poser sur le conteneur de la page.
 *
 * `overrides` : primary -> --sc-accent (boutons/CTA/catégorie active),
 * secondary -> --sc-ink (header, fonds sombres), accent -> --sc-highlight
 * (filets/décoratifs). Toute valeur absente/null retombe sur le thème
 * statique choisi (`name`) — comportement V68 et antérieur inchangé.
 *
 * Corrige V70-03 : --sc-accent-text était la SEULE couleur de texte
 * calculée (readableTextColor sur primary_color/--sc-accent). Or
 * --sc-ink sert aussi de FOND avec du texte dessus (voir
 * RestaurantHeader — titre, sous-titre, CTA), et --sc-ink est
 * modifiable via secondary_color : un commerçant choisissant
 * secondary_color = #FFFFFF (fond quasi blanc) laissait ce texte
 * hardcodé (`text-crema`, donc en réalité --sc-bg, un TROISIÈME
 * gabarit jamais recalculé) proche de l'invisibilité — exactement le
 * cas mesuré par l'audit (secondary_color=#FFFFFF, texte=#F6F2EC,
 * contraste ≈1,12:1). --sc-ink-text est désormais TOUJOURS calculée
 * (jamais choisie par le commerçant) et appliquée explicitement à ces
 * éléments (voir RestaurantHeader.tsx). --sc-highlight (accent_color)
 * n'est utilisée nulle part comme fond contenant du texte dans ce
 * projet (recherche exhaustive menée sur components/ et app/, avant
 * d'écrire ce correctif) — seulement en couleur de texte/bordure sur
 * un fond dérivé de --sc-ink, déjà couvert par --sc-ink-text
 * ci-dessous puisque c'est ce fond-là qui détermine la lisibilité,
 * pas la couleur du texte elle-même.
 *
 * Thème par défaut (aucun override) : --sc-ink-text vaut blanc pour
 * les 5 thèmes existants (tous ont un ink sombre), identique au
 * text-crema actuellement en dur — aucune régression visuelle sans
 * personnalisation.
 *
 * Corrige V71-02 (contre-audit Work, 2e tour) : inventaire élargi de
 * TOUS les usages de bg-espresso/--sc-ink dans components/ et app/
 * (pas seulement MenuView/RestaurantInfoBar/LanguageSelector cités
 * par l'audit -- PastryModal et OptionModal utilisent le même motif
 * pour leur bouton désactivé, corrigés aussi).
 *
 * DEUX cas distincts, traités différemment :
 *   1. Fond SOLIDE ou fond TRANSLUCENT sur un arrière-plan CONNU
 *      (--sc-bg, une couleur de page fixe) : --sc-ink-text (fond
 *      plein) et --sc-ink-text-on-bg-20 (fond à 20% d'opacité sur
 *      --sc-bg, cas réel de PastryModal/OptionModal) sont calculées
 *      PRÉCISÉMENT par composition alpha réelle (compositeOver),
 *      jamais contre --sc-ink pur pour les éléments translucides --
 *      substituer une classe sans recalculer la couleur RÉELLEMENT
 *      visible ne prouverait rien.
 *   2. Fond TRANSLUCENT positionné sur la PHOTO de bannière
 *      (RestaurantHeader, RestaurantInfoBar, LanguageSelector) :
 *      le contenu réel de la photo est arbitraire et inconnu à la
 *      génération de ces variables -- AUCUNE garantie de contraste
 *      programmatique précise n'est possible dans ce cas. --sc-ink-text
 *      y est réutilisée comme heuristique raisonnable (approxime le
 *      voile ink-teinté qui domine visuellement la zone), complétée
 *      par l'ombre portée déjà en place sur le texte du header
 *      (voir RestaurantHeader.tsx) -- LIMITE CONNUE ET ASSUMÉE,
 *      documentée ici plutôt que masquée, voir le rapport de
 *      livraison V72.
 */
export function themeStyle(
  name: string | undefined,
  overrides?: ThemeColorOverrides
): Record<string, string> {
  const t = getTheme(name);
  const accent = overrides?.primary ?? t.accent;
  const ink = overrides?.secondary ?? t.ink;
  const highlight = overrides?.accent ?? t.highlight;
  const bg = overrides?.bg ?? t.bg;
  const accentDark = overrides?.primary ? darken(overrides.primary, 0.15) : t.accentDark;
  const [r, g, b] = rgbOf(ink);
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
    "--sc-ink": ink,
    "--sc-bg": bg,
    "--sc-accent": accent,
    "--sc-accent-dark": accentDark,
    "--sc-highlight": highlight,
    "--sc-accent-text": readableTextColor(accent),
    "--sc-ink-text": readableTextColor(ink),
    // Composition RÉELLE ink à 20% sur --sc-bg (fond connu) — cas
    // exact des boutons désactivés de PastryModal/OptionModal.
    "--sc-ink-text-on-bg-20": readableTextColor(compositeOver(ink, bg, 0.2)),
    // Corrige V72-03 : --sc-ink utilisée comme COULEUR DE TEXTE sur
    // --sc-bg (fond fixe) -- conserve ink si son contraste est
    // suffisant, replie sur noir/blanc sinon. Cas exact :
    // LanguageSelector, pastille active.
    "--sc-ink-on-bg": readableAccentOnBg(ink, bg),
    // Corrige V72-03 : --sc-highlight utilisée comme TEXTE sur un
    // fond --sc-ink désormais SOLIDE (RestaurantInfoBar, icônes et
    // libellés) -- conserve highlight si son contraste contre ink est
    // suffisant, replie sur noir/blanc sinon.
    "--sc-highlight-on-ink": readableAccentOnBg(highlight, ink),
    // Corrige V73-02 (contre-audit Work, 4e tour) : inventaire élargi
    // à TOUT le catalogue (MenuItemCard, CartPanel, OrderConfirmation,
    // FulfillmentSelector, CategoryNav, InlineOptions, OptionModal,
    // PastryModal, ProductInfoButton, TableSelector -- pas seulement
    // RestaurantHeader/LanguageSelector/RestaurantInfoBar cités par
    // l'audit). --sc-accent-dark est utilisée comme COULEUR DE TEXTE
    // LISIBLE (prix, libellés) sur le fond de page fixe (--sc-bg) --
    // même mécanisme que --sc-ink-on-bg ci-dessus, jamais choisi par
    // le commerçant.
    //
    // --sc-highlight (RestaurantInfoCard, icône aria-hidden) n'entre
    // volontairement PAS dans ce périmètre : une icône purement
    // décorative masquée aux technologies d'assistance (aria-hidden)
    // est explicitement exclue des exigences de contraste de texte
    // WCAG 1.4.3/1.4.11 -- vérifié dans le code avant d'écarter ce
    // cas, pas supposé.
    "--sc-accent-dark-on-bg": readableAccentOnBg(accentDark, bg),
    // Variantes "atténuées" pour la hiérarchie visuelle (texte
    // secondaire/description) SANS opacité Tailwind -- corrige
    // V73-02. Reviennent à la pleine puissance si l'atténuation
    // ferait tomber le contraste sous 4.5:1 (voir mutedOnBg).
    "--sc-ink-on-bg-muted": mutedOnBg(readableAccentOnBg(ink, bg), bg),
    "--sc-accent-dark-on-bg-muted": mutedOnBg(readableAccentOnBg(accentDark, bg), bg),
  };
}
