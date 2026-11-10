import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { invoiceFixture } from "./helpers/invoice-pdf-fixture.ts";
import {
  prepareInvoice,
  sendInvoice,
  runInvoiceWorker,
} from "../lib/server/invoices/service.ts";
process.env.INVOICE_PDF_ENABLED = "true";
process.env.NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED = "true";
const pdf = Buffer.from("%PDF-synthetic"),
  encoded = pdf.toString("base64");
function doc() {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    restaurant_id: invoiceFixture().order.restaurant_id,
    order_id: invoiceFixture().order.id,
    invoice_number: "FAC-DEMO-2026-000001",
    issued_at: "2026-11-10T12:06:00Z",
    source: invoiceFixture(),
    pdf_base64: encoded,
    pdf_md5: createHash("md5").update(encoded).digest("hex"),
  };
}
function db(
  options: {
    existing?: boolean;
    brokenFinalize?: boolean;
    throwFinalize?: boolean;
    malformed?: boolean;
    duplicate?: boolean;
  } = {},
) {
  let stored: any = options.existing === false ? null : doc();
  const calls: any[] = [];
  const client: any = {
    from(t: string) {
      assert.equal(t, "invoice_pdf_documents");
      return {
        select() {
          return {
            eq(k: string, id: string) {
              assert.equal(k, "order_id");
              assert.equal(id, doc().order_id);
              return {
                async maybeSingle() {
                  return { data: stored, error: null };
                },
              };
            },
          };
        },
      };
    },
    async rpc(name: string, args: any) {
      calls.push([name, args]);
      switch (name) {
        case "invoice_pdf_source": {
          const s = invoiceFixture();
          if (options.malformed)
            s.order.order_items[0].tax_rate_snapshot = null;
          return { data: s, error: null };
        }
        case "invoice_pdf_issue":
          stored = { ...doc(), pdf_base64: null, pdf_md5: null };
          return { data: stored, error: null };
        case "invoice_pdf_store":
          stored = { ...doc() };
          return { data: true, error: null };
        case "invoice_pdf_claim_delivery":
          return {
            data: options.duplicate
              ? { id: null }
              : { id: "delivery", claim_token: "token" },
            error: null,
          };
        case "invoice_pdf_finish_delivery":
          if (options.throwFinalize) throw Error("down");
          return {
            data: !options.brokenFinalize,
            error: options.brokenFinalize ? {} : null,
          };
        case "invoice_pdf_candidates":
          return { data: [{ order_id: doc().order_id }], error: null };
        default:
          throw Error("Unexpected RPC " + name);
      }
    },
  };
  return { client, calls };
}
const budget = (ms: number) => ({
  expired: () => ms <= 0,
  remainingMs: () => ms,
});
test("existing PDF is reused byte-for-byte; no new number or render", async () => {
  const d = db();
  const got = await prepareInvoice(doc().order_id, {
    client: d.client,
    render: async () => {
      throw Error("must not render");
    },
  });
  assert.equal(got.pdf_base64, encoded);
  assert.deepEqual(d.calls, []);
});
test("new invoice validated BEFORE numbering, archive saved and reread", async () => {
  const d = db({ existing: false });
  const got = await prepareInvoice(doc().order_id, {
    client: d.client,
    render: async () => pdf,
  });
  assert.equal(got.pdf_base64, encoded);
  assert.deepEqual(
    d.calls.map((c) => c[0]),
    ["invoice_pdf_source", "invoice_pdf_issue", "invoice_pdf_store"],
  );
});
test("invalid fiscal source reserves no number and renders no PDF", async () => {
  const d = db({ existing: false, malformed: true });
  await assert.rejects(
    prepareInvoice(doc().order_id, { client: d.client }),
    /INCOMPLETE/,
  );
  assert.deepEqual(
    d.calls.map((c) => c[0]),
    ["invoice_pdf_source"],
  );
});
test("real merchant boundary: recipient, sender and archived PDF supplied to correct provider", async () => {
  const d = db();
  let message: any;
  const result = await sendInvoice(
    doc(),
    doc().id,
    {
      client: d.client,
      provider: async (rid) => {
        assert.equal(rid, doc().restaurant_id);
        return {
          name: "intercepted",
          send: async (m) => {
            message = m;
            return { ok: true, providerMessageId: "synthetic" };
          },
        };
      },
    },
    budget(100000),
  );
  assert.equal(result, "accepted");
  assert.equal(message.to, "client@example.com");
  assert.equal(message.from, "marchand@example.com");
  assert.deepEqual(message.attachments[0].content, pdf);
  assert.equal(message.attachments[0].filename, "FAC-DEMO-2026-000001.pdf");
});
for (const opts of [{ brokenFinalize: true }, { throwFinalize: true }])
  test(
    "SMTP success + lost recording never announces accepted " +
      JSON.stringify(opts),
    async () => {
      const d = db(opts);
      let count = 0;
      const r = await sendInvoice(doc(), doc().id, {
        client: d.client,
        provider: async () => ({
          name: "fake",
          send: async () => {
            count++;
            return { ok: true, providerMessageId: "id" };
          },
        }),
      });
      assert.equal(r, "unconfirmed");
      assert.equal(count, 1);
    },
  );
test("provider throws after possible DATA acceptance: leave sticky claim, no finalization", async () => {
  const d = db();
  assert.equal(
    await sendInvoice(doc(), doc().id, {
      client: d.client,
      provider: async () => ({
        name: "fake",
        send: async () => {
          throw Error("connection lost");
        },
      }),
    }),
    "unconfirmed",
  );
  assert.equal(
    d.calls.filter((c) => c[0] === "invoice_pdf_finish_delivery").length,
    0,
  );
});
test("duplicate request never submits SMTP a second time", async () => {
  const d = db({ duplicate: true });
  assert.equal(
    await sendInvoice(doc(), doc().id, {
      client: d.client,
      provider: async () => ({
        name: "fake",
        send: async () => {
          throw Error("must not send");
        },
      }),
    }),
    "already_claimed",
  );
});
test("insufficient monotonic budget does not claim or send", async () => {
  const d = db();
  assert.equal(
    await sendInvoice(
      doc(),
      doc().id,
      {
        client: d.client,
        provider: async () => ({
          name: "fake",
          send: async () => {
            throw Error();
          },
        }),
      },
      budget(100),
    ),
    "deferred",
  );
  assert.equal(d.calls.length, 0);
});
test("default-off platform gate touches no database or provider", async () => {
  delete process.env.INVOICE_PDF_ENABLED;
  try {
    const d = db();
    assert.deepEqual(
      await runInvoiceWorker(budget(100000), { client: d.client }),
      { status: "disabled" },
    );
    assert.deepEqual(d.calls, []);
  } finally {
    process.env.INVOICE_PDF_ENABLED = "true";
  }
});
test("worker automatic request id is the invoice identity across executions", async () => {
  const d = db({ duplicate: true });
  await runInvoiceWorker(budget(100000), {
    client: d.client,
    provider: async () => ({
      name: "fake",
      send: async () => {
        throw Error("not called");
      },
    }),
  });
  const claim = d.calls.find((c) => c[0] === "invoice_pdf_claim_delivery");
  assert.equal(claim[1].p_request_id, doc().id);
});
