import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import { validateInvoiceSource } from "@/lib/server/invoices/model";
import { renderInvoicePdf } from "@/lib/server/invoices/pdf";
import { resolveMerchantSmtpProvider } from "@/lib/server/notifications/merchant-smtp-provider";
import { isRealEmailSendActivated } from "@/lib/server/notifications/real-email-activation-gate";
import type { EmailProvider } from "@/lib/server/notifications/email-provider";
import type { RunBudget } from "@/lib/server/notifications/run-budget";
import { loadInvoiceBranding, type InvoiceBranding } from "@/lib/server/invoices/branding";
import { SMTP_SESSION_TOTAL_TIMEOUT_MS } from "@/lib/server/ack-mailer";

export const invoicePdfEnabled = () =>
  process.env.INVOICE_PDF_ENABLED === "true";
export interface InvoiceDocument {
  id: string;
  restaurant_id: string;
  order_id: string;
  invoice_number: string;
  issued_at: string;
  source: unknown;
  pdf_base64: string | null;
  pdf_md5: string | null;
}
export interface InvoiceDeps {
  client?: SupabaseClient;
  render?: typeof renderInvoicePdf;
  branding?: (restaurantId: string, client: SupabaseClient) => Promise<InvoiceBranding>;
  provider?: (restaurantId: string) => Promise<EmailProvider | null>;
}
class InvoiceSourceRejected extends Error {
  readonly source: unknown;
  constructor(source: unknown) {
    super("INVOICE_DATA_INCOMPLETE");
    this.source = source;
  }
}
function checked<T>(data: T | null, error: unknown): T {
  if (error || data == null) throw new Error("INVOICE_STORAGE_UNAVAILABLE");
  return data;
}
function one<T>(data: T | T[]): T {
  return Array.isArray(data) ? data[0] : data;
}
export async function findInvoice(
  orderId: string,
  client = getServiceRoleSupabaseClient(),
): Promise<InvoiceDocument | null> {
  const { data, error } = await client
    .from("invoice_pdf_documents")
    .select(
      "id,restaurant_id,order_id,invoice_number,issued_at,source,pdf_base64,pdf_md5",
    )
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new Error("INVOICE_STORAGE_UNAVAILABLE");
  return data;
}
export function invoiceBytes(d: InvoiceDocument): Buffer {
  if (
    !d.pdf_base64 ||
    !d.pdf_md5 ||
    createHash("md5").update(d.pdf_base64).digest("hex") !== d.pdf_md5
  )
    throw new Error("INVOICE_DOCUMENT_UNAVAILABLE");
  const bytes = Buffer.from(d.pdf_base64, "base64");
  if (bytes.subarray(0, 5).toString() !== "%PDF-" || bytes.length > 2_000_000)
    throw new Error("INVOICE_DOCUMENT_UNAVAILABLE");
  return bytes;
}
export async function prepareInvoice(
  orderId: string,
  deps: InvoiceDeps = {},
): Promise<InvoiceDocument> {
  if (!invoicePdfEnabled()) throw new Error("INVOICE_DISABLED");
  const client = deps.client ?? getServiceRoleSupabaseClient();
  let d = await findInvoice(orderId, client);
  if (!d) {
    const sourceResult = await client.rpc("invoice_pdf_source", {
      p_order_id: orderId,
    });
    if (sourceResult.error) throw new Error("INVOICE_STORAGE_UNAVAILABLE");
    const source = sourceResult.data;
    try {
      validateInvoiceSource(source);
    } catch {
      throw new InvoiceSourceRejected(source);
    }
    // Validation is BEFORE reserving a number.
    const issued = await client.rpc("invoice_pdf_issue", {
      p_order_id: orderId,
      p_expected_source: source,
    });
    d = one(checked(issued.data, issued.error)) as InvoiceDocument;
    if (!d) throw new Error("INVOICE_STORAGE_UNAVAILABLE");
  }
  if (!d.pdf_base64) {
    const pdf = await (deps.render ?? renderInvoicePdf)(
      d.source,
      d.invoice_number,
      d.issued_at,
      await (deps.branding ?? loadInvoiceBranding)(d.restaurant_id, client),
    );
    const stored = await client.rpc("invoice_pdf_store", {
      p_invoice_id: d.id,
      p_pdf_base64: pdf.toString("base64"),
    });
    if (checked(stored.data, stored.error) !== true)
      throw new Error("INVOICE_STORAGE_UNAVAILABLE");
    // Read the winner's immutable bytes, not our local render (concurrent workers).
    d = await findInvoice(orderId, client);
    if (!d) throw new Error("INVOICE_STORAGE_UNAVAILABLE");
  }
  invoiceBytes(d);
  return d;
}

export async function sendInvoice(
  d: InvoiceDocument,
  requestId: string,
  deps: InvoiceDeps = {},
  budget?: RunBudget,
) {
  if (!invoicePdfEnabled() || !isRealEmailSendActivated()) return "disabled";
  const { source: s } = validateInvoiceSource(d.source);
  const client = deps.client ?? getServiceRoleSupabaseClient();
  const provider = await (deps.provider ?? resolveMerchantSmtpProvider)(
    d.restaurant_id,
  );
  if (
    !provider ||
    (budget && budget.remainingMs() < SMTP_SESSION_TOTAL_TIMEOUT_MS + 5000)
  )
    return "deferred";
  const pdf = invoiceBytes(d);
  const claimed = await client.rpc("invoice_pdf_claim_delivery", {
    p_invoice_id: d.id,
    p_request_id: requestId,
  });
  if (claimed.error) throw new Error("INVOICE_STORAGE_UNAVAILABLE");
  const claim = claimed.data == null ? null : one(claimed.data);
  if (!claim?.id) return "already_claimed";
  // A claim is never automatically reclaimed, even after crashes/timeouts.
  // SMTP has no exactly-once guarantee: ambiguous outcomes require human reconciliation.
  if (budget?.expired()) return "unconfirmed";
  let accepted = false;
  try {
    const result = await provider.send({
      to: s.buyer.email,
      from: s.sender.email,
      fromName: s.sender.name,
      replyTo: s.sender.replyTo,
      subject: `${s.seller.name} - Facture ${d.invoice_number}`,
      text: `Bonjour,\n\nVotre facture ${d.invoice_number}, correspondant a la commande SC-${s.order.order_number}, est jointe a ce message.\n\nMerci de votre confiance.`,
      html: `<p>Bonjour,</p><p>Votre facture est jointe a ce message.</p><p>Merci de votre confiance.</p>`,
      attachments: [{ filename: `${d.invoice_number}.pdf`, content: pdf }],
      idempotencyKey: `scanym:invoice:${d.id}:${requestId}`,
    });
    accepted = result.ok;
  } catch {
    // Do not announce failure or retry: the server may have accepted DATA.
    return "unconfirmed";
  }
  try {
    const done = await client.rpc("invoice_pdf_finish_delivery", {
      p_id: claim.id,
      p_claim_token: claim.claim_token,
      p_state: accepted ? "accepted" : "failed",
    });
    if (done.error || done.data !== true) return "unconfirmed";
  } catch {
    return "unconfirmed";
  }
  return accepted ? "accepted" : "failed";
}

/** Legacy entry point deliberately inert: generation and sending require a merchant click. */
export async function runInvoiceWorker(_budget: RunBudget, _deps: InvoiceDeps = {}) {
  return { status: "manual_only" };
}
