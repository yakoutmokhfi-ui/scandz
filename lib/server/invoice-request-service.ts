import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/**
 * SCANYM CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1
 *
 * Couche serveur DÉDIÉE, INDÉPENDANTE de Monetico/Stuart/tout
 * prestataire (décision CTO explicite) -- appelle exclusivement
 * `set_order_invoice_request`/`get_order_invoice_request`
 * (SECURITY DEFINER, service_role UNIQUEMENT, jamais anon/
 * authenticated côté SQL) via le client Supabase à privilège élevé,
 * JAMAIS exposé au navigateur (mandat, littéral : "no service_role
 * in browser").
 */

export type InvoiceType = "individual" | "company";

export interface InvoiceRequestInput {
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

export interface InvoiceRequestResult {
  orderId: string;
  invoiceType: InvoiceType;
  updatedAt: string;
}

export interface InvoiceRequestRecord {
  invoiceType: InvoiceType;
  companyLegalName: string | null;
  vatNumber: string | null;
  contactName: string | null;
  contactEmail: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string;
  country: string;
  updatedAt: string;
}

/**
 * Erreur serveur dédiée -- jamais une fuite du message SQL brut au
 * client (mandat implicite de posture déjà établie dans ce dépôt,
 * ex. PaymentServerRpcError). Le code SQLSTATE est conservé pour
 * diagnostic serveur, jamais transmis tel quel à la réponse HTTP.
 */
export class InvoiceRequestServerError extends Error {
  rpcName: "set_order_invoice_request" | "get_order_invoice_request";
  sqlState: string | null;

  constructor(
    rpcName: "set_order_invoice_request" | "get_order_invoice_request",
    sqlState: string | null
  ) {
    super(`InvoiceRequestServerError: ${rpcName} (${sqlState ?? "unknown"})`);
    this.name = "InvoiceRequestServerError";
    this.rpcName = rpcName;
    this.sqlState = sqlState;
  }
}

/**
 * Écrit/met à jour (upsert déterministe) la demande de facture d'une
 * commande. Validation SERVEUR complète déléguée à la RPC SQL
 * elle-même (échec fermé, jamais une troncature silencieuse) --
 * cette fonction ne fait que relayer et traduire l'erreur.
 *
 * N'ENVOIE JAMAIS de paiement, ne déclenche JAMAIS Stuart, ne génère
 * AUCUN PDF, ne provoque AUCUNE communication client -- capture de
 * données uniquement (mandat, littéral).
 */
export async function setOrderInvoiceRequest(
  input: InvoiceRequestInput
): Promise<InvoiceRequestResult> {
  const client = getServiceRoleSupabaseClient();

  const { data, error } = await client.rpc("set_order_invoice_request", {
    p_order_id: input.orderId,
    p_public_token: input.publicToken,
    p_invoice_type: input.invoiceType,
    p_address_line_1: input.addressLine1,
    p_city: input.city,
    p_postal_code: input.postalCode,
    p_country: input.country,
    p_address_line_2: input.addressLine2 ?? null,
    p_company_legal_name: input.companyLegalName ?? null,
    p_vat_number: input.vatNumber ?? null,
    p_contact_name: input.contactName ?? null,
    p_contact_email: input.contactEmail ?? null,
  });

  if (error) {
    throw new InvoiceRequestServerError("set_order_invoice_request", error.code ?? null);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new InvoiceRequestServerError("set_order_invoice_request", "EMPTY_ROW");
  }

  return {
    orderId: row.order_id,
    invoiceType: row.invoice_type,
    updatedAt: row.updated_at,
  };
}

/**
 * Lit la demande de facture d'une commande -- retourne `null` si
 * aucune facture n'a été demandée (état légitime, jamais une erreur,
 * cohérent avec le comportement SQL de `get_order_invoice_request`).
 */
export async function getOrderInvoiceRequest(
  orderId: string,
  publicToken: string
): Promise<InvoiceRequestRecord | null> {
  const client = getServiceRoleSupabaseClient();

  const { data, error } = await client.rpc("get_order_invoice_request", {
    p_order_id: orderId,
    p_public_token: publicToken,
  });

  if (error) {
    throw new InvoiceRequestServerError("get_order_invoice_request", error.code ?? null);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return null;
  }

  return {
    invoiceType: row.invoice_type,
    companyLegalName: row.company_legal_name,
    vatNumber: row.vat_number,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    addressLine1: row.address_line_1,
    addressLine2: row.address_line_2,
    city: row.city,
    postalCode: row.postal_code,
    country: row.country,
    updatedAt: row.updated_at,
  };
}
