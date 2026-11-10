import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const install = readFileSync(
  "supabase/DRAFT-lot-order-invoice-pdf-v1.sql",
  "utf8",
);
const rollback = readFileSync(
  "supabase/DRAFT-lot-order-invoice-pdf-v1-rollback.sql",
  "utf8",
);
const R = "20000000-0000-4000-8000-000000000001",
  O = "10000000-0000-4000-8000-000000000001",
  P = "40000000-0000-4000-8000-000000000001";
const ddl = `
 create role anon;create role authenticated;create role service_role;
 create table restaurants(id uuid primary key,country text);
 create function has_role_in(uuid,text[]) returns boolean language sql as 'select false';
 create table orders(id uuid primary key,restaurant_id uuid,order_number bigint,status text,payment_status text,current_payment_transaction_id uuid,service_mode text,created_at timestamptz,currency text,subtotal numeric,total numeric,customer_name text,customer_email text,tax_settings_snapshot_prices_include_tax boolean,tax_settings_snapshot_default_tax_rate numeric,tax_settings_snapshot_tax_label text,tax_settings_snapshot_show_tax_summary boolean);
 create table order_items(id uuid primary key,order_id uuid,item_name text,option_name text,quantity integer,unit_price numeric,line_total numeric,tax_rate_snapshot numeric);
 create table order_delivery_tax_allocations(order_id uuid,tax_rate_snapshot numeric,delivery_fee_gross_share numeric,delivery_fee_net_share numeric,delivery_fee_tax_amount numeric);
 create table order_invoice_request(order_id uuid primary key,invoice_type text,company_legal_name text,contact_name text,contact_email text,address_line_1 text,address_line_2 text,postal_code text,city text,country text,vat_number text,siren text,created_at timestamptz);
 create table receipt_settings(restaurant_id uuid primary key,legal_name text,legal_address text,registration_number text,tax_identifier text,email text);
 create table merchant_legal_profile(restaurant_id uuid primary key,legal_entity_name text,address_line1 text,address_line2 text,postal_code text,city text,governing_country text,siret text,siren text,vat_number text,legal_form text);
 create table merchant_notification_profile(restaurant_id uuid primary key,email_enabled boolean,sender_email text,sender_name text,reply_to text);
 create table payment_transactions(id uuid primary key,restaurant_id uuid,order_id uuid,status text,amount numeric,currency text,paid_at timestamptz,provider_code text);
 insert into restaurants values('${R}','FR');
`;
async function setup() {
  const db = new PGlite();
  await db.exec(ddl);
  await db.exec(install);
  return db;
}
async function seed(db: PGlite) {
  await db.exec(`
 insert into invoice_pdf_settings(restaurant_id,series,enabled,legal_footer) values('${R}','DEMO',true,'Test only');
 insert into orders values('${O}','${R}',124,'new','paid','${P}','pickup',clock_timestamp()+interval '1 second','EUR',12,12,'Client','client@example.com',true,20,'TVA',true);
 insert into order_items values('30000000-0000-4000-8000-000000000001','${O}','Vin',null,1,12,12,20);
 insert into order_invoice_request values('${O}','individual',null,'Client','client@example.com','2 rue Test',null,'75000','Paris','FR',null,null,clock_timestamp()+interval '1 second');
 insert into receipt_settings values('${R}','Marchand','1 rue Test','00000000000000','FR00000000000','marchand@example.com');
 insert into merchant_legal_profile(restaurant_id) values('${R}');
 insert into merchant_notification_profile values('${R}',true,'marchand@example.com','Marchand',null);
 insert into payment_transactions values('${P}','${R}','${O}','paid',12,'EUR',clock_timestamp(),'monetico');
`);
}
async function source(db: PGlite) {
  return (await db.query<{ s: any }>(`select invoice_pdf_source('${O}') s`))
    .rows[0].s;
}
async function issue(db: PGlite) {
  return (
    await db.query<{ id: string; invoice_number: string; source: any }>(
      "select * from invoice_pdf_issue($1,$2::jsonb)",
      [O, JSON.stringify(await source(db))],
    )
  ).rows[0];
}
// Independent live snapshot of the catalogue state of every invoice object. It deliberately does NOT use the
// stored manifest nor invoice_pdf_fingerprint(): both are themselves drift targets. A query error is a test
// failure (never an empty "unchanged" value).
const LIVE_STATE = `select md5(concat_ws('|',
 (select coalesce(jsonb_agg(to_jsonb(p) order by p.oid::regprocedure::text),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'invoice_pdf%')::text,
 (select coalesce(jsonb_agg(jsonb_build_array(c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,c.reloptions::text,c.relreplident::text,obj_description(c.oid,'pg_class')) order by c.relname),'[]') from pg_class c where c.relname like 'invoice_pdf%' and c.relkind='r')::text,
 (select coalesce(jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl::text,col_description(c.oid,a.attnum)) order by c.relname,a.attnum),'[]') from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where c.relname like 'invoice_pdf%' and c.relkind='r')::text,
 (select coalesce(jsonb_agg(jsonb_build_array(k.conrelid::regclass::text,k.conname,pg_get_constraintdef(k.oid),k.convalidated) order by k.conrelid::regclass::text,k.conname),'[]') from pg_constraint k where k.conrelid::regclass::text like 'invoice_pdf%')::text,
 (select coalesce(jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text),'[]') from pg_index i where i.indrelid::regclass::text like 'invoice_pdf%')::text,
 (select coalesce(jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,pg_get_triggerdef(t.oid),t.tgenabled::text) order by t.tgrelid::regclass::text,t.tgname),'[]') from pg_trigger t where not t.tgisinternal and t.tgrelid::regclass::text like 'invoice_pdf%')::text,
 (select coalesce(jsonb_agg(jsonb_build_array(s.stxrelid::regclass::text,s.stxname,pg_get_statisticsobjdef(s.oid)) order by s.stxname),'[]') from pg_statistic_ext s where s.stxrelid::regclass::text like 'invoice_pdf%')::text,
 (select coalesce(jsonb_agg(jsonb_build_array(r.ev_class::regclass::text,r.rulename) order by r.rulename),'[]') from pg_rewrite r where r.ev_class::regclass::text like 'invoice_pdf%')::text,
 (select coalesce(jsonb_agg(jsonb_build_array(o.polrelid::regclass::text,o.polname,o.polcmd::text,pg_get_expr(o.polqual,o.polrelid),pg_get_expr(o.polwithcheck,o.polrelid)) order by o.polname),'[]') from pg_policy o where o.polrelid::regclass::text like 'invoice_pdf%')::text,
 (select count(*) from pg_class where relname like 'invoice_pdf%')::text
)) s`;
async function liveState(db: PGlite): Promise<string> {
  const state = (await db.query<{ s: string }>(LIVE_STATE)).rows[0]?.s;
  assert.match(state ?? "", /^[0-9a-f]{32}$/, "live state fingerprint must be computable");
  return state;
}
async function rejectsWithoutMutation(db: PGlite, sql: string, marker: string) {
  const before = await liveState(db);
  await assert.rejects(db.exec(sql), new RegExp(marker));
  await db.exec("rollback");
  assert.equal(await liveState(db), before, "state changed although the statement was rejected");
}

test("SQL installation: gates absent/closed; all mutations service-only; source excludes private payment material", async () => {
  const db = await setup();
  try {
    assert.equal(
      (await db.query("select * from invoice_pdf_candidates()")).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from pg_class where relname in ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_manifest') and relrowsecurity",
        )
      ).rows[0].n,
      4,
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from information_schema.role_routine_grants where routine_name like 'invoice_pdf_%' and grantee in ('PUBLIC','anon','authenticated')",
        )
      ).rows[0].n,
      0,
    );
    await seed(db);
    const src = await source(db);
    assert.equal(src.buyer.email, "client@example.com");
    assert.equal(src.order.order_items[0].item_name, "Vin");
    assert.ok(!JSON.stringify(src).includes("public_token"));
    assert.ok(!JSON.stringify(src).includes("current_payment_transaction_id"));
  } finally {
    await db.close();
  }
});
test("SQL number reservation is idempotent and source changes consume no number", async () => {
  const db = await setup();
  try {
    await seed(db);
    const old = await source(db);
    await db.exec(
      `update orders set customer_name='Autre' where id='${O}'; update order_invoice_request set contact_name='Autre' where order_id='${O}'`,
    );
    await assert.rejects(
      db.query("select invoice_pdf_issue($1,$2::jsonb)", [
        O,
        JSON.stringify(old),
      ]),
      /SOURCE_CHANGED/,
    );
    const a = await issue(db),
      b = await issue(db);
    assert.equal(a.id, b.id);
    assert.match(a.invoice_number, /FAC-DEMO-\d{4}-000001/);
    assert.equal(
      (
        await db.query<{ next_number: number }>(
          "select next_number::int from invoice_pdf_settings",
        )
      ).rows[0].next_number,
      2,
    );
    await db.exec(
      `update order_items set item_name='Nouveau' where order_id='${O}'`,
    );
    assert.equal(
      (await issue(db)).source.order.order_items[0].item_name,
      "Vin",
    );
  } finally {
    await db.close();
  }
});
test("SQL archive immutable; first render wins; duplicate delivery cannot reclaim; token required to finish", async () => {
  const db = await setup();
  try {
    await seed(db);
    const d = await issue(db);
    const pdf = Buffer.from("%PDF-test").toString("base64");
    await db.query("select invoice_pdf_store($1,$2)", [d.id, pdf]);
    await db.query("select invoice_pdf_store($1,$2)", [
      d.id,
      Buffer.from("%PDF-other").toString("base64"),
    ]);
    assert.equal(
      (
        await db.query<{ pdf_base64: string }>(
          "select pdf_base64 from invoice_pdf_documents",
        )
      ).rows[0].pdf_base64,
      pdf,
    );
    await assert.rejects(
      db.exec(`update invoice_pdf_documents set source='{}'`),
      /IMMUTABLE/,
    );
    const claim = (
      await db.query<any>("select * from invoice_pdf_claim_delivery($1,$1)", [
        d.id,
      ])
    ).rows[0];
    assert.ok(claim.id);
    const dup = (
      await db.query<any>("select * from invoice_pdf_claim_delivery($1,$1)", [
        d.id,
      ])
    ).rows[0];
    assert.equal(dup.id, null);
    assert.equal(
      (
        await db.query<any>(
          `select invoice_pdf_finish_delivery($1,'00000000-0000-4000-8000-000000000000','accepted') ok`,
          [claim.id],
        )
      ).rows[0].ok,
      false,
    );
    assert.equal(
      (
        await db.query<any>(
          `select invoice_pdf_finish_delivery($1,$2,'accepted') ok`,
          [claim.id, claim.claim_token],
        )
      ).rows[0].ok,
      true,
    );
    assert.equal(
      (await db.query("select * from invoice_pdf_candidates()")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
test("SQL old orders, unpaid and wrong payment amount never enter source; automatic boundary stamped", async () => {
  const db = await setup();
  try {
    await seed(db);
    await db.exec(`update orders set created_at='2020-01-01' where id='${O}'`);
    assert.equal(await source(db), null);
    await db.exec(
      `update orders set created_at=clock_timestamp()+interval '1 second',payment_status='pending' where id='${O}'`,
    );
    assert.equal(await source(db), null);
    await db.exec(
      `update orders set payment_status='paid';update payment_transactions set amount=13`,
    );
    assert.equal(await source(db), null);
    await db.exec(
      `update payment_transactions set amount=12;update invoice_pdf_settings set enabled=false;update invoice_pdf_settings set enabled=true,activated_at='2000-01-01'`,
    );
    assert.ok(
      new Date(
        (
          await db.query<any>("select activated_at from invoice_pdf_settings")
        ).rows[0].activated_at,
      ).getFullYear() > 2020,
    );
  } finally {
    await db.close();
  }
});
test("SQL rollback nominal and reapplication", async () => {
  const db = await setup();
  try {
    await db.exec(rollback);
    await db.exec(install);
    assert.ok(
      (await db.query("select to_regclass('invoice_pdf_documents') t")).rows[0],
    );
  } finally {
    await db.close();
  }
});
for (const [label, sql] of Object.entries({
  constraint:
    "alter table invoice_pdf_documents add constraint unexpected check(sequence_number>0)",
  strict: "alter function invoice_pdf_store(uuid,text) strict",
  permissions: "grant execute on function invoice_pdf_source(uuid) to anon",
  owner: "alter function invoice_pdf_source(uuid) owner to service_role",
  fingerprintBody:
    "create or replace function invoice_pdf_fingerprint() returns text language sql as 'select fingerprint from invoice_pdf_manifest'",
  column: "alter table invoice_pdf_documents add column third_party text",
}))
  test("SQL rollback refuses drift without mutation: " + label, async () => {
    const db = await setup();
    try {
      await db.exec(sql);
      await rejectsWithoutMutation(db, rollback, "ROLLBACK_DRIFT");
      assert.ok(
        (
          await db.query<{ t: string }>(
            "select to_regclass('invoice_pdf_documents') t",
          )
        ).rows[0].t,
      );
    } finally {
      await db.close();
    }
  });
test("SQL rollback preserves issued invoice even before PDF is generated", async () => {
  const db = await setup();
  try {
    await seed(db);
    await issue(db);
    await rejectsWithoutMutation(db, rollback, "ROLLBACK_HAS_RECORDS");
    assert.equal(
      (await db.query("select * from invoice_pdf_documents")).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
test("SQL missing prerequisite fails atomically", async () => {
  const db = new PGlite();
  try {
    await db.exec(ddl);
    await db.exec(
      "alter table orders drop column current_payment_transaction_id",
    );
    await assert.rejects(db.exec(install), /PREREQUISITE/);
    await db.exec("rollback");
    assert.equal(
      (await db.query<any>("select to_regclass('invoice_pdf_documents') t"))
        .rows[0].t,
      null,
    );
  } finally {
    await db.close();
  }
});

test("SQL malformed source is quarantined without starving later invoices; changed source is retried", async () => {
  const db = await setup();
  try {
    await seed(db);
    const before = await source(db);
    await db.query("select invoice_pdf_block($1,$2::jsonb)", [
      O,
      JSON.stringify(before),
    ]);
    assert.equal(
      (await db.query("select * from invoice_pdf_candidates()")).rows.length,
      0,
    );
    await db.exec(
      `update order_invoice_request set contact_email='different@example.com' where order_id='${O}'`,
    );
    assert.equal(
      (await db.query("select * from invoice_pdf_candidates()")).rows.length,
      1,
    );
    // A failure of the OLD read must not quarantine the NEW source.
    await db.query("select invoice_pdf_block($1,$2::jsonb)", [
      O,
      JSON.stringify(before),
    ]);
    assert.equal(
      (await db.query("select * from invoice_pdf_candidates()")).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
for (const kind of ["function", "procedure"])
  test(
    "SQL rollback refuses third-party " + kind + " consumer without mutation",
    async () => {
      const db = await setup();
      try {
        if (kind === "function")
          await db.exec(
            "create function third_party_invoice() returns text language sql as 'select public.invoice_pdf_fingerprint()'",
          );
        else
          await db.exec(
            "create procedure third_party_invoice() language plpgsql as 'begin perform public.invoice_pdf_fingerprint(); end'",
          );
        await rejectsWithoutMutation(db, rollback, "ROLLBACK_CONSUMER");
        if (kind === "function")
          assert.ok((await db.query("select third_party_invoice()")).rows[0]);
        else await db.exec("call third_party_invoice()");
      } finally {
        await db.close();
      }
    },
  );
test("SQL CRLF installation and LF rollback agree on stored definitions", async () => {
  const db = new PGlite();
  try {
    await db.exec(ddl);
    await db.exec(install.replace(/\r?\n/g, "\r\n"));
    await db.exec(rollback);
  } finally {
    await db.close();
  }
});

for (const [label, sql] of Object.entries({
  archiveGuardDisabled: "alter table invoice_pdf_documents disable trigger invoice_pdf_archive_guard",
  activationGuardDisabled: "alter table invoice_pdf_settings disable trigger invoice_pdf_activation_guard",
  archiveGuardReplica: "alter table invoice_pdf_documents enable replica trigger invoice_pdf_archive_guard",
  archiveGuardAlways: "alter table invoice_pdf_documents enable always trigger invoice_pdf_archive_guard",
  thirdPartyStatistic:
    "create statistics public.audit_external_stat (dependencies) on enabled, next_number from public.invoice_pdf_settings",
  thirdPartyStatisticDocuments:
    "create statistics public.audit_external_stat2 (ndistinct) on sequence_number, restaurant_id from public.invoice_pdf_documents",
  tableComment: "comment on table invoice_pdf_documents is 'third-party note'",
  columnComment: "comment on column invoice_pdf_settings.enabled is 'third-party note'",
  replicaIdentity: "alter table invoice_pdf_documents replica identity full",
  thirdPartyRule: "create rule audit_rule as on delete to invoice_pdf_blocked do instead nothing",
  dependentView: "create view public.audit_view as select * from public.invoice_pdf_settings",
}))
  test("SQL rollback refuses third-party/attribute drift without mutation: " + label, async () => {
    const db = await setup();
    try {
      await db.exec(sql);
      await rejectsWithoutMutation(db, rollback, "ROLLBACK_(DRIFT|DEPENDENCY)");
      assert.ok((await db.query<{ t: string }>("select to_regclass('invoice_pdf_documents') t")).rows[0].t);
    } finally {
      await db.close();
    }
  });
test("SQL rollback keeps an unrelated third-party object on an unrelated table and succeeds nominally", async () => {
  const db = await setup();
  try {
    await db.exec("create table audit_unrelated(a int, b int); create statistics audit_unrelated_stat on a, b from audit_unrelated");
    await db.exec(rollback);
    assert.equal((await db.query("select 1 from pg_statistic_ext where stxname='audit_unrelated_stat'")).rows.length, 1);
    assert.equal((await db.query<{ t: string | null }>("select to_regclass('invoice_pdf_documents')::text t")).rows[0].t, null);
  } finally {
    await db.close();
  }
});
// Negative controls of the "no mutation" helper itself: it must FAIL when a change persists.
test("helper negative control: a persisted change followed by an exception is detected", async () => {
  const db = await setup();
  try {
    await assert.rejects(
      rejectsWithoutMutation(
        db,
        "alter table invoice_pdf_documents add constraint neg_ctl check(sequence_number>0); commit; select 1/0",
        "division by zero",
      ),
      /state changed/,
    );
  } finally {
    await db.close();
  }
});
test("helper negative control: a disabled trigger (invisible to the stored manifest) is detected", async () => {
  const db = await setup();
  try {
    await assert.rejects(
      rejectsWithoutMutation(
        db,
        "alter table invoice_pdf_documents disable trigger invoice_pdf_archive_guard; commit; select 1/0",
        "division by zero",
      ),
      /state changed/,
    );
  } finally {
    await db.close();
  }
});
test("helper negative control: a statement that succeeds, or fails with another error, is not accepted as a clean rejection", async () => {
  const db = await setup();
  try {
    await assert.rejects(rejectsWithoutMutation(db, "select 1", "ROLLBACK_DRIFT"));
    await assert.rejects(rejectsWithoutMutation(db, "select 1/0", "ROLLBACK_DRIFT"));
    assert.match(await liveState(db), /^[0-9a-f]{32}$/);
  } finally {
    await db.close();
  }
});
