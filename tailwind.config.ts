import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Résolues à l'exécution : chaque établissement injecte ses
        // propres valeurs (voir lib/themes.ts). Les valeurs de repli
        // sont celles du thème "café", historique du projet.
        espresso: "var(--sc-ink, #221510)",
        crema: "var(--sc-bg, #F6F2EC)",
        caramel: "var(--sc-accent, #A3651F)",
        "caramel-dark": "var(--sc-accent-dark, #8A5322)",
        gold: "var(--sc-highlight, #C6A15B)",
        // Texte lisible sur bg-caramel (V69) — TOUJOURS calculée
        // (lib/color-contrast.ts, readableTextColor), jamais choisie
        // par le commerçant. Repli blanc : identique au text-white
        // actuellement en dur sur ces mêmes boutons pour les 5 thèmes
        // existants (aucune régression sans couleur personnalisée).
        "caramel-ink": "var(--sc-accent-text, #ffffff)",
        // Texte lisible sur un fond "espresso"/--sc-ink (V71, corrige
        // V70-03) — TOUJOURS calculée, jamais choisie par le
        // commerçant. Utilisée là où du texte est rendu directement
        // sur un fond dérivé de --sc-ink (RestaurantHeader), à la
        // place d'un texte auparavant figé indépendamment de la
        // couleur réellement personnalisable par le commerçant.
        "ink-text": "var(--sc-ink-text, #ffffff)",
        // Composition RÉELLE ink à 20% sur --sc-bg (V71-02/V72) --
        // cas précis des boutons désactivés (PastryModal/OptionModal),
        // jamais --sc-ink pur (qui ne correspond pas à ce qui est
        // réellement affiché à cette opacité).
        "ink-text-on-bg-20": "var(--sc-ink-text-on-bg-20, #ffffff)",
        // ink en tant que TEXTE sur --sc-bg (V72-03) -- conservée si
        // lisible, repliée sur noir/blanc sinon. Jamais --sc-ink brut
        // pour ce rôle précis.
        "ink-on-bg": "var(--sc-ink-on-bg, #221510)",
        // highlight en tant que TEXTE sur --sc-ink (V72-03) --
        // conservée si lisible, repliée sur noir/blanc sinon.
        "highlight-on-ink": "var(--sc-highlight-on-ink, #C6A15B)",
        // accentDark en tant que TEXTE sur --sc-bg (V73-02) --
        // conservée si lisible, repliée sur noir/blanc sinon. Cas
        // réel : prix et libellés dans tout le catalogue
        // (MenuItemCard, CartPanel, OrderConfirmation, etc.).
        "accent-dark-on-bg": "var(--sc-accent-dark-on-bg, #8A5322)",
        // Variantes "atténuées" pour le texte secondaire/description
        // (V73-02) -- mélange RÉEL vers le fond, jamais une opacité
        // Tailwind qui dégraderait la garantie de contraste calculée.
        "ink-on-bg-muted": "var(--sc-ink-on-bg-muted, #625752)",
        "accent-dark-on-bg-muted": "var(--sc-accent-dark-on-bg-muted, #8A5322)",
      },
    },
  },
  plugins: [],
};

export default config;
