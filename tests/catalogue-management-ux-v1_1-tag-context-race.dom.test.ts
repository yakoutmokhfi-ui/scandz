import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — CATALOGUE MANAGEMENT UX v1.1
// CMUX-V1-TAG-CONTEXT-RACE-01 (HIGH, bloquant) — REMÉDIATION CIBLÉE.
//
// Ce fichier prouve, sur le RENDU RÉEL de
// app/dashboard/catalogue/page.tsx, qu'une réponse asynchrone périmée
// -- venue d'un autre établissement, ou d'une requête plus ancienne du
// MÊME établissement -- ne peut plus devenir visible.
//
// MÉTHODE : aucune attente arbitraire (`sleep`) ne sert de preuve. Les
// services sont remplacés par des promesses DIFFÉRÉES que le test
// résout lui-même, dans l'ordre qu'il choisit. L'ordre d'arrivée des
// réponses est donc DÉTERMINISTE, et la course est reproduite
// exactement, jamais approchée.
//
// CONTRÔLE NÉGATIF (§10 du mandat) : le dernier test recompile le même
// écran APRÈS avoir retiré la garde, et vérifie que la fuite
// réapparaît. Sans cela, ces tests prouveraient seulement que le
// chemin s'exécute, pas que la garde protège.
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
const PAGE_PATH = path.join(REPO_ROOT, "app", "dashboard", "catalogue", "page.tsx");

const A = "resto-a";
const B = "resto-b";

// ------------------------------------------------------------------
// Journal des requêtes DIFFÉRÉES. Chaque appel de service enregistre
// sa provenance et son résolveur ; rien ne se résout tant que le test
// ne l'a pas décidé.
// ------------------------------------------------------------------
interface PendingRequest {
  fn: string;
  id: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}
(globalThis as any).__pending = [] as PendingRequest[];
(globalThis as any).__mutations = [] as Array<{ fn: string; args: unknown[] }>;

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/catalogue"; }
export function useSearchParams() { return new URLSearchParams(""); }
`;
const MOCK_AUTH = `
export async function getUser() { return { id: "u1" }; }
export async function getSession() { return { access_token: "t", user: { id: "u1" } }; }
export async function signOut() {}
`;
const DEFER = `
function defer(fn, id) {
  return new Promise((resolve, reject) => {
    (globalThis).__pending.push({ fn, id, resolve, reject, settled: false });
  });
}
`;
const MOCK_DASHBOARD = `
${DEFER}
export function getMerchantCatalogue(id) { return defer("catalogue", id); }
export async function getMerchantRestaurants() {
  return [
    { restaurant_id: "${A}", role: "owner", restaurants: { id: "${A}", name: "Au lait cru", slug: "a" } },
    { restaurant_id: "${B}", role: "owner", restaurants: { id: "${B}", name: "Hotel Royal", slug: "b" } },
  ];
}
export async function getRestaurantSettings() { return { currency: "EUR", staff_receipt_language: "fr" }; }
export async function createProduct() { return "new"; }
export async function updateProduct() {}
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
${DEFER}
export function getRestaurantProductTags(id) { return defer("productTags", id); }
export function getRestaurantTags(id) { return defer("knownTags", id); }
export async function addProductTags(productId, names) {
  (globalThis).__mutations.push({ fn: "addProductTags", args: [productId, names] });
  return names.length;
}
export async function removeProductTag(productId, tagId) {
  (globalThis).__mutations.push({ fn: "removeProductTag", args: [productId, tagId] });
  return 1;
}
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
};

/**
 * Compile et charge le VRAI écran. `transformPage` permet au contrôle
 * négatif de recompiler exactement le même écran une seconde fois,
 * garde retirée.
 */
async function buildPage(transformPage?: (src: string) => string): Promise<any> {
  const plugin: esbuild.Plugin = {
    name: "scanym-mocks",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path in mocks) return { path: args.path, namespace: "mock" };
        if (args.path.startsWith("@/")) {
          const rel = args.path.slice(2);
          const base = path.join(REPO_ROOT, rel);
          const candidate = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
          return { path: candidate ?? base };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
        contents: mocks[args.path],
        loader: "ts",
      }));
      if (transformPage) {
        build.onLoad({ filter: /app[\\/]dashboard[\\/]catalogue[\\/]page\.tsx$/ }, (args) => ({
          contents: transformPage(readFileSync(args.path, "utf8")),
          loader: "tsx",
        }));
      }
    },
  };

  const result = await esbuild.build({
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
    plugins: [plugin],
    external: ["react", "react-dom", "react-dom/client"],
  });

  const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-race-"));
  const tmpFile = path.join(tmpDir, `Page-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(tmpFile, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpDir, { recursive: true, force: true });
  return mod.CataloguePage;
}

const GuardedPage = await buildPage();

// ------------------------------------------------------------------
// Fixtures — les deux tenants ont des produits et des tags DISJOINTS.
// ------------------------------------------------------------------
function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "pa1",
    category_id: "ca",
    category_name: "Fromages A",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Produit A",
    name_hash: "h",
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 10,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: 5.5,
    unit_weight_grams: 200,
    weight_is_approximate: false,
    reference_price_per_kg: 50,
    ...over,
  };
}
function category(over: Record<string, unknown> = {}) {
  return {
    category_id: "ca",
    category_name: "Fromages A",
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

const CATALOGUE_A = [category({ products: [product()] })];
const CATALOGUE_B = [
  category({
    category_id: "cb",
    category_name: "Vins B",
    products: [product({ product_id: "pb1", category_id: "cb", category_name: "Vins B", name: "Produit B" })],
  }),
];

const SECRET_A = "Secret tenant A";
const PUBLIC_B = "Tag public B";
const OLD_GEN_A = "Ancienne generation A";

const PRODUCT_TAGS_A = [{ menuItemId: "pa1", tagIds: ["ta1"], tagNames: [SECRET_A] }];
const KNOWN_TAGS_A = [
  { id: "ta1", name: SECRET_A, normalizedKey: "secret tenant a", visibleOnCustomerMenu: false, displayOrder: 0, productCount: 1 },
];
const PRODUCT_TAGS_A_OLD = [{ menuItemId: "pa1", tagIds: ["ta9"], tagNames: [OLD_GEN_A] }];
const KNOWN_TAGS_A_OLD = [
  { id: "ta9", name: OLD_GEN_A, normalizedKey: "ancienne generation a", visibleOnCustomerMenu: false, displayOrder: 0, productCount: 1 },
];
const PRODUCT_TAGS_B = [{ menuItemId: "pb1", tagIds: ["tb1"], tagNames: [PUBLIC_B] }];
const KNOWN_TAGS_B = [
  { id: "tb1", name: PUBLIC_B, normalizedKey: "tag public b", visibleOnCustomerMenu: false, displayOrder: 0, productCount: 1 },
];

// ------------------------------------------------------------------
// Outils DOM
// ------------------------------------------------------------------
function q(c: HTMLElement, sel: string) {
  return c.querySelector(sel) as HTMLElement | null;
}
function qa(c: HTMLElement, sel: string) {
  return [...c.querySelectorAll(sel)] as HTMLElement[];
}
function setValue(el: HTMLElement, value: string, proto: any) {
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(
    new window.Event(proto === window.HTMLSelectElement ? "change" : "input", { bubbles: true })
  );
}
function click(el: Element | null) {
  assert.ok(el, "élément à cliquer introuvable");
  el!.dispatchEvent(new window.Event("click", { bubbles: true }));
}
/** Laisse React traiter les micro-tâches déjà résolues. Ce n'est JAMAIS
 *  une preuve d'ordonnancement : l'ordre est imposé par `settle`. */
function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

function pendingList(): PendingRequest[] {
  return (globalThis as any).__pending as PendingRequest[];
}
function open(fn: string, id: string): PendingRequest[] {
  return pendingList().filter((r) => r.fn === fn && r.id === id && !r.settled);
}
/** Résout la requête EN ATTENTE la plus ANCIENNE correspondante. */
async function settle(fn: string, id: string, value: unknown): Promise<void> {
  const [req] = open(fn, id);
  assert.ok(req, `aucune requête ${fn}(${id}) en attente`);
  req.settled = true;
  req.resolve(value);
  await flush();
}
/** Résout la requête EN ATTENTE la plus RÉCENTE correspondante. */
async function settleNewest(fn: string, id: string, value: unknown): Promise<void> {
  const list = open(fn, id);
  const req = list[list.length - 1];
  assert.ok(req, `aucune requête ${fn}(${id}) en attente`);
  req.settled = true;
  req.resolve(value);
  await flush();
}
async function waitPending(fn: string, id: string, atLeast = 1): Promise<void> {
  const ok = await waitFor(() => open(fn, id).length >= atLeast);
  assert.ok(ok, `requête ${fn}(${id}) jamais émise (attendu >= ${atLeast})`);
}

function render(Page: any) {
  (globalThis as any).__pending = [];
  (globalThis as any).__mutations = [];
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  createRoot(container).render(React.createElement(Page));
  return container;
}

/** Charge complètement le restaurant A : catalogue + tags résolus. */
async function loadA(container: HTMLElement): Promise<void> {
  await waitPending("catalogue", A);
  await settle("catalogue", A, CATALOGUE_A);
  await waitPending("productTags", A);
  await settle("productTags", A, PRODUCT_TAGS_A);
  await settle("knownTags", A, KNOWN_TAGS_A);
  await waitFor(() => (container.textContent ?? "").includes("Produit A"));
}

function switchTo(container: HTMLElement, id: string): void {
  const select = q(container, "header select");
  assert.ok(select, "sélecteur d'établissement introuvable");
  setValue(select!, id, window.HTMLSelectElement);
}

/** Options réellement proposées par le filtre « Tag ». */
function tagFilterOptions(container: HTMLElement): string[] {
  const sel = q(container, '[data-testid="filter-tag"]');
  if (!sel) return [];
  return qa(sel, "option")
    .map((o) => (o.textContent ?? "").trim())
    .filter((v, i) => i > 0 || v !== "");
}

/** Suggestions de tags visibles dans l'éditeur produit ouvert. */
function suggestionValues(container: HTMLElement): string[] {
  const dl = q(container, "#product-tag-suggestions");
  return dl ? qa(dl, "option").map((o) => (o as HTMLOptionElement).value) : [];
}

async function openFirstProductEditor(container: HTMLElement): Promise<void> {
  const card = qa(container, "li").find((li) => /Produit [AB]/.test(li.textContent ?? ""));
  assert.ok(card, "carte produit introuvable");
  const btn = qa(card!, "button").find((b) => (b.textContent ?? "").trim() === "Modifier");
  assert.ok(btn, "bouton Modifier introuvable");
  click(btn!);
  await flush();
}

// ==================================================================
// A. Réponse PÉRIMÉE de A après bascule A -> B
// ==================================================================

test("[RACE-A] une réponse de tags de A qui arrive APRÈS la bascule vers B est REJETÉE -- B reste l'autorité", async () => {
  const container = render(GuardedPage);
  await loadA(container);
  assert.deepEqual(tagFilterOptions(container).filter((o) => o === SECRET_A), [SECRET_A], "A affiche bien ses tags avant la bascule");

  // 2. une NOUVELLE requête de tags A part et RESTE EN ATTENTE
  //    (l'utilisateur ouvre les archives).
  click(qa(container, "button").find((b) => /archives/i.test(b.textContent ?? "")) ?? null);
  await waitPending("catalogue", A);
  await settle("catalogue", A, CATALOGUE_A);
  await waitPending("productTags", A);
  const staleProductTags = open("productTags", A)[0];
  const staleKnownTags = open("knownTags", A)[0];
  assert.ok(staleProductTags && staleKnownTags, "les requêtes A doivent être en vol");

  // 3. bascule vers B, 4. B se charge complètement
  switchTo(container, B);
  await waitPending("catalogue", B);
  await settle("catalogue", B, CATALOGUE_B);
  await waitPending("productTags", B);
  await settle("productTags", B, PRODUCT_TAGS_B);
  await settle("knownTags", B, KNOWN_TAGS_B);
  await waitFor(() => (container.textContent ?? "").includes("Produit B"));
  assert.deepEqual(tagFilterOptions(container).filter((o) => o === PUBLIC_B), [PUBLIC_B], "B affiche ses propres tags");

  // 5. LA RÉPONSE DE A ARRIVE MAINTENANT.
  staleProductTags!.settled = true;
  staleProductTags!.resolve(PRODUCT_TAGS_A);
  staleKnownTags!.settled = true;
  staleKnownTags!.resolve(KNOWN_TAGS_A);
  await flush(80);

  // 6. elle n'a RIEN écrit.
  assert.equal(
    (container.textContent ?? "").includes(SECRET_A),
    false,
    "fuite : une métadonnée de tag du tenant A est visible sur l'écran de B"
  );
  assert.deepEqual(tagFilterOptions(container).filter((o) => o === SECRET_A), []);
  assert.deepEqual(tagFilterOptions(container).filter((o) => o === PUBLIC_B), [PUBLIC_B], "B reste l'autorité");

  // 7. et le canal le plus exposé -- les SUGGESTIONS -- est propre.
  await openFirstProductEditor(container);
  assert.deepEqual(suggestionValues(container), [PUBLIC_B], "les suggestions ne doivent contenir que les tags de B");
});

// ==================================================================
// B. Requêtes CONCURRENTES sur le MÊME restaurant
// ==================================================================

test("[RACE-B] deux requêtes de tags du MÊME restaurant : la plus ANCIENNE, résolue en dernier, n'écrase pas la plus récente", async () => {
  const container = render(GuardedPage);
  await loadA(container);

  // requête #1 (via archives) : catalogue résolu, tags EN ATTENTE
  click(qa(container, "button").find((b) => /archives/i.test(b.textContent ?? "")) ?? null);
  await waitPending("catalogue", A);
  await settle("catalogue", A, CATALOGUE_A);
  await waitPending("productTags", A);
  const older = { pt: open("productTags", A)[0], kt: open("knownTags", A)[0] };

  // requête #2 (retour au catalogue courant) : plus récente
  click(qa(container, "button").find((b) => /archives|carte/i.test(b.textContent ?? "")) ?? null);
  await waitPending("catalogue", A);
  await settle("catalogue", A, CATALOGUE_A);
  await waitPending("productTags", A, 2);

  // #2 se résout D'ABORD : elle fait autorité.
  await settleNewest("productTags", A, PRODUCT_TAGS_A);
  await settleNewest("knownTags", A, KNOWN_TAGS_A);
  await waitFor(() => tagFilterOptions(container).includes(SECRET_A));

  // #1 se résout ENSUITE, avec un contenu DIFFÉRENT.
  older.pt!.settled = true;
  older.pt!.resolve(PRODUCT_TAGS_A_OLD);
  older.kt!.settled = true;
  older.kt!.resolve(KNOWN_TAGS_A_OLD);
  await flush(80);

  assert.equal(
    (container.textContent ?? "").includes(OLD_GEN_A),
    false,
    "une réponse plus ANCIENNE du même restaurant a écrasé l'état autoritatif"
  );
  assert.deepEqual(tagFilterOptions(container).filter((o) => o === SECRET_A), [SECRET_A]);
});

// ==================================================================
// C. A -> B -> A : la génération, pas seulement l'identifiant
// ==================================================================

test("[RACE-C] A -> B -> A : une réponse d'une génération A antérieure ne peut pas écraser l'état A courant (l'identifiant seul ne suffirait pas)", async () => {
  const container = render(GuardedPage);
  await loadA(container);

  // Une requête A part et reste en vol.
  click(qa(container, "button").find((b) => /archives/i.test(b.textContent ?? "")) ?? null);
  await waitPending("catalogue", A);
  await settle("catalogue", A, CATALOGUE_A);
  await waitPending("productTags", A);
  const ancien = { pt: open("productTags", A)[0], kt: open("knownTags", A)[0] };

  // A -> B
  switchTo(container, B);
  await waitPending("catalogue", B);
  await settle("catalogue", B, CATALOGUE_B);
  await waitPending("productTags", B);
  await settle("productTags", B, PRODUCT_TAGS_B);
  await settle("knownTags", B, KNOWN_TAGS_B);

  // B -> A (nouvelle génération de A)
  switchTo(container, A);
  await waitPending("catalogue", A);
  await settle("catalogue", A, CATALOGUE_A);
  await waitPending("productTags", A);
  await settleNewest("productTags", A, PRODUCT_TAGS_A);
  await settleNewest("knownTags", A, KNOWN_TAGS_A);
  await waitFor(() => tagFilterOptions(container).includes(SECRET_A));

  // La réponse de la PREMIÈRE génération A arrive enfin. Elle porte le
  // BON identifiant de restaurant : seule la génération la disqualifie.
  ancien.pt!.settled = true;
  ancien.pt!.resolve(PRODUCT_TAGS_A_OLD);
  ancien.kt!.settled = true;
  ancien.kt!.resolve(KNOWN_TAGS_A_OLD);
  await flush(80);

  assert.equal(
    (container.textContent ?? "").includes(OLD_GEN_A),
    false,
    "une génération antérieure du MÊME restaurant a écrasé l'état courant"
  );
  assert.deepEqual(tagFilterOptions(container).filter((o) => o === SECRET_A), [SECRET_A]);
});

// ==================================================================
// D. Invalidation IMMÉDIATE au changement de restaurant
// ==================================================================

test("[RACE-D] la bascule vide IMMÉDIATEMENT les métadonnées de tags du tenant précédent, sans attendre la réponse du nouveau", async () => {
  const container = render(GuardedPage);
  await loadA(container);
  assert.ok(tagFilterOptions(container).includes(SECRET_A), "précondition : les tags de A sont affichés");

  switchTo(container, B);
  await flush();

  // Le catalogue de B n'est même pas encore arrivé.
  assert.ok(open("catalogue", B).length >= 1, "le chargement de B doit être en cours");
  assert.equal(
    (container.textContent ?? "").includes(SECRET_A),
    false,
    "les métadonnées de A restent affichées pendant le chargement de B"
  );
  assert.deepEqual(tagFilterOptions(container).filter((o) => o === SECRET_A), []);
});

// ==================================================================
// E. Éditeur produit et suggestions
// ==================================================================

test("[RACE-E] un éditeur produit ouvert sur A se ferme à la bascule, et un produit de B ne propose JAMAIS une suggestion de A", async () => {
  const container = render(GuardedPage);
  await loadA(container);

  await openFirstProductEditor(container);
  assert.ok(q(container, "#product-name"), "précondition : l'éditeur de A est ouvert");
  assert.deepEqual(suggestionValues(container), [SECRET_A]);

  switchTo(container, B);
  await flush();
  assert.equal(q(container, "#product-name"), null, "l'éditeur lié au produit de A doit être refermé");
  assert.equal(q(container, '[data-testid="product-tag-remove"]'), null, "aucune association de A ne reste actionnable");

  await settle("catalogue", B, CATALOGUE_B);
  await waitPending("productTags", B);
  await settle("productTags", B, PRODUCT_TAGS_B);
  await settle("knownTags", B, KNOWN_TAGS_B);
  await waitFor(() => (container.textContent ?? "").includes("Produit B"));

  await openFirstProductEditor(container);
  assert.deepEqual(suggestionValues(container), [PUBLIC_B], "seules les suggestions de B sont proposées");
  assert.equal((container.textContent ?? "").includes(SECRET_A), false);
});

// ==================================================================
// F. Les mutations visent le contexte COURANT
// ==================================================================

test("[RACE-F] après bascule, ajout et retrait de tag visent le produit et l'établissement COURANTS uniquement", async () => {
  const container = render(GuardedPage);
  await loadA(container);
  switchTo(container, B);
  await settle("catalogue", B, CATALOGUE_B);
  await waitPending("productTags", B);
  await settle("productTags", B, PRODUCT_TAGS_B);
  await settle("knownTags", B, KNOWN_TAGS_B);
  await waitFor(() => (container.textContent ?? "").includes("Produit B"));

  await openFirstProductEditor(container);
  (globalThis as any).__mutations = [];

  setValue(q(container, '[data-testid="product-tag-input"]')!, " Nouveau B ", window.HTMLInputElement);
  await flush();
  click(q(container, '[data-testid="product-tag-add"]'));
  await flush(60);

  // L'ajout déclenche un rechargement des tags : on le résout (avec les
  // données de B) pour que l'éditeur ne soit plus occupé -- sans cela le
  // bouton de retrait resterait légitimement désactivé.
  await waitPending("productTags", B);
  await settleNewest("productTags", B, PRODUCT_TAGS_B);
  await settleNewest("knownTags", B, KNOWN_TAGS_B);
  await waitFor(() => {
    const btn = q(container, '[data-testid="product-tag-remove"]') as HTMLButtonElement | null;
    return !!btn && !btn.disabled;
  });

  click(q(container, '[data-testid="product-tag-remove"]'));
  await flush(60);

  const muts = (globalThis as any).__mutations as Array<{ fn: string; args: unknown[] }>;
  const add = muts.find((m) => m.fn === "addProductTags");
  const rm = muts.find((m) => m.fn === "removeProductTag");
  assert.ok(add, "addProductTags doit être appelée");
  assert.deepEqual(add!.args, ["pb1", ["Nouveau B"]], "l'ajout vise le produit de B");
  assert.ok(rm, "removeProductTag doit être appelée");
  assert.deepEqual(rm!.args, ["pb1", "tb1"], "le retrait vise l'association de B");

  const serialized = JSON.stringify(muts);
  assert.equal(serialized.includes("pa1"), false, "aucune mutation ne vise un produit de A");
  assert.equal(serialized.includes("ta1"), false, "aucune mutation ne vise un tag de A");
});

// ==================================================================
// CONTRÔLE NÉGATIF (§10) — sans la garde, la fuite REVIENT.
// ==================================================================

test("[CONTRÔLE NÉGATIF] retirer la garde fait RÉAPPARAÎTRE la fuite -- le test prouve donc la protection, pas seulement le chemin", async () => {
  let removed = 0;
  const strip = (src: string) => {
    const out = src.replace(/\n\s*if \(!isCurrentTagLoad\(gen, id\)\) return;/g, () => {
      removed += 1;
      return "";
    });
    return out;
  };
  const UnguardedPage = await buildPage(strip);
  assert.equal(removed, 2, `la transformation doit retirer exactement les 2 gardes de tags (retiré : ${removed})`);

  const container = render(UnguardedPage);
  await loadA(container);

  click(qa(container, "button").find((b) => /archives/i.test(b.textContent ?? "")) ?? null);
  await waitPending("catalogue", A);
  await settle("catalogue", A, CATALOGUE_A);
  await waitPending("productTags", A);
  const stale = { pt: open("productTags", A)[0], kt: open("knownTags", A)[0] };

  switchTo(container, B);
  await waitPending("catalogue", B);
  await settle("catalogue", B, CATALOGUE_B);
  await waitPending("productTags", B);
  await settle("productTags", B, PRODUCT_TAGS_B);
  await settle("knownTags", B, KNOWN_TAGS_B);
  await waitFor(() => (container.textContent ?? "").includes("Produit B"));

  stale.pt!.settled = true;
  stale.pt!.resolve(PRODUCT_TAGS_A);
  stale.kt!.settled = true;
  stale.kt!.resolve(KNOWN_TAGS_A);
  await flush(80);

  await openFirstProductEditor(container);
  assert.deepEqual(
    suggestionValues(container),
    [SECRET_A],
    "sans la garde, l'écran de B DOIT exposer les suggestions de A -- sinon ce test ne prouve rien"
  );
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "File",
    "Blob",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    delete (globalThis as any)[k];
  }
});
