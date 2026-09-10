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
// BULK PRODUCT PHOTOS v1.7 — CLEANUP-RETRY-DOM-EVIDENCE.
//
// MEDIUM (Cat Stevens, v1.6 -> v1.7) : "no substantive Node/DOM
// behavior test for cleanup retry -- v1.6 had none beyond mocked
// exports/structural string checks". Ce fichier rend RÉELLEMENT, en
// DOM (jsdom), les composants RÉELS (app/dashboard/catalogue/page.tsx
// -- flux photo UNIQUE via ProductPhotoField, ET
// components/dashboard/BulkPhotoUpload.tsx -- flux BULK, monté à
// l'intérieur de la MÊME page réelle, jamais réimplémenté), avec un
// module virtuel @/lib/services/product-photo entièrement
// CONTRÔLABLE par test (mêmes patrons esbuild/jsdom que
// tests/v150-bulk-product-photos.dom.test.ts/tests/v151-bulk-photos-
// v1-1-retry-remediation.dom.test.ts).
//
// Assertions applicatives RÉELLES requises par le mandat v1.7 (ni
// mockées-only, ni de simples vérifications structurelles de chaîne) :
//   - l'avertissement de nettoyage devient VISIBLE (texte réel rendu) ;
//   - le bouton/l'action de retry n'apparaît QUE pour un remplacement
//     RÉUSSI dont le nettoyage a ÉCHOUÉ (jamais pour "removed"/
//     "skipped_unsafe_legacy") ;
//   - cliquer sur le retry appelle EXCLUSIVEMENT le point d'entrée de
//     nettoyage (retryOldPhotoCleanup), avec le cleanup_id OPAQUE,
//     JAMAIS un oldPath (assertion positive : le cleanup_id transmis
//     ne contient JAMAIS de "/", contrairement à tout chemin Storage) ;
//   - AUCUN upload ne se produit pendant un retry (compteur d'appels
//     addOrReplaceProductPhoto strictement inchangé) ;
//   - AUCUNE RPC de remplacement n'est rejouée (même compteur, même
//     garantie) ;
//   - un nettoyage retrié RÉUSSI efface l'avertissement/l'état de
//     retry ; un retry ÉCHOUÉ reste visible et retriable ;
//   - un échec d'upload NORMAL (jamais un échec de nettoyage) continue
//     d'utiliser le retry de remplacement NORMAL (handleRetryFailed --
//     addOrReplaceProductPhoto rejoué), jamais retryOldPhotoCleanup.
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
(globalThis as any).URL.createObjectURL = () => "blob:mock-preview-url";
(globalThis as any).URL.revokeObjectURL = () => {};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

function makeProduct(overrides: Record<string, unknown>) {
  return {
    product_id: "p-x",
    category_id: "c1",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Produit",
    name_hash: "hash",
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 500,
    is_available: true,
    archived_at: null,
    display_order: 0,
    is_option_source: false,
    image_url: null,
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: false,
    reference_price_per_kg: null,
    ...overrides,
  };
}

const CATALOGUE_BY_RESTAURANT: Record<string, any[]> = {
  "r-test": [
    {
      category_id: "c1",
      category_name: "Fromages",
      category_translations: null,
      category_display_order: 0,
      category_is_option_source: false,
      category_description: null,
      products: [
        makeProduct({ product_id: "p-camembert", name: "Camembert", image_url: null }),
        makeProduct({ product_id: "p-brie", name: "Brie", image_url: "https://x.supabase.co/existing-brie.jpg" }),
      ],
      subcategories: [],
    },
  ],
};

(globalThis as any).__mockUser = { id: "merchant-1" };
(globalThis as any).__mockIsOperator = false;
(globalThis as any).__mockMappings = [
  { restaurant_id: "r-test", role: "owner", restaurants: { id: "r-test", name: "Fromagerie Test", slug: "fromagerie-test" } },
];
(globalThis as any).__mockRpcCallLog = [] as { fn: string; restaurantId: string }[];
(globalThis as any).__mockApplyCalls = [] as { restaurantId: string; productId: string; fileName: string; bulk: unknown }[];
(globalThis as any).__mockApplyFailFor = new Set<string>();
// NOUVEAU v1.7 -- outcome de nettoyage (+ cleanup_id OPAQUE, JAMAIS un
// chemin) CONTRÔLABLE par test, par productId. Défaut : succès complet,
// aucune autorité de retry.
(globalThis as any).__mockCleanupFor = new Map<string, { outcome: string; cleanupId: string | null }>();
// NOUVEAU v1.7 -- journal des appels RÉELS à retryOldPhotoCleanup --
// SEULE façon de prouver, positivement, qu'aucun oldPath (chemin) n'est
// jamais transmis : chaque entrée est inspectée pour l'ABSENCE de "/".
(globalThis as any).__mockRetryCalls = [] as { productId: string; cleanupId: string }[];
(globalThis as any).__mockRetryOutcome = "removed";

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/catalogue"; }
`;

const MOCK_AUTH = `
export async function getUser() { return (globalThis).__mockUser; }
export async function signOut() {}
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__mockIsOperator; }
export async function getEstablishmentSummary(id) { return { restaurantId: id, name: "x", slug: "x", status: "active", ownerEmail: null, ownerStatus: null }; }
`;

const MOCK_DASHBOARD = `
class CategoryDuplicateNameError extends Error {}
class CategoryDescriptionTooLongError extends Error {}
class DescriptionTooLongError extends Error {}
class ShortDescriptionTooLongError extends Error {}
class SubcategoryDuplicateNameError extends Error {}
class SubcategoryCategoryMismatchError extends Error {}
export { CategoryDuplicateNameError, CategoryDescriptionTooLongError, DescriptionTooLongError, ShortDescriptionTooLongError, SubcategoryDuplicateNameError, SubcategoryCategoryMismatchError };

export async function getMerchantRestaurants() { return (globalThis).__mockMappings; }
export async function getRestaurantSettings() { return { currency: "DZD", staff_receipt_language: "fr" }; }
export async function getMerchantCatalogue(id) {
  (globalThis).__mockRpcCallLog.push({ fn: "get_merchant_catalogue", restaurantId: id });
  const CATALOGUE = ${JSON.stringify(CATALOGUE_BY_RESTAURANT)};
  return CATALOGUE[id] ?? [];
}
export async function createProduct() { return "new-product-id"; }
export async function updateProduct() {}
export async function createCategory() { return "new-category-id"; }
export async function updateCategory() {}
export async function createSubcategory() { return "new-subcategory-id"; }
export async function updateSubcategory() {}
export async function setProductAvailability() {}
export async function setProductOrder() {}
export async function archiveProduct() {}
export async function restoreProduct() {}
`;

// NOUVEAU v1.7 -- module virtuel product-photo ENTIÈREMENT contrôlable :
// addOrReplaceProductPhoto renvoie EXACTEMENT { imageUrl, oldImageCleanup,
// cleanupId } -- la forme RÉELLE post-v1.7 (jamais oldPath) --,
// retryOldPhotoCleanup journalise chaque appel RÉEL (productId,
// cleanupId) pour une assertion positive "jamais un oldPath transmis".
const MOCK_PRODUCT_PHOTO = `
export class InvalidFileTypeError extends Error {}
export class FileTooLargeError extends Error {}
export class PhotoUploadError extends Error {}
export class PhotoRemoveError extends Error {}
export class PhotoConflictError extends Error {}

export async function validateProductPhotoFile() {
  return { mime: "image/jpeg", ext: "jpg" };
}

export async function addOrReplaceProductPhoto(restaurantId, productId, file, bulk) {
  (globalThis).__mockApplyCalls.push({ restaurantId, productId, fileName: file.name, bulk: bulk ?? null });
  if ((globalThis).__mockApplyFailFor.has(productId)) throw new PhotoUploadError(new Error("boom"));
  const cfg = (globalThis).__mockCleanupFor.get(productId) ?? { outcome: "removed", cleanupId: null };
  return { imageUrl: "https://x.supabase.co/new-" + productId + ".jpg", oldImageCleanup: cfg.outcome, cleanupId: cfg.cleanupId };
}

export async function removeProductPhoto(productId) {
  const cfg = (globalThis).__mockCleanupFor.get(productId) ?? { outcome: "not_applicable", cleanupId: null };
  return { oldImageCleanup: cfg.outcome, cleanupId: cfg.cleanupId };
}

// NOUVEAU v1.7 -- REMPLACE oldPath par cleanupId ; journalise l'appel
// RÉEL tel qu'émis par le composant réel (page.tsx/BulkPhotoUpload.tsx),
// jamais reconstruit ici.
export async function retryOldPhotoCleanup(productId, cleanupId) {
  (globalThis).__mockRetryCalls.push({ productId, cleanupId });
  return { oldImageCleanup: (globalThis).__mockRetryOutcome };
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/product-photo": MOCK_PRODUCT_PHOTO,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path in mocks) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
  },
};

async function buildPage(entryRelPath: string, exportName: string) {
  const entrySource = `export { default as ${exportName} } from "@/${entryRelPath}";`;
  const buildResult = await esbuild.build({
    stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    plugins: [mockPlugin],
    external: ["react", "react-dom", "react-dom/client"],
  });
  const code = buildResult.outputFiles[0].text;
  const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
  const tmpFile = path.join(tmpDir, `${exportName}.mjs`);
  writeFileSync(tmpFile, code);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpDir, { recursive: true, force: true });
  return mod[exportName];
}

const CataloguePage = await buildPage("app/dashboard/catalogue/page.tsx", "CataloguePage");

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition jamais satisfaite avant le délai");
    await flush(intervalMs);
  }
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CataloguePage));
  return { container, root };
}

function resetGlobalMockState() {
  (globalThis as any).__mockIsOperator = false;
  (globalThis as any).__mockMappings = [
    { restaurant_id: "r-test", role: "owner", restaurants: { id: "r-test", name: "Fromagerie Test", slug: "fromagerie-test" } },
  ];
  (globalThis as any).__mockRpcCallLog = [];
  (globalThis as any).__mockApplyCalls = [];
  (globalThis as any).__mockApplyFailFor = new Set<string>();
  (globalThis as any).__mockCleanupFor = new Map();
  (globalThis as any).__mockRetryCalls = [];
  (globalThis as any).__mockRetryOutcome = "removed";
}

function makeFile(name: string, size = 1000): File {
  return new window.File([new Uint8Array(size)], name, { type: "image/jpeg" });
}

function selectFiles(container: HTMLElement, files: File[]) {
  const region = container.querySelector('[role="region"]');
  assert.ok(region, "panneau BulkPhotoUpload introuvable (bouton pas encore cliqué ?)");
  const inputs = region!.querySelectorAll('input[type="file"]');
  const filesInput = inputs[0] as HTMLInputElement;
  Object.defineProperty(filesInput, "files", { value: files, configurable: true });
  filesInput.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function openBulkPhotoPanel(container: HTMLElement) {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Photos en lot")
  ) as HTMLButtonElement | undefined;
  assert.ok(btn, "bouton d'ouverture du panneau Bulk Photos introuvable");
  btn!.click();
}

// v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, décision CIO qui
// ANNULE ET REMPLACE tout modèle de drapeau, global (v2.1) ou par
// ligne (v2.0)). Brie a une photo existante dans la fixture de ce
// fichier -- les tests BULK de nettoyage/remplacement ci-dessous
// exercent délibérément le cas "remplacement d'une photo existante",
// qui est désormais inclus automatiquement dès la confirmation du lot
// -- il n'existe PLUS aucun geste préalable à reproduire ici.

async function setupCatalogue() {
  resetGlobalMockState();
  const { container, root } = render();
  // Attendre le rendu RÉEL des lignes produit (pas seulement le nom du
  // restaurant/de la catégorie, qui peut apparaître avant que
  // getMerchantCatalogue() ait résolu et que les <li> produit existent --
  // condition de course observée : le sélecteur de restaurant affiche
  // "Fromagerie Test" avant que les produits ne soient montés).
  await waitFor(() => container.textContent!.includes("Camembert") && container.textContent!.includes("Brie"));
  return { container, root };
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text)) as
    | HTMLButtonElement
    | undefined;
}

// ====================================================================
// FLUX PHOTO UNIQUE (page.tsx / ProductPhotoField) — v1.7
// ====================================================================

test("SINGLE-PHOTO -- remplacement réussi + nettoyage ÉCHOUÉ : avertissement VISIBLE, bouton de retry présent UNIQUEMENT dans ce cas", async () => {
  const { container, root } = await setupCatalogue();

  const productItems = Array.from(container.querySelectorAll("li"));
  const brieItem = productItems.find((li) => (li.textContent ?? "").includes("Brie"));
  assert.ok(brieItem, "ligne produit Brie introuvable");
  const editButtons = Array.from(brieItem!.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === "Modifier");
  assert.ok(editButtons.length > 0);
  (editButtons[0] as HTMLButtonElement).click();
  await flush(30);

  // Avant tout remplacement : aucun avertissement, jamais affiché sans raison.
  assert.ok(!container.textContent!.includes("l'ancienne image n'a pas pu être supprimée"), "aucun avertissement avant tout remplacement");

  (globalThis as any).__mockCleanupFor.set("p-brie", { outcome: "failed", cleanupId: "cleanup-brie-1" });
  const fileInput = container.querySelector("#product-photo-p-brie") as HTMLInputElement;
  assert.ok(fileInput, "input file de ProductPhotoField introuvable pour p-brie");
  Object.defineProperty(fileInput, "files", { value: [makeFile("nouvelle-brie.jpg")], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  assert.equal((globalThis as any).__mockApplyCalls[0].productId, "p-brie");

  // L'avertissement doit devenir VISIBLE -- texte RÉEL rendu, jamais un console.warn.
  await waitFor(() => container.textContent!.includes("l'ancienne image n'a pas pu être supprimée"));

  const retryBtn = findButtonByText(container, "Réessayer le nettoyage");
  assert.ok(retryBtn, "le bouton de retry cleanup-only doit apparaître UNIQUEMENT quand le nettoyage a ÉCHOUÉ");

  root.unmount();
  container.remove();
});

test("SINGLE-PHOTO -- cliquer sur le retry appelle EXCLUSIVEMENT retryOldPhotoCleanup, avec le cleanup_id OPAQUE (JAMAIS un oldPath), AUCUN nouvel upload, AUCUNE RPC de remplacement rejouée", async () => {
  const { container, root } = await setupCatalogue();
  const productItems = Array.from(container.querySelectorAll("li"));
  const brieItem = productItems.find((li) => (li.textContent ?? "").includes("Brie"));
  const editButtons = Array.from(brieItem!.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === "Modifier");
  (editButtons[0] as HTMLButtonElement).click();
  await flush(30);

  (globalThis as any).__mockCleanupFor.set("p-brie", { outcome: "failed", cleanupId: "cleanup-brie-2" });
  const fileInput = container.querySelector("#product-photo-p-brie") as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [makeFile("nouvelle-brie.jpg")], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  await waitFor(() => container.textContent!.includes("Réessayer le nettoyage"));

  const applyCallsBeforeRetry = (globalThis as any).__mockApplyCalls.length;

  const retryBtn = findButtonByText(container, "Réessayer le nettoyage")!;
  retryBtn.click();

  await waitFor(() => (globalThis as any).__mockRetryCalls.length === 1);
  const retryCall = (globalThis as any).__mockRetryCalls[0];
  assert.equal(retryCall.productId, "p-brie");
  assert.equal(retryCall.cleanupId, "cleanup-brie-2", "le cleanup_id transmis doit être EXACTEMENT celui reçu de addOrReplaceProductPhoto -- jamais reconstruit, jamais un chemin");
  assert.ok(!retryCall.cleanupId.includes("/"), "le paramètre transmis ne doit JAMAIS ressembler à un chemin Storage (un cleanup_id opaque ne contient jamais '/') -- preuve positive CLIENT CLEANUP PATH PARAMETER: NONE");

  await flush(30);
  assert.equal((globalThis as any).__mockApplyCalls.length, applyCallsBeforeRetry, "un retry de nettoyage ne doit JAMAIS déclencher un nouvel appel addOrReplaceProductPhoto -- CLEANUP RETRY REPLAYS UPLOAD: NO, CLEANUP RETRY REPLAYS REPLACEMENT: NO");

  root.unmount();
  container.remove();
});

test("SINGLE-PHOTO -- retry RÉUSSI efface l'avertissement/le bouton ; retry ÉCHOUÉ reste VISIBLE et RETRIABLE", async () => {
  const { container, root } = await setupCatalogue();
  const productItems = Array.from(container.querySelectorAll("li"));
  const brieItem = productItems.find((li) => (li.textContent ?? "").includes("Brie"));
  const editButtons = Array.from(brieItem!.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === "Modifier");
  (editButtons[0] as HTMLButtonElement).click();
  await flush(30);

  (globalThis as any).__mockCleanupFor.set("p-brie", { outcome: "failed", cleanupId: "cleanup-brie-3" });
  const fileInput = container.querySelector("#product-photo-p-brie") as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [makeFile("nouvelle-brie.jpg")], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  await waitFor(() => container.textContent!.includes("Réessayer le nettoyage"));

  // Premier essai : échoue DE NOUVEAU -- l'avertissement/le bouton doivent rester.
  (globalThis as any).__mockRetryOutcome = "failed";
  findButtonByText(container, "Réessayer le nettoyage")!.click();
  await waitFor(() => (globalThis as any).__mockRetryCalls.length === 1);
  await flush(30);
  assert.ok(container.textContent!.includes("l'ancienne image n'a pas pu être supprimée"), "un retry ÉCHOUÉ ne doit JAMAIS effacer l'avertissement -- reste visible");
  assert.ok(findButtonByText(container, "Réessayer le nettoyage"), "un retry ÉCHOUÉ doit rester RETRIABLE -- le bouton reste présent");

  // Second essai : réussit -- l'avertissement ET le bouton doivent disparaître.
  (globalThis as any).__mockRetryOutcome = "removed";
  findButtonByText(container, "Réessayer le nettoyage")!.click();
  await waitFor(() => (globalThis as any).__mockRetryCalls.length === 2);
  await waitFor(() => !container.textContent!.includes("l'ancienne image n'a pas pu être supprimée"));
  assert.equal(findButtonByText(container, "Réessayer le nettoyage"), undefined, "un retry RÉUSSI doit effacer le bouton de retry");

  root.unmount();
  container.remove();
});

test("SINGLE-PHOTO -- remplacement réussi SANS échec de nettoyage ('removed') : AUCUN avertissement, AUCUN bouton de retry", async () => {
  const { container, root } = await setupCatalogue();
  const productItems = Array.from(container.querySelectorAll("li"));
  const camembertItem = productItems.find((li) => (li.textContent ?? "").includes("Camembert"));
  const editButtons = Array.from(camembertItem!.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === "Modifier");
  (editButtons[0] as HTMLButtonElement).click();
  await flush(30);

  const fileInput = container.querySelector("#product-photo-p-camembert") as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [makeFile("nouveau-camembert.jpg")], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  await flush(50);

  assert.ok(!container.textContent!.includes("l'ancienne image n'a pas pu être supprimée"));
  assert.equal(findButtonByText(container, "Réessayer le nettoyage"), undefined);

  root.unmount();
  container.remove();
});

test("SINGLE-PHOTO -- un échec d'UPLOAD normal (jamais un échec de nettoyage) n'affiche JAMAIS le bouton de retry cleanup-only, et n'appelle JAMAIS retryOldPhotoCleanup", async () => {
  const { container, root } = await setupCatalogue();
  (globalThis as any).__mockApplyFailFor = new Set(["p-camembert"]);
  const productItems = Array.from(container.querySelectorAll("li"));
  const camembertItem = productItems.find((li) => (li.textContent ?? "").includes("Camembert"));
  const editButtons = Array.from(camembertItem!.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim() === "Modifier");
  (editButtons[0] as HTMLButtonElement).click();
  await flush(30);

  const fileInput = container.querySelector("#product-photo-p-camembert") as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [makeFile("echoue.jpg")], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  await flush(50);

  assert.equal(findButtonByText(container, "Réessayer le nettoyage"), undefined, "un échec d'UPLOAD (remplacement jamais réussi) ne doit JAMAIS proposer le retry cleanup-only -- distinct par construction (noteCleanupOutcome n'est appelée qu'après un remplacement RÉUSSI)");
  assert.equal((globalThis as any).__mockRetryCalls.length, 0, "retryOldPhotoCleanup ne doit JAMAIS être appelée pour un échec d'upload normal");

  root.unmount();
  container.remove();
});

// ====================================================================
// FLUX BULK (BulkPhotoUpload.tsx, monté dans la page réelle) — v1.7
// ====================================================================

test("BULK -- remplacement réussi + nettoyage ÉCHOUÉ pour UN item : avertissement + bouton de retry sur CETTE ligne uniquement, cleanup_id OPAQUE transmis (JAMAIS un chemin), AUCUN nouvel upload pendant le retry", async () => {
  const { container, root } = await setupCatalogue();
  openBulkPhotoPanel(container);
  await waitFor(() => !!container.querySelector('[role="region"]'));

  (globalThis as any).__mockCleanupFor.set("p-brie", { outcome: "failed", cleanupId: "cleanup-bulk-brie-1" });
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);
  // v2.2 -- Brie a une photo existante : ce test exerce précisément le
  // cas REMPLACEMENT (nettoyage de l'ancienne image), inclus
  // automatiquement dès la confirmation du lot -- aucun geste préalable.

  const confirmBtn = findButtonByText(container, "Confirmer et appliquer") as HTMLButtonElement;
  assert.ok(confirmBtn && !confirmBtn.disabled);
  confirmBtn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  await waitFor(() => container.textContent!.includes("nettoyage de l'ancienne image non garanti"));

  const resultItems = Array.from(container.querySelectorAll("li"));
  const brieResult = resultItems.find((li) => (li.textContent ?? "").includes("Brie") && (li.textContent ?? "").includes("nettoyage de l'ancienne image non garanti"));
  assert.ok(brieResult, "la ligne de résultat Brie doit porter l'avertissement de nettoyage");
  const camembertResult = resultItems.find((li) => (li.textContent ?? "").includes("Camembert") && (li.textContent ?? "").includes("→"));
  assert.ok(camembertResult && !(camembertResult.textContent ?? "").includes("nettoyage de l'ancienne image non garanti"), "Camembert (nettoyage réussi) ne doit porter AUCUN avertissement");

  const retryBtn = Array.from(brieResult!.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Réessayer le nettoyage")) as HTMLButtonElement;
  assert.ok(retryBtn, "le bouton de retry cleanup-only doit apparaître UNIQUEMENT sur la ligne Brie");
  assert.ok(
    !Array.from(camembertResult!.querySelectorAll("button")).some((b) => (b.textContent ?? "").includes("Réessayer le nettoyage")),
    "AUCUN bouton de retry cleanup-only ne doit apparaître sur la ligne Camembert (nettoyage déjà réussi)"
  );

  const applyCallsBeforeRetry = (globalThis as any).__mockApplyCalls.length;
  retryBtn.click();

  await waitFor(() => (globalThis as any).__mockRetryCalls.length === 1);
  const retryCall = (globalThis as any).__mockRetryCalls[0];
  assert.equal(retryCall.productId, "p-brie");
  assert.equal(retryCall.cleanupId, "cleanup-bulk-brie-1");
  assert.ok(!retryCall.cleanupId.includes("/"), "cleanup_id opaque -- jamais un chemin Storage");

  await flush(30);
  assert.equal((globalThis as any).__mockApplyCalls.length, applyCallsBeforeRetry, "AUCUN nouvel upload/remplacement ne doit être déclenché par un retry de nettoyage bulk");

  await waitFor(() => !container.textContent!.includes("nettoyage de l'ancienne image non garanti"));
  root.unmount();
  container.remove();
});

test("BULK -- un échec d'UPLOAD normal (Réessayer les échecs) continue d'utiliser le retry de REMPLACEMENT normal -- rejoue addOrReplaceProductPhoto, JAMAIS retryOldPhotoCleanup", async () => {
  const { container, root } = await setupCatalogue();
  openBulkPhotoPanel(container);
  await waitFor(() => !!container.querySelector('[role="region"]'));

  (globalThis as any).__mockApplyFailFor = new Set(["p-brie"]);
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);
  // v2.2 -- Brie a une photo existante : incluse automatiquement, voir
  // la note du test précédent.

  const confirmBtn = findButtonByText(container, "Confirmer et appliquer") as HTMLButtonElement;
  confirmBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  await waitFor(() => container.textContent!.includes("Échec de l'envoi de cette photo"));

  const retryFailedBtn = findButtonByText(container, "Réessayer les échecs") as HTMLButtonElement;
  assert.ok(retryFailedBtn);

  (globalThis as any).__mockApplyFailFor = new Set();
  retryFailedBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 3);

  assert.equal((globalThis as any).__mockRetryCalls.length, 0, "un échec d'upload NORMAL doit être rejoué via addOrReplaceProductPhoto (Réessayer les échecs) -- JAMAIS via retryOldPhotoCleanup, les deux mécanismes restent strictement distincts");

  root.unmount();
  container.remove();
});

after(() => {
  window.close();
  void esbuild.stop();
});
