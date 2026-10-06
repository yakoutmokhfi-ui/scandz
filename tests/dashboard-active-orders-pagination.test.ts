import { after, before, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ORDER_PAGE_SIZE, orderPage, readOrderWindow, compareOrderKeys, type OrderCursor, type OrderPage } from "../lib/dashboard-pagination.ts";
import { makePaginationDb, seed, uuid, readSql, TENANT_A, TENANT_B, MERCHANT, OPERATOR } from "./helpers/dashboard-pagination-db.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-test-only";
const { getDashboardOrders, getOperatorRestaurantOrders } = await import("../lib/services/dashboard.ts");
let db: Awaited<ReturnType<typeof makePaginationDb>>;
let user = MERCHANT;
const requests: URL[] = [];
const approved = ["id", "order_number", "status", "service_mode", "created_at", "updated_at", "total", "currency", "item_count", "has_invoice_request"];
type FetchBatch = (id: string, history?: boolean, cursor?: OrderCursor | null) => Promise<OrderCursor[]>;

before(async () => { db = await makePaginationDb(); });
after(async () => { await db?.close(); });
beforeEach(async (t) => {
  await db.exec("truncate public.order_items, public.order_invoice_request, public.orders;");
  user = MERCHANT;
  requests.length = 0;
  // Real supabase-js request generation -> strict, small PostgREST test adapter
  // -> real local PostgreSQL/RLS/RPC. Not a hosted PostgREST integration test.
  (t as TestContext).mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:9", "no external request permitted");
    requests.push(url);
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
        if (url.pathname.endsWith("/rpc/get_operator_restaurant_orders_page")) {
          const args = JSON.parse(String(init?.body));
          const r = await tx.query<{ row: Record<string, unknown> }>(`select row_to_json(r) as row from
            public.get_operator_restaurant_orders_page($1::uuid,$2::boolean,$3::timestamptz,$4::uuid) r`,
          [args.p_restaurant_id, args.p_include_completed, args.p_before_created_at, args.p_before_id]);
          return r.rows.map(r => r.row);
        }
        assert.equal(url.pathname, "/rest/v1/orders");
        assert.equal(url.searchParams.get("order"), "created_at.desc,id.desc");
        assert.equal(url.searchParams.get("limit"), "51");
        const tenant = url.searchParams.get("restaurant_id")!.replace(/^eq\./, "");
        const active = url.searchParams.has("status");
        if (active) assert.equal(url.searchParams.get("status"), "not.in.(completed,rejected,cancelled)");
        const or = url.searchParams.get("or");
        let before: string | null = null, id: string | null = null;
        if (or) {
          const match = or.match(/^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([0-9a-f-]+)\)\)$/);
          assert.ok(match, `unexpected cursor filter ${or}`);
          assert.equal(match[1], match[2]);
          before = match[1]; id = match[3];
        }
        const r = await tx.query<{ row: Record<string, unknown> }>(`select row_to_json(o) as row from public.orders o
          where restaurant_id=$1::uuid and (not $2::boolean or status not in ('completed','rejected','cancelled'))
          and ($3::timestamptz is null or (created_at,id)<($3::timestamptz,$4::uuid))
          order by created_at desc,id desc limit 51`, [tenant, active, before, id]);
        return r.rows.map(r => r.row);
      });
      return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ message: (error as Error).message }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  });
});

for (const [index, count] of [0, 1, 49, 50, 51, 100, 237].entries()) {
  for (const operator of [false, true]) {
    test(`P${index + 1} ${operator ? "operator" : "merchant"}: ${count} active orders all reachable`, async () => {
      await seed(db, count);
      user = operator ? OPERATOR : MERCHANT;
      const fetchBatch: FetchBatch = operator ? getOperatorRestaurantOrders : getDashboardOrders;
      const ids: string[] = [];
      let cursor: OrderCursor | null = null;
      do {
        const page: OrderPage<OrderCursor> = orderPage(await fetchBatch(TENANT_A, false, cursor));
        if (ids.length === 0) assert.equal(page.nextCursor !== null, count > 50);
        ids.push(...page.orders.map(r => r.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(ids, Array.from({ length: count }, (_, i) => uuid(count - i)));
      assert.equal(new Set(ids).size, count);
    });
  }
}

test("P8/P9/P10: identical timestamps, microsecond boundaries, deterministic continuation in both paths", async () => {
  await seed(db, 155);
  await db.exec("update public.orders set created_at='2026-10-01T12:00:00.123457Z' where order_number % 3=0");
  const expected = (await db.query<{ id: string }>("select id from public.orders order by created_at desc,id desc")).rows.map(r => r.id);
  for (const operator of [false, true]) {
    user = operator ? OPERATOR : MERCHANT;
    const fetchBatch: FetchBatch = operator ? getOperatorRestaurantOrders : getDashboardOrders;
    const first = orderPage(await fetchBatch(TENANT_A));
    const second = orderPage(await fetchBatch(TENANT_A, false, first.nextCursor));
    assert.deepEqual(first.orders.map(r => r.id), expected.slice(0, 50));
    assert.deepEqual(second.orders.map(r => r.id), expected.slice(50, 100));
    const all = await readOrderWindow(c => fetchBatch(TENANT_A, false, c), { created_at: "2000-01-01T00:00:00Z", id: uuid(0) });
    assert.deepEqual(all.orders.map(r => r.id), expected);
    assert.equal(all.nextCursor, null);
  }
  assert.equal(compareOrderKeys({ id: uuid(1), created_at: "2026-10-01T14:00:00.123456+02:00" }, { id: uuid(1), created_at: "2026-10-01T12:00:00.123456Z" }), 0);
});

test("P11: merchant A cannot read tenant B, including a cursor from B", async () => {
  await seed(db, 101, TENANT_B);
  assert.deepEqual(await getDashboardOrders(TENANT_B), []);
  assert.deepEqual(await getDashboardOrders(TENANT_B, true, { id: uuid(90), created_at: "2026-10-01T12:00:00.123456Z" }), []);
  // An operator can read B by existing authorization, but receives B only.
  user = OPERATOR;
  assert.equal((await getOperatorRestaurantOrders(TENANT_B)).length, 51);
  assert.deepEqual(await getOperatorRestaurantOrders(TENANT_A), []);
});

test("P12: non-operator and unauthenticated uid rejected; no merchant fallback", async () => {
  await seed(db, 1);
  await assert.rejects(getOperatorRestaurantOrders(TENANT_A), /Not authorized/);
  user = "";
  await assert.rejects(getOperatorRestaurantOrders(TENANT_A), /Authentication required/);
  assert.ok(requests.every(r => r.pathname.endsWith("/rpc/get_operator_restaurant_orders_page")));
  const grants = await db.query<{ anon: boolean; service: boolean }>(`select
    has_function_privilege('anon','public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)','EXECUTE') as anon,
    has_function_privilege('service_role','public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)','EXECUTE') as service`);
  assert.deepEqual(grants.rows, [{ anon: false, service: false }]);
});

test("P13: actual SQL and service each expose exactly the ten approved operator fields", async (t) => {
  await seed(db, 1);
  await db.query("insert into public.order_items values ($1,$2,3)", [uuid(2000), uuid(1)]);
  await db.query("insert into public.order_invoice_request values ($1,'SECRET')", [uuid(1)]);
  user = OPERATOR;
  const rows = await getOperatorRestaurantOrders(TENANT_A);
  assert.deepEqual(Object.keys(rows[0]), approved);
  assert.equal(rows[0].item_count, 3);
  assert.equal(rows[0].has_invoice_request, true);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OPERATOR]);
  const raw = await db.query<{ row: Record<string, unknown> }>("select row_to_json(r) as row from public.get_operator_restaurant_orders_page($1) r", [TENANT_A]);
  assert.deepEqual(Object.keys(raw.rows[0].row), approved);
  // Even an unexpectedly widened network response cannot cross the DTO mapping.
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([{ ...raw.rows[0].row,
    customer_name: "PRIVATE", phone: "PRIVATE", email: "PRIVATE", address: "PRIVATE", note: "PRIVATE", public_token: "PRIVATE", extra: "PRIVATE" }]),
    { headers: { "Content-Type": "application/json" } }));
  assert.deepEqual(Object.keys((await getOperatorRestaurantOrders(TENANT_A))[0]), approved);
});

test("P14: resolving/deleting the boundary does not skip next-page active rows; refresh includes reopened rows and new arrivals", async () => {
  await seed(db, 125);
  const first = orderPage(await getDashboardOrders(TENANT_A));
  assert.equal(first.nextCursor?.id, uuid(76));
  await db.query("update public.orders set status='completed' where id=$1", [uuid(76)]);
  await db.query("update public.orders set status='rejected' where id=$1", [uuid(75)]);
  const second = orderPage(await getDashboardOrders(TENANT_A, false, first.nextCursor));
  assert.deepEqual(second.orders.map(r => r.id), Array.from({ length: 50 }, (_, i) => uuid(74 - i)));
  await db.query("delete from public.orders where id=$1", [uuid(76)]);
  await db.query("update public.orders set status='new' where id=$1", [uuid(75)]);
  await db.exec(`insert into public.orders(id,restaurant_id,order_number,status,created_at)
    values ('${uuid(126)}','${TENANT_A}',126,'new','2026-10-02T00:00:00Z')`);
  const refreshed = await readOrderWindow(c => getDashboardOrders(TENANT_A, false, c), second.orders.at(-1)!);
  assert.equal(refreshed.orders[0].id, uuid(126));
  assert.ok(refreshed.orders.some(r => r.id === uuid(75)));
  assert.ok(refreshed.orders.some(r => r.id === uuid(25)), "already reached frontier retained");
  assert.equal(new Set(refreshed.orders.map(r => r.id)).size, refreshed.orders.length);
});

test("P15/P16: >1000 active orders and all-history traversal have no total cap; statuses preserved", async () => {
  await seed(db, 1203);
  await db.exec("update public.orders set status=case order_number when 1 then 'completed' when 2 then 'rejected' when 3 then 'cancelled' else 'preparing' end");
  for (const operator of [false, true]) {
    user = operator ? OPERATOR : MERCHANT;
    const fetchBatch: FetchBatch = operator ? getOperatorRestaurantOrders : getDashboardOrders;
    for (const history of [false, true]) {
      const all = await readOrderWindow(c => fetchBatch(TENANT_A, history, c), { id: uuid(0), created_at: "2000-01-01T00:00:00Z" });
      assert.equal(all.orders.length, history ? 1203 : 1200);
      assert.equal(all.nextCursor, null);
    }
  }
  assert.equal(ORDER_PAGE_SIZE, 50);
});

test("malformed cursors fail before transport; partial SQL cursor rejected", async () => {
  await assert.rejects(getDashboardOrders(TENANT_A, false, { id: "x),status.eq.new", created_at: "today" }), /Invalid order cursor/);
  await assert.rejects(getOperatorRestaurantOrders(TENANT_A, false, { id: uuid(1), created_at: "x" }), /Invalid order cursor/);
  assert.equal(requests.length, 0);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OPERATOR]);
  await assert.rejects(db.query("select * from public.get_operator_restaurant_orders_page($1,false,now(),null)", [TENANT_A]), /Both order cursor fields/);
});

test("forward/rollback: additive RPC only, predecessor restored byte-for-byte and repeat forward works", async () => {
  const definition = async () => (await db.query("select pg_get_functiondef('public.get_operator_restaurant_orders(uuid,boolean)'::regprocedure) as definition")).rows;
  const before = await definition();
  await db.exec(readSql("DRAFT-dashboard-active-orders-pagination-v1-rollback.sql"));
  assert.deepEqual(await definition(), before);
  await db.exec(readSql("DRAFT-dashboard-active-orders-pagination-v1.sql"));
  assert.deepEqual(await definition(), before);
});
