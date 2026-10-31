import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

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
const { supabase } = await import("../lib/supabase.ts");
const { ORDER_NOTE_MAX_LENGTH } = await import("../lib/order-note.ts");

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
      const resolvedPath = candidate ?? base;
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

const entrySource = `
export { default as MenuView } from "@/components/MenuView";
export { default as OrderHelpButton } from "@/components/OrderHelpButton";
export { DeliveryConditionsButton } from "@/components/DeliveryConditions";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-psearch-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView, OrderHelpButton, DeliveryConditionsButton, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 3000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(intervalMs);
  }
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function buttonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

function inputById(container: Element, id: string): HTMLInputElement | null {
  return container.querySelector(`#${id}`);
}

function selectServiceMode(container: Element, label: string) {
  const btn = buttonWithText(container, label);
  assert.ok(btn, `le bouton de mode "${label}" doit être présent`);
  click(btn!);
}


import { clearTestCartSession } from "./helpers/cart-session-isolation.ts";

const SALE_MODE_CATALOG_ROWS = [
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];
const PICKUP_SALE_MODE_ROWS = [
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "delivery", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];

function mockRpc(t: { mock: { method: Function } }) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_restaurant_public_sale_modes") return { data: PICKUP_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    if (name === "get_checkout_fulfillment_schedule") return { data: [{ schedule_status: "absent" }], error: null };
    if (name === "get_restaurant_public_communication_texts") return { data: [], error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  (globalThis as any).fetch = async (input: unknown) => { throw new Error(`requête sortante inattendue : ${String(input)}`); };
}

type Item = Record<string, unknown>;
function item(id: string, categoryId: string, name: string, extra: Item = {}): Item {
  return {
    id, category_id: categoryId, name, description: null, short_description: null,
    price: 5, image_url: null, display_order: 1, is_available: true, ...extra,
  };
}

/** Établissement de test : 12 produits publiés répartis sur 3 catégories, plus un produit
 *  ARCHIVÉ et une catégorie MASQUÉE qui ne doivent jamais être trouvés. */
function fromagerie(opts: { id?: string; slug?: string; lang?: "fr" | "ar"; extraItems?: Item[] } = {}) {
  const id = opts.id ?? "r-fromagerie";
  const slug = opts.slug ?? "fromagerie-test";
  const fromages = [
    item("i-fumee", "c-fromages", "Raclette fumée", { image_url: "https://img.example/fumee.jpg" }),
    item("i-ail", "c-fromages", "Raclette à l’ail des ours", {
      name_hash: "h-ail",
      translations: { ar: { name: "راكليت بالثوم البري", name_status: "validated", name_source_hash: "h-ail" } },
    }),
    item("i-fenugrec", "c-fromages", "Raclette au fenugrec"),
    item("i-comte", "c-fromages", "Comté 24 mois"),
    item("i-epoisses", "c-fromages", "Époisses"),
    item("i-menthe-f", "c-fromages", "Fromage frais à la menthe"),
    item("i-vieux", "c-fromages", "Vieux produit archivé", { archived_at: "2026-01-01T00:00:00Z" }),
    ...(opts.extraItems ?? []),
    // Les produits d'une sous-catégorie viennent APRÈS les produits directs, comme dans le catalogue public.
    item("i-crottin", "c-fromages", "Crottin de chèvre", { subcategory_id: "s-chevres", subcategory_name: "Chèvres" }),
  ];
  const charcuterie = [
    item("i-jambon", "c-charcuterie", "Jambon d'Auvergne"),
    item("i-saucisson", "c-charcuterie", "Saucisson sec"),
    item("i-rillettes", "c-charcuterie", "Rillettes de canard"),
  ];
  const boissons = [
    item("i-cidre", "c-boissons", "Cidre brut"),
    item("i-the", "c-boissons", "Thé à la menthe"),
  ];
  const cat = (cid: string, name: string, order: number, items: Item[]) => ({
    id: cid, restaurant_id: id, name, display_order: order, is_active: true, menu_items: items,
  });
  return {
    id, name: "Fromagerie (test)", slug, is_active: true, created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: id, max_tables: 10, currency: "EUR", whatsapp_number: "+33600000000",
      address: null, latitude: null, longitude: null, logo_url: null, cover_url: null,
      opening_hours: null, source_language: "fr",
    },
    categories: [
      cat("c-fromages", "Fromages", 1, fromages),
      cat("c-charcuterie", "Charcuterie", 2, charcuterie),
      cat("c-boissons", "Boissons", 3, boissons),
    ],
    hiddenCategories: [{
      id: "c-secret", restaurant_id: id, name: "Goûts secrets", display_order: 9, is_active: false,
      menu_items: [item("i-secret", "c-secret", "Goût secret")],
    }],
    activeLanguages: [
      { code: "fr", label: "Français", dir: "ltr", display_order: 1 },
      ...(opts.lang === "ar" || true ? [{ code: "ar", label: "العربية", dir: "rtl", display_order: 2 }] : []),
    ],
  };
}

/** Petit établissement : moins de produits que le seuil, donc sans champ de recherche. */
function smallRestaurant() {
  const r = fromagerie({ id: "r-small", slug: "petit-test" }) as any;
  r.categories = [{ ...r.categories[2], menu_items: r.categories[2].menu_items }];
  return r;
}

async function mount(restaurant: any) {
  clearTestCartSession(window.sessionStorage);
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush(60);
  return { container, root };
}
function done(view: { container: Element; root: { unmount(): void } }) {
  view.root.unmount();
  view.container.remove();
  clearTestCartSession(window.sessionStorage);
}

const searchInput = (c: Element) => c.querySelector<HTMLInputElement>('[data-product-search="true"] input');
const resultsSection = (c: Element) => c.querySelector('[data-product-search-results="true"]');
const names = (c: Element) =>
  [...(resultsSection(c)?.querySelectorAll("h3:not([data-subcategory-heading])") ?? [])].map((h) => h.textContent ?? "");
const categoryHeadings = (c: Element) => [...(resultsSection(c)?.querySelectorAll("h2") ?? [])].map((h) => h.textContent ?? "");
const status = (c: Element) => c.querySelector('[data-product-search-status="true"]')?.textContent ?? "";
const mainText = (c: Element) => c.querySelector("main")?.textContent ?? "";
async function type(c: Element, value: string) {
  const input = searchInput(c);
  assert.ok(input, "le champ de recherche doit être présent");
  setNativeValue(input!, value);
  await flush(30);
}
const cartBarText = (c: Element) => [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"))?.textContent ?? "";

test("[PS-1] le champ est proposé à partir d'un catalogue de taille suffisante, avec libellé, rôle search et sans effet sur la vue par défaut", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    const field = view.container.querySelector('[role="search"]');
    assert.ok(field, "région de recherche");
    const input = searchInput(view.container)!;
    assert.equal(input.type, "search");
    const label = view.container.querySelector(`label[for="${input.id}"]`);
    assert.equal(label?.textContent, "Rechercher un produit");
    assert.equal(resultsSection(view.container), null, "sans saisie, aucune section de résultats");
    assert.match(mainText(view.container), /Raclette fumée/, "la catégorie active reste affichée");
  } finally { done(view); }
});

test("[PS-2] un petit catalogue n'affiche pas de champ de recherche", async (t) => {
  mockRpc(t);
  const view = await mount(smallRestaurant());
  try {
    assert.equal(searchInput(view.container), null);
  } finally { done(view); }
});

test("[PS-3] insensible à la casse et aux accents, apostrophes droites ou courbes, mots dans le désordre", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    await type(view.container, "EPOISSES");
    assert.deepEqual(names(view.container), ["Époisses"]);
    await type(view.container, "epoisses");
    assert.deepEqual(names(view.container), ["Époisses"]);
    await type(view.container, "l'ail ours");
    assert.deepEqual(names(view.container), ["Raclette à l’ail des ours"]);
    await type(view.container, "OURS   raclette");
    assert.deepEqual(names(view.container), ["Raclette à l’ail des ours"]);
    await type(view.container, "fumee");
    assert.deepEqual(names(view.container), ["Raclette fumée"]);
    await type(view.container, "d auvergne");
    assert.deepEqual(names(view.container), ["Jambon d'Auvergne"]);
  } finally { done(view); }
});

test("[PS-4] la recherche est globale : résultats de plusieurs catégories, groupés dans l'ordre de la vitrine, avec compteur", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    await type(view.container, "menthe");
    assert.deepEqual(names(view.container), ["Fromage frais à la menthe", "Thé à la menthe"]);
    assert.deepEqual(categoryHeadings(view.container).map((h) => h.toLowerCase()), ["fromages", "boissons"]);
    assert.equal(status(view.container), "2 résultats");
    await type(view.container, "cidre");
    assert.equal(status(view.container), "1 résultat");
    await type(view.container, "raclette");
    assert.deepEqual(names(view.container), ["Raclette fumée", "Raclette à l’ail des ours", "Raclette au fenugrec"]);
  } finally { done(view); }
});

test("[PS-5] aucun résultat : message clair, bouton d'effacement, retour à la vue normale", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    await type(view.container, "zzzz");
    assert.match(status(view.container), /Aucun produit ne correspond à « zzzz »/);
    assert.deepEqual(names(view.container), []);
    click(view.container.querySelector('[data-product-search-reset="true"]')!);
    await flush(30);
    assert.equal(searchInput(view.container)!.value, "");
    assert.equal(resultsSection(view.container), null);
    assert.match(mainText(view.container), /Raclette fumée/);
  } finally { done(view); }
});

test("[PS-6] effacer (bouton ou Échap) ramène EXACTEMENT la catégorie qui était affichée, sans réécrire la sélection", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    click([...view.container.querySelectorAll('[data-category-navigation="true"] button')].find((b) => /charcuterie/i.test(b.textContent ?? ""))!);
    await flush(30);
    assert.match(mainText(view.container), /Saucisson sec/);
    await type(view.container, "cidre");
    assert.deepEqual(names(view.container), ["Cidre brut"]);
    click(view.container.querySelector('[data-product-search-clear="true"]')!);
    await flush(30);
    assert.equal(resultsSection(view.container), null);
    assert.match(mainText(view.container), /Saucisson sec/, "retour à Charcuterie, pas à la première catégorie");
    assert.doesNotMatch(mainText(view.container), /Raclette fumée/);
    await type(view.container, "cidre");
    searchInput(view.container)!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(30);
    assert.equal(searchInput(view.container)!.value, "");
    assert.match(mainText(view.container), /Saucisson sec/);
  } finally { done(view); }
});

test("[PS-7] choisir une catégorie pendant une recherche efface la recherche et affiche cette catégorie", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    await type(view.container, "menthe");
    assert.ok(resultsSection(view.container));
    click([...view.container.querySelectorAll('[data-category-navigation="true"] button')].find((b) => /boissons/i.test(b.textContent ?? ""))!);
    await flush(30);
    assert.equal(searchInput(view.container)!.value, "");
    assert.equal(resultsSection(view.container), null);
    assert.match(mainText(view.container), /Cidre brut/);
  } finally { done(view); }
});

test("[PS-8] le panier n'est jamais perdu : ajout depuis les résultats, recherche changée ou effacée, compteur conservé", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    await type(view.container, "cidre");
    click([...resultsSection(view.container)!.querySelectorAll("button")].find((b) => b.textContent === "Ajouter")!);
    await flush(30);
    assert.match(cartBarText(view.container), /1 article/);
    await type(view.container, "saucisson");
    assert.match(cartBarText(view.container), /1 article/, "changer de recherche ne vide pas le panier");
    click([...resultsSection(view.container)!.querySelectorAll("button")].find((b) => b.textContent === "Ajouter")!);
    await flush(30);
    assert.match(cartBarText(view.container), /2 articles/);
    click(view.container.querySelector('[data-product-search-clear="true"]')!);
    await flush(30);
    assert.match(cartBarText(view.container), /2 articles/);
    await type(view.container, "cidre");
    assert.ok(resultsSection(view.container)!.textContent!.includes("1"), "la carte du produit reflète la quantité du panier");
  } finally { done(view); }
});

test("[PS-9] produit archivé et catégorie masquée ne sont jamais retrouvés", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    await type(view.container, "archive");
    assert.match(status(view.container), /Aucun produit/);
    await type(view.container, "secret");
    assert.match(status(view.container), /Aucun produit/);
  } finally { done(view); }
});

test("[PS-10] langues : le nom traduit validé est cherchable, le nom source aussi, et la carte l'affiche dans la langue active", async (t) => {
  mockRpc(t);
  const view = await mount(fromagerie());
  try {
    click(view.container.querySelector('button[lang="ar"]')!);
    await flush(40);
    assert.equal(view.container.querySelector("label[for]")?.textContent, "ابحث عن منتج");
    await type(view.container, "بالثوم");
    assert.deepEqual(names(view.container), ["راكليت بالثوم البري"]);
    await type(view.container, "ail des ours");
    assert.deepEqual(names(view.container), ["راكليت بالثوم البري"], "le nom source reste cherchable");
    await type(view.container, "zzz");
    assert.match(status(view.container), /لا يوجد منتج يطابق «zzz»/);
  } finally { done(view); }
});

test("[PS-11] produit à options : la carte des résultats ouvre la même fenêtre de choix et rien n'entre au panier avant confirmation", async (t) => {
  mockRpc(t);
  const r = fromagerie({
    slug: "illico-presto",
    extraItems: [item("i-formule", "c-fromages", "Formule Prestigio", { price: 12 })],
  }) as any;
  r.categories.push({
    id: "c-patisseries", restaurant_id: r.id, name: "Pâtisseries", display_order: 4, is_active: true,
    menu_items: [item("i-eclair", "c-patisseries", "Éclair café"), item("i-tarte", "c-patisseries", "Tarte citron")],
  });
  const view = await mount(r);
  try {
    await type(view.container, "prestigio");
    assert.deepEqual(names(view.container), ["Formule Prestigio"]);
    click([...resultsSection(view.container)!.querySelectorAll("button")].find((b) => b.textContent === "Ajouter")!);
    await flush(40);
    assert.match(view.container.textContent ?? "", /Choisissez votre pâtisserie/);
    assert.equal(cartBarText(view.container), "", "aucun article avant la confirmation");
  } finally { done(view); }
});

test("[PS-12] isolation : la requête d'un établissement ne s'applique pas à un autre, et ses produits ne sont jamais proposés", async (t) => {
  mockRpc(t);
  const a = fromagerie({ id: "r-a", slug: "a-test" });
  const b = fromagerie({ id: "r-b", slug: "b-test", extraItems: [item("i-b-only", "c-fromages", "Spécialité exclusive B")] }) as any;
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  clearTestCartSession(window.sessionStorage);
  root.render(React.createElement(MenuView, { restaurant: b }));
  await flush(60);
  try {
    await type(container, "exclusive");
    assert.deepEqual(names(container), ["Spécialité exclusive B"]);
    root.render(React.createElement(MenuView, { restaurant: a }));
    await flush(60);
    assert.equal(searchInput(container)!.value, "", "la saisie de B n'est pas appliquée à A");
    assert.equal(resultsSection(container), null);
    await type(container, "exclusive");
    assert.match(status(container), /Aucun produit/, "le produit de B est introuvable chez A");
  } finally { root.unmount(); container.remove(); clearTestCartSession(window.sessionStorage); }
});

test("[PS-13] grands catalogues : résultats paginés par 40, « Afficher plus » charge la suite, photos différées conservées", async (t) => {
  mockRpc(t);
  const many = Array.from({ length: 95 }, (_, i) =>
    item(`i-many-${i}`, "c-fromages", `Tomme numéro ${i}`, { image_url: `https://img.example/tomme-${i}.jpg` }));
  const view = await mount(fromagerie({ extraItems: many }));
  try {
    await type(view.container, "tomme");
    await waitFor(() => status(view.container) === "95 résultats", "95 résultats annoncés", 5000);
    assert.equal(names(view.container).length, 40);
    const imgs = [...resultsSection(view.container)!.querySelectorAll("img")];
    assert.ok(imgs.length > 0 && imgs.every((img) => img.getAttribute("loading") === "lazy"), "photos différées");
    click(view.container.querySelector('[data-product-search-more="true"]')!);
    await waitFor(() => names(view.container).length === 80, "80 résultats rendus", 5000);
    click(view.container.querySelector('[data-product-search-more="true"]')!);
    await waitFor(() => names(view.container).length === 95, "95 résultats rendus", 5000);
    assert.equal(view.container.querySelector('[data-product-search-more="true"]'), null);
    await type(view.container, "tomme 7");
    await waitFor(() => names(view.container).length === 18, "18 produits contiennent « 7 »", 5000);
    await type(view.container, "tomme");
    await waitFor(() => names(view.container).length === 40, "la pagination repart de zéro à chaque nouvelle saisie", 5000);
  } finally { done(view); }
});

test("[PS-14] combiné avec sous-catégorie et collection : la recherche prime, puis effacer restitue la sélection d'avant", async (t) => {
  mockRpc(t);
  const r = fromagerie() as any;
  r.collections = [{ id: "col-raclettes", label: "Raclettes", displayOrder: 1, menuItemIds: ["i-fumee", "i-ail", "i-fenugrec"] }];
  const view = await mount(r);
  try {
    // Sous-catégorie : on filtre sur « Chèvres » dans la catégorie Fromages.
    click(view.container.querySelector('[data-subcategory-filter-option="s-chevres"]')!);
    await flush(30);
    assert.match(mainText(view.container), /Crottin de chèvre/);
    assert.doesNotMatch(mainText(view.container), /Comté 24 mois/);
    await type(view.container, "comte");
    assert.deepEqual(names(view.container), ["Comté 24 mois"], "la recherche n'est pas bornée par la sous-catégorie choisie");
    click(view.container.querySelector('[data-product-search-clear="true"]')!);
    await flush(30);
    assert.match(mainText(view.container), /Crottin de chèvre/);
    assert.doesNotMatch(mainText(view.container), /Comté 24 mois/, "le filtre « Chèvres » est restitué");

    // Collection (tag) : active, puis recherche, puis retour.
    click(view.container.querySelector('[data-customer-collection-option="collection"]')!);
    await flush(30);
    assert.ok(view.container.querySelector('[data-customer-collection-view="true"]'));
    await type(view.container, "cidre");
    assert.deepEqual(names(view.container), ["Cidre brut"], "la recherche n'est pas bornée par la collection");
    assert.equal(view.container.querySelector('[data-customer-collection-view="true"]'), null);
    assert.equal(view.container.querySelector('[data-customer-collection-option="collection"][aria-pressed="true"]'), null, "aucune collection marquée active pendant la recherche");
    click(view.container.querySelector('[data-product-search-clear="true"]')!);
    await flush(30);
    assert.ok(view.container.querySelector('[data-customer-collection-view="true"]'), "la collection revient");
    // Choisir une collection pendant une recherche l'efface.
    await type(view.container, "cidre");
    click(view.container.querySelector('[data-customer-collection-option="collection"]')!);
    await flush(30);
    assert.equal(searchInput(view.container)!.value, "");
    assert.equal(resultsSection(view.container), null);
  } finally { done(view); }
});

test("[PS-15] A -> B -> A avec la MÊME instance de MenuView : la saisie et la pagination sont réellement réinitialisées, jamais ressorties", async (t) => {
  mockRpc(t);
  const many = Array.from({ length: 95 }, (_, i) => item(`i-many-${i}`, "c-fromages", `Tomme numéro ${i}`));
  const a = () => fromagerie({ id: "r-a", slug: "a-test", extraItems: many });
  const b = () => fromagerie({ id: "r-b", slug: "b-test" });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  clearTestCartSession(window.sessionStorage);
  root.render(React.createElement(MenuView, { restaurant: a() }));
  await flush(60);
  try {
    await type(container, "tomme");
    await waitFor(() => names(container).length === 40, "40 résultats chez A", 5000);
    click(container.querySelector('[data-product-search-more="true"]')!);
    await waitFor(() => names(container).length === 80, "80 résultats chez A", 5000);

    // A -> B : rien de la recherche de A, ni à l'écran immédiat ni après stabilisation.
    root.render(React.createElement(MenuView, { restaurant: b() }));
    await flush(0);
    assert.equal(searchInput(container)!.value, "");
    assert.equal(resultsSection(container), null, "aucun résultat de A peint chez B");
    await flush(80);
    assert.equal(searchInput(container)!.value, "");
    assert.equal(resultsSection(container), null);
    assert.doesNotMatch(mainText(container), /Tomme numéro/);

    // B -> A : la saisie de A n'est PAS ressortie.
    root.render(React.createElement(MenuView, { restaurant: a() }));
    await flush(0);
    assert.equal(searchInput(container)!.value, "", "la saisie de A ne revient pas");
    assert.equal(resultsSection(container), null);
    await flush(80);
    assert.equal(searchInput(container)!.value, "");
    assert.equal(resultsSection(container), null);
    assert.match(mainText(container), /Raclette fumée/, "vitrine normale de A");

    // La pagination est repartie de zéro.
    await type(container, "tomme");
    await waitFor(() => names(container).length === 40, "retour à 40 résultats (pagination réinitialisée)", 5000);
  } finally { root.unmount(); container.remove(); clearTestCartSession(window.sessionStorage); }
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
});
