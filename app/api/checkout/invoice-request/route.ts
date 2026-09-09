import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  setOrderInvoiceRequest,
  InvoiceRequestServerError,
  type InvoiceType,
} from "@/lib/server/invoice-request-service";

/**
 * SCANYM CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1 —
 * ROUTE D'ÉCRITURE.
 *
 * Adaptateur HTTP fin, sans logique de confiance propre (même patron
 * que app/api/payments/monetico/checkout/route.ts) -- toute la
 * validation vit dans la RPC SQL `set_order_invoice_request`
 * (SECURITY DEFINER, service_role UNIQUEMENT), jamais dupliquée ici.
 *
 * Appelée par le navigateur APRÈS la création de commande
 * (create_order, appel anon existant, inchangé) -- jamais AVANT,
 * jamais à la place. Aucun déclenchement de paiement, de Stuart, ou
 * de communication client -- capture de données uniquement.
 */
export const runtime = "nodejs";

interface InvoiceRequestBody {
  orderId?: unknown;
  publicToken?: unknown;
  invoiceType?: unknown;
  addressLine1?: unknown;
  addressLine2?: unknown;
  city?: unknown;
  postalCode?: unknown;
  country?: unknown;
  companyLegalName?: unknown;
  vatNumber?: unknown;
  contactName?: unknown;
  contactEmail?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined | null {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * Réponse d'erreur GÉNÉRIQUE -- ne distingue JAMAIS observablement
 * "jeton incorrect" de "commande inexistante" de "panne serveur
 * interne" (même posture que la route Monetico équivalente). Les
 * erreurs de VALIDATION MÉTIER (ex. nom de société manquant) sont
 * distinguées explicitement -- l'utilisateur doit savoir CE QU'IL a
 * mal saisi, contrairement à une preuve de possession qui ne doit
 * jamais être sondable.
 */
function genericFailureResponse(): NextResponse {
  return NextResponse.json({ outcome: "unavailable" }, { status: 502 });
}

function validationFailureResponse(field: string): NextResponse {
  return NextResponse.json({ outcome: "invalid_field", field }, { status: 400 });
}

export async function POST(request: NextRequest) {
  let body: InvoiceRequestBody;
  try {
    body = (await request.json()) as InvoiceRequestBody;
  } catch {
    return genericFailureResponse();
  }

  if (!isNonEmptyString(body.orderId) || !isNonEmptyString(body.publicToken)) {
    return genericFailureResponse();
  }
  if (body.invoiceType !== "individual" && body.invoiceType !== "company") {
    return validationFailureResponse("invoiceType");
  }
  if (!isNonEmptyString(body.addressLine1)) return validationFailureResponse("addressLine1");
  if (!isNonEmptyString(body.city)) return validationFailureResponse("city");
  if (!isNonEmptyString(body.postalCode)) return validationFailureResponse("postalCode");
  if (!isNonEmptyString(body.country)) return validationFailureResponse("country");
  if (!isOptionalString(body.addressLine2)) return validationFailureResponse("addressLine2");
  if (!isOptionalString(body.companyLegalName)) return validationFailureResponse("companyLegalName");
  if (!isOptionalString(body.vatNumber)) return validationFailureResponse("vatNumber");
  if (!isOptionalString(body.contactName)) return validationFailureResponse("contactName");
  if (!isOptionalString(body.contactEmail)) return validationFailureResponse("contactEmail");

  // Contrôle de forme précoce (expérience utilisateur uniquement) --
  // la RPC SQL reste la SEULE autorité de validation réelle
  // (fail-closed, contrainte CHECK au niveau schéma). Ce contrôle
  // évite un aller-retour réseau pour l'erreur la plus fréquente,
  // jamais un remplacement de la validation serveur SQL.
  if (body.invoiceType === "company" && !isNonEmptyString(body.companyLegalName)) {
    return validationFailureResponse("companyLegalName");
  }

  try {
    const result = await setOrderInvoiceRequest({
      orderId: body.orderId,
      publicToken: body.publicToken,
      invoiceType: body.invoiceType as InvoiceType,
      addressLine1: body.addressLine1,
      city: body.city,
      postalCode: body.postalCode,
      country: body.country,
      addressLine2: body.addressLine2 ?? null,
      companyLegalName: body.companyLegalName ?? null,
      vatNumber: body.vatNumber ?? null,
      contactName: body.contactName ?? null,
      contactEmail: body.contactEmail ?? null,
    });

    return NextResponse.json({
      outcome: "ok",
      orderId: result.orderId,
      invoiceType: result.invoiceType,
    });
  } catch (err) {
    if (err instanceof InvoiceRequestServerError) {
      // Codes de validation SQL connus (22004/22023/22001) -> réponse
      // de validation distinguable ; tout le reste (P0002 -- preuve
      // de possession invalide -- ou une panne inattendue) -> réponse
      // générique, jamais distinguable de l'extérieur.
      if (err.sqlState === "22004" || err.sqlState === "22023" || err.sqlState === "22001") {
        return NextResponse.json({ outcome: "invalid_request" }, { status: 400 });
      }
      return genericFailureResponse();
    }
    return genericFailureResponse();
  }
}
