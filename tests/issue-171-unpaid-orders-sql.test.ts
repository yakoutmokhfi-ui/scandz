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
  await db.exec("rollback"); // AUD179-04: the lot is one explicit transaction -- close the aborted one.
  const def = await db.query<{ d: string }>("select pg_get_functiondef(to_regprocedure('public.update_order_status(uuid,text)')) as d");
  assert.match(def.rows[0].d, /ORDER_PAYMENT_NOT_OPERATIONAL/);
  await db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1-rollback.sql"));
  const after = await db.query<{ d: string; p: string }>("select pg_get_functiondef(to_regprocedure('public.update_order_status(uuid,text)')) as d, pg_get_functiondef(to_regprocedure('public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)')) as p");
  assert.doesNotMatch(after.rows[0].d, /payment_status/);
  assert.doesNotMatch(after.rows[0].p, /payment_status/);
  await assert.rejects(db.exec(readSql("DRAFT-lot-issue-171-unpaid-orders-not-operational-v1-rollback.sql")), /rien à annuler/);
  await db.exec("rollback");
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


// --------------------------------------------------------------------
// AUD179-04 -- atomicity of the lot and of its rollback
// --------------------------------------------------------------------

const LOT = "DRAFT-lot-issue-171-unpaid-orders-not-operational-v1.sql";
const ROLLBACK = "DRAFT-lot-issue-171-unpaid-orders-not-operational-v1-rollback.sql";

/** Snapshot of everything the lot may change: both bodies + ACL + security attributes. */
async function snapshot(db: Awaited<ReturnType<typeof makeDb>>) {
  const r = await db.query<Record<string, unknown>>(`select
    pg_get_functiondef('public.update_order_status(uuid,text)'::regprocedure) as upd,
    pg_get_functiondef('public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)'::regprocedure) as page,
    (select proacl::text from pg_proc where oid = 'public.update_order_status(uuid,text)'::regprocedure) as upd_acl,
    (select proacl::text from pg_proc where oid = 'public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)'::regprocedure) as page_acl,
    (select prosecdef::text || provolatile::text || coalesce(proconfig::text,'') from pg_proc where oid = 'public.update_order_status(uuid,text)'::regprocedure) as upd_sec,
    (select prosecdef::text || provolatile::text || coalesce(proconfig::text,'') from pg_proc where oid = 'public.get_operator_restaurant_orders_page(uuid,boolean,timestamptz,uuid)'::regprocedure) as page_sec`);
  return r.rows[0];
}

/**
 * Splits a SQL file into top-level statements (outside '...' and $$...$$,
 * full-line `--` comments removed) -- the way a line-oriented runner in
 * autocommit mode would send them one by one.
 */
function splitStatements(sql: string): string[] {
  const text = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const out: string[] = [];
  let cur = "", inDollar = false, inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inQuote && text.startsWith("$$", i)) { inDollar = !inDollar; cur += "$$"; i++; continue; }
    if (!inDollar && c === "'") inQuote = !inQuote;
    if (!inDollar && !inQuote && c === ";") { if (cur.trim()) out.push(cur.trim() + ";"); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Runs statements one at a time; stops at the first error (as a runner would), then ends the session's transaction. */
async function runStatementByStatement(db: Awaited<ReturnType<typeof makeDb>>, sql: string): Promise<Error | null> {
  for (const stmt of splitStatements(sql)) {
    try {
      await db.exec(stmt);
    } catch (err) {
      await db.exec("rollback"); // session ends -> open transaction rolled back by PostgreSQL
      return err as Error;
    }
  }
  return null;
}

test("AUD179-04 (auditor's reproduction): EXECUTE revoked from authenticated, lot run STATEMENT BY STATEMENT in autocommit -> refused by the PRE-check, nothing replaced, and a re-run after fixing the grant succeeds (no 'double application' lock-out)", async () => {
  const db = await makeDb();
  await db.exec("revoke execute on function public.update_order_status(uuid, text) from authenticated;");
  const before = await snapshot(db);
  const err = await runStatementByStatement(db, readSql(LOT));
  assert.ok(err, "the lot must fail");
  assert.match(err!.message, /SCANYM_PRE_CHECK_FAILED: update_order_status grants drift/);
  assert.deepEqual(await snapshot(db), before, "no body, ACL or security attribute changed");
  await db.exec("grant execute on function public.update_order_status(uuid, text) to authenticated;");
  assert.equal(await runStatementByStatement(db, readSql(LOT)), null, "re-run after correction succeeds");
  assert.match(String((await snapshot(db)).upd), /ORDER_PAYMENT_NOT_OPERATIONAL/);
});

test("AUD179-04: a failure forced just before COMMIT (post-check stage) rolls EVERYTHING back -- both modes (single request and statement by statement)", async () => {
  const forced = readSql(LOT).replace(/\ncommit;\s*$/, () => "\ndo $$ begin raise exception 'FORCED_POSTCHECK_FAILURE'; end $$;\ncommit;\n");
  assert.notEqual(forced, readSql(LOT), "injection point found");
  for (const mode of ["single", "statements"] as const) {
    const db = await makeDb();
    const before = await snapshot(db);
    if (mode === "single") {
      await assert.rejects(db.exec(forced), /FORCED_POSTCHECK_FAILURE/);
      await db.exec("rollback");
    } else {
      const err = await runStatementByStatement(db, forced);
      assert.match(err!.message, /FORCED_POSTCHECK_FAILURE/);
    }
    assert.deepEqual(await snapshot(db), before, `${mode}: nothing changed`);
    // The real lot still applies afterwards.
    await db.exec(readSql(LOT));
    assert.match(String((await snapshot(db)).upd), /ORDER_PAYMENT_NOT_OPERATIONAL/);
  }
});

test("AUD179-04: the ROLLBACK script is atomic too -- forced failure before its COMMIT leaves the applied lot intact; its normal run restores bodies, ACL and security exactly", async () => {
  const db = await makeDb();
  const original = await snapshot(db);
  await db.exec(readSql(LOT));
  const applied = await snapshot(db);
  const forced = readSql(ROLLBACK).replace(/\ncommit;\s*$/, () => "\ndo $$ begin raise exception 'FORCED_ROLLBACK_FAILURE'; end $$;\ncommit;\n");
  assert.notEqual(forced, readSql(ROLLBACK));
  await assert.rejects(db.exec(forced), /FORCED_ROLLBACK_FAILURE/);
  await db.exec("rollback");
  assert.deepEqual(await snapshot(db), applied, "applied state intact after a failed rollback");
  await db.exec(readSql(ROLLBACK));
  const restored = await snapshot(db);
  assert.equal(restored.upd_acl, original.upd_acl);
  assert.equal(restored.page_acl, original.page_acl);
  assert.equal(restored.upd_sec, original.upd_sec);
  assert.equal(restored.page_sec, original.page_sec);
  assert.doesNotMatch(String(restored.upd), /payment_status/);
  assert.doesNotMatch(String(restored.page), /payment_status/);
});
