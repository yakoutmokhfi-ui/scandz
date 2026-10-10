// THEME & CONTENT SETTINGS v1 — jeu de paires pour prouver que le validateur
// SQL (theme_tokens_valid / theme_token_contrast) est le MIROIR du validateur
// TypeScript (lib/theme-tokens.ts). Sortie CSV : bg,texte,accepté_TS,ratio_TS.
// Exécuté par theme-content-settings-v1-check.sh depuis la racine du dépôt.
import { validateThemeTokens } from "../../lib/theme-tokens.ts";
import { contrastRatio } from "../../lib/color-contrast.ts";

const hex = (n) => "#" + n.toString(16).padStart(6, "0").toUpperCase();
const pairs = [];
// Balayage exhaustif des gris contre blanc et noir (bascule autour de 4,5).
for (let g = 0; g < 256; g++) {
  const c = hex(g * 0x010101);
  pairs.push(["#FFFFFF", c], ["#000000", c], [c, "#FFFFFF"]);
}
// Paires pseudo-aléatoires déterministes.
let seed = 123456789;
const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (let i = 0; i < 1500; i++) pairs.push([hex(next() & 0xffffff), hex(next() & 0xffffff)]);

for (const [bg, tx] of pairs) {
  const v = validateThemeTokens({ popup_bg: bg, popup_text: tx });
  console.log([bg, tx, v.ok ? "t" : "f", contrastRatio(bg, tx).toFixed(12)].join(","));
}
