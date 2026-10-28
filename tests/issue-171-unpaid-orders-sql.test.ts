import { test } from "node:test";
import assert from "node:assert/strict";
import { makePaginationDb, readSql, uuid, TENANT_A, TENANT_B, MERCHANT, OPERATOR } from "./helpers/dashboard-pagination-db.ts";

/**
 * ISSUE #171 — SQL proofs on a REAL PostgreSQL (PGlite), reusing the
 * DASHBOARD PAGINATION v1 harness (real is_scanym_operator, real RLS
 * policy, real operator page RPC) extended with orders.payment_status and
 * the REAL V29 update_order_status, then applying this lot's draft.
 *
 * Six payment states × operator view / history / status mutation.
 */

const STATES = ["not_required", "required", "pending", "paid", "failed", "cancelled"] as const;
const OPERATIONAL = new Set(["not_required", "paid"]);

async function makeDb() {
  const db = await makePaginationDb();
  await db.exec(`alter table public.orders add column payment_status text not null default 'not_required'
    check (payment_status in ('not_required','required','pending','paid','failed','cancelled'));`);
  const v29 = readSql("migration-v29-merchant-dashboard.sql");
  const upd = v29.match(/create function public\.update_order_status\([\s\S]*?\nend \$\$;\n/)![0];
  await db.exec(upd);
  await db.exec(`revoke all on function public.update_order_status(uuid, text) from public, anon; grant execute on function public.update_order_status(uuid, text) to authenticated;`);
  return db;
}

/** One `new` order per payment state for a tenant, order_number = index+1. */
async function seedStates(db: Awaited<ReturnType<typeof makeDb>>, tenant: string, base: number) {
  for (const [i, ps] of STATES.entries()) {
    await db.query(`insert into public.orders(id,restaurant_id,order_number,status,payment_status,created_at) values ($1::uuid,$2::uuid,$3,'new',$4,'2026-10-01T12:00:00Z'::timestamptz)`, [uuid(base + i), tenant, base + i, ps]);
  }
}

async function as(db: Awaited<ReturnType<typeof makeDb>>, user: string, fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<void>) {
  await db.transaction(async (tx) => {
    await tx.query("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    await fn((sql, params) => tx.query(sql, params));
  });
}

test("ISSUE #171 SQL: the draft applies on top of PAGINATION v1 + V29, refuses double application, and the rollback restores the previous bodies", async () => {
  const db = await makeDb();
  await db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql"));
  await assert.rejects(db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql")), /double application/);
  const def = await db.query<{ d: string }>("select pg_get_functiondef(to_regprocedure('public.update_order_status(uuid,text)')) as d");
  assert.match(def.rows[0].d, /ORDER_PAYMENT_NOT_OPERATIONAL/);
  await db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1-rollback.sql"));
  const after = await db.query<{ d: string; p: string }>("select pg_get_functiondef(to_regprocedure('public.update_order_status(uuid,text)')) as d, pg_get_functiondef(to_regprocedure('public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)')) as p");
  assert.doesNotMatch(after.rows[0].d, /payment_status/);
  assert.doesNotMatch(after.rows[0].p, /payment_status/);
  await assert.rejects(db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1-rollback.sql")), /rien à annuler/);
});

test("ISSUE #171 SQL: operator OPERATIONAL view returns only not_required+paid `new` orders; HISTORY returns all six; projection (ten approved fields) unchanged; tenant isolation kept", async () => {
  const db = await makeDb();
  await db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql"));
  await seedStates(db, TENANT_A, 100);
  await seedStates(db, TENANT_B, 200);
  await as(db, OPERATOR, async (q) => {
    const op = await q("select * from public.get_operator_restaurant_orders_page($1::uuid,false,null,null)", [TENANT_A]);
    assert.deepEqual(op.rows.map((r: any) => Number(r.order_number)).sort(), [100, 103], "not_required (100) and paid (103) only");
    assert.deepEqual(Object.keys(op.rows[0]).sort(), ["created_at", "currency", "has_invoice_request", "id", "item_count", "order_number", "service_mode", "status", "total", "updated_at"], "ten approved fields, no payment_status leak");
    const hist = await q("select * from public.get_operator_restaurant_orders_page($1::uuid,true,null,null)", [TENANT_A]);
    assert.equal(hist.rows.length, 6, "history keeps every payment state for audit");
    const b = await q("select * from public.get_operator_restaurant_orders_page($1::uuid,false,null,null)", [TENANT_B]);
    assert.deepEqual(b.rows.map((r: any) => Number(r.order_number)).sort(), [200, 203]);
  });
  // The merchant RLS read is untouched: a merchant still SEES every row of its tenant
  // (the operational filter is applied by the client query, see dashboard.ts) --
  // the server-side protection for merchants is the update_order_status guard below.
  await as(db, MERCHANT, async (q) => {
    const rows = await q("select payment_status from public.orders where restaurant_id=$1::uuid order by order_number", [TENANT_A]);
    assert.equal(rows.rows.length, 6);
  });
});

test("ISSUE #171 SQL: update_order_status is a DENY list -- accepts not_required and paid, refuses required/pending/failed/cancelled with 42501 ORDER_PAYMENT_NOT_OPERATIONAL; V29 rules otherwise intact", async () => {
  const db = await makeDb();
  await db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql"));
  await seedStates(db, TENANT_A, 100);
  await seedStates(db, TENANT_B, 200);
  for (const [i, ps] of STATES.entries()) {
    const id = uuid(100 + i);
    if (OPERATIONAL.has(ps)) {
      await as(db, MERCHANT, async (q) => {
        const r = await q("select * from public.update_order_status($1::uuid,'accepted')", [id]);
        assert.equal(r.rows[0].new_status, "accepted", ps);
      });
      const row = await db.query<{ status: string }>("select status from public.orders where id=$1::uuid", [id]);
      assert.equal(row.rows[0].status, "accepted", ps);
    } else {
      // One transaction per refused call (an error aborts the PostgreSQL transaction).
      await as(db, MERCHANT, async (q) => {
        await assert.rejects(q("select * from public.update_order_status($1::uuid,'accepted')", [id]), (e: any) => e.code === "42501" && /ORDER_PAYMENT_NOT_OPERATIONAL: payment_status=/.test(e.message), ps);
      });
      await as(db, MERCHANT, async (q) => {
        await assert.rejects(q("select * from public.update_order_status($1::uuid,'rejected')", [id]), (e: any) => e.code === "42501", ps + " rejected");
      });
      const row = await db.query<{ status: string }>("select status from public.orders where id=$1::uuid", [id]);
      assert.equal(row.rows[0].status, "new", `${ps}: status untouched`);
    }
  }
  // V29 rules preserved: foreign tenant refused BEFORE the payment guard; invalid transition still 22023; anon refused.
  await as(db, MERCHANT, async (q) => {
    await assert.rejects(q("select * from public.update_order_status($1::uuid,'accepted')", [uuid(200)]), (e: any) => e.code === "42501" && /Not authorized/.test(e.message));
  });
  await as(db, MERCHANT, async (q) => {
    await assert.rejects(q("select * from public.update_order_status($1::uuid,'completed')", [uuid(103)]), (e: any) => e.code === "22023");
  });
  await as(db, MERCHANT, async (q) => {
    await assert.rejects(q("select * from public.update_order_status($1::uuid,'bogus')", [uuid(103)]), (e: any) => e.code === "22023");
  });
  await db.transaction(async (tx) => {
    await tx.query("set local role anon");
    await assert.rejects(tx.query("select * from public.update_order_status($1::uuid,'accepted')", [uuid(100)]));
  });
  // A paid order that was refused by the kitchen keeps working as before (paid is operational end to end).
  await as(db, MERCHANT, async (q) => {
    await q("select * from public.update_order_status($1::uuid,'preparing')", [uuid(103)]);
    await q("select * from public.update_order_status($1::uuid,'ready')", [uuid(103)]);
    const r = await q("select * from public.update_order_status($1::uuid,'completed')", [uuid(103)]);
    assert.equal(r.rows[0].new_status, "completed");
  });
});

test("ISSUE #171 SQL: a merchant WITHOUT online payment (all orders not_required) is unaffected -- every V29 transition still works", async () => {
  const db = await makeDb();
  await db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql"));
  await db.query(`insert into public.orders(id,restaurant_id,order_number,status,created_at) values ($1::uuid,$2::uuid,1,'new','2026-10-01T12:00:00Z'::timestamptz)`, [uuid(300), TENANT_A]);
  await as(db, MERCHANT, async (q) => {
    for (const s of ["accepted", "preparing", "ready", "completed"]) {
      const r = await q("select * from public.update_order_status($1::uuid,$2)", [uuid(300), s]);
      assert.equal(r.rows[0].new_status, s);
    }
  });
  await as(db, OPERATOR, async (q) => {
    const op = await q("select * from public.get_operator_restaurant_orders_page($1::uuid,true,null,null)", [TENANT_A]);
    assert.equal(op.rows.length, 1);
  });
});
