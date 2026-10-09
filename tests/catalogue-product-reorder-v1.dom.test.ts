import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { applyProductMove, findProductOrderScope } from "../lib/catalogue-product-order.ts";
import { compareMenuItemsForPublicDisplay } from "../lib/catalogue-subcategory-grouping.ts";
import { readXlsxWorkbook } from "../lib/catalogue-import/xlsx-reader.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — CATALOGUE PRODUCT REORDER v1 — rendu RÉEL de
// app/dashboard/catalogue/page.tsx (esbuild + jsdom).
//
// Seuls les services réseau sont remplacés : l'écran, son état, ses
// gardes et son rendu sont les vrais. Le « serveur » simulé applique
// un déplacement accepté avec la logique de production
// (applyProductMove, prouvée identique à la RPC par
// tests/catalogue-product-reorder-v1-sql.test.ts) : un rechargement
// renvoie donc ce que la base renverrait.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/catalogue",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).File = window.File;
(globalThis as any).Blob = window.Blob;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

const RESTO_A = "resto-a";
const RESTO_B = "resto-b";

const G = globalThis as any;
G.__cpr = {
  catalogue: {} as Record<string, unknown[]>,
  role: "owner",
  catalogueLoads: [] as Array<{ id: string; archived: boolean }>,
  moveCalls: [] as Array<{ productId: string; direction: string; expectedOrder: string[] }>,
  moveImpl: null as null | ((productId: string, direction: string, expectedOrder: string[]) => Promise<number>),
  availabilityCalls: [] as unknown[][],
  updateCalls: [] as unknown[][],
  orderCalls: [] as unknown[][],
};

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/catalogue"; }
export function useSearchParams() { return new URLSearchParams("r=${RESTO_A}"); }
`;
const MOCK_AUTH = `
export async function getUser() { return { id: "u1" }; }
export async function getSession() { return { access_token: "t", user: { id: "u1" } }; }
export async function signOut() {}
`;
const MOCK_DASHBOARD = `
const S = () => globalThis.__cpr;
export async function getMerchantCatalogue(id, archived) {
  S().catalogueLoads.push({ id, archived });
  if (archived) return [];
  // Copie profonde : comme une vraie réponse réseau, jamais la
  // référence de l'état « serveur ».
  return JSON.parse(JSON.stringify(S().catalogue[id] ?? []));
}
export async function getMerchantRestaurants() {
  return [
    { restaurant_id: "${RESTO_A}", name: "Au lait cru", role: S().role },
    { restaurant_id: "${RESTO_B}", name: "Hotel Royal", role: S().role },
  ];
}
export async function getRestaurantSettings() {
  return { currency: "EUR", staff_receipt_language: "fr" };
}
export async function createProduct() { return "new"; }
export async function updateProduct(...args) { S().updateCalls.push(args); }
export async function archiveProduct() {}
export async function restoreProduct() {}
export async function setProductAvailability(...args) { S().availabilityCalls.push(args); }
export async function setProductOrder(...args) { S().orderCalls.push(args); }
export async function createCategory() { return "c"; }
export async function updateCategory() {}
export async function createSubcategory() { return "s"; }
export async function updateSubcategory() {}
export class CategoryDuplicateNameError extends Error {}
export class CategoryDescriptionTooLongError extends Error {}
export class DescriptionTooLongError extends Error {}
export class ShortDescriptionTooLongError extends Error {}
export class SubcategoryDuplicateNameError extends Error {}
export class SubcategoryCategoryMismatchError extends Error {}
`;
const MOCK_REORDER_SERVICE = `
export class ProductOrderStaleError extends Error {
  constructor() { super("SCANYM_PRODUCT_ORDER_STALE"); this.name = "ProductOrderStaleError"; }
}
export class ProductOrderBoundaryError extends Error {
  constructor() { super("SCANYM_PRODUCT_ORDER_BOUNDARY"); this.name = "ProductOrderBoundaryError"; }
}
globalThis.__cprStaleError = ProductOrderStaleError;
export async function moveProductOrder(productId, direction, expectedOrder) {
  globalThis.__cpr.moveCalls.push({ productId, direction, expectedOrder: [...expectedOrder] });
  return globalThis.__cpr.moveImpl(productId, direction, [...expectedOrder]);
}
`;
const MOCK_TAGS = `
export async function getRestaurantProductTags() { return globalThis.__cprProductTags ?? []; }
export async function getRestaurantTags() { return globalThis.__cprKnownTags ?? []; }
export async function addProductTags(productId, names) { return names.length; }
export async function removeProductTag() { return 1; }
export async function updateTagCollectionSettings() {}
export class TagDuplicateNameError extends Error {}
`;
const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return false; }
export async function getEstablishmentSummary() { return null; }
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/catalogue-product-order": MOCK_REORDER_SERVICE,
  "@/lib/services/catalogue-tags": MOCK_TAGS,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/sale-modes-public": `export async function getPublicSaleModes() { return []; }`,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "ts" }));
  },
};

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as CataloguePage } from "@/app/dashboard/catalogue/page.tsx";`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "CataloguePage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { CataloguePage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

function prod(over: Record<string, unknown> = {}) {
  return {
    product_id: "p1", category_id: "c1", category_name: "Fromages", category_translations: null,
    subcategory_id: null, subcategory_name: null, name: "Comté", name_hash: "h",
    short_description: null, short_description_hash: null, description: null, description_hash: null,
    translations: null, price: 12.5, is_available: true, archived_at: null, display_order: 0,
    is_option_source: false, image_url: null, tax_rate: 5.5, unit_weight_grams: null,
    weight_is_approximate: false, reference_price_per_kg: null, withdrawal_eligible: false,
    allowed_sale_modes: null,
    ...over,
  };
}
function sub(id: string, name: string, order: number, products: Record<string, unknown>[]) {
  return {
    subcategory_id: id, subcategory_name: name, subcategory_display_order: order, subcategory_is_active: true,
    products: products.map((p) => ({ ...p, subcategory_id: id, subcategory_name: name })),
  };
}
function cat(over: Record<string, unknown> = {}) {
  return {
    category_id: "c1", category_name: "Fromages", category_name_hash: "h", category_translations: null,
    category_display_order: 1, category_is_option_source: false, category_description: null,
    category_description_hash: null, category_is_active: true, products: [], subcategories: [],
    ...over,
  };
}

/**
 * Fromages (c1)
 *   directs    : Comté(1, retrait seul) Beaufort(2) Abondance(3, indisponible)
 *   Chèvres s1 : quatre EX ÆQUO historiques à 0 (Zeste, éclat, Banon, crottin)
 *   Brebis  s2 : Ossau(4)                       <- périmètre d'UN produit
 * Boissons (c2)
 *   directs    : Eau(5) Jus(9) Cidre(14)
 *
 * Les tableaux sont volontairement dans un ordre QUELCONQUE : l'écran
 * ne doit jamais dépendre de l'ordre d'arrivée.
 */
function catalogueA() {
  return [
    cat({
      category_id: "c1", category_name: "Fromages", category_display_order: 1,
      products: [
        prod({ product_id: "abondance", name: "Abondance", display_order: 3, is_available: false, tax_rate: null }),
        prod({ product_id: "comte", name: "Comté", display_order: 1, allowed_sale_modes: ["pickup"] }),
        prod({ product_id: "beaufort", name: "Beaufort", display_order: 2 }),
      ],
      subcategories: [
        sub("s1", "Chèvres", 1, [
          prod({ product_id: "zeste", name: "Zeste de chèvre", display_order: 0 }),
          prod({ product_id: "eclat", name: "éclat cendré", display_order: 0 }),
          prod({ product_id: "banon", name: "Banon", display_order: 0 }),
          prod({ product_id: "crottin", name: "crottin", display_order: 0 }),
        ]),
        sub("s2", "Brebis", 2, [prod({ product_id: "ossau", name: "Ossau", display_order: 4 })]),
      ],
    }),
    cat({
      category_id: "c2", category_name: "Boissons", category_display_order: 2,
      products: [
        prod({ product_id: "jus", name: "Jus", category_id: "c2", category_name: "Boissons", display_order: 9 }),
        prod({ product_id: "cidre", name: "Cidre", category_id: "c2", category_name: "Boissons", display_order: 14 }),
        prod({ product_id: "eau", name: "Eau", category_id: "c2", category_name: "Boissons", display_order: 5 }),
      ],
    }),
  ];
}
function catalogueB() {
  return [
    cat({
      category_id: "cb", category_name: "Carte",
      products: [
        prod({ product_id: "b-trois", name: "B-Trois", category_id: "cb", category_name: "Carte", display_order: 0 }),
        prod({ product_id: "b-un", name: "B-Un", category_id: "cb", category_name: "Carte", display_order: 0 }),
        prod({ product_id: "b-deux", name: "B-Deux", category_id: "cb", category_name: "Carte", display_order: 0 }),
      ],
    }),
  ];
}

const NAMES: Record<string, string> = {
  comte: "Comté", beaufort: "Beaufort", abondance: "Abondance",
  zeste: "Zeste de chèvre", eclat: "éclat cendré", banon: "Banon", crottin: "crottin", ossau: "Ossau",
  eau: "Eau", jus: "Jus", cidre: "Cidre", "b-un": "B-Un", "b-deux": "B-Deux", "b-trois": "B-Trois",
};

/** « Serveur » : accepte le déplacement si la vue transmise est
 *  l'ordre courant, l'applique comme la RPC, sinon le refuse. */
function serverAccepts(restaurantId = RESTO_A) {
  return async (productId: string, direction: string, expectedOrder: string[]) => {
    const current = G.__cpr.catalogue[restaurantId];
    const scope = findProductOrderScope(current, productId);
    if (!scope || JSON.stringify(scope.orderedIds) !== JSON.stringify(expectedOrder)) {
      throw new G.__cprStaleError();
    }
    const result = applyProductMove(current, productId, direction as "up" | "down");
    assert.ok(result, "le serveur simulé n'est jamais appelé pour un déplacement impossible");
    G.__cpr.catalogue[restaurantId] = result!.categories;
    return result!.position;
  };
}

// ------------------------------------------------------------------
// Outils de rendu
// ------------------------------------------------------------------

let mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement } | null = null;

function flush(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
function q(c: ParentNode, sel: string) {
  return c.querySelector(sel) as HTMLElement | null;
}
function qa(c: ParentNode, sel: string) {
  return [...c.querySelectorAll(sel)] as HTMLElement[];
}
function setValue(el: HTMLElement, value: string, proto: any) {
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event(proto === window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
function click(el: Element | null | undefined) {
  assert.ok(el, "élément à cliquer introuvable");
  el!.dispatchEvent(new window.Event("click", { bubbles: true }));
}

async function renderCatalogue(): Promise<HTMLElement> {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CataloguePage));
  mounted = { root, container };
  await waitFor(() => !!q(container, '[data-testid="catalogue-toolbar"]'));
  await flush();
  return container;
}

async function chooseSort(container: HTMLElement, value: string) {
  setValue(q(container, '[data-testid="catalogue-sort"]')!, value, window.HTMLSelectElement);
  await flush();
}
async function reorderView(): Promise<HTMLElement> {
  const container = await renderCatalogue();
  await chooseSort(container, "catalogue-order");
  return container;
}

/** Carte (<li>) du produit : celle qui porte ses boutons, sinon celle
 *  dont le titre est exactement son nom. */
function card(container: HTMLElement, id: string): HTMLElement {
  const li = qa(container, "li").find((el) => (q(el, "p.font-semibold")?.textContent ?? "").trim() === NAMES[id]);
  assert.ok(li, `carte produit « ${NAMES[id]} » introuvable`);
  return li!;
}
function moveButton(container: HTMLElement, id: string, direction: "up" | "down"): HTMLButtonElement {
  const button = qa(container, `button[data-reorder-direction="${direction}"]`).find(
    (b) => b.getAttribute("data-reorder-product") === id
  );
  assert.ok(button, `bouton ${direction} de « ${NAMES[id]} » introuvable`);
  return button as HTMLButtonElement;
}
/** Titres des cartes produit rendues, dans l'ordre du DOM. */
function renderedNames(scope: ParentNode): string[] {
  return qa(scope, "li p.font-semibold").map((p) => (p.textContent ?? "").trim());
}
/** <section> d'une catégorie, par son titre. */
function section(container: HTMLElement, categoryName: string): HTMLElement {
  const s = qa(container, "section").find((el) => (q(el, "h2")?.textContent ?? "").trim() === categoryName);
  assert.ok(s, `section « ${categoryName} » introuvable`);
  return s!;
}
/** Produits DIRECTS d'une catégorie (première liste de la section). */
function directNames(container: HTMLElement, categoryName: string): string[] {
  return renderedNames(q(section(container, categoryName), ":scope > ul")!);
}
/** Produits d'une sous-catégorie, par son titre. */
function subNames(container: HTMLElement, subName: string): string[] {
  const h3 = qa(container, "h3").find((el) => (el.textContent ?? "").trim() === subName);
  assert.ok(h3, `sous-catégorie « ${subName} » introuvable`);
  return renderedNames(h3!.parentElement!.parentElement!);
}
function statusText(container: HTMLElement): string {
  return (q(container, '[data-testid="catalogue-reorder-status"]')?.textContent ?? "").trim();
}
function hintText(container: HTMLElement): string {
  return (q(container, '[data-testid="catalogue-reorder-hint"]')?.textContent ?? "").trim();
}
function nonArchivedLoads(): number {
  return G.__cpr.catalogueLoads.filter((l: any) => !l.archived).length;
}

beforeEach(() => {
  if (mounted) {
    mounted.root.unmount();
    mounted.container.remove();
    mounted = null;
  }
  G.__cpr.catalogue = { [RESTO_A]: catalogueA(), [RESTO_B]: catalogueB() };
  G.__cpr.role = "owner";
  G.__cpr.catalogueLoads = [];
  G.__cpr.moveCalls = [];
  G.__cpr.moveImpl = serverAccepts();
  G.__cpr.availabilityCalls = [];
  G.__cpr.updateCalls = [];
  G.__cpr.orderCalls = [];
  G.__cprProductTags = [];
  G.__cprKnownTags = [];
});

// ==================================================================
// A. Vue par défaut : rien ne change pour qui ne réordonne pas
// ==================================================================

test("[A] VUE PAR DÉFAUT inchangée : tri « Nom A → Z », produits alphabétiques, champ numérique « Ordre » toujours présent, AUCUN bouton Monter/Descendre", async () => {
  const container = await renderCatalogue();
  assert.equal((q(container, '[data-testid="catalogue-sort"]') as HTMLSelectElement).value, "name-asc");
  assert.deepEqual(directNames(container, "Fromages"), ["Abondance", "Beaufort", "Comté"]);
  assert.equal(qa(container, '[data-testid="product-move-up"], [data-testid="product-move-down"]').length, 0);
  assert.equal(qa(container, 'li input[type="number"]').length, 11, "un champ « Ordre » par produit, comme avant ce lot");
  assert.equal(G.__cpr.moveCalls.length, 0);
});

test("[A] le tri « Ordre de la carte » est ajouté EN DERNIER dans le sélecteur ; les quatre options existantes gardent leur position", async () => {
  const container = await renderCatalogue();
  const options = qa(q(container, '[data-testid="catalogue-sort"]')!, "option").map((o) => (o as HTMLOptionElement).value);
  assert.deepEqual(options, ["name-asc", "name-desc", "price-asc", "price-desc", "catalogue-order"]);
  assert.match(hintText(container), /Ordre de la carte/, "l'écran dit où se trouve le réordonnancement");
});

test("[A] le champ numérique historique reste câblé sur setProductOrder dans la vue par défaut", async () => {
  const container = await renderCatalogue();
  const input = q(card(container, "beaufort"), 'input[type="number"]')!;
  setValue(input, "7", window.HTMLInputElement);
  await flush();
  click(qa(card(container, "beaufort"), "button").find((b) => (b.textContent ?? "").trim() === "✓"));
  await flush();
  assert.deepEqual(G.__cpr.orderCalls, [["beaufort", 7]]);
  assert.equal(G.__cpr.moveCalls.length, 0);
});

// ==================================================================
// B. Vue « Ordre de la carte »
// ==================================================================

test("[B] la vue « Ordre de la carte » affiche chaque périmètre dans l'ordre PERSISTÉ -- celui de la carte client -- quel que soit l'ordre d'arrivée des lignes", async () => {
  const container = await reorderView();
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Beaufort", "Abondance"]);
  assert.deepEqual(subNames(container, "Chèvres"), ["Banon", "crottin", "Zeste de chèvre", "éclat cendré"]);
  assert.deepEqual(directNames(container, "Boissons"), ["Eau", "Jus", "Cidre"]);

  // Même ordre que le comparateur de la carte client, sur les mêmes données.
  const chevres = (catalogueA()[0] as any).subcategories[0].products
    .map((p: any) => ({ ...p, id: p.product_id, subcategory_display_order: 1 }))
    .sort(compareMenuItemsForPublicDisplay)
    .map((p: any) => p.name);
  assert.deepEqual(subNames(container, "Chèvres"), chevres);
});

test("[B] chaque produit porte deux vrais boutons nommés (« Monter {produit} », « Descendre {produit} ») ; le champ numérique disparaît ; la position est affichée", async () => {
  const container = await reorderView();
  assert.equal(qa(container, '[data-testid="product-move-up"]').length, 11);
  assert.equal(qa(container, '[data-testid="product-move-down"]').length, 11);
  assert.equal(qa(container, 'li input[type="number"]').length, 0);

  const up = moveButton(container, "beaufort", "up");
  const down = moveButton(container, "beaufort", "down");
  assert.equal(up.tagName, "BUTTON");
  assert.equal(up.getAttribute("type"), "button");
  assert.equal(up.getAttribute("aria-label"), "Monter Beaufort");
  assert.equal(down.getAttribute("aria-label"), "Descendre Beaufort");
  assert.equal((up.textContent ?? "").trim(), "↑ Monter");
  assert.equal((down.textContent ?? "").trim(), "↓ Descendre");
  assert.ok(up.getAttribute("aria-label")!.includes("Monter"), "le nom accessible contient le libellé visible");
  assert.equal(q(card(container, "beaufort"), '[data-testid="product-order-position"]')!.textContent, "2 / 3");
  assert.equal(q(card(container, "beaufort"), '[data-testid="product-reorder"]')!.getAttribute("role"), "group");
  assert.match(hintText(container), /Monter/);
});

test("[B] BORNES : le PREMIER de chaque périmètre ne peut pas monter, le DERNIER ne peut pas descendre, un périmètre d'un seul produit n'offre aucun déplacement", async () => {
  const container = await reorderView();
  for (const [first, last] of [["comte", "abondance"], ["banon", "eclat"], ["eau", "cidre"]]) {
    assert.equal(moveButton(container, first, "up").disabled, true, `${first} : Monter inactif`);
    assert.equal(moveButton(container, first, "down").disabled, false);
    assert.equal(moveButton(container, last, "down").disabled, true, `${last} : Descendre inactif`);
    assert.equal(moveButton(container, last, "up").disabled, false);
  }
  assert.equal(moveButton(container, "ossau", "up").disabled, true);
  assert.equal(moveButton(container, "ossau", "down").disabled, true);

  // Un clic sur un bouton inactif n'appelle rien.
  click(moveButton(container, "comte", "up"));
  click(moveButton(container, "abondance", "down"));
  click(moveButton(container, "ossau", "up"));
  await flush();
  assert.equal(G.__cpr.moveCalls.length, 0);
});

// ==================================================================
// C. Déplacements
// ==================================================================

test("[C] MILIEU vers le HAUT : la ligne remonte immédiatement, la RPC reçoit l'ordre AFFICHÉ du périmètre, aucun rechargement, annonce aria-live", async () => {
  const container = await reorderView();
  const loads = nonArchivedLoads();

  click(moveButton(container, "beaufort", "up"));
  await flush();

  assert.deepEqual(G.__cpr.moveCalls, [{ productId: "beaufort", direction: "up", expectedOrder: ["comte", "beaufort", "abondance"] }]);
  assert.deepEqual(directNames(container, "Fromages"), ["Beaufort", "Comté", "Abondance"]);
  assert.equal(nonArchivedLoads(), loads, "un déplacement accepté ne recharge pas le catalogue (la liste ne disparaît pas)");
  assert.equal(statusText(container), "Beaufort : position 1 sur 3.");
  assert.equal(q(card(container, "beaufort"), '[data-testid="product-order-position"]')!.textContent, "1 / 3");
  const status = q(container, '[data-testid="catalogue-reorder-status"]')!;
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
});

test("[C] MILIEU vers le BAS : la ligne descend immédiatement", async () => {
  const container = await reorderView();
  click(moveButton(container, "beaufort", "down"));
  await flush();
  assert.deepEqual(G.__cpr.moveCalls, [{ productId: "beaufort", direction: "down", expectedOrder: ["comte", "beaufort", "abondance"] }]);
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Abondance", "Beaufort"]);
  assert.equal(statusText(container), "Beaufort : position 3 sur 3.");
});

test("[C] FOCUS CLAVIER : le bouton actionné garde le focus ; s'il devient inactif (borne atteinte), le focus passe au bouton opposé du MÊME produit", async () => {
  const container = await reorderView();

  // Zeste : 3e -> 2e. « Monter » reste actif : il garde le focus.
  moveButton(container, "zeste", "up").focus();
  click(moveButton(container, "zeste", "up"));
  await flush();
  assert.deepEqual(subNames(container, "Chèvres"), ["Banon", "Zeste de chèvre", "crottin", "éclat cendré"]);
  assert.equal(window.document.activeElement, moveButton(container, "zeste", "up"));

  // Zeste : 2e -> 1er. « Monter » devient inactif : focus sur « Descendre ».
  click(moveButton(container, "zeste", "up"));
  await flush();
  assert.deepEqual(subNames(container, "Chèvres"), ["Zeste de chèvre", "Banon", "crottin", "éclat cendré"]);
  assert.equal(moveButton(container, "zeste", "up").disabled, true);
  assert.equal(window.document.activeElement, moveButton(container, "zeste", "down"));

  // Descendre : le produit déplacé est celui dont le nœud change de place.
  click(moveButton(container, "zeste", "down"));
  await flush();
  assert.equal(window.document.activeElement, moveButton(container, "zeste", "down"), "le focus suit la ligne déplacée");
});

test("[C] déplacements ENCHAÎNÉS : chaque appel transmet l'ordre résultant du précédent ; l'écran et le serveur restent identiques", async () => {
  const container = await reorderView();
  click(moveButton(container, "cidre", "up"));
  await flush();
  click(moveButton(container, "cidre", "up"));
  await flush();
  click(moveButton(container, "eau", "down"));
  await flush();
  assert.deepEqual(G.__cpr.moveCalls.map((c: any) => c.expectedOrder), [
    ["eau", "jus", "cidre"],
    ["eau", "cidre", "jus"],
    ["cidre", "eau", "jus"],
  ]);
  assert.deepEqual(directNames(container, "Boissons"), ["Cidre", "Jus", "Eau"]);
  assert.deepEqual(findProductOrderScope(G.__cpr.catalogue[RESTO_A], "eau")!.orderedIds, ["cidre", "jus", "eau"]);
});

// ==================================================================
// D. Périmètres
// ==================================================================

test("[D] PÉRIMÈTRE SOUS-CATÉGORIE : la liste transmise ne contient QUE les produits de la sous-catégorie ; les produits directs et l'autre catégorie ne bougent pas", async () => {
  const container = await reorderView();
  click(moveButton(container, "crottin", "down"));
  await flush();
  assert.deepEqual(G.__cpr.moveCalls[0].expectedOrder, ["banon", "crottin", "zeste", "eclat"]);
  assert.deepEqual(subNames(container, "Chèvres"), ["Banon", "Zeste de chèvre", "crottin", "éclat cendré"]);
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Beaufort", "Abondance"]);
  assert.deepEqual(subNames(container, "Brebis"), ["Ossau"]);
  assert.deepEqual(directNames(container, "Boissons"), ["Eau", "Jus", "Cidre"]);
});

test("[D] REPLI CATÉGORIE : pour un produit sans sous-catégorie, la liste transmise ne contient QUE les produits directs de sa catégorie", async () => {
  const container = await reorderView();
  click(moveButton(container, "abondance", "up"));
  await flush();
  assert.deepEqual(G.__cpr.moveCalls[0].expectedOrder, ["comte", "beaufort", "abondance"]);
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Abondance", "Beaufort"]);
  assert.deepEqual(subNames(container, "Chèvres"), ["Banon", "crottin", "Zeste de chèvre", "éclat cendré"]);
});

test("[D] AUCUN DÉPLACEMENT ENTRE CATÉGORIES : après une série de déplacements dans tous les périmètres, chaque produit est toujours sous SON titre ; aucune liste transmise ne mêle deux périmètres", async () => {
  const container = await reorderView();
  const scopes: Record<string, string[]> = {
    direct: ["comte", "beaufort", "abondance"], chevres: ["banon", "crottin", "zeste", "eclat"], boissons: ["eau", "jus", "cidre"],
  };
  for (const [id, direction] of [
    ["abondance", "up"], ["abondance", "up"], ["eclat", "up"], ["banon", "down"], ["banon", "down"],
    ["jus", "up"], ["cidre", "up"], ["comte", "down"], ["crottin", "down"],
  ] as const) {
    click(moveButton(container, id, direction));
    await flush(40);
  }
  assert.equal(G.__cpr.moveCalls.length, 9);
  for (const call of G.__cpr.moveCalls) {
    const scope = Object.values(scopes).find((ids) => ids.includes(call.productId))!;
    assert.deepEqual([...call.expectedOrder].sort(), [...scope].sort(), `périmètre de ${call.productId}`);
  }
  assert.deepEqual(directNames(container, "Fromages").sort(), ["Abondance", "Beaufort", "Comté"]);
  assert.deepEqual(subNames(container, "Chèvres").sort(), ["Banon", "Zeste de chèvre", "crottin", "éclat cendré"]);
  assert.deepEqual(subNames(container, "Brebis"), ["Ossau"]);
  assert.deepEqual(directNames(container, "Boissons").sort(), ["Cidre", "Eau", "Jus"]);
  // Côté « serveur » : aucune catégorie / sous-catégorie d'un produit n'a changé.
  const membership = (cats: any[]) =>
    Object.fromEntries(
      cats.flatMap((c) => [...c.products, ...c.subcategories.flatMap((s: any) => s.products)]).map((p: any) => [p.product_id, `${p.category_id}/${p.subcategory_id ?? "-"}`])
    );
  assert.deepEqual(membership(G.__cpr.catalogue[RESTO_A]), membership(catalogueA()));
});

// ==================================================================
// E. Concurrence et erreurs
// ==================================================================

test("[E] UN SEUL déplacement à la fois : pendant un appel en vol, les boutons sont aria-disabled (jamais disabled : le focus est conservé) et tout autre clic est ignoré", async () => {
  const container = await reorderView();
  let release!: (position: number) => void;
  G.__cpr.moveImpl = () => new Promise<number>((resolve) => { release = resolve; });

  const up = moveButton(container, "beaufort", "up");
  up.focus();
  click(up);
  await flush();
  click(moveButton(container, "beaufort", "up"));
  click(moveButton(container, "jus", "down"));
  click(moveButton(container, "zeste", "up"));
  await flush();

  assert.equal(G.__cpr.moveCalls.length, 1, "un seul appel RPC malgré quatre clics");
  assert.equal(moveButton(container, "beaufort", "up").getAttribute("aria-disabled"), "true");
  assert.equal(moveButton(container, "beaufort", "up").disabled, false, "aria-disabled, pas disabled");
  assert.equal(moveButton(container, "jus", "down").getAttribute("aria-disabled"), "true");
  assert.equal(q(card(container, "beaufort"), '[data-testid="product-reorder"]')!.getAttribute("aria-busy"), "true");
  assert.equal(window.document.activeElement, moveButton(container, "beaufort", "up"));
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Beaufort", "Abondance"], "rien n'est appliqué avant la réponse du serveur");

  G.__cpr.catalogue[RESTO_A] = applyProductMove(G.__cpr.catalogue[RESTO_A], "beaufort", "up")!.categories;
  release(1);
  await flush();
  assert.deepEqual(directNames(container, "Fromages"), ["Beaufort", "Comté", "Abondance"]);
  assert.equal(moveButton(container, "jus", "down").getAttribute("aria-disabled"), null);
  assert.equal(G.__cpr.moveCalls.length, 1);
});

test("[E] VUE PÉRIMÉE (un autre utilisateur a réordonné entre-temps) : rien n'est appliqué localement, le catalogue est rechargé, l'ordre de la base est affiché, un message l'explique", async () => {
  const container = await reorderView();
  const loads = nonArchivedLoads();
  // Pendant que l'écran est ouvert, un autre gérant déplace Abondance en tête.
  G.__cpr.catalogue[RESTO_A] = applyProductMove(
    applyProductMove(G.__cpr.catalogue[RESTO_A], "abondance", "up")!.categories, "abondance", "up"
  )!.categories;

  click(moveButton(container, "beaufort", "up"));
  await waitFor(() => nonArchivedLoads() > loads);
  await flush(120);

  assert.equal(G.__cpr.moveCalls.length, 1);
  assert.equal(nonArchivedLoads(), loads + 1, "rechargement après le refus");
  assert.deepEqual(directNames(container, "Fromages"), ["Abondance", "Comté", "Beaufort"], "l'ordre de la base, pas un échange local");
  assert.match(container.textContent ?? "", /L'ordre des produits a changé entre-temps/);
  assert.match(statusText(container), /^L'ordre des produits a changé entre-temps/, "le refus est ANNONCÉ (zone aria-live), jamais un déplacement réussi");
  assert.ok(!(container.textContent ?? "").includes("SCANYM_PRODUCT_ORDER_STALE"), "le code technique n'est jamais affiché");
  // La liste a été démontée puis remontée : le focus revient sur le
  // même produit (ici « Monter » de Beaufort, toujours actif).
  assert.equal(window.document.activeElement, moveButton(container, "beaufort", "up"), "focus rendu au produit après rechargement");

  // Le marchand recommence sur la liste à jour : accepté.
  click(moveButton(container, "beaufort", "up"));
  await flush();
  assert.deepEqual(directNames(container, "Fromages"), ["Abondance", "Beaufort", "Comté"]);
  assert.ok(!/a changé entre-temps/.test(container.textContent ?? ""), "le message disparaît au déplacement suivant");
});

test("[E] ÉCHEC quelconque (réseau, refus) : message générique, rechargement, jamais le message technique, jamais d'échange local", async () => {
  const container = await reorderView();
  const loads = nonArchivedLoads();
  const realError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    G.__cpr.moveImpl = async () => { throw new Error("permission denied for function move_product_order"); };
    click(moveButton(container, "jus", "up"));
    await waitFor(() => nonArchivedLoads() > loads);
    await flush(120);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(directNames(container, "Boissons"), ["Eau", "Jus", "Cidre"]);
  assert.match(container.textContent ?? "", /Le déplacement n'a pas pu être enregistré/);
  assert.match(statusText(container), /^Le déplacement n'a pas pu être enregistré/);
  assert.ok(!(container.textContent ?? "").includes("permission denied"));
  assert.equal(window.document.activeElement, moveButton(container, "jus", "up"), "focus rendu au produit après rechargement");
  assert.equal(logged.length, 1, "le détail technique est journalisé, pas affiché");
});

test("[E] CHANGEMENT D'ÉTABLISSEMENT pendant un déplacement : la réponse tardive de A n'est jamais appliquée à l'écran de B, aucun message, aucune annonce", async () => {
  const container = await reorderView();
  let release!: (position: number) => void;
  G.__cpr.moveImpl = () => new Promise<number>((resolve) => { release = resolve; });
  click(moveButton(container, "beaufort", "up"));
  await flush();

  setValue(q(container, "header select")!, RESTO_B, window.HTMLSelectElement);
  await waitFor(() => (container.textContent ?? "").includes("B-Un"));
  await flush();
  const loadsOfA = G.__cpr.catalogueLoads.filter((l: any) => l.id === RESTO_A).length;

  release(1);
  await flush(120);

  assert.deepEqual(directNames(container, "Carte"), ["B-Deux", "B-Trois", "B-Un"]);
  assert.ok(!(container.textContent ?? "").includes("Beaufort"), "aucun produit de A sous l'entête de B");
  assert.equal(statusText(container), "");
  assert.ok(!/déplacement|entre-temps/.test(container.textContent ?? ""));
  assert.equal(G.__cpr.catalogueLoads.filter((l: any) => l.id === RESTO_A).length, loadsOfA, "aucun rechargement de A déclenché depuis l'écran de B");
  assert.equal((q(container, '[data-testid="catalogue-sort"]') as HTMLSelectElement).value, "name-asc", "B repart de la vue par défaut");
  assert.deepEqual(JSON.parse(JSON.stringify(G.__cpr.catalogue[RESTO_B])), catalogueB(), "le catalogue de B est intact");
});

// ==================================================================
// F. Quand Monter/Descendre ne sont PAS proposés
// ==================================================================

test("[F] un critère qui masque des produits À L'INTÉRIEUR d'un périmètre (recherche, disponibilité) retire les boutons et l'écran dit pourquoi ; un filtre de catégorie les conserve", async () => {
  const container = await reorderView();

  setValue(q(container, '[data-testid="catalogue-search"]')!, "o", window.HTMLInputElement);
  await flush();
  assert.equal(qa(container, '[data-testid="product-move-up"]').length, 0);
  assert.match(hintText(container), /Effacez la recherche/);
  setValue(q(container, '[data-testid="catalogue-search"]')!, "", window.HTMLInputElement);
  await flush();
  assert.equal(qa(container, '[data-testid="product-move-up"]').length, 11);

  setValue(q(container, '[data-testid="filter-availability"]')!, "yes", window.HTMLSelectElement);
  await flush();
  assert.equal(qa(container, '[data-testid="product-move-up"]').length, 0);
  setValue(q(container, '[data-testid="filter-availability"]')!, "", window.HTMLSelectElement);
  await flush();

  // Filtre de catégorie : des périmètres ENTIERS sont masqués, aucun
  // n'est tronqué -> le réordonnancement reste proposé et exact.
  setValue(q(container, '[data-testid="filter-category"]')!, "c2", window.HTMLSelectElement);
  await flush();
  assert.equal(qa(container, '[data-testid="product-move-up"]').length, 3);
  click(moveButton(container, "jus", "up"));
  await flush();
  assert.deepEqual(G.__cpr.moveCalls[0].expectedOrder, ["eau", "jus", "cidre"]);
  assert.deepEqual(directNames(container, "Boissons"), ["Jus", "Eau", "Cidre"]);
});

test("[F] tout autre tri retire les boutons et rend le champ numérique historique", async () => {
  const container = await reorderView();
  for (const sort of ["price-asc", "name-desc", "name-asc"]) {
    await chooseSort(container, sort);
    assert.equal(qa(container, '[data-testid="product-move-up"]').length, 0, sort);
    assert.equal(qa(container, 'li input[type="number"]').length, 11, sort);
  }
});

test("[F] STAFF : aucun bouton, aucune indication de réordonnancement (l'autorité reste la RPC, owner/manager uniquement)", async () => {
  G.__cpr.role = "staff";
  const container = await reorderView();
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Beaufort", "Abondance"], "le tri reste consultable");
  assert.equal(qa(container, "button[data-reorder-product]").length, 0);
  assert.equal(q(container, '[data-testid="catalogue-reorder-hint"]'), null);
  assert.equal(G.__cpr.moveCalls.length, 0);
});

// ==================================================================
// G. Rechargement, carte client, non-régressions
// ==================================================================

test("[G] ORDRE DÉTERMINISTE APRÈS RECHARGEMENT : après des déplacements, un rechargement complet du catalogue réaffiche exactement le même ordre", async () => {
  const container = await reorderView();
  for (const [id, direction] of [["zeste", "up"], ["eclat", "up"], ["cidre", "up"], ["abondance", "up"]] as const) {
    click(moveButton(container, id, direction));
    await flush(40);
  }
  const before = {
    direct: directNames(container, "Fromages"), chevres: subNames(container, "Chèvres"), boissons: directNames(container, "Boissons"),
  };
  assert.deepEqual(before.chevres, ["Banon", "Zeste de chèvre", "éclat cendré", "crottin"]);

  // Aller-retour par la vue des archives : deux vrais rechargements.
  const loads = nonArchivedLoads();
  const toggle = qa(container, "button").find((b) => /archiv/i.test(b.textContent ?? ""))!;
  click(toggle);
  await flush(120);
  click(qa(container, "button").find((b) => /carte|menu/i.test(b.textContent ?? "") && b !== toggle) ?? toggle);
  await waitFor(() => nonArchivedLoads() > loads);
  await flush(120);

  assert.ok(nonArchivedLoads() > loads, "le catalogue a bien été relu");
  assert.equal((q(container, '[data-testid="catalogue-sort"]') as HTMLSelectElement).value, "catalogue-order");
  assert.deepEqual(
    { direct: directNames(container, "Fromages"), chevres: subNames(container, "Chèvres"), boissons: directNames(container, "Boissons") },
    before
  );
});

test("[G] LA CARTE CLIENT SUIT LE BACK-OFFICE : l'ordre affiché après réordonnancement est celui que le comparateur de la carte client produit sur les données enregistrées", async () => {
  const container = await reorderView();
  for (const [id, direction] of [["abondance", "up"], ["abondance", "up"], ["crottin", "down"], ["jus", "down"]] as const) {
    click(moveButton(container, id, direction));
    await flush(40);
  }
  const saved = G.__cpr.catalogue[RESTO_A] as any[];
  const publicOrder = (category: any) => {
    const subs = new Map(category.subcategories.map((s: any) => [s.subcategory_id, s]));
    return [...category.products, ...category.subcategories.flatMap((s: any) => s.products)]
      .filter((p: any) => p.is_available && !p.archived_at)
      .map((p: any) => ({
        ...p, id: p.product_id,
        subcategory_name: p.subcategory_id ? (subs.get(p.subcategory_id) as any).subcategory_name : null,
        subcategory_display_order: p.subcategory_id ? (subs.get(p.subcategory_id) as any).subcategory_display_order : null,
      }))
      .sort(compareMenuItemsForPublicDisplay)
      .map((p: any) => p.name);
  };
  // Back-office, réduit aux produits que la carte affiche (Abondance est indisponible).
  const backOffice = (categoryName: string) =>
    renderedNames(section(container, categoryName)).filter((name) => name !== "Abondance");
  assert.deepEqual(backOffice("Fromages"), publicOrder(saved[0]));
  assert.deepEqual(backOffice("Boissons"), publicOrder(saved[1]));
  assert.deepEqual(publicOrder(saved[0]).slice(0, 2), ["Comté", "Beaufort"], "Abondance, 1re au back-office, est masquée sans décaler les autres");
});

test("[G] NON-RÉGRESSION DISPONIBILITÉ : un déplacement ne change la disponibilité d'aucun produit, et la bascule de disponibilité fonctionne dans la vue de réordonnancement", async () => {
  const container = await reorderView();
  const availabilityLabel = (id: string) =>
    (qa(card(container, id), "button").find((b) => b.hasAttribute("aria-pressed"))?.textContent ?? "").trim();
  const before = Object.fromEntries(["comte", "beaufort", "abondance"].map((id) => [id, availabilityLabel(id)]));
  assert.notEqual(before.abondance, before.beaufort, "Abondance est indisponible, Beaufort disponible");

  click(moveButton(container, "abondance", "up"));
  await flush();
  click(moveButton(container, "abondance", "up"));
  await flush();
  assert.deepEqual(Object.fromEntries(["comte", "beaufort", "abondance"].map((id) => [id, availabilityLabel(id)])), before);
  assert.equal(G.__cpr.availabilityCalls.length, 0, "aucun appel de disponibilité déclenché par un déplacement");
  const saved = (G.__cpr.catalogue[RESTO_A] as any[])[0].products;
  assert.equal(saved.find((p: any) => p.product_id === "abondance").is_available, false);
  assert.equal(saved.find((p: any) => p.product_id === "beaufort").is_available, true);

  click(qa(card(container, "beaufort"), "button").find((b) => b.hasAttribute("aria-pressed")));
  await flush(120);
  assert.deepEqual(G.__cpr.availabilityCalls, [["beaufort", false]]);
});

test("[G] NON-RÉGRESSION MODES DE VENTE : après déplacement, enregistrer la fiche d'un produit renvoie sa restriction de modes de vente et sa sous-catégorie inchangées", async () => {
  const container = await reorderView();
  click(moveButton(container, "comte", "down"));
  await flush();
  assert.deepEqual(directNames(container, "Fromages"), ["Beaufort", "Comté", "Abondance"]);

  click(qa(card(container, "comte"), "button").find((b) => (b.textContent ?? "").trim() === "Modifier"));
  await flush();
  const save = qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Enregistrer");
  click(save);
  await flush(120);

  assert.equal(G.__cpr.updateCalls.length, 1);
  const [productId, name, , price, , fiscal, subcategoryId] = G.__cpr.updateCalls[0] as any[];
  assert.equal(productId, "comte");
  assert.equal(name, "Comté");
  assert.equal(price, 12.5);
  assert.deepEqual(fiscal.allowedSaleModes, ["pickup"], "restriction « retrait uniquement » intacte");
  assert.equal(fiscal.withdrawalEligible, false);
  assert.equal(subcategoryId, null, "aucun changement de sous-catégorie");
  const saved = (G.__cpr.catalogue[RESTO_A] as any[])[0].products.find((p: any) => p.product_id === "comte");
  assert.deepEqual(saved.allowed_sale_modes, ["pickup"]);
});

test("[G] NON-RÉGRESSION EXPORT : l'export complet reste un .xlsx au même contrat de colonnes, et ses lignes suivent l'ordre persisté -- y compris depuis la vue par défaut (alphabétique)", async () => {
  const container = await reorderView();
  for (const [id, direction] of [["beaufort", "up"], ["zeste", "up"], ["jus", "down"]] as const) {
    click(moveButton(container, id, direction));
    await flush(40);
  }
  // Retour au tri alphabétique : l'export COMPLET ne dépend pas du tri affiché.
  await chooseSort(container, "name-asc");
  assert.deepEqual(directNames(container, "Fromages"), ["Abondance", "Beaufort", "Comté"]);

  const blobs: ArrayBuffer[] = [];
  const names: string[] = [];
  const RealBlob = (globalThis as any).Blob;
  (globalThis as any).Blob = class extends RealBlob {
    constructor(parts: any[], options: any) {
      super(parts, options);
      blobs.push(parts[0] as ArrayBuffer);
    }
  };
  const realCreateEl = window.document.createElement.bind(window.document);
  (window.URL as any).createObjectURL = () => "blob:mock";
  (window.URL as any).revokeObjectURL = () => {};
  (globalThis as any).URL = window.URL;
  (window.document as any).createElement = (tag: string) => {
    const el = realCreateEl(tag);
    if (tag === "a") Object.defineProperty(el, "click", { value: () => names.push((el as HTMLAnchorElement).download) });
    return el;
  };
  try {
    click(q(container, '[data-testid="catalogue-export-all"]'));
    await flush();
    click(q(container, '[data-testid="catalogue-export-filtered"]'));
    await flush();
  } finally {
    (window.document as any).createElement = realCreateEl;
    (globalThis as any).Blob = RealBlob;
  }

  assert.equal(blobs.length, 2);
  assert.match(names[0], /^catalogue-complet-\d{4}-\d{2}-\d{2}\.xlsx$/);
  // Relu par le lecteur d'IMPORT de production.
  const full = readXlsxWorkbook(blobs[0]);
  assert.deepEqual(full.rows[0], [
    "Type", "Nom", "Catégorie parent", "Sous-catégorie parent", "Tags / Collections", "Description courte",
    "Description longue", "Prix TTC (€)", "TVA (%)", "Poids (g)", "Photo fichier", "Rétractable", "Modes de vente",
    "Disponible", "Prix de référence (€/kg)",
  ]);
  assert.deepEqual(full.rows.slice(1).map((r) => r[1]), [
    "Beaufort", "Comté", "Abondance",
    "Banon", "Zeste de chèvre", "crottin", "éclat cendré",
    "Ossau",
    "Eau", "Cidre", "Jus",
  ]);
  // L'export des résultats reste la liste AFFICHÉE (ici alphabétique).
  const filtered = readXlsxWorkbook(blobs[1]);
  assert.deepEqual(filtered.rows.slice(1).map((r) => r[1]).slice(0, 3), ["Abondance", "Banon", "Beaufort"]);
});

test("[G] MARCHAND HISTORIQUE : ouvrir la vue « Ordre de la carte » sans rien déplacer n'envoie AUCUNE écriture et ne modifie aucune valeur enregistrée", async () => {
  const container = await reorderView();
  await chooseSort(container, "name-asc");
  await chooseSort(container, "catalogue-order");
  await flush();
  assert.equal(G.__cpr.moveCalls.length, 0);
  assert.equal(G.__cpr.orderCalls.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(G.__cpr.catalogue[RESTO_A])), catalogueA());
  assert.deepEqual(subNames(container, "Chèvres"), ["Banon", "crottin", "Zeste de chèvre", "éclat cendré"]);
});

after(async () => {
  if (mounted) {
    mounted.root.unmount();
    mounted = null;
  }
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of ["window", "document", "navigator", "HTMLElement", "Event", "File", "Blob", "requestAnimationFrame", "cancelAnimationFrame"]) {
    delete (globalThis as any)[k];
  }
});
