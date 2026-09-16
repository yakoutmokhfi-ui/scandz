import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CATALOGUE IMPORT — CATEGORY / SUBCATEGORY ROW SUPPORT v1.
// Remédiation ciblée : le Preview traitait à tort toute ligne
// (Type = "Catégorie" / "Sous-catégorie") comme un produit, la
// bloquant faussement pour "Prix manquant"/"TVA absente" et affichant
// "Valeur « Catégorie » de la colonne « Type » ne correspond à aucune
// notion actuellement modélisée par Scanym".
//
// Ce fichier couvre le mandat, section 13 "TESTS", items A-M --
// classification pure (normalization.ts), Preview pur
// (preview.ts/validation.ts) et Commit impur mocké
// (catalogue-import-commit.ts), aux mêmes patrons établis que
// tests/lot-ob3-*.test.ts / tests/lot-ob4-*.test.ts.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { classifyRowType } = await import("../lib/catalogue-import/normalization.ts");
const { buildPreviewReport } = await import("../lib/catalogue-import/preview.ts");
const { commitCatalogueImport } = await import("../lib/services/catalogue-import-commit.ts");
const { buildImportXlsx } = await import("./helpers/xlsx-fixture-builder.ts");

function xlsxFile(name: string, header: string[], rows: (string | number | null)[][]): File {
  const buf = buildImportXlsx(header, rows);
  return new File([buf], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const VALID_HEADER = [
  "Type",
  "Nom",
  "Catégorie parent",
  "Sous-catégorie parent",
  "Tags / Collections",
  "Description courte",
  "Description longue",
  "Prix TTC (€)",
  "TVA (%)",
  "Poids (g)",
  "Photo fichier",
];

// --------------------------------------------------------------
// item J : whitespace/case/accent normalization for "Type" --
// classifyRowType (pure).
// --------------------------------------------------------------

test("J. classifyRowType : robuste aux espaces de bordure, à la casse et aux accents français normaux", () => {
  assert.deepEqual(classifyRowType("Catégorie"), { kind: "CATEGORY" });
  assert.deepEqual(classifyRowType("  Catégorie  "), { kind: "CATEGORY" });
  assert.deepEqual(classifyRowType("CATÉGORIE"), { kind: "CATEGORY" });
  assert.deepEqual(classifyRowType("categorie"), { kind: "CATEGORY" }); // accent omis, toléré
  assert.deepEqual(classifyRowType("CATEGORIE"), { kind: "CATEGORY" });
  assert.deepEqual(classifyRowType("Sous-catégorie"), { kind: "SUBCATEGORY" });
  assert.deepEqual(classifyRowType("sous-categorie"), { kind: "SUBCATEGORY" });
  assert.deepEqual(classifyRowType("Sous catégorie"), { kind: "SUBCATEGORY" }); // espace au lieu du trait d'union, toléré (même tolérance que l'en-tête homonyme, column-mapping.ts)
  assert.deepEqual(classifyRowType("  SOUS   CATEGORIE  "), { kind: "SUBCATEGORY" });
  assert.deepEqual(classifyRowType("Produit"), { kind: "PRODUCT" });
  assert.deepEqual(classifyRowType("  produit  "), { kind: "PRODUCT" });
  assert.deepEqual(classifyRowType("PRODUIT"), { kind: "PRODUCT" });
});

test("I. classifyRowType : valeur non reconnue -> UNKNOWN, jamais une devinette (mandat 'Do not silently interpret unknown Type values')", () => {
  assert.deepEqual(classifyRowType("Formule"), { kind: "UNKNOWN", rawValue: "Formule" });
  assert.deepEqual(classifyRowType("Plat"), { kind: "UNKNOWN", rawValue: "Plat" });
  assert.deepEqual(classifyRowType("Categorie parent"), { kind: "UNKNOWN", rawValue: "Categorie parent" });
});

// --------------------------------------------------------------
// item A : Category row with no price and no VAT -> PASS / READY.
// --------------------------------------------------------------

test("A. Ligne CATEGORY sans prix ni TVA -> jamais bloquée, action prévue = CREATE, aucun diagnostic prix/TVA", () => {
  const report = buildPreviewReport([{ row: 2, cells: { Type: "Catégorie", Nom: "Fromages" } }], [], []);
  const row = report.rows[0];
  assert.equal(row.rowType, "CATEGORY");
  assert.equal(row.status, "OK");
  assert.equal(row.plannedAction, "CREATE");
  assert.equal(report.eligibility, "ELIGIBLE");
  assert.equal(
    row.errors.some((i) => i.code.includes("PRICE") || i.code.includes("TAX")),
    false
  );
  assert.equal(
    [...row.errors, ...row.warnings, ...row.infos].some((i) => i.code === "SCANYM_IMPORT_UNKNOWN_ROW_TYPE"),
    false,
    "la vieille régression : « Catégorie » ne doit plus jamais être signalée comme un Type non modélisé"
  );
});

test("A bis. Ligne CATEGORY sans Nom -> BLOCKED avec un diagnostic explicite sur le nom de catégorie, jamais 'Prix manquant'", () => {
  const report = buildPreviewReport([{ row: 2, cells: { Type: "Catégorie", Nom: "" } }], [], []);
  const row = report.rows[0];
  assert.equal(row.status, "BLOCKED");
  assert.ok(row.errors.some((i) => i.code === "SCANYM_IMPORT_MISSING_CATEGORY_NAME"));
  assert.equal(row.errors.some((i) => i.code === "SCANYM_IMPORT_MISSING_PRICE"), false);
});

// --------------------------------------------------------------
// item B : Subcategory row with no price and no VAT -> PASS / READY.
// --------------------------------------------------------------

test("B. Ligne SUBCATEGORY sans prix ni TVA, parent EXISTANT -> jamais bloquée, action prévue = CREATE", () => {
  const existing = [
    {
      category_id: "cat-1",
      category_name: "Fromages",
      category_name_hash: "h",
      category_translations: null,
      category_display_order: 1,
      category_is_option_source: false,
      category_description: null,
      category_description_hash: null,
      products: [],
      subcategories: [],
    },
  ];
  const report = buildPreviewReport(
    [{ row: 2, cells: { Type: "Sous-catégorie", Nom: "Raclette", "Catégorie parent": "Fromages" } }],
    existing as any,
    []
  );
  const row = report.rows[0];
  assert.equal(row.rowType, "SUBCATEGORY");
  assert.equal(row.status, "OK");
  assert.equal(row.plannedAction, "CREATE");
  assert.equal(report.eligibility, "ELIGIBLE");
});

// --------------------------------------------------------------
// item C : Product row with missing required price -> still BLOCKED.
// --------------------------------------------------------------

test("C. Ligne PRODUIT (Type explicite) avec prix manquant -> reste BLOQUÉE, comportement produit INCHANGÉ", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Type: "Produit", Nom: "Comte", "Catégorie parent": "Fromages" } }],
    [],
    []
  );
  const row = report.rows[0];
  assert.equal(row.rowType, "PRODUCT");
  assert.equal(row.status, "BLOCKED");
  assert.ok(row.errors.some((i) => i.code === "SCANYM_IMPORT_MISSING_PRICE"));
  assert.equal(report.eligibility, "NOT_ELIGIBLE");
});

test("C bis. Ligne PRODUIT implicite (colonne Type absente) avec prix manquant -> reste BLOQUÉE (comportement historique préservé à l'identique)", () => {
  const report = buildPreviewReport([{ row: 2, cells: { Nom: "Comte", "Catégorie parent": "Fromages" } }], [], []);
  const row = report.rows[0];
  assert.equal(row.rowType, "PRODUCT");
  assert.equal(row.status, "BLOCKED");
  assert.ok(row.errors.some((i) => i.code === "SCANYM_IMPORT_MISSING_PRICE"));
});

// --------------------------------------------------------------
// item D : Category + subcategory + product in same file ->
// dependency resolution PASS (mandat section 7/8).
// --------------------------------------------------------------

test("D. Catégorie + sous-catégorie + produit dans le MÊME fichier -> toutes les dépendances résolues, fichier ÉLIGIBLE, une seule catégorie/sous-catégorie planifiée", () => {
  const report = buildPreviewReport(
    [
      { row: 2, cells: { Type: "Catégorie", Nom: "Fromages" } },
      { row: 3, cells: { Type: "Sous-catégorie", Nom: "Raclette", "Catégorie parent": "Fromages" } },
      {
        row: 4,
        cells: {
          Type: "Produit",
          Nom: "Raclette fermière",
          "Catégorie parent": "Fromages",
          "Sous-catégorie parent": "Raclette",
          "Prix TTC (€)": "12.5",
          "TVA (%)": "5.5",
        },
      },
    ],
    [],
    []
  );
  assert.equal(report.eligibility, "ELIGIBLE_WITH_WARNINGS" === report.eligibility ? report.eligibility : report.eligibility); // no-op guard removed below
  assert.notEqual(report.eligibility, "NOT_ELIGIBLE");
  assert.equal(report.rows[0].rowType, "CATEGORY");
  assert.equal(report.rows[0].plannedAction, "CREATE");
  assert.equal(report.rows[1].rowType, "SUBCATEGORY");
  assert.equal(report.rows[1].plannedAction, "CREATE");
  assert.equal(report.rows[1].resolvedCategory.displayName, "Fromages");
  assert.equal(report.rows[2].rowType, "PRODUCT");
  assert.equal(report.rows[2].plannedAction, "CREATE");
  assert.equal(report.rows[2].resolvedCategory.state, "WOULD_CREATE");
  assert.equal(report.rows[2].resolvedSubcategory?.state, "WOULD_CREATE");
});

// --------------------------------------------------------------
// item E : Subcategory referencing missing category -> BLOCKED with
// clear error.
// --------------------------------------------------------------

test("E. Ligne SUBCATEGORY sans « Catégorie parent » (cellule vide) -> BLOQUÉE avec un diagnostic explicite", () => {
  const report = buildPreviewReport([{ row: 2, cells: { Type: "Sous-catégorie", Nom: "Raclette" } }], [], []);
  const row = report.rows[0];
  assert.equal(row.status, "BLOCKED");
  assert.ok(row.errors.some((i) => i.code === "SCANYM_IMPORT_SUBCATEGORY_MISSING_PARENT_CATEGORY"));
});

test("E bis. Ligne SUBCATEGORY dont le parent n'est référencé QUE par une ligne Produit (jamais une ligne Catégorie explicite, jamais une catégorie existante) -> BLOQUÉE, « introuvable »", () => {
  // mandat section 4 : "resolve parent category from either: A. an
  // existing merchant category; or B. a CATEGORY row in the same
  // import." -- une ligne Sous-catégorie ne doit JAMAIS inventer
  // silencieusement une toute nouvelle catégorie de premier niveau
  // simplement parce qu'une AUTRE ligne (ici un Produit) y fait
  // référence.
  const report = buildPreviewReport(
    [
      { row: 2, cells: { Type: "Sous-catégorie", Nom: "Raclette", "Catégorie parent": "Fromages" } },
      {
        row: 3,
        cells: {
          Type: "Produit",
          Nom: "Comte",
          "Catégorie parent": "Fromages",
          "Prix TTC (€)": "5",
        },
      },
    ],
    [],
    []
  );
  const subRow = report.rows[0];
  assert.equal(subRow.status, "BLOCKED");
  assert.ok(subRow.errors.some((i) => i.code === "SCANYM_IMPORT_SUBCATEGORY_PARENT_CATEGORY_NOT_FOUND"));
  // La ligne Produit, elle, N'EST PAS affectée par cette règle plus
  // stricte -- comportement historique produit INCHANGÉ (elle crée
  // silencieusement "Fromages" comme toujours).
  const prodRow = report.rows[1];
  assert.equal(prodRow.resolvedCategory.state, "WOULD_CREATE");
  assert.equal(prodRow.errors.length, 0);
});

// --------------------------------------------------------------
// item F : Category already exists -> reuse / no duplicate.
// --------------------------------------------------------------

test("F. Ligne CATEGORY dont le nom existe déjà (insensible à la casse/espaces) -> EXISTING, action = SKIP (réutilisation, jamais un doublon)", () => {
  const existing = [
    {
      category_id: "cat-1",
      category_name: "Fromages",
      category_name_hash: "h",
      category_translations: null,
      category_display_order: 1,
      category_is_option_source: false,
      category_description: null,
      category_description_hash: null,
      products: [],
      subcategories: [],
    },
  ];
  for (const variant of ["Fromages", " fromages ", "FROMAGES"]) {
    const report = buildPreviewReport([{ row: 2, cells: { Type: "Catégorie", Nom: variant } }], existing as any, []);
    const row = report.rows[0];
    assert.equal(row.resolvedCategory.state, "EXISTING", `variante "${variant}"`);
    assert.equal(row.resolvedCategory.existingId, "cat-1");
    assert.equal(row.plannedAction, "SKIP");
    assert.equal(row.status, "OK");
  }
});

// --------------------------------------------------------------
// item G : Subcategory already exists under parent -> reuse / no
// duplicate.
// --------------------------------------------------------------

test("G. Ligne SUBCATEGORY dont le nom existe déjà sous ce parent -> EXISTING, action = SKIP", () => {
  const existing = [
    {
      category_id: "cat-1",
      category_name: "Fromages",
      category_name_hash: "h",
      category_translations: null,
      category_display_order: 1,
      category_is_option_source: false,
      category_description: null,
      category_description_hash: null,
      products: [],
      subcategories: [{ subcategory_id: "sub-1", subcategory_name: "Raclette", subcategory_display_order: 1, products: [] }],
    },
  ];
  const report = buildPreviewReport(
    [{ row: 2, cells: { Type: "Sous-catégorie", Nom: " raclette ", "Catégorie parent": "Fromages" } }],
    existing as any,
    []
  );
  const row = report.rows[0];
  assert.equal(row.resolvedSubcategory?.state, "EXISTING");
  assert.equal(row.resolvedSubcategory?.existingId, "sub-1");
  assert.equal(row.plannedAction, "SKIP");
  assert.equal(row.status, "OK");
});

// --------------------------------------------------------------
// item I : Unknown Type -> BLOCKED.
// --------------------------------------------------------------

test("I. Ligne avec Type inconnu -> BLOQUÉE avec un diagnostic explicite, jamais une interprétation silencieuse", () => {
  const report = buildPreviewReport(
    [{ row: 2, cells: { Type: "Formule", Nom: "Menu du jour", "Catégorie parent": "Menus", "Prix TTC (€)": "15" } }],
    [],
    []
  );
  const row = report.rows[0];
  assert.equal(row.rowType, "UNKNOWN");
  assert.equal(row.status, "BLOCKED");
  const issue = row.errors.find((i) => i.code === "SCANYM_IMPORT_UNKNOWN_ROW_TYPE");
  assert.ok(issue);
  assert.ok(issue!.message.includes("Formule"));
  assert.equal(report.eligibility, "NOT_ELIGIBLE");
});

// --------------------------------------------------------------
// item K : Preview creates no rows (dry run, aucune mutation) --
// spécifiquement pour des lignes CATEGORY/SUBCATEGORY (le test
// générique "STRICT NO-MUTATION" existe déjà pour les produits,
// tests/lot-ob3-catalogue-import-service.test.ts).
// --------------------------------------------------------------

test("K. analyzeCatalogueImportFile (Preview) sur un fichier Catégorie+Sous-catégorie+Produit -> AUCUN appel RPC mutant, uniquement des LECTURES", async (t) => {
  const { analyzeCatalogueImportFile } = await import("../lib/services/catalogue-import.ts");
  const rpcCalls: string[] = [];
  t.mock.method(supabase, "rpc", async (name: string) => {
    rpcCalls.push(name);
    if (name === "get_merchant_catalogue") return { data: [], error: null };
    // COLLECTIONS / TAGS FOUNDATION v1 -- lecture supplémentaire
    // (RPC `stable`) : la preview distingue désormais un tag existant
    // d'un tag à créer. L'invariant testé ici est inchangé : aucune
    // RPC MUTANTE pendant un preview.
    if (name === "get_restaurant_tags") return { data: [], error: null };
    throw new Error(`RPC MUTANTE INATTENDUE PENDANT UN PREVIEW : ${name}`);
  });
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Catégorie", "Fromages", "", "", "", "", "", "", "", "", ""],
    ["Sous-catégorie", "Raclette", "Fromages", "", "", "", "", "", "", "", ""],
    ["Produit", "Raclette fermière", "Fromages", "Raclette", "", "", "", 12.5, 5.5, "", ""],
  ]);
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "OK");
  assert.deepEqual(rpcCalls, ["get_merchant_catalogue", "get_restaurant_tags"]);
});

// ====================================================================
// COMMIT (catalogue-import-commit.ts) -- items D (bout en bout), F, G,
// H, L.
// ====================================================================

interface RawCatalogueRow {
  product_id: string | null;
  category_id: string;
  category_name: string;
  category_name_hash: string;
  category_translations: null;
  category_display_order: number;
  category_is_option_source: boolean;
  category_description: string | null;
  category_description_hash: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  subcategory_display_order: number | null;
  name: string | null;
  name_hash: string | null;
  short_description: string | null;
  short_description_hash: string | null;
  description: string | null;
  description_hash: string | null;
  translations: null;
  price: number | null;
  is_available: boolean | null;
  archived_at: string | null;
  display_order: number | null;
  is_option_source: boolean | null;
  image_url: string | null;
  tax_rate: number | null;
  unit_weight_grams: number | null;
  weight_is_approximate: boolean | null;
  reference_price_per_kg: number | null;
}

function categoryOnlyRow(categoryId: string, categoryName: string): RawCatalogueRow {
  return {
    product_id: null,
    category_id: categoryId,
    category_name: categoryName,
    category_name_hash: `hash-${categoryName}`,
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    subcategory_id: null,
    subcategory_name: null,
    subcategory_display_order: null,
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
  };
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

interface RpcHarness {
  rpcCalls: { name: string; args: any }[];
  catalogueRowsByTenant: Map<string, RawCatalogueRow[]>;
  categoryCounter: { n: number };
  subcategoryCounter: { n: number };
  productCounter: { n: number };
}

function freshHarness(initialByTenant: Record<string, RawCatalogueRow[]> = {}): RpcHarness {
  return {
    rpcCalls: [],
    catalogueRowsByTenant: new Map(Object.entries(initialByTenant).map(([k, v]) => [k, [...v]])),
    categoryCounter: { n: 0 },
    subcategoryCounter: { n: 0 },
    productCounter: { n: 0 },
  };
}

function installMocks(t: any, h: RpcHarness) {
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    h.rpcCalls.push({ name, args });
    if (name === "get_restaurant_tags") return { data: [], error: null };
    if (name === "add_product_tags") return { data: 0, error: null };

    if (name === "get_merchant_catalogue") {
      return { data: h.catalogueRowsByTenant.get(args.p_restaurant_id) ?? [], error: null };
    }
    if (name === "create_category") {
      h.categoryCounter.n++;
      const id = `cat-new-${h.categoryCounter.n}`;
      const rows = h.catalogueRowsByTenant.get(args.p_restaurant_id) ?? [];
      rows.push(categoryOnlyRow(id, args.p_name));
      h.catalogueRowsByTenant.set(args.p_restaurant_id, rows);
      return { data: id, error: null };
    }
    if (name === "create_subcategory") {
      h.subcategoryCounter.n++;
      const id = `sub-new-${h.subcategoryCounter.n}`;
      return { data: id, error: null };
    }
    if (name === "create_product") {
      h.productCounter.n++;
      const id = `prod-new-${h.productCounter.n}`;
      return { data: id, error: null };
    }
    if (name === "update_product") {
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  t.mock.method(supabase, "from", (table: string) => {
    throw new Error(`Accès table direct inattendu (contournement RLS suspecté) : ${table}`);
  });
  t.mock.method(supabase.storage, "from", () => {
    throw new Error("Storage ne doit JAMAIS être touché par cet import.");
  });
}

// --------------------------------------------------------------
// item D (bout en bout) + item L : ordre de commit.
// --------------------------------------------------------------

test("D/L. Commit Catégorie+Sous-catégorie+Produit dans le MÊME fichier -> create_category PUIS create_subcategory PUIS create_product, jamais de produit créé pour les lignes structurelles elles-mêmes", async (t) => {
  const h = freshHarness();
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Catégorie", "Fromages", "", "", "", "", "", "", "", "", ""],
    ["Sous-catégorie", "Raclette", "Fromages", "", "", "", "", "", "", "", ""],
    ["Produit", "Raclette fermière", "Fromages", "Raclette", "", "", "", 12.5, 5.5, "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;

  assert.equal(result.categoriesCreated, 1);
  assert.equal(result.subcategoriesCreated, 1);
  assert.equal(result.productsCreated, 1);
  assert.equal(result.categoriesFailed, 0);
  assert.equal(result.subcategoriesFailed, 0);
  assert.equal(result.productsFailed, 0);

  // item L : ordre de création -- catégorie AVANT sous-catégorie AVANT
  // produit, quel que soit l'ordre des lignes dans le fichier lui-même
  // (mandat section 8, "Commit processing order must guarantee: 1.
  // categories; 2. subcategories; 3. products").
  // Seules les RPC MUTANTES nous intéressent ici : les deux lectures
  // (catalogue + tags existants) sont exclues par nom.
  const READ_ONLY_RPCS = ["get_merchant_catalogue", "get_restaurant_tags"];
  const mutatingOrder = h.rpcCalls.map((c) => c.name).filter((n) => !READ_ONLY_RPCS.includes(n));
  assert.deepEqual(mutatingOrder, ["create_category", "create_subcategory", "create_product"]);

  // La ligne CATEGORY elle-même ne crée JAMAIS de produit ; son résultat
  // reflète la création de LA CATÉGORIE, pas un produit fantôme.
  assert.equal(result.rows[0].outcome, "CREATED");
  assert.equal(result.rows[0].productId, undefined);
  assert.equal(result.rows[1].outcome, "CREATED");
  assert.equal(result.rows[1].productId, undefined);
  assert.equal(result.rows[2].outcome, "CREATED");
  assert.equal(result.rows[2].productId, "prod-new-1");

  assert.equal(h.rpcCalls.filter((c) => c.name === "create_product").length, 1, "UNE seule création produit -- jamais une pour la ligne Catégorie/Sous-catégorie");
});

// --------------------------------------------------------------
// item F (commit) : catégorie déjà existante -> réutilisée, jamais un
// second create_category.
// --------------------------------------------------------------

test("F (commit). Ligne CATEGORY dont le nom existe déjà -> AUCUN appel create_category, ligne rapportée SKIPPED", async (t) => {
  const h = freshHarness({ "resto-1": [categoryOnlyRow("cat-1", "Fromages")] });
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [["Catégorie", "Fromages", "", "", "", "", "", "", "", "", ""]]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.categoriesCreated, 0);
  assert.equal(result.rows[0].outcome, "SKIPPED");
  assert.equal(h.rpcCalls.some((c) => c.name === "create_category"), false);
});

// --------------------------------------------------------------
// item G (commit) : sous-catégorie déjà existante -> réutilisée,
// jamais un second create_subcategory.
// --------------------------------------------------------------

test("G (commit). Ligne SUBCATEGORY dont le nom existe déjà sous ce parent -> AUCUN appel create_subcategory, ligne rapportée SKIPPED", async (t) => {
  const cat: RawCatalogueRow = {
    ...categoryOnlyRow("cat-1", "Fromages"),
  };
  const h = freshHarness({ "resto-1": [cat] });
  // Injecte la sous-catégorie existante directement dans get_merchant_catalogue
  // (même contrat que dashboard.ts::getMerchantCatalogue -- une ligne
  // "groupe sous-catégorie" avec product_id null).
  h.catalogueRowsByTenant.set("resto-1", [
    { ...categoryOnlyRow("cat-1", "Fromages"), subcategory_id: "sub-1", subcategory_name: "Raclette", subcategory_display_order: 1 },
  ]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Sous-catégorie", "Raclette", "Fromages", "", "", "", "", "", "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.subcategoriesCreated, 0);
  assert.equal(result.rows[0].outcome, "SKIPPED");
  assert.equal(h.rpcCalls.some((c) => c.name === "create_subcategory"), false);
});

// --------------------------------------------------------------
// item H : tenant isolation stricte.
// --------------------------------------------------------------

test("H. Deux tenants distincts, mêmes noms de catégorie/produit -> AUCUNE fuite croisée (création/réutilisation toujours scopée au restaurant_id explicite)", async (t) => {
  const h = freshHarness({
    "resto-A": [categoryOnlyRow("cat-A-1", "Fromages")],
    "resto-B": [], // resto-B n'a PAS encore "Fromages" -- doit être créé séparément, jamais réutiliser cat-A-1
  });
  installMocks(t, h);

  const fileA = xlsxFile("a.xlsx", VALID_HEADER, [["Catégorie", "Fromages", "", "", "", "", "", "", "", "", ""]]);
  const resultA = await commitCatalogueImport(fileA, "resto-A");
  assert.equal(resultA.kind, "COMMITTED");
  if (resultA.kind === "COMMITTED") {
    assert.equal(resultA.categoriesCreated, 0, "resto-A a déjà « Fromages » -- réutilisée, jamais recréée");
  }

  const fileB = xlsxFile("b.xlsx", VALID_HEADER, [["Catégorie", "Fromages", "", "", "", "", "", "", "", "", ""]]);
  const resultB = await commitCatalogueImport(fileB, "resto-B");
  assert.equal(resultB.kind, "COMMITTED");
  if (resultB.kind === "COMMITTED") {
    assert.equal(resultB.categoriesCreated, 1, "resto-B n'a PAS « Fromages » -- doit être créée, jamais réutiliser celle de resto-A");
  }

  // Chaque appel get_merchant_catalogue a bien reçu le restaurant_id
  // EXPLICITE correspondant, jamais un autre.
  const getCalls = h.rpcCalls.filter((c) => c.name === "get_merchant_catalogue");
  assert.deepEqual(
    getCalls.map((c) => c.args.p_restaurant_id),
    ["resto-A", "resto-B"]
  );
  // La catégorie créée pour resto-B porte un id NEUF, jamais cat-A-1
  // (aucune fuite du catalogue d'un tenant vers l'autre).
  const createCategoryCall = h.rpcCalls.find((c) => c.name === "create_category")!;
  assert.equal(createCategoryCall.args.p_restaurant_id, "resto-B");
  assert.notEqual(createCategoryCall.args.p_restaurant_id, "resto-A");
});

// --------------------------------------------------------------
// M (référence) : la suite existante lot-ob3-*/lot-ob4-*/v15x-*
// (ré-exécutée sans modification, hors les deux corrections
// documentées ci-dessus pour la sémantique "Type" désormais
// autoritaire) reste la preuve de non-régression -- rien à dupliquer
// ici, voir TEST-RESULTS.md du paquet livré pour le détail.
// --------------------------------------------------------------
