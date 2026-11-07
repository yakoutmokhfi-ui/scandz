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
    getMerchantTagTranslations: `export async function getMerchantTagTranslations() { return (globalThis).__tagTranslations ?? []; }`,
    getRestaurantProductTags: `export async function getRestaurantProductTags() {
      return [{ menuItemId: "p-tomme", tagIds: ["t-bio"], tagNames: ["Bio"] }];
    }`,
  }),
  // #209 -- `__helpScript` : comportements successifs (un par lecture) pour
  // simuler un échec, une lecture lente ou une réponse périmée.
  "@/lib/services/merchant-communications": `export async function getMerchantOrderHelpTexts() {
    (globalThis).__helpCalls = ((globalThis).__helpCalls ?? 0) + 1;
    const script = (globalThis).__helpScript;
    if (script && script.length) return script.shift()();
    return (globalThis).__helpTexts ?? [];
  }`,
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
    // BULK VALIDATION v1 §1.A (décision CIO) : la confirmation d'import
    // EST l'acte de validation du commerçant -- la ligne est donc
    // écrite « validated », et non plus avec le statut lu dans le
    // fichier. Le hash source reste, lui, la précondition de
    // concurrence (v2.1), inchangée.
    [R_ID, "item", "p-tomme", "name", "en", "Sheep tomme", "validated", HASH.tomme],
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

test("traduire un tag transmet son identifiant et le hash du nom source", async (t) => {
  (globalThis as any).__tagTranslations = [{ id: "tag-truffe", name: "Truffe", name_hash: "hash-truffe", translations: null }];
  t.after(() => { delete (globalThis as any).__tagTranslations; });
  const container = await mount(t);
  const tag = container.querySelector('[data-translation-entity="tag"][data-translation-entity-id="tag-truffe"]');
  assert.ok(tag);
  const field = tag.querySelector("textarea");
  assert.ok(field);
  await (React as any).act(async () => { setValue(field, "Truffle"); });
  const validate = [...tag.querySelectorAll("button")].find((b) => b.textContent === "Valider");
  assert.ok(validate);
  await (React as any).act(async () => { validate.click(); });
  const write = ((globalThis as any).__writes as unknown[][]).find((args) => args[1] === "tag");
  assert.ok(write);
  assert.equal(write[2], "tag-truffe");
  assert.equal(write[7], "hash-truffe");
});

test("aide à la commande : la validation manuelle transmet le hash source affiché", async (t) => {
  (globalThis as any).__helpTexts = [{ text_key: "order_help_body", body: "Comment commander", body_hash: "help-source-v1", translations: null }];
  t.after(() => { delete (globalThis as any).__helpTexts; });
  const container = await mount(t);
  const help = container.querySelector('[data-translation-entity="order_help"]');
  assert.ok(help, "le texte d'aide apparaît dans les traductions");
  const textarea = help.querySelector("textarea");
  assert.ok(textarea);
  await (React as any).act(async () => { setValue(textarea, "How to order"); });
  const validate = [...help.querySelectorAll("button")].find((b) => b.textContent === "Valider");
  assert.ok(validate);
  await (React as any).act(async () => { validate.click(); });
  const writes = (globalThis as any).__writes as unknown[][];
  const write = writes.find((args) => args[1] === "order_help");
  assert.ok(write, "la traduction est envoyée au service");
  assert.equal(write[7], "help-source-v1", "la source affichée est la précondition de concurrence");
});


// ====================================================================
// #209 -- TRADUCTIONS DE L'AIDE : bouton, titre et contenu repérables
// ====================================================================
const LONG_BODY = Array.from(
  { length: 40 },
  (_, i) => `Étape ${i + 1} : choisissez vos fromages, ajoutez-les au panier puis validez.`
).join("\n\n");
const helpRows = (body = LONG_BODY) => [
  { text_key: "order_help_button_label", body: "Comment passer commande ?", body_hash: "h-label", translations: null },
  { text_key: "order_help_title", body: "Comment passer commande", body_hash: "h-title", translations: null },
  { text_key: "order_help_body", body, body_hash: "h-body", translations: null },
];
const helpCard = (c: Element) => c.querySelector('[data-translation-entity="order_help"]');
const helpFields = (c: Element) => [...(helpCard(c)?.querySelectorAll("textarea") ?? [])];
function cleanHelp(t: any) {
  t.after(() => {
    delete (globalThis as any).__helpTexts;
    delete (globalThis as any).__helpScript;
    delete (globalThis as any).__helpCalls;
  });
}
async function click(el: Element | null | undefined) {
  assert.ok(el, "élément à cliquer introuvable");
  await (React as any).act(async () => {
    (el as HTMLElement).click();
  });
  await flush(60);
}

test("[209-A] les trois champs de l'aide sont réunis dans UNE carte nommée, le corps de 2 430+ caractères est lisible et saisissable", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  assert.ok(LONG_BODY.length > 2430);
  const container = await mount(t);
  const card = helpCard(container)!;
  assert.ok(card, "la carte de l'aide est rendue");
  assert.equal(card.id, "translations-order-help");
  assert.equal(card.querySelector("h3")?.textContent, "Comment passer commande");
  assert.equal(helpFields(container).length, 3, "bouton + titre + contenu");
  const labels = [...card.querySelectorAll("label")].map((l) => l.textContent);
  assert.deepEqual(labels, [
    "Bouton « Comment passer commande »",
    "Titre de la fenêtre d’aide",
    "Texte de la fenêtre d’aide",
  ]);
  const body = card.querySelectorAll("[data-translation-source]")[2] as HTMLElement;
  assert.equal(body.textContent, LONG_BODY, "texte source COMPLET, sans troncature");
  assert.ok(body.className.includes("whitespace-pre-wrap"), "sauts de ligne préservés à l'affichage");
  assert.ok(body.className.includes("overflow-y-auto"), "un texte long défile dans son cadre");
  assert.equal(helpFields(container)[2].getAttribute("rows"), "16", "zone de saisie adaptée au texte long");
  assert.match(textOf(card), /0 \/ 5\s000 caractère/, "compteur et limite serveur du corps");
});

test("[209-B] saisie manuelle du corps long : sauts de ligne conservés, hash source transmis, jamais validé tout seul", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  const card = helpCard(container)!;
  const english = "Step 1: pick your cheeses.\n\nStep 2: add to cart.\n\nStep 3: confirm.";
  await (React as any).act(async () => {
    setValue(helpFields(container)[2], english);
  });
  const buttons = [...card.querySelectorAll("button")];
  const save = buttons.filter((b) => b.textContent === "Enregistrer")[2];
  await click(save);
  const writes = (globalThis as any).__writes as unknown[][];
  const w = writes.find((a) => a[1] === "order_help" && a[3] === "order_help_body")!;
  assert.ok(w, "écriture envoyée");
  assert.equal(w[5], english, "sauts de ligne intacts");
  assert.equal(w[6], "to_review", "« Enregistrer » ne valide pas");
  assert.equal(w[7], "h-body", "précondition de hash source");
  assert.equal(writes.filter((a) => a[6] === "validated").length, 0, "rien n'est validé automatiquement");
});

test("[209-C] la recherche trouve l'aide par le libellé du champ, sans en élargir l'effet au catalogue", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  for (const q of ["bouton", "titre de la fenêtre", "aide à la commande", "comment passer commande"]) {
    await (React as any).act(async () => {
      setValue(container.querySelector("[data-translations-search]")!, q);
    });
    await flush(40);
    assert.ok(helpCard(container), `« ${q} » retrouve l'aide`);
  }
  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-search]")!, "description");
  });
  await flush(40);
  assert.equal(helpCard(container), null, "« description » ne ramène pas l'aide");
  assert.deepEqual(entityIds(container), [], "ni le catalogue (libellés de champ non cherchables)");
});

test("[209-D] un filtre catalogue masque l'aide : le message le dit et un clic la rend", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-filter-category]")!, "c-fromages");
  });
  await flush(40);
  assert.equal(helpCard(container), null, "masquée par le filtre de contexte");
  const hidden = container.querySelector("[data-translations-order-help-hidden]");
  assert.ok(hidden, "le masquage est annoncé");
  assert.match(textOf(hidden), /masqués par les filtres catalogue/);
  await click(container.querySelector("[data-translations-order-help-show]"));
  assert.ok(helpCard(container), "l'aide est affichée");
  assert.equal(
    (container.querySelector("[data-translations-filter-category]") as HTMLSelectElement).value,
    "",
    "le filtre de catégorie est levé"
  );
});

test("[209-E] une recherche qui ne l'inclut pas la masque : message et retour direct, statut levé aussi", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-search]")!, "crottin");
  });
  await flush(40);
  assert.equal(helpCard(container), null);
  assert.match(textOf(container.querySelector("[data-translations-order-help-hidden]")!), /recherche ou le statut/);
  await click(container.querySelector("[data-translations-order-help-show]"));
  assert.ok(helpCard(container));
  assert.equal((container.querySelector("[data-translations-search]") as HTMLInputElement).value, "");
});

test("[209-F] erreur de lecture : message + reprise, catalogue utilisable, jamais confondue avec « aucun texte »", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpScript = [() => { throw new Error("réseau"); }];
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  const alert = container.querySelector("[data-translations-order-help-error]");
  assert.ok(alert, "l'échec est visible");
  assert.equal(alert.getAttribute("role"), "alert");
  assert.match(textOf(alert), /Impossible de charger les textes « Comment passer commande »/);
  assert.match(textOf(alert), /Il ne s'agit pas d'une absence de texte/);
  assert.equal(helpCard(container), null, "aucune carte vide");
  assert.equal(container.querySelector("[data-translations-order-help-shortcut]"), null);
  assert.ok(entityIds(container).includes("p-tomme"), "le catalogue reste utilisable");
  await click(container.querySelector("[data-translations-order-help-retry]"));
  assert.equal(container.querySelector("[data-translations-order-help-error]"), null, "erreur levée");
  assert.equal(helpFields(container).length, 3, "les trois champs apparaissent après la reprise");
  assert.equal((globalThis as any).__helpCalls, 2, "une seule relecture de l'aide");
});

test("[209-G] lecture réussie mais vide : aucun message d'erreur, aucune carte", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = [];
  const container = await mount(t);
  assert.equal(container.querySelector("[data-translations-order-help-error]"), null);
  assert.equal(helpCard(container), null);
});

test("[209-H] champ non renseigné : dit clairement qu'il n'y a rien à traduire, sans ligne vide à « traduire »", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = [helpRows()[0], helpRows()[2]];
  const container = await mount(t);
  assert.equal(helpFields(container).length, 2);
  const unset = container.querySelector('[data-translation-order-help-unset="order_help_title"]')!;
  assert.ok(unset);
  assert.match(textOf(unset), /non renseigné dans les réglages/);
  assert.match(textOf(unset), /titre est facultatif/);
});

test("[209-I] réponse périmée : une reprise lente ne remplace jamais une lecture plus récente", async (t) => {
  cleanHelp(t);
  let releaseOld!: (rows: unknown[]) => void;
  const oldRead = new Promise<unknown[]>((r) => { releaseOld = r; });
  (globalThis as any).__helpScript = [
    () => { throw new Error("réseau"); }, // chargement initial : échec
    () => oldRead, // reprise : lente
    () => helpRows("TEXTE RÉCENT"), // rechargement après enregistrement : rapide
  ];
  const container = await mount(t);
  await click(container.querySelector("[data-translations-order-help-retry]")); // reprise en attente
  const tomme = container.querySelector('[data-translation-entity-id="p-tomme"]')!;
  await (React as any).act(async () => {
    setValue(tomme.querySelector("textarea")!, "Sheep tomme");
  });
  await click([...tomme.querySelectorAll("button")].find((b) => b.textContent === "Enregistrer"));
  assert.match(textOf(helpCard(container)!), /TEXTE RÉCENT/);
  await (React as any).act(async () => {
    releaseOld(helpRows("TEXTE PÉRIMÉ"));
  });
  await flush(80);
  assert.match(textOf(helpCard(container)!), /TEXTE RÉCENT/);
  assert.doesNotMatch(textOf(container), /TEXTE PÉRIMÉ/, "la réponse tardive est abandonnée");
  assert.equal(container.querySelector("[data-translations-order-help-error]"), null);
});

test("[209-J] dépasser la limite serveur du corps : message clair et enregistrement bloqué (aucune coupe silencieuse)", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  const card = helpCard(container)!;
  await (React as any).act(async () => {
    setValue(helpFields(container)[2], "x".repeat(5001));
  });
  assert.match(textOf(card), /5\s001 \/ 5\s000 caractère\(s\) — trop long/);
  const body = helpFields(container)[2] as HTMLTextAreaElement;
  assert.equal(body.value.length, 5001, "rien n'est coupé en silence");
  const buttons = [...card.querySelectorAll("button")];
  assert.equal((buttons.filter((b) => b.textContent === "Enregistrer")[2] as HTMLButtonElement).disabled, true);
  assert.equal((buttons.filter((b) => b.textContent === "Valider")[2] as HTMLButtonElement).disabled, true);
  assert.equal((buttons.filter((b) => b.textContent === "Valider")[0] as HTMLButtonElement).disabled, false, "les autres champs restent éditables");
});

// AUD212-01 -- « masqué par la recherche » ≠ « non renseigné »
async function searchFor(container: Element, q: string) {
  await (React as any).act(async () => {
    setValue(container.querySelector("[data-translations-search]")!, q);
  });
  await flush(40);
}
const unsetFields = (c: Element) =>
  [...c.querySelectorAll("[data-translation-order-help-unset]")].map((n) => n.getAttribute("data-translation-order-help-unset"));
const filteredFields = (c: Element) =>
  [...c.querySelectorAll("[data-translation-order-help-filtered]")].map((n) => n.getAttribute("data-translation-order-help-filtered"));

test("[209-K] recherche « bouton » avec les trois sources configurées : titre et corps sont MASQUÉS, jamais « non renseignés »", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  assert.deepEqual(unsetFields(container), [], "rien d'absent sans recherche");
  await searchFor(container, "bouton");
  assert.equal(helpFields(container).length, 1, "seul le champ bouton correspond");
  assert.deepEqual(unsetFields(container), [], "AUD212-01 : aucune fausse absence");
  assert.deepEqual(filteredFields(container).sort(), ["order_help_body", "order_help_title"]);
  assert.match(textOf(helpCard(container)!), /masqué par la recherche ou le statut choisis \(le texte existe\)/);
  assert.doesNotMatch(textOf(helpCard(container)!), /non renseigné/);
  const shortcut = container.querySelector("[data-translations-order-help-hidden]");
  assert.ok(shortcut, "message de masquage partiel");
  assert.match(textOf(shortcut), /Certains de ces textes sont masqués par la recherche ou le statut/);
  await click(container.querySelector("[data-translations-order-help-show]"));
  assert.equal(helpFields(container).length, 3, "un clic ramène les trois champs");
  assert.equal(container.querySelector("[data-translations-order-help-hidden]"), null);
  assert.deepEqual(filteredFields(container), []);
});

test("[209-L] recherche « titre » : bouton et corps masqués (existent), pas absents", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = helpRows();
  const container = await mount(t);
  await searchFor(container, "titre de la fenêtre");
  assert.equal(helpFields(container).length, 1);
  assert.deepEqual(unsetFields(container), []);
  assert.deepEqual(filteredFields(container).sort(), ["order_help_body", "order_help_button_label"]);
});

test("[209-M] titre RÉELLEMENT absent + recherche « bouton » : le titre reste « non renseigné », le corps est « masqué »", async (t) => {
  cleanHelp(t);
  (globalThis as any).__helpTexts = [helpRows()[0], helpRows()[2]];
  const container = await mount(t);
  await searchFor(container, "bouton");
  assert.deepEqual(unsetFields(container), ["order_help_title"], "vraie absence conservée");
  assert.deepEqual(filteredFields(container), ["order_help_body"], "le corps existe, il est masqué");
});
