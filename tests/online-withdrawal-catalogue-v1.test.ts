import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — ONLINE WITHDRAWAL v1 — CÔTÉ MARCHAND (catalogue).
//
// `menu_items.withdrawal_eligible` est une classification
// OPÉRATIONNELLE posée par le MARCHAND (voir
// supabase/DRAFT-lot-online-withdrawal-foundation-v1.sql) : attribut
// strictement INTERNE, jamais exposé au client.
//
// Ce fichier prouve, en logique PURE (aucun DOM), que :
//   [A] un NOUVEAU produit vaut « Non » par défaut -- jamais « Oui »
//       par omission, à aucun étage (service, import) ;
//   [B] créer/modifier un produit transmet bien « Oui » ou « Non » aux
//       RPC create_product / update_product, et la valeur revient par
//       get_merchant_catalogue ;
//   [C] le filtre de liste à trois états (Tous / Oui / Non) retient
//       exactement les bons produits ;
//   [D] l'export XLSX écrit EXACTEMENT « Oui » / « Non » ;
//   [E] l'aller-retour XLSX (export -> réimport, puis preview ->
//       commit) préserve la valeur, y compris la sémantique de la
//       cellule VIDE (inchangée pour un produit existant, « Non »
//       pour un produit nouveau) ;
//   [F] une valeur XLSX invalide produit un diagnostic de LIGNE et
//       n'est JAMAIS convertie silencieusement en « Non » (fail closed).
//
// Le comportement d'ÉCRAN (formulaire produit + sélecteur de filtre)
// est prouvé séparément par
// tests/online-withdrawal-catalogue-v1-dom.test.ts.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { createProduct, updateProduct, getMerchantCatalogue } = await import("../lib/services/dashboard.ts");
const { commitCatalogueImport } = await import("../lib/services/catalogue-import-commit.ts");
const { analyzeCatalogueImportFile } = await import("../lib/services/catalogue-import.ts");
const { flattenCatalogue, applyCatalogueFilters, isDefaultFilters, EMPTY_FILTERS } = await import(
  "../lib/catalogue-management/filtering.ts"
);
const { buildExportRows, buildCatalogueExport, EXPORT_COLUMNS } = await import(
  "../lib/catalogue-management/export.ts"
);
const { IMPORT_COLUMNS, REQUIRED_IMPORT_COLUMNS, resolveColumnMap } = await import(
  "../lib/catalogue-import/column-mapping.ts"
);
const { coerceWithdrawalEligible } = await import("../lib/catalogue-import/normalization.ts");
const { buildPreviewReport } = await import("../lib/catalogue-import/preview.ts");
const { WITHDRAWAL_ELIGIBLE_INVALID_MESSAGE } = await import("../lib/catalogue-import/validation.ts");
const { readXlsxWorkbook } = await import("../lib/catalogue-import/xlsx-reader.ts");
const { buildImportXlsx } = await import("./helpers/xlsx-fixture-builder.ts");
const { makeCategory, makeProduct } = await import("./helpers/catalogue-fixtures.ts");
const { DICTS, translate } = await import("../lib/i18n.ts");

// ------------------------------------------------------------------
// Fixtures -- deux commerçants, Victor et Hugo.
// ------------------------------------------------------------------

const RESTO_VICTOR = "resto-victor";

const WITHDRAWAL_COLUMN = "Rétractable";

function xlsxFile(name: string, header: string[], rows: (string | number | null)[][]): File {
  const buf = buildImportXlsx(header, rows);
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** En-tête complet du format d'import, colonne « Rétractable »
 *  comprise -- dérivé de IMPORT_COLUMNS, jamais recopié à la main. */
const FULL_HEADER = [...IMPORT_COLUMNS];

const COL = Object.fromEntries(IMPORT_COLUMNS.map((c, i) => [c, i])) as Record<string, number>;

/** Ligne de fichier PRODUIT, positionnée par NOM de colonne. */
function productFileRow(values: Partial<Record<string, string | number>>): (string | number | null)[] {
  const row: (string | number | null)[] = FULL_HEADER.map(() => "");
  row[COL["Type"]] = "Produit";
  for (const [column, value] of Object.entries(values)) row[COL[column]] = value ?? "";
  return row;
}

// ==================================================================
// Bloc commun -- harnais RPC pour l'import (preview + commit)
// ==================================================================

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

// ==================================================================
// A. Défaut « Non » -- jamais « Oui » par omission
// ==================================================================

test("[A] createProduct sans valeur de rétractabilité transmet p_withdrawal_eligible = false -- un NOUVEAU produit de Victor n'est jamais rétractable par omission", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return { data: "prod-1", error: null };
  });

  await createProduct("cat-fromages", "Tomme de Victor", null, 9.9);

  assert.equal(calls[0].name, "create_product");
  assert.equal(calls[0].args.p_withdrawal_eligible, false);
});

test("[A] getMerchantCatalogue : colonne ABSENTE (base non encore migrée) -> false, jamais true -- repli FAIL-CLOSED", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [catalogueRow({ product_id: "p-victor", name: "Tomme de Victor", price: 9.9, is_available: true, display_order: 1, is_option_source: false, withdrawal_eligible: undefined })],
    error: null,
  }));

  const categories = await getMerchantCatalogue(RESTO_VICTOR);
  assert.equal(categories[0].products[0].withdrawal_eligible, false);
});

test("[A] IMPORT : produit NOUVEAU dont la cellule « Rétractable » est VIDE -> créé à « Non » (false), jamais true", async (t) => {
  const h: ImportHarness = { rpcCalls: [], catalogueRows: [catalogueRow()] };
  installImportMocks(t, h);

  const file = xlsxFile(
    "victor.xlsx",
    FULL_HEADER,
    [productFileRow({ Nom: "Tomme de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": 9.9, "TVA (%)": 5.5 })]
  );
  const result = await commitCatalogueImport(file, RESTO_VICTOR);

  assert.equal(result.kind, "COMMITTED");
  const create = h.rpcCalls.find((c) => c.name === "create_product")!;
  assert.equal(create.args.p_withdrawal_eligible, false, "cellule vide + produit nouveau = Non");
});

// ==================================================================
// B. Créer / modifier : « Oui » et « Non » explicites
// ==================================================================

test("[B] createProduct transmet p_withdrawal_eligible = true quand Victor choisit « Oui »", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return { data: "prod-1", error: null };
  });

  await createProduct("cat-fromages", "Coffret de Victor", null, 24, null, { withdrawalEligible: true });
  assert.equal(calls[0].args.p_withdrawal_eligible, true);
});

test("[B] updateProduct transmet la valeur des DEUX sens (Oui -> Non et Non -> Oui) : update_product réécrit toujours la colonne", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return { data: null, error: null };
  });

  await updateProduct("prod-hugo", "Coffret de Hugo", null, 24, null, { withdrawalEligible: true });
  await updateProduct("prod-hugo", "Coffret de Hugo", null, 24, null, { withdrawalEligible: false });

  assert.equal(calls[0].name, "update_product");
  assert.equal(calls[0].args.p_withdrawal_eligible, true);
  assert.equal(calls[1].args.p_withdrawal_eligible, false);
});

test("[B] getMerchantCatalogue expose withdrawal_eligible tel quel -- c'est la valeur que le formulaire d'édition rechargera", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [
      catalogueRow({ product_id: "p-victor", name: "Coffret de Victor", price: 24, is_available: true, display_order: 1, is_option_source: false, withdrawal_eligible: true }),
      catalogueRow({ product_id: "p-hugo", name: "Tomme de Hugo", price: 9.9, is_available: true, display_order: 2, is_option_source: false, withdrawal_eligible: false }),
    ],
    error: null,
  }));

  const categories = await getMerchantCatalogue(RESTO_VICTOR);
  const byId = new Map(categories[0].products.map((p) => [p.product_id, p.withdrawal_eligible]));
  assert.equal(byId.get("p-victor"), true);
  assert.equal(byId.get("p-hugo"), false);
});

// ==================================================================
// C. Filtre de liste à trois états (Tous / Oui / Non)
// ==================================================================

const CATALOGUE_VICTOR_HUGO = [
  makeCategory({
    category_id: "cat-fromages",
    category_name: "Fromages",
    products: [
      makeProduct({ product_id: "p-victor", name: "Coffret de Victor", withdrawal_eligible: true }),
      makeProduct({ product_id: "p-hugo", name: "Tomme de Hugo", withdrawal_eligible: false }),
    ],
  }),
];

test("[C] filtre « Tous » (null) : aucun produit n'est masqué", () => {
  const flat = flattenCatalogue(CATALOGUE_VICTOR_HUGO);
  const out = applyCatalogueFilters(flat, { ...EMPTY_FILTERS, withdrawalEligible: null });
  assert.deepEqual(out.map((f) => f.product.product_id).sort(), ["p-hugo", "p-victor"]);
});

test("[C] filtre « Oui » / « Non » : exactement les produits concernés, dans les deux sens", () => {
  const flat = flattenCatalogue(CATALOGUE_VICTOR_HUGO);
  assert.deepEqual(
    applyCatalogueFilters(flat, { ...EMPTY_FILTERS, withdrawalEligible: true }).map((f) => f.product.product_id),
    ["p-victor"]
  );
  assert.deepEqual(
    applyCatalogueFilters(flat, { ...EMPTY_FILTERS, withdrawalEligible: false }).map((f) => f.product.product_id),
    ["p-hugo"]
  );
});

test("[C] le filtre « Rétractable » se COMBINE en ET avec les autres critères, et « Tous » est bien l'état par défaut", () => {
  const flat = flattenCatalogue(CATALOGUE_VICTOR_HUGO);
  assert.equal(EMPTY_FILTERS.withdrawalEligible, null, "état par défaut = Tous");
  assert.equal(isDefaultFilters(EMPTY_FILTERS), true);
  assert.equal(
    isDefaultFilters({ ...EMPTY_FILTERS, withdrawalEligible: false }),
    false,
    "« Non » est un filtre ACTIF (le bouton de réinitialisation doit apparaître), jamais confondu avec « Tous »"
  );

  // ET avec la recherche : « Victor » + Rétractable=Non ne retient rien.
  assert.deepEqual(
    applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "Victor", withdrawalEligible: false }),
    []
  );
});

// ==================================================================
// D. Export XLSX
// ==================================================================

test("[D] l'export écrit EXACTEMENT « Oui » / « Non » dans la colonne « Rétractable »", () => {
  const flat = flattenCatalogue(CATALOGUE_VICTOR_HUGO);
  const rows = buildExportRows(flat);
  const col = EXPORT_COLUMNS.indexOf(WITHDRAWAL_COLUMN);
  assert.ok(col >= 0, "colonne « Rétractable » absente de l'export");
  assert.equal(rows[0][col], "Oui");
  assert.equal(rows[1][col], "Non");
});

test("[D] « Rétractable » est une colonne d'IMPORT (aller-retour), pas une colonne supplémentaire purement informative", () => {
  assert.ok(IMPORT_COLUMNS.includes(WITHDRAWAL_COLUMN as any), "la colonne doit appartenir au format d'import");
  assert.equal(
    REQUIRED_IMPORT_COLUMNS.includes(WITHDRAWAL_COLUMN as any),
    false,
    "elle reste OPTIONNELLE : un fichier antérieur à ce lot doit rester importable"
  );
  // Elle est reconnue par le résolveur d'en-tête, donc jamais rangée
  // parmi les colonnes « non reconnues, ignorées ».
  const map = resolveColumnMap([...EXPORT_COLUMNS]);
  assert.ok(map.indexOf[WITHDRAWAL_COLUMN as never] !== undefined);
  assert.equal(map.unrecognizedHeaders.includes(WITHDRAWAL_COLUMN), false);
});

test("[D] le classeur exporté est relu par readXlsxWorkbook (lecteur d'import de PRODUCTION) avec « Oui »/« Non » intacts", () => {
  const flat = flattenCatalogue(CATALOGUE_VICTOR_HUGO);
  const bytes = buildCatalogueExport(flat);
  const sheet = readXlsxWorkbook(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  const col = EXPORT_COLUMNS.indexOf(WITHDRAWAL_COLUMN);
  assert.deepEqual(sheet.rows[0], [...EXPORT_COLUMNS]);
  assert.equal(sheet.rows[1][col], "Oui");
  assert.equal(sheet.rows[2][col], "Non");
});

// ==================================================================
// E. Aller-retour XLSX : preview + commit
// ==================================================================

test("[E] coerceWithdrawalEligible : « Oui »/« Non » tolérants à la casse, aux espaces et aux accents ; vide -> undefined ; inconnu -> null (INVALIDE, jamais false)", () => {
  for (const raw of ["Oui", "oui", "  OUI  ", "OuI"]) {
    assert.equal(coerceWithdrawalEligible(raw), true, `« ${raw} » devrait valoir Oui`);
  }
  for (const raw of ["Non", "non", " NON ", "nOn"]) {
    assert.equal(coerceWithdrawalEligible(raw), false, `« ${raw} » devrait valoir Non`);
  }
  assert.equal(coerceWithdrawalEligible(undefined), undefined, "colonne absente");
  assert.equal(coerceWithdrawalEligible(""), undefined, "cellule vide");
  assert.equal(coerceWithdrawalEligible("   "), undefined, "cellule blanche");
  for (const raw of ["true", "1", "peut-être", "O", "N", "yes"]) {
    assert.equal(coerceWithdrawalEligible(raw), null, `« ${raw} » doit être INVALIDE, jamais false`);
  }
});

test("[E] PREVIEW : la valeur du fichier traverse la preview -- « Oui » sur un produit nouveau planifie CREATE avec la valeur, « Non » sur un produit existant rétractable planifie UPDATE", () => {
  const existing = [
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({
          product_id: "p-hugo",
          name: "Tomme de Hugo",
          price: 9.9,
          tax_rate: 5.5,
          withdrawal_eligible: true,
        }),
      ],
    }),
  ];

  const report = buildPreviewReport(
    [
      { row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", "TVA (%)": "5.5", "Rétractable": "Oui" } },
      { row: 3, cells: { Nom: "Tomme de Hugo", "Catégorie parent": "Fromages", "Prix TTC (€)": "9.9", "TVA (%)": "5.5", "Rétractable": "Non" } },
    ],
    existing,
    []
  );

  const [nouveau, existant] = report.rows;
  assert.equal(nouveau.plannedAction, "CREATE");
  assert.equal(nouveau.withdrawalEligibleToWrite, true);
  assert.equal(existant.plannedAction, "UPDATE", "basculer Oui -> Non doit être un UPDATE, jamais un SKIP silencieux");
  assert.equal(existant.withdrawalEligibleToWrite, false);
});

test("[E] PREVIEW : cellule VIDE sur un produit EXISTANT = INCHANGÉ -- la valeur courante est reconduite et la ligne reste SKIP", () => {
  const existing = [
    makeCategory({
      category_id: "cat-fromages",
      category_name: "Fromages",
      products: [
        makeProduct({
          product_id: "p-victor",
          name: "Coffret de Victor",
          price: 24,
          tax_rate: 5.5,
          withdrawal_eligible: true,
        }),
      ],
    }),
  ];

  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", "TVA (%)": "5.5", "Rétractable": "" } }],
    existing,
    []
  );

  assert.equal(report.rows[0].withdrawalEligibleToWrite, true, "une cellule vide ne remet JAMAIS un « Oui » à « Non »");
  assert.equal(report.rows[0].plannedAction, "SKIP", "aucune valeur ne change -> aucune écriture inutile");
});

test("[E] ALLER-RETOUR COMPLET : l'export de Victor est réimporté tel quel -- « Oui » et « Non » arrivent jusqu'aux RPC du commit", async (t) => {
  // 1. Export du catalogue affiché (Coffret rétractable, Tomme non).
  const flat = flattenCatalogue(CATALOGUE_VICTOR_HUGO);
  const bytes = buildCatalogueExport(flat);
  const file = new File(
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
    "catalogue-complet.xlsx",
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
  );

  // 2. Réimport dans un catalogue où les deux valeurs sont INVERSÉES
  //    (Coffret à « Non », Tomme à « Oui ») : le fichier doit donc
  //    réellement basculer les deux, dans les deux sens.
  const h: ImportHarness = {
    rpcCalls: [],
    catalogueRows: [
      catalogueRow({ product_id: "p-victor", name: "Coffret de Victor", price: 0, is_available: true, display_order: 1, is_option_source: false, withdrawal_eligible: false }),
      catalogueRow({ product_id: "p-hugo", name: "Tomme de Hugo", price: 0, is_available: true, display_order: 2, is_option_source: false, withdrawal_eligible: true }),
    ],
  };
  installImportMocks(t, h);

  const result = await commitCatalogueImport(file, RESTO_VICTOR);
  assert.equal(result.kind, "COMMITTED");

  const updates = h.rpcCalls.filter((c) => c.name === "update_product");
  const byName = new Map(updates.map((c) => [c.args.p_name, c.args.p_withdrawal_eligible]));
  assert.equal(byName.get("Coffret de Victor"), true, "« Oui » exporté puis réimporté doit rester Oui");
  assert.equal(byName.get("Tomme de Hugo"), false, "« Non » exporté puis réimporté doit rester Non");
});

// ==================================================================
// F. FAIL CLOSED : valeur invalide
// ==================================================================

test("[F] une valeur « Rétractable » invalide produit un diagnostic BLOQUANT de LIGNE, jamais un « Non » silencieux", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": "24", "TVA (%)": "5.5", "Rétractable": "Peut-être" } }],
    [makeCategory({ category_id: "cat-fromages", category_name: "Fromages" })],
    []
  );

  const row = report.rows[0];
  const issue = row.errors.find((e) => e.code === "SCANYM_IMPORT_INVALID_WITHDRAWAL_ELIGIBLE");
  assert.ok(issue, "diagnostic SCANYM_IMPORT_INVALID_WITHDRAWAL_ELIGIBLE absent");
  assert.equal(issue!.severity, "BLOCKING_ERROR");
  assert.equal(issue!.field, WITHDRAWAL_COLUMN);
  assert.equal(issue!.message, WITHDRAWAL_ELIGIBLE_INVALID_MESSAGE);
  assert.equal(row.status, "BLOCKED");
  assert.equal(row.plannedAction, "BLOCKED");
  assert.equal(report.eligibility, "NOT_ELIGIBLE", "le fichier entier reste inéligible tant que la ligne est bloquée");
  // La valeur brute reste INVALIDE (`null`), jamais coercée en `false`.
  assert.equal(row.normalizedValues.withdrawalEligible, null);
});

test("[F] COMMIT : un fichier contenant une valeur invalide n'écrit RIEN -- aucune ligne, même valide, n'est appliquée", async (t) => {
  const h: ImportHarness = { rpcCalls: [], catalogueRows: [catalogueRow()] };
  installImportMocks(t, h);

  const file = xlsxFile("victor-invalide.xlsx", FULL_HEADER, [
    productFileRow({ Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": 24, "TVA (%)": 5.5, "Rétractable": "Peut-être" }),
    productFileRow({ Nom: "Tomme de Hugo", "Catégorie parent": "Fromages", "Prix TTC (€)": 9.9, "TVA (%)": 5.5, "Rétractable": "Oui" }),
  ]);

  const result = await commitCatalogueImport(file, RESTO_VICTOR);
  assert.equal(result.kind, "NOT_ELIGIBLE");
  assert.equal(
    h.rpcCalls.some((c) => c.name === "create_product" || c.name === "update_product"),
    false,
    "aucune écriture produit ne doit avoir lieu"
  );
});

test("[F] la valeur invalide est signalée PAR LIGNE (numéro de ligne du fichier), pas globalement", async (t) => {
  const h: ImportHarness = { rpcCalls: [], catalogueRows: [catalogueRow()] };
  installImportMocks(t, h);

  const file = xlsxFile("victor-invalide.xlsx", FULL_HEADER, [
    productFileRow({ Nom: "Tomme de Hugo", "Catégorie parent": "Fromages", "Prix TTC (€)": 9.9, "TVA (%)": 5.5, "Rétractable": "Oui" }),
    productFileRow({ Nom: "Coffret de Victor", "Catégorie parent": "Fromages", "Prix TTC (€)": 24, "TVA (%)": 5.5, "Rétractable": "OUI!" }),
  ]);

  const analysis = await analyzeCatalogueImportFile(file, RESTO_VICTOR);
  assert.equal(analysis.kind, "OK");
  if (analysis.kind !== "OK") return;

  const blocked = analysis.report.rows.filter((r) => r.status === "BLOCKED");
  assert.equal(blocked.length, 1, "une seule ligne bloquée");
  assert.equal(blocked[0].row, 3, "la ligne 3 du fichier (2e ligne de données) est la fautive");
  assert.ok(blocked[0].errors.some((e) => e.code === "SCANYM_IMPORT_INVALID_WITHDRAWAL_ELIGIBLE"));
  assert.equal(analysis.report.rows[0].status, "OK", "la ligne valide reste diagnostiquée OK");
});

// ==================================================================
// i18n et étanchéité de l'attribut interne
// ==================================================================

test("i18n : les clés du lot existent en fr, en ET ar, avec les valeurs françaises attendues", () => {
  const keys = [
    "catalogueWithdrawalEligibleLabel",
    "commonYes",
    "commonNo",
    "catalogueWithdrawalFilterAll",
    "catalogueImportWithdrawalInvalid",
  ];
  for (const lang of ["fr", "en", "ar"]) {
    for (const key of keys) {
      const value = DICTS[lang]?.[key];
      assert.ok(typeof value === "string" && value.trim() !== "", `clé ${key} absente ou vide en ${lang}`);
    }
  }
  assert.equal(translate("fr", "catalogueWithdrawalEligibleLabel"), "Rétractable");
  assert.equal(translate("fr", "commonYes"), "Oui");
  assert.equal(translate("fr", "commonNo"), "Non");
  assert.equal(translate("fr", "catalogueWithdrawalFilterAll"), "Tous");
});

test("i18n : le message du diagnostic d'import et la clé catalogueImportWithdrawalInvalid ne peuvent pas diverger", () => {
  assert.equal(translate("fr", "catalogueImportWithdrawalInvalid"), WITHDRAWAL_ELIGIBLE_INVALID_MESSAGE);
});

test("ÉTANCHÉITÉ : withdrawal_eligible n'apparaît dans AUCUN module de rendu client du catalogue", () => {
  // Attribut strictement MARCHAND (voir le commentaire de colonne de la
  // migration) : sa seule présence dans un module de rendu client
  // serait déjà une fuite, même sans affichage.
  //
  // `lib/services/restaurant.ts` est VOLONTAIREMENT exclu de cette
  // liste : c'est la FRONTIÈRE elle-même. Sa requête publique
  // sélectionne `menu_items(*)` puis ÉTALE l'objet obtenu, si bien que
  // toute nouvelle colonne serait exposée PAR CONSTRUCTION ; le nom de
  // l'attribut doit donc y apparaître, précisément pour l'en RETIRER.
  // C'est le test suivant -- un test de COMPORTEMENT, pas de texte --
  // qui prouve l'étanchéité de ce module.
  const publicModules = [
    "lib/menu-i18n.ts",
    "lib/customer-product-tags.ts",
    "lib/customer-collections.ts",
    "lib/sale-modes-public.ts",
  ];
  for (const file of publicModules) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(
      src.includes("withdrawal_eligible"),
      false,
      `${file} référence withdrawal_eligible -- attribut marchand interne, jamais exposé côté client`
    );
  }
});

test("ÉTANCHÉITÉ : la carte publique RETIRE réellement l'attribut, même si la base le renvoie", async () => {
  // Preuve de COMPORTEMENT : on fait répondre la requête publique
  // EXACTEMENT comme le ferait `menu_items(*)` sur une base migrée --
  // c'est-à-dire AVEC la colonne interne -- et on vérifie que la charge
  // utile rendue au navigateur ne la porte pas. Un test qui se
  // contenterait de lire le code source ne prouverait pas cela.
  const { supabase } = await import("../lib/supabase.ts");

  const rawItem = {
    id: "item-1",
    category_id: "cat-1",
    subcategory_id: null,
    name: "Coffret de Victor",
    price: 24,
    is_available: true,
    archived_at: null,
    display_order: 1,
    translations: null,
    // La colonne INTERNE, telle que la base la renvoie via `*`.
    withdrawal_eligible: true,
  };

  const response = {
    data: {
      id: "resto-1",
      name: "Chez Victor",
      slug: "chez-victor",
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      restaurant_configs: { id: "cfg-1" },
      menu_categories: [
        {
          id: "cat-1",
          display_order: 1,
          is_active: true,
          menu_subcategories: [],
          menu_items: [rawItem],
        },
      ],
      restaurant_active_languages: [],
    },
    error: null,
  };

  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = async () => response;

  const originalFrom = supabase.from;
  const originalRpc = supabase.rpc;
  (supabase as unknown as { from: unknown }).from = () => builder;
  (supabase as unknown as { rpc: unknown }).rpc = async () => ({ data: [], error: null });

  try {
    const { getRestaurantBySlug } = await import("../lib/services/restaurant.ts");
    const restaurant = await getRestaurantBySlug("chez-victor");
    assert.ok(restaurant, "carte publique rendue");
    const item = restaurant!.categories[0]!.menu_items[0]! as unknown as Record<string, unknown>;

    // Le produit est bien là…
    assert.equal(item.name, "Coffret de Victor");
    // …mais SANS l'attribut marchand, ni comme clé, ni comme valeur.
    assert.equal(
      Object.prototype.hasOwnProperty.call(item, "withdrawal_eligible"),
      false,
      "l'attribut marchand ne doit pas exister sur le produit public"
    );
    assert.ok(
      !JSON.stringify(restaurant).includes("withdrawal_eligible"),
      "l'attribut ne doit apparaître NULLE PART dans la charge utile sérialisée vers le navigateur"
    );
    // …et l'objet source n'est pas muté au passage.
    assert.equal(rawItem.withdrawal_eligible, true);
  } finally {
    (supabase as unknown as { from: unknown }).from = originalFrom;
    (supabase as unknown as { rpc: unknown }).rpc = originalRpc;
  }
});
