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
      },
    },
  },
  plugins: [],
};

export default config;
