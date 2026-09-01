import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  initiateCheckout,
  PaymentCheckoutRuntimeDisabledError,
} from "@/lib/server/payment-checkout-runtime";

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
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
