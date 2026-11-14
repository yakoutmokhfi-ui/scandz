import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInvoicePdf, buyerLines } from "../lib/server/invoices/pdf.ts";
import { invoiceFixture } from "./helpers/invoice-pdf-fixture.ts";
function pages(pdf: Buffer) {
  return Number(
    pdf.toString("latin1").match(/\/Type \/Pages[\s\S]*?\/Count (\d+)/)?.[1],
  );
}
test("A4 invoice: one page for ordinary order, no empty footer page or JS/link action", async () => {
  const pdf = await renderInvoicePdf(
    invoiceFixture(),
    "FAC-DEMO-2026-000001",
    "2026-11-10T12:06:00Z",
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(pages(pdf), 1);
  assert.match(pdf.toString("latin1"), /595\.28 841\.89/);
  assert.doesNotMatch(
    pdf.toString("latin1"),
    /\/JavaScript|\/URI|\/OpenAction/,
  );
  assert.ok(pdf.length < 2000000);
});
test("long order paginates on A4 without one empty page per footer", async () => {
  const s = invoiceFixture();
  s.order.order_items = Array.from({ length: 65 }, (_, i) => ({
    ...s.order.order_items[0],
    id: "item" + i,
    item_name:
      "Produit de démonstration " +
      i +
      " avec une désignation longue et une option",
    option_name: "Option de démonstration",
  }));
  s.order.total = 780;
  s.order.subtotal = 780;
  const pdf = await renderInvoicePdf(
    s,
    "FAC-DEMO-2026-000002",
    "2026-11-10T12:06:00Z",
  );
  assert.ok(pages(pdf) > 1);
  assert.ok(pages(pdf) <= 8);
});
test("reject malformed invoice number before rendering", async () => {
  await assert.rejects(
    renderInvoicePdf(invoiceFixture(), "../evil.pdf", "2026-11-10T12:06:00Z"),
    /INVOICE_ID_INVALID/,
  );
});
test("FACTURER À : le SIRET d'un client entreprise est affiché, libellé SIRET", () => {
  const s = invoiceFixture();
  s.buyer = {
    ...s.buyer,
    name: "Société cliente SARL",
    company: true,
    vat: "FR00000000000",
    registration: "12345678900012",
  };
  const lines = buyerLines(s);
  assert.ok(lines.includes("SIRET : 12345678900012"));
  assert.ok(lines.includes("TVA : FR00000000000"));
  const p = invoiceFixture();
  assert.equal(
    buyerLines(p).some(
      (l) => l.startsWith("SIRET") || l.startsWith("Immatriculation"),
    ),
    false,
    "particulier sans identifiant : rien d'inventé",
  );
});

test("merchant raster logo is embedded, while invalid logo falls back to merchant name", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwl8AAAAASUVORK5CYII=",
    "base64",
  );
  const pdf = await renderInvoicePdf(
    invoiceFixture(),
    "FAC-DEMO-2026-000003",
    "2026-11-14T10:00:00Z",
    { logo: png, phone: "+33 1 23 45 67 89" },
  );
  assert.ok(/\/Subtype \/Image/.test(pdf.toString("latin1")), "configured logo must be embedded");
  assert.equal(pages(pdf), 1);
  const fallback = await renderInvoicePdf(
    invoiceFixture(),
    "FAC-DEMO-2026-000004",
    "2026-11-14T10:00:00Z",
    { logo: Buffer.from("not an image"), phone: null },
  );
  assert.equal(pages(fallback), 1);
});
