import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  initiateCheckout,
  PaymentCheckoutRuntimeDisabledError,
} from "@/lib/server/payment-checkout-runtime";
import { setOrderBillingContext } from "@/lib/server/payment-service";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — ROUTE D'INITIATION.
 *
 * `node:crypto` requis en transitif (référence/MAC/jeton de relais) --
 * jamais Edge.
 *
 * RESTRUCTURATION v4 (ferme P3B-V3-RETURN-AUTHORITY-01 /
 * P3B-V3-SHIPPING-AUTHORITY-01) : cette route ne construit PLUS elle-
 * même les URLs de retour (v3 les dérivait de `request.nextUrl.origin`,
 * une autorité de confiance INVALIDE -- voir
 * `lib/server/canonical-public-origin.ts`) et n'accepte PLUS
 * `isDeliveryOrder` depuis le corps JSON du navigateur (v3 -- voir
 * `lib/server/payment-service.ts::getOrderServiceMode`). Toute cette
 * logique est désormais ENTIÈREMENT interne à `initiateCheckout`
 * (`payment-checkout-runtime.ts`), qui la traite comme un prérequis
 * STATIQUE devant réussir AVANT toute création de tentative -- cette
 * route reste volontairement un adaptateur HTTP fin, sans logique de
 * confiance propre.
 */
export const runtime = "nodejs";

interface CheckoutRequestBody {
  orderId?: unknown;
  publicToken?: unknown;
  language?: unknown;
  /** PAYMENT P4-A -- contexte de facturation, voir `parseBilling`. */
  billing?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * PAYMENT P4-A -- CONTEXTE DE FACTURATION FOURNI PAR LE NAVIGATEUR.
 *
 * Le client ne connaît pas à l'avance l'obligation de paiement : il
 * appelle d'abord cette route SANS `billing` ; `409 billing_required`
 * lui indique alors de collecter l'adresse de facturation (Monetico,
 * annexe 9.5 : rue, ville, code postal, pays obligatoires) et de
 * rappeler la route AVEC `billing`. Deux formes, toutes deux validées
 * fail-closed par la RPC `set_order_billing_context` (P3-B6) :
 *   - `{ source: "delivery_reuse", country }` : les 4 champs d'adresse
 *     sont COPIÉS par la base depuis l'adresse de livraison de CETTE
 *     commande (jamais acceptés tels quels), `country` reste confirmé
 *     explicitement ;
 *   - `{ source: "manual", addressLine1, city, postalCode, country,
 *     addressLine2?, customerName?, customerEmail?, customerPhone? }`.
 * Aucun de ces champs ne décide de l'applicabilité `shipping` (dérivée
 * exclusivement de `orders.service_mode`, v4) ni du montant.
 * Forme inconnue -> `null` (rejet 400, aucune écriture).
 */
type ParsedBilling =
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseBilling(raw: unknown): ParsedBilling | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const country = typeof b.country === "string" ? b.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) return null;
  if (b.source === "delivery_reuse") {
    return { source: "delivery_reuse", country };
  }
  if (b.source === "manual") {
    const addressLine1 = optionalString(b.addressLine1);
    const city = optionalString(b.city);
    const postalCode = optionalString(b.postalCode);
    if (!addressLine1 || !city || !postalCode) return null;
    return {
      source: "manual",
      addressLine1,
      addressLine2: optionalString(b.addressLine2),
      city,
      postalCode,
      country,
      customerName: optionalString(b.customerName),
      customerEmail: optionalString(b.customerEmail),
      customerPhone: optionalString(b.customerPhone),
    };
  }
  return null;
}

/**
 * Réponse d'erreur GÉNÉRIQUE -- ne distingue JAMAIS observablement
 * "jeton incorrect" de "commande inexistante" de "panne serveur
 * interne". Seuls les résultats atteints APRÈS que la possession ait
 * déjà été prouvée (`checkout_not_needed`/`provider_unavailable`/
 * `billing_required`/`ready`) sont renvoyés de façon distinguable.
 */
function genericFailureResponse(): NextResponse {
  return NextResponse.json({ outcome: "unavailable" }, { status: 502 });
}

export async function POST(request: NextRequest) {
  let body: CheckoutRequestBody;
  try {
    body = (await request.json()) as CheckoutRequestBody;
  } catch {
    return NextResponse.json({ outcome: "invalid_request" }, { status: 400 });
  }

  if (!isNonEmptyString(body.orderId) || !isNonEmptyString(body.publicToken)) {
    return NextResponse.json({ outcome: "invalid_request" }, { status: 400 });
  }
  const orderId = body.orderId;
  const publicToken = body.publicToken;

  // PAYMENT P4-A : facturation fournie -> enregistrée AVANT l'initiation,
  // fail-closed (forme inconnue ou refus de la RPC = 400, aucune
  // tentative de paiement initiée). Absente -> chemin inchangé.
  if (body.billing !== undefined) {
    const billing = parseBilling(body.billing);
    if (billing === null) {
      return NextResponse.json({ outcome: "invalid_request", reason: "billing_invalid" }, { status: 400 });
    }
    try {
      await setOrderBillingContext(
        billing.source === "delivery_reuse"
          ? { orderId, publicToken, source: "delivery_reuse", country: billing.country }
          : {
              orderId,
              publicToken,
              source: "manual",
              addressLine1: billing.addressLine1,
              addressLine2: billing.addressLine2,
              city: billing.city,
              postalCode: billing.postalCode,
              country: billing.country,
              customerName: billing.customerName,
              customerEmail: billing.customerEmail,
              customerPhone: billing.customerPhone,
            }
      );
    } catch {
      return NextResponse.json({ outcome: "invalid_request", reason: "billing_invalid" }, { status: 400 });
    }
  }

  try {
    const result = await initiateCheckout({
      orderId,
      publicToken,
      language: isNonEmptyString(body.language) ? body.language : undefined,
    });

    switch (result.outcome) {
      case "checkout_not_needed":
        return NextResponse.json(
          { outcome: "checkout_not_needed", reason: result.reason },
          { status: 200 }
        );
      case "provider_unavailable":
        return NextResponse.json({ outcome: "provider_unavailable" }, { status: 503 });
      case "payment_decision_unavailable":
        // ISSUE #172 / T180-01 : la décision « sans paiement en ligne »
        // n'est pas acquise -> JAMAIS un 200 `checkout_not_needed`. 503 :
        // la commande existe, la reprise est sûre (même commande).
        return NextResponse.json({ outcome: "payment_decision_unavailable" }, { status: 503 });
      case "billing_required":
        // Signal DISTINCT et intentionnel (mandat v4 §8 : "FAIL
        // CHECKOUT CLEANLY") -- actionnable par un appelant légitime
        // (inviter le client à renseigner sa facturation), jamais
        // confondu avec une panne opérationnelle générique.
        return NextResponse.json({ outcome: "billing_required" }, { status: 409 });
      case "invalid_request":
        // PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 -- ferme
        // P3BV41-PREFLIGHT-01. Distinct de la vérification de forme du
        // corps JSON ci-dessus (même statut HTTP 400, même sémantique
        // "requête client invalide") -- ici, la valeur a passé la
        // vérification de FORME (chaîne non vide) mais échoue une
        // règle métier STATIQUE (langue non supportée), toujours
        // détectée AVANT toute mutation P1.
        return NextResponse.json(
          { outcome: "invalid_request", reason: result.reason },
          { status: 400 }
        );
      case "ready":
        return NextResponse.json(
          {
            outcome: "ready",
            submissionUrl: result.submissionUrl,
            fields: result.fields,
            resumed: result.resumed,
          },
          { status: 200 }
        );
    }
  } catch (err) {
    if (err instanceof PaymentCheckoutRuntimeDisabledError) {
      return NextResponse.json({ outcome: "checkout_disabled" }, { status: 503 });
    }
    // TOUT le reste -- une seule réponse générique, jamais de
    // `err.message`/`err.stack` exposé au client.
    return genericFailureResponse();
  }
}
