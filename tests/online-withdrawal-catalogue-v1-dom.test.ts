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
// Scanym — ONLINE WITHDRAWAL v1 — rendu RÉEL de
// app/dashboard/catalogue/page.tsx (esbuild + jsdom).
//
// Seuls les services sont mockés : l'écran, son état et son rendu
// conditionnel sont les vrais. Ce fichier prouve ce que la logique
// pure ne peut pas prouver seule -- que l'ÉCRAN marchand offre bien
// le contrôle « Rétractable » (Oui/Non) et le filtre de liste à trois
// états (Tous/Oui/Non), et que la valeur choisie atteint réellement
// createProduct/updateProduct.
//
// La logique (défaut, filtre, export/import XLSX, valeur invalide) est
// prouvée séparément par tests/online-withdrawal-catalogue-v1.test.ts.
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

// Deux commerçants : Victor (affiché) et Hugo (second établissement).
const RESTO_VICTOR = "resto-victor";
const RESTO_HUGO = "resto-hugo";

(globalThis as any).__catalogueByRestaurant = {} as Record<string, unknown>;
(globalThis as any).__productCalls = [] as Array<{ fn: string; args: unknown[] }>;

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/catalogue"; }
export function useSearchParams() { return new URLSearchParams("r=${RESTO_VICTOR}"); }
`;
const MOCK_AUTH = `
export async function getUser() { return { id: "u1" }; }
export async function getSession() { return { access_token: "t", user: { id: "u1" } }; }
export async function signOut() {}
`;
const MOCK_DASHBOARD = `
export async function getMerchantCatalogue(id, archived) {
  return (globalThis).__catalogueByRestaurant[id] ?? [];
}
export async function getMerchantRestaurants() {
  return [
    { restaurant_id: "${RESTO_VICTOR}", name: "Chez Victor", role: "owner" },
    { restaurant_id: "${RESTO_HUGO}", name: "Chez Hugo", role: "owner" },
  ];
}
export async function getRestaurantSettings() {
  return { currency: "EUR", staff_receipt_language: "fr" };
}
export async function createProduct(...args) {
  (globalThis).__productCalls.push({ fn: "createProduct", args });
  return "prod-new";
}
export async function updateProduct(...args) {
  (globalThis).__productCalls.push({ fn: "updateProduct", args });
}
export async function archiveProduct() {}
export async function restoreProduct() {}
export async function setProductAvailability() {}
export async function setProductOrder() {}
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
const MOCK_TAGS = `
export async function getRestaurantProductTags() { return []; }
export async function getRestaurantTags() { return []; }
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
  "@/lib/services/catalogue-tags": MOCK_TAGS,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  // PRODUCT SERVICE MODES v1 -- getPublicSaleModes() n'est pas l'objet de
  // ce test ; tableau vide, patron déjà suivi par les autres mocks ci-dessus.
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-wd-"));
const tmpFile = path.join(tmpDir, "CataloguePage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { CataloguePage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

function prod(over: Record<string, unknown> = {}) {
  return {
    product_id: "p-victor",
    category_id: "c1",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Coffret de Victor",
    name_hash: "h",
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 24,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: 5.5,
    unit_weight_grams: 250,
    weight_is_approximate: false,
    reference_price_per_kg: 96,
    withdrawal_eligible: false,
    ...over,
  };
}

function cat(over: Record<string, unknown> = {}) {
  return {
    category_id: "c1",
    category_name: "Fromages",
    category_name_hash: "h",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [],
    subcategories: [],
    ...over,
  };
}

const CATALOGUE_VICTOR_HUGO = [
  cat({
    products: [
      prod({ product_id: "p-victor", name: "Coffret de Victor", withdrawal_eligible: true }),
      prod({ product_id: "p-hugo", name: "Tomme de Hugo", price: 9.9, withdrawal_eligible: false }),
    ],
  }),
];

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CataloguePage));
  return { container, root };
}

function flush(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
function q(c: HTMLElement, sel: string) {
  return c.querySelector(sel) as HTMLElement | null;
}
function qa(c: HTMLElement, sel: string) {
  return [...c.querySelectorAll(sel)] as HTMLElement[];
}
function setValue(el: HTMLElement, value: string, proto: any) {
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event(proto === window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
function click(el: Element | null) {
  assert.ok(el, "élément à cliquer introuvable");
  el!.dispatchEvent(new window.Event("click", { bubbles: true }));
}

/** Noms des produits RÉELLEMENT rendus dans la liste (même patron que
 *  tests/catalogue-management-ux-v1.dom.test.ts : l'écran n'expose pas
 *  de data-testid par produit, on lit donc les cartes rendues). */
const PRODUCT_NAMES = /Coffret de Victor|Tomme de Hugo/;
function renderedProductNames(container: HTMLElement): string[] {
  return qa(container, "li")
    .map((li) => li.textContent ?? "")
    .filter((txt) => PRODUCT_NAMES.test(txt))
    .map((txt) => (txt.match(PRODUCT_NAMES) ?? [""])[0]);
}

async function openProductEditor(container: HTMLElement, productName: string): Promise<void> {
  const card = qa(container, "li").find((li) => (li.textContent ?? "").includes(productName));
  assert.ok(card, `carte produit « ${productName} » introuvable`);
  const btn = qa(card!, "button").find((b) => (b.textContent ?? "").trim() === "Modifier");
  assert.ok(btn, `bouton « Modifier » absent de la carte « ${productName} »`);
  click(btn!);
  await flush();
}

async function renderCatalogue(categories: unknown[]): Promise<HTMLElement> {
  (globalThis as any).__catalogueByRestaurant = { [RESTO_VICTOR]: categories };
  (globalThis as any).__productCalls = [];
  const { container } = render();
  await waitFor(() => !!q(container, '[data-testid="catalogue-toolbar"]'));
  await flush();
  return container;
}

// ==================================================================
// A. Formulaire produit -- défaut « Non » pour un NOUVEAU produit
// ==================================================================

test("[A] création : le contrôle « Rétractable » est présent, libellé, et vaut « Non » par défaut", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);

  const addBtn = qa(container, "button").find((b) => (b.textContent ?? "").includes("Produit"));
  click(addBtn ?? null);
  await flush();

  const select = q(container, "#product-withdrawal-eligible") as HTMLSelectElement | null;
  assert.ok(select, "contrôle « Rétractable » absent du formulaire de création");
  assert.equal(select!.value, "no", "un nouveau produit vaut « Non » par défaut");

  const label = qa(container, "label").find((l) => l.getAttribute("for") === "product-withdrawal-eligible");
  assert.ok(label, "aucun <label for=\"product-withdrawal-eligible\">");
  assert.equal((label!.textContent ?? "").trim(), "Rétractable");

  // EXACTEMENT deux valeurs : Oui et Non, jamais un troisième état.
  assert.deepEqual(
    qa(select!, "option").map((o) => (o.textContent ?? "").trim()),
    ["Oui", "Non"]
  );
});

test("[A] création : le choix « Oui » atteint createProduct, jamais un false posé en douce", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);

  const addBtn = qa(container, "button").find((b) => (b.textContent ?? "").includes("Produit"));
  click(addBtn ?? null);
  await flush();

  setValue(q(container, "#product-name")!, "Coffret cadeau de Hugo", window.HTMLInputElement);
  setValue(q(container, "#product-price")!, "30", window.HTMLInputElement);
  setValue(q(container, "#product-withdrawal-eligible")!, "yes", window.HTMLSelectElement);
  await flush();

  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Créer") ?? null);
  await flush(150);

  const calls = (globalThis as any).__productCalls as Array<{ fn: string; args: any[] }>;
  const create = calls.find((c) => c.fn === "createProduct");
  assert.ok(create, "createProduct doit être appelée");
  assert.equal(create!.args[5].withdrawalEligible, true);
});

// ==================================================================
// B. Édition : la valeur existante est chargée et modifiable
// ==================================================================

test("[B] édition : le contrôle reflète la valeur ACTUELLE du produit (Oui pour Victor, Non pour Hugo)", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);

  await openProductEditor(container, "Coffret de Victor");
  assert.equal((q(container, "#product-withdrawal-eligible") as HTMLSelectElement).value, "yes");

  click(qa(container, "button").find((b) => /Annuler/i.test(b.textContent ?? "")) ?? null);
  await flush();

  await openProductEditor(container, "Tomme de Hugo");
  assert.equal((q(container, "#product-withdrawal-eligible") as HTMLSelectElement).value, "no");
});

test("[B] édition : basculer « Oui » -> « Non » transmet false à updateProduct -- la valeur n'est jamais perdue en route", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);
  await openProductEditor(container, "Coffret de Victor");

  setValue(q(container, "#product-withdrawal-eligible")!, "no", window.HTMLSelectElement);
  await flush();
  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Enregistrer") ?? null);
  await flush(150);

  const calls = (globalThis as any).__productCalls as Array<{ fn: string; args: any[] }>;
  const update = calls.find((c) => c.fn === "updateProduct");
  assert.ok(update, "updateProduct doit être appelée");
  assert.equal(update!.args[0], "p-victor");
  assert.equal(update!.args[5].withdrawalEligible, false);
});

test("[B] édition SANS toucher au contrôle : la valeur COURANTE est retransmise telle quelle (update_product réécrit toujours la colonne)", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);
  await openProductEditor(container, "Coffret de Victor");

  // Aucune modification du contrôle « Rétractable » : on change juste
  // le prix, comme le ferait un marchand pressé.
  setValue(q(container, "#product-price")!, "25", window.HTMLInputElement);
  await flush();
  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Enregistrer") ?? null);
  await flush(150);

  const calls = (globalThis as any).__productCalls as Array<{ fn: string; args: any[] }>;
  const update = calls.find((c) => c.fn === "updateProduct");
  assert.ok(update, "updateProduct doit être appelée");
  assert.equal(update!.args[5].withdrawalEligible, true, "enregistrer sans y toucher ne doit JAMAIS effacer le « Oui »");
});

// ==================================================================
// C. Filtre de liste à trois états
// ==================================================================

test("[C] le filtre « Rétractable » existe, est libellé, et offre exactement Tous / Oui / Non", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);

  const select = q(container, '[data-testid="filter-withdrawal-eligible"]') as HTMLSelectElement | null;
  assert.ok(select, "filtre « Rétractable » absent de la barre d'outils");
  assert.equal(select!.value, "", "état par défaut = Tous");

  const label = qa(container, "label").find((l) => l.getAttribute("for") === "filter-withdrawal-eligible");
  assert.ok(label, "aucun <label for=\"filter-withdrawal-eligible\">");
  assert.equal((label!.textContent ?? "").trim(), "Rétractable");

  assert.deepEqual(
    qa(select!, "option").map((o) => (o.textContent ?? "").trim()),
    ["Tous", "Oui", "Non"]
  );
});

test("[C] le filtre masque réellement les produits de la liste, dans les deux sens, et « Tous » les rend tous", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);
  assert.deepEqual(renderedProductNames(container).sort(), ["Coffret de Victor", "Tomme de Hugo"]);

  setValue(q(container, '[data-testid="filter-withdrawal-eligible"]')!, "yes", window.HTMLSelectElement);
  await flush();
  assert.deepEqual(renderedProductNames(container), ["Coffret de Victor"]);

  setValue(q(container, '[data-testid="filter-withdrawal-eligible"]')!, "no", window.HTMLSelectElement);
  await flush();
  assert.deepEqual(renderedProductNames(container), ["Tomme de Hugo"]);

  setValue(q(container, '[data-testid="filter-withdrawal-eligible"]')!, "", window.HTMLSelectElement);
  await flush();
  assert.deepEqual(renderedProductNames(container).sort(), ["Coffret de Victor", "Tomme de Hugo"]);
});

test("[C] filtrer sur « Rétractable » active le bouton de réinitialisation, qui remet bien le filtre sur « Tous »", async () => {
  const container = await renderCatalogue(CATALOGUE_VICTOR_HUGO);
  assert.equal(q(container, '[data-testid="catalogue-reset-filters"]'), null, "aucun filtre actif au départ");

  setValue(q(container, '[data-testid="filter-withdrawal-eligible"]')!, "no", window.HTMLSelectElement);
  await flush();
  const reset = q(container, '[data-testid="catalogue-reset-filters"]');
  assert.ok(reset, "le bouton de réinitialisation doit apparaître");

  click(reset);
  await flush();
  assert.equal((q(container, '[data-testid="filter-withdrawal-eligible"]') as HTMLSelectElement).value, "");
  assert.deepEqual(renderedProductNames(container).sort(), ["Coffret de Victor", "Tomme de Hugo"]);
});

after(() => {
  window.close();
});
