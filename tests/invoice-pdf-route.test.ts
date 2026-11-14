import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceFixture } from "./helpers/invoice-pdf-fixture.ts";
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
    noDocument?: boolean;
    deliveryError?: boolean;
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
    if (table === "invoice_pdf_deliveries")
      return {
        select: () => ({
          eq: (key: string, id: string) => {
            assert.equal(key, "invoice_id");
            assert.equal(id, "invoice");
            return {
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: {
                      state: "accepted",
                      created_at: "2026-11-14T10:00:00Z",
                      completed_at: "2026-11-14T10:00:01Z",
                    },
                    error: opts.deliveryError ? {} : null,
                  }),
                }),
              }),
            };
          },
        }),
      };
    assert.equal(table, "invoice_pdf_documents");
    return {
      select: () => ({
        eq: (key: string, id: string) => {
          assert.equal(key, "order_id");
          assert.equal(id, oid);
          return {
            maybeSingle: async () => ({
              data: opts.noDocument
                ? null
                : {
                    source: invoiceFixture(),
                    issued_at: "2026-11-14T09:00:00Z",
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

test("status exposes archived recipient and persisted send time only to authorized tenant", async (t) => {
  setup(t);
  const r = await GET(
    new NextRequest(
      "http://localhost/api/dashboard/invoices?orderId=" + oid + "&view=status",
      { headers: { authorization: "Bearer synthetic" } },
    ),
  );
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.generated, true);
  assert.equal(s.recipient, "client@example.com");
  assert.equal(s.lastDelivery.state, "accepted");
  assert.equal(s.lastDelivery.completed_at, "2026-11-14T10:00:01Z");
  assert.equal(s.pdf_base64, undefined);
  assert.equal(s.source, undefined);
});
test("status does not turn delivery history read failures into a false never-sent state", async (t) => {
  setup(t, { deliveryError: true });
  const r = await GET(
    new NextRequest(
      "http://localhost/api/dashboard/invoices?orderId=" + oid + "&view=status",
      { headers: { authorization: "Bearer synthetic" } },
    ),
  );
  assert.equal(r.status, 503);
});
test("status without invoice performs no generation or numbering", async (t) => {
  setup(t, { noDocument: true });
  const r = await GET(
    new NextRequest(
      "http://localhost/api/dashboard/invoices?orderId=" + oid + "&view=status",
      { headers: { authorization: "Bearer synthetic" } },
    ),
  );
  assert.deepEqual(await r.json(), { generated: false });
});
test("manual send without a generated invoice refuses before any RPC or SMTP", async (t) => {
  setup(t, { noDocument: true });
  process.env.INVOICE_PDF_ENABLED = "true";
  t.mock.method(admin, "rpc", () => {
    throw Error("must not generate or send");
  });
  try {
    const r = await POST(
      new NextRequest("http://localhost/api/dashboard/invoices", {
        method: "POST",
        headers: { authorization: "Bearer synthetic" },
        body: JSON.stringify({
          orderId: oid,
          action: "send",
          requestId: "60000000-0000-4000-8000-000000000001",
        }),
      }),
    );
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, "INVOICE_NOT_READY");
  } finally {
    delete process.env.INVOICE_PDF_ENABLED;
  }
});
