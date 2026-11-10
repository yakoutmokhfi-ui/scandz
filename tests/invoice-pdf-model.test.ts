import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInvoiceSource } from "../lib/server/invoices/model.ts";
import { invoiceFixture } from "./helpers/invoice-pdf-fixture.ts";

test("paid requested invoice: canonical historical amounts and exact net allocation", () => {
  const s = invoiceFixture();
  const d = validateInvoiceSource(s);
  assert.equal(d.fiscal.totalGross, 12);
  assert.equal(d.fiscal.totalNet, 10);
  assert.equal(d.fiscal.totalTax, 2);
  assert.equal(d.lines[0].net, 10);
});
for (const [label, mutate] of Object.entries({
  unpaid: (s: any): void => {
    s.order.payment_status = "pending";
  },
  noHistory: (s: any): void => {
    s.order.tax_settings_snapshot_prices_include_tax = null;
  },
  corruptTotal: (s: any): void => {
    s.order.total = "NaN";
  },
  subtotalMismatch: (s: any): void => {
    s.order.subtotal = 13;
  },
  lineMismatch: (s: any): void => {
    s.order.order_items[0].line_total = 11;
  },
  missingRate: (s: any): void => {
    s.order.order_items[0].tax_rate_snapshot = null;
  },
  missingSeller: (s: any): void => {
    s.seller.registration = null;
  },
  wrongCountry: (s: any): void => {
    s.seller.country = "BE";
  },
  noLegalFooter: (s: any): void => {
    s.footer = "";
  },
  recipientInjection: (s: any): void => {
    s.buyer.email = "client@example.com\r\nBCC:x@example.com";
  },
  missingDeliveryTax: (s: any): void => {
    s.order.total = 15;
  },
  noBuyer: (s: any): void => {
    s.buyer.name = "";
  },
  fractionalQuantity: (s: any): void => {
    s.order.order_items[0].quantity = 1.5;
  },
  zeroVat: (s: any): void => {
    s.order.order_items[0].tax_rate_snapshot = 0;
  },
}))
  test("fail closed: " + label, () => {
    const s = invoiceFixture();
    mutate(s);
    assert.throws(() => validateInvoiceSource(s), /INVOICE_DATA_INCOMPLETE/);
  });

test("mixed VAT + persisted delivery allocation: canonical totals reconcile", () => {
  const s = invoiceFixture();
  s.order.order_items.push({
    ...s.order.order_items[0],
    id: "item2",
    item_name: "Fromage",
    unit_price: 10.55,
    line_total: 10.55,
    tax_rate_snapshot: 5.5,
  });
  s.order.subtotal = 22.55;
  s.order.total = 24.95;
  s.order.order_delivery_tax_allocations = [
    {
      tax_rate_snapshot: 20,
      delivery_fee_gross_share: 2.4,
      delivery_fee_net_share: 2,
      delivery_fee_tax_amount: 0.4,
    },
    {
      tax_rate_snapshot: 5.5,
      delivery_fee_gross_share: 0,
      delivery_fee_net_share: 0,
      delivery_fee_tax_amount: 0,
    },
  ];
  const d = validateInvoiceSource(s);
  assert.equal(d.fiscal.totalGross, 24.95);
  assert.equal(d.fiscal.totalNet, 22);
  assert.equal(d.fiscal.totalTax, 2.95);
});
test("reordered products preserve per-line rounded net cents", () => {
  const s = invoiceFixture();
  s.order.order_items = [
    { ...s.order.order_items[0], id: "a", unit_price: 2, line_total: 2 },
    { ...s.order.order_items[0], id: "b", unit_price: 2, line_total: 2 },
  ];
  s.order.subtotal = 4;
  s.order.total = 4;
  const a = validateInvoiceSource(s).lines;
  s.order.order_items.reverse();
  const b = validateInvoiceSource(s).lines;
  assert.deepEqual(
    [...a].sort((a, b) => a.itemId.localeCompare(b.itemId)),
    [...b].sort((a, b) => a.itemId.localeCompare(b.itemId)),
  );
});

test("same historical unit price has same unit HT despite line-cent allocation", () => {
  const s = invoiceFixture();
  s.order.order_items = ["a", "b"].map((id) => ({
    ...s.order.order_items[0],
    id,
    unit_price: 2,
    line_total: 2,
  }));
  s.order.subtotal = 4;
  s.order.total = 4;
  const d = validateInvoiceSource(s);
  assert.equal(d.fiscal.totalNet, 3.33);
  assert.notEqual(d.lines[0].net, d.lines[1].net);
  assert.equal(d.lines[0].unitNet, 2 / 1.2);
  assert.equal(d.lines[0].unitNet, d.lines[1].unitNet);
});
