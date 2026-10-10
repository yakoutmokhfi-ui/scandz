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
// PRODUCT SERVICE MODES v1 -- tests DOM DÉDIÉS pour le sélecteur
// multi-mode marchand (app/dashboard/catalogue/page.tsx, ProductForm).
//
// Demandé explicitement par le GO CIO/Ravel (issue #11, "dedicated
// DOM/service tests"). Même patron de montage DOM réel (esbuild +
// jsdom) que tests/online-withdrawal-catalogue-v1-dom.test.ts (mêmes
// mocks de service, même infrastructure) -- aucun nouveau patron
// inventé. `getPublicSaleModes` (@/lib/sale-modes-public) est mocké
// ICI avec un contenu RÉEL (contrairement aux 11 fichiers DOM
// préexistants patchés ce même lot pour retourner [] -- non concernés
// par ce sélecteur) pour exercer effectivement le sélecteur.
//
// `@/lib/services/catalogue-error` n'est PAS mocké : les classes
// d'erreur utilisées ci-dessous (ServiceModesEmptyRestrictionError,
// InvalidSaleModeForEstablishmentError) sont importées du fichier réel,
// exactement comme le fait app/dashboard/catalogue/page.tsx -- même
// référence de classe des deux côtés, `instanceof` fonctionne donc
// réellement, jamais une classe homonyme distincte.
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

const RESTO = "resto-psmv1";

(globalThis as any).__catalogueByRestaurant = {} as Record<string, unknown>;
(globalThis as any).__productCalls = [] as Array<{ fn: string; args: unknown[] }>;
(globalThis as any).__establishmentSaleModes = [] as unknown[];
(globalThis as any).__nextCreateError = null as string | null;

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/catalogue"; }
export function useSearchParams() { return new URLSearchParams("r=${RESTO}"); }
`;
const MOCK_AUTH = `
export async function getUser() { return { id: "u1" }; }
export async function getSession() { return { access_token: "t", user: { id: "u1" } }; }
export async function signOut() {}
`;
const MOCK_DASHBOARD = `
import { ServiceModesEmptyRestrictionError, InvalidSaleModeForEstablishmentError } from "@/lib/services/catalogue-error";
export { ServiceModesEmptyRestrictionError, InvalidSaleModeForEstablishmentError };
export async function getMerchantCatalogue(id, archived) {
  return (globalThis).__catalogueByRestaurant[id] ?? [];
}
export async function getMerchantRestaurants() {
  return [{ restaurant_id: "${RESTO}", name: "Chez Test", role: "owner" }];
}
export async function getRestaurantSettings() {
  return { currency: "EUR", staff_receipt_language: "fr" };
}
export async function createProduct(...args) {
  (globalThis).__productCalls.push({ fn: "createProduct", args });
  const err = (globalThis).__nextCreateError;
  if (err) {
    (globalThis).__nextCreateError = null;
    if (err === "empty") throw new ServiceModesEmptyRestrictionError();
    if (err === "invalid") throw new InvalidSaleModeForEstablishmentError();
  }
  return "prod-new";
}
export async function updateProduct(...args) {
  (globalThis).__productCalls.push({ fn: "updateProduct", args });
  const err = (globalThis).__nextCreateError;
  if (err) {
    (globalThis).__nextCreateError = null;
    if (err === "empty") throw new ServiceModesEmptyRestrictionError();
    if (err === "invalid") throw new InvalidSaleModeForEstablishmentError();
  }
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
const MOCK_SALE_MODES_PUBLIC = `
export async function getPublicSaleModes(restaurantId) {
  return (globalThis).__establishmentSaleModes;
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/catalogue-tags": MOCK_TAGS,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/sale-modes-public": MOCK_SALE_MODES_PUBLIC,
  // CATALOGUE PRODUCT REORDER v1 -- moveProductOrder() n'est pas l'objet de
  // ce test ; service remplacé, patron déjà suivi par les autres mocks ci-dessus.
  "@/lib/services/catalogue-product-order": `export async function moveProductOrder() { return 1; } export class ProductOrderStaleError extends Error {} export class ProductOrderBoundaryError extends Error {}`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-psmv1-ce-"));
const tmpFile = path.join(tmpDir, "CataloguePage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { CataloguePage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

function prod(over: Record<string, unknown> = {}) {
  return {
    product_id: "p-1",
    category_id: "c1",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Coffret",
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
    allowed_sale_modes: null,
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

const SALE_MODES = [
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
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
function click(el: Element | null) {
  assert.ok(el, "élément à cliquer introuvable");
  el!.dispatchEvent(new window.Event("click", { bubbles: true }));
}
/** Pour les cases à cocher : `.click()` (méthode DOM native), jamais un
 *  Event synthétique dispatché à la main -- même patron que
 *  tests/checkout-invoice-request-reliability.dom.test.ts (toggleCheckbox).
 *  jsdom gère alors lui-même, une seule fois, le comportement
 *  d'activation natif (bascule de `.checked` + évènement "change") ;
 *  un Event "click" dispatché manuellement double le déclenchement du
 *  gestionnaire React onChange sur une case à cocher contrôlée. */
function toggleCheckbox(el: HTMLElement | null) {
  assert.ok(el, "case à cocher introuvable");
  (el as HTMLInputElement).click();
}
function setValue(el: HTMLElement, value: string, proto: any) {
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function renderCatalogue(
  categories: unknown[],
  saleModes: unknown[] = SALE_MODES
): Promise<HTMLElement> {
  (globalThis as any).__catalogueByRestaurant = { [RESTO]: categories };
  (globalThis as any).__productCalls = [];
  (globalThis as any).__establishmentSaleModes = saleModes;
  (globalThis as any).__nextCreateError = null;
  const { container } = render();
  await waitFor(() => !!q(container, '[data-testid="catalogue-toolbar"]'));
  await flush();
  return container;
}

async function openProductEditor(container: HTMLElement, productName: string): Promise<void> {
  const card = qa(container, "li").find((li) => (li.textContent ?? "").includes(productName));
  assert.ok(card, `carte produit « ${productName} » introuvable`);
  const btn = qa(card!, "button").find((b) => (b.textContent ?? "").trim() === "Modifier");
  assert.ok(btn, `bouton « Modifier » absent de la carte « ${productName} »`);
  click(btn!);
  await flush();
}

async function openNewProductForm(container: HTMLElement): Promise<void> {
  const addBtn = qa(container, "button").find((b) => (b.textContent ?? "").includes("Produit"));
  click(addBtn ?? null);
  await flush();
}

// ==================================================================
// A. Sélecteur absent quand l'établissement n'a aucun mode de vente
// ==================================================================

test("[Sélecteur] établissement SANS mode de vente configuré -- aucun sélecteur affiché (rien à choisir), le reste du formulaire fonctionne normalement", async () => {
  const container = await renderCatalogue([cat({ products: [prod()] })], []);
  await openNewProductForm(container);
  assert.equal(
    q(container, "#product-sale-modes"),
    null,
    "aucun sélecteur de modes ne doit apparaître si l'établissement n'a aucun mode configuré"
  );
});

// ==================================================================
// B. Création -- "Tous" par défaut, ALL-par-absence
// ==================================================================

test("[Sélecteur] création : « Tous les modes » coché par défaut, cases individuelles désactivées et cochées tant que « Tous » l'est", async () => {
  const container = await renderCatalogue([cat({ products: [prod()] })]);
  await openNewProductForm(container);

  const allCheckbox = q(container, '[data-testid="product-sale-modes-all"]') as HTMLInputElement;
  assert.ok(allCheckbox, "la case « Tous les modes » doit exister");
  assert.equal(allCheckbox.checked, true, "« Tous » doit être cochée par défaut pour un nouveau produit");

  const pickupCheckbox = q(container, '[data-testid="product-sale-modes-pickup"]') as HTMLInputElement;
  const deliveryCheckbox = q(container, '[data-testid="product-sale-modes-delivery"]') as HTMLInputElement;
  assert.equal(pickupCheckbox.checked, true);
  assert.equal(deliveryCheckbox.checked, true);
  assert.equal(pickupCheckbox.disabled, true, "les cases individuelles sont désactivées tant que « Tous » est coché");
  assert.equal(deliveryCheckbox.disabled, true);
});

test("[Sélecteur] création avec « Tous » resté coché -- createProduct reçoit allowedSaleModes: null (efface toute restriction)", async () => {
  const container = await renderCatalogue([cat({ products: [] })]);
  await openNewProductForm(container);
  setValue(q(container, "#product-name")!, "Nouveau produit", window.HTMLInputElement);
  setValue(q(container, "#product-price")!, "10", window.HTMLInputElement);
  await flush();
  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Créer") ?? null);
  await flush(150);

  const calls = (globalThis as any).__productCalls as Array<{ fn: string; args: any[] }>;
  const create = calls.find((c) => c.fn === "createProduct");
  assert.ok(create, "createProduct doit être appelée");
  assert.equal(create!.args[5].allowedSaleModes, null);
});

// ==================================================================
// C. Décocher "Tous" -- démarre avec TOUS les modes pré-cochés
// ==================================================================

test("[Sélecteur] décocher « Tous » démarre avec TOUS les modes actuels pré-cochés (jamais un tableau vide transitoire)", async () => {
  const container = await renderCatalogue([cat({ products: [] })]);
  await openNewProductForm(container);

  toggleCheckbox(q(container, '[data-testid="product-sale-modes-all"]'));
  await flush();

  const pickupCheckbox = q(container, '[data-testid="product-sale-modes-pickup"]') as HTMLInputElement;
  const deliveryCheckbox = q(container, '[data-testid="product-sale-modes-delivery"]') as HTMLInputElement;
  assert.equal(pickupCheckbox.disabled, false, "les cases individuelles redeviennent modifiables");
  assert.equal(deliveryCheckbox.disabled, false);
  assert.equal(pickupCheckbox.checked, true, "pré-coché : jamais un état vide transitoire");
  assert.equal(deliveryCheckbox.checked, true);
});

test("[Sélecteur] décocher « Tous » puis un seul mode -- createProduct reçoit exactement le sous-ensemble restant", async () => {
  const container = await renderCatalogue([cat({ products: [] })]);
  await openNewProductForm(container);
  setValue(q(container, "#product-name")!, "Retrait seul", window.HTMLInputElement);
  setValue(q(container, "#product-price")!, "10", window.HTMLInputElement);

  toggleCheckbox(q(container, '[data-testid="product-sale-modes-all"]'));
  await flush();
  toggleCheckbox(q(container, '[data-testid="product-sale-modes-delivery"]'));
  await flush();

  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Créer") ?? null);
  await flush(150);

  const calls = (globalThis as any).__productCalls as Array<{ fn: string; args: any[] }>;
  const create = calls.find((c) => c.fn === "createProduct");
  assert.ok(create, "createProduct doit être appelée");
  assert.deepEqual(create!.args[5].allowedSaleModes, ["pickup"]);
});

// ==================================================================
// D. Décocher le DERNIER mode restant est un no-op (jamais vide)
// ==================================================================

test("[Sélecteur] décocher le DERNIER mode encore coché est un no-op -- la sélection ne devient JAMAIS vide côté UI", async () => {
  const container = await renderCatalogue([cat({ products: [] })]);
  await openNewProductForm(container);

  toggleCheckbox(q(container, '[data-testid="product-sale-modes-all"]'));
  await flush();
  toggleCheckbox(q(container, '[data-testid="product-sale-modes-delivery"]'));
  await flush();

  const pickupCheckbox = q(container, '[data-testid="product-sale-modes-pickup"]') as HTMLInputElement;
  assert.equal(pickupCheckbox.checked, true, "pickup est le seul mode encore coché");

  // Tenter de décocher le dernier mode restant : doit rester coché.
  toggleCheckbox(pickupCheckbox);
  await flush();
  assert.equal(
    pickupCheckbox.checked,
    true,
    "décocher le dernier mode restant ne doit avoir aucun effet (jamais une restriction à zéro mode)"
  );
});

// ==================================================================
// E. Édition -- la sélection reflète la valeur existante du produit
// ==================================================================

test("[Sélecteur] édition : un produit déjà restreint affiche « Tous » décoché et exactement ses modes cochés", async () => {
  const container = await renderCatalogue([
    cat({ products: [prod({ product_id: "p-restricted", name: "Article restreint", allowed_sale_modes: ["pickup"] })] }),
  ]);
  await openProductEditor(container, "Article restreint");

  const allCheckbox = q(container, '[data-testid="product-sale-modes-all"]') as HTMLInputElement;
  const pickupCheckbox = q(container, '[data-testid="product-sale-modes-pickup"]') as HTMLInputElement;
  const deliveryCheckbox = q(container, '[data-testid="product-sale-modes-delivery"]') as HTMLInputElement;

  assert.equal(allCheckbox.checked, false, "« Tous » ne doit pas apparaître coché pour un produit restreint");
  assert.equal(pickupCheckbox.checked, true);
  assert.equal(deliveryCheckbox.checked, false);
});

test("[Sélecteur] édition : ré-cocher « Tous » sur un produit restreint envoie allowedSaleModes: null à updateProduct", async () => {
  const container = await renderCatalogue([
    cat({ products: [prod({ product_id: "p-restricted", name: "Article restreint", allowed_sale_modes: ["pickup"] })] }),
  ]);
  await openProductEditor(container, "Article restreint");

  toggleCheckbox(q(container, '[data-testid="product-sale-modes-all"]'));
  await flush();
  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Enregistrer") ?? null);
  await flush(150);

  const calls = (globalThis as any).__productCalls as Array<{ fn: string; args: any[] }>;
  const update = calls.find((c) => c.fn === "updateProduct");
  assert.ok(update, "updateProduct doit être appelée");
  assert.equal(update!.args[0], "p-restricted");
  assert.equal(update!.args[5].allowedSaleModes, null);
});

test("[Sélecteur] édition SANS toucher au sélecteur : la restriction existante est retransmise telle quelle", async () => {
  const container = await renderCatalogue([
    cat({ products: [prod({ product_id: "p-restricted", name: "Article restreint", allowed_sale_modes: ["pickup"] })] }),
  ]);
  await openProductEditor(container, "Article restreint");

  setValue(q(container, "#product-price")!, "25", window.HTMLInputElement);
  await flush();
  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Enregistrer") ?? null);
  await flush(150);

  const calls = (globalThis as any).__productCalls as Array<{ fn: string; args: any[] }>;
  const update = calls.find((c) => c.fn === "updateProduct");
  assert.ok(update, "updateProduct doit être appelée");
  assert.deepEqual(
    update!.args[5].allowedSaleModes,
    ["pickup"],
    "enregistrer sans toucher au sélecteur ne doit JAMAIS effacer ni modifier la restriction existante"
  );
});

// ==================================================================
// F. Messages d'erreur applicatifs (garde-fous défensifs)
// ==================================================================

test("[Sélecteur] ServiceModesEmptyRestrictionError -- message applicatif clair, jamais le texte brut de la contrainte serveur", async () => {
  const container = await renderCatalogue([cat({ products: [] })]);
  await openNewProductForm(container);
  setValue(q(container, "#product-name")!, "X", window.HTMLInputElement);
  setValue(q(container, "#product-price")!, "10", window.HTMLInputElement);
  (globalThis as any).__nextCreateError = "empty";
  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Créer") ?? null);
  await flush(150);

  assert.ok(
    container.textContent?.includes("Sélectionnez au moins un mode, ou choisissez « Tous les modes ».") === true,
    "le message applicatif exact (mcServiceModesEmptyRestriction) doit être affiché pour SCANYM_SERVICE_MODES_EMPTY_RESTRICTION"
  );
});

test("[Sélecteur] InvalidSaleModeForEstablishmentError -- message applicatif clair, jamais le texte brut de la contrainte serveur", async () => {
  const container = await renderCatalogue([cat({ products: [] })]);
  await openNewProductForm(container);
  setValue(q(container, "#product-name")!, "X", window.HTMLInputElement);
  setValue(q(container, "#product-price")!, "10", window.HTMLInputElement);
  (globalThis as any).__nextCreateError = "invalid";
  click(qa(container, "button").find((b) => (b.textContent ?? "").trim() === "Créer") ?? null);
  await flush(150);

  assert.ok(
    container.textContent?.includes(
      "Un des modes sélectionnés n'est plus activé pour cet établissement. Rechargez la page et vérifiez votre sélection."
    ) === true,
    "le message applicatif exact (mcInvalidSaleModeForEstablishment) doit être affiché, jamais le code d'erreur brut"
  );
});

after(() => {
  window.close();
});
