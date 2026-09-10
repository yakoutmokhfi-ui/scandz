import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-4 v1.1 — CATALOGUE IMPORT COMMIT /
// IDEMPOTENCY.
//
// Preuve COMPORTEMENTALE (mock supabase.rpc, pas un grep de source pour
// le comportement -- même patron établi que
// tests/lot-ob3-catalogue-import-service.test.ts) que
// commitCatalogueImport :
//   - ne JAMAIS fait confiance à un PreviewReport fourni par l'appelant
//     (le SIGNATURE MÊME de la fonction ne l'accepte pas -- (file,
//     restaurantId) uniquement, revalidation TOUJOURS fraîche) ;
//   - refuse tout le fichier (aucune écriture) tant qu'un blocage
//     persiste après relecture fraîche ;
//   - crée catégorie/sous-catégorie AU PLUS UNE FOIS par clé normalisée,
//     même si plusieurs lignes la référencent ;
//   - CREATE / UPDATE / SKIP conformes au plannedAction recalculé ;
//   - convergence idempotente sous ré-exécution (exact retry, partiel) ;
//   - jamais Tags/Collections, jamais Photo, jamais Storage, jamais
//     accès table direct (RLS bypass), jamais restaurant_users.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { commitCatalogueImport } = await import("../lib/services/catalogue-import-commit.ts");
const { buildCommitPlan } = await import("../lib/catalogue-import/commit-plan.ts");
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

/** Ligne "groupe catégorie racine" (aucun produit) -- catégorie visible
 *  même vide (LEFT JOIN, voir getMerchantCatalogue). */
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

function productRow(opts: {
  productId: string;
  categoryId: string;
  categoryName: string;
  subcategoryId?: string | null;
  subcategoryName?: string | null;
  name: string;
  price: number;
  shortDescription?: string | null;
  description?: string | null;
  taxRate?: number | null;
  unitWeightGrams?: number | null;
  weightIsApproximate?: boolean;
}): RawCatalogueRow {
  return {
    ...categoryOnlyRow(opts.categoryId, opts.categoryName),
    product_id: opts.productId,
    subcategory_id: opts.subcategoryId ?? null,
    subcategory_name: opts.subcategoryName ?? null,
    subcategory_display_order: opts.subcategoryId ? 1 : null,
    name: opts.name,
    name_hash: `hash-${opts.name}`,
    short_description: opts.shortDescription ?? null,
    description: opts.description ?? null,
    price: opts.price,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: opts.taxRate ?? null,
    unit_weight_grams: opts.unitWeightGrams ?? null,
    weight_is_approximate: opts.weightIsApproximate ?? false,
    reference_price_per_kg: null,
  };
}

interface RpcHarness {
  rpcCalls: { name: string; args: any }[];
  catalogueRows: RawCatalogueRow[];
  categoryCounter: { n: number };
  productCounter: { n: number };
  subcategoryCounter: { n: number };
  /** Simule un doublon de nom actif déjà présent (course concurrente) --
   *  create_category/create_subcategory/create_product renverra
   *  l'erreur *_DUPLICATE_NAME pour ces clés. */
  forceDuplicateOnCategoryName?: Set<string>;
  forceDuplicateOnProductKey?: Set<string>; // `${categoryId}\0${normalizedName}`
  /** Force une erreur d'autorisation (42501) sur create_product pour
   *  ces noms de produit (test "unauthorized actor"). */
  forceUnauthorizedOnProductName?: Set<string>;
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

function installMocks(t: any, h: RpcHarness) {
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    h.rpcCalls.push({ name, args });

    if (name === "get_merchant_catalogue") {
      return { data: h.catalogueRows, error: null };
    }

    if (name === "create_category") {
      const key = normKey(args.p_name);
      if (h.forceDuplicateOnCategoryName?.has(key)) {
        return { data: null, error: { code: "23505", message: "SCANYM_CATEGORY_DUPLICATE_NAME" } };
      }
      h.categoryCounter.n++;
      const id = `cat-new-${h.categoryCounter.n}`;
      h.catalogueRows.push(categoryOnlyRow(id, args.p_name));
      return { data: id, error: null };
    }

    if (name === "create_subcategory") {
      h.subcategoryCounter.n++;
      const id = `sub-new-${h.subcategoryCounter.n}`;
      return { data: id, error: null };
    }

    if (name === "create_product") {
      const key = `${args.p_category_id}\0${normKey(args.p_name)}`;
      if (h.forceDuplicateOnProductKey?.has(key)) {
        return { data: null, error: { code: "23505", message: "SCANYM_PRODUCT_DUPLICATE_NAME" } };
      }
      if (h.forceUnauthorizedOnProductName?.has(args.p_name)) {
        return { data: null, error: { code: "42501", message: "Not authorized for this category" } };
      }
      h.productCounter.n++;
      const id = `prod-new-${h.productCounter.n}`;
      return { data: id, error: null };
    }

    if (name === "update_product") {
      return { data: null, error: null };
    }

    throw new Error(`RPC inattendue dans ce test OB-4 : ${name}`);
  });
  t.mock.method(supabase, "from", (table: string) => {
    throw new Error(`Accès table direct inattendu (contournement RLS suspecté) : ${table}`);
  });
  t.mock.method(supabase.storage, "from", () => {
    throw new Error("Storage ne doit JAMAIS être touché par OB-4 v1.1 (STRICT SCOPE)");
  });
}

function freshHarness(initialRows: RawCatalogueRow[] = []): RpcHarness {
  return {
    rpcCalls: [],
    catalogueRows: [...initialRows],
    categoryCounter: { n: 0 },
    productCounter: { n: 0 },
    subcategoryCounter: { n: 0 },
  };
}

// ------------------------------------------------------------------
// 1. create category + product
// ------------------------------------------------------------------
test("1. Nouvelle catégorie + nouveau produit -> create_category puis create_product, CREATED", async (t) => {
  const h = freshHarness([]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, 10, 350, ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.categoriesCreated, 1);
  assert.equal(result.productsCreated, 1);
  assert.equal(result.rows[0].outcome, "CREATED");
  assert.deepEqual(
    h.rpcCalls.map((c) => c.name),
    ["get_merchant_catalogue", "create_category", "create_product"]
  );
});

// ------------------------------------------------------------------
// 2. existing category + new product
// ------------------------------------------------------------------
test("2. Catégorie existante + nouveau produit -> AUCUN create_category, create_product seul", async (t) => {
  const h = freshHarness([categoryOnlyRow("cat-1", "Pizzas")]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.categoriesCreated, 0);
  assert.equal(result.productsCreated, 1);
  assert.deepEqual(
    h.rpcCalls.map((c) => c.name),
    ["get_merchant_catalogue", "create_product"]
  );
  assert.equal(h.rpcCalls[1].args.p_category_id, "cat-1");
});

// ------------------------------------------------------------------
// 3. create / use subcategory
// ------------------------------------------------------------------
test("3a. Sous-catégorie WOULD_CREATE -> create_subcategory puis create_product avec p_subcategory_id", async (t) => {
  const h = freshHarness([categoryOnlyRow("cat-1", "Fromages")]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Comte", "Fromages", "Chevres", "", "", "", 5, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.subcategoriesCreated, 1);
  assert.equal(result.productsCreated, 1);
  const subCall = h.rpcCalls.find((c) => c.name === "create_subcategory")!;
  assert.equal(subCall.args.p_category_id, "cat-1");
  assert.equal(subCall.args.p_name, "Chevres");
  const prodCall = h.rpcCalls.find((c) => c.name === "create_product")!;
  assert.equal(prodCall.args.p_subcategory_id, "sub-new-1");
});

test("3b. Deux lignes référençant la MÊME sous-catégorie nouvelle -> create_subcategory appelé UNE SEULE FOIS", async (t) => {
  const h = freshHarness([categoryOnlyRow("cat-1", "Fromages")]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Comte", "Fromages", "Chevres", "", "", "", 5, "", "", ""],
    ["Produit", "Crottin", "Fromages", "chevres", "", "", "", 6, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.subcategoriesCreated, 1, "une seule sous-catégorie créée malgré 2 lignes (casse différente, même clé normalisée)");
  assert.equal(result.productsCreated, 2);
  assert.equal(h.rpcCalls.filter((c) => c.name === "create_subcategory").length, 1);
});

// ------------------------------------------------------------------
// 6/7. UPDATE / SKIP
// ------------------------------------------------------------------
test("6. Produit existant, valeurs différentes -> UPDATE (update_product), jamais create_product pour cette ligne", async (t) => {
  const h = freshHarness([
    productRow({ productId: "prod-1", categoryId: "cat-1", categoryName: "Pizzas", name: "Pizza Margherita", price: 8.0 }),
  ]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.productsUpdated, 1);
  assert.equal(result.rows[0].outcome, "UPDATED");
  assert.equal(result.rows[0].productId, "prod-1");
  const updateCall = h.rpcCalls.find((c) => c.name === "update_product")!;
  assert.equal(updateCall.args.p_product_id, "prod-1");
  assert.equal(updateCall.args.p_price, 9.9);
  assert.equal(h.rpcCalls.some((c) => c.name === "create_product"), false);
});

test("7. Produit existant, valeurs STRICTEMENT identiques -> SKIP, AUCUN appel RPC mutant pour cette ligne", async (t) => {
  const h = freshHarness([
    productRow({ productId: "prod-1", categoryId: "cat-1", categoryName: "Pizzas", name: "Pizza Margherita", price: 9.9 }),
  ]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.productsSkipped, 1);
  assert.equal(result.rows[0].outcome, "SKIPPED");
  assert.equal(result.rows[0].productId, "prod-1");
  assert.deepEqual(
    h.rpcCalls.map((c) => c.name),
    ["get_merchant_catalogue"],
    "SKIP = aucune écriture, ni create_product ni update_product"
  );
});

// ------------------------------------------------------------------
// 8/9. BLOCKED / ambiguous -> NOT_ELIGIBLE, AUCUNE écriture
// ------------------------------------------------------------------
test("8. Une ligne BLOCKED (prix manquant) parmi plusieurs -> NOT_ELIGIBLE, ZÉRO écriture pour TOUT le fichier (pas seulement la ligne fautive)", async (t) => {
  const h = freshHarness([]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
    ["Produit", "Salade", "Salades", "", "", "", "", "", "", "", ""], // prix manquant -> BLOCKED
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "NOT_ELIGIBLE");
  if (result.kind !== "NOT_ELIGIBLE") return;
  assert.equal(result.report.blockedRows, 1);
  assert.deepEqual(
    h.rpcCalls.map((c) => c.name),
    ["get_merchant_catalogue"],
    "NOT_ELIGIBLE = aucune écriture, même pour les lignes par ailleurs valides"
  );
});

test("9. Catégorie ambiguë (2 catégories existantes de même clé normalisée) -> NOT_ELIGIBLE, ZÉRO écriture", async (t) => {
  const h = freshHarness([categoryOnlyRow("cat-a", "Pizzas"), categoryOnlyRow("cat-b", "pizzas")]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "NOT_ELIGIBLE");
  if (result.kind !== "NOT_ELIGIBLE") return;
  assert.equal(result.report.rows[0].resolvedCategory.state, "AMBIGUOUS");
  assert.deepEqual(
    h.rpcCalls.map((c) => c.name),
    ["get_merchant_catalogue"]
  );
});

// ------------------------------------------------------------------
// 10. unauthorized actor
// ------------------------------------------------------------------
test("10. create_product refuse (42501, acteur non autorisé) -> ligne FAILED, message propagé, AUTRES lignes non affectées (best-effort)", async (t) => {
  const h = freshHarness([]);
  h.forceUnauthorizedOnProductName = new Set(["Pizza Interdite"]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Interdite", "Pizzas", "", "", "", "", 9.9, "", "", ""],
    ["Produit", "Salade OK", "Salades", "", "", "", "", 5, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.productsFailed, 1);
  assert.equal(result.productsCreated, 1);
  assert.equal(result.rows[0].outcome, "FAILED");
  assert.match(result.rows[0].errorMessage ?? "", /Not authorized/);
  assert.equal(result.rows[1].outcome, "CREATED", "une ligne en échec n'empêche jamais l'exécution des lignes suivantes");
});

// ------------------------------------------------------------------
// 11. cross-tenant denial
// ------------------------------------------------------------------
test("11. get_merchant_catalogue refuse (cross-tenant) -> STRUCTURAL_ERROR TENANT_ACCESS_DENIED, AUCUNE tentative d'écriture", async (t) => {
  const h = freshHarness([]);
  installMocks(t, h);
  t.mock.method(supabase, "rpc", async (name: string) => {
    h.rpcCalls.push({ name, args: {} });
    if (name === "get_merchant_catalogue") return { data: null, error: { message: "Not authorized for this restaurant" } };
    throw new Error(`RPC inattendue : ${name}`);
  });
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, "", "", ""],
  ]);
  const result = await commitCatalogueImport(file, "restaurant-non-autorise");
  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") assert.equal(result.code, "TENANT_ACCESS_DENIED");
  assert.deepEqual(h.rpcCalls.map((c) => c.name), ["get_merchant_catalogue"]);
});

// ------------------------------------------------------------------
// 13/14/15. fake membership / Tags / Photo jamais persistés, jamais
// d'accès table direct.
// ------------------------------------------------------------------
test("13/14/15. Tags/Collections et Photo ne sont JAMAIS transmis à create_product ; aucune table accédée directement", async (t) => {
  const h = freshHarness([]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza", "Pizzas", "", "Vegetarien, Nouveau", "", "", 9.9, "", "", "pizza.jpg"],
  ]);
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  const prodCall = h.rpcCalls.find((c) => c.name === "create_product")!;
  const argNames = Object.keys(prodCall.args);
  assert.deepEqual(
    argNames.sort(),
    [
      "p_category_id",
      "p_description",
      "p_name",
      "p_price",
      "p_short_description",
      "p_subcategory_id",
      "p_tax_rate",
      "p_unit_weight_grams",
      "p_weight_is_approximate",
    ].sort(),
    "create_product ne reçoit QUE les paramètres publiés -- aucun p_tags/p_photo/p_image_url"
  );
  // supabase.from() aurait jeté (mock) si un accès table direct avait
  // eu lieu (ex. fausse ligne restaurant_users) -- le commit entier a
  // réussi, donc aucun accès table direct ne s'est produit.
  assert.equal(result.kind, "COMMITTED");
});

// ------------------------------------------------------------------
// 16. manipulated planned action rejected / recomputed
// ------------------------------------------------------------------
test("16. commitCatalogueImport n'accepte AUCUN PreviewReport en paramètre -- le catalogue est TOUJOURS relu frais, un état différent au moment du commit change le résultat", async (t) => {
  // Premier appel : la catégorie n'existe pas encore -> l'aperçu
  // affiché à l'opérateur montrerait CREATE. Avant que l'opérateur ne
  // confirme, un AUTRE import (ou un autre onglet) crée déjà le produit.
  // Le commit ne doit JAMAIS se fier à un plannedAction figé : la
  // relecture fraîche au moment du commit doit voir l'état RÉEL.
  const h = freshHarness([
    productRow({ productId: "prod-existing", categoryId: "cat-1", categoryName: "Pizzas", name: "Pizza Margherita", price: 9.9 }),
  ]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
  ]);
  // Le signature (file, restaurantId) ne permet structurellement pas de
  // passer un PreviewReport -- TypeScript refuserait la compilation. Le
  // test comportemental prouve la conséquence : le produit, bien que
  // déjà existant avec des valeurs identiques au moment du commit
  // (créé par un tiers après un Preview qui l'aurait montré comme
  // CREATE), est correctement traité en SKIP -- jamais un second
  // create_product.
  const result = await commitCatalogueImport(file, "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.productsSkipped, 1);
  assert.equal(h.rpcCalls.some((c) => c.name === "create_product"), false, "jamais de second create_product pour un produit déjà convergé au moment de la relecture fraîche");
});

// ------------------------------------------------------------------
// 4/17. exact retry / repeated submission idempotent
// ------------------------------------------------------------------
test("4/17. Ré-exécution EXACTE du même commit après un premier succès -> convergence totale, ZÉRO doublon (tout ressort SKIP)", async (t) => {
  const h = freshHarness([categoryOnlyRow("cat-1", "Pizzas")]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
  ]);

  const first = await commitCatalogueImport(file, "resto-1");
  assert.equal(first.kind, "COMMITTED");
  if (first.kind !== "COMMITTED") return;
  assert.equal(first.productsCreated, 1);

  // Le mock a déjà ajouté le produit créé au catalogue simulé (voir
  // create_product ci-dessous -- non, create_product actuel ne l'ajoute
  // PAS automatiquement à h.catalogueRows -- on le fait explicitement
  // ici pour représenter fidèlement "la base a réellement le produit
  // après le premier commit", exactement ce qu'une VRAIE relecture
  // getMerchantCatalogue renverrait après un create_product réel.
  h.catalogueRows.push(
    productRow({ productId: first.rows[0].productId!, categoryId: "cat-1", categoryName: "Pizzas", name: "Pizza Margherita", price: 9.9 })
  );
  h.rpcCalls = [];

  const second = await commitCatalogueImport(file, "resto-1");
  assert.equal(second.kind, "COMMITTED");
  if (second.kind !== "COMMITTED") return;
  assert.equal(second.productsCreated, 0);
  assert.equal(second.productsSkipped, 1);
  assert.equal(second.categoriesCreated, 0);
  assert.equal(h.rpcCalls.filter((c) => c.name === "create_category").length, 0, "create_category jamais rappelé au second essai");
  assert.equal(h.rpcCalls.filter((c) => c.name === "create_product").length, 0, "create_product jamais rappelé au second essai");
});

// ------------------------------------------------------------------
// 5. partial retry / convergence (une ligne échoue, les autres
// réussissent, ré-exécution converge sans dupliquer les succès)
// ------------------------------------------------------------------
test("5. Échec partiel (course concurrente sur UNE catégorie) puis ré-exécution -> converge, aucun doublon sur les lignes déjà réussies", async (t) => {
  const h = freshHarness([]);
  // Simule : au moment du PREMIER commit, une autre session a déjà
  // créé "Pizzas" entre notre lecture fraîche et notre create_category
  // -- notre create_category pour "pizzas" échoue avec le doublon.
  h.forceDuplicateOnCategoryName = new Set(["pizzas"]);
  installMocks(t, h);
  const file = xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, "", "", ""],
    ["Produit", "Salade", "Salades", "", "", "", "", 5, "", "", ""],
  ]);

  const first = await commitCatalogueImport(file, "resto-1");
  assert.equal(first.kind, "COMMITTED");
  if (first.kind !== "COMMITTED") return;
  assert.equal(first.productsFailed, 1, "Pizza Margherita échoue (catégorie non disponible)");
  assert.equal(first.productsCreated, 1, "Salade réussit malgré l'échec de l'autre ligne (best-effort)");
  assert.equal(first.categoriesCreated, 1, "Salades a bien été créée");

  // La ligne Salade a réellement réussi (create_category + create_product,
  // seule création de catégorie du premier essai puisque "Pizzas" a
  // échoué) : on reflète cet état réel dans le catalogue simulé,
  // exactement comme une VRAIE relecture getMerchantCatalogue le
  // montrerait au second essai.
  assert.equal(h.categoryCounter.n, 1, "une seule catégorie créée avec succès au premier essai (Salades)");
  const salesCategoryId = "cat-new-1";
  h.catalogueRows.push(categoryOnlyRow(salesCategoryId, "Salades"));
  h.catalogueRows.push(
    productRow({ productId: first.rows[1].productId!, categoryId: salesCategoryId, categoryName: "Salades", name: "Salade", price: 5 })
  );

  // Convergence : au second essai, "Pizzas" existe désormais réellement
  // (créée par le tiers concurrent du premier essai) -- on l'ajoute au
  // catalogue simulé pour représenter cet état réel, et on retire le
  // blocage synthétique (le tiers a déjà gagné la course, il n'y a plus
  // de concurrence à ce point).
  h.catalogueRows.push(categoryOnlyRow("cat-pizzas-concurrent", "Pizzas"));
  h.forceDuplicateOnCategoryName = new Set();

  const second = await commitCatalogueImport(file, "resto-1");
  assert.equal(second.kind, "COMMITTED");
  if (second.kind !== "COMMITTED") return;
  assert.equal(second.productsFailed, 0);
  assert.equal(second.categoriesCreated, 0, "Pizzas existe déjà (créée par le tiers) -- jamais recréée");
  assert.equal(second.productsCreated, 1, "Pizza Margherita réussit maintenant");
  assert.equal(second.productsSkipped, 1, "Salade, déjà créée au premier essai, ressort SKIP -- jamais un doublon");
});

// ------------------------------------------------------------------
// Structural — jamais restaurant_users / service_role / accès table
// direct dans le code source du commit (défense en profondeur,
// complète les preuves comportementales ci-dessus).
// ------------------------------------------------------------------
test("Structural — lib/services/catalogue-import-commit.ts ne référence JAMAIS restaurant_users, service_role, ni supabase.from(", () => {
  const src = readFileSync(new URL("../lib/services/catalogue-import-commit.ts", import.meta.url), "utf8");
  assert.equal(src.includes("restaurant_users"), false);
  assert.equal(src.includes("service_role"), false);
  assert.equal(src.includes("supabase.from("), false);
  assert.equal(src.includes(".storage."), false);
});

test("Structural — lib/catalogue-import/commit-plan.ts reste PUR (aucun import supabase/réseau)", () => {
  const src = readFileSync(new URL("../lib/catalogue-import/commit-plan.ts", import.meta.url), "utf8");
  assert.equal(/from ["']@\/lib\/supabase["']/.test(src), false);
  assert.equal(src.includes("fetch("), false);
});

// ------------------------------------------------------------------
// buildCommitPlan — tests unitaires PURS (aucun mock nécessaire).
// ------------------------------------------------------------------
test("buildCommitPlan — déduplique catégories/sous-catégories WOULD_CREATE par clé normalisée, ordre de première apparition", () => {
  const report = {
    rows: [
      {
        row: 2,
        status: "OK" as const,
        errors: [],
        warnings: [],
        infos: [],
        resolvedCategory: { state: "WOULD_CREATE" as const, displayName: "Pizzas" },
        resolvedSubcategory: null,
        normalizedValues: { categoryNameRaw: "Pizzas", subcategoryNameRaw: "", name: "A" } as any,
        photoFilename: null,
        productMatch: { state: "NEW" as const },
        plannedAction: "CREATE" as const,
      },
      {
        row: 3,
        status: "OK" as const,
        errors: [],
        warnings: [],
        infos: [],
        resolvedCategory: { state: "WOULD_CREATE" as const, displayName: "Pizzas" },
        resolvedSubcategory: null,
        normalizedValues: { categoryNameRaw: "PIZZAS", subcategoryNameRaw: "", name: "B" } as any,
        photoFilename: null,
        productMatch: { state: "NEW" as const },
        plannedAction: "CREATE" as const,
      },
    ],
    eligibility: "ELIGIBLE" as const,
    totalRows: 2,
    blockedRows: 0,
    warningRows: 0,
    okRows: 2,
    columnMapWarnings: [],
  };
  const plan = buildCommitPlan(report as any);
  assert.equal(plan.categoriesToCreate.length, 1);
  assert.equal(plan.categoriesToCreate[0].displayName, "Pizzas");
  assert.deepEqual(plan.categoriesToCreate[0].rows, [2, 3]);
});

test("buildCommitPlan — ignore les lignes BLOCKED (filet de sécurité déterministe)", () => {
  const report = {
    rows: [
      {
        row: 2,
        status: "BLOCKED" as const,
        errors: [{ code: "X", severity: "BLOCKING_ERROR" as const, message: "x" }],
        warnings: [],
        infos: [],
        resolvedCategory: { state: "WOULD_CREATE" as const, displayName: "Pizzas" },
        resolvedSubcategory: null,
        normalizedValues: { categoryNameRaw: "Pizzas", subcategoryNameRaw: "", name: "" } as any,
        photoFilename: null,
        productMatch: { state: "NEW" as const },
        plannedAction: "BLOCKED" as const,
      },
    ],
    eligibility: "NOT_ELIGIBLE" as const,
    totalRows: 1,
    blockedRows: 1,
    warningRows: 0,
    okRows: 0,
    columnMapWarnings: [],
  };
  const plan = buildCommitPlan(report as any);
  assert.equal(plan.categoriesToCreate.length, 0);
});
