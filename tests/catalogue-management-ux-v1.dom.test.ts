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
// Scanym — CATALOGUE MANAGEMENT UX v1 — rendu RÉEL de
// app/dashboard/catalogue/page.tsx (esbuild + jsdom).
//
// Seuls les services sont mockés : l'écran, son état et son rendu
// conditionnel sont les vrais. La logique pure de recherche/filtre/tri
// est prouvée séparément par tests/catalogue-management-ux-v1.test.ts.
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

(globalThis as any).__catalogueByRestaurant = {} as Record<string, unknown>;
(globalThis as any).__productTagsByRestaurant = {} as Record<string, unknown>;
(globalThis as any).__restaurantTagsByRestaurant = {} as Record<string, unknown>;
(globalThis as any).__tagCalls = [] as Array<{ fn: string; args: unknown[] }>;

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
export async function getMerchantCatalogue(id, archived) {
  return (globalThis).__catalogueByRestaurant[id] ?? [];
}
export async function getMerchantRestaurants() {
  return [
    { restaurant_id: "${RESTO_A}", name: "Au lait cru", role: "owner" },
    { restaurant_id: "${RESTO_B}", name: "Hotel Royal", role: "owner" },
  ];
}
export async function getRestaurantSettings() {
  return { currency: "EUR", staff_receipt_language: "fr" };
}
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
export async function getRestaurantProductTags(id) {
  (globalThis).__tagCalls.push({ fn: "getRestaurantProductTags", args: [id] });
  return (globalThis).__productTagsByRestaurant[id] ?? [];
}
export async function getRestaurantTags(id) {
  (globalThis).__tagCalls.push({ fn: "getRestaurantTags", args: [id] });
  return (globalThis).__restaurantTagsByRestaurant[id] ?? [];
}
export async function addProductTags(productId, names) {
  (globalThis).__tagCalls.push({ fn: "addProductTags", args: [productId, names] });
  return names.length;
}
export async function removeProductTag(productId, tagId) {
  (globalThis).__tagCalls.push({ fn: "removeProductTag", args: [productId, tagId] });
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
    product_id: "p1",
    category_id: "c1",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Comté",
    name_hash: "h",
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 12.5,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: 5.5,
    unit_weight_grams: 250,
    weight_is_approximate: false,
    reference_price_per_kg: 50,
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

/**
 * Ouvre le formulaire d'édition DU PRODUIT nommé.
 *
 * Le bouton est cherché À L'INTÉRIEUR de la carte produit (`<li>`) qui
 * porte ce nom, jamais par simple ordre d'apparition : l'écran contient
 * aussi des boutons « Modifier » de CATÉGORIE, et viser le premier
 * bouton venu ouvrirait le mauvais formulaire.
 */
async function openProductEditor(container: HTMLElement, productName: string): Promise<void> {
  const card = qa(container, "li").find((li) =>
    (li.textContent ?? "").includes(productName)
  );
  assert.ok(card, `carte produit « ${productName} » introuvable`);
  const btn = qa(card!, "button").find((b) => (b.textContent ?? "").trim() === "Modifier");
  assert.ok(btn, `bouton « Modifier » absent de la carte « ${productName} »`);
  click(btn!);
  await flush();
}

async function renderCatalogue(
  categories: unknown[],
  productTags: unknown[] = [],
  restaurantTags: unknown[] = []
): Promise<HTMLElement> {
  (globalThis as any).__catalogueByRestaurant = { [RESTO_A]: categories };
  (globalThis as any).__productTagsByRestaurant = { [RESTO_A]: productTags };
  (globalThis as any).__restaurantTagsByRestaurant = { [RESTO_A]: restaurantTags };
  (globalThis as any).__tagCalls = [];
  const { container } = render();
  await waitFor(() => !!q(container, '[data-testid="catalogue-toolbar"]'));
  await flush();
  return container;
}

const THREE = [
  cat({
    category_id: "c1",
    category_name: "Fromages",
    products: [
      prod({ product_id: "p1", name: "Comté", price: 12.5, is_available: true }),
      prod({ product_id: "p2", name: "Brie", price: 5, is_available: false }),
    ],
    subcategories: [
      {
        subcategory_id: "s1",
        subcategory_name: "Raclette",
        subcategory_display_order: 1,
        subcategory_is_active: true,
        products: [prod({ product_id: "p3", name: "Raclette bleue", price: 9, subcategory_id: "s1", subcategory_name: "Raclette" })],
      },
    ],
  }),
  cat({ category_id: "c2", category_name: "Vins", products: [prod({ product_id: "p4", name: "Rouge", category_id: "c2", category_name: "Vins", price: 20 })] }),
];

const TAGS_P1 = [{ menuItemId: "p1", tagIds: ["t-bio"], tagNames: ["Bio"] }];
const KNOWN = [{ id: "t-bio", name: "Bio", normalizedKey: "bio", visibleOnCustomerMenu: false, displayOrder: 0, productCount: 1 }];

// ==================================================================
// A. Formulaire produit — libellés explicites
// ==================================================================

test("[A] chaque champ éditable porte un LIBELLÉ PERSISTANT lié par htmlFor -- plus jamais un placeholder seul qui disparaît à la saisie", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  await openProductEditor(container, "Comté");

  for (const id of [
    "product-name",
    "product-short-description",
    "product-description",
    "product-price",
    "product-tax-rate",
    "product-unit-weight",
  ]) {
    const field = q(container, `#${id}`);
    assert.ok(field, `champ #${id} absent`);
    const label = [...container.querySelectorAll("label")].find((l) => l.getAttribute("for") === id);
    assert.ok(label, `aucun <label for="${id}">`);
    assert.ok((label!.textContent ?? "").trim().length > 0, `libellé de #${id} vide`);
  }
});

test("[A] le libellé reste visible ALORS QUE le champ porte une valeur -- c'est précisément le défaut signalé (« 5.4 / Raclette / 5.5 / 200 »)", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  await openProductEditor(container, "Comté");

  const price = q(container, "#product-price") as HTMLInputElement;
  const tax = q(container, "#product-tax-rate") as HTMLInputElement;
  const weight = q(container, "#product-unit-weight") as HTMLInputElement;

  // Les valeurs existantes sont bien mappées...
  assert.equal(price.value, "12.5");
  assert.equal(tax.value, "5.5");
  assert.equal(weight.value, "250");

  // ...et chacune reste accompagnée de son libellé, donc le prix ne
  // peut plus être confondu avec la TVA ni avec le poids.
  const labelOf = (id: string) =>
    ([...container.querySelectorAll("label")].find((l) => l.getAttribute("for") === id)?.textContent ?? "").trim();
  const [lp, lt, lw] = [labelOf("product-price"), labelOf("product-tax-rate"), labelOf("product-unit-weight")];
  assert.equal(new Set([lp, lt, lw]).size, 3, "les trois libellés doivent être distincts");
  assert.ok(/tva|vat/i.test(lt), `le libellé TVA doit nommer la TVA : « ${lt} »`);
  assert.ok(/poids|weight/i.test(lw), `le libellé poids doit nommer le poids : « ${lw} »`);
});

test("[A] le prix de référence €/kg porte toujours son libellé, même sans valeur calculable", async () => {
  const container = await renderCatalogue(
    [cat({ products: [prod({ unit_weight_grams: null, reference_price_per_kg: null })] })],
    [],
    []
  );
  await openProductEditor(container, "Comté");
  const ref = q(container, '[data-testid="reference-price-per-kg"]');
  assert.ok(ref, "la ligne du prix de référence doit exister même sans poids");
  assert.ok((ref!.textContent ?? "").trim().length > 1);
});

// ==================================================================
// B. Tags
// ==================================================================

test("[B] les tags courants du produit sont affichés ; un produit sans tag affiche un état vide explicite", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  await openProductEditor(container, "Comté");
  assert.deepEqual(
    qa(container, '[data-testid="product-tag-name"]').map((e) => e.textContent),
    ["Bio"]
  );

  // Second produit : aucun tag.
  click(qa(container, "button").find((b) => /Annuler/i.test(b.textContent ?? "")) ?? null);
  await flush();
  await openProductEditor(container, "Brie");
  assert.ok(q(container, '[data-testid="product-tags-empty"]'), "état vide attendu");
});

test("[B] ajouter un tag appelle addProductTags avec le produit et le nom saisis, puis recharge les tags", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  await openProductEditor(container, "Comté");

  setValue(q(container, '[data-testid="product-tag-input"]')!, "  AOP  ", window.HTMLInputElement);
  await flush();
  (globalThis as any).__tagCalls = [];
  click(q(container, '[data-testid="product-tag-add"]'));
  await flush(120);

  const calls = (globalThis as any).__tagCalls as Array<{ fn: string; args: unknown[] }>;
  const add = calls.find((c) => c.fn === "addProductTags");
  assert.ok(add, "addProductTags doit être appelée");
  assert.deepEqual(add!.args, ["p1", ["AOP"]], "nom nettoyé, produit correct");
  assert.ok(calls.some((c) => c.fn === "getRestaurantProductTags"), "les tags doivent être rechargés après l'ajout");
});

test("[B] retirer une association appelle removeProductTag avec le bon tag, et ne supprime jamais le tag du tenant", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  await openProductEditor(container, "Comté");

  (globalThis as any).__tagCalls = [];
  click(q(container, '[data-testid="product-tag-remove"]'));
  await flush(120);

  const calls = (globalThis as any).__tagCalls as Array<{ fn: string; args: unknown[] }>;
  const rm = calls.find((c) => c.fn === "removeProductTag");
  assert.ok(rm, "removeProductTag doit être appelée");
  assert.deepEqual(rm!.args, ["p1", "t-bio"]);
  // L'écran n'expose AUCUNE action de suppression d'entité tag.
  assert.equal(
    calls.some((c) => /deleteTag|removeTag\b/.test(c.fn)),
    false,
    "aucune suppression de l'entité tag ne doit exister"
  );
});

test("[B] le bouton d'ajout reste inactif tant qu'aucun nom n'est saisi -- aucun appel réseau inutile", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  await openProductEditor(container, "Comté");
  const add = q(container, '[data-testid="product-tag-add"]') as HTMLButtonElement;
  assert.equal(add.disabled, true, "désactivé à vide");
  setValue(q(container, '[data-testid="product-tag-input"]')!, "   ", window.HTMLInputElement);
  await flush();
  assert.equal((q(container, '[data-testid="product-tag-add"]') as HTMLButtonElement).disabled, true, "désactivé sur des espaces");
});

test("[B/ISOLATION] les tags sont chargés pour le restaurant COURANT uniquement", async () => {
  await renderCatalogue(THREE, TAGS_P1, KNOWN);
  const calls = (globalThis as any).__tagCalls as Array<{ fn: string; args: unknown[] }>;
  const reads = calls.filter((c) => c.fn === "getRestaurantProductTags" || c.fn === "getRestaurantTags");
  assert.ok(reads.length >= 2, "les deux lectures de tags doivent avoir lieu");
  for (const r of reads) {
    assert.equal(r.args[0], RESTO_A, "aucune lecture de tags pour un autre établissement");
  }
});

// ==================================================================
// C / D / E. Recherche, filtres, tri, compteur, reset
// ==================================================================

function visibleProductNames(container: HTMLElement): string[] {
  return qa(container, "li")
    .map((li) => li.textContent ?? "")
    .filter((txt) => /Comté|Brie|Raclette bleue|Rouge/.test(txt))
    .map((txt) => (txt.match(/Comté|Brie|Raclette bleue|Rouge/) ?? [""])[0]);
}

test("[C] la recherche restreint la liste rendue et met à jour le compteur de résultats", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  assert.ok((q(container, '[data-testid="catalogue-result-count"]')!.textContent ?? "").includes("4"), "4 produits au départ");

  setValue(q(container, '[data-testid="catalogue-search"]')!, "comt", window.HTMLInputElement);
  await flush();
  const count = q(container, '[data-testid="catalogue-result-count"]')!.textContent ?? "";
  assert.ok(count.includes("1") && count.includes("4"), `compteur « n sur N » attendu : ${count}`);
  assert.deepEqual(visibleProductNames(container), ["Comté"]);
});

test("[C] une recherche sans correspondance affiche un état VIDE explicite, jamais une liste silencieusement vide", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  setValue(q(container, '[data-testid="catalogue-search"]')!, "zzzz", window.HTMLInputElement);
  await flush();
  assert.ok(q(container, '[data-testid="catalogue-no-result"]'), "message « aucun résultat » attendu");
  assert.deepEqual(visibleProductNames(container), []);
});

test("[D] filtrer par disponibilité ne garde que les produits correspondants", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  setValue(q(container, '[data-testid="filter-availability"]')!, "no", window.HTMLSelectElement);
  await flush();
  assert.deepEqual(visibleProductNames(container), ["Brie"]);
});

test("[D] filtrer par catégorie masque les autres catégories entièrement", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  setValue(q(container, '[data-testid="filter-category"]')!, "c2", window.HTMLSelectElement);
  await flush();
  assert.deepEqual(visibleProductNames(container), ["Rouge"]);
  assert.equal((container.textContent ?? "").includes("Comté"), false, "la catégorie Fromages ne doit plus être rendue");
});

test("[D] filtrer par tag ne garde que les produits portant ce tag", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  setValue(q(container, '[data-testid="filter-tag"]')!, "t-bio", window.HTMLSelectElement);
  await flush();
  assert.deepEqual(visibleProductNames(container), ["Comté"]);
});

test("[D] RÉINITIALISER restaure la recherche, les filtres et le tri par défaut, sans rechargement de page", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  setValue(q(container, '[data-testid="catalogue-search"]')!, "comt", window.HTMLInputElement);
  await flush();
  setValue(q(container, '[data-testid="filter-availability"]')!, "yes", window.HTMLSelectElement);
  await flush();
  setValue(q(container, '[data-testid="catalogue-sort"]')!, "price-desc", window.HTMLSelectElement);
  await flush();

  const reset = q(container, '[data-testid="catalogue-reset-filters"]');
  assert.ok(reset, "le bouton de réinitialisation doit apparaître dès qu'un filtre est actif");
  click(reset);
  await flush();

  assert.equal((q(container, '[data-testid="catalogue-search"]') as HTMLInputElement).value, "");
  assert.equal((q(container, '[data-testid="filter-availability"]') as HTMLSelectElement).value, "");
  assert.equal((q(container, '[data-testid="catalogue-sort"]') as HTMLSelectElement).value, "name-asc");
  assert.equal(visibleProductNames(container).length, 4, "tout le catalogue est de nouveau rendu");
  assert.equal(q(container, '[data-testid="catalogue-reset-filters"]'), null, "le bouton disparaît une fois l'état par défaut restauré");
});

test("[E] changer le tri réordonne la liste rendue", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  // Le rendu reste groupé par catégorie ; on vérifie l'ordre AU SEIN
  // de la catégorie Fromages, où les prix diffèrent (12,5 / 5).
  setValue(q(container, '[data-testid="catalogue-sort"]')!, "price-asc", window.HTMLSelectElement);
  await flush();
  const asc = visibleProductNames(container);
  setValue(q(container, '[data-testid="catalogue-sort"]')!, "price-desc", window.HTMLSelectElement);
  await flush();
  const desc = visibleProductNames(container);
  assert.notDeepEqual(asc, desc, "le tri doit changer l'ordre rendu");
  assert.deepEqual([...asc].sort(), [...desc].sort(), "les mêmes produits, seulement réordonnés");
});

// ==================================================================
// F. Export
// ==================================================================

test("[F] les deux exports sont proposés distinctement et annoncent leur volume respectif", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);
  setValue(q(container, '[data-testid="catalogue-search"]')!, "comt", window.HTMLInputElement);
  await flush();

  const all = q(container, '[data-testid="catalogue-export-all"]')!.textContent ?? "";
  const filtered = q(container, '[data-testid="catalogue-export-filtered"]')!.textContent ?? "";
  assert.ok(all.includes("(4)"), `export complet doit annoncer 4 : ${all}`);
  assert.ok(filtered.includes("(1)"), `export filtré doit annoncer 1 : ${filtered}`);
  assert.notEqual(all, filtered, "les deux libellés doivent être distincts");
});

test("[F] l'export produit un classeur .xlsx dont le nom distingue catalogue complet et résultats filtrés", async () => {
  const container = await renderCatalogue(THREE, TAGS_P1, KNOWN);

  const names: string[] = [];
  const types: string[] = [];
  const realCreateEl = window.document.createElement.bind(window.document);
  (window.URL as any).createObjectURL = (b: any) => {
    types.push(b?.type ?? "");
    return "blob:mock";
  };
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

    assert.equal(names.length, 2);
    assert.ok(/^catalogue-complet-\d{4}-\d{2}-\d{2}\.xlsx$/.test(names[0]), `nom inattendu : ${names[0]}`);
    assert.ok(/^catalogue-resultats-\d{4}-\d{2}-\d{2}\.xlsx$/.test(names[1]), `nom inattendu : ${names[1]}`);
    for (const ty of types) {
      assert.ok(ty.includes("spreadsheetml.sheet"), `type MIME xlsx attendu : ${ty}`);
    }
  } finally {
    (window.document as any).createElement = realCreateEl;
  }
});

// ==================================================================
// G. Volume
// ==================================================================

test("[G] 312 produits : la barre s'affiche, le compteur annonce le total, et un filtre réduit réellement le rendu", async () => {
  const products = [];
  for (let i = 1; i <= 312; i++) {
    products.push(
      prod({
        product_id: `p${i}`,
        name: `Produit ${String(i).padStart(3, "0")}`,
        price: 1 + (i % 50),
        is_available: i % 10 !== 0,
      })
    );
  }
  const container = await renderCatalogue([cat({ products })], [], []);
  const count = q(container, '[data-testid="catalogue-result-count"]')!.textContent ?? "";
  assert.ok(count.includes("312"), `le total doit apparaître : ${count}`);

  setValue(q(container, '[data-testid="catalogue-search"]')!, "Produit 007", window.HTMLInputElement);
  await flush(120);
  const after = q(container, '[data-testid="catalogue-result-count"]')!.textContent ?? "";
  assert.ok(after.includes("1") && after.includes("312"), `compteur « 1 sur 312 » attendu : ${after}`);
});

after(async () => {
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
