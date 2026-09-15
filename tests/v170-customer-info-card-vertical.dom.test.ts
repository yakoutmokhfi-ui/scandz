import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CUSTOMER INFO CARD / ADDRESS-HOURS REMEDIATION v1.1 — rendu RÉEL
// (jsdom + esbuild, même technique que tests/v169b-*) de
// components/RestaurantInfoBar.tsx (rendu via components/
// RestaurantHeader.tsx, seul point d'intégration réel) et de
// components/MenuView.tsx (non-régression du reste de la page).
//
// Couvre les 8 exigences A-H du mandat de remédiation, dans l'ordre.
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
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

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
export { default as MenuView } from "@/components/MenuView";
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
const tmpFile = path.join(tmpDir, "entry.mjs");
writeFileSync(tmpFile, code);
const { RestaurantHeader, MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const HOURS = "Lundi : 16h–20h\nMardi–Vendredi : 10h–14h / 16h–20h\nSamedi : 10h–19h30\nDimanche : Fermé";
const ADDRESS = "114 rue Ordener, 75018 Paris";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    restaurant_id: "r1",
    max_tables: 10,
    currency: "EUR",
    whatsapp_number: "+33600000000",
    address: ADDRESS,
    latitude: null,
    longitude: null,
    logo_url: null,
    cover_url: null,
    opening_hours: HOURS,
    maps_url: null,
    source_language: "fr",
    ...overrides,
  };
}

function baseRestaurant(categories: unknown[] = []) {
  return {
    id: "r1",
    name: "Fromagerie (test)",
    slug: "fromagerie-test-infocard",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: baseConfig(),
    categories,
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

function renderHeader(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(RestaurantHeader, {
      restaurant,
      lang: "fr",
      onChangeLang: () => {},
      theme: "classic",
      banner: undefined,
    })
  );
  return { container, root };
}

function renderMenu(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function boissonsCategory() {
  return {
    id: "cat-boissons",
    restaurant_id: "r1",
    name: "Boissons",
    display_order: 1,
    is_active: true,
    menu_items: [
      { id: "eau", category_id: "cat-boissons", subcategory_id: null, subcategory_name: null, name: "Eau", description: null, short_description: null, price: 2, image_url: null, display_order: 1, is_available: true },
    ],
  };
}

// --------------------------------------------------------------
// A. L'adresse apparaît AVANT les horaires.
// --------------------------------------------------------------
test("A. l'adresse apparaît avant les horaires dans le DOM", async () => {
  const { container, root } = renderHeader(baseRestaurant());
  try {
    await flush();
    const html = container.innerHTML;
    const addressIdx = html.indexOf(ADDRESS.replace(/[–]/g, "–"));
    const hoursIdx = html.indexOf("Lundi");
    assert.ok(addressIdx !== -1, "l'adresse doit être présente dans le DOM");
    assert.ok(hoursIdx !== -1, "les horaires doivent être présents dans le DOM");
    assert.ok(addressIdx < hoursIdx, "l'adresse doit apparaître AVANT les horaires dans l'ordre du DOM");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// B. Adresse et Horaires ne sont pas rendus en colonnes fixes
//    côte-à-côte.
// --------------------------------------------------------------
test("B. adresse et horaires ne sont pas rendus dans des colonnes fixes côte-à-côte (aucune grille CSS)", async () => {
  const { container, root } = renderHeader(baseRestaurant());
  try {
    await flush();
    assert.equal(container.querySelector(".grid"), null, "aucun conteneur '.grid' ne doit exister autour de l'adresse/des horaires");
    const stack = container.querySelector(".flex-col");
    assert.ok(stack, "un conteneur vertical (flex-col) doit envelopper adresse/horaires");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// C. Les horaires reçoivent une disposition pleine largeur.
// --------------------------------------------------------------
test("C. les horaires reçoivent une disposition pleine largeur (w-full, aucun col-span)", async () => {
  const { container, root } = renderHeader(baseRestaurant());
  try {
    await flush();
    const hoursCell = container.querySelector("span.whitespace-pre-wrap");
    assert.ok(hoursCell, "la cellule horaires doit être présente");
    const hoursRow = hoursCell!.closest(".flex.w-full") ?? hoursCell!.closest('[class*="w-full"]');
    assert.ok(hoursRow, "la ligne des horaires doit porter w-full");
    assert.ok(!hoursRow!.className.includes("col-span"), "la ligne des horaires ne doit porter aucun col-span");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// D. L'adresse configurée par le commerçant est préservée.
// --------------------------------------------------------------
test("D. l'adresse configurée par le commerçant est préservée telle quelle", async () => {
  const { container, root } = renderHeader(baseRestaurant());
  try {
    await flush();
    assert.ok(container.textContent?.includes(ADDRESS), "l'adresse exacte configurée doit apparaître, sans altération");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// E. Les horaires configurés par le commerçant sont préservés.
// --------------------------------------------------------------
test("E. les horaires configurés par le commerçant sont préservés telles quelles, retours à la ligne compris", async () => {
  const { container, root } = renderHeader(baseRestaurant());
  try {
    await flush();
    const hoursCell = container.querySelector("span.whitespace-pre-wrap");
    assert.ok(hoursCell);
    assert.equal(hoursCell!.textContent, HOURS, "le texte des horaires doit être identique, caractère pour caractère, y compris les \\n");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// F. Le rendu mobile reste utilisable (contrainte jsdom : preuve
//    structurelle -- pas de classe de largeur minimale forcée qui
//    déborderait un petit écran, pas de grille réintroduite en-deçà
//    d'un palier).
// --------------------------------------------------------------
test("F. rendu mobile : aucune classe de largeur minimale forcée ni de grille conditionnelle en-deçà d'un palier -- reste utilisable sur petit écran", async () => {
  const { container, root } = renderHeader(baseRestaurant());
  try {
    await flush();
    const rows = Array.from(container.querySelectorAll(".flex-col > *"));
    assert.ok(rows.length >= 2, "au moins adresse + horaires doivent être présents");
    for (const row of rows) {
      assert.ok(!/\bmin-w-\[/.test(row.className), "aucune largeur minimale forcée ne doit risquer un débordement sur mobile");
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// G. Le rendu desktop reste vertical (jamais de retour à un layout en
//    colonnes à un palier plus large -- preuve structurelle, cohérente
//    avec F : aucune classe sm:/md:/lg: ne réintroduit une grille).
// --------------------------------------------------------------
test("G. rendu desktop : reste vertical -- aucune classe sm:/md:/lg: ne réintroduit une disposition en colonnes", async () => {
  const { container, root } = renderHeader(baseRestaurant());
  try {
    await flush();
    const rows = Array.from(container.querySelectorAll(".flex-col > *"));
    for (const row of rows) {
      assert.ok(
        !/(sm|md|lg):(grid|col-span|w-)/.test(row.className),
        `aucune classe responsive ne doit réintroduire un layout en colonnes à un palier plus large, reçu: "${row.className}"`
      );
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// H. Le comportement existant de l'en-tête / du menu marchand reste
//    inchangé (non-régression : rendu complet de MenuView avec
//    adresse + horaires configurés, catégorie et produit toujours
//    affichés normalement).
// --------------------------------------------------------------
test("H. non-régression : MenuView complet (en-tête + catégories + produits) reste fonctionnel avec adresse/horaires configurés", async () => {
  const restaurant = baseRestaurant([boissonsCategory()]);
  const { container, root } = renderMenu(restaurant);
  try {
    await flush();
    assert.ok(container.textContent?.includes(ADDRESS), "l'adresse doit toujours apparaître dans le rendu complet du menu");
    assert.ok(container.textContent?.includes("Lundi"), "les horaires doivent toujours apparaître dans le rendu complet du menu");
    assert.ok(container.textContent?.includes("Boissons"), "la catégorie doit toujours s'afficher normalement");
    assert.ok(container.textContent?.includes("Eau"), "le produit doit toujours s'afficher normalement");
  } finally {
    root.unmount();
    container.remove();
  }
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") {
      h.unref();
    }
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
