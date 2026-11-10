import "server-only";
import type { DashboardOrder } from "@/lib/dashboard-types";
import {
  computeOrderFiscalSummary,
  getInvoiceProductFiscalLines,
} from "@/lib/order-fiscal-summary";

export interface InvoiceSource {
  order: DashboardOrder;
  seller: {
    name: string;
    address: string;
    registration: string;
    vat: string | null;
    email: string | null;
    country: string;
    legalForm: string | null;
  };
  buyer: {
    name: string;
    address: string;
    email: string;
    vat: string | null;
    company: boolean;
    registration?: string | null;
  };
  payment: { paidAt: string; method: string };
  footer: string;
  sender: { email: string; name: string; replyTo: string | null };
}
export class InvoiceNotReady extends Error {
  constructor() {
    super("INVOICE_DATA_INCOMPLETE");
  }
}
const fail = (): never => {
  throw new InvoiceNotReady();
};
function required(value: unknown, max = 2000): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(value)
  )
    fail();
}
export function validInvoiceEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(value)
  );
}
function money(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^\d+(?:\.\d{1,2})?$/.test(String(value))
  )
    return fail();
  const n = Number(value);
  if (!Number.isFinite(n) || n > 1_000_000) return fail();
  return Math.round(n * 100);
}

/** Reject incomplete fiscal history; never read today's catalogue or invent VAT. */
export function validateInvoiceSource(value: unknown) {
  if (!value || typeof value !== "object") return fail();
  const s = value as InvoiceSource;
  if (!s.seller || !s.buyer || !s.sender || !s.payment || !s.order)
    return fail();
  required(s.seller.name, 250);
  required(s.seller.address);
  required(s.seller.registration, 100);
  required(s.buyer.name, 250);
  required(s.buyer.address);
  if (s.buyer.registration != null) required(s.buyer.registration, 100);
  required(s.footer, 2000);
  required(s.sender.name, 120);
  required(s.payment.method, 40);
  if (
    s.seller.country !== "FR" ||
    !validInvoiceEmail(s.buyer.email) ||
    !validInvoiceEmail(s.sender.email) ||
    (s.sender.replyTo && !validInvoiceEmail(s.sender.replyTo))
  )
    return fail();
  if (
    !Number.isFinite(Date.parse(s.payment.paidAt)) ||
    !Number.isFinite(Date.parse(s.order.created_at)) ||
    /[\r\n]/.test(s.seller.name + s.sender.name)
  )
    return fail();
  const o = s.order;
  if (
    o.payment_status !== "paid" ||
    o.currency !== "EUR" ||
    o.tax_settings_snapshot_prices_include_tax !== true ||
    !Array.isArray(o.order_items) ||
    !o.order_items.length ||
    o.order_items.length > 500
  )
    return fail();
  const total = money(o.total),
    subtotal = money(o.subtotal);
  if (total <= 0 || subtotal > total) return fail();
  let itemsTotal = 0;
  const ids = new Set<string>();
  for (const item of o.order_items) {
    required(item.id, 40);
    required(item.item_name, 500);
    if (item.option_name != null) required(item.option_name, 500);
    if (ids.has(item.id)) return fail();
    ids.add(item.id);
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10000
    )
      return fail();
    const unit = money(item.unit_price),
      line = money(item.line_total);
    if (unit * item.quantity !== line) return fail();
    itemsTotal += line;
    const rate = item.tax_rate_snapshot;
    if (
      rate == null ||
      !Number.isFinite(Number(rate)) ||
      Number(rate) < 0 ||
      Number(rate) > 100 ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(rate))
    )
      return fail();
  }
  if (itemsTotal !== subtotal) return fail();
  const fiscal = computeOrderFiscalSummary({
    ...o,
    tax_settings_snapshot_show_tax_summary: true,
  });
  const lines = getInvoiceProductFiscalLines(o);
  if (
    fiscal.mode !== "mixed-rate" ||
    !lines ||
    money(fiscal.totalNet) + money(fiscal.totalTax) !== total ||
    money(fiscal.totalGross) !== total ||
    !fiscal.compositionReconcilesWithTotal
  )
    return fail();
  // v1: VAT-registered French merchants only. Exempt/zero-rate invoices need
  // their explicit legal basis, so do not guess it from a 0% snapshot.
  if (!s.seller.vat || fiscal.rates.some((r) => r.rate === 0)) return fail();
  required(s.seller.vat, 100);
  const items = new Map(o.order_items.map((item) => [item.id, item]));
  // Unit-price presentation comes from the historical unit GROSS, not from
  // an allocated/rounded line net (identical products must have identical PU).
  const pricedLines = lines.map((line) => ({
    ...line,
    unitNet: Number(items.get(line.itemId)!.unit_price) / (1 + line.rate / 100),
  }));
  return { source: s, fiscal, lines: pricedLines };
}
