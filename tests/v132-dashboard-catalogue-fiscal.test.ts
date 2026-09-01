import { test } from "node:test";
import assert from "node:assert/strict";

// Import dynamique obligatoire (patron déjà établi,
// tests/v109b-dashboard-payment-service.test.ts) : les variables
// d'environnement doivent être définies AVANT que lib/supabase.ts ne
// soit chargé.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { createProduct, updateProduct, getMerchantCatalogue } = await import("../lib/services/dashboard.ts");
const { FiscalMeasurementValidationError, INVALID_WEIGHT_VALUE_CODE } = await import(
  "../lib/services/catalogue-error.ts"
);

// ====================================================================
// Scanym — CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 —
// lib/services/dashboard.ts (createProduct/updateProduct/
// getMerchantCatalogue étendus des 3 champs éditables + 1 colonne
// dérivée — modèle SIMPLIFIÉ, plus de sales_unit/price_mode/
// weight_mode/price_per_weight_rate).
// ====================================================================

test("createProduct: transmet les 3 p_* fiscaux à create_product avec les valeurs fournies", async (t) => {
  const calls: { name: string; args: any }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return { data: "new-product-id", error: null };
  });

  const id = await createProduct("cat-1", "Raclette", null, 7.5, null, {
    taxRate: 5.5,
    unitWeightGrams: 200,
    weightIsApproximate: true,
  });

  assert.equal(id, "new-product-id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "create_product");
  assert.deepEqual(calls[0].args, {
    p_category_id: "cat-1",
    p_name: "Raclette",
    p_description: null,
    p_price: 7.5,
    p_short_description: null,
    p_tax_rate: 5.5,
    p_unit_weight_grams: 200,
    p_weight_is_approximate: true,
  });
});

test("createProduct: aucun 6e argument fourni -- retombe EXACTEMENT sur le comportement historique (mandat §17)", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push(args);
    return { data: "id", error: null };
  });

  await createProduct("cat-1", "Classique", "desc", 9.9, "court");

  assert.deepEqual(calls[0], {
    p_category_id: "cat-1",
    p_name: "Classique",
    p_description: "desc",
    p_price: 9.9,
    p_short_description: "court",
    p_tax_rate: null,
    p_unit_weight_grams: null,
    p_weight_is_approximate: false,
  });
});

test("createProduct: AUCUN paramètre RPC résiduel du modèle v1 (sales_unit/price_mode/weight_mode/price_per_weight_rate)", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push(args);
    return { data: "id", error: null };
  });
  await createProduct("cat-1", "X", null, 1, null, { taxRate: 5.5, unitWeightGrams: 200 });
  const keys = Object.keys(calls[0]);
  assert.deepEqual(
    keys.filter((k) => /sales_unit|price_mode|weight_mode|price_per_weight/i.test(k)),
    []
  );
  assert.deepEqual(keys.sort(), [
    "p_category_id",
    "p_description",
    "p_name",
    "p_price",
    "p_short_description",
    "p_tax_rate",
    "p_unit_weight_grams",
    "p_weight_is_approximate",
  ]);
});

test("updateProduct: transmet les 3 p_* fiscaux à update_product", async (t) => {
  const calls: any[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return { data: null, error: null };
  });

  await updateProduct("prod-1", "Nom", null, 12, null, {
    taxRate: null,
    unitWeightGrams: 1800,
    weightIsApproximate: true,
  });

  assert.equal(calls[0].name, "update_product");
  assert.deepEqual(calls[0].args, {
    p_product_id: "prod-1",
    p_name: "Nom",
    p_description: null,
    p_price: 12,
    p_short_description: null,
    p_tax_rate: null,
    p_unit_weight_grams: 1800,
    p_weight_is_approximate: true,
  });
});

test("createProduct/updateProduct: une erreur RPC fiscale (22001 + code fiscal) devient FiscalMeasurementValidationError avec le bon code, jamais une Error générique", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "22001", message: INVALID_WEIGHT_VALUE_CODE },
  }));

  await assert.rejects(
    () => createProduct("cat-1", "X", null, 0, null, { unitWeightGrams: -5 }),
    (err: unknown) => {
      assert.ok(err instanceof FiscalMeasurementValidationError);
      assert.equal((err as InstanceType<typeof FiscalMeasurementValidationError>).code, INVALID_WEIGHT_VALUE_CODE);
      return true;
    }
  );

  await assert.rejects(
    () => updateProduct("prod-1", "X", null, 0),
    (err: unknown) => {
      assert.ok(err instanceof FiscalMeasurementValidationError);
      return true;
    }
  );
});

test("getMerchantCatalogue: mappe les 4 colonnes fiscales quand présentes (base migrée)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [
      {
        product_id: "p1",
        category_id: "c1",
        category_name: "Plats",
        category_name_hash: "h1",
        category_translations: null,
        category_display_order: 1,
        category_is_option_source: false,
        category_description: null,
        category_description_hash: null,
        name: "Raclette",
        name_hash: "h2",
        short_description: null,
        short_description_hash: null,
        description: null,
        description_hash: null,
        translations: null,
        price: 7.5,
        is_available: true,
        archived_at: null,
        display_order: 1,
        is_option_source: false,
        image_url: null,
        tax_rate: 5.5,
        unit_weight_grams: 200,
        weight_is_approximate: true,
        reference_price_per_kg: 37.5,
      },
    ],
    error: null,
  }));

  const cats = await getMerchantCatalogue("r1");
  assert.equal(cats.length, 1);
  const product = cats[0].products[0];
  assert.equal(product.tax_rate, 5.5);
  assert.equal(product.unit_weight_grams, 200);
  assert.equal(product.weight_is_approximate, true);
  assert.equal(product.reference_price_per_kg, 37.5);
});

test("getMerchantCatalogue: colonnes fiscales absentes (base non migrée, RPC renvoie null) -- repli défensif, jamais une exception (mandat §17)", async (t) => {
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
  const product = cats[0].products[0];
  assert.equal(product.tax_rate, null);
  assert.equal(product.unit_weight_grams, null);
  assert.equal(product.weight_is_approximate, false, "repli défensif -- même défaut que la migration SQL");
  assert.equal(product.reference_price_per_kg, null);
});
