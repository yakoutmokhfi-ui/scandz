import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// STOREFRONT PHOTO OVERLAY v1 — rendu RÉEL de components/RestaurantHeader
// (React, SSR) pour chaque valeur du réglage : voile appliqué, éléments
// préservés (titre, adresse, horaires, itinéraire, réseaux sociaux),
// aucune fuite entre établissements, rétrocompatibilité (champ absent).
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-overlay-"));
const tmpFile = path.join(tmpDir, "header.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { RestaurantHeader, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const LEGACY_LAYER =
  "linear-gradient(var(--sc-veil-soft, rgba(23,13,9,0.2)), var(--sc-veil-strong, rgba(23,13,9,0.32)))";

function restaurant(slug: string, configExtra: Record<string, unknown> = {}) {
  return {
    id: `id-${slug}`,
    name: `Nom ${slug}`,
    slug,
    activeLanguages: [
      { code: "fr", label: "Français" },
      { code: "en", label: "English" },
    ],
    categories: [],
    config: {
      restaurant_id: `id-${slug}`,
      cover_url: `https://cdn.example/${slug}-cover.jpg`,
      logo_url: null,
      address: `12 rue du ${slug}`,
      opening_hours: "9h-18h",
      maps_url: "https://maps.example/itineraire",
      display_name: `Titre ${slug}`,
      instagram_url: "https://www.instagram.com/example",
      tiktok_url: "https://www.tiktok.com/@example",
      facebook_url: "https://www.facebook.com/example",
      source_language: "fr",
      ...configExtra,
    },
  };
}

function render(r: ReturnType<typeof restaurant>, veilInk?: string | null): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { lang: "fr", sourceLanguage: "fr", activeLanguages: r.activeLanguages },
      React.createElement(RestaurantHeader, { restaurant: r, lang: "fr", onChangeLang: () => {}, veilInk })
    )
  );
}
/** backgroundImage inline du <header>, entité HTML décodée. */
function backgroundImageOf(html: string): string {
  const m = html.match(/<header[^>]*style="([^"]*)"/);
  assert.ok(m, "<header> avec style");
  const decoded = m![1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  const bg = decoded.match(/background-image:([^;]*(?:\([^)]*\)[^;]*)*);\s*background-size/);
  assert.ok(bg, `background-image dans « ${decoded} »`);
  return bg![1].trim();
}

test("OVD-1 sans champ (colonne pas encore appliquée / marchand existant): rendu HISTORIQUE — voile standard + photo", () => {
  const html = render(restaurant("legacy"));
  assert.equal(backgroundImageOf(html), `${LEGACY_LAYER}, url('https://cdn.example/legacy-cover.jpg')`);
  assert.ok(html.includes('data-photo-overlay="standard"'));
});

test("OVD-2 'standard' explicite = EXACTEMENT le rendu historique (même chaîne que sans champ)", () => {
  const a = render(restaurant("m1"));
  const b = render(restaurant("m1", { storefront_photo_overlay: "standard" }));
  assert.equal(backgroundImageOf(a), backgroundImageOf(b));
  // Seule la classe des icônes sociales pourrait différer: elle ne diffère pas en standard.
  assert.equal(a.replace(/data-photo-overlay="[^"]*"/, ""), b.replace(/data-photo-overlay="[^"]*"/, ""), "rendu identique octet pour octet");
});

test("OVD-3 'none': aucune couche de dégradé, la photo seule", () => {
  const html = render(restaurant("m1", { storefront_photo_overlay: "none" }));
  assert.equal(backgroundImageOf(html), "url('https://cdn.example/m1-cover.jpg')");
  assert.ok(!backgroundImageOf(html).includes("gradient"));
  assert.ok(html.includes('data-photo-overlay="none"'));
});

test("OVD-4 'light': voile de même teinte, plus léger; teinte suivie via veilInk", () => {
  const html = render(restaurant("m1", { storefront_photo_overlay: "light" }), "#12243D");
  assert.equal(
    backgroundImageOf(html),
    "linear-gradient(rgba(18, 36, 61, 0.08), rgba(18, 36, 61, 0.13)), url('https://cdn.example/m1-cover.jpg')"
  );
  const noInk = render(restaurant("m1", { storefront_photo_overlay: "light" }));
  assert.ok(backgroundImageOf(noInk).startsWith("linear-gradient(rgba(23, 13, 9, 0.08)"), "repli: teinte historique");
});

test("OVD-5 valeur inconnue/corrompue en base => rendu 'standard', jamais un voile arbitraire ni du CSS injecté", () => {
  for (const bad of ["dark", "None", " none", "none;background:red", null, 7, {}]) {
    const html = render(restaurant("m1", { storefront_photo_overlay: bad }));
    assert.equal(backgroundImageOf(html), `${LEGACY_LAYER}, url('https://cdn.example/m1-cover.jpg')`, String(bad));
  }
});

test("OVD-6 repli /banners/<slug>.jpg (sans cover_url) conserve le même comportement pour chaque mode", () => {
  const noCover = (mode: string | undefined) =>
    render(restaurant("sanaa-cookies", { cover_url: null, ...(mode ? { storefront_photo_overlay: mode } : {}) }));
  assert.equal(backgroundImageOf(noCover(undefined)), `${LEGACY_LAYER}, url('/banners/sanaa-cookies.jpg')`);
  assert.equal(backgroundImageOf(noCover("none")), "url('/banners/sanaa-cookies.jpg')");
});

test("OVD-7 éléments PRÉSERVÉS dans les trois modes: titre, adresse, horaires, itinéraire, réseaux sociaux, sélecteur de langue", () => {
  for (const mode of ["none", "light", "standard"]) {
    const html = render(restaurant("m1", { storefront_photo_overlay: mode }));
    assert.ok(html.includes("Titre m1"), `${mode}: titre`);
    assert.ok(html.includes("12 rue du m1"), `${mode}: adresse`);
    assert.ok(html.includes("9h-18h"), `${mode}: horaires`);
    assert.ok(html.includes('href="https://maps.example/itineraire"'), `${mode}: itinéraire`);
    for (const name of ["Instagram", "TikTok", "Facebook"]) assert.ok(html.includes(`aria-label="${name}"`), `${mode}: ${name}`);
    assert.ok(html.includes('href="https://www.instagram.com/example"') && html.includes('href="https://www.tiktok.com/@example"') && html.includes('href="https://www.facebook.com/example"'), `${mode}: liens sociaux`);
    assert.ok(html.includes('aria-pressed="true"'), `${mode}: sélecteur de langue`);
    // Les surfaces de texte restent OPAQUES (lisibilité indépendante de la photo, V72-02).
    assert.ok(html.includes("rounded-2xl bg-espresso"), `${mode}: panneau titre opaque`);
    assert.ok(html.includes("bg-espresso p-1"), `${mode}: sélecteur de langue opaque`);
  }
});

test("OVD-8 lisibilité sans voile: les icônes sociales (posées sur la photo) reçoivent un fond OPAQUE en 'none' et 'light', rien de changé en 'standard'", () => {
  const std = render(restaurant("m1", { storefront_photo_overlay: "standard" }));
  const none = render(restaurant("m1", { storefront_photo_overlay: "none" }));
  const light = render(restaurant("m1", { storefront_photo_overlay: "light" }));
  const socialLinkClass = (html: string, label: string) => html.match(new RegExp(`class="([^"]*)"[^>]*aria-label="${label}"|aria-label="${label}"[^>]*class="([^"]*)"`))!.slice(1).find(Boolean) ?? "";
  for (const label of ["Instagram", "TikTok"]) {
    assert.ok(!socialLinkClass(std, label).includes("bg-espresso"), `standard/${label}: inchangé`);
    for (const html of [none, light]) assert.ok(socialLinkClass(html, label).includes("bg-espresso"), `${label}: fond opaque sans voile fort`);
  }
  // Facebook: enveloppe ronde opaque hors standard.
  assert.ok(!std.includes("justify-center rounded-full bg-espresso\"><a"), "standard/Facebook inchangé");
  assert.ok(none.includes('items-center justify-center rounded-full bg-espresso"><a'), "none/Facebook: fond opaque");
});

test("OVD-9 pas de fuite entre marchands: rendus successifs de A(none) puis B(standard) puis C(sans champ) indépendants", () => {
  const a1 = backgroundImageOf(render(restaurant("a", { storefront_photo_overlay: "none" })));
  const b = backgroundImageOf(render(restaurant("b", { storefront_photo_overlay: "standard" })));
  const c = backgroundImageOf(render(restaurant("c")));
  const a2 = backgroundImageOf(render(restaurant("a", { storefront_photo_overlay: "none" })));
  assert.equal(a1, "url('https://cdn.example/a-cover.jpg')");
  assert.equal(b, `${LEGACY_LAYER}, url('https://cdn.example/b-cover.jpg')`);
  assert.equal(c, `${LEGACY_LAYER}, url('https://cdn.example/c-cover.jpg')`);
  assert.equal(a2, a1, "A reste inchangé après B et C");
});

test("OVD-10 aucun autre réglage de personnalisation n'est modifié: titre/logo/annonce rendus identiques quel que soit le mode", () => {
  const strip = (html: string) => html.replace(/ data-photo-overlay="[^"]*"/, "").replace(/style="[^"]*"/, "").replace(/ bg-espresso(?=[" ])/g, "").replace(/ rounded-full(?=[" ])/g, "");
  const base = strip(render(restaurant("m1", { logo_url: "https://cdn.example/logo.png", announcement_text: "Fermé lundi", announcement_active: true, storefront_photo_overlay: "standard" })));
  for (const mode of ["none", "light"]) {
    const other = strip(render(restaurant("m1", { logo_url: "https://cdn.example/logo.png", announcement_text: "Fermé lundi", announcement_active: true, storefront_photo_overlay: mode })));
    assert.equal(other.replace(/\s+/g, " "), base.replace(/\s+/g, " "), `${mode}: seul le voile et le fond des icônes sociales diffèrent`);
  }
});
