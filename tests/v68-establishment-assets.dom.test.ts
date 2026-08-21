import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Test comportemental React réel pour la cover d'établissement (V68)
// sur la carte publique : rendu réel dans un DOM (jsdom), pas une
// lecture du fichier source -- même raison qu'en V66/V67 : un rendu
// sans cover ne doit produire aucune régression visuelle (repli
// exact sur le comportement actuel /banners/<slug>.jpg), ce qu'une
// assertion sur le code source seul ne peut pas vérifier.
//
// RestaurantHeader.tsx a de vraies dépendances (@/lib/*, @/components/*,
// dont certaines en JSX) : même technique qu'en V67
// (tests/v67-product-photos.dom.test.ts) -- esbuild.build() avec
// bundling réel et un plugin d'alias "@/" -> racine du dépôt.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", {
  value: window.navigator,
  configurable: true,
});
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const base = path.join(REPO_ROOT, rel);
      const candidate = ["", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

const entrySource = `
export { default as RestaurantHeader } from "@/components/RestaurantHeader";
export { I18nProvider } from "@/lib/i18n-context";
`;

const buildResult = await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "RestaurantHeader.mjs");
writeFileSync(tmpFile, code);
const { RestaurantHeader, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseRestaurant(configOverrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "Café Test",
    slug: "cafe-test-inexistant",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r1",
      max_tables: 10,
      currency: "DZD",
      whatsapp_number: "+213550000000",
      address: null,
      latitude: null,
      longitude: null,
      logo_url: null,
      cover_url: null,
      opening_hours: null,
      ...configOverrides,
    },
    categories: [],
    hiddenCategories: [],
  };
}

function render(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      I18nProvider,
      { lang: "fr" },
      React.createElement(RestaurantHeader, {
        restaurant,
        lang: "fr",
        onChangeLang: () => {},
      })
    )
  );
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function headerBackgroundImage(container: HTMLElement): string {
  const header = container.querySelector("header")!;
  return (header as HTMLElement).style.backgroundImage;
}

test("RestaurantHeader (DOM réel, scénario 12) : cover_url absente -- repli inchangé sur /banners/<slug>.jpg, aucune régression visuelle", async () => {
  const { container, root } = render(baseRestaurant({ cover_url: null }));
  await flush();

  const bg = headerBackgroundImage(container);
  assert.ok(
    bg.includes("/banners/cafe-test-inexistant.jpg"),
    `sans cover_url, le fond doit rester /banners/<slug>.jpg -- reçu: ${bg}`
  );
  assert.ok(container.textContent!.includes("Café Test"), "le reste de la carte doit rester intact");

  root.unmount();
  container.remove();
});

test("RestaurantHeader (DOM réel, scénario 11) : cover_url présente -- utilisée comme fond, PAS le repli /banners/<slug>.jpg", async () => {
  const coverUrl = "https://fake.supabase.co/storage/v1/object/public/establishment-assets/r1/cover/abc.jpg";
  const { container, root } = render(baseRestaurant({ cover_url: coverUrl }));
  await flush();

  const bg = headerBackgroundImage(container);
  assert.ok(bg.includes(coverUrl), `avec cover_url, le fond doit l'utiliser -- reçu: ${bg}`);
  assert.ok(!bg.includes("/banners/cafe-test-inexistant.jpg"), "le repli /banners/<slug>.jpg ne doit plus être utilisé quand cover_url est présente");

  root.unmount();
  container.remove();
});

test("RestaurantHeader (DOM réel) : logo_url absente -- aucune <img> logo rendue (comportement préexistant, non touché par V68)", async () => {
  const { container, root } = render(baseRestaurant({ logo_url: null }));
  await flush();

  assert.equal(container.querySelector("img"), null, "sans logo_url, aucune <img> ne doit être rendue");

  root.unmount();
  container.remove();
});

test("RestaurantHeader (DOM réel) : logo_url présente -- <img> logo rendue avec le bon src, cohabite avec une cover_url distincte", async () => {
  const logoUrl = "https://fake.supabase.co/storage/v1/object/public/establishment-assets/r1/logo/abc.png";
  const coverUrl = "https://fake.supabase.co/storage/v1/object/public/establishment-assets/r1/cover/xyz.jpg";
  const { container, root } = render(baseRestaurant({ logo_url: logoUrl, cover_url: coverUrl }));
  await flush();

  const img = container.querySelector("img");
  assert.ok(img, "une <img> logo doit être rendue quand logo_url est présente");
  assert.equal(img!.getAttribute("src"), logoUrl);
  assert.ok(headerBackgroundImage(container).includes(coverUrl), "cover_url reste utilisée comme fond, indépendamment du logo");

  root.unmount();
  container.remove();
});

// ====================================================================
// V69 — lien de localisation configurable (maps_url), CTA
// "Itinéraire" sur la page publique. Ajouté à ce fichier plutôt que
// dans un nouveau : réutilise le bundling esbuild déjà en place pour
// RestaurantHeader (même composant), pas de second harnais DOM créé
// pour ce seul ajout. Corrigé V71 (V70-06) : plus aucun repli
// implicite vers Google Maps depuis latitude/longitude.
// ====================================================================

test("RestaurantHeader (DOM réel, V69) : ni maps_url ni latitude/longitude -- aucun CTA maps rendu (comportement inchangé)", async () => {
  const { container, root } = render(
    baseRestaurant({ maps_url: null, latitude: null, longitude: null })
  );
  await flush();

  assert.equal(container.querySelector("a[target=\"_blank\"]"), null, "aucun lien maps ne doit être rendu sans URL ni coordonnées");

  root.unmount();
  container.remove();
});

test("RestaurantHeader (DOM réel, V71/corrige V70-06) : latitude/longitude seules (sans maps_url) -- AUCUN CTA fabriqué depuis les coordonnées, décision CTO explicite", async () => {
  const { container, root } = render(
    baseRestaurant({ maps_url: null, latitude: 36.75, longitude: 3.05 })
  );
  await flush();

  assert.equal(
    container.querySelector("a[target=\"_blank\"]"),
    null,
    "aucun lien ne doit être fabriqué depuis latitude/longitude seules -- corrige V70-06 : les coordonnées restent des données neutres, jamais transformées en lien Google implicite"
  );

  root.unmount();
  container.remove();
});

test("RestaurantHeader (DOM réel) : maps_url configurée, AVEC OU SANS coordonnées -- seul CTA possible, jamais de lien fabriqué en parallèle", async () => {
  const mapsUrl = "https://maps.app.goo.gl/abc123";
  const { container, root } = render(
    baseRestaurant({ maps_url: mapsUrl, latitude: 36.75, longitude: 3.05 })
  );
  await flush();

  const links = container.querySelectorAll("a[target=\"_blank\"]");
  assert.equal(links.length, 1, "un seul CTA maps possible, jamais deux");
  assert.equal(links[0].getAttribute("href"), mapsUrl, "maps_url doit être le seul lien utilisé");
  assert.ok(links[0].textContent!.includes("Itinéraire"), "le libellé doit être celui du lien configurable");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");

  root.unmount();
  container.remove();
});
