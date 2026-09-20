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
// Scanym — P1 CUSTOMER COLLECTIONS BY TAGS — réglage marchand, rendu
// RÉEL de app/dashboard/catalogue/page.tsx (même harnais que
// tests/catalogue-management-ux-v1_1-tag-context-race.dom.test.ts).
//
// Couvre : §9 bascule de visibilité + ordre via la RPC existante
// (updateTagCollectionSettings) puis rechargement SERVEUR ; échec
// annoncé (role=alert), jamais présenté comme un succès ; ordre non
// entier refusé sans appel ; §10 une réponse tardive du restaurant A
// n'agit jamais sur l'écran de B (ni rechargement, ni message), et les
// écritures faites depuis B ne visent que les tags de B ; §12 contrôles
// explicitement étiquetés.
//
// Les écritures sont des promesses DIFFÉRÉES résolues par le test :
// l'ordre d'arrivée est déterministe.
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

const A = "resto-a";
const B = "resto-b";

interface PendingWrite {
  args: [string, boolean, number | undefined];
  resolve: () => void;
  reject: (e: unknown) => void;
  settled: boolean;
}
const G = globalThis as any;
function resetState() {
  G.__writes = [] as PendingWrite[];
  G.__tagCalls = [] as Array<{ fn: string; id: string }>;
  G.__knownTags = {
    [A]: [
      { id: "ta-bio", name: "Bio A", normalizedKey: "bio a", visibleOnCustomerMenu: true, displayOrder: 1, productCount: 2 },
      { id: "ta-int", name: "Interne A", normalizedKey: "interne a", visibleOnCustomerMenu: false, displayOrder: 0, productCount: 1 },
    ],
    [B]: [
      { id: "tb-apero", name: "Apéro B", normalizedKey: "apero b", visibleOnCustomerMenu: false, displayOrder: 0, productCount: 1 },
    ],
  };
}
resetState();

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
const MOCK_DASHBOARD = `
function product(id, cat, name) {
  return {
    product_id: id, category_id: cat, category_name: "Cat", category_translations: null,
    subcategory_id: null, subcategory_name: null, name, name_hash: "h",
    short_description: null, short_description_hash: null, description: null, description_hash: null,
    translations: null, price: 10, is_available: true, archived_at: null, display_order: 1,
    is_option_source: false, image_url: null, tax_rate: 5.5, unit_weight_grams: null,
    weight_is_approximate: false, reference_price_per_kg: null,
  };
}
function category(id, name, products) {
  return {
    category_id: id, category_name: name, category_name_hash: "h", category_translations: null,
    category_display_order: 1, category_is_option_source: false, category_description: null,
    category_description_hash: null, category_is_active: true, products, subcategories: [],
  };
}
export async function getMerchantCatalogue(id) {
  return id === "${A}"
    ? [category("ca", "Fromages A", [product("pa1", "ca", "Produit A")])]
    : [category("cb", "Vins B", [product("pb1", "cb", "Produit B")])];
}
export async function getMerchantRestaurants() {
  return [
    { restaurant_id: "${A}", role: "owner", restaurants: { id: "${A}", name: "Au lait cru", slug: "a" } },
    { restaurant_id: "${B}", role: "manager", restaurants: { id: "${B}", name: "Hotel Royal", slug: "b" } },
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
export async function getRestaurantProductTags(id) {
  (globalThis).__tagCalls.push({ fn: "getRestaurantProductTags", id });
  return [];
}
export async function getRestaurantTags(id) {
  (globalThis).__tagCalls.push({ fn: "getRestaurantTags", id });
  return ((globalThis).__knownTags[id] ?? []).map((t) => ({ ...t }));
}
export async function addProductTags() { return 0; }
export async function removeProductTag() { return 0; }
export function updateTagCollectionSettings(tagId, visible, order) {
  return new Promise((resolve, reject) => {
    (globalThis).__writes.push({ args: [tagId, visible, order], resolve, reject, settled: false });
  });
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
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "ts" }));
  },
};

const built = await esbuild.build({
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-collections-"));
const tmpFile = path.join(tmpDir, "CataloguePage.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { CataloguePage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --------------------------------------------------------------------
// Outils DOM
// --------------------------------------------------------------------
function q(c: ParentNode, sel: string) {
  return c.querySelector(sel) as HTMLElement | null;
}
function qa(c: ParentNode, sel: string) {
  return [...c.querySelectorAll(sel)] as HTMLElement[];
}
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
function setValue(el: HTMLElement, value: string, proto: any) {
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event(proto === window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function panel(c: HTMLElement) {
  return q(c, '[data-testid="customer-collections-settings"]');
}
function row(c: HTMLElement, name: string): HTMLElement {
  const r = qa(c, '[data-testid="customer-collection-row"]').find(
    (li) => (q(li, '[data-testid="customer-collection-name"]')?.textContent ?? "") === name
  );
  assert.ok(r, `ligne de collection '${name}' attendue`);
  return r!;
}
function rowNames(c: HTMLElement): string[] {
  return qa(c, '[data-testid="customer-collection-name"]').map((e) => e.textContent ?? "");
}
function stateOf(c: HTMLElement, name: string): string {
  return q(row(c, name), '[data-testid="customer-collection-state"]')?.textContent ?? "";
}
function checkbox(c: HTMLElement, name: string) {
  return q(row(c, name), '[data-testid="customer-collection-visible"]') as HTMLInputElement;
}
function orderInput(c: HTMLElement, name: string) {
  return q(row(c, name), '[data-testid="customer-collection-order"]') as HTMLInputElement;
}
function saveButton(c: HTMLElement, name: string) {
  return q(row(c, name), '[data-testid="customer-collection-save"]') as HTMLButtonElement;
}
function tagReloads(id: string): number {
  return (G.__tagCalls as Array<{ fn: string; id: string }>).filter((x) => x.fn === "getRestaurantTags" && x.id === id).length;
}
function writes(): PendingWrite[] {
  return G.__writes as PendingWrite[];
}
function switchTo(c: HTMLElement, id: string) {
  const select = q(c, "header select");
  assert.ok(select, "sélecteur d'établissement introuvable");
  setValue(select!, id, window.HTMLSelectElement);
}

async function renderA() {
  resetState();
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CataloguePage));
  const ok = await waitFor(() => !!panel(container) && rowNames(container).length === 2);
  assert.ok(ok, "le réglage des collections de A doit apparaître");
  return { container, root };
}
function cleanup(x: { container: HTMLElement; root: any }) {
  x.root.unmount();
  x.container.remove();
}

// ====================================================================

test("[A11Y][STATE] une ligne par tag actif du restaurant courant : état public/interne, ordre, contrôles explicitement étiquetés", async () => {
  const x = await renderA();
  const c = x.container;
  assert.deepEqual(rowNames(c), ["Bio A", "Interne A"]);
  assert.equal(stateOf(c, "Bio A"), "Publique");
  assert.equal(stateOf(c, "Interne A"), "Interne");
  assert.equal(checkbox(c, "Bio A").checked, true);
  assert.equal(checkbox(c, "Interne A").checked, false);
  assert.equal(orderInput(c, "Bio A").value, "1");
  assert.equal(orderInput(c, "Interne A").value, "0");

  for (const name of ["Bio A", "Interne A"]) {
    const cb = checkbox(c, name);
    const cbLabel = q(c, `label[for="${cb.id}"]`);
    assert.equal(cbLabel?.textContent, `Afficher comme collection client : ${name}`);
    const oi = orderInput(c, name);
    const oiLabel = q(c, `label[for="${oi.id}"]`);
    assert.equal(oiLabel?.textContent, `Ordre d'affichage : ${name}`);
    assert.equal(saveButton(c, name).getAttribute("aria-label"), `Enregistrer la collection ${name}`);
    assert.equal(saveButton(c, name).tagName, "BUTTON");
    assert.equal(saveButton(c, name).disabled, true, "rien à enregistrer tant que rien n'a changé");
  }
  const heading = q(c, "#customer-collections-title");
  assert.equal(heading?.textContent, "Collections client");
  assert.equal(panel(c)!.getAttribute("aria-labelledby"), "customer-collections-title");
  cleanup(x);
});

test("[RPC + REFRESH] publier un tag et fixer son ordre appelle update_tag_collection_settings puis recharge depuis le serveur", async () => {
  const x = await renderA();
  const c = x.container;
  const reloadsBefore = tagReloads(A);

  checkbox(c, "Interne A").click();
  setValue(orderInput(c, "Interne A"), "5", window.HTMLInputElement);
  await flush();
  assert.equal(saveButton(c, "Interne A").disabled, false);
  saveButton(c, "Interne A").click();
  await flush();

  assert.equal(writes().length, 1);
  assert.deepEqual(writes()[0].args, ["ta-int", true, 5], "écriture via le contrat existant, tag du restaurant courant");
  assert.equal(stateOf(c, "Interne A"), "Interne", "aucun succès présenté avant la réponse serveur");

  // Le serveur applique l'écriture ; le rechargement la reflète.
  G.__knownTags[A][1] = { ...G.__knownTags[A][1], visibleOnCustomerMenu: true, displayOrder: 5 };
  writes()[0].settled = true;
  writes()[0].resolve();
  const ok = await waitFor(() => stateOf(c, "Interne A") === "Publique");
  assert.ok(ok, "l'état affiché provient du rechargement serveur");
  assert.ok(tagReloads(A) > reloadsBefore, "rechargement serveur après succès");
  assert.equal(orderInput(c, "Interne A").value, "5");
  assert.equal(checkbox(c, "Interne A").checked, true);
  assert.equal(q(c, '[data-testid="customer-collection-error"]'), null);

  // Dépublier : même contrat.
  checkbox(c, "Bio A").click();
  await flush();
  saveButton(c, "Bio A").click();
  await flush();
  assert.deepEqual(writes()[1].args, ["ta-bio", false, 1]);
  cleanup(x);
});

test("[FAILURE] un refus serveur est annoncé (role=alert) et rien n'est présenté comme enregistré ni rechargé", async () => {
  const x = await renderA();
  const c = x.container;
  checkbox(c, "Interne A").click();
  await flush();
  saveButton(c, "Interne A").click();
  await flush();
  const reloadsBefore = tagReloads(A);
  writes()[0].settled = true;
  writes()[0].reject(new Error("Forbidden: not a restaurant admin"));
  const ok = await waitFor(() => !!q(c, '[data-testid="customer-collection-error"]'));
  assert.ok(ok, "message d'erreur attendu");
  const alert = q(c, '[data-testid="customer-collection-error"]')!;
  assert.equal(alert.getAttribute("role"), "alert");
  assert.ok((alert.textContent ?? "").includes("Forbidden: not a restaurant admin"));
  assert.equal(stateOf(c, "Interne A"), "Interne", "l'état serveur reste affiché");
  assert.equal(tagReloads(A), reloadsBefore, "aucun rechargement sur échec");
  assert.equal(checkbox(c, "Interne A").getAttribute("aria-describedby"), alert.id, "erreur reliée au contrôle");
  cleanup(x);
});

test("[VALIDATION] un ordre non entier est refusé localement, sans aucun appel", async () => {
  const x = await renderA();
  const c = x.container;
  setValue(orderInput(c, "Bio A"), "1.5", window.HTMLInputElement);
  await flush();
  saveButton(c, "Bio A").click();
  await flush();
  assert.equal(writes().length, 0);
  const alert = q(c, '[data-testid="customer-collection-error"]');
  assert.ok(alert, "message attendu");
  assert.equal(alert!.getAttribute("role"), "alert");
  assert.equal(alert!.textContent, "L'ordre d'affichage doit être un nombre entier.");
  cleanup(x);
});

test("[A/B CONTEXT] une écriture de A qui répond APRÈS la bascule vers B ne recharge rien, n'affiche rien sur B ; B n'écrit que ses propres tags", async () => {
  const x = await renderA();
  const c = x.container;

  // Écriture A en vol (succès) + écriture A en vol (échec).
  checkbox(c, "Interne A").click();
  await flush();
  saveButton(c, "Interne A").click();
  checkbox(c, "Bio A").click();
  await flush();
  saveButton(c, "Bio A").click();
  await flush();
  assert.equal(writes().length, 2);

  switchTo(c, B);
  const okB = await waitFor(() => rowNames(c).join("|") === "Apéro B");
  assert.ok(okB, "le réglage de B doit afficher uniquement les tags de B");
  const reloadsA = tagReloads(A);

  writes()[0].settled = true;
  writes()[0].resolve();
  writes()[1].settled = true;
  writes()[1].reject(new Error("late failure from A"));
  await flush(80);

  assert.equal(tagReloads(A), reloadsA, "aucun rechargement de A déclenché depuis l'écran de B");
  assert.deepEqual(rowNames(c), ["Apéro B"]);
  assert.equal(q(c, '[data-testid="customer-collection-error"]'), null, "aucun message de A sur l'écran de B");
  const text = c.textContent ?? "";
  assert.equal(text.includes("Bio A") || text.includes("Interne A") || text.includes("late failure"), false);

  // Les écritures depuis B ne visent que B.
  checkbox(c, "Apéro B").click();
  setValue(orderInput(c, "Apéro B"), "2", window.HTMLInputElement);
  await flush();
  saveButton(c, "Apéro B").click();
  await flush();
  assert.equal(writes().length, 3);
  assert.deepEqual(writes()[2].args, ["tb-apero", true, 2]);
  const bWrites = JSON.stringify(writes().slice(2).map((w) => w.args));
  assert.equal(bWrites.includes("ta-"), false, "aucune écriture de B ne vise un tag de A");
  cleanup(x);
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
