import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { themeStyle, THEMES } = await import("../lib/themes.ts");
const { contrastRatio } = await import("../lib/color-contrast.ts");

// ====================================================================
// STOREFRONT PHOTO OVERLAY v1 — REMÉDIATION de l'audit indépendant
// (FAIL : couleur secondaire blanche => note TikTok blanche sur disque
// blanc, contraste 1:1). Ces tests couvrent TOUTES les couleurs
// secondaires autorisées (#RRGGBB), pas le seul cas signalé, pour les
// trois icônes sociales, sans toucher au rendu historique « standard ».
// ====================================================================

const REPO_ROOT = process.cwd();
const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p) && !p.endsWith("/"));
      return { path: candidate ?? base };
    });
  },
};
const built = await esbuild.build({
  stdin: {
    contents: `
      export { default as RestaurantHeader } from "@/components/RestaurantHeader";
      export { I18nProvider } from "@/lib/i18n-context";
    `,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-social-"));
const tmpFile = path.join(tmpDir, "header.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { RestaurantHeader, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

function html(overlay: string | undefined): string {
  const r = {
    id: "id-x", name: "X", slug: "x", activeLanguages: [{ code: "fr", label: "Français" }], categories: [],
    config: {
      restaurant_id: "id-x", cover_url: "https://cdn.example/x.jpg", logo_url: null, address: "a", opening_hours: "9h",
      maps_url: null, display_name: "X", source_language: "fr",
      instagram_url: "https://www.instagram.com/e", tiktok_url: "https://www.tiktok.com/@e", facebook_url: "https://www.facebook.com/e",
      ...(overlay ? { storefront_photo_overlay: overlay } : {}),
    },
  };
  return renderToStaticMarkup(
    React.createElement(I18nProvider, { lang: "fr", sourceLanguage: "fr", activeLanguages: r.activeLanguages },
      React.createElement(RestaurantHeader, { restaurant: r, lang: "fr", onChangeLang: () => {} }))
  );
}

/** Couleurs secondaires de test : extrêmes, quasi-extrêmes, milieu de gamme, thèmes, balayage de gris, pseudo-aléatoires (graine fixe). */
function inkSamples(): string[] {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  const out = new Set<string>(["#FFFFFF", "#000000", "#FEFEFE", "#010101", "#F6F2EC", "#777777", "#7F7F7F", "#808080", "#767676", "#757575", "#FFFF00", "#00FFFF", "#FF00FF", "#25F4EE", "#FE2C55", "#FEDA75", "#4F5BD5"]);
  for (let g = 0; g <= 255; g += 5) out.add(`#${hex(g)}${hex(g)}${hex(g)}`);
  for (const t of Object.values(THEMES)) out.add(t.ink.toUpperCase());
  let seed = 123456789;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 3000; i++) out.add(`#${hex(Math.floor(rnd() * 256))}${hex(Math.floor(rnd() * 256))}${hex(Math.floor(rnd() * 256))}`);
  return [...out];
}

test("SOC-1 pour TOUTE couleur secondaire autorisée, la couleur calculée --sc-ink-text contraste >= 4,5:1 avec le disque (--sc-ink) — note TikTok et glyphe Facebook", () => {
  const samples = inkSamples();
  assert.ok(samples.length > 3000);
  let worst = Infinity;
  let worstInk = "";
  for (const ink of samples) {
    const vars = themeStyle(undefined, { primary: null, secondary: ink, accent: null, bg: null });
    assert.equal(vars["--sc-ink"].toUpperCase(), ink, "le disque (bg-espresso = --sc-ink) EST la couleur secondaire");
    const ratio = contrastRatio(vars["--sc-ink-text"], vars["--sc-ink"]);
    if (ratio < worst) { worst = ratio; worstInk = ink; }
    assert.ok(ratio >= 4.5, `${ink}: ${ratio.toFixed(2)}:1`);
  }
  // Le pire cas réel du balayage reste au-dessus du seuil WCAG AA texte.
  assert.ok(worst >= 4.5, `pire cas ${worstInk}: ${worst.toFixed(3)}`);
});

test("SOC-2 sensibilité: l'ancienne note blanche FIXE échouait bien (1:1 sur secondaire blanche) — le test détecte le défaut signalé", () => {
  assert.equal(contrastRatio("#FFFFFF", "#FFFFFF"), 1);
  const failing = inkSamples().filter((ink) => contrastRatio("#FFFFFF", ink) < 3);
  assert.ok(failing.length > 500, "une large part des couleurs autorisées rendait la note blanche illisible");
  assert.ok(failing.includes("#FFFFFF") && failing.includes("#F6F2EC") && failing.includes("#FFFF00"));
});

test("SOC-3 'none' et 'light': la note TikTok suit --sc-ink-text, Instagram a un liseré --sc-ink-text, Facebook garde text-ink-text; les trois sur disque opaque", () => {
  for (const mode of ["none", "light"]) {
    const h = html(mode);
    assert.ok(h.includes('data-note-adaptive=""'), `${mode}: note adaptative`);
    assert.ok(/<path[^>]*fill="#FFFFFF"[^>]*style="fill:var\(--sc-ink-text, #FFFFFF\)"/.test(h) || /<path[^>]*style="fill:var\(--sc-ink-text, #FFFFFF\)"[^>]*fill="#FFFFFF"/.test(h), `${mode}: style fill = --sc-ink-text, repli blanc`);
    assert.ok(/<rect[^>]*stroke="var\(--sc-ink-text, #FFFFFF\)"[^>]*data-icon-ring=""/.test(h) || /<rect[^>]*data-icon-ring=""[^>]*stroke="var\(--sc-ink-text, #FFFFFF\)"/.test(h), `${mode}: liseré Instagram`);
    // Les trois icônes sont sur un disque opaque (--sc-ink): Instagram et TikTok sur leur lien, Facebook sur son enveloppe.
    for (const label of ["Instagram", "TikTok"]) {
      const cls = h.match(new RegExp(`aria-label="${label}"[^>]*class="([^"]*)"`))?.[1] ?? "";
      assert.ok(cls.includes("bg-espresso") && cls.includes("rounded-full"), `${mode}/${label}: disque opaque`);
    }
    assert.ok(/<span class="[^"]*rounded-full bg-espresso"><a[^>]*aria-label="Facebook"/.test(h), `${mode}/Facebook: disque opaque`);
    assert.equal((h.match(/bg-espresso/g) ?? []).length >= 4, true, "langue + titre + 3 icônes sur fond opaque");
    assert.ok(/aria-label="Facebook"[^>]*class="text-ink-text"|class="text-ink-text"[^>]*aria-label="Facebook"/.test(h), "Facebook: glyphe text-ink-text");
  }
});

test("SOC-4 'standard' (rendu historique): AUCUNE adaptation — note TikTok blanche fixe, Instagram sans liseré, pas de disque", () => {
  for (const h of [html("standard"), html(undefined)]) {
    assert.ok(!h.includes("data-note-adaptive"));
    assert.ok(!h.includes("data-icon-ring"));
    assert.ok(!h.includes('stroke="var('), "aucun liseré de thème hors backed");
    assert.ok(!h.includes("--sc-ink-text, #FFFFFF"), "aucune variable ajoutée en standard");
    const tiktok = h.match(/<svg[^>]*data-brand-icon="tiktok">.*?<\/svg>/)![0];
    assert.ok(tiktok.endsWith('fill="#FFFFFF"></path></svg>'), "note blanche fixe, exactement comme sur main");
  }
  assert.equal(html("standard").replace(/ data-photo-overlay="[^"]*"/, ""), html(undefined).replace(/ data-photo-overlay="[^"]*"/, ""));
});

test("SOC-5 les échos de marque TikTok (cyan/rouge) et le dégradé Instagram sont conservés dans tous les modes", () => {
  for (const mode of ["none", "light", "standard"]) {
    const h = html(mode);
    assert.ok(h.includes('fill="#25F4EE"') && h.includes('fill="#FE2C55"'), `${mode}: échos TikTok`);
    for (const stop of ["#FEDA75", "#FA7E1E", "#D62976", "#962FBF", "#4F5BD5"]) assert.ok(h.includes(stop), `${mode}: ${stop}`);
  }
});
