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
// #209 — Traductions de l'aide « Comment passer commande » :
//   - recherche / filtre (pur) ;
//   - export puis import XLSX du corps long, sauts de ligne préservés ;
//   - aucune traduction écrasée, rien de validé automatiquement,
//     isolation par établissement, source périmée refusée ;
//   - la traduction validée apparaît dans la fenêtre de la vitrine.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
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
const { supabase } = await import("../lib/supabase.ts");
void supabase;

const { buildTranslationRows } = await import("../lib/translations-management/rows.ts");
const { buildTranslationExport, buildTranslationExportRows, TRANSLATION_EXPORT_COLUMNS } = await import(
  "../lib/translations-management/export.ts"
);
const { parseTranslationWorkbook, buildTranslationImportPreview } = await import(
  "../lib/translations-management/import.ts"
);
const { buildCatalogueXlsx } = await import("../lib/catalogue-management/export.ts");
const {
  applyTranslationFilters,
  EMPTY_TRANSLATION_FILTERS,
  isOrderHelpHiddenByContextFilter,
  matchesTranslationSearch,
  withoutContextFilters,
} = await import("../lib/translations-management/filtering.ts");

const REPO_ROOT = process.cwd();
const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const candidate = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
      const resolved = candidate ?? base;
      if (resolved.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolved).href, external: true };
      }
      return { path: resolved };
    });
  },
};
const built = await esbuild.build({
  stdin: {
    contents: `export { default as OrderHelpButton } from "@/components/OrderHelpButton";
export { I18nProvider } from "@/lib/i18n-context";`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-209-"));
const tmpFile = path.join(tmpDir, "help.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { OrderHelpButton, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const flush = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

// --- données ---------------------------------------------------------
const RID = "r-au-lait-cru";
const OTHER_RID = "r-autre-fromagerie";
const LABEL = "Comment passer commande ?";
const TITLE = "Comment passer commande";
// Corps réaliste : > 2 430 caractères, paragraphes séparés par des
// lignes vides, accents, ponctuation française.
const BODY = Array.from(
  { length: 40 },
  (_, i) => `Étape ${i + 1} : choisissez vos fromages, ajoutez-les au panier, puis validez.`
).join("\n\n");
const EN_BODY = Array.from(
  { length: 40 },
  (_, i) => `Step ${i + 1}: choose your cheeses, add them to the cart, then confirm.`
).join("\n\n");
assert.ok(BODY.length > 2430);

type Row = ReturnType<typeof buildTranslationRows>[number];
function helpRows(over: Partial<Record<string, any>> = {}, restaurantId = RID): Row[] {
  const text = (textKey: string, body: string, hash: string, translations: any = null) => ({
    restaurantId,
    restaurantName: "Au lait cru",
    textKey,
    body,
    bodyHash: hash,
    translations,
  });
  return buildTranslationRows({
    restaurant: null,
    categories: [],
    orderHelpTexts: [
      text("order_help_button_label", LABEL, "h-label", over.label ?? null),
      text("order_help_title", TITLE, "h-title", over.title ?? null),
      text("order_help_body", BODY, "h-body", over.body ?? null),
    ] as any,
  });
}

// --- recherche / filtre (pur) -----------------------------------------
test("[209-F1] la recherche trouve chaque champ de l'aide par son libellé (casse ignorée ; les accents restent significatifs comme partout dans ce catalogue)", () => {
  const rows = helpRows();
  assert.equal(rows.length, 3);
  const found = (q: string) => rows.filter((r) => matchesTranslationSearch(r, q)).map((r) => r.field);
  assert.deepEqual(found("bouton"), ["order_help_button_label"]);
  assert.deepEqual(found("TITRE DE LA FENÊTRE"), ["order_help_title"]);
  assert.deepEqual(found("texte de la fenêtre"), ["order_help_body"]);
  assert.equal(found("aide à la commande").length, 3, "famille de contenu");
  assert.equal(found("Comment passer commande").length, 3, "titre de carte");
});

test("[209-F2] les libellés de champ ne sont PAS cherchables pour le catalogue (pas de recherche qui renvoie tout)", () => {
  const catalogueLike = buildTranslationRows({
    restaurant: null,
    categories: [
      {
        category_id: "c1",
        category_name: "Fromages",
        category_name_hash: "hc",
        category_translations: null,
        category_display_order: 1,
        category_is_option_source: false,
        category_description: "Nos fromages",
        category_description_hash: "hd",
        category_is_active: true,
        products: [],
        subcategories: [],
      },
    ] as any,
  });
  assert.ok(catalogueLike.length >= 2);
  assert.equal(catalogueLike.filter((r) => matchesTranslationSearch(r, "description")).length, 0);
  assert.equal(catalogueLike.filter((r) => matchesTranslationSearch(r, "nom")).length, 0);
});

test("[209-F3] masquage par filtre de contexte détecté ; levée sans toucher à la langue ni au tri", () => {
  const rows = helpRows();
  const withCategory = { ...EMPTY_TRANSLATION_FILTERS, categoryId: "c1" };
  assert.equal(isOrderHelpHiddenByContextFilter(rows, withCategory), true);
  assert.equal(isOrderHelpHiddenByContextFilter(rows, EMPTY_TRANSLATION_FILTERS), false);
  assert.equal(isOrderHelpHiddenByContextFilter([], withCategory), false, "pas d'aide : rien à signaler");
  assert.equal(applyTranslationFilters(rows, withCategory, "en").length, 0);
  const lifted = withoutContextFilters({ ...withCategory, search: "bouton", status: "missing", tagId: "t", available: true });
  assert.equal(lifted.categoryId, null);
  assert.equal(lifted.tagId, null);
  assert.equal(lifted.available, null);
  assert.equal(lifted.search, "bouton", "la recherche est conservée par cette fonction");
  assert.equal(applyTranslationFilters(rows, lifted, "en").length, 1);
});

// --- XLSX : export, import, corps long ---------------------------------
function xlsxRoundTrip(rows: Row[], fill: (r: string[], h: string[]) => string[], lang = "en") {
  const exported = buildTranslationExport(rows, lang);
  const ab0 = exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength) as ArrayBuffer;
  const parsed0 = parseTranslationWorkbook(ab0);
  // Le commerçant complète la colonne « translation » dans Excel.
  const filled = parsed0.rows.map((r) => fill([...r], parsed0.header));
  const rebuilt = buildCatalogueXlsx(parsed0.header, filled as any, "Traductions");
  const ab = rebuilt.buffer.slice(rebuilt.byteOffset, rebuilt.byteOffset + rebuilt.byteLength) as ArrayBuffer;
  return parseTranslationWorkbook(ab);
}
const ctx = (rows: Row[], over: Record<string, unknown> = {}) => ({
  rows,
  sourceLanguage: "fr",
  activeLanguages: ["fr", "en"],
  targetLanguage: "en",
  ...over,
});

test("[209-X1] l'export contient les trois champs avec le corps COMPLET et ses sauts de ligne", () => {
  const rows = helpRows();
  const cells = buildTranslationExportRows(rows, "en");
  assert.equal(cells.length, 3);
  const body = cells.find((c) => c[4] === "order_help_body")!;
  assert.equal(body[0], "order_help");
  assert.equal(body[1], RID);
  assert.equal(body[5], BODY, "texte source intégral (>2 430 car.)");
  assert.equal(body[6], "h-body", "hash source exporté");
  const ab = (() => {
    const b = buildTranslationExport(rows, "en");
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  })();
  const parsed = parseTranslationWorkbook(ab);
  const iSrc = parsed.header.indexOf("source_text");
  const iField = parsed.header.indexOf("field");
  const row = parsed.rows.find((r) => r[iField] === "order_help_body")!;
  assert.equal(row[iSrc], BODY, "relu à l'identique depuis le .xlsx, retours à la ligne inclus");
  assert.deepEqual(parsed.header, [...TRANSLATION_EXPORT_COLUMNS]);
});

test("[209-X2] import XLSX du corps long : applicable, sauts de ligne préservés, statut « à relire » (rien n'est validé tout seul)", () => {
  const rows = helpRows();
  const parsed = xlsxRoundTrip(rows, (r, h) => {
    const f = r[h.indexOf("field")];
    r[h.indexOf("translation")] =
      f === "order_help_body" ? EN_BODY : f === "order_help_title" ? "How to order" : "How to order?";
    return r; // colonne « status » = statut dérivé de l'export (missing) : jamais « validated »
  });
  const preview = buildTranslationImportPreview(parsed, ctx(rows));
  assert.equal(preview.fileError, null);
  assert.equal(preview.counts.applicable, 3);
  const body = preview.rows.find((r) => r.field === "order_help_body")!;
  assert.equal(body.translation, EN_BODY, "sauts de ligne et longueur identiques");
  assert.ok(body.translation.includes("\n\n"));
  assert.equal(preview.rows.filter((r) => r.status === "validated").length, 0, "aucune validation automatique");
});

test("[209-X3] import : ne remplace jamais une traduction DÉJÀ VALIDÉE sans consentement explicite", () => {
  const existing = {
    en: { order_help_body: "Validated by the merchant", order_help_body_status: "validated", order_help_body_source_hash: "h-body" },
  };
  const rows = helpRows({ body: existing });
  const parsed = xlsxRoundTrip(rows, (r, h) => {
    if (r[h.indexOf("field")] === "order_help_body") r[h.indexOf("translation")] = EN_BODY;
    return r;
  });
  const preview = buildTranslationImportPreview(parsed, ctx(rows));
  assert.equal(preview.rows.find((r) => r.field === "order_help_body")!.verdict, "overwrites_validated");
  const allowed = buildTranslationImportPreview(parsed, ctx(rows, { allowOverwriteValidated: true }));
  assert.equal(allowed.rows.find((r) => r.field === "order_help_body")!.verdict, "applicable");
});

test("[209-X4] import : source modifiée depuis l'export → refusée (hash), jamais écrite", () => {
  const exportedFrom = helpRows();
  const parsed = xlsxRoundTrip(exportedFrom, (r, h) => {
    if (r[h.indexOf("field")] === "order_help_body") r[h.indexOf("translation")] = EN_BODY;
    return r;
  });
  const changed = buildTranslationRows({
    restaurant: null,
    categories: [],
    orderHelpTexts: [
      { restaurantId: RID, restaurantName: "Au lait cru", textKey: "order_help_body", body: BODY + " Nouveau.", bodyHash: "h-body-v2", translations: null },
    ] as any,
  });
  const preview = buildTranslationImportPreview(parsed, ctx(changed));
  const body = preview.rows.find((r) => r.field === "order_help_body")!;
  assert.equal(body.verdict, "stale_source");
});

test("[209-X5] isolation par établissement : l'aide d'un autre commerçant est « élément inconnu »", () => {
  const rowsOfOther = helpRows({}, OTHER_RID);
  const parsedFromOther = xlsxRoundTrip(rowsOfOther, (r, h) => {
    r[h.indexOf("translation")] = "X";
    return r;
  });
  const preview = buildTranslationImportPreview(parsedFromOther, ctx(helpRows()));
  assert.equal(preview.counts.applicable, 0);
  assert.equal(preview.counts.unknown_entity, 3);
});

test("[209-X6] import : un champ d'aide inexistant ou un statut inventé est refusé", () => {
  const rows = helpRows();
  const parsed = xlsxRoundTrip(rows, (r, h) => {
    r[h.indexOf("translation")] = "x";
    r[h.indexOf("status")] = "ai_generated";
    return r;
  });
  const preview = buildTranslationImportPreview(parsed, ctx(rows));
  assert.equal(preview.counts.applicable, 0);
  assert.equal(preview.counts.invalid_status, 3);
});

// --- vitrine : la traduction validée est affichée ----------------------
async function renderHelp(lang: string, translatedTexts: any[]) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const communicationTexts = {
    order_help_button_label: LABEL,
    order_help_title: TITLE,
    order_help_body: BODY,
  };
  await (React as any).act(async () => {
    root.render(
      React.createElement(I18nProvider, {
        lang,
        sourceLanguage: "fr",
        children: React.createElement(OrderHelpButton, { communicationTexts, translatedTexts }),
      })
    );
  });
  await flush();
  return { container, unmount: () => { root.unmount(); container.remove(); } };
}
const validated = (key: string, value: string, hash: string) => ({
  en: { [key]: value, [`${key}_status`]: "validated", [`${key}_source_hash`]: hash },
});

test("[209-S1] la traduction validée du corps long (2 430+ car., sauts de ligne) apparaît dans la fenêtre, en anglais", async () => {
  const { container, unmount } = await renderHelp("en", [
    { text_key: "order_help_button_label", body: LABEL, body_hash: "h-label", translations: validated("order_help_button_label", "How to order?", "h-label") },
    { text_key: "order_help_title", body: TITLE, body_hash: "h-title", translations: validated("order_help_title", "How to order", "h-title") },
    { text_key: "order_help_body", body: BODY, body_hash: "h-body", translations: validated("order_help_body", EN_BODY, "h-body") },
  ]);
  try {
    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent === "How to order?");
    assert.ok(trigger, "libellé du bouton traduit");
    await (React as any).act(async () => { (trigger as HTMLElement).click(); });
    await flush();
    assert.equal(container.querySelector("[data-order-help-title]")?.textContent, "How to order");
    const body = container.querySelector("[data-order-help-body]") as HTMLElement;
    assert.equal(body.textContent, EN_BODY, "corps traduit intégral, retours à la ligne inclus");
    assert.ok(body.className.includes("whitespace-pre-line"), "les sauts de ligne sont rendus");
  } finally { unmount(); }
});

test("[209-S2] une traduction seulement « à relire » n'est PAS affichée : la source française reste", async () => {
  const draft = { en: { order_help_body: EN_BODY, order_help_body_status: "to_review", order_help_body_source_hash: "h-body" } };
  const { container, unmount } = await renderHelp("en", [
    { text_key: "order_help_body", body: BODY, body_hash: "h-body", translations: draft },
  ]);
  try {
    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent === LABEL);
    assert.ok(trigger);
    await (React as any).act(async () => { (trigger as HTMLElement).click(); });
    await flush();
    assert.equal(container.querySelector("[data-order-help-body]")?.textContent, BODY);
  } finally { unmount(); }
});

test("[209-S3] langue sans traduction : le texte source s'affiche (jamais une fenêtre vide)", async () => {
  const { container, unmount } = await renderHelp("nl", [
    { text_key: "order_help_body", body: BODY, body_hash: "h-body", translations: validated("order_help_body", EN_BODY, "h-body") },
  ]);
  try {
    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent === LABEL);
    assert.ok(trigger);
    await (React as any).act(async () => { (trigger as HTMLElement).click(); });
    await flush();
    assert.equal(container.querySelector("[data-order-help-body]")?.textContent, BODY);
  } finally { unmount(); }
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of ["window", "document", "navigator", "HTMLElement", "Event", "requestAnimationFrame", "cancelAnimationFrame", "fetch"]) delete (globalThis as any)[k];
});
