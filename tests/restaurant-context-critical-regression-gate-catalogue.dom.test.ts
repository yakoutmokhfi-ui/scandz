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
// Restaurant Context Critical Regression Gate — CATALOGUE module
// (app/dashboard/catalogue/page.tsx).
//
// Same invariant, same technique as the Orders and Legal/CGV suites
// in this same gate (real component, esbuild + jsdom, driven through
// the real DashboardNav restaurant <select>, same-instance, no
// unmount).
//
// UNLIKE Orders, this module's `reload(id, archived)` (source read
// before writing this test) has NO generation/restaurant guard at all
// around `setCategories(await getMerchantCatalogue(id, archived))` --
// a plain unconditional setState after an unguarded await. This suite
// is therefore EXPECTED to demonstrate a live regression, not a false
// alarm: it must fail red today and turn green only once Claude
// Monet's functional fix lands. No functional fix is included here.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/catalogue?r=resto-a",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).File = window.File;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function category(id: string, name: string) {
  return {
    category_id: id,
    category_name: name,
    category_name_hash: id,
    category_translations: null,
    category_display_order: 0,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [],
    subcategories: [],
  };
}

(globalThis as any).__mappings = [
  { restaurant_id: "resto-a", role: "owner", restaurants: { id: "resto-a", name: "Restaurant A", slug: "a" } },
  { restaurant_id: "resto-b", role: "owner", restaurants: { id: "resto-b", name: "Restaurant B", slug: "b" } },
];
(globalThis as any).__catalogueDeferred = new Map<string, Deferred<unknown[]>>();
(globalThis as any).__catalogueCallLog = [] as string[];

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/catalogue"; }
`;

const MOCK_AUTH = `
export async function getUser() { return { id: "staff-1" }; }
export async function signOut() {}
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return false; }
export async function getEstablishmentSummary(id) { return { name: "Op " + id }; }
`;

const MOCK_PRODUCT_PHOTO = `
export class InvalidFileTypeError extends Error {}
export class FileTooLargeError extends Error {}
export class PhotoUploadError extends Error {}
export class PhotoRemoveError extends Error {}
export async function addOrReplaceProductPhoto() {}
export async function removeProductPhoto() {}
export async function retryOldPhotoCleanup() {}
export function validateProductPhotoFile() { return null; }
`;

const MOCK_PHOTO_PLACEHOLDER = `
import React from "react";
export default function ProductPhotoPlaceholder() { return null; }
`;

const MOCK_BULK_PHOTO_UPLOAD = `
import React from "react";
export default function BulkPhotoUpload() { return null; }
`;

const MOCK_DASHBOARD = `
export class CategoryDuplicateNameError extends Error {}
export class CategoryDescriptionTooLongError extends Error {}
export class DescriptionTooLongError extends Error {}
export class ShortDescriptionTooLongError extends Error {}
export class SubcategoryDuplicateNameError extends Error {}
export class SubcategoryCategoryMismatchError extends Error {}
export async function archiveProduct() {}
export async function restoreProduct() {}
export async function setProductAvailability() {}
export async function setProductOrder() {}
export async function updateCategory() {}
export async function updateProduct() {}
export async function createCategory() {}
export async function createProduct() {}
export async function createSubcategory() {}
export async function updateSubcategory() {}
export async function getMerchantRestaurants() { return (globalThis).__mappings; }
export async function getRestaurantSettings() { return { staff_receipt_language: "fr" }; }
export async function getMerchantCatalogue(restaurantId, archived) {
  (globalThis).__catalogueCallLog.push(restaurantId);
  const deferred = (globalThis).__catalogueDeferred.get(restaurantId);
  if (deferred) return deferred.promise;
  const fallback = (globalThis).__catalogueFallback?.[restaurantId];
  return fallback ?? [];
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/product-photo": MOCK_PRODUCT_PHOTO,
  "@/components/ProductPhotoPlaceholder": MOCK_PHOTO_PLACEHOLDER,
  "@/components/dashboard/BulkPhotoUpload": MOCK_BULK_PHOTO_UPLOAD,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) {
        return { path: args.path, namespace: "mock" };
      }
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"]
          .map((ext) => base + ext)
          .find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path],
      loader: args.path.startsWith("@/components/") ? "tsx" : "ts",
    }));
  },
};

const entrySource = `
export { default as CataloguePage } from "@/app/dashboard/catalogue/page";
`;

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
const tmpFile = path.join(tmpDir, "CataloguePage.mjs");
writeFileSync(tmpFile, code);
const { CataloguePage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await flush(stepMs);
  }
  await flush(stepMs);
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(CataloguePage));
  return { container, root };
}

function switchTo(container: HTMLElement, restaurantId: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the restaurant <select> switcher must be present in DashboardNav");
  select!.value = restaurantId;
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

test("CATALOGUE — A→B→late A (same instance): B's categories must render and must never be overwritten by A's late response", async () => {
  (globalThis as any).__catalogueDeferred = new Map();
  (globalThis as any).__catalogueCallLog = [];
  const deferredA = makeDeferred<unknown[]>();
  (globalThis as any).__catalogueDeferred.set("resto-a", deferredA);
  (globalThis as any).__catalogueFallback = { "resto-b": [category("cat-b", "MARKER_B_CAT")] };

  const { container, root } = render();
  await waitFor(() => (globalThis as any).__catalogueCallLog.includes("resto-a"));

  assert.ok(!container.textContent!.includes("MARKER_A_CAT"), "A's request is still pending: nothing of A should render yet");

  switchTo(container, "resto-b");
  await waitFor(() => container.textContent!.includes("MARKER_B_CAT"));

  assert.ok(container.textContent!.includes("MARKER_B_CAT"), "B's categories must be rendered after switching");
  assert.ok(!container.textContent!.includes("MARKER_A_CAT"), "A must not be rendered while B is selected");

  // A's response finally resolves, LATE, after B is already displayed.
  deferredA.resolve([category("cat-a", "MARKER_A_CAT")]);
  await flush(80);

  assert.ok(container.textContent!.includes("MARKER_B_CAT"), "B must STILL be rendered after A's stale response resolves");
  assert.ok(
    !container.textContent!.includes("MARKER_A_CAT"),
    "REGRESSION (expected to currently FAIL — no functional fix applied by this gate): " +
      "reload() in app/dashboard/catalogue/page.tsx has no generation/restaurant guard, so A's " +
      "stale late response overwrites B's already-displayed catalogue via an unconditional setCategories()."
  );

  root.unmount();
  container.remove();
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).File;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mappings;
  delete (globalThis as any).__catalogueDeferred;
  delete (globalThis as any).__catalogueCallLog;
  delete (globalThis as any).__catalogueFallback;
});
