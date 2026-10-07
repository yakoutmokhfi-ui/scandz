import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { coerceAvailability } from "../lib/catalogue-import/normalization.ts";
import { IMPORT_COLUMNS, resolveColumnMap } from "../lib/catalogue-import/column-mapping.ts";
import { buildImportXlsx } from "./helpers/xlsx-fixture-builder.ts";
import { buildCatalogueExport, EXPORT_COLUMNS, EXPORT_EXTRA_COLUMNS } from "../lib/catalogue-management/export.ts";
import { flattenCatalogue } from "../lib/catalogue-management/filtering.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder";
const { supabase } = await import("../lib/supabase.ts");
const { getMerchantCatalogue } = await import("../lib/services/dashboard.ts");
const { analyzeCatalogueImportFile } = await import("../lib/services/catalogue-import.ts");
const { commitCatalogueImport } = await import("../lib/services/catalogue-import-commit.ts");

function product(name: string, available: boolean, tax: number | null = 10) {
  return {
    product_id: name, name, name_hash: name, price: 5, is_available: available,
    category_id: "cat", category_name: "Boissons", category_name_hash: "boissons",
    category_translations: null, category_display_order: 1, category_is_option_source: false,
    category_description: null, category_description_hash: null,
    subcategory_id: null, subcategory_name: null, subcategory_display_order: null,
    short_description: null, short_description_hash: null, description: null, description_hash: null,
    translations: null, archived_at: null, display_order: 1, is_option_source: false,
    image_url: null, tax_rate: tax, unit_weight_grams: null, weight_is_approximate: false,
    reference_price_per_kg: null, withdrawal_eligible: false, allowed_sale_modes: null,
  };
}
type Product = ReturnType<typeof product>;
function harness(t: TestContext, initial: Product[] = []) {
  const products = [...initial];
  const calls: { name: string; args: Record<string, any> }[] = [];
  const failures = new Set<string>();
  const category = { ...product("", false), product_id: null, name: null };
  const vatError = { data: null, error: { code: "23514", message: "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" } };
  t.mock.method(supabase, "rpc", async (name: string, args: Record<string, any>) => {
    calls.push({ name, args });
    if (name === "get_merchant_catalogue") return { data: [category, ...products], error: null };
    if (name === "get_restaurant_tags") return { data: [], error: null };
    if (name === "create_product") {
      const p = product(args.p_name, args.p_tax_rate !== null, args.p_tax_rate);
      p.price = args.p_price;
      products.push(p);
      return { data: p.product_id, error: null };
    }
    const p = products.find(p => p.product_id === args.p_product_id);
    assert.ok(p, `Unexpected product RPC: ${name}`);
    if (name === "set_product_availability") {
      if (failures.has(p.name)) return { data: null, error: { message: "Availability write failed" } };
      if (args.p_is_available && p.tax_rate === null) return vatError;
      p.is_available = args.p_is_available;
    } else if (name === "update_product") {
      if (p.is_available && args.p_tax_rate === null) return vatError;
      p.price = args.p_price;
      p.tax_rate = args.p_tax_rate;
    } else {
      assert.fail(`Unexpected RPC: ${name}`);
    }
    return { data: null, error: null };
  });
  t.mock.method(supabase, "from", () => { throw new Error("Direct DB writes forbidden"); });
  t.mock.method(supabase.storage, "from", () => { throw new Error("Storage forbidden"); });
  return { products, calls, failures, writes: () => calls.filter(c => !c.name.startsWith("get_")) };
}
function file(availability: string | undefined, names = ["Sobacha"], tax: number | null = 10, price = 5) {
  const header = ["Nom", "Catégorie parent", "Prix TTC (€)", "TVA (%)"];
  if (availability !== undefined) header.push("Disponible");
  return new File([buildImportXlsx(header, names.map(n => [n, "Boissons", price, tax, ...(availability === undefined ? [] : [availability])]))], "catalogue.xlsx");
}
async function preview(f: File) {
  const a = await analyzeCatalogueImportFile(f, "tenant-test");
  assert.equal(a.kind, "OK");
  assert.ok("report" in a);
  return a.report;
}
async function commit(f: File) {
  const r = await commitCatalogueImport(f, "tenant-test");
  assert.equal(r.kind, "COMMITTED");
  assert.ok("rows" in r);
  return r;
}

test("availability coercion: finite Oui/Non, trim/case/accents, blank distinct from invalid", () => {
  for (const [raw, expected] of [[undefined, undefined], ["  ", undefined], [" OÙI ", true], ["nOn", false], ["Peut-être", null], ["true", null], ["0", null]] as const) {
    assert.equal(coerceAvailability(raw), expected);
  }
});

for (const [id, current, value, target] of [["A1/A11", true, "Non", false], ["A2", false, "Oui", true]] as const) {
  test(`${id}: availability-only change is UPDATE and uses only setProductAvailability`, async t => {
    const h = harness(t, [product("Sobacha", current)]);
    const f = file(value);
    assert.equal((await preview(f)).rows[0].plannedAction, "UPDATE");
    const r = await commit(f);
    assert.equal(r.rows[0].outcome, "UPDATED");
    assert.equal(h.products[0].is_available, target);
    assert.deepEqual(h.writes().map(c => c.name), ["set_product_availability"]);
    assert.equal(h.products[0].archived_at, null, "A14: unavailable is not archived");
  });
}
for (const current of [true, false]) for (const value of ["", undefined]) {
  test(`A3/A4/A5: ${current}, availability ${value === undefined ? "absent" : "blank"} preserves state even with field update`, async t => {
    const h = harness(t, [product("Sobacha", current)]);
    assert.equal((await preview(file(value))).rows[0].plannedAction, "SKIP");
    await commit(file(value, ["Sobacha"], 10, 6));
    assert.equal(h.products[0].is_available, current);
    assert.deepEqual(h.writes().map(c => c.name), ["update_product"]);
  });
}
test("A6: invalid availability blocks existing and new rows without any mutation", async t => {
  const h = harness(t, [product("Sobacha", true)]);
  const f = file("Peut-être", ["Sobacha", "Nouveau"]);
  const p = await preview(f);
  assert.ok(p.rows.every(r => r.plannedAction === "BLOCKED" && r.errors.some(e => e.code === "SCANYM_IMPORT_INVALID_AVAILABILITY")));
  assert.equal((await commitCatalogueImport(f, "tenant-test")).kind, "NOT_ELIGIBLE");
  assert.deepEqual(h.writes(), []);
});
for (const [id, value, target] of [["A7", "Non", false], ["A8", "Oui", true]] as const) {
  test(`${id}: explicit availability on new product, only necessary sub-write`, async t => {
    const h = harness(t);
    assert.equal((await commit(file(value))).rows[0].outcome, "CREATED");
    assert.equal(h.products[0].is_available, target);
    assert.equal(h.writes().filter(c => c.name === "set_product_availability").length, target ? 0 : 1);
    assert.equal(h.products[0].archived_at, null);
  });
}
for (const value of ["", undefined]) for (const tax of [10, null]) {
  test(`A9: new product ${value === undefined ? "absent" : "blank"}, VAT ${tax}, preserves server default`, async t => {
    const h = harness(t);
    await commit(file(value, ["Sobacha"], tax));
    assert.equal(h.products[0].is_available, tax !== null);
    assert.deepEqual(h.writes().map(c => c.name), ["create_product"]);
  });
}
test("A10: already unavailable + Non is SKIP and performs no write", async t => {
  const h = harness(t, [product("Sobacha", false)]);
  assert.equal((await preview(file("Non"))).rows[0].plannedAction, "SKIP");
  assert.equal((await commit(file("Non"))).rows[0].outcome, "SKIPPED");
  assert.deepEqual(h.writes(), []);
});
test("A12/A13: actual XLSX export/import preserves Oui/Non; only reference price is ignored", async t => {
  const h = harness(t, [product("Sobacha", true), product("Orzo", false)]);
  const flat = flattenCatalogue(await getMerchantCatalogue("tenant-test"), new Map());
  const bytes = buildCatalogueExport(flat);
  const f = new File([new Uint8Array(bytes)], "round-trip.xlsx");
  const map = resolveColumnMap([...EXPORT_COLUMNS]);
  assert.ok(IMPORT_COLUMNS.includes("Disponible"));
  assert.deepEqual(EXPORT_EXTRA_COLUMNS, ["Prix de référence (€/kg)"]);
  assert.deepEqual(map.unrecognizedHeaders, ["Prix de référence (€/kg)"]);
  assert.deepEqual((await preview(f)).rows.map(r => r.normalizedValues.availability), [true, false]);
  h.products[0].is_available = false;
  h.products[1].is_available = true;
  await commit(f);
  assert.deepEqual(h.products.map(p => p.is_available), [true, false]);
});
for (const isNew of [false, true]) {
  test(`A15: VAT guard rejects explicit Oui, ${isNew ? "new" : "existing"} product without VAT`, async t => {
    const h = harness(t, isNew ? [] : [product("Sobacha", false, null)]);
    const r = await commit(file("Oui", ["Sobacha"], null));
    assert.equal(r.rows[0].outcome, "FAILED");
    assert.equal(r.rows[0].errorCode, "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY");
    assert.equal(r.productsCreated + r.productsUpdated, 0);
    assert.equal(h.products[0].is_available, false);
  });
}
test("incident regression: five synthetic products become unavailable without archive or unrelated updates", async t => {
  const names = ["Sobacha", "Orgé expresso", "Orgé infusion", "Kofé", "Orzo"];
  const h = harness(t, names.map(n => product(n, true)));
  const r = await commit(file("Non", names));
  assert.equal(r.productsUpdated, 5);
  assert.ok(h.products.every(p => p.is_available === false && p.archived_at === null));
  assert.deepEqual(h.writes().map(c => c.name), names.map(() => "set_product_availability"));
});
test("failed availability sub-write: FAILED, other rows continue, retry converges", async t => {
  const h = harness(t, [product("Sobacha", true), product("Orzo", true)]);
  h.failures.add("Sobacha");
  const f = file("Non", ["Sobacha", "Orzo"]);
  assert.deepEqual((await commit(f)).rows.map(r => r.outcome), ["FAILED", "UPDATED"]);
  h.failures.clear();
  assert.deepEqual((await commit(f)).rows.map(r => r.outcome), ["UPDATED", "SKIPPED"]);
});
test("new product availability failure is FAILED and retry does not recreate it", async t => {
  const h = harness(t);
  h.failures.add("Sobacha");
  const r = await commit(file("Non"));
  assert.equal(r.rows[0].outcome, "FAILED");
  assert.equal(r.productsCreated, 0);
  h.failures.clear();
  assert.equal((await commit(file("Non"))).rows[0].outcome, "UPDATED");
  assert.equal(h.products.length, 1);
  assert.equal(h.products[0].is_available, false);
});
test("explicit deactivation before VAT removal, activation after VAT addition", async t => {
  const h = harness(t, [product("Sobacha", true)]);
  assert.equal((await commit(file("Non", ["Sobacha"], null))).rows[0].outcome, "UPDATED");
  assert.deepEqual(h.writes().map(c => c.name), ["set_product_availability", "update_product"]);
  h.calls.length = 0;
  assert.equal((await commit(file("Oui"))).rows[0].outcome, "UPDATED");
  assert.deepEqual(h.writes().map(c => c.name), ["update_product", "set_product_availability"]);
});

test("availability already matches: other edits do not cause a redundant availability write", async t => {
  const h = harness(t, [product("Sobacha", false)]);
  await commit(file("Non", ["Sobacha"], 10, 6));
  assert.deepEqual(h.writes().map(c => c.name), ["update_product"]);
  assert.equal(h.products[0].is_available, false);
});

test("commit revalidates availability after a stale preview", async t => {
  const h = harness(t, [product("Sobacha", false)]);
  const f = file("Non");
  assert.equal((await preview(f)).rows[0].plannedAction, "SKIP");
  h.products[0].is_available = true;
  assert.equal((await commit(f)).rows[0].outcome, "UPDATED");
  assert.equal(h.products[0].is_available, false);
});

test("new product Non without VAT: actual server default already false, no redundant write", async t => {
  const h = harness(t);
  await commit(file("Non", ["Sobacha"], null));
  assert.equal(h.products[0].is_available, false);
  assert.deepEqual(h.writes().map(c => c.name), ["create_product"]);
});
