import type { InvoiceType } from "@/lib/invoice-request";

/**
 * SCANYM CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.3.
 *
 * Appelle app/api/checkout/invoice-request/route.ts APRÈS que
 * createOrder() ait réussi -- jamais avant, jamais à la place.
 *
 * CORRECTIF v1.2 (documentation corrigée en v1.3, Cat Woman
 * INVOICE-V12-DOCUMENTATION-01, LOW) : CETTE FONCTION N'EST PLUS
 * "best effort" -- l'appelant (components/MenuView.tsx) ATTEND
 * TOUJOURS son résultat et ne considère JAMAIS la commande comme
 * "complète" tant que l'issue n'est pas connue et positive. Une
 * demande de facture est une instruction métier EXPLICITE du client
 * -- elle ne doit JAMAIS échouer silencieusement. En cas d'échec,
 * l'appelant conserve un instantané complet et gelé
 * (`pendingInvoiceCompletion`) permettant une reprise CIBLÉE,
 * réutilisant les mêmes `orderId`/`publicToken`, jamais une nouvelle
 * commande. Cette fonction elle-même reste un simple relais réseau
 * pur (aucune logique de retry ici) -- la fiabilité est assurée par
 * l'APPELANT, jamais ici.
 */
export interface SubmitInvoiceRequestParams {
  orderId: string;
  publicToken: string;
  invoiceType: InvoiceType;
  addressLine1: string;
  city: string;
  postalCode: string;
  country: string;
  addressLine2?: string | null;
  companyLegalName?: string | null;
  vatNumber?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
}

export type SubmitInvoiceRequestOutcome =
  | { ok: true }
  | { ok: false; reason: "invalid_field" | "invalid_request" | "unavailable" };

export async function submitInvoiceRequest(
  params: SubmitInvoiceRequestParams
): Promise<SubmitInvoiceRequestOutcome> {
  try {
    const response = await fetch("/api/checkout/invoice-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });

    if (response.ok) {
      return { ok: true };
    }

    const data = (await response.json().catch(() => null)) as { outcome?: string } | null;
    if (data?.outcome === "invalid_field" || data?.outcome === "invalid_request") {
      return { ok: false, reason: data.outcome };
    }
    return { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
