import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic";
const { NextRequest } = await import("next/server");
const { asUserSupabaseClientFactory } = await import(
  "../lib/server/supabase-as-user.ts"
);
const { getServiceRoleSupabaseClient } = await import(
  "../lib/server/supabase-admin.ts"
);
const { GET, POST } = await import("../app/api/dashboard/invoices/route.ts");
const admin = getServiceRoleSupabaseClient();
const oid = "10000000-0000-4000-8000-000000000001",
  rid = "20000000-0000-4000-8000-000000000001";
function setup(
  t: any,
  opts: {
    signed?: boolean;
    member?: boolean;
    order?: boolean;
    foreignDocument?: boolean;
  } = {},
) {
  let reads = 0;
  const pdf = Buffer.from("%PDF-cached"),
    b64 = pdf.toString("base64");
  t.mock.method(asUserSupabaseClientFactory, "create", () => ({
    auth: {
      getUser: async () => ({
        data: { user: opts.signed === false ? null : { id: "user" } },
        error: null,
      }),
    },
    from: (table: string) => {
      assert.equal(table, "orders");
      return {
        select: () => ({
          eq: (key: string, id: string) => {
            assert.equal(key, "id");
            assert.equal(id, oid);
            return {
              maybeSingle: async () => ({
                data:
                  opts.order === false ? null : { id: oid, restaurant_id: rid },
                error: null,
              }),
            };
          },
        }),
      };
    },
    rpc: async (name: string, args: any) => {
      assert.equal(name, "has_role_in");
      assert.equal(args.p_restaurant_id, rid);
      return { data: opts.member !== false, error: null };
    },
  }));
  t.mock.method(admin, "from", (table: string) => {
    reads++;
    assert.equal(table, "invoice_pdf_documents");
    return {
      select: () => ({
        eq: (key: string, id: string) => {
          assert.equal(key, "order_id");
          assert.equal(id, oid);
          return {
            maybeSingle: async () => ({
              data: {
                id: "invoice",
                restaurant_id: opts.foreignDocument ? "foreign" : rid,
                order_id: oid,
                invoice_number: "FAC-DEMO-2026-000001",
                pdf_base64: b64,
                pdf_md5: createHash("md5").update(b64).digest("hex"),
              },
              error: null,
            }),
          };
        },
      }),
    };
  });
  return { reads: () => reads, pdf };
}
function req(token = true) {
  return new NextRequest(
    "http://localhost/api/dashboard/invoices?orderId=" + oid,
    { headers: token ? { authorization: "Bearer synthetic" } : {} },
  );
}
test("anonymous access rejected before touching archive", async (t) => {
  const d = setup(t);
  assert.equal((await GET(req(false))).status, 403);
  assert.equal(d.reads(), 0);
});
test("invalid session rejected before touching archive", async (t) => {
  const d = setup(t, { signed: false });
  assert.equal((await GET(req())).status, 403);
  assert.equal(d.reads(), 0);
});
test("foreign order rejected by user-scoped read", async (t) => {
  const d = setup(t, { order: false });
  assert.equal((await GET(req())).status, 403);
  assert.equal(d.reads(), 0);
});
test("operator alone is not restaurant membership", async (t) => {
  const d = setup(t, { member: false });
  assert.equal((await GET(req())).status, 403);
  assert.equal(d.reads(), 0);
});
test("archive tenant mismatch is rejected", async (t) => {
  setup(t, { foreignDocument: true });
  assert.equal((await GET(req())).status, 403);
});
test("authorized member downloads exact cached PDF with private/no-referrer headers, even with generation off", async (t) => {
  delete process.env.INVOICE_PDF_ENABLED;
  const d = setup(t);
  const r = await GET(req());
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control")!, /no-store/);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), d.pdf);
});
test("disabled POST touches no data", async (t) => {
  const d = setup(t);
  delete process.env.INVOICE_PDF_ENABLED;
  const r = await POST(
    new NextRequest("http://localhost/api/dashboard/invoices", {
      method: "POST",
      body: JSON.stringify({ orderId: oid, action: "prepare" }),
    }),
  );
  assert.equal(r.status, 503);
  assert.equal(d.reads(), 0);
});
test("POST refuses invalid actions and missing resend id before data access", async (t) => {
  const d = setup(t);
  process.env.INVOICE_PDF_ENABLED = "true";
  try {
    for (const body of [
      { orderId: oid, action: "delete" },
      { orderId: oid, action: "resend" },
    ]) {
      assert.equal(
        (
          await POST(
            new NextRequest("http://localhost/api/dashboard/invoices", {
              method: "POST",
              headers: { authorization: "Bearer synthetic" },
              body: JSON.stringify(body),
            }),
          )
        ).status,
        400,
      );
    }
    assert.equal(d.reads(), 0);
  } finally {
    delete process.env.INVOICE_PDF_ENABLED;
  }
});
