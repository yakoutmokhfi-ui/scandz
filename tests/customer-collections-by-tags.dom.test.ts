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
// Scanym — P1 CUSTOMER COLLECTIONS BY TAGS — rendu RÉEL de MenuView
// (jsdom), même technique que tests/lot02-sticky-subcategories.dom.
// test.ts (bundling esbuild réel + alias "@/").
//
// Couvre : §1 seules les collections publiées (non vides) sont rendues,
// §2 aucun tag interne découvrable, §4 une collection sélectionne dans
// plusieurs catégories/sous-catégories, §5 ordre serveur, §6 retour au
// catalogue normal restaure catégorie + sous-catégorie, §7 badges
// inchangés, §8 identifiants inconnus sans effet, §11 une seule ligne
// défilable non repliée, §12 nav nommée + vrais boutons + aria-pressed
// + focus clavier, §14 aucune collection -> catalogue normal intact.
// Le panier n'est pas affecté par le mode collection.
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

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as MenuView } from "@/components/MenuView";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --------------------------------------------------------------------
// Fixtures : 2 catégories affichées, sous-catégories dans chacune.
// --------------------------------------------------------------------
const RACLETTE = { id: "sub-raclette", name: "Raclette", order: 1 };
const CHEVRES = { id: "sub-chevres", name: "Chèvres", order: 2 };
const BLANCS = { id: "sub-blancs", name: "Blancs", order: 1 };

function product(
  catId: string,
  id: string,
  sub: { id: string; name: string; order: number } | null,
  order: number,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    category_id: catId,
    subcategory_id: sub?.id ?? null,
    subcategory_name: sub?.name ?? null,
    subcategory_display_order: sub?.order ?? null,
    name: id,
    description: null,
    short_description: null,
    price: 4,
    image_url: null,
    display_order: order,
    is_available: true,
    ...extra,
  };
}

function categories() {
  return [
    {
      id: "cat-fromages",
      restaurant_id: "r1",
      name: "Fromages",
      display_order: 1,
      is_active: true,
      menu_items: [
        product("cat-fromages", "Tomme directe", null, 1, { customer_tags: ["Apéro"] }),
        product("cat-fromages", "Raclette fumée", RACLETTE, 1, { customer_tags: ["Apéro"] }),
        product("cat-fromages", "Raclette nature", RACLETTE, 2),
        product("cat-fromages", "Crottin", CHEVRES, 1, { customer_tags: ["Bio"] }),
      ],
    },
    {
      id: "cat-vins",
      restaurant_id: "r1",
      name: "Vins",
      display_order: 2,
      is_active: true,
      menu_items: [
        product("cat-vins", "Rouge maison", null, 1),
        product("cat-vins", "Chablis", BLANCS, 1, { customer_tags: ["Apéro"] }),
      ],
    },
  ];
}

/** Sortie du service (déjà ordonnée par display_order serveur). */
const PUBLISHED = [
  { id: "t-apero", label: "Apéro", displayOrder: 1, menuItemIds: ["Chablis", "Raclette fumée", "Tomme directe"] },
  { id: "t-bio", label: "Bio", displayOrder: 2, menuItemIds: ["Crottin"] },
];

function restaurant(collections?: unknown) {
  const r: Record<string, unknown> = {
    id: "r1",
    name: "Fromagerie (test)",
    slug: "fromagerie-test",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
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
    },
    categories: categories(),
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
  if (collections !== undefined) r.collections = collections;
  return r;
}

async function render(r: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: r }));
  await flush();
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function secondaryNav(c: Element): HTMLElement | null {
  return c.querySelector("nav[data-category-secondary-filters]");
}

function tagButtons(c: Element): HTMLButtonElement[] {
  return [...c.querySelectorAll("[data-category-tag-option]")] as HTMLButtonElement[];
}

function tagButton(c: Element, label: string): HTMLButtonElement {
  const b = tagButtons(c).find((x) => x.textContent === label);
  assert.ok(b, `filtre de tag '${label}' attendu`);
  return b!;
}

function categoryButton(c: Element, label: string): HTMLButtonElement {
  const btn = [...c.querySelectorAll("nav:not([aria-label]) button")].find((b) =>
    b.textContent?.includes(label)
  ) as HTMLButtonElement | undefined;
  assert.ok(btn, `bouton de catégorie '${label}' attendu`);
  return btn!;
}

function pressedCategories(c: Element): string[] {
  return [...c.querySelectorAll('nav:not([aria-label]) button[aria-pressed="true"]')].map(
    (b) => b.textContent ?? ""
  );
}

function subcategoryPill(c: Element, label: string): HTMLButtonElement {
  const b = [...c.querySelectorAll("[data-subcategory-filter-option]")].find(
    (x) => x.textContent === label
  ) as HTMLButtonElement | undefined;
  assert.ok(b, `pilule de sous-catégorie '${label}' attendue`);
  return b!;
}

function pressedSubcategories(c: Element): string[] {
  return [...c.querySelectorAll('[data-subcategory-filter-option][aria-pressed="true"]')].map(
    (b) => b.textContent ?? ""
  );
}

function cardNames(c: Element): string[] {
  return [...c.querySelectorAll("main article h3")].map((h) => (h.textContent ?? "").trim());
}

function sectionTitle(c: Element): string {
  return (c.querySelector("main section h2")?.textContent ?? "").trim();
}

function badgesOf(c: Element, productName: string): string[] {
  const card = [...c.querySelectorAll("main article")].find((a) =>
    (a.querySelector("h3")?.textContent ?? "").trim() === productName
  );
  assert.ok(card, `carte '${productName}' attendue`);
  return [...card!.querySelectorAll("[data-product-tags] > li")].map((li) => li.textContent ?? "");
}

function cleanup(x: { container: HTMLElement; root: any }) {
  x.root.unmount();
  x.container.remove();
}

// ====================================================================

test("[NO TAG] sans tag public, le catalogue et ses sous-catégories restent inchangés", async () => {
  for (const r of [restaurant(), restaurant([])]) {
    const x = await render(r);
    assert.equal(tagButtons(x.container).length, 0);
    assert.equal(sectionTitle(x.container), "Fromages");
    assert.deepEqual(pressedCategories(x.container), ["Fromages"]);
    assert.deepEqual(cardNames(x.container), ["Tomme directe", "Raclette fumée", "Raclette nature", "Crottin"]);
    cleanup(x);
  }
});

test("[CONTEXT][ORDER][A11Y] seuls les tags utilisés dans la catégorie active sont des boutons secondaires ordonnés", async () => {
  const x = await render(restaurant(PUBLISHED));
  const nav = secondaryNav(x.container);
  assert.ok(nav, "la navigation secondaire doit être rendue");
  assert.equal(nav!.tagName, "NAV");
  assert.deepEqual(tagButtons(x.container).map((b) => b.textContent), ["Apéro", "Bio"]);
  for (const b of tagButtons(x.container)) {
    assert.equal(b.tagName, "BUTTON");
    assert.equal(b.getAttribute("type"), "button");
    assert.equal(b.getAttribute("aria-pressed"), "false");
    assert.notEqual(b.getAttribute("tabindex"), "-1", "atteignable au clavier");
  }
  const apero = tagButton(x.container, "Apéro");
  apero.focus();
  assert.equal(window.document.activeElement, apero);
  cleanup(x);
});

test("[INTERNAL] aucun identifiant interne de tag n'est exposé dans le DOM", async () => {
  const x = await render(restaurant(PUBLISHED));
  const html = secondaryNav(x.container)!.outerHTML;
  assert.equal(html.includes("t-apero") || html.includes("t-bio"), false, "aucun identifiant de tag dans le DOM");
  cleanup(x);
});

test("[CATEGORY SCOPE][BADGES] un tag ne montre que les produits de la catégorie active et conserve les badges", async () => {
  const x = await render(restaurant(PUBLISHED));
  click(tagButton(x.container, "Apéro"));
  await flush();
  assert.equal(sectionTitle(x.container), "Fromages");
  assert.deepEqual(cardNames(x.container), ["Tomme directe", "Raclette fumée"]);
  assert.equal(cardNames(x.container).includes("Chablis"), false, "aucune fuite depuis Vins");
  assert.equal(tagButton(x.container, "Apéro").getAttribute("aria-pressed"), "true");
  assert.deepEqual(badgesOf(x.container, "Raclette fumée"), ["Apéro"]);
  cleanup(x);
});

test("[COMBINED][TOUS] sous-catégorie ET tag sont déterministes ; Tous restaure la catégorie complète", async () => {
  const x = await render(restaurant(PUBLISHED));
  click(subcategoryPill(x.container, "Raclette"));
  await flush();
  assert.deepEqual(cardNames(x.container), ["Raclette fumée", "Raclette nature"]);
  click(tagButton(x.container, "Apéro"));
  await flush();
  assert.deepEqual(cardNames(x.container), ["Raclette fumée"]);
  assert.deepEqual(pressedSubcategories(x.container), ["Raclette"]);
  assert.equal(tagButton(x.container, "Apéro").getAttribute("aria-pressed"), "true");
  click(subcategoryPill(x.container, "Tous"));
  await flush();
  assert.deepEqual(pressedSubcategories(x.container), ["Tous"]);
  assert.deepEqual(cardNames(x.container), ["Tomme directe", "Raclette fumée", "Raclette nature", "Crottin"]);
  cleanup(x);
});

test("[CATEGORY CHANGE] le tag est réinitialisé et les tags sont recalculés pour la nouvelle catégorie", async () => {
  const x = await render(restaurant(PUBLISHED));
  click(tagButton(x.container, "Bio"));
  await flush();
  click(categoryButton(x.container, "Vins"));
  await flush();
  assert.equal(sectionTitle(x.container), "Vins");
  assert.deepEqual(pressedCategories(x.container), ["Vins"]);
  assert.deepEqual(cardNames(x.container), ["Rouge maison", "Chablis"]);
  assert.deepEqual(tagButtons(x.container).map((b) => b.textContent), ["Apéro"]);
  assert.equal(tagButton(x.container, "Apéro").getAttribute("aria-pressed"), "false");
  cleanup(x);
});

test("[FAIL-CLOSED] identifiants étrangers ignorés ; tag absent de la catégorie caché", async () => {
  const x = await render(
    restaurant([
      { id: "t-mix", label: "Mix", displayOrder: 1, menuItemIds: ["foreign-tenant-b-product", "Rouge maison"] },
      { id: "t-foreign", label: "Étrangère", displayOrder: 2, menuItemIds: ["foreign-tenant-b-product"] },
    ])
  );
  assert.deepEqual(tagButtons(x.container).map((b) => b.textContent), [], "Mix n'est pas utilisé dans Fromages");
  click(categoryButton(x.container, "Vins"));
  await flush();
  assert.deepEqual(tagButtons(x.container).map((b) => b.textContent), ["Mix"]);
  click(tagButton(x.container, "Mix"));
  await flush();
  assert.deepEqual(cardNames(x.container), ["Rouge maison"]);
  assert.equal((x.container.textContent ?? "").includes("foreign-tenant-b-product"), false);
  assert.equal((x.container.textContent ?? "").includes("Étrangère"), false);
  cleanup(x);
});

test("[RESPONSIVE] catégories classic/editorial non sticky sur mobile et sticky desktop ; filtres repliés sans scroll horizontal", async () => {
  const longUnbrokenLabel = "X".repeat(60);
  const x = await render(restaurant([
    ...PUBLISHED,
    { id: "t-long", label: longUnbrokenLabel, displayOrder: 3, menuItemIds: ["Tomme directe"] },
  ]));
  const categoryNav = x.container.querySelector("[data-category-navigation]")!;
  const categoryClasses = (categoryNav.getAttribute("class") ?? "").split(/\s+/);
  assert.equal(categoryClasses.includes("sticky"), false);
  assert.ok(categoryClasses.includes("sm:sticky") && categoryClasses.includes("sm:top-0"));
  const rowClasses = (secondaryNav(x.container)!.querySelector("ul")!.getAttribute("class") ?? "").split(/\s+/);
  assert.ok(rowClasses.includes("flex-wrap"));
  assert.equal(rowClasses.includes("overflow-x-auto"), false);
  for (const button of secondaryNav(x.container)!.querySelectorAll("button")) {
    const buttonClasses = (button.getAttribute("class") ?? "").split(/\s+/);
    const itemClasses = (button.parentElement!.getAttribute("class") ?? "").split(/\s+/);
    assert.ok(buttonClasses.includes("max-w-full") && buttonClasses.includes("[overflow-wrap:anywhere]"));
    assert.ok(itemClasses.includes("min-w-0") && itemClasses.includes("max-w-full"));
    assert.equal(buttonClasses.includes("whitespace-nowrap"), false);
  }
  assert.ok(tagButton(x.container, longUnbrokenLabel), "tag public maximal sans espace rendu sans élargir son item flex");
  cleanup(x);

  const editorialRestaurant = restaurant(PUBLISHED);
  editorialRestaurant.slug = "le-sirocco";
  const editorial = await render(editorialRestaurant);
  const editorialClasses = (
    editorial.container.querySelector("[data-category-navigation]")!.getAttribute("class") ?? ""
  ).split(/\s+/);
  assert.equal(editorialClasses.includes("sticky"), false);
  assert.ok(editorialClasses.includes("sm:sticky") && editorialClasses.includes("sm:top-0"));
  cleanup(editorial);
});

test("[CART] filtrer par tag ne duplique ni ne remplace le produit du panier", async () => {
  const x = await render(restaurant(PUBLISHED));
  click(tagButton(x.container, "Bio"));
  await flush();
  const card = [...x.container.querySelectorAll("main article")].find((a) =>
    (a.textContent ?? "").includes("Crottin")
  )!;
  const add = [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Ajouter");
  assert.ok(add, "bouton Ajouter attendu");
  click(add!);
  await flush();
  assert.ok((x.container.textContent ?? "").includes("1 article"), "barre panier : 1 article");

  click(subcategoryPill(x.container, "Tous"));
  await flush();
  assert.ok((x.container.textContent ?? "").includes("1 article"), "le panier est conservé");
  click(subcategoryPill(x.container, "Chèvres"));
  await flush();
  const normalCard = [...x.container.querySelectorAll("main article")].find((a) =>
    (a.textContent ?? "").includes("Crottin")
  )!;
  assert.equal(
    [...normalCard.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "Ajouter"),
    false,
    "la navigation normale voit la même quantité (stepper affiché, plus de bouton Ajouter)"
  );
  cleanup(x);
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
