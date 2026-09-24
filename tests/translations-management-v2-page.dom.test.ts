import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRANSLATIONS MANAGEMENT v2 — ÉCRAN RÉEL (mandat §19.A/§19.E)
//
// L'écran RÉEL app/dashboard/translations/page.tsx est rendu dans un
// vrai DOM ; seules les dépendances de service sont contrôlées. Ce qui
// est prouvé ici ne peut pas l'être par inspection de source :
//   - un produit de SOUS-CATÉGORIE apparaît réellement à l'écran
//     (défaut PRODUIT du mandat §2), sans doublon ;
//   - la hiérarchie Catégorie > Sous-catégorie > Produit est visible ;
//   - les filtres et le filtre de statut agissent sur ce qui est rendu ;
//   - l'import affiche un APERÇU sans écrire, et n'écrit qu'après la
//     confirmation explicite.
// ====================================================================

const REPO_ROOT = process.cwd();
const R_ID = "r-au-lait-cru";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/translations",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const HASH = { tomme: "h-tomme", crottin: "h-crottin", sub: "h-sub", intro: "h-intro" };

function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "p-tomme",
    category_id: "c-fromages",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Tomme de brebis",
    name_hash: HASH.tomme,
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 12,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: false,
    reference_price_per_kg: null,
    ...over,
  };
}

const CATALOGUE = [
  {
    category_id: "c-fromages",
    category_name: "Fromages",
    category_name_hash: "h-cat",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [product()],
    subcategories: [
      {
        subcategory_id: "s-chevres",
        subcategory_name: "Chèvres",
        subcategory_display_order: 1,
        subcategory_is_active: true,
        subcategory_name_hash: HASH.sub,
        subcategory_translations: null,
        products: [
          product({
            product_id: "p-crottin",
            subcategory_id: "s-chevres",
            subcategory_name: "Chèvres",
            name: "Crottin de Chavignol",
            name_hash: HASH.crottin,
            price: 6,
            translations: {
              en: {
                name: "Chavignol crottin",
                name_status: "validated",
                name_source_hash: HASH.crottin,
              },
            },
          }),
        ],
      },
    ],
  },
];

(globalThis as any).__writes = [] as unknown[];

function exportedNames(relPath: string): { fns: string[]; classes: string[] } {
  const src = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return {
    fns: [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    classes: [...src.matchAll(/export\s+class\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  };
}

function buildServiceMock(relPath: string, overrides: Record<string, string>): string {
  const { fns, classes } = exportedNames(relPath);
  const lines: string[] = [];
  for (const c of classes) lines.push(`export class ${c} extends Error {}`);
  for (const f of fns) {
    if (overrides[f]) continue;
    lines.push(`export async function ${f}() { return undefined; }`);
  }
  for (const body of Object.values(overrides)) lines.push(body);
  return lines.join("\n");
}

const MOCK_DASHBOARD = buildServiceMock("lib/services/dashboard.ts", {
  getMerchantRestaurants: `export async function getMerchantRestaurants() {
    return [{ restaurant_id: ${JSON.stringify(R_ID)}, role: "owner", restaurants: { id: ${JSON.stringify(R_ID)}, name: "Au lait cru", slug: "au-lait-cru" } }];
  }`,
  getMerchantCatalogue: `export async function getMerchantCatalogue() { return (globalThis).__catalogue; }`,
  getRestaurantActiveLanguages: `export async function getRestaurantActiveLanguages() {
    return [
      { code: "fr", label: "Français", dir: "ltr", display_order: 1 },
      { code: "en", label: "Anglais", dir: "ltr", display_order: 2 },
    ];
  }`,
  getRestaurantTranslationSettings: `export async function getRestaurantTranslationSettings() {
    return {
      source_language: "fr",
      intro_text: "Fromagerie artisanale",
      intro_text_hash: ${JSON.stringify(HASH.intro)},
      announcement_text: null,
      announcement_text_hash: null,
      translations: null,
    };
  }`,
  getMerchantDeliveryMethodNotices: `export async function getMerchantDeliveryMethodNotices() {
    return [{ modeCode: "pickup", modeLabel: "À emporter", customerText: "Retrait sous 2 h.", saleModeId: "sm-pickup", customerTextHash: "h-pickup", translations: null }];
  }`,
  getMerchantDeliveryFulfillmentPricing: `export async function getMerchantDeliveryFulfillmentPricing() { return []; }`,
  writeTranslation: `export async function writeTranslation(...args) {
    const reject = (globalThis).__rejectWrites;
    if (reject) { (globalThis).__refused.push(args); throw new Error(reject); }
    (globalThis).__writes.push(args);
  }`,
});

const mocks: Record<string, string> = {
  "next/navigation": `const r = { replace: () => {}, push: () => {} };
export function useRouter() { return r; }
export function usePathname() { return "/dashboard/translations"; }`,
  "@/lib/services/auth": `export async function getUser() { return { id: "u" }; }
export async function getSession() { return { user: { id: "u" } }; }
export async function signOut() {}`,
  "@/lib/services/establishments": buildServiceMock("lib/services/establishments.ts", {
    isScanymOperator: `export async function isScanymOperator() { return false; }`,
    listEstablishments: `export async function listEstablishments() { return []; }`,
  }),
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/catalogue-tags": buildServiceMock("lib/services/catalogue-tags.ts", {
    getRestaurantProductTags: `export async function getRestaurantProductTags() {
      return [{ menuItemId: "p-tomme", tagIds: ["t-bio"], tagNames: ["Bio"] }];
    }`,
  }),
};

const mockPlugin: esbuild.Plugin = {
  name: "tm2-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "tm2mock" };
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
        return { path: c ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "tm2mock" }, (a) => ({
      contents: mocks[a.path],
      loader: "ts",
    }));
  },
};

const built = await esbuild.build({
  stdin: {
    contents: `export { default as Translations } from "@/app/dashboard/translations/page";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-tm2-"));
const tmpFile = path.join(tmpDir, "page.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const P = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 120): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function mount(t: any) {
  (globalThis as any).__catalogue = CATALOGUE;
  (globalThis as any).__writes = [];
  (globalThis as any).__refused = [];
  (globalThis as any).__rejectWrites = null;
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await (React as any).act(async () => {
    root.render(React.createElement(P.Translations as never));
  });
  await flush();
  t.after(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

const textOf = (c: Element) => (c.textContent ?? "").replace(/\s+/g, " ");

function setValue(el: Element, value: string) {
  const input = el as HTMLInputElement | HTMLSelectElement;
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

const entityIds = (c: Element) =>
  [...c.querySelectorAll("[data-translation-entity-id]")].map(
    (n) => n.getAttribute("data-translation-entity-id") ?? ""
  );

test("A — le produit de SOUS-CATÉGORIE est réellement rendu, comme le produit direct, sans doublon", async (t) => {
  const container = await mount(t);
  const ids = entityIds(container);
  assert.equal(ids.includes("p-tomme"), true, "produit direct");
  assert.equal(ids.includes("p-crottin"), true, "produit de sous-catégorie -- défaut du mandat §2");
  assert.equal(new Set(ids).size, ids.length, "aucune entité rendue deux fois");
  assert.equal(ids.includes("s-chevres"), true, "la sous-catégorie est elle-même traduisible");
  assert.equal(ids.includes("sm-pickup"), true, "le message client configurable est présent");
  assert.equal(ids.includes(R_ID), true, "les textes d'établissement restent présents");
});

test("A — la hiérarchie Catégorie > Sous-catégorie > Produit est visible", async (t) => {
  const container = await mount(t);
  const crottin = container.querySelector('[data-translation-entity-id="p-crottin"]')!;
  assert.equal(
    crottin.querySelector("[data-translation-breadcrumb]")?.textContent?.trim(),
    "Fromages > Chèvres > Crottin de Chavignol"
  );
  const tomme = container.querySelector('[data-translation-entity-id="p-tomme"]')!;
  assert.equal(
    tomme.querySelector("[data-translation-breadcrumb]")?.textContent?.trim(),
    "Fromages > Tomme de brebis"
  );
});

test("C — filtres et statut agissent sur ce qui est RENDU", async (t) => {
  const container = await mount(t);

  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-search]")!, "crottin");
  });
  await flush(40);
  assert.deepEqual(entityIds(container), ["p-crottin"]);
  assert.equal(
    container.querySelector("[data-translations-result-count]")?.textContent?.includes("1"),
    true
  );

  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-reset-filters]")!, "");
    (container.querySelector("[data-translations-reset-filters]") as HTMLButtonElement).click();
  });
  await flush(40);

  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-filter-status]")!, "validated");
  });
  await flush(40);
  assert.deepEqual(
    entityIds(container),
    ["p-crottin"],
    "seule l'entité qui porte une traduction validée en anglais reste"
  );

  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-filter-tag]")!, "t-bio");
    setValue(container.querySelector("[data-translations-filter-status]")!, "all");
  });
  await flush(40);
  assert.deepEqual(entityIds(container), ["p-tomme"], "le filtre par tag ne retient que des produits");
});

test("E — l'import affiche un APERÇU sans rien écrire, puis n'écrit qu'après confirmation", async (t) => {
  const container = await mount(t);
  const { buildTranslationExport } = await import("../lib/translations-management/export.ts");
  const { buildTranslationRows } = await import("../lib/translations-management/rows.ts");

  const rows = buildTranslationRows({
    restaurant: null,
    categories: CATALOGUE as never,
  });
  const bytes = buildTranslationExport(rows, "en");
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  // Un fichier complété par le commerçant : on remplit la colonne
  // `translation` du produit de SOUS-CATÉGORIE uniquement.
  const { parseTranslationWorkbook } = await import("../lib/translations-management/import.ts");
  const parsed = parseTranslationWorkbook(ab);
  const tIdx = parsed.header.indexOf("translation");
  const filled = parsed.rows.map((r) => {
    const copy = [...r];
    // Le commerçant ne complète QU'UNE ligne ; les autres restent
    // vides (elles seront donc signalées, jamais écrites).
    copy[tIdx] = copy[1] === "p-tomme" ? "Sheep tomme" : "";
    return copy;
  });
  const { buildTranslationXlsxForTest } = await import("./helpers/translations-import-fixture.ts");
  const file = buildTranslationXlsxForTest(parsed.header, filled);

  const input = container.querySelector("[data-translations-import-input]") as HTMLInputElement;
  // Simule la sélection d'un fichier : le composant lit `files[0]`.
  Object.defineProperty(input, "files", {
    value: [
      {
        name: "traductions.xlsx",
        arrayBuffer: async () => file,
      },
    ],
    configurable: true,
  });
  await (React as any).act(async () => {
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await flush(120);

  const preview = container.querySelector("[data-translations-import-preview]");
  assert.equal(preview !== null, true, "un aperçu doit s'afficher");
  assert.equal(
    (globalThis as any).__writes.length,
    0,
    "PHASE 1 : la lecture du fichier n'écrit RIEN"
  );
  assert.equal(
    container.querySelector("[data-translations-import-applicable]")?.textContent,
    "1",
    "une seule ligne complétée est applicable"
  );

  await (React as any).act(async () => {
    (container.querySelector("[data-translations-import-confirm]") as HTMLButtonElement).click();
  });
  await flush(150);

  const writes = (globalThis as any).__writes as unknown[][];
  assert.equal(writes.length, 1, "PHASE 2 : une seule écriture, celle de la ligne applicable");
  assert.deepEqual(
    writes[0],
    [R_ID, "item", "p-tomme", "name", "en", "Sheep tomme", "to_review", HASH.tomme],
    "v2.1 : le hash source LU DANS LE FICHIER est transmis comme précondition de concurrence"
  );
});

test("E/v2.1 — COURSE aperçu -> confirmation : le serveur refuse la ligne, l'écran la compte comme refusée", async (t) => {
  // Cas B du mandat (distinct du cas A « périmé DÈS l'aperçu », couvert
  // par tests/translations-management-v2-excel.test.ts) : au moment de
  // l'aperçu la ligne est applicable sous le hash A ; le texte source
  // change ENSUITE ; à la confirmation, le SERVEUR refuse cette ligne.
  const container = await mount(t);
  const { buildTranslationExport } = await import("../lib/translations-management/export.ts");
  const { buildTranslationRows } = await import("../lib/translations-management/rows.ts");
  const { parseTranslationWorkbook } = await import("../lib/translations-management/import.ts");
  const { buildTranslationXlsxForTest } = await import("./helpers/translations-import-fixture.ts");

  const bytes = buildTranslationExport(
    buildTranslationRows({ restaurant: null, categories: CATALOGUE as never }),
    "en"
  );
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const parsed = parseTranslationWorkbook(ab);
  const tIdx = parsed.header.indexOf("translation");
  const filled = parsed.rows.map((r) => {
    const copy = [...r];
    copy[tIdx] = copy[1] === "p-tomme" ? "Sheep tomme" : "";
    return copy;
  });
  const file = buildTranslationXlsxForTest(parsed.header, filled);

  const input = container.querySelector("[data-translations-import-input]") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: [{ name: "traductions.xlsx", arrayBuffer: async () => file }],
    configurable: true,
  });
  await (React as any).act(async () => {
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await flush(120);
  assert.equal(
    container.querySelector("[data-translations-import-applicable]")?.textContent,
    "1",
    "la ligne est bien APPLICABLE au moment de l'aperçu (hash A)"
  );

  // ENTRE l'aperçu et la confirmation, le texte source change : le
  // serveur (ici son contrat, reproduit par le mock) rejette la ligne.
  (globalThis as any).__rejectWrites =
    "SCANYM_TRANSLATION_SOURCE_CHANGED: le texte source a changé depuis l'export -- traduction non enregistrée.";

  await (React as any).act(async () => {
    (container.querySelector("[data-translations-import-confirm]") as HTMLButtonElement).click();
  });
  await flush(150);

  assert.equal(
    ((globalThis as any).__writes as unknown[][]).length,
    0,
    "AUCUNE écriture réussie ne doit être comptée pour cette ligne"
  );
  const refused = (globalThis as any).__refused as unknown[][];
  assert.equal(refused.length, 1, "la ligne a bien été tentée, avec sa précondition");
  assert.equal(refused[0][7], HASH.tomme, "le hash du fichier est la précondition transmise");

  const result = container.querySelector("[data-translations-import-result]")?.textContent ?? "";
  assert.equal(result.includes("0 traduction(s) importée(s)"), true, `résultat inattendu : ${result}`);
  assert.equal(result.includes("1 refusée(s) par le serveur"), true, `résultat inattendu : ${result}`);
  assert.equal(
    result.includes("le texte source a changé depuis l'export"),
    true,
    "l'écran doit dire POURQUOI la ligne a été refusée"
  );
});
