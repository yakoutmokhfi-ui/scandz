/**
 * PAYMENT P4-A — CLIENT du paiement en ligne (boutique).
 *
 * Appelle POST /api/payments/monetico/checkout APRÈS la création de la
 * commande (create_order). Le navigateur ne décide de RIEN : ni si le
 * paiement est requis (décidé côté base par require_order_payment, à
 * partir de la configuration prestataire de l'établissement), ni le
 * montant, ni la devise, ni les URLs de retour. Il ne fait que
 * transporter l'identifiant de commande, son jeton de possession, la
 * langue, et -- quand le serveur l'a réclamé (`billing_required`) --
 * l'adresse de facturation saisie ou confirmée par le client.
 *
 * Résultats, TOUS traités par l'appelant (aucun cas silencieux) :
 *   - `not_needed`       : aucun paiement en ligne (établissement sans
 *                          configuration activée, commande déjà payée) ->
 *                          parcours historique de confirmation ;
 *   - `ready`            : formulaire Monetico signé côté serveur ->
 *                          redirection (voir lib/payment-redirect.ts) ;
 *   - `billing_required` : collecter l'adresse de facturation puis
 *                          rappeler avec `billing` ;
 *   - `billing_invalid`  : adresse refusée par le serveur ;
 *   - `unavailable`      : prestataire/serveur indisponible, ou module
 *                          désactivé -- la commande EXISTE mais n'a pas
 *                          pu être mise en paiement.
 */

export type CheckoutBillingInput =
  | { source: "delivery_reuse"; country: string }
  | {
      source: "manual";
      addressLine1: string;
      addressLine2?: string;
      city: string;
      postalCode: string;
      country: string;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
    };

export interface StartCheckoutParams {
  orderId: string;
  publicToken: string;
  language?: string;
  billing?: CheckoutBillingInput;
}

export type StartCheckoutOutcome =
  | { kind: "not_needed" }
  | { kind: "ready"; submissionUrl: string; fields: Record<string, string> }
  | { kind: "billing_required" }
  | { kind: "billing_invalid" }
  | { kind: "unavailable" };

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

export async function startOnlineCheckout(params: StartCheckoutParams): Promise<StartCheckoutOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/payments/monetico/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      credentials: "same-origin",
    });
  } catch {
    return { kind: "unavailable" };
  }

  const data = (await response.json().catch(() => null)) as
    | { outcome?: string; reason?: string; submissionUrl?: unknown; fields?: unknown }
    | null;

  if (response.status === 200 && data?.outcome === "checkout_not_needed") {
    return { kind: "not_needed" };
  }
  if (response.status === 200 && data?.outcome === "ready") {
    // Échec FERMÉ : un « ready » sans URL https ni champs exploitables ne
    // déclenche JAMAIS une redirection.
    if (
      typeof data.submissionUrl === "string" &&
      /^https:\/\//.test(data.submissionUrl) &&
      isRecordOfStrings(data.fields) &&
      Object.keys(data.fields).length > 0
    ) {
      return { kind: "ready", submissionUrl: data.submissionUrl, fields: data.fields };
    }
    return { kind: "unavailable" };
  }
  if (response.status === 409 && data?.outcome === "billing_required") {
    return { kind: "billing_required" };
  }
  if (response.status === 400 && data?.reason === "billing_invalid") {
    return { kind: "billing_invalid" };
  }
  return { kind: "unavailable" };
}
