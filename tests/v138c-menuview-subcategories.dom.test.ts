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
// CATALOGUE / SUBCATEGORIES v1 — rendu RÉEL de MenuView (jsdom), même
// technique/patron que tests/v80-lot1a1-menuview-lang.dom.test.ts
// (bundling esbuild réel + alias "@/", pas une réimplémentation) :
// vérifie que le sous-titre visuel de sous-catégorie n'apparaît que
// pour les commerçants qui en utilisent, et que le rendu d'un
// commerçant SANS sous-catégorie reste identique au comportement
// historique (aucun <h3> de sous-catégorie, aucune régression de
// contenu/ordre).
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
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseConfig() {
  return {
    restaurant_id: "r1",
    max_tables: 10,
    currency: "EUR",
    whatsapp_number: "+33600000000",
    address: null,
    latitude: null,
    longitude: null,
    logo_url: null,
    cover_url: null,
    opening_hours: null,
    source_language: "fr",
  };
}

function baseRestaurant(categories: unknown[]) {
  return {
    id: "r1",
    name: "Au Lait Cru (test)",
    slug: "au-lait-cru-test",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: baseConfig(),
    categories,
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

function render(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("MenuView (DOM réel) : catégorie SANS sous-catégorie (ex. Boissons -- Eau/Jus) -- AUCUN <h3> de sous-titre, les 2 produits s'affichent tels quels (non-régression stricte du rendu historique)", async () => {
  const restaurant = baseRestaurant([
    {
      id: "cat-boissons",
      restaurant_id: "r1",
      name: "Boissons",
      display_order: 1,
      is_active: true,
      menu_items: [
        {
          id: "item-eau",
          category_id: "cat-boissons",
          subcategory_id: null,
          subcategory_name: null,
          name: "Eau",
          description: null,
          short_description: null,
          price: 2,
          image_url: null,
          display_order: 1,
          is_available: true,
        },
        {
          id: "item-jus",
          category_id: "cat-boissons",
          subcategory_id: null,
          subcategory_name: null,
          name: "Jus",
          description: null,
          short_description: null,
          price: 3,
          image_url: null,
          display_order: 2,
          is_available: true,
        },
      ],
    },
  ]);

  const { container, root } = render(restaurant);
  try {
    await flush();

    assert.equal(
      container.querySelectorAll('[data-subcategory-heading="true"]').length,
      0,
      "aucun sous-titre de sous-catégorie ne doit apparaître pour un commerçant qui n'en utilise aucune"
    );
    assert.ok(container.textContent?.includes("Eau"));
    assert.ok(container.textContent?.includes("Jus"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("MenuView (DOM réel) : catégorie AVEC sous-catégorie (Fromages -- Chèvres : Charolais/Pélardon) -- le nom de la sous-catégorie apparaît comme sous-titre, les produits restent affichés", async () => {
  const restaurant = baseRestaurant([
    {
      id: "cat-fromages",
      restaurant_id: "r1",
      name: "Fromages",
      display_order: 1,
      is_active: true,
      menu_items: [
        {
          id: "item-charolais",
          category_id: "cat-fromages",
          subcategory_id: "sub-chevres",
          subcategory_name: "Chèvres",
          name: "Charolais",
          description: null,
          short_description: null,
          price: 4.5,
          image_url: null,
          display_order: 1,
          is_available: true,
        },
        {
          id: "item-pelardon",
          category_id: "cat-fromages",
          subcategory_id: "sub-chevres",
          subcategory_name: "Chèvres",
          name: "Pélardon",
          description: null,
          short_description: null,
          price: 5,
          image_url: null,
          display_order: 2,
          is_available: true,
        },
      ],
    },
  ]);

  const { container, root } = render(restaurant);
  try {
    await flush();

    const headings = Array.from(container.querySelectorAll('[data-subcategory-heading="true"]')).map(
      (h) => h.textContent
    );
    assert.ok(headings.includes("Chèvres"), "le nom de la sous-catégorie doit apparaître comme sous-titre");
    assert.ok(container.textContent?.includes("Charolais"));
    assert.ok(container.textContent?.includes("Pélardon"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("MenuView (DOM réel) : catégorie mixte -- produits directs (Reblochon) PUIS une sous-catégorie (Chèvres) -- un seul sous-titre, précédé des produits directs sans sous-titre", async () => {
  const restaurant = baseRestaurant([
    {
      id: "cat-fromages",
      restaurant_id: "r1",
      name: "Fromages",
      display_order: 1,
      is_active: true,
      menu_items: [
        {
          id: "item-reblochon",
          category_id: "cat-fromages",
          subcategory_id: null,
          subcategory_name: null,
          name: "Reblochon",
          description: null,
          short_description: null,
          price: 6,
          image_url: null,
          display_order: 1,
          is_available: true,
        },
        {
          id: "item-charolais",
          category_id: "cat-fromages",
          subcategory_id: "sub-chevres",
          subcategory_name: "Chèvres",
          name: "Charolais",
          description: null,
          short_description: null,
          price: 4.5,
          image_url: null,
          display_order: 1,
          is_available: true,
        },
      ],
    },
  ]);

  const { container, root } = render(restaurant);
  try {
    await flush();

    const headings = Array.from(container.querySelectorAll('[data-subcategory-heading="true"]')).map(
      (h) => h.textContent
    );
    assert.deepEqual(headings, ["Chèvres"], "un seul sous-titre attendu -- les produits directs n'en reçoivent jamais");
    assert.ok(container.textContent?.includes("Reblochon"));
    assert.ok(container.textContent?.includes("Charolais"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("MenuView (DOM réel) : remédiation CAT-SUB-V1-PUBLIC-GROUPING-01 -- 2 sous-catégories de MÊME display_order, triées par le VRAI compareMenuItemsForPublicDisplay (comme le ferait lib/services/restaurant.ts) -- exactement 2 sous-titres, chacun une seule fois, aucune clé React dupliquée, aucun entrelacement visible", async () => {
  const { compareMenuItemsForPublicDisplay } = await import("../lib/catalogue-subcategory-grouping.ts");

  // Chèvres et Vaches partagent le MÊME display_order (1) -- la
  // collision exacte décrite par le finding Work. L'ordre D'ENTRÉE est
  // délibérément déjà entrelacé (A1, B2, A3, B4) pour prouver que
  // c'est bien le tri qui regroupe, pas un ordre d'entrée qui aiderait
  // artificiellement le test.
  const rawItems = [
    {
      id: "item-charolais",
      category_id: "cat-fromages",
      subcategory_id: "sub-chevres",
      subcategory_name: "Chèvres",
      subcategory_display_order: 1,
      name: "Charolais",
      description: null,
      short_description: null,
      price: 4.5,
      image_url: null,
      display_order: 1,
      is_available: true,
    },
    {
      id: "item-camembert",
      category_id: "cat-fromages",
      subcategory_id: "sub-vaches",
      subcategory_name: "Vaches",
      subcategory_display_order: 1,
      name: "Camembert",
      description: null,
      short_description: null,
      price: 5,
      image_url: null,
      display_order: 2,
      is_available: true,
    },
    {
      id: "item-pelardon",
      category_id: "cat-fromages",
      subcategory_id: "sub-chevres",
      subcategory_name: "Chèvres",
      subcategory_display_order: 1,
      name: "Pélardon",
      description: null,
      short_description: null,
      price: 5.5,
      image_url: null,
      display_order: 3,
      is_available: true,
    },
    {
      id: "item-tomme",
      category_id: "cat-fromages",
      subcategory_id: "sub-vaches",
      subcategory_name: "Vaches",
      subcategory_display_order: 1,
      name: "Tomme",
      description: null,
      short_description: null,
      price: 6,
      image_url: null,
      display_order: 4,
      is_available: true,
    },
  ];

  // Même étape que lib/services/restaurant.ts : trier AVANT de
  // transmettre à MenuView (MenuView ne trie jamais lui-même, il fait
  // confiance à l'ordre reçu -- voir groupMenuItemsBySubcategory).
  const sortedItems = [...rawItems].sort(compareMenuItemsForPublicDisplay);

  const restaurant = baseRestaurant([
    {
      id: "cat-fromages",
      restaurant_id: "r1",
      name: "Fromages",
      display_order: 1,
      is_active: true,
      menu_items: sortedItems,
    },
  ]);

  const { container, root } = render(restaurant);
  try {
    await flush();

    const headingEls = Array.from(container.querySelectorAll('[data-subcategory-heading="true"]'));
    const headings = headingEls.map((h) => h.textContent);
    assert.deepEqual(headings, ["Chèvres", "Vaches"], "exactement 2 sous-titres, chacun une seule fois -- jamais répété par un entrelacement");

    // Reconstruit l'ordre des noms de produit affichés pour vérifier
    // qu'aucun entrelacement n'est visible dans le DOM lui-même.
    const productNames = Array.from(container.querySelectorAll("h3"))
      .map((h) => h.textContent)
      .filter((t): t is string => t !== null && !["Chèvres", "Vaches"].includes(t));
    assert.deepEqual(productNames, ["Charolais", "Pélardon", "Camembert", "Tomme"]);
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
