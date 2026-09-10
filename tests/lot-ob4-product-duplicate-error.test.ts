import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-4 v1.1 — CATALOGUE IMPORT COMMIT.
// Classification de l'erreur de doublon de nom de produit
// (lib/services/catalogue-error.ts) et branchement dans createProduct
// (lib/services/dashboard.ts) -- même patron EXACT que les tests V66
// pour CategoryDuplicateNameError (tests/v66-categories-descriptions.test.ts).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const {
  isProductDuplicateNameError,
  ProductDuplicateNameError,
  PRODUCT_DUPLICATE_NAME_CODE,
} = await import("../lib/services/catalogue-error.ts");
const { supabase } = await import("../lib/supabase.ts");
const { createProduct } = await import("../lib/services/dashboard.ts");

test("catalogue-error: doublon de produit reconnu sur le vrai SQLSTATE 23505 + message", () => {
  assert.equal(PRODUCT_DUPLICATE_NAME_CODE, "SCANYM_PRODUCT_DUPLICATE_NAME");
  assert.equal(
    isProductDuplicateNameError({ code: "23505", message: PRODUCT_DUPLICATE_NAME_CODE }),
    true
  );
});

test("catalogue-error: un 23505 SANS le message exact n'est jamais classé doublon produit (ne pas confondre avec un autre index unique)", () => {
  assert.equal(
    isProductDuplicateNameError({ code: "23505", message: "duplicate key value violates unique constraint" }),
    false
  );
  assert.equal(
    isProductDuplicateNameError({ code: "23505", message: "SCANYM_CATEGORY_DUPLICATE_NAME" }),
    false,
    "ne doit jamais confondre le doublon PRODUIT avec le doublon CATÉGORIE, même SQLSTATE"
  );
});

test("catalogue-error: le bon message SANS le SQLSTATE 23505 n'est jamais classé doublon produit", () => {
  assert.equal(
    isProductDuplicateNameError({ code: "22001", message: PRODUCT_DUPLICATE_NAME_CODE }),
    false
  );
});

test("catalogue-error: erreur absente/nulle jamais reconnue", () => {
  assert.equal(isProductDuplicateNameError(undefined), false);
  assert.equal(isProductDuplicateNameError(null), false);
});

test("ProductDuplicateNameError: nom et message portent le code stable", () => {
  const e = new ProductDuplicateNameError();
  assert.equal(e.name, "ProductDuplicateNameError");
  assert.equal(e.message, PRODUCT_DUPLICATE_NAME_CODE);
  assert.ok(e instanceof Error);
});

test("createProduct: un rejet create_product 23505/SCANYM_PRODUCT_DUPLICATE_NAME lève ProductDuplicateNameError (jamais une Error générique)", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    assert.equal(name, "create_product");
    return { data: null, error: { code: "23505", message: PRODUCT_DUPLICATE_NAME_CODE } };
  });
  await assert.rejects(
    () => createProduct("cat-1", "Café Latte", null, 3.5),
    (err: unknown) => err instanceof ProductDuplicateNameError
  );
});

test("createProduct: une erreur fiscale (SCANYM_INVALID_TAX_RATE) reste routée vers FiscalMeasurementValidationError, jamais confondue avec un doublon (non-régression)", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    assert.equal(name, "create_product");
    return { data: null, error: { code: "22001", message: "SCANYM_INVALID_TAX_RATE" } };
  });
  const { FiscalMeasurementValidationError } = await import("../lib/services/catalogue-error.ts");
  await assert.rejects(
    () => createProduct("cat-1", "Café Latte", null, 3.5),
    (err: unknown) => err instanceof FiscalMeasurementValidationError
  );
});

test("createProduct: succès -> renvoie l'id, aucune exception", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    assert.equal(name, "create_product");
    assert.equal(args.p_category_id, "cat-1");
    return { data: "new-product-id", error: null };
  });
  const id = await createProduct("cat-1", "Café Latte", null, 3.5);
  assert.equal(id, "new-product-id");
});
