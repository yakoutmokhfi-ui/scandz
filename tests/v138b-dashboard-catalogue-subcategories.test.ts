import { test } from "node:test";
import assert from "node:assert/strict";

// Import dynamique obligatoire (patron déjà établi,
// tests/v132-dashboard-catalogue-fiscal.test.ts) : les variables
// d'environnement doivent être définies AVANT que lib/supabase.ts ne
// soit chargé.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const {
  createSubcategory,
  updateSubcategory,
  createProduct,
  updateProduct,
  getMerchantCatalogue,
  SubcategoryDuplicateNameError,
  SubcategoryCategoryMismatchError,
} = await import("../lib/services/dashboard.ts");

// ====================================================================
// Scanym — CATALOGUE / SUBCATEGORIES BACKOFFICE v1 —
// lib/services/dashboard.ts : createSubcategory/updateSubcategory (RPC
// create_subcategory/update_subcategory), le 9e paramètre
// p_subcategory_id de create_product/update_product, et le
// regroupement products/subcategories de getMerchantCatalogue. Même
// patron/style que tests/v132-dashboard-catalogue-fiscal.test.ts
// (mock de supabase.rpc, jamais un vrai réseau/une vraie base).
// ====================================================================

test("createSubcategory: transmet category_id/name/display_order à create_subcategory, renvoie l'id créé", async (t) => {
  const calls: { name: string; args: any }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return { data: "sub-1", error: null };
  });

  const id = await createSubcategory("cat-1", "Chèvres");

  assert.equal(id, "sub-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "create_subcategory");
  assert.deepEqual(calls[0].args, {
    p_category_id: "cat-1",
    p_name: "Chèvres",
    p_display_order: null,
  });
});

test("createSubcategory: display_order explicite transmis tel quel", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (_name: string, args: any) => {
    calls.push(args);
    return { data: "sub-2", error: null };
  });

  await createSubcategory("cat-1", "Vaches", 3);

  assert.equal(calls[0].p_display_order, 3);
});

test("createSubcategory: nom dupliqué (23505 + code SCANYM_SUBCATEGORY_DUPLICATE_NAME) devient SubcategoryDuplicateNameError, jamais une Error générique", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "23505", message: "SCANYM_SUBCATEGORY_DUPLICATE_NAME" },
  }));

  await assert.rejects(
    () => createSubcategory("cat-1", "Chèvres"),
    (err: unknown) => err instanceof SubcategoryDuplicateNameError
  );
});

test("createSubcategory: toute autre erreur RPC reste une Error standard avec le message serveur", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "P0002", message: "Category not found" },
  }));

  await assert.rejects(
    () => createSubcategory("cat-inexistante", "X"),
    (err: unknown) => err instanceof Error && !(err instanceof SubcategoryDuplicateNameError) && (err as Error).message === "Category not found"
  );
});

test("updateSubcategory: transmet subcategory_id/name/display_order à update_subcategory", async (t) => {
  const calls: { name: string; args: any }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return { data: null, error: null };
  });

  await updateSubcategory("sub-1", "Chèvres (renommé)", 5);

  assert.equal(calls[0].name, "update_subcategory");
  assert.deepEqual(calls[0].args, {
    p_subcategory_id: "sub-1",
    p_name: "Chèvres (renommé)",
    p_display_order: 5,
  });
});

test("updateSubcategory: nom dupliqué devient SubcategoryDuplicateNameError", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "23505", message: "SCANYM_SUBCATEGORY_DUPLICATE_NAME" },
  }));

  await assert.rejects(
    () => updateSubcategory("sub-1", "Vaches", 1),
    (err: unknown) => err instanceof SubcategoryDuplicateNameError
  );
});

test("createProduct: p_subcategory_id transmis tel quel quand fourni (placement dans une sous-catégorie de sa catégorie)", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (_name: string, args: any) => {
    calls.push(args);
    return { data: "prod-1", error: null };
  });

  await createProduct("cat-1", "Charolais", null, 4.5, null, {}, "sub-chevres");

  assert.equal(calls[0].p_subcategory_id, "sub-chevres");
});

test("createProduct: erreur RPC de désaccord catégorie/sous-catégorie (22023 + SCANYM_SUBCATEGORY_CATEGORY_MISMATCH) devient SubcategoryCategoryMismatchError", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "22023", message: "SCANYM_SUBCATEGORY_CATEGORY_MISMATCH" },
  }));

  await assert.rejects(
    () => createProduct("cat-1", "X", null, 1, null, {}, "sub-dune-autre-categorie"),
    (err: unknown) => err instanceof SubcategoryCategoryMismatchError
  );
});

test("updateProduct: p_subcategory_id transmis tel quel (déplacement d'un produit existant vers/hors d'une sous-catégorie de SA catégorie actuelle)", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (_name: string, args: any) => {
    calls.push(args);
    return { data: null, error: null };
  });

  await updateProduct("prod-1", "Charolais", null, 4.5, null, {}, null);

  assert.equal(calls[0].p_subcategory_id, null);
});

// --------------------------------------------------------------------
// getMerchantCatalogue -- regroupement products (direct) / subcategories[].products
// --------------------------------------------------------------------

function baseRow(overrides: Record<string, unknown>) {
  return {
    product_id: null,
    category_id: "cat-1",
    category_name: "Fromages",
    category_name_hash: "h-cat",
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
    ...overrides,
  };
}

test("getMerchantCatalogue: catégorie SANS sous-catégorie -- tous les produits vont dans products[], subcategories[] reste vide (non-régression stricte)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [
      baseRow({ product_id: "p1", name: "Eau", price: 2, is_available: true, display_order: 1 }),
      baseRow({ product_id: "p2", name: "Jus", price: 3, is_available: true, display_order: 2 }),
    ],
    error: null,
  }));

  const cats = await getMerchantCatalogue("r1");
  assert.equal(cats.length, 1);
  assert.equal(cats[0].subcategories.length, 0);
  assert.deepEqual(cats[0].products.map((p) => p.name), ["Eau", "Jus"]);
});

test("getMerchantCatalogue: catégorie avec une sous-catégorie ET des produits directs -- les 2 restent séparés, jamais mélangés ni dupliqués", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [
      baseRow({ product_id: "p1", name: "Reblochon", price: 6, is_available: true, display_order: 1 }),
      baseRow({
        product_id: "p2",
        name: "Charolais",
        price: 4.5,
        is_available: true,
        display_order: 1,
        subcategory_id: "sub-1",
        subcategory_name: "Chèvres",
        subcategory_display_order: 1,
      }),
      baseRow({
        product_id: "p3",
        name: "Pélardon",
        price: 5,
        is_available: true,
        display_order: 2,
        subcategory_id: "sub-1",
        subcategory_name: "Chèvres",
        subcategory_display_order: 1,
      }),
    ],
    error: null,
  }));

  const cats = await getMerchantCatalogue("r1");
  assert.equal(cats.length, 1);
  assert.deepEqual(cats[0].products.map((p) => p.name), ["Reblochon"]);
  assert.equal(cats[0].subcategories.length, 1);
  assert.equal(cats[0].subcategories[0].subcategory_name, "Chèvres");
  assert.deepEqual(cats[0].subcategories[0].products.map((p) => p.name), ["Charolais", "Pélardon"]);
});

test("getMerchantCatalogue: sous-catégorie VIDE (groupe racine LEFT JOIN sans produit) -- reste visible dans subcategories[] avec products:[] (jamais absente)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [
      // Ligne racine (produit direct), catégorie non vide.
      baseRow({ product_id: "p1", name: "Reblochon", price: 6, is_available: true, display_order: 1 }),
      // Ligne de groupe pour une sous-catégorie fraîchement créée, sans
      // produit -- product_id null (LEFT JOIN), mais subcategory_id
      // NON null : le groupe doit apparaître quand même.
      baseRow({ subcategory_id: "sub-2", subcategory_name: "Vaches", subcategory_display_order: 2 }),
    ],
    error: null,
  }));

  const cats = await getMerchantCatalogue("r1");
  assert.equal(cats[0].subcategories.length, 1);
  assert.equal(cats[0].subcategories[0].subcategory_name, "Vaches");
  assert.deepEqual(cats[0].subcategories[0].products, []);
});

test("getMerchantCatalogue: base non migrée (RPC pas encore mise à jour, colonnes subcategory_* ABSENTES de la ligne, donc `undefined`) -- repli défensif : classé comme produit direct, jamais une exception ni un produit perdu dans une fausse sous-catégorie (même philosophie que le repli fiscal v1.1, mandat §17)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [
      {
        product_id: "p1",
        category_id: "c1",
        category_name: "Classique",
        category_name_hash: "h1",
        category_translations: null,
        category_display_order: 1,
        category_is_option_source: false,
        category_description: null,
        category_description_hash: null,
        // subcategory_id/subcategory_name/subcategory_display_order
        // délibérément ABSENTS de cette ligne (RPC antérieure au lot).
        name: "Ancien produit",
        name_hash: "h2",
        short_description: null,
        short_description_hash: null,
        description: null,
        description_hash: null,
        translations: null,
        price: 9.5,
        is_available: true,
        archived_at: null,
        display_order: 1,
        is_option_source: false,
        image_url: null,
        tax_rate: null,
        unit_weight_grams: null,
        weight_is_approximate: null,
        reference_price_per_kg: null,
      },
    ],
    error: null,
  }));

  const cats = await getMerchantCatalogue("r1");
  assert.equal(cats[0].subcategories.length, 0, "aucune fausse sous-catégorie créée à partir de undefined");
  assert.equal(cats[0].products.length, 1);
  assert.equal(cats[0].products[0].name, "Ancien produit");
});
