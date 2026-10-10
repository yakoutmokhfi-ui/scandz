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
import { moveProductOrderModel, type RpcModelRow } from "./helpers/catalogue-product-reorder-rpc-model.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — CATALOGUE PRODUCT REORDER v1 — rendu RÉEL de
// app/dashboard/catalogue/page.tsx (esbuild + jsdom).
//
// Seuls les services réseau sont remplacés : l'écran, son état, ses
// gardes et son rendu sont les vrais.
//
// LE « SERVEUR » SIMULÉ EXÉCUTE LE VRAI CONTRAT DE LA RPC (audit,
// CPR-AUDIT-01). Dans la première version, il comparait la liste
// d'identifiants reçue à l'ordre courant : il était PLUS STRICT que le
// SQL de production et masquait donc la vue périmée que celui-ci
// acceptait. Il exécute désormais moveProductOrderModel
// (tests/helpers/catalogue-product-reorder-rpc-model.ts), dont
// tests/catalogue-product-reorder-v1-sql.test.ts (« [MODÈLE] ») prouve
// qu'il rend la même décision et les mêmes écritures que le SQL réel,
// scénario par scénario. Ce que ce faux serveur accepte ou refuse est
// donc ce que la base accepterait ou refuserait -- ni plus, ni moins.
//
// AUCUNE RÉSOLUTION DE PAQUET PAR ESBUILD. Tout spécificateur « nu »
// (react, fflate…) est EXTERNALISÉ et chargé par Node, comme n'importe
// quel import du reste de la suite ; esbuild ne lit rien dans
// node_modules. La première version laissait esbuild résoudre
// `fflate` : sur un poste où le résolveur d'esbuild n'y parvient pas,
// ce fichier ne se chargeait pas avec la commande standard.
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

type ScopeEntry = { id: string; display_order: number; name: string };

const G = globalThis as any;
G.__cpr = {
  catalogue: {} as Record<string, unknown[]>,
  role: "owner",
  catalogueLoads: [] as Array<{ id: string; archived: boolean }>,
  /** Appels reçus par le service : `expectedScope` est la vue telle
   *  qu'elle part sur le réseau ; `expectedOrder` en est la simple
   *  liste d'identifiants (commodité de lecture des assertions). */
  moveCalls: [] as Array<{ productId: string; direction: string; expectedScope: ScopeEntry[]; expectedOrder: string[] }>,
  moveImpl: null as null | ((productId: string, direction: string, expectedScope: unknown) => Promise<number>),
  /** Décision rendue par le « serveur » pour chaque appel qu'il traite. */
  serverOutcomes: [] as string[],
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
  // référence de l'état « serveur ». Comme get_merchant_catalogue
  // (p_archived = false), la vue courante ne rend pas les archivés.
  const live = (products) => (products ?? []).filter((p) => !p.archived_at);
  return JSON.parse(JSON.stringify(S().catalogue[id] ?? [])).map((c) => ({
    ...c,
    products: live(c.products),
    subcategories: (c.subcategories ?? []).map((s) => ({ ...s, products: live(s.products) })),
  }));
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
globalThis.__cprBoundaryError = ProductOrderBoundaryError;
export async function moveProductOrder(productId, direction, expectedScope) {
  // Aller-retour JSON : ce que le « serveur » reçoit est ce qui
  // traverserait le réseau, jamais une référence à l'état de l'écran.
  const wire = JSON.parse(JSON.stringify(expectedScope));
  globalThis.__cpr.moveCalls.push({ productId, direction, expectedScope: wire, expectedOrder: wire.map((e) => e.id) });
  return globalThis.__cpr.moveImpl(productId, direction, JSON.parse(JSON.stringify(wire)));
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

/**
 * Paquets que le code de l'écran importe par un spécificateur « nu ».
 * Ils sont EXTERNALISÉS : le bundle garde l'import tel quel et c'est
 * Node qui le résout au chargement, depuis node_modules du dépôt --
 * exactement comme les imports de ce fichier de test lui-même.
 *
 * `fflate` (lib/catalogue-management/export.ts) en fait partie : la
 * fonction d'export RÉELLE s'exécute toujours, avec la bibliothèque
 * réelle, et le classeur produit est relu plus bas octet par octet.
 * Rien n'est remplacé par un double.
 */
const EXTERNAL_PACKAGES = new Set(["react", "react/jsx-runtime", "react-dom", "react-dom/client", "fflate"]);
/** Spécificateurs nus effectivement rencontrés pendant le bundling. */
const bareSpecifiersSeen = new Set<string>();

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
      // Import relatif ou chemin absolu : fichier du dépôt, résolution
      // de fichier ordinaire.
      if (args.path.startsWith(".") || path.isAbsolute(args.path)) return undefined;
      // Spécificateur NU : jamais confié au résolveur de paquets
      // d'esbuild. Connu -> externalisé ; inconnu -> échec explicite
      // (plutôt qu'une résolution silencieuse dans node_modules).
      bareSpecifiersSeen.add(args.path);
      if (EXTERNAL_PACKAGES.has(args.path)) return { path: args.path, external: true };
      return {
        errors: [{
          text: `paquet « ${args.path} » importé par ${args.importer} : il doit être ajouté à EXTERNAL_PACKAGES (chargé par Node) ou remplacé par un double dans \`mocks\`. esbuild ne résout aucun paquet dans ce test.`,
        }],
      };
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
  metafile: true,
  plugins: [mockPlugin],
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

/** Lignes « menu_items » de l'état serveur d'un établissement, telles
 *  que la RPC les verrait (périmètre = le panier qui porte le produit). */
function serverRows(restaurantId = RESTO_A): RpcModelRow[] {
  const rows: RpcModelRow[] = [];
  for (const category of G.__cpr.catalogue[restaurantId] ?? []) {
    for (const p of category.products ?? []) {
      rows.push({ id: p.product_id, category_id: category.category_id, subcategory_id: null, name: p.name, display_order: p.display_order, archived_at: p.archived_at ?? null });
    }
    for (const subcategory of category.subcategories ?? []) {
      for (const p of subcategory.products ?? []) {
        rows.push({ id: p.product_id, category_id: category.category_id, subcategory_id: subcategory.subcategory_id, name: p.name, display_order: p.display_order, archived_at: p.archived_at ?? null });
      }
    }
  }
  return rows;
}
/** Produit de l'état serveur, par identifiant (pour qu'un « autre
 *  utilisateur » le modifie pendant que l'écran est ouvert). */
function serverProduct(id: string, restaurantId = RESTO_A): any {
  for (const category of G.__cpr.catalogue[restaurantId] ?? []) {
    for (const p of [...(category.products ?? []), ...(category.subcategories ?? []).flatMap((s: any) => s.products ?? [])]) {
      if (p.product_id === id) return p;
    }
  }
  throw new Error(`produit serveur introuvable : ${id}`);
}
/** Instantané OCTET POUR OCTET de l'état serveur (toutes les colonnes
 *  lues par la RPC, de tous les produits). */
function serverSnapshot(restaurantId = RESTO_A): string {
  return JSON.stringify([...serverRows(restaurantId)].sort((a, b) => (a.id < b.id ? -1 : 1)));
}
/** « nom=valeur|… » d'un périmètre serveur, par valeur puis nom. */
function serverState(categoryId: string, subcategoryId: string | null, restaurantId = RESTO_A): string {
  return serverRows(restaurantId)
    .filter((r) => r.category_id === categoryId && r.subcategory_id === subcategoryId && r.archived_at === null)
    .sort((a, b) => a.display_order - b.display_order || (a.name < b.name ? -1 : 1))
    .map((r) => `${r.name}=${r.display_order}`)
    .join("|");
}

/**
 * « Serveur » : exécute le CONTRAT RÉEL de move_product_order
 * (moveProductOrderModel, prouvé équivalent au SQL) sur l'état serveur
 * courant, applique les écritures qu'il rend, ou lève l'erreur typée
 * que le vrai service lèverait.
 */
function serverAccepts(restaurantId = RESTO_A) {
  return async (productId: string, direction: string, expectedScope: unknown) => {
    const outcome = moveProductOrderModel(serverRows(restaurantId), productId, direction, expectedScope);
    G.__cpr.serverOutcomes.push(outcome.kind);
    switch (outcome.kind) {
      case "moved":
        for (const [id, displayOrder] of Object.entries(outcome.writes)) serverProduct(id, restaurantId).display_order = displayOrder;
        return outcome.position;
      case "stale":
        throw new G.__cprStaleError();
      case "boundary":
        throw new G.__cprBoundaryError();
      case "not_found":
        throw new Error("Product not found or archived");
      default:
        throw new Error("SCANYM_PRODUCT_ORDER_INVALID_DIRECTION");
    }
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
  G.__cpr.serverOutcomes = [];
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

  assert.deepEqual(G.__cpr.moveCalls, [{
    productId: "beaufort", direction: "up", expectedOrder: ["comte", "beaufort", "abondance"],
    // La vue transmise : pour chaque produit du périmètre, dans
    // l'ordre affiché, les trois champs reçus du serveur -- et eux seuls.
    expectedScope: [
      { id: "comte", display_order: 1, name: "Comté" },
      { id: "beaufort", display_order: 2, name: "Beaufort" },
      { id: "abondance", display_order: 3, name: "Abondance" },
    ],
  }]);
  assert.deepEqual(G.__cpr.serverOutcomes, ["moved"]);
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
  assert.deepEqual(
    G.__cpr.moveCalls.map(({ productId, direction, expectedOrder }: any) => ({ productId, direction, expectedOrder })),
    [{ productId: "beaufort", direction: "down", expectedOrder: ["comte", "beaufort", "abondance"] }]
  );
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
  // Chaque vue transmise porte les display_order que le déplacement
  // précédent a écrits (5/9/14 d'origine, puis 1..3 denses) : enchaîner
  // sans recharger n'envoie jamais une vue périmée.
  assert.deepEqual(G.__cpr.moveCalls.map((c: any) => c.expectedScope.map((e: ScopeEntry) => e.display_order)), [
    [5, 9, 14],
    [1, 2, 3],
    [1, 2, 3],
  ]);
  assert.deepEqual(G.__cpr.serverOutcomes, ["moved", "moved", "moved"]);
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

// ==================================================================
// H. FRAÎCHEUR DE LA VUE -- remédiation CPR-AUDIT-01, sur l'écran réel
//
// Les dix cas du mandat. Patron : l'écran est ouvert sur une vue ; un
// AUTRE utilisateur modifie l'état « serveur » ; le marchand clique.
// L'écran envoie SA vue (périmée) ; le serveur -- qui exécute le
// contrat réel -- la refuse ; rien n'est écrit ; l'écran recharge et
// affiche l'ordre qui fait autorité.
// ==================================================================

const STALE_MESSAGE = /L'ordre des produits a changé entre-temps/;

/**
 * Clique un bouton de déplacement alors que la vue de l'écran est
 * PÉRIMÉE, et vérifie tout ce que le mandat exige :
 *   - la vue partie sur le réseau est EXACTEMENT celle que l'écran
 *     affichait (`staleView`), et non l'état serveur ;
 *   - le serveur la refuse comme périmée ;
 *   - l'état serveur est identique OCTET POUR OCTET ;
 *   - l'écran recharge, l'explique, et n'applique aucun échange local.
 */
async function clickWithStaleView(
  container: HTMLElement,
  productId: string,
  direction: "up" | "down",
  staleView: ScopeEntry[]
): Promise<void> {
  const before = serverSnapshot();
  const loads = nonArchivedLoads();
  const calls = G.__cpr.moveCalls.length;

  click(moveButton(container, productId, direction));
  await waitFor(() => nonArchivedLoads() > loads);
  await flush(120);

  assert.equal(G.__cpr.moveCalls.length, calls + 1, "un appel RPC, un seul");
  const call = G.__cpr.moveCalls[calls];
  assert.equal(call.productId, productId);
  assert.equal(call.direction, direction);
  assert.deepEqual(call.expectedScope, staleView, "la vue transmise est celle que l'écran affichait");
  assert.equal(G.__cpr.serverOutcomes.at(-1), "stale", "VUE PÉRIMÉE REFUSÉE par le contrat réel");
  assert.equal(serverSnapshot(), before, "AUCUNE ÉCRITURE : état serveur identique octet pour octet");
  assert.equal(nonArchivedLoads(), loads + 1, "le catalogue est rechargé après le refus");
  assert.match(container.textContent ?? "", STALE_MESSAGE);
  assert.match(statusText(container), STALE_MESSAGE, "le refus est annoncé, jamais un déplacement réussi");
  assert.ok(!(container.textContent ?? "").includes("SCANYM_PRODUCT_ORDER_STALE"));
}

test("[H] CPR-01 / 1. REPRODUCTION EXACTE DE L'AUDIT : Comté=1 Beaufort=2 Abondance=3 ; un autre utilisateur passe Comté à 2 ; l'écran périmé [Comté, Beaufort, Abondance] demande « Abondance UP » -> VUE PÉRIMÉE REFUSÉE, AUCUNE ÉCRITURE", async () => {
  const container = await reorderView();
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Beaufort", "Abondance"]);
  assert.equal(serverState("c1", null), "Comté=1|Beaufort=2|Abondance=3");

  // Un autre utilisateur : Comté -> display_order 2.
  serverProduct("comte").display_order = 2;
  assert.equal(serverState("c1", null), "Beaufort=2|Comté=2|Abondance=3", "l'ordre qui fait autorité : Beaufort, Comté, Abondance");
  assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Beaufort", "Abondance"], "l'écran, lui, affiche encore l'ancienne vue");

  await clickWithStaleView(container, "abondance", "up", [
    { id: "comte", display_order: 1, name: "Comté" },
    { id: "beaufort", display_order: 2, name: "Beaufort" },
    { id: "abondance", display_order: 3, name: "Abondance" },
  ]);
  assert.equal(serverState("c1", null), "Beaufort=2|Comté=2|Abondance=3", "le changement validé par l'autre utilisateur n'est pas écrasé");
  assert.deepEqual(directNames(container, "Fromages"), ["Beaufort", "Comté", "Abondance"], "après rechargement : l'ordre qui fait autorité");

  // Le marchand refait son geste sur la vue à jour : il s'applique à
  // l'ordre RÉEL (Abondance passe devant Comté, pas devant Beaufort).
  click(moveButton(container, "abondance", "up"));
  await flush();
  assert.equal(G.__cpr.serverOutcomes.at(-1), "moved");
  assert.deepEqual(G.__cpr.moveCalls.at(-1).expectedScope, [
    { id: "beaufort", display_order: 2, name: "Beaufort" },
    { id: "comte", display_order: 2, name: "Comté" },
    { id: "abondance", display_order: 3, name: "Abondance" },
  ]);
  assert.deepEqual(directNames(container, "Fromages"), ["Beaufort", "Abondance", "Comté"]);
  assert.equal(serverState("c1", null), "Beaufort=1|Abondance=2|Comté=3");
});

test("[H] CPR-01 / 2. EX ÆQUO INTRODUIT par un autre utilisateur après le chargement -> refusé, aucune écriture", async () => {
  const container = await reorderView();
  serverProduct("cidre").display_order = 9; // rejoint Jus : l'ordre visible devient Eau, Cidre, Jus
  await clickWithStaleView(container, "jus", "up", [
    { id: "eau", display_order: 5, name: "Eau" },
    { id: "jus", display_order: 9, name: "Jus" },
    { id: "cidre", display_order: 14, name: "Cidre" },
  ]);
  assert.deepEqual(directNames(container, "Boissons"), ["Eau", "Cidre", "Jus"]);
});

test("[H] CPR-01 / 3. EX ÆQUO SUPPRIMÉ par un autre utilisateur après le chargement -> refusé, aucune écriture, même quand l'ordre visible ne change pas", async () => {
  const container = await reorderView();
  const shown = subNames(container, "Chèvres");
  assert.deepEqual(shown, ["Banon", "crottin", "Zeste de chèvre", "éclat cendré"]);
  serverProduct("banon").display_order = -1; // quitte l'ex æquo, reste premier
  await clickWithStaleView(container, "zeste", "up", [
    { id: "banon", display_order: 0, name: "Banon" },
    { id: "crottin", display_order: 0, name: "crottin" },
    { id: "zeste", display_order: 0, name: "Zeste de chèvre" },
    { id: "eclat", display_order: 0, name: "éclat cendré" },
  ]);
  assert.deepEqual(subNames(container, "Chèvres"), shown, "même ordre visible -- la vue n'en était pas moins périmée");
});

test("[H] CPR-01 / 4. CHAMP DE DÉPARTAGE modifié alors que tous les display_order sont identiques -> refusé, aucune écriture", async () => {
  const container = await reorderView();
  const orders = () => serverRows().map((r) => `${r.id}=${r.display_order}`).sort().join(",");
  const ordersBefore = orders();
  // Renommage : aucun display_order ne bouge, mais le départage par
  // nom fait passer le produit de premier à deuxième.
  serverProduct("banon").name = "Tomme de Banon";
  NAMES.banon = "Tomme de Banon";
  try {
    assert.equal(orders(), ordersBefore, "aucun display_order modifié par l'autre utilisateur");
    await clickWithStaleView(container, "crottin", "up", [
      { id: "banon", display_order: 0, name: "Banon" },
      { id: "crottin", display_order: 0, name: "crottin" },
      { id: "zeste", display_order: 0, name: "Zeste de chèvre" },
      { id: "eclat", display_order: 0, name: "éclat cendré" },
    ]);
    assert.deepEqual(subNames(container, "Chèvres"), ["crottin", "Tomme de Banon", "Zeste de chèvre", "éclat cendré"], "l'ordre visible avait changé");
  } finally {
    NAMES.banon = "Banon";
  }
});

test("[H] CPR-01 / 5. PRODUIT INSÉRÉ dans le périmètre après le chargement -> refusé, aucune écriture", async () => {
  const container = await reorderView();
  G.__cpr.catalogue[RESTO_A][1].products.push(
    prod({ product_id: "limonade", name: "Limonade", category_id: "c2", category_name: "Boissons", display_order: 15 })
  );
  await clickWithStaleView(container, "jus", "up", [
    { id: "eau", display_order: 5, name: "Eau" },
    { id: "jus", display_order: 9, name: "Jus" },
    { id: "cidre", display_order: 14, name: "Cidre" },
  ]);
  assert.deepEqual(directNames(container, "Boissons"), ["Eau", "Jus", "Cidre", "Limonade"]);
});

test("[H] CPR-01 / 6. PRODUIT ARCHIVÉ (retiré du périmètre) après le chargement -> refusé, aucune écriture", async () => {
  const container = await reorderView();
  serverProduct("cidre").archived_at = "2026-10-10T08:00:00Z";
  await clickWithStaleView(container, "jus", "up", [
    { id: "eau", display_order: 5, name: "Eau" },
    { id: "jus", display_order: 9, name: "Jus" },
    { id: "cidre", display_order: 14, name: "Cidre" },
  ]);
  assert.deepEqual(directNames(container, "Boissons"), ["Eau", "Jus"], "l'archivé a quitté la carte");
  // À cardinalité ÉGALE : un produit sort, un autre entre.
  const stale: ScopeEntry[] = [
    { id: "eau", display_order: 5, name: "Eau" },
    { id: "jus", display_order: 9, name: "Jus" },
  ];
  serverProduct("eau").archived_at = "2026-10-10T08:05:00Z";
  G.__cpr.catalogue[RESTO_A][1].products.push(
    prod({ product_id: "limonade", name: "Limonade", category_id: "c2", category_name: "Boissons", display_order: 5 })
  );
  await clickWithStaleView(container, "jus", "up", stale);
  assert.deepEqual(directNames(container, "Boissons"), ["Limonade", "Jus"]);
});

test("[H] CPR-01 / 7. PRODUIT RENOMMÉ après le chargement (le nom participe au départage) -> refusé, aucune écriture, même sans ex æquo", async () => {
  const container = await reorderView();
  serverProduct("beaufort").name = "Beaufort d'alpage";
  NAMES.beaufort = "Beaufort d'alpage";
  try {
    await clickWithStaleView(container, "abondance", "up", [
      { id: "comte", display_order: 1, name: "Comté" },
      { id: "beaufort", display_order: 2, name: "Beaufort" },
      { id: "abondance", display_order: 3, name: "Abondance" },
    ]);
    assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Beaufort d'alpage", "Abondance"]);
    // Vue rechargée, nom à jour : accepté.
    click(moveButton(container, "abondance", "up"));
    await flush();
    assert.equal(G.__cpr.serverOutcomes.at(-1), "moved");
    assert.deepEqual(directNames(container, "Fromages"), ["Comté", "Abondance", "Beaufort d'alpage"]);
  } finally {
    NAMES.beaufort = "Beaufort";
  }
});

test("[H] CPR-01 / 8. LA VUE FRAÎCHE AUTORISE LE DÉPLACEMENT : périmètre dense, ex æquo historiques, et état modifié par un autre utilisateur AVANT l'ouverture de l'écran", async () => {
  // L'autre utilisateur a créé un ex æquo AVANT que l'écran ne charge :
  // la vue chargée est fraîche, donc acceptée.
  serverProduct("comte").display_order = 2;
  const container = await reorderView();
  assert.deepEqual(directNames(container, "Fromages"), ["Beaufort", "Comté", "Abondance"]);

  click(moveButton(container, "abondance", "up"));
  await flush();
  click(moveButton(container, "crottin", "up"));
  await flush();
  click(moveButton(container, "jus", "down"));
  await flush();

  assert.deepEqual(G.__cpr.serverOutcomes, ["moved", "moved", "moved"], "trois vues fraîches, trois déplacements acceptés");
  assert.deepEqual(G.__cpr.moveCalls.map((c: any) => c.expectedScope), [
    [{ id: "beaufort", display_order: 2, name: "Beaufort" }, { id: "comte", display_order: 2, name: "Comté" }, { id: "abondance", display_order: 3, name: "Abondance" }],
    [{ id: "banon", display_order: 0, name: "Banon" }, { id: "crottin", display_order: 0, name: "crottin" }, { id: "zeste", display_order: 0, name: "Zeste de chèvre" }, { id: "eclat", display_order: 0, name: "éclat cendré" }],
    [{ id: "eau", display_order: 5, name: "Eau" }, { id: "jus", display_order: 9, name: "Jus" }, { id: "cidre", display_order: 14, name: "Cidre" }],
  ]);
  assert.equal(nonArchivedLoads(), 1, "aucun rechargement : aucun refus");
  assert.equal(serverState("c1", null), "Beaufort=1|Abondance=2|Comté=3");
  assert.equal(serverState("c1", "s1"), "crottin=1|Banon=2|Zeste de chèvre=3|éclat cendré=4");
  assert.equal(serverState("c2", null), "Eau=1|Cidre=2|Jus=3");
  assert.ok(!STALE_MESSAGE.test(container.textContent ?? ""));
});

test("[H] CPR-01 / 9. UN REFUS NE CHANGE AUCUN display_order, octet pour octet : trois périmètres rendus périmés, trois clics, trois refus, état serveur intact", async () => {
  const container = await reorderView();
  serverProduct("comte").display_order = 2;
  serverProduct("cidre").display_order = 9;
  serverProduct("banon").display_order = -1;
  const before = serverSnapshot();
  const values = () => serverRows().map((r) => `${r.id}=${r.display_order}`).sort().join(",");
  const valuesBefore = values();

  // Chaque refus recharge TOUT le catalogue : seul le premier clic part
  // d'une vue périmée. On remet donc l'écran dans une vue périmée entre
  // deux clics, par un nouveau changement d'un autre utilisateur.
  click(moveButton(container, "abondance", "up"));
  await waitFor(() => G.__cpr.serverOutcomes.length === 1);
  await flush(120);
  serverProduct("jus").display_order = 9; // (déjà 9 : aucun changement d'état)
  serverProduct("eau").display_order = 9; // nouvel ex æquo à trois
  const mid = serverSnapshot();
  click(moveButton(container, "cidre", "up"));
  await waitFor(() => G.__cpr.serverOutcomes.length === 2);
  await flush(120);
  serverProduct("zeste").name = "Zeste";
  NAMES.zeste = "Zeste";
  const last = serverSnapshot();
  try {
    click(moveButton(container, "crottin", "down"));
    await waitFor(() => G.__cpr.serverOutcomes.length === 3);
    await flush(120);
  } finally {
    NAMES.zeste = "Zeste de chèvre";
  }

  assert.deepEqual(G.__cpr.serverOutcomes, ["stale", "stale", "stale"]);
  assert.notEqual(mid, before);
  assert.equal(serverSnapshot(), last, "le dernier refus n'a rien écrit");
  // Les SEULS changements de l'état serveur sont ceux de l'autre
  // utilisateur : aucun display_order n'a été écrit par un refus.
  assert.equal(
    values(),
    valuesBefore.replace("eau=5", "eau=9"),
    "chaque display_order est celui posé par l'autre utilisateur, octet pour octet"
  );
});

test("[H] CPR-01 / 10. DEUX DÉPLACEURS CONCURRENTS partis de la même vue : le premier est ACCEPTÉ, le second -- cet écran -- est REFUSÉ comme périmé", async () => {
  const container = await reorderView();
  const sharedView: ScopeEntry[] = [
    { id: "comte", display_order: 1, name: "Comté" },
    { id: "beaufort", display_order: 2, name: "Beaufort" },
    { id: "abondance", display_order: 3, name: "Abondance" },
  ];

  // Cet écran envoie son déplacement ; pendant qu'il est EN VOL, un
  // autre client, parti de la même vue, est servi le premier.
  const server = serverAccepts();
  let serve!: () => void;
  const gate = new Promise<void>((resolve) => { serve = resolve; });
  G.__cpr.moveImpl = async (productId: string, direction: string, expectedScope: unknown) => {
    await gate;
    return server(productId, direction, expectedScope);
  };
  const loads = nonArchivedLoads();
  click(moveButton(container, "abondance", "up"));
  await flush();
  assert.deepEqual(G.__cpr.moveCalls.at(-1).expectedScope, sharedView);

  assert.equal(await server("beaufort", "up", JSON.parse(JSON.stringify(sharedView))), 1, "premier déplaceur : ACCEPTÉ");
  assert.equal(serverState("c1", null), "Beaufort=1|Comté=2|Abondance=3");
  const afterFirst = serverSnapshot();

  serve();
  await waitFor(() => nonArchivedLoads() > loads);
  await flush(120);

  assert.deepEqual(G.__cpr.serverOutcomes, ["moved", "stale"], "second déplaceur : REFUSÉ comme périmé");
  assert.equal(serverSnapshot(), afterFirst, "seul le déplacement du premier est enregistré");
  assert.deepEqual(directNames(container, "Fromages"), ["Beaufort", "Comté", "Abondance"], "l'écran affiche l'ordre validé par le premier");
  assert.match(statusText(container), STALE_MESSAGE);
});

// ==================================================================
// I. Chargement avec la commande standard : aucun paquet résolu par
//    esbuild
// ==================================================================

test("[I] le bundle de l'écran ne contient AUCUN fichier de node_modules : chaque paquet importé (react, fflate) est externalisé et chargé par Node, esbuild ne résout aucun paquet", () => {
  const inputs = Object.keys(buildResult.metafile!.inputs);
  assert.ok(inputs.length > 20, "le vrai écran et ses dépendances du dépôt ont bien été bundlés");
  assert.ok(inputs.some((file) => file.replaceAll("\\", "/").endsWith("app/dashboard/catalogue/page.tsx")));
  assert.ok(inputs.some((file) => file.replaceAll("\\", "/").endsWith("lib/catalogue-management/export.ts")), "la fonction d'export RÉELLE est dans le bundle");
  assert.deepEqual(inputs.filter((file) => file.replaceAll("\\", "/").includes("node_modules/")), []);

  // Les spécificateurs nus rencontrés sont exactement ceux déclarés.
  for (const specifier of bareSpecifiersSeen) assert.ok(EXTERNAL_PACKAGES.has(specifier), specifier);
  assert.ok(bareSpecifiersSeen.has("fflate"), "l'écran importe bien fflate (export XLSX)");
  assert.ok(bareSpecifiersSeen.has("react"));

  // Le bundle garde ces imports tels quels : c'est Node qui les résout.
  const externalImports = Object.values(buildResult.metafile!.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external)
    .map((entry) => entry.path);
  assert.deepEqual([...new Set(externalImports)].sort(), [...bareSpecifiersSeen].sort());
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
