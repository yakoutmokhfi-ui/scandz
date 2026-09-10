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
// BULK PRODUCT PHOTOS v1 — appariement/prévisualisation/application de
// photos en lot, intégré à app/dashboard/catalogue/page.tsx.
//
// Rendu RÉEL en DOM (jsdom) de la page catalogue (composant réel,
// jamais réimplémenté) + du composant réel BulkPhotoUpload.tsx, avec
// le module d'appariement bulk-product-photo-matching.ts RÉEL, sans
// mock (module pur, sans I/O -- inutile et contre-productif de le
// mocker). Seuls next/navigation, @/lib/services/auth,
// @/lib/services/establishments, @/lib/services/dashboard et
// @/lib/services/product-photo sont remplacés par des modules
// virtuels (même patron que tests/v149-operator-dashboard-context-v1.dom.test.ts).
//
// Reproduit le harnais esbuild/jsdom déjà établi -- même structure de
// build, mêmes conventions (waitFor/flush, Object.defineProperty pour
// simuler une sélection de fichiers, cf.
// tests/v67b-photo-error-message.dom.test.ts:307-308).
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

// --------------------------------------------------------------
// Fixture catalogue -- restaurant "r-test" (tenant courant) ET
// "r-other" (AUTRE tenant, jamais chargé par défaut -- sert
// uniquement à prouver qu'aucun produit d'un autre restaurant ne
// peut apparaître dans le panneau, voir Sécurité/tenant ci-dessous).
// --------------------------------------------------------------
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
        // NOUVEAU v2.0 -- second produit AVEC photo existante,
        // indépendant de Brie : requis pour prouver que l'override
        // "Remplacer quand même" est bien PAR LIGNE (SCÉNARIO 6),
        // jamais un état partagé/global entre deux produits.
        makeProduct({ product_id: "p-munster", name: "Munster", image_url: "https://x.supabase.co/existing-munster.jpg" }),
        // NOUVEAU v2.0 -- produit SANS photo existante, non ambigu,
        // utilisé par les tests v1 pré-existants qui avaient besoin
        // d'un DEUXIÈME fichier "simplement prêt" (matching/retry/
        // tenant), désormais distinct de Brie (qui, depuis v2.0, est
        // SKIPPÉ par défaut -- voir plus bas les tests dédiés v2.0).
        makeProduct({ product_id: "p-reblochon", name: "Reblochon", image_url: null }),
        // Nom dupliqué (deux produits, même clé normalisée) --
        // ambiguïté volontaire pour les tests MATCHING.
        makeProduct({ product_id: "p-tomme-a", name: "Tomme", image_url: null }),
        makeProduct({ product_id: "p-tomme-b", name: "Tomme", image_url: null }),
        // Produit archivé -- ne doit JAMAIS être proposé/apparié.
        makeProduct({ product_id: "p-old", name: "Vieux Fromage", archived_at: "2020-01-01T00:00:00Z" }),
      ],
      subcategories: [],
    },
  ],
  "r-other": [
    {
      category_id: "c-other",
      category_name: "Autre",
      category_translations: null,
      category_display_order: 0,
      category_is_option_source: false,
      category_description: null,
      products: [makeProduct({ product_id: "p-foreign-camembert", name: "Camembert", image_url: null })],
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

// Validation binaire réelle contrôlable par test : par défaut tout
// fichier est un JPEG valide ; un nom de fichier listé dans
// __mockInvalidTypeFiles/__mockOversizedFiles échoue la validation
// exactement comme le ferait product-photo.ts pour un fichier
// falsifié/trop volumineux -- sans dépendre de vrais octets d'image
// dans jsdom (même simplification que le harnais v149, qui mocke déjà
// entièrement ce module).
(globalThis as any).__mockInvalidTypeFiles = new Set<string>();
(globalThis as any).__mockOversizedFiles = new Set<string>();
// v1.3 (Cat Stevens, Blocker A) : addOrReplaceProductPhoto n'accepte
// plus de previousImageUrl -- le nettoyage de l'ancienne photo est
// désormais prouvé et effectué côté serveur, par la RPC elle-même
// (voir lib/services/product-photo.ts). Le mock ci-dessous reflète la
// signature réelle à 3 paramètres.
(globalThis as any).__mockApplyCalls = [] as { restaurantId: string; productId: string; fileName: string; bulk: unknown }[];
(globalThis as any).__mockApplyFailFor = new Set<string>(); // product_id -> échec
// NOUVEAU v2.2 -- product_id -> CONFLICT (le serveur refuse un retry
// incertain, voir PhotoConflictError).
(globalThis as any).__mockApplyConflictFor = new Set<string>();

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

const MOCK_PRODUCT_PHOTO = `
export class InvalidFileTypeError extends Error {}
export class FileTooLargeError extends Error {}
export class PhotoUploadError extends Error {}
export class PhotoRemoveError extends Error {}
export class PhotoConflictError extends Error {}

export async function validateProductPhotoFile(file) {
  if ((globalThis).__mockOversizedFiles.has(file.name)) throw new FileTooLargeError();
  if ((globalThis).__mockInvalidTypeFiles.has(file.name)) throw new InvalidFileTypeError();
  return { mime: "image/jpeg", ext: "jpg" };
}

// NOUVEAU v2.2 -- 4e paramètre \`bulk\` (BulkPhotoApplyContext), ANNULE
// ET REMPLACE le \`idempotencyKey\` v2.1. v2.2.1 : \`bulk\` est désormais
// TOUJOURS \`{batchId, isRetry}\` (plus jamais d'\`expectedPriorImageUrl\`
// -- RETIRÉ, voir lib/services/product-photo.ts). Enregistré TEL QUEL
// dans __mockApplyCalls pour que les tests dédiés v2.2/v2.2.1 puissent
// inspecter batchId/isRetry exactement comme transmis par
// BulkPhotoUpload.tsx, sans jamais réimplémenter sa logique ici.
export async function addOrReplaceProductPhoto(restaurantId, productId, file, bulk) {
  (globalThis).__mockApplyCalls.push({ restaurantId, productId, fileName: file.name, bulk: bulk ?? null });
  if ((globalThis).__mockApplyConflictFor.has(productId)) throw new PhotoConflictError(new Error("conflict"));
  if ((globalThis).__mockApplyFailFor.has(productId)) throw new PhotoUploadError(new Error("boom"));
  return { imageUrl: "https://x.supabase.co/new.jpg", oldImageCleanup: "not_applicable", cleanupId: null, alreadyApplied: false };
}

export async function removeProductPhoto() {}
// BULK PRODUCT PHOTOS v1.6 (MEDIUM cleanup retry) -- stub jamais exercé par ce scénario, requis uniquement pour satisfaire l'import statique de page.tsx.
export async function retryOldPhotoCleanup() { return { oldImageCleanup: "removed" }; }
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
  (globalThis as any).__mockInvalidTypeFiles = new Set<string>();
  (globalThis as any).__mockOversizedFiles = new Set<string>();
  (globalThis as any).__mockApplyCalls = [];
  (globalThis as any).__mockApplyFailFor = new Set<string>();
  (globalThis as any).__mockApplyConflictFor = new Set<string>();
}

function makeFile(name: string, size = 1000): File {
  return new window.File([new Uint8Array(size)], name, { type: "image/jpeg" });
}

function selectFiles(container: HTMLElement, files: File[]) {
  const region = container.querySelector('[role="region"]');
  assert.ok(region, "panneau BulkPhotoUpload introuvable (bouton pas encore cliqué ?)");
  const inputs = region!.querySelectorAll('input[type="file"]');
  assert.equal(inputs.length, 2, "attendu exactement 2 inputs file (fichiers multiples + dossier)");
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

async function setupAndOpenPanel() {
  resetGlobalMockState();
  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("Fromagerie Test") || container.textContent!.includes("Fromages"));
  openBulkPhotoPanel(container);
  await waitFor(() => !!container.querySelector('[role="region"]'));
  return { container, root };
}

// ====================================================================
// HAPPY PATH
// ====================================================================

test("HAPPY PATH -- plusieurs photos, appariement déterministe, plusieurs produits, confirmation réussie", async () => {
  const { container, root } = await setupAndOpenPanel();

  // v2.0 -- Reblochon (sans photo existante), pas Brie : ce test
  // couvre l'appariement/l'application de base, indépendamment du
  // gate existing-photo (couvert par ses propres tests dédiés v2.0
  // plus bas, qui utilisent explicitement Brie/Munster).
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("reblochon.jpg")]);
  await waitFor(() => !!(globalThis as any).__mockApplyCalls); // laisse React committer
  await flush(50);

  assert.ok(container.textContent!.includes("2 fichier(s) sélectionné(s)"));
  assert.ok(container.textContent!.includes("2 apparié(s)"));

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  assert.ok(confirmBtn && !confirmBtn.disabled);
  confirmBtn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.deepEqual(
    calls.map((c) => c.productId).sort(),
    ["p-camembert", "p-reblochon"]
  );
  assert.ok(calls.every((c) => c.restaurantId === "r-test"));
  // v1.3 (Cat Stevens, Blocker A) : addOrReplaceProductPhoto ne reçoit
  // plus aucune valeur "ancienne image" -- la RPC serveur lit seule
  // l'ancienne valeur en DB, jamais une valeur transmise par ce
  // composant (vérifié aussi pour le cas remplacement -- Brie avec
  // override -- dans les tests v2.0 dédiés plus bas).
  const camembertCall = calls.find((c) => c.productId === "p-camembert");
  assert.ok(camembertCall && !("previousImageUrl" in camembertCall));

  await waitFor(() => container.textContent!.includes("2 photo(s) sur 2 appliquée(s) avec succès"));

  root.unmount();
  container.remove();
});

// ====================================================================
// MATCHING
// ====================================================================

test("MATCHING -- unknown reference : fichier sans produit correspondant reste non apparié, non applicable", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("produit-totalement-inconnu.jpg")]);
  await flush(50);
  assert.ok(container.textContent!.includes("Non apparié"));
  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  assert.ok(confirmBtn.disabled, "aucun fichier prêt -> le bouton doit rester désactivé");
  root.unmount();
  container.remove();
});

test("MATCHING -- duplicate reference / ambiguous match : deux produits partagent le même nom -> aucune écriture automatique", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Tomme.jpg")]);
  await flush(50);
  assert.ok(container.textContent!.includes("Ambigu"));
  assert.ok(container.textContent!.includes("1 conflit(s)/erreur(s)") === false); // ambiguous != conflict/error bucket
  assert.ok(container.textContent!.includes("1 à confirmer"));

  // Le menu déroulant doit proposer UNIQUEMENT p-tomme-a / p-tomme-b,
  // jamais un autre produit du catalogue.
  const select = container.querySelector('select[aria-label="Produit ciblé"]') as HTMLSelectElement;
  const optionValues = Array.from(select.options).map((o) => o.value).filter(Boolean);
  assert.deepEqual(optionValues.sort(), ["p-tomme-a", "p-tomme-b"]);
  root.unmount();
  container.remove();
});

test("MATCHING -- same product twice : deux fichiers visant le même produit -> conflit explicite, aucune application avant arbitrage", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("camembert-bis.jpg")]);
  await flush(50);

  // Force manuellement le deuxième fichier (non apparié par nom) vers
  // le MÊME produit que le premier (déjà apparié) -- reproduit
  // l'opérateur qui choisit deux fichiers pour un seul produit.
  const selects = container.querySelectorAll('select[aria-label="Produit ciblé"]');
  const secondSelect = selects[1] as HTMLSelectElement;
  secondSelect.value = "p-camembert";
  secondSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush(30);

  assert.ok(container.textContent!.includes("Conflit"));
  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  assert.ok(confirmBtn.disabled, "un conflit non résolu doit bloquer la confirmation pour CE produit");
  root.unmount();
  container.remove();
});

// ====================================================================
// VALIDATION
// ====================================================================

test("VALIDATION -- invalid file type : jamais appliqué même avec un nom qui correspond exactement", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockInvalidTypeFiles = new Set(["Camembert.jpg"]);
  selectFiles(container, [makeFile("Camembert.jpg")]);
  await waitFor(() => container.textContent!.includes("Format non pris en charge"));
  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  assert.ok(confirmBtn.disabled);
  root.unmount();
  container.remove();
});

test("VALIDATION -- oversized file : rejeté avec message dédié, jamais appliqué", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockOversizedFiles = new Set(["Camembert.jpg"]);
  selectFiles(container, [makeFile("Camembert.jpg")]);
  await waitFor(() => container.textContent!.includes("trop volumineux"));
  root.unmount();
  container.remove();
});

test("VALIDATION -- empty selection : aucun fichier -> aucun tableau, aucune confirmation possible", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, []);
  await flush(30);
  assert.ok(container.textContent!.includes("Aucun fichier sélectionné"));
  assert.ok(!Array.from(container.querySelectorAll("button")).some((b) => (b.textContent ?? "").includes("Confirmer et appliquer")));
  root.unmount();
  container.remove();
});

// ====================================================================
// SECURITE / MULTI-TENANT
// ====================================================================

test("SECURITE -- cross-tenant : le catalogue chargé pour r-test ne contient jamais de produit de r-other", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Camembert.jpg")]);
  await flush(50);
  // "Camembert" existe A LA FOIS dans r-test (p-camembert) et r-other
  // (p-foreign-camembert) -- seul p-camembert doit jamais apparaître.
  const calls = (globalThis as any).__mockRpcCallLog as any[];
  assert.ok(calls.some((c) => c.fn === "get_merchant_catalogue" && c.restaurantId === "r-test"));
  assert.ok(!calls.some((c) => c.restaurantId === "r-other"), "aucun appel catalogue ne doit jamais cibler un autre restaurant que celui de la session");

  const select = container.querySelector('select[aria-label="Produit ciblé"]') as HTMLSelectElement;
  const optionValues = Array.from(select.options).map((o) => o.value).filter(Boolean);
  assert.ok(!optionValues.includes("p-foreign-camembert"), "un produit d'un AUTRE restaurant ne doit jamais être proposé");
  root.unmount();
  container.remove();
});

test("SECURITE -- produit archivé jamais proposé comme cible (même garde que set_product_photo)", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Vieux Fromage.jpg")]);
  await flush(50);
  // Le nom correspond exactement à un produit ARCHIVÉ -- doit rester
  // non apparié (l'index d'appariement exclut les archivés).
  assert.ok(container.textContent!.includes("Non apparié"));
  root.unmount();
  container.remove();
});

test("SECURITE -- un rôle sans droit d'édition ne voit jamais le bouton Bulk Photos", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockMappings = [
    { restaurant_id: "r-test", role: "staff", restaurants: { id: "r-test", name: "Fromagerie Test", slug: "fromagerie-test" } },
  ];
  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("Fromages"));
  const btn = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Photos en lot"));
  assert.equal(btn, undefined, "un rôle staff (sans canEditProducts) ne doit jamais voir ce bouton");
  root.unmount();
  container.remove();
});

test("SECURITE -- opérateur Scanym (sans rattachement restaurant_users) : cible valide, bulk photos accessible et scoped au restaurant visé", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockMappings = []; // aucune adhésion restaurant_users propre
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-test");
  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("Fromages"));
  openBulkPhotoPanel(container);
  await waitFor(() => !!container.querySelector('[role="region"]'));

  selectFiles(container, [makeFile("Camembert.jpg")]);
  await flush(50);
  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  assert.ok(confirmBtn && !confirmBtn.disabled);
  confirmBtn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  const call = (globalThis as any).__mockApplyCalls[0];
  assert.equal(call.restaurantId, "r-test", "même un opérateur ne doit appliquer que sur le restaurant explicitement ciblé");
  assert.equal(call.productId, "p-camembert");
  root.unmount();
  container.remove();
});

test("SECURITE -- aucune collision de chemin tenant : chaque application est adressée au restaurantId de la session courante, jamais un autre", async () => {
  const { container, root } = await setupAndOpenPanel();
  // v2.0 -- Reblochon (sans photo existante), pas Brie : ce test
  // couvre le scoping tenant, indépendant du gate existing-photo.
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("reblochon.jpg")]);
  await flush(50);
  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  confirmBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.ok(
    calls.every((c) => c.restaurantId === "r-test"),
    "toute application doit être adressée au restaurant de la session courante -- jamais r-other ni un autre id"
  );
  root.unmount();
  container.remove();
});

// ====================================================================
// FAILURE / RETRY
// ====================================================================

test("FAILURE -- un échec d'upload est rapporté individuellement, les autres fichiers continuent d'être traités", async () => {
  const { container, root } = await setupAndOpenPanel();
  // v2.1 -- Reblochon (sans photo existante), pas Brie : ce test
  // couvre le mécanisme échec/retry, indépendant du drapeau global
  // existing-photo (couvert par le test dédié plus bas, qui lui
  // combine explicitement retry ET drapeau global activé).
  (globalThis as any).__mockApplyFailFor = new Set(["p-reblochon"]);
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("reblochon.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  confirmBtn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  await waitFor(() => container.textContent!.includes("1 photo(s) sur 2 appliquée(s) avec succès"));
  assert.ok(container.textContent!.includes("Échec de l'envoi de cette photo"));

  const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Réessayer les échecs")
  ) as HTMLButtonElement;
  assert.ok(retryBtn);

  // Le retry ne doit rejouer QUE le fichier en échec (Reblochon),
  // jamais Camembert (déjà réussi) -- aucun doublon d'objet Storage
  // incontrôlé (mandat "retry must not create uncontrolled duplicate
  // image objects").
  (globalThis as any).__mockApplyFailFor = new Set(); // le prochain essai réussit
  retryBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 3);
  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.equal(calls.filter((c) => c.productId === "p-camembert").length, 1, "Camembert ne doit jamais être ré-uploadé au retry");
  assert.equal(calls.filter((c) => c.productId === "p-reblochon").length, 2, "seul Reblochon (échoué) est rejoué");

  await waitFor(() => container.textContent!.includes("2 photo(s) sur 2 appliquée(s) avec succès"));
  root.unmount();
  container.remove();
});

// ====================================================================
// NON-REGRESSION
// ====================================================================

test("NON-REGRESSION -- le flux photo unique (ProductPhotoField, via Modifier) reste présent et fonctionnel à côté du panneau bulk", async () => {
  const { container, root } = await setupAndOpenPanel();
  // La liste des produits reste affichée, le panneau bulk n'en prend
  // jamais la place -- et le flux d'édition individuelle (bouton
  // "Modifier" -> ProductPhotoField) reste intact et atteignable.
  await flush(30);
  assert.ok(container.textContent!.includes("Camembert"));

  // Plusieurs boutons "Modifier" existent (catégorie ET produits) --
  // on cible précisément celui de la ligne produit "Camembert" (le
  // <li> qui contient son nom), jamais le premier bouton "Modifier"
  // rencontré (qui pourrait être celui de la catégorie elle-même).
  const productItems = Array.from(container.querySelectorAll("li"));
  const camembertItem = productItems.find((li) => (li.textContent ?? "").includes("Camembert"));
  assert.ok(camembertItem, "ligne produit Camembert introuvable");
  const editButtons = Array.from(camembertItem!.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "").trim() === "Modifier"
  );
  assert.ok(editButtons.length > 0, "le bouton Modifier (édition produit) doit rester présent");
  (editButtons[0] as HTMLButtonElement).click();
  await flush(30);
  assert.ok(
    container.textContent!.includes("Ajouter une photo") ||
      container.textContent!.includes("Remplacer la photo"),
    "ProductPhotoField (photo unique) doit toujours apparaître en mode édition, inchangé par ce lot"
  );
  root.unmount();
  container.remove();
});

test("NON-REGRESSION -- créer une catégorie reste fonctionnel (bouton mcAddCategory toujours présent)", async () => {
  resetGlobalMockState();
  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("Fromages"));
  const btn = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("+ Catégorie"));
  assert.ok(btn, "bouton d'ajout de catégorie doit rester présent, inchangé par ce lot");
  root.unmount();
  container.remove();
});

// ====================================================================
// BULK PRODUCT PHOTOS v2.2 -- FINAL SIMPLIFICATION (décision CIO qui
// ANNULE ET REMPLACE le modèle "drapeau global" v2.1 ci-dessus, lui-
// même remplaçant du modèle "skip par défaut + override par ligne"
// v2.0). CONFIRMER LE LOT BULK LUI-MÊME autorise le remplacement de
// TOUT produit correctement apparié -- il n'existe PLUS aucune case à
// cocher, ni globale ni par ligne. Couvre au niveau DOM (composant
// réel, catalogue réel via get_merchant_catalogue) : l'absence de
// toute case à cocher, la note de confirmation statique, l'inclusion
// automatique et immédiate des lignes avec photo existante, et le
// mécanisme LOST HTTP RESPONSE / SUCCESSFUL REPLAY (batchId STABLE
// PAR LOT, `isRetry` booléen simple transmis sur chaque appel -- v2.2.1
// RETIRE `expectedPriorImageUrl`, la décision ALREADY_APPLIED/CONFLICT
// étant désormais prise ENTIÈREMENT côté SQL, sous le verrou de ligne
// autoritaire -- CONFLICT reste distinct d'un échec ordinaire).
// L'édition manuelle d'une seule photo
// (Single Photo Edit) reste couverte par la suite existante
// tests/v67b-photo-error-message.dom.test.ts, non modifiée par ce lot.
// ====================================================================

test("v2.2 -- aucune case à cocher nulle part dans le panneau -- confirmer le lot suffit à tout appliquer", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);

  const region = container.querySelector('[role="region"]');
  const checkboxes = region!.querySelectorAll('input[type="checkbox"]');
  assert.equal(checkboxes.length, 0, "mandat v2.2 : 'There is no OFF/ON replacement mode. There is no per-row replacement mode.' -- ZÉRO case à cocher");

  root.unmount();
  container.remove();
});

test("v2.2 -- note de confirmation statique affichée quand au moins une ligne a déjà une photo, jamais une case interactive", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);

  assert.ok(
    container.textContent!.includes("Confirmer cet import remplacera les photos des produits appariés."),
    "la note de confirmation exacte du mandat doit être affichée une fois"
  );
  assert.ok(
    container.textContent!.includes("Photo déjà présente"),
    "l'indicateur passif par ligne reste affiché (purement informatif, INCHANGÉ depuis v2.1)"
  );

  root.unmount();
  container.remove();
});

test("v2.2 -- produit AVEC photo existante (Brie) : prêt IMMÉDIATEMENT, inclus AUTOMATIQUEMENT dans l'application sans aucune interaction supplémentaire", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  assert.ok(confirmBtn && !confirmBtn.disabled);
  assert.ok(
    confirmBtn.textContent!.includes("(2)"),
    `les DEUX items (avec et sans photo existante) doivent être comptés prêts DÈS la prévisualisation, reçu: "${confirmBtn.textContent}"`
  );
  confirmBtn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.deepEqual(calls.map((c) => c.productId).sort(), ["p-brie", "p-camembert"]);

  await waitFor(() => container.textContent!.includes("2 photo(s) sur 2 appliquée(s) avec succès"));
  root.unmount();
  container.remove();
});

test("v2.2 -- deux produits avec photo existante (Brie, Munster) sont TOUS LES DEUX appliqués d'un coup, sans arbitrage", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("brie.jpg"), makeFile("munster.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  assert.ok(confirmBtn.textContent!.includes("(2)"), "aucun arbitrage requis -- les deux sont prêts d'emblée");
  confirmBtn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.deepEqual(calls.map((c) => c.productId).sort(), ["p-brie", "p-munster"]);

  root.unmount();
  container.remove();
});

test("v2.2 -- batchId STABLE pour TOUT le lot (partagé entre deux produits différents), PREMIÈRE tentative -> isRetry:false pour chacun", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  confirmBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  const calls = (globalThis as any).__mockApplyCalls as any[];

  assert.ok(calls[0].bulk?.batchId, "batchId doit être fourni pour une opération Bulk");
  assert.equal(
    calls[0].bulk.batchId,
    calls[1].bulk.batchId,
    "mandat : 'Generate ONE stable batchId when the Bulk candidate is created' -- un SEUL batchId pour TOUT le lot, jamais un par fichier"
  );
  assert.equal(calls[0].bulk.isRetry, false);
  assert.equal(calls[1].bulk.isRetry, false);

  root.unmount();
  container.remove();
});

test("v2.2/v2.2.1 -- RETRY d'un item en échec : MÊME batchId, isRetry:true (v2.2.1 : aucune 'image attendue' transmise -- la décision est prise entièrement côté SQL)", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockApplyFailFor = new Set(["p-brie"]);
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  confirmBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  await waitFor(() => container.textContent!.includes("1 photo(s) sur 2 appliquée(s) avec succès"));

  const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Réessayer les échecs")
  ) as HTMLButtonElement;
  assert.ok(retryBtn);

  (globalThis as any).__mockApplyFailFor = new Set();
  retryBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 3);
  const calls = (globalThis as any).__mockApplyCalls as any[];
  const brieCalls = calls.filter((c) => c.productId === "p-brie");
  assert.equal(brieCalls.length, 2, "Brie : une première tentative (échec) + un retry");
  assert.equal(brieCalls[0].bulk.isRetry, false);
  assert.equal(brieCalls[1].bulk.isRetry, true, "le retry DOIT être marqué comme tel");
  assert.equal(
    brieCalls[1].bulk.batchId,
    brieCalls[0].bulk.batchId,
    "le retry réutilise le MÊME batchId que la tentative initiale -- jamais régénéré"
  );
  // v2.2.1 -- AUCUNE "image attendue" n'est plus transmise par ce
  // composant : `bulk` ne porte plus que `{batchId, isRetry}` (voir
  // BulkPhotoApplyContext, lib/services/product-photo.ts) -- la
  // décision ALREADY_APPLIED/CONFLICT est prise ENTIÈREMENT côté SQL.
  assert.ok(
    !("expectedPriorImageUrl" in brieCalls[1].bulk),
    "le champ expectedPriorImageUrl (v2.2) n'existe plus sur le contexte Bulk transmis (v2.2.1, SOLE BLOCKER FIX)"
  );

  await waitFor(() => container.textContent!.includes("2 photo(s) sur 2 appliquée(s) avec succès"));
  root.unmount();
  container.remove();
});

test("v2.2 -- CONFLICT (PhotoConflictError) affiché avec un message DISTINCT d'un échec ordinaire, les autres fichiers du lot ne sont jamais affectés", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockApplyConflictFor = new Set(["p-brie"]);
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  confirmBtn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);
  await waitFor(() => container.textContent!.includes("1 photo(s) sur 2 appliquée(s) avec succès"));
  assert.ok(
    container.textContent!.includes("Photo modifiée entre-temps"),
    "un CONFLICT doit afficher son propre message, distinct de l'échec d'upload générique"
  );
  assert.ok(
    !container.textContent!.includes("Échec de l'envoi de cette photo"),
    "aucun autre fichier de ce lot n'a échoué -- le message d'échec ordinaire ne doit PAS apparaître ici"
  );

  root.unmount();
  container.remove();
});

test("v2.2/v2.2.1 -- retry après CONFLICT réussit une fois la situation résolue, réutilise le MÊME batchId", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockApplyConflictFor = new Set(["p-brie"]);
  selectFiles(container, [makeFile("brie.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  confirmBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  await waitFor(() => container.textContent!.includes("Photo modifiée entre-temps"));

  (globalThis as any).__mockApplyConflictFor = new Set(); // la situation en conflit est résolue
  const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Réessayer les échecs")
  ) as HTMLButtonElement;
  retryBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 2);

  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.equal(calls[1].bulk.batchId, calls[0].bulk.batchId);
  assert.equal(calls[1].bulk.isRetry, true);

  await waitFor(() => container.textContent!.includes("1 photo(s) sur 1 appliquée(s) avec succès"));
  root.unmount();
  container.remove();
});

test("v2.2 -- tenant isolation préservée pour un remplacement automatique d'une photo existante (Brie), sans aucune interaction supplémentaire", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("brie.jpg")]);
  await flush(50);

  const confirmBtn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
  confirmBtn.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 1);
  const call = (globalThis as any).__mockApplyCalls[0];
  assert.equal(call.restaurantId, "r-test", "même un remplacement automatique d'une photo existante reste adressé au restaurant de la session courante, jamais un autre");
  assert.equal(call.productId, "p-brie");

  root.unmount();
  container.remove();
});

after(() => {
  window.close();
  void esbuild.stop();
});
