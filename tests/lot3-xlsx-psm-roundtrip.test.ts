import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — XLSX / PRODUCT SERVICE MODES ROUND-TRIP v1 (issue #11,
// arbitrage CIO/Ravel issuecomment-5877011057).
//
// Défaut d'impact identifié AVANT ce lot (analyse issuecomment-
// 5876972459) : `allowed_sale_modes` est déjà lu (get_merchant_
// catalogue), déjà modifiable (dashboard), déjà écrit
// (create_product/update_product), mais JAMAIS transmis par le
// commit d'import XLSX -- chaque UPDATE envoyait donc `null` (ALL),
// effaçant SILENCIEUSEMENT toute restriction existante à chaque
// réimport. Ce fichier prouve, en logique PURE (sauf [E]/[H], qui
// exercent le commit RPC via mocks, même patron que
// tests/online-withdrawal-catalogue-v1.test.ts), que :
//
//   [A] coerceAllowedSaleModes distingue 4 états (unset/all/codes/
//       invalid), jamais superposés -- un jeton invalide bloque TOUTE
//       la cellule, jamais un repli silencieux ;
//   [B] PREVIEW : un produit NOUVEAU sans cellule = ALL (null), avec
//       codes = exactement ce jeu, avec « Tous » = ALL explicite ;
//   [C] PREVIEW : un produit EXISTANT restreint, cellule VIDE = la
//       restriction ACTUELLE est reconduite (SKIP, jamais un UPDATE
//       qui effacerait) -- c'est le coeur du défaut corrigé ;
//   [D] PREVIEW : « Tous » sur un produit restreint EFFACE
//       explicitement (UPDATE vers null) ; des codes identiques en
//       ORDRE DIFFÉRENT ne produisent PAS de faux UPDATE ;
//   [E] EXPORT : `null` -> littéral « Tous », un jeu de codes -> ordre
//       CANONIQUE joint par « ; » ;
//   [F] ALLER-RETOUR COMPLET (commit RPC réel, mocks) : un produit
//       pickup-only exporté puis réimporté SANS modification reste en
//       SKIP -- idempotence de l'aller-retour, explicitement demandée
//       par la CIO ;
//   [G] ALLER-RETOUR COMPLET -- LE DÉFAUT LUI-MÊME : un produit
//       restreint (room_service), le marchand modifie UNIQUEMENT le
//       prix via le fichier réimporté (cellule « Modes de vente »
//       laissée vide, comme le ferait un marchand qui ignore cette
//       colonne) -- la restriction doit survivre intacte au commit ;
//   [H] FAIL CLOSED : un code invalide bloque la ligne
//       (SCANYM_IMPORT_INVALID_SALE_MODE), jamais un « Tous » silencieux ;
//   [I] rétro-compatibilité : un fichier SANS la colonne « Modes de
//       vente » du tout s'importe exactement comme avant ce lot ;
//   [J] i18n : le message du diagnostic et la clé
//       catalogueImportSaleModeInvalid ne peuvent pas diverger.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { commitCatalogueImport } = await import("../lib/services/catalogue-import-commit.ts");
const { flattenCatalogue } = await import("../lib/catalogue-management/filtering.ts");
const { buildExportRows, buildCatalogueExport, EXPORT_COLUMNS } = await import(
  "../lib/catalogue-management/export.ts"
);
const { IMPORT_COLUMNS } = await import("../lib/catalogue-import/column-mapping.ts");
const { coerceAllowedSaleModes, SALE_MODE_CODES } = await import("../lib/catalogue-import/normalization.ts");
const { buildPreviewReport } = await import("../lib/catalogue-import/preview.ts");
const { SALE_MODE_INVALID_MESSAGE } = await import("../lib/catalogue-import/validation.ts");
const { makeCategory, makeProduct } = await import("./helpers/catalogue-fixtures.ts");
const { DICTS, translate } = await import("../lib/i18n.ts");

const SALE_MODE_COLUMN = "Modes de vente";

/** En-tête complet du format d'import -- dérivé de IMPORT_COLUMNS,
 *  jamais recopié à la main (même discipline que le fichier
 *  online-withdrawal-catalogue-v1.test.ts, dont ce fichier reprend le
 *  patron). */
const FULL_HEADER = [...IMPORT_COLUMNS];
const COL = Object.fromEntries(IMPORT_COLUMNS.map((c, i) => [c, i])) as Record<string, number>;

function productFileRow(values: Partial<Record<string, string | number>>): (string | number | null)[] {
  const row: (string | number | null)[] = FULL_HEADER.map(() => "");
  row[COL["Type"]] = "Produit";
  for (const [column, value] of Object.entries(values)) row[COL[column]] = value ?? "";
  return row;
}

interface RawCatalogueRow {
  [key: string]: unknown;
}

function catalogueRow(over: Record<string, unknown> = {}): RawCatalogueRow {
  return {
    product_id: null,
    category_id: "cat-fromages",
    category_name: "Fromages",
    category_name_hash: "hash-fromages",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    subcategory_id: null,
    subcategory_name: null,
    subcategory_display_order: null,
    subcategory_is_active: null,
    subcategory_name_hash: null,
    subcategory_translations: null,
    name: null,
    name_hash: null,
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: null,
    is_available: null,
    archived_at: null,
    display_order: null,
    is_option_source: null,
    image_url: null,
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: null,
    reference_price_per_kg: null,
    withdrawal_eligible: null,
    allowed_sale_modes: null,
    ...over,
  };
}

interface ImportHarness {
  rpcCalls: { name: string; args: any }[];
  catalogueRows: RawCatalogueRow[];
}

function installImportMocks(t: any, h: ImportHarness) {
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    h.rpcCalls.push({ name, args });
    if (name === "get_merchant_catalogue") return { data: h.catalogueRows, error: null };
    if (name === "get_restaurant_tags") return { data: [], error: null };
    if (name === "add_product_tags") return { data: 0, error: null };
    if (name === "create_category") return { data: "cat-new", error: null };
    if (name === "create_subcategory") return { data: "sub-new", error: null };
    if (name === "create_product") return { data: "prod-new", error: null };
    if (name === "update_product") return { data: null, error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
}

const RESTO_VICTOR = "resto-victor";

// ==================================================================
// A. coerceAllowedSaleModes -- 4 états distincts
// ==================================================================

test("[A] coerceAllowedSaleModes : colonne absente / cellule vide -> unset", () => {
  assert.deepEqual(coerceAllowedSaleModes(undefined), { kind: "unset" });
  assert.deepEqual(coerceAllowedSaleModes(""), { kind: "unset" });
  assert.deepEqual(coerceAllowedSaleModes("   "), { kind: "unset" });
  assert.deepEqual(coerceAllowedSaleModes(";"), { kind: "unset" }, "que des séparateurs -> aucun jeton exploitable");
});

test("[A] coerceAllowedSaleModes : littéral « Tous », insensible casse/espaces/accents", () => {
  for (const raw of ["Tous", "tous", "TOUS", "  Tous  ", "ToUs"]) {
    assert.deepEqual(coerceAllowedSaleModes(raw), { kind: "all" }, `« ${raw} » doit être reconnu comme Tous`);
  }
});

test("[A] coerceAllowedSaleModes : codes valides, séparés par « ; », dédupliqués (ordre de première apparition), insensibles à la casse", () => {
  assert.deepEqual(coerceAllowedSaleModes("pickup"), { kind: "codes", codes: ["pickup"] });
  assert.deepEqual(coerceAllowedSaleModes("pickup ; delivery"), { kind: "codes", codes: ["pickup", "delivery"] });
  assert.deepEqual(
    coerceAllowedSaleModes("delivery;pickup;delivery"),
    { kind: "codes", codes: ["delivery", "pickup"] },
    "doublon supprimé, première occurrence conservée"
  );
  assert.deepEqual(coerceAllowedSaleModes("PICKUP ; Room_Service"), { kind: "codes", codes: ["pickup", "room_service"] });
});

test("[A] coerceAllowedSaleModes : la virgule N'est PAS un séparateur (format d'échange strict, distinct de « Tags / Collections »)", () => {
  // "pickup, delivery" est un jeton unique non reconnu -> invalide,
  // jamais silencieusement découpé comme le ferait splitTagsColumn.
  assert.deepEqual(coerceAllowedSaleModes("pickup, delivery"), { kind: "invalid" });
});

test("[A] coerceAllowedSaleModes : un seul jeton invalide bloque TOUTE la cellule, jamais un repli silencieux qui ignorerait juste ce jeton", () => {
  assert.deepEqual(coerceAllowedSaleModes("pickup ; retrait"), { kind: "invalid" }, "'retrait' n'est pas un code -- toute la cellule est invalide");
  assert.deepEqual(coerceAllowedSaleModes("emporter"), { kind: "invalid" });
  assert.deepEqual(coerceAllowedSaleModes("à emporter"), { kind: "invalid" }, "le libellé client n'est PAS un alias accepté (décision CIO v1)");
});

test("[A] SALE_MODE_CODES contient exactement les 5 codes du référentiel serveur, en ordre canonique", () => {
  assert.deepEqual([...SALE_MODE_CODES], ["table", "pickup", "click_collect", "room_service", "delivery"]);
});

// ==================================================================
// B. PREVIEW -- produit NOUVEAU
// ==================================================================

test("[B] PREVIEW : produit NOUVEAU, cellule vide -> allowedSaleModesToWrite = null (ALL, défaut serveur)", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24" } }],
    [makeCategory({ category_id: "cat-fromages", category_name: "Fromages" })],
    []
  );
  assert.equal(report.rows[0].plannedAction, "CREATE");
  assert.equal(report.rows[0].allowedSaleModesToWrite, null);
});

test("[B] PREVIEW : produit NOUVEAU, codes valides -> allowedSaleModesToWrite = exactement ce jeu (ordre canonique)", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", [SALE_MODE_COLUMN]: "delivery ; pickup" } }],
    [makeCategory({ category_id: "cat-fromages", category_name: "Fromages" })],
    []
  );
  assert.deepEqual(report.rows[0].allowedSaleModesToWrite, ["pickup", "delivery"]);
});

test("[B] PREVIEW : produit NOUVEAU, « Tous » explicite -> allowedSaleModesToWrite = null (même résultat que vide, mais valeur EXPLICITE)", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", [SALE_MODE_COLUMN]: "Tous" } }],
    [makeCategory({ category_id: "cat-fromages", category_name: "Fromages" })],
    []
  );
  assert.equal(report.rows[0].allowedSaleModesToWrite, null);
});

// ==================================================================
// C. PREVIEW -- produit EXISTANT restreint, cellule VIDE = LE COEUR
//    DU DÉFAUT CORRIGÉ
// ==================================================================

test("[C] PREVIEW : produit EXISTANT restreint (room_service), cellule VIDE = restriction ACTUELLE reconduite, jamais ALL -- ligne SKIP", () => {
  const existing = [
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({
          product_id: "p-victor",
          name: "Coffret de Victor",
          price: 24,
          allowed_sale_modes: ["room_service"],
        }),
      ],
    }),
  ];

  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24" } }],
    existing,
    []
  );

  assert.deepEqual(
    report.rows[0].allowedSaleModesToWrite,
    ["room_service"],
    "une cellule vide ne remet JAMAIS une restriction à ALL"
  );
  assert.equal(report.rows[0].plannedAction, "SKIP", "aucune valeur ne change -> aucune écriture inutile");
});

test("[C] PREVIEW : produit EXISTANT restreint, le marchand change SEULEMENT le prix (cellule Modes de vente toujours vide) -> restriction reconduite, ligne UPDATE (le prix a changé, pas la restriction)", () => {
  const existing = [
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({
          product_id: "p-victor",
          name: "Coffret de Victor",
          price: 24,
          allowed_sale_modes: ["room_service"],
        }),
      ],
    }),
  ];

  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "29" } }],
    existing,
    []
  );

  assert.equal(report.rows[0].plannedAction, "UPDATE", "le prix a changé");
  assert.deepEqual(
    report.rows[0].allowedSaleModesToWrite,
    ["room_service"],
    "la restriction survit à un UPDATE déclenché par un AUTRE champ"
  );
});

// ==================================================================
// D. PREVIEW -- « Tous » explicite efface, ordre différent = pas de
//    faux UPDATE
// ==================================================================

test("[D] PREVIEW : « Tous » sur un produit restreint EFFACE explicitement -> UPDATE vers null", () => {
  const existing = [
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({ product_id: "p-victor", name: "Coffret de Victor", price: 24, allowed_sale_modes: ["room_service"] }),
      ],
    }),
  ];

  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", [SALE_MODE_COLUMN]: "Tous" } }],
    existing,
    []
  );

  assert.equal(report.rows[0].allowedSaleModesToWrite, null);
  assert.equal(report.rows[0].plannedAction, "UPDATE", "Tous efface explicitement une restriction existante");
});

test("[D] PREVIEW : mêmes codes en ORDRE DIFFÉRENT dans la cellule -> comparaison en ENSEMBLE, ligne SKIP (pas de faux UPDATE)", () => {
  const existing = [
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({
          product_id: "p-victor",
          name: "Coffret de Victor",
          price: 24,
          allowed_sale_modes: ["pickup", "delivery"],
        }),
      ],
    }),
  ];

  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", [SALE_MODE_COLUMN]: "delivery ; pickup" } }],
    existing,
    []
  );

  assert.equal(report.rows[0].plannedAction, "SKIP", "même ensemble, ordre différent -> aucun changement réel");
});

// ==================================================================
// E. EXPORT -- format des cellules
// ==================================================================

test("[E] EXPORT : allowed_sale_modes = null -> littéral « Tous »", () => {
  const flat = flattenCatalogue([
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [makeProduct({ product_id: "p-victor", name: "Coffret de Victor", allowed_sale_modes: null })],
    }),
  ]);
  const rows = buildExportRows(flat);
  assert.equal(rows[0][EXPORT_COLUMNS.indexOf(SALE_MODE_COLUMN)], "Tous");
});

test("[E] EXPORT : allowed_sale_modes = codes -> ordre CANONIQUE joint par « ; », jamais l'ordre serveur brut", () => {
  const flat = flattenCatalogue([
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({ product_id: "p-victor", name: "Coffret de Victor", allowed_sale_modes: ["delivery", "pickup"] }),
      ],
    }),
  ]);
  const rows = buildExportRows(flat);
  assert.equal(rows[0][EXPORT_COLUMNS.indexOf(SALE_MODE_COLUMN)], "pickup ; delivery");
});

// ==================================================================
// F. ALLER-RETOUR COMPLET -- idempotence pickup-only (exigée par la
//    CIO explicitement)
// ==================================================================

test("[F] ALLER-RETOUR COMPLET : un produit pickup-only exporté puis réimporté SANS modification reste en SKIP (idempotence)", async (t) => {
  const flat = flattenCatalogue([
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({ product_id: "p-victor", name: "Coffret de Victor", price: 24, allowed_sale_modes: ["pickup"] }),
      ],
    }),
  ]);
  const bytes = buildCatalogueExport(flat);
  const file = new File(
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
    "catalogue-complet.xlsx",
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
  );

  const h: ImportHarness = {
    rpcCalls: [],
    catalogueRows: [
      catalogueRow({
        product_id: "p-victor",
        name: "Coffret de Victor",
        price: 24,
        is_available: true,
        display_order: 1,
        is_option_source: false,
        allowed_sale_modes: ["pickup"],
      }),
    ],
  };
  installImportMocks(t, h);

  const result = await commitCatalogueImport(file, RESTO_VICTOR);
  assert.equal(result.kind, "COMMITTED");
  assert.equal(
    h.rpcCalls.some((c) => c.name === "update_product" || c.name === "create_product"),
    false,
    "un ré-import à l'identique ne doit déclencher AUCUNE écriture -- preuve directe d'idempotence"
  );
});

// ==================================================================
// G. ALLER-RETOUR COMPLET -- LE DÉFAUT LUI-MÊME : bulk edit d'un
//    AUTRE champ ne doit plus effacer la restriction
// ==================================================================

test("[G] ALLER-RETOUR COMPLET : le marchand modifie SEULEMENT le prix dans le fichier réimporté -- la restriction room_service survit au commit RPC réel (le défaut identifié dans l'analyse d'impact est fermé)", async (t) => {
  const file = new File(
    [
      // Reproduit exactement le geste marchand décrit dans l'analyse
      // d'impact (issuecomment-5876972459) : exporter, modifier UN
      // champ (le prix), réimporter -- la cellule "Modes de vente" du
      // fichier réimporté est laissée VIDE (comme le ferait un
      // marchand qui ignore/n'a pas encore cette colonne dans son
      // habitude, ou l'efface par erreur).
      Buffer.from(""), // remplacé ci-dessous par un vrai classeur
    ],
    "placeholder.xlsx"
  );
  void file; // le classeur réel est construit ci-dessous via buildImportXlsx

  const { buildImportXlsx } = await import("./helpers/xlsx-fixture-builder.ts");
  const buf = buildImportXlsx(FULL_HEADER, [
    productFileRow({ Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "29" }),
  ]);
  const realFile = new File([buf], "victor-prix-modifie.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const h: ImportHarness = {
    rpcCalls: [],
    catalogueRows: [
      catalogueRow({
        product_id: "p-victor",
        name: "Coffret de Victor",
        price: 24,
        is_available: true,
        display_order: 1,
        is_option_source: false,
        allowed_sale_modes: ["room_service"],
      }),
    ],
  };
  installImportMocks(t, h);

  const result = await commitCatalogueImport(realFile, RESTO_VICTOR);
  assert.equal(result.kind, "COMMITTED");

  const update = h.rpcCalls.find((c) => c.name === "update_product");
  assert.ok(update, "le prix a changé, un UPDATE doit avoir lieu");
  assert.deepEqual(
    update!.args.p_allowed_sale_modes,
    ["room_service"],
    "AVANT ce lot : p_allowed_sale_modes valait toujours null (ALL) ici, effaçant silencieusement la restriction -- c'est exactement le défaut fermé par ce lot"
  );
});

// ==================================================================
// H. FAIL CLOSED
// ==================================================================

test("[H] un code invalide dans « Modes de vente » produit un diagnostic BLOQUANT de LIGNE, jamais un « Tous » silencieux", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", [SALE_MODE_COLUMN]: "pickup ; retrait" } }],
    [makeCategory({ category_id: "cat-fromages", category_name: "Fromages" })],
    []
  );

  const row = report.rows[0];
  const issue = row.errors.find((e) => e.code === "SCANYM_IMPORT_INVALID_SALE_MODE");
  assert.ok(issue, "diagnostic SCANYM_IMPORT_INVALID_SALE_MODE absent");
  assert.equal(issue!.severity, "BLOCKING_ERROR");
  assert.equal(issue!.field, SALE_MODE_COLUMN);
  assert.equal(issue!.message, SALE_MODE_INVALID_MESSAGE);
  assert.equal(row.status, "BLOCKED");
  assert.equal(row.plannedAction, "BLOCKED");
  assert.equal(report.eligibility, "NOT_ELIGIBLE");
  assert.deepEqual(row.normalizedValues.allowedSaleModesRaw, { kind: "invalid" });
});

// ==================================================================
// I. Rétro-compatibilité -- fichier ANTÉRIEUR à ce lot
// ==================================================================

test("[I] un fichier SANS la colonne « Modes de vente » du tout s'importe exactement comme avant ce lot (produit nouveau -> ALL, produit existant restreint -> restriction inchangée)", async (t) => {
  const HEADER_WITHOUT_SALE_MODES = FULL_HEADER.filter((c) => c !== SALE_MODE_COLUMN);
  const COL2 = Object.fromEntries(HEADER_WITHOUT_SALE_MODES.map((c, i) => [c, i])) as Record<string, number>;
  function rowWithout(values: Partial<Record<string, string | number>>): (string | number | null)[] {
    const row: (string | number | null)[] = HEADER_WITHOUT_SALE_MODES.map(() => "");
    row[COL2["Type"]] = "Produit";
    for (const [column, value] of Object.entries(values)) row[COL2[column]] = value ?? "";
    return row;
  }

  const { buildImportXlsx } = await import("./helpers/xlsx-fixture-builder.ts");
  const buf = buildImportXlsx(HEADER_WITHOUT_SALE_MODES, [
    rowWithout({ Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "29" }),
  ]);
  const file = new File([buf], "ancien-format.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const h: ImportHarness = {
    rpcCalls: [],
    catalogueRows: [
      catalogueRow({
        product_id: "p-victor",
        name: "Coffret de Victor",
        price: 24,
        is_available: true,
        display_order: 1,
        is_option_source: false,
        allowed_sale_modes: ["room_service"],
      }),
    ],
  };
  installImportMocks(t, h);

  const result = await commitCatalogueImport(file, RESTO_VICTOR);
  assert.equal(result.kind, "COMMITTED");
  const update = h.rpcCalls.find((c) => c.name === "update_product");
  assert.ok(update);
  assert.deepEqual(update!.args.p_allowed_sale_modes, ["room_service"], "colonne absente -> restriction préservée");
});

// ==================================================================
// J. i18n
// ==================================================================

test("[J] i18n : le message du diagnostic et la clé catalogueImportSaleModeInvalid ne peuvent pas diverger", () => {
  assert.equal(translate("fr", "catalogueImportSaleModeInvalid"), SALE_MODE_INVALID_MESSAGE);
  for (const lang of ["fr", "en", "ar"] as const) {
    const value = DICTS[lang]?.["catalogueImportSaleModeInvalid" as keyof (typeof DICTS)[typeof lang]];
    assert.ok(typeof value === "string" && value.trim().length > 0, `${lang}.catalogueImportSaleModeInvalid manquant`);
  }
});
