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
// Scanym — TRANSLATIONS BULK VALIDATION v1 — ÉCRAN RÉEL
//
// L'écran RÉEL app/dashboard/translations/page.tsx est rendu dans un
// vrai DOM ; SEULE la couche de service est contrôlée, et la RPC
// `writeTranslation` est observée argument par argument. Ce qui est
// prouvé ici ne peut pas l'être sur le module pur :
//   - §1.A un import CONFIRMÉ écrit « validated », y compris pour une
//     ligne jusque-là `missing` ou `to_review` ;
//   - §3  AUCUNE mutation avant la confirmation explicite, et la
//     confirmation porte le COMPTE EXACT ;
//   - §2  le lot n'atteint ni un autre établissement, ni une autre
//     langue, ni une ligne validée / périmée / manquante ;
//   - §5  le second consentement d'écrasement reste EXIGÉ.
// ====================================================================

const REPO_ROOT = process.cwd();
const R_ID = "r-au-lait-cru";

/** Hash SOURCE ACTUEL de chaque champ. */
const H = {
  review: "h-review",
  validated: "h-validated",
  staleSrc: "h-stale-now",
  missing: "h-missing",
  trap: "h-trap-now",
  arOnly: "h-ar-only",
  intro: "h-intro",
  cat: "h-cat",
};
/** Hash d'un texte source PRÉCÉDENT (donc plus à jour). */
const H_OLD = "h-ancien-texte";

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

function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "p-x",
    category_id: "c-fromages",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Produit",
    name_hash: "h-x",
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
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: false,
    ...over,
  };
}

const tr = (lang: string, value: string, status: string, hash: string) => ({
  [lang]: { name: value, name_status: status, name_source_hash: hash },
});

/**
 * Catalogue de preuve : UNE ligne par cas du §2, plus une ligne piège.
 * Toutes portent le MÊME champ (`name`) pour que seuls les statuts et
 * les hashs distinguent les cas.
 */
const CATALOGUE = [
  {
    category_id: "c-fromages",
    category_name: "Fromages",
    category_name_hash: H.cat,
    // La catégorie elle-même est « à relire » et à jour : elle DOIT
    // être validée (le lot ne se limite pas aux produits).
    category_translations: { en: { name: "Cheeses", name_status: "to_review", name_source_hash: H.cat } },
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [
      product({
        product_id: "p-review",
        name: "À relire",
        name_hash: H.review,
        translations: tr("en", "To review", "to_review", H.review),
      }),
      product({
        product_id: "p-validated",
        name: "Déjà validé",
        name_hash: H.validated,
        translations: tr("en", "Already validated", "validated", H.validated),
      }),
      product({
        product_id: "p-stale",
        name: "Périmé",
        name_hash: H.staleSrc,
        translations: tr("en", "Stale", "validated", H_OLD),
      }),
      product({ product_id: "p-missing", name: "Manquant", name_hash: H.missing, translations: null }),
      product({
        product_id: "p-trap",
        name: "Piège",
        name_hash: H.trap,
        // « à relire » MAIS écrite contre un texte source disparu :
        // affichée « À relire », elle ne doit JAMAIS être validée.
        translations: tr("en", "Traduction d'un ancien texte", "to_review", H_OLD),
      }),
      product({
        product_id: "p-ar-only",
        name: "Arabe seulement",
        name_hash: H.arOnly,
        translations: tr("ar", "عربي", "to_review", H.arOnly),
      }),
    ],
    subcategories: [],
  },
];

/** Entités dont la traduction anglaise DOIT être validée par le lot. */
const EXPECTED_EN = [
  ["category", "c-fromages", "Cheeses", H.cat],
  ["item", "p-review", "To review", H.review],
] as const;

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
  // L'identifiant reçu est OBSERVÉ : il prouve qu'aucune lecture ne
  // vise un autre établissement.
  getMerchantCatalogue: `export async function getMerchantCatalogue(id) {
    (globalThis).__catalogueReads.push(id);
    return (globalThis).__catalogue;
  }`,
  getRestaurantActiveLanguages: `export async function getRestaurantActiveLanguages() {
    return [
      { code: "fr", label: "Français", dir: "ltr", display_order: 1 },
      { code: "en", label: "Anglais", dir: "ltr", display_order: 2 },
      { code: "ar", label: "Arabe", dir: "rtl", display_order: 3 },
    ];
  }`,
  getRestaurantTranslationSettings: `export async function getRestaurantTranslationSettings() {
    return {
      source_language: "fr",
      intro_text: "Fromagerie artisanale",
      intro_text_hash: ${JSON.stringify(H.intro)},
      announcement_text: null,
      announcement_text_hash: null,
      translations: null,
    };
  }`,
  getMerchantDeliveryMethodNotices: `export async function getMerchantDeliveryMethodNotices() { return []; }`,
  getMerchantDeliveryFulfillmentPricing: `export async function getMerchantDeliveryFulfillmentPricing() { return []; }`,
  writeTranslation: `export async function writeTranslation(...args) {
    const reject = (globalThis).__rejectWrites;
    if (reject && reject(args)) { (globalThis).__refused.push(args); throw new Error((globalThis).__rejectMessage); }
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
    getRestaurantProductTags: `export async function getRestaurantProductTags() { return []; }`,
  }),
};

const mockPlugin: esbuild.Plugin = {
  name: "bulkv1-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "bulkv1mock" };
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
        return { path: c ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "bulkv1mock" }, (a) => ({
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-bulkv1-"));
const tmpFile = path.join(tmpDir, "page.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const P = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 120): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function mount(t: any) {
  (globalThis as any).__catalogue = CATALOGUE;
  (globalThis as any).__catalogueReads = [];
  (globalThis as any).__writes = [];
  (globalThis as any).__refused = [];
  (globalThis as any).__rejectWrites = null;
  (globalThis as any).__rejectMessage = "";
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

const writes = () => (globalThis as any).__writes as unknown[][];
const q = (c: Element, sel: string) => c.querySelector(sel) as HTMLElement | null;

async function click(container: Element, sel: string) {
  const el = q(container, sel);
  assert.ok(el, `élément introuvable : ${sel}`);
  await (React as any).act(async () => {
    (el as HTMLButtonElement).click();
  });
  await flush(150);
}

function setValue(el: Element, value: string) {
  const input = el as HTMLInputElement | HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

/** Construit un classeur d'import minimal mais VALIDE. */
async function importFile(
  container: Element,
  rows: ReadonlyArray<ReadonlyArray<string>>
) {
  const { buildTranslationXlsxForTest } = await import("./helpers/translations-import-fixture.ts");
  const header = [
    "entity_type",
    "entity_id",
    "field",
    "source_hash",
    "target_language",
    "translation",
    "status",
  ];
  const file = buildTranslationXlsxForTest(header, rows);
  const input = q(container, "[data-translations-import-input]") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: [{ name: "traductions.xlsx", arrayBuffer: async () => file }],
    configurable: true,
  });
  await (React as any).act(async () => {
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await flush(150);
}

// ====================================================================
// §1.A — IMPORT CONFIRMÉ = VALIDÉ
// ====================================================================

test("1 — import confirmé d'une ligne MANQUANTE : écrite « validated »", async (t) => {
  const container = await mount(t);
  await importFile(container, [
    ["item", "p-missing", "name", H.missing, "en", "Missing translated", "missing"],
  ]);
  assert.equal(q(container, "[data-translations-import-applicable]")?.textContent, "1");
  assert.equal(writes().length, 0, "PHASE 1 : aucune écriture à la lecture du fichier");

  await click(container, "[data-translations-import-confirm]");
  assert.deepEqual(writes(), [
    [R_ID, "item", "p-missing", "name", "en", "Missing translated", "validated", H.missing],
  ]);
});

test("2 — import confirmé d'une ligne À RELIRE : écrite « validated » (statut Excel ignoré)", async (t) => {
  const container = await mount(t);
  // Le fichier porte explicitement « to_review » : la CONFIRMATION du
  // commerçant prime, la colonne reste une métadonnée d'aller-retour.
  await importFile(container, [
    ["item", "p-review", "name", H.review, "en", "Reviewed text", "to_review"],
  ]);
  await click(container, "[data-translations-import-confirm]");
  assert.equal(writes().length, 1);
  assert.equal(writes()[0][6], "validated", "la confirmation EST l'acte de validation");
  assert.equal(writes()[0][7], H.review, "le hash du fichier reste la précondition de concurrence");
});

test("10 — le SECOND consentement d'écrasement reste EXIGÉ malgré la règle §1.A", async (t) => {
  const container = await mount(t);
  await importFile(container, [
    ["item", "p-validated", "name", H.validated, "en", "Nouvelle valeur", "validated"],
  ]);
  assert.equal(
    q(container, "[data-translations-import-applicable]")?.textContent,
    "0",
    "par défaut, une traduction DÉJÀ validée n'est jamais écrasée"
  );
  assert.equal(
    q(container, '[data-import-verdict="overwrites_validated"]') !== null,
    true,
    "le refus est visible, jamais silencieux"
  );
  assert.equal(
    (q(container, "[data-translations-import-confirm]") as HTMLButtonElement).disabled,
    true
  );

  // Second consentement explicite -> la ligne devient applicable.
  await (React as any).act(async () => {
    const box = q(container, "[data-translations-allow-overwrite]") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")?.set;
    setter?.call(box, true);
    box.dispatchEvent(new window.Event("click", { bubbles: true }));
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await flush(120);
  assert.equal(q(container, "[data-translations-import-applicable]")?.textContent, "1");
  assert.equal(writes().length, 0, "cocher la case n'écrit toujours rien");

  await click(container, "[data-translations-import-confirm]");
  assert.deepEqual(writes(), [
    [R_ID, "item", "p-validated", "name", "en", "Nouvelle valeur", "validated", H.validated],
  ]);
});

// ====================================================================
// §2 / §3 — VALIDATION EN MASSE
// ====================================================================

test("3 — le bouton OUVRE une confirmation portant le compte EXACT, sans rien écrire", async (t) => {
  const container = await mount(t);
  const button = q(container, "[data-translations-bulk-validate]") as HTMLButtonElement;
  assert.ok(button, "l'action « Valider toutes les traductions de cette langue » doit exister");
  assert.equal(
    button.textContent?.includes("Valider toutes les traductions de cette langue"),
    true,
    `libellé inattendu : ${button.textContent}`
  );
  assert.equal(q(container, "[data-translations-bulk-confirm]"), null, "aucune confirmation ouverte au départ");

  await click(container, "[data-translations-bulk-validate]");
  assert.equal(writes().length, 0, "§3 : AUCUNE mutation avant confirmation explicite");

  const panel = q(container, "[data-translations-bulk-confirm]")!;
  assert.ok(panel, "la confirmation doit s'afficher");
  assert.equal(
    q(container, "[data-translations-bulk-question]")?.textContent,
    "Valider 2 traductions en anglais ?",
    "le compte affiché est le compte EXACT des lignes retenues"
  );
  assert.equal(
    (panel.textContent ?? "").includes(
      "Seules les traductions à relire et toujours à jour seront validées."
    ),
    true,
    "l'explication imposée par le mandat doit être affichée"
  );
  assert.equal(
    (q(container, "[data-translations-bulk-skipped]")?.textContent ?? "").includes("1 traduction(s)"),
    true,
    "la ligne à relire dont la source a changé est annoncée comme ignorée"
  );

  // Annuler ne mute rien non plus.
  await click(container, "[data-translations-bulk-cancel]");
  assert.equal(q(container, "[data-translations-bulk-confirm]"), null);
  assert.equal(writes().length, 0);
});

test("3/4/5/6 — la confirmation ne valide QUE les lignes à relire et à jour", async (t) => {
  const container = await mount(t);
  await click(container, "[data-translations-bulk-validate]");
  await click(container, "[data-translations-bulk-confirm-action]");

  const actual = writes().map((w) => [w[1], w[2], w[5], w[7]]);
  assert.deepEqual(
    actual.slice().sort(),
    EXPECTED_EN.map((e) => [e[0], e[1], e[2], e[3]]).slice().sort(),
    "seules les lignes « à relire » ET à jour sont écrites, avec leur valeur STOCKÉE inchangée"
  );
  for (const w of writes()) {
    assert.equal(w[6], "validated", "chaque écriture porte le statut validé");
    assert.equal(w[4], "en", "chaque écriture vise la langue COURANTE");
    assert.equal(w[0], R_ID, "chaque écriture vise l'établissement COURANT");
  }

  const touched = writes().map((w) => w[2]);
  for (const forbidden of ["p-validated", "p-stale", "p-missing", "p-trap", "p-ar-only"]) {
    assert.equal(
      touched.includes(forbidden),
      false,
      `${forbidden} ne doit JAMAIS être touché par la validation en masse`
    );
  }

  const result = q(container, "[data-translations-bulk-result]")?.textContent ?? "";
  assert.equal(result.includes("2 traduction(s) validée(s)"), true, result);
  assert.equal(result.includes("1 ignorée(s)"), true, result);
  assert.equal(result.includes("0 échec(s)"), true, result);
});

test("7 — le lot ne peut atteindre aucun AUTRE établissement", async (t) => {
  const container = await mount(t);
  await click(container, "[data-translations-bulk-validate]");
  await click(container, "[data-translations-bulk-confirm-action]");

  assert.ok(writes().length > 0, "le lot a bien écrit quelque chose");
  assert.deepEqual(
    [...new Set(writes().map((w) => w[0]))],
    [R_ID],
    "toutes les écritures portent l'identifiant de l'établissement COURANT"
  );
  const known = new Set(["c-fromages", "p-review"]);
  for (const w of writes()) {
    assert.equal(known.has(w[2] as string), true, `entité hors de l'établissement courant : ${w[2]}`);
  }
  assert.deepEqual(
    [...new Set((globalThis as any).__catalogueReads as string[])],
    [R_ID],
    "aucune lecture ne vise un autre établissement"
  );
});

test("8 — changer de langue change le PÉRIMÈTRE : aucune écriture sur l'autre langue", async (t) => {
  const container = await mount(t);
  await (React as any).act(async () => {
    setValue(q(container, "[data-translations-target-lang]")!, "ar");
  });
  await flush(120);

  await click(container, "[data-translations-bulk-validate]");
  assert.equal(
    q(container, "[data-translations-bulk-question]")?.textContent,
    "Valider 1 traduction en arabe ?",
    "seule la traduction arabe à relire et à jour est retenue"
  );
  await click(container, "[data-translations-bulk-confirm-action]");

  assert.deepEqual(writes().map((w) => w[4]), ["ar"], "aucune écriture en anglais");
  assert.deepEqual(writes().map((w) => w[2]), ["p-ar-only"]);
  assert.equal(writes()[0][5], "عربي", "la valeur arabe stockée est réécrite telle quelle");
});

test("8bis — une confirmation comptée pour une langue ne survit PAS au changement de langue", async (t) => {
  const container = await mount(t);
  await click(container, "[data-translations-bulk-validate]");
  assert.ok(q(container, "[data-translations-bulk-confirm]"));

  await (React as any).act(async () => {
    setValue(q(container, "[data-translations-target-lang]")!, "ar");
  });
  await flush(120);
  assert.equal(
    q(container, "[data-translations-bulk-confirm]"),
    null,
    "le panneau se referme : un compte de 2 lignes anglaises ne peut pas valider l'arabe"
  );
  assert.equal(writes().length, 0);
});

test("9 — SOURCE MODIFIÉE entre l'écran et l'écriture : le SERVEUR refuse, l'écran le dit", async (t) => {
  const container = await mount(t);
  // Le texte source de la catégorie change APRÈS le calcul du compte :
  // la base refuse cette ligne (SQLSTATE 40001), l'autre passe.
  (globalThis as any).__rejectWrites = (args: unknown[]) => args[2] === "c-fromages";
  (globalThis as any).__rejectMessage =
    "SCANYM_TRANSLATION_SOURCE_CHANGED: le texte source a changé -- traduction non enregistrée.";

  await click(container, "[data-translations-bulk-validate]");
  await click(container, "[data-translations-bulk-confirm-action]");

  const refused = (globalThis as any).__refused as unknown[][];
  assert.equal(refused.length, 1, "la ligne a bien été tentée");
  assert.equal(refused[0][7], H.cat, "avec le hash source courant en PRÉCONDITION");
  assert.deepEqual(writes().map((w) => w[2]), ["p-review"], "seule la ligne non refusée est écrite");

  const result = q(container, "[data-translations-bulk-result]")?.textContent ?? "";
  assert.equal(result.includes("1 traduction(s) validée(s)"), true, result);
  assert.equal(result.includes("1 échec(s)"), true, result);
  assert.equal(
    result.includes("le texte source a changé pendant la validation"),
    true,
    `l'écran doit dire POURQUOI la ligne a été refusée : ${result}`
  );
});

test("12 — après le lot, l'écran est RELU et l'action se désactive d'elle-même", async (t) => {
  const container = await mount(t);
  // État tel que le SERVEUR le renverra une fois le lot appliqué : les
  // deux lignes deviennent validées.
  (globalThis as any).__catalogue = [
    {
      ...CATALOGUE[0],
      category_translations: { en: { name: "Cheeses", name_status: "validated", name_source_hash: H.cat } },
      products: CATALOGUE[0].products.map((p) =>
        p.product_id === "p-review"
          ? { ...p, translations: tr("en", "To review", "validated", H.review) }
          : p
      ),
    },
  ];

  await click(container, "[data-translations-bulk-validate]");
  await click(container, "[data-translations-bulk-confirm-action]");
  await flush(200);
  const before = writes().length;
  assert.equal(before, 2, "le lot a bien porté sur les 2 lignes comptées AVANT le rechargement");

  const button = q(container, "[data-translations-bulk-validate]") as HTMLButtonElement;
  assert.equal(
    button.disabled,
    true,
    "plus aucune ligne à relire et à jour -> action désactivée, jamais un lot vide envoyé au serveur"
  );
  await click(container, "[data-translations-bulk-validate]");
  assert.equal(q(container, "[data-translations-bulk-confirm]"), null);
  assert.equal(writes().length, before, "aucune écriture supplémentaire");
  assert.equal(
    (q(container, "[data-translations-bulk-result]")?.textContent ?? "").includes(
      "2 traduction(s) validée(s)"
    ),
    true,
    "le compte rendu reste affiché après le rechargement"
  );
});
