// DELIVERY RULE DELETE v1 -- real B1..B5 SQL chain in PGlite plus the DRAFT delete migration.
// Nothing is mocked: roles, RLS, grants, triggers and FKs are the repository's own.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeBaseline, readSql } from "../supabase/tests/b5/bootstrap.mjs";

const deleteFile = "DRAFT-lot-delivery-rule-delete-v1.sql";
const rollbackFile = "DRAFT-lot-delivery-rule-delete-v1-ROLLBACK.sql";
const db = await makeBaseline();
after(async () => db.close());
await db.exec(readSql("DRAFT-lot-delivery-pricing-v2-b5.sql"));

const MUTATE = "public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)";
const engineSignatures = [
  "public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)",
  "public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)",
  "public.get_restaurant_public_delivery_fulfillments(uuid)",
  "public.get_merchant_delivery_fulfillment_pricing(uuid)",
  "public.test_merchant_delivery_postcode(uuid,text,text,numeric,integer)",
  "public.preview_merchant_delivery_rule_save(uuid,uuid,boolean)",
  "public.update_merchant_delivery_fulfillment_pricing(uuid,uuid,text,numeric,numeric,text)",
];
async function defs(sigs: string[]) {
  const out: Record<string, unknown> = {};
  for (const sig of sigs) {
    const reg = (await db.query<{ r: string | null }>("select to_regprocedure($1)::text r", [sig])).rows[0].r;
    out[sig] = reg === null ? null : (await db.query<Record<string, unknown>>(
      "select pg_get_functiondef(oid) def, proacl::text acl, proowner from pg_proc where oid=$1::regprocedure", [sig])).rows[0];
  }
  return out;
}
const mutateRow = async () => (await db.query<Record<string, any>>(
  "select md5(replace(prosrc,chr(13)||chr(10),chr(10))) m, proacl::text acl, prosecdef from pg_proc where oid=$1::regprocedure", [MUTATE])).rows[0];

const enginesBefore = await defs(engineSignatures);
const b5Mutate = await mutateRow();
await db.exec(readSql(deleteFile));

const id = (n: number) => `de100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), owner = id(3), manager = id(4), staff = id(5), operator = id(6), stranger = id(7), item = id(8), ownerB = id(10);
await db.exec(`insert into auth.users(id,email) values ${[owner, manager, staff, operator, stranger].map((u, i) => `('${u}','del-${i}@example.test')`).join(",")};
 insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Delete A','del-a','active',true,'FR'),('${B}','Delete B','del-b','active',true,'FR');
 insert into restaurant_users(restaurant_id,user_id,role) values ('${A}','${owner}','owner'),('${A}','${manager}','manager'),('${A}','${staff}','staff'),('${B}','${stranger}','owner');
 insert into scanym_operators(user_id) values ('${operator}');
 insert into restaurant_configs(restaurant_id,whatsapp_number,currency,next_order_number) values ('${A}','+33600000000','EUR',1),('${B}','+33600000000','EUR',1);
 insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{}'),('${A}','pickup',true,'{}'),('${B}','delivery',true,'{}');
 insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR'),('${B}','FR');
 insert into menu_categories(id,restaurant_id,name) values ('${id(9)}','${A}','Fixture');
 insert into menu_items(id,category_id,name,price,tax_rate,is_available) values ('${item}','${id(9)}','Product',20,5.5,true);`);
void ownerB;

async function asUser(sql: string, args: unknown[] = [], uid: string | null = owner, role = "authenticated") {
  return db.transaction(async tx => {
    await tx.query("select set_config('test.uid',$1,true)", [uid ?? ""]);
    await tx.exec(`set local role ${role}`);
    return tx.query<Record<string, any>>(sql, args);
  });
}
const payload = (extra: Record<string, unknown> = {}) => ({
  fulfillmentCode: "Zone", provider: "internal", zones: ["75"], enabled: true, isFallback: false,
  pricingMode: "fixed", fixedFee: 6.9, freeThreshold: null, customerText: "Texte", minItems: null, ...extra,
});
async function save(p: Record<string, unknown>, ruleId: string | null = null, uid = owner, tenant = A) {
  if (p.enabled === false) {
    const t = (await asUser("select preview_merchant_delivery_rule_save($1,$2,false) t", [tenant, ruleId], uid)).rows[0].t;
    if (t !== "none") p = { ...p, legacyConfirmation: t };
  }
  return String((await asUser("select mutate_merchant_delivery_rule($1,'save',$2,$3::jsonb) id", [tenant, ruleId, JSON.stringify(p)], uid)).rows[0].id);
}
const del = (rule: string | null, uid: string | null = owner, tenant = A, extra: Record<string, unknown> = {}, role = "authenticated") =>
  asUser("select mutate_merchant_delivery_rule($1,'delete',$2,$3::jsonb) id", [tenant, rule, JSON.stringify(extra)], uid, role);
const rules = async (tenant = A) => (await db.query<Record<string, any>>(
  "select id,fulfillment_code,display_order,enabled,is_fallback from restaurant_sale_mode_fulfillments where restaurant_id=$1 order by display_order", [tenant])).rows;
const snapshotOf = async (tenant = A) => JSON.stringify((await db.query("select to_jsonb(f) r from restaurant_sale_mode_fulfillments f where restaurant_id=$1 order by display_order,id", [tenant])).rows);

let r75: string, r92: string, r93: string, fallback: string, bRule: string;

test("migration is additive: engine functions byte-identical, save/move branches byte-identical to B5, ACL kept", async () => {
  assert.deepEqual(await defs(engineSignatures), enginesBefore, "no delivery engine / checkout / tester / projection function changed");
  const after = await mutateRow();
  assert.notEqual(after.m, b5Mutate.m);
  assert.equal(after.acl, b5Mutate.acl);
  assert.equal(after.prosecdef, true);
  // Removing exactly the delete branch yields the B5 body character for character.
  const sql = readSql(deleteFile);
  const branch = sql.slice(sql.indexOf("  elsif p_action='delete' then"), sql.indexOf("  else raise exception using errcode='22023',message='B234_INVALID_ACTION'"));
  const installed = (await db.query<{ s: string }>("select prosrc s from pg_proc where oid=$1::regprocedure", [MUTATE])).rows[0].s;
  const b5Source = readSql("DRAFT-lot-delivery-pricing-v2-b5.sql");
  const b5Body = b5Source.slice(b5Source.indexOf("create or replace function public.mutate_merchant_delivery_rule"), b5Source.indexOf("drop function public.get_restaurant_public_delivery_fulfillments"));
  const b5Prosrc = b5Body.slice(b5Body.indexOf("$$") + 2, b5Body.lastIndexOf("$$"));
  assert.equal(installed.replace(branch, ""), b5Prosrc);
});

test("migration refuses a second application and drifted predecessors", async () => {
  await assert.rejects(() => db.exec(readSql(deleteFile)), /SCANYM_ALREADY_APPLIED/);
  await db.exec("rollback");
});

test("no direct DELETE/INSERT/UPDATE grant on delivery rules for anon/authenticated; direct DELETE is denied", async () => {
  r75 = await save(payload());
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await db.query<{ y: boolean }>("select has_table_privilege($1,'public.restaurant_sale_mode_fulfillments','DELETE') y", [role])).rows[0].y, false);
    await assert.rejects(() => asUser("delete from restaurant_sale_mode_fulfillments where id=$1", [r75], owner, role), /permission denied/);
  }
  assert.equal((await rules()).length, 1);
});

test("anon and service_role cannot execute the writer", async () => {
  await assert.rejects(() => del(r75, null, A, {}, "anon"), /permission denied/);
  assert.equal((await rules()).length, 1);
});

test("staff and a stranger tenant owner cannot delete; nothing changes", async () => {
  const before = await snapshotOf();
  await assert.rejects(() => del(r75, staff), /Not authorized/);
  await assert.rejects(() => del(r75, stranger), /Not authorized/);
  assert.equal(await snapshotOf(), before);
});

test("cross-tenant and mismatched (restaurant, rule) pairs fail closed", async () => {
  bRule = await save(payload({ fulfillmentCode: "B zone", zones: ["33"] }), null, stranger, B);
  const beforeA = await snapshotOf(A), beforeB = await snapshotOf(B);
  // stranger owns B but targets A's rule through B's restaurant id
  await assert.rejects(() => del(r75, stranger, B), /Delivery rule unavailable/);
  // owner of A targets B's rule through A's restaurant id
  await assert.rejects(() => del(bRule, owner, A), /Delivery rule unavailable/);
  // owner of A targets B directly
  await assert.rejects(() => del(bRule, owner, B), /Not authorized/);
  // operator with mismatched pair
  await assert.rejects(() => del(bRule, operator, A), /Delivery rule unavailable/);
  await assert.rejects(() => del(r75, operator, B), /Delivery rule unavailable/);
  assert.equal(await snapshotOf(A), beforeA);
  assert.equal(await snapshotOf(B), beforeB);
});

test("nonexistent rule, null rule id, junk payload and unknown action fail safely", async () => {
  const before = await snapshotOf();
  await assert.rejects(() => del(id(999)), /Delivery rule unavailable/);
  await assert.rejects(() => del(null), /B234_INVALID_PAYLOAD/);
  await assert.rejects(() => del(r75, owner, A, { force: true }), /B234_INVALID_PAYLOAD/);
  await assert.rejects(() => asUser("select mutate_merchant_delivery_rule($1,'delete',$2,null)", [A, r75]), /B234_INVALID_PAYLOAD/);
  await assert.rejects(() => asUser("select mutate_merchant_delivery_rule($1,'remove',$2,'{}'::jsonb)", [A, r75]), /B234_INVALID_ACTION/);
  assert.equal(await snapshotOf(), before);
});

test("owner, manager and operator can each delete; gaps in display_order are kept and nothing is renumbered", async () => {
  r92 = await save(payload({ fulfillmentCode: "92", zones: ["92"], fixedFee: 10.9 }));
  r93 = await save(payload({ fulfillmentCode: "93", zones: ["93"], fixedFee: 13.9 }));
  fallback = await save(payload({ fulfillmentCode: "Reste", zones: [], isFallback: true, fixedFee: 18.9 }));
  const extra = [] as string[];
  for (const [n, uid] of [["94", owner], ["95", manager], ["96", operator]] as const) extra.push(await save(payload({ fulfillmentCode: n, zones: [n] }), null, uid));
  const orderBefore = new Map((await rules()).map(r => [r.id, r.display_order]));
  assert.equal((await del(extra[0], owner)).rows[0].id, extra[0]);
  assert.equal((await del(extra[1], manager)).rows[0].id, extra[1]);
  assert.equal((await del(extra[2], operator)).rows[0].id, extra[2]);
  const remaining = await rules();
  assert.deepEqual(remaining.map(r => r.id), [r75, r92, r93, fallback]);
  for (const r of remaining) assert.equal(r.display_order, orderBefore.get(r.id), "no renumbering");
  const mid = remaining[1].id;
  await del(mid);
  const gap = await rules();
  assert.deepEqual(gap.map(r => r.id), [r75, r93, fallback]);
  assert.deepEqual(gap.map(r => r.display_order), [orderBefore.get(r75), orderBefore.get(r93), orderBefore.get(fallback)]);
  assert.equal((await rules(B)).length, 1, "other tenant untouched");
  // a new rule after gaps still receives a free order
  r92 = await save(payload({ fulfillmentCode: "92 again", zones: ["92"], fixedFee: 10.9 }));
  assert.equal((await rules()).length, 4);
});

test("historical order survives: fulfillment_rule_id becomes NULL, snapshot and fees are untouched", async () => {
  const customer = { first_name: "Ada", last_name: "Lovelace", phone: "0612345678", email: "ada@example.test", address: "1 rue Test, 93100 Paris", postalCode: "93100", street: "1 rue Test", city: "Paris", country: "FR", delivery_fee: 0, discount_percentage: 100 };
  const order = (await asUser("select * from create_order('del-a','delivery',$1::jsonb,null,$2::jsonb,null,'fr',false)", [JSON.stringify([{ menu_item_id: item, quantity: 1 }]), JSON.stringify(customer)], null, "anon")).rows[0];
  const orderRow = async () => (await db.query<Record<string, any>>("select to_jsonb(o) - 'fulfillment_rule_id' - 'updated_at' o, fulfillment_rule_id from orders o where id=$1", [order.order_id])).rows[0];
  const snap = async () => JSON.stringify((await db.query("select * from order_delivery_fulfillment_snapshot where order_id=$1", [order.order_id])).rows);
  const before = await orderRow(), snapBefore = await snap();
  assert.equal(before.fulfillment_rule_id, r93);
  assert.equal(Number(order.delivery_fee), 13.9);
  await del(r93);
  const afterRow = await orderRow();
  assert.equal(afterRow.fulfillment_rule_id, null);
  assert.deepEqual(afterRow.o, before.o, "every other order column identical (fees, totals, address); only the FK nulls out (updated_at is touched by the existing trigger)");
  assert.equal(await snap(), snapBefore, "B1 snapshot not rewritten, keeps the deleted rule id as a plain value");
  assert.ok(snapBefore.includes(r93));
  assert.equal((await db.query("select id from orders where id=$1", [order.order_id])).rows.length, 1);
});

test("deleting a rule never changes how the remaining rules are priced (engine + tester parity)", async () => {
  const res = async (postal: string) => (await asUser("select test_merchant_delivery_postcode($1,$2,'FR',20,1) r", [A, postal])).rows[0].r;
  assert.equal(Number((await res("75018")).delivery_fee), 6.9);
  assert.equal(Number((await res("93100")).delivery_fee), 18.9, "93 deleted -> falls back, by the unchanged resolver");
  assert.equal(Number((await res("69001")).delivery_fee), 18.9);
});

test("last ACTIVE rule: confirmation is mandatory and server-computed; wrong/missing refused; cancel = no mutation", async () => {
  // disable everything except the fallback, then try to delete it
  for (const r of await rules()) if (r.id !== fallback) await save({ ...payload({ fulfillmentCode: r.fulfillment_code, zones: r.fulfillment_code === "Zone" ? ["75"] : ["92"], enabled: false }) }, r.id);
  const before = await snapshotOf();
  // legacy-unavailable (config has no zones)
  await assert.rejects(() => del(fallback), /B234_CONFIRM_LEGACY_REQUIRED/);
  await assert.rejects(() => del(fallback, owner, A, { legacyConfirmation: "legacy-zones" }), /B234_CONFIRM_LEGACY_REQUIRED/);
  await assert.rejects(() => del(fallback, owner, A, { legacyConfirmation: "none" }), /B234_CONFIRM_LEGACY_REQUIRED/);
  assert.equal(await snapshotOf(), before);
  assert.equal((await asUser("select preview_merchant_delivery_rule_save($1,$2,false) t", [A, fallback])).rows[0].t, "legacy-unavailable");
  await db.query("update restaurant_sale_modes set config='{\"delivery_zone_prefixes\":[\"75\"]}' where restaurant_id=$1 and mode_code='delivery'", [A]);
  await assert.rejects(() => del(fallback, owner, A, { legacyConfirmation: "legacy-unavailable" }), /B234_CONFIRM_LEGACY_REQUIRED/);
  assert.equal((await del(fallback, owner, A, { legacyConfirmation: "legacy-zones" })).rows[0].id, fallback);
  assert.ok(!(await rules()).some(r => r.id === fallback));
  const tester = (await asUser("select test_merchant_delivery_postcode($1,'75018','FR',20,1) r", [A])).rows[0].r;
  assert.ok(tester, "tester keeps working on the unchanged legacy path");
});

test("deleting an already disabled rule never requires a legacy confirmation; deleting the final row is allowed with it", async () => {
  const left = await rules();
  assert.ok(left.length >= 2 && left.every(r => !r.enabled));
  await del(left[0].id);
  for (const r of (await rules())) await del(r.id);
  assert.equal((await rules()).length, 0);
  assert.equal((await rules(B)).length, 1);
});

test("structural invariants stay enforced by the shared validator after a delete (fallback uniqueness, unique order)", async () => {
  const f1 = await save(payload({ fulfillmentCode: "F", zones: [], isFallback: true }));
  await assert.rejects(() => save(payload({ fulfillmentCode: "F2", zones: [], isFallback: true })), /one_fallback|MULTIPLE-DEFAULTS|B234|ZV-/);
  await del(f1, owner, A, { legacyConfirmation: "legacy-zones" }).catch(() => del(f1, owner, A, { legacyConfirmation: "legacy-unavailable" }));
  const f2 = await save(payload({ fulfillmentCode: "F3", zones: [], isFallback: true }));
  assert.equal((await rules()).filter(r => r.is_fallback).length, 1);
  assert.ok(f2);
  const orders = (await rules()).map(r => r.display_order);
  assert.equal(new Set(orders).size, orders.length);
});

test("rollback restores the exact B5 writer (delete refused) and is refused on a drifted body; reapply works", async () => {
  await db.exec(readSql(rollbackFile));
  const back = await mutateRow();
  assert.equal(back.m, b5Mutate.m);
  assert.equal(back.acl, b5Mutate.acl);
  const any = (await rules())[0]?.id ?? (await save(payload({ fulfillmentCode: "R", zones: ["12"] })));
  await assert.rejects(() => del(any), /B234_INVALID_ACTION/);
  await assert.rejects(() => db.exec(readSql(rollbackFile)), /SCANYM_SCHEMA_DRIFT/);
  await db.exec("rollback");
  await db.exec(readSql(deleteFile));
  assert.notEqual((await mutateRow()).m, b5Mutate.m);
  assert.deepEqual(await defs(engineSignatures), enginesBefore);
});

test("migration file is a single transaction, not applied anywhere, and contains no table GRANT", () => {
  for (const f of [deleteFile, rollbackFile]) {
    const sql = readFileSync(new URL(`../supabase/${f}`, import.meta.url), "utf8");
    assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;$/m);
    assert.doesNotMatch(sql, /grant\s+(delete|all|insert|update)\b/i);
    assert.doesNotMatch(sql, /grant\s+execute[^;]*\bto\s+(anon|public)\b/i);
  }
});
