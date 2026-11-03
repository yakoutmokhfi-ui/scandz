import type { SubmitInvoiceRequestParams } from "@/lib/services/invoice-request";
import type { CheckoutBillingInput } from "@/lib/services/payment-checkout";

export type InvoicePaymentBilling = Extract<CheckoutBillingInput, { source: "manual" }>;

/** À appeler seulement APRÈS l'enregistrement réussi de cette charge utile
 * de facture. Les validations du paiement restent faites côté serveur. */
export function paymentBillingFromSavedInvoice(
  invoice: SubmitInvoiceRequestParams,
  customer: { name?: string; email?: string; phone?: string } | null
): InvoicePaymentBilling | undefined {
  const addressLine1 = invoice.addressLine1.trim();
  const postalCode = invoice.postalCode.trim();
  const city = invoice.city.trim();
  const country = invoice.country.trim().toUpperCase();
  if (!addressLine1 || !postalCode || !city || !/^[A-Z]{2}$/.test(country)) return undefined;
  return {
    source: "manual",
    addressLine1,
    addressLine2: invoice.addressLine2?.trim() || undefined,
    postalCode,
    city,
    country,
    customerName: customer?.name || undefined,
    customerEmail: customer?.email || undefined,
    customerPhone: customer?.phone || undefined,
  };
}
