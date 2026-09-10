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
// BULK PRODUCT PHOTOS v1.1 — REMEDIATION: Cat Stevens Blocker 2
// (retry successful files replay).
//
// Reproduit exactement le harnais de tests/v150-bulk-product-photos.dom.test.ts
// (même fixture, mêmes mocks) -- ce fichier est un AJOUT ciblé, pas
// un remplacement : les 33 tests v1/v1.1-régression existants restent
// dans v150 et v67c (voir TEST-RESULTS.md pour la vue d'ensemble).
//
// Couvre les 5 CASE du mandat v1.1 :
//   CASE 1 -- 3 fichiers, tous réussissent -> bouton désactivé, second
//             clic impossible, aucun upload dupliqué.
//   CASE 2 -- 3 fichiers, 2 réussissent, 1 échoue -> seul le fichier en
//             échec est rejouable, le retry n'uploade QUE lui.
//   CASE 3 -- le fichier en échec réussit au retry -> le lot devient
//             complet, plus aucun replay possible.
//   CASE 4 -- un fichier déjà réussi n'est JAMAIS ré-uploadé pendant un
//             retry (vérifié par comptage exact des appels).
//   CASE 5 -- remplacement de photo existante + tentative de replay
//             (double clic rapide) -> aucun second appel avec un
//             previousImageUrl potentiellement périmé.
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
        makeProduct({ product_id: "p-reblochon", name: "Reblochon", image_url: null }),
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
// v1.3 (Cat Stevens, Blocker A) : addOrReplaceProductPhoto n'accepte
// plus de previousImageUrl -- voir tests/v150-bulk-product-photos.dom.test.ts
// pour la même note ; signature réelle à 3 paramètres reflétée ici.
(globalThis as any).__mockApplyCalls = [] as { restaurantId: string; productId: string; fileName: string; bulk: unknown }[];
(globalThis as any).__mockApplyFailFor = new Set<string>();

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
  return { mime: "image/jpeg", ext: "jpg" };
}

export async function addOrReplaceProductPhoto(restaurantId, productId, file, bulk) {
  (globalThis).__mockApplyCalls.push({ restaurantId, productId, fileName: file.name, bulk: bulk ?? null });
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
  (globalThis as any).__mockApplyCalls = [];
  (globalThis as any).__mockApplyFailFor = new Set<string>();
}

function makeFile(name: string, size = 1000): File {
  return new window.File([new Uint8Array(size)], name, { type: "image/jpeg" });
}

function selectFiles(container: HTMLElement, files: File[]) {
  const region = container.querySelector('[role="region"]');
  assert.ok(region, "panneau BulkPhotoUpload introuvable");
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

async function setupAndOpenPanel() {
  resetGlobalMockState();
  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("Fromagerie Test") || container.textContent!.includes("Fromages"));
  openBulkPhotoPanel(container);
  await waitFor(() => !!container.querySelector('[role="region"]'));
  return { container, root };
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Confirmer et appliquer")
  ) as HTMLButtonElement;
}

function retryButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Réessayer les échecs")
  ) as HTMLButtonElement | undefined;
}

// v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, décision CIO qui
// ANNULE ET REMPLACE le modèle "drapeau global" v2.1 ci-dessus décrit).
// Brie a une photo existante dans la fixture de ce fichier -- CASE 1 à
// 5 ci-dessous testent des mécaniques de retry/réentrance/anti-replay
// qui ne dépendent PAS elles-mêmes de l'état "photo existante". En
// v2.1 il fallait activer une case globale avant que Brie ne devienne
// "prêt" ; en v2.2 il n'existe PLUS AUCUNE case (ni globale, ni par
// ligne) -- confirmer le lot suffit, Brie est prêt dès la
// prévisualisation, exactement comme tout autre fichier apparié. Le
// helper d'activation a donc été retiré : aucun geste supplémentaire
// n'est plus nécessaire avant de confirmer.

// ====================================================================
// CASE 1 -- 3 fichiers, tous réussissent
// ====================================================================

test("CASE 1 -- 3 fichiers, tous réussissent -> bouton désactivé, second clic impossible, aucun doublon", async () => {
  const { container, root } = await setupAndOpenPanel();
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg"), makeFile("Reblochon.jpg")]);
  await flush(50);
  // v2.2 -- Brie a une photo existante : prêt IMMÉDIATEMENT, aucun
  // geste supplémentaire requis (ce test vérifie la mécanique de
  // retry/réentrance, pas l'inclusion automatique elle-même -- voir
  // les tests dédiés v2.2 de v150-bulk-product-photos.dom.test.ts pour
  // cette dernière).

  const btn = confirmButton(container);
  assert.ok(!btn.disabled, "les 3 fichiers sont appariés (Brie inclus automatiquement, v2.2) -> bouton actif avant confirmation");
  btn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 3);
  await waitFor(() => container.textContent!.includes("3 photo(s) sur 3 appliquée(s) avec succès"));

  const btnAfter = confirmButton(container);
  assert.ok(btnAfter.disabled, "les 3 fichiers sont déjà appliqués -> bouton désactivé (CASE 1)");

  // Second clic -- ne doit produire AUCUN appel supplémentaire (un
  // bouton disabled ne déclenche pas son onClick, comme dans un vrai
  // navigateur -- vérifié explicitement plutôt que supposé).
  btnAfter.click();
  await flush(50);
  assert.equal((globalThis as any).__mockApplyCalls.length, 3, "aucun appel supplémentaire après un second clic sur le bouton désactivé");

  root.unmount();
  container.remove();
});

// ====================================================================
// CASE 2 -- 3 fichiers, 2 réussissent, 1 échoue
// ====================================================================

test("CASE 2 -- 3 fichiers, 2 réussissent, 1 échoue -> seul le fichier en échec est rejouable, retry n'uploade que lui", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockApplyFailFor = new Set(["p-brie"]);
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg"), makeFile("Reblochon.jpg")]);
  await flush(50);

  confirmButton(container).click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 3);
  await waitFor(() => container.textContent!.includes("2 photo(s) sur 3 appliquée(s) avec succès"));

  const rBtn = retryButton(container);
  assert.ok(rBtn, "un fichier en échec doit rendre le bouton de retry visible");

  (globalThis as any).__mockApplyFailFor = new Set(); // le retry réussira cette fois
  rBtn!.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 4);

  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.equal(calls.filter((c) => c.productId === "p-camembert").length, 1, "Camembert (déjà réussi) n'est jamais rejoué");
  assert.equal(calls.filter((c) => c.productId === "p-reblochon").length, 1, "Reblochon (déjà réussi) n'est jamais rejoué");
  assert.equal(calls.filter((c) => c.productId === "p-brie").length, 2, "Brie (échoué) est rejoué exactement une fois, jamais plus");

  root.unmount();
  container.remove();
});

// ====================================================================
// CASE 3 -- le fichier en échec réussit au retry -> lot complet
// ====================================================================

test("CASE 3 -- le fichier en échec réussit au retry -> le lot devient complet, plus aucun replay possible", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockApplyFailFor = new Set(["p-brie"]);
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg"), makeFile("Reblochon.jpg")]);
  await flush(50);
  confirmButton(container).click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 3);

  (globalThis as any).__mockApplyFailFor = new Set();
  retryButton(container)!.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 4);
  await waitFor(() => container.textContent!.includes("3 photo(s) sur 3 appliquée(s) avec succès"));

  assert.equal(retryButton(container), undefined, "plus aucun fichier en échec -> bouton de retry disparaît (lot complet)");
  const btn = confirmButton(container);
  assert.ok(btn.disabled, "lot complet -> bouton de confirmation principal désactivé aussi");

  btn.click();
  await flush(50);
  assert.equal((globalThis as any).__mockApplyCalls.length, 4, "aucun replay possible une fois le lot complet");

  root.unmount();
  container.remove();
});

// ====================================================================
// CASE 4 -- un fichier réussi n'est jamais ré-uploadé pendant un retry
// (déjà prouvé structurellement par CASE 2/3 ; test dédié explicite
// pour la traçabilité directe avec le mandat).
// ====================================================================

test("CASE 4 -- un fichier déjà réussi n'est jamais ré-uploadé, même après PLUSIEURS cycles retry", async () => {
  const { container, root } = await setupAndOpenPanel();
  (globalThis as any).__mockApplyFailFor = new Set(["p-brie", "p-reblochon"]);
  selectFiles(container, [makeFile("Camembert.jpg"), makeFile("brie.jpg"), makeFile("Reblochon.jpg")]);
  await flush(50);
  confirmButton(container).click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 3);

  // Premier retry : Brie réussit, Reblochon échoue encore.
  (globalThis as any).__mockApplyFailFor = new Set(["p-reblochon"]);
  retryButton(container)!.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 5); // 2 retries tentés (brie + reblochon)

  // Second retry : Reblochon réussit enfin.
  (globalThis as any).__mockApplyFailFor = new Set();
  await waitFor(() => !!retryButton(container));
  retryButton(container)!.click();
  await waitFor(() => (globalThis as any).__mockApplyCalls.length === 6);

  const calls = (globalThis as any).__mockApplyCalls as any[];
  assert.equal(calls.filter((c) => c.productId === "p-camembert").length, 1, "Camembert (réussi dès le premier essai) : jamais rejoué sur 2 cycles de retry");
  assert.equal(calls.filter((c) => c.productId === "p-brie").length, 2, "Brie (réussi au 1er retry) : jamais rejoué au 2e retry");
  // Reblochon échoue à l'application initiale ET au premier retry
  // (volontairement maintenu dans __mockApplyFailFor jusqu'au second
  // retry, voir ligne 400 ci-dessus) avant de réussir au second retry :
  // 3 tentatives légitimes (2 échecs + 1 succès), jamais une 4e -- ce
  // qui est exactement ce que ce test vérifie (aucun replay au-delà de
  // ce que les échecs successifs justifient).
  assert.equal(calls.filter((c) => c.productId === "p-reblochon").length, 3, "Reblochon (réussi seulement au 2e retry) : 2 échecs + 1 succès, jamais plus");

  root.unmount();
  container.remove();
});

// ====================================================================
// CASE 5 -- remplacement de photo existante + tentative de replay
// (double clic rapide) -> jamais un second appel Storage/RPC, aucun
// orphelin évitable causé par un replay UI. v1.3 (Cat Stevens, Blocker
// A) : addOrReplaceProductPhoto ne reçoit plus previousImageUrl du
// tout (le nettoyage de l'ancienne photo est prouvé et effectué côté
// serveur par la RPC elle-même) -- le risque historique d'un
// previousImageUrl périmé transmis par un second appel replay n'existe
// donc plus PAR CONSTRUCTION, mais le risque de réentrance (2 appels
// Storage/RPC réels pour 1 seul clic utilisateur) reste vérifié
// ci-dessous, à l'identique.
// ====================================================================

test("CASE 5 -- remplacement de photo existante : prêt IMMÉDIATEMENT (v2.2, aucun geste préalable), puis double clic rapide ne produit jamais un second appel pour le même fichier", async () => {
  const { container, root } = await setupAndOpenPanel();
  // Brie a déjà une photo existante dans la fixture -- cas de
  // remplacement, pas d'ajout.
  selectFiles(container, [makeFile("brie.jpg")]);
  await flush(50);

  // v2.2 -- confirmer le lot autorise déjà le remplacement de tout
  // produit correctement apparié : aucun geste préalable n'est requis,
  // le bouton est actif dès la prévisualisation malgré la photo
  // existante (l'indicateur reste affiché, purement informatif).
  assert.ok(container.textContent!.includes("Photo déjà présente") || container.textContent!.includes("a déjà une photo"));
  const btn = confirmButton(container);
  assert.ok(!btn.disabled, "v2.2 -- un produit avec photo existante est prêt IMMÉDIATEMENT, sans aucune case à activer");
  // Double clic RAPIDE, avant toute résolution de la promesse
  // d'upload (simulateur du scénario du mandat : "avant que le
  // rechargement du catalogue parent ne mette à jour
  // previousImageUrl").
  btn.click();
  btn.click();

  await waitFor(() => (globalThis as any).__mockApplyCalls.length >= 1);
  await flush(80); // laisse une éventuelle 2e invocation se manifester si le bug était présent

  assert.equal(
    (globalThis as any).__mockApplyCalls.length,
    1,
    "un double clic rapide sur le fichier de remplacement ne produit JAMAIS un second appel Storage/RPC"
  );
  const call = (globalThis as any).__mockApplyCalls[0];
  assert.equal(call.productId, "p-brie");
  assert.ok(
    !("previousImageUrl" in call),
    "l'appel ne doit plus jamais transporter de previousImageUrl -- ce paramètre a été supprimé (Cat Stevens, Blocker A) : la RPC lit seule l'ancienne valeur en DB, jamais une valeur cliente, périmée ou non"
  );

  await waitFor(() => container.textContent!.includes("1 photo(s) sur 1 appliquée(s) avec succès"));
  assert.ok(confirmButton(container).disabled, "après le succès unique, le bouton reste désactivé -- aucun second appel n'est jamais possible ensuite");

  root.unmount();
  container.remove();
});

after(() => {
  window.close();
  void esbuild.stop();
});
