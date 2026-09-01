import "server-only";
import { getOrderPaymentStatusSnapshot } from "@/lib/server/payment-service";
import { verifyReturnRelayToken } from "@/lib/server/payment-return-relay";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — PAGES DE RETOUR.
 *
 * RESTRUCTURATION v4 (ferme P3B-V3-PUBLIC-TOKEN-URL-01) : `publicToken`
 * n'est PLUS jamais lu en clair depuis le query string -- il n'y a
 * d'ailleurs plus jamais été placé en clair par
 * `payment-checkout-runtime.ts` (voir ce fichier). Seul un jeton de
 * relais OPAQUE (`token`), chiffré/authentifié (`payment-return-relay.ts`),
 * y transite désormais. `orderId` reste en clair (mission v3, INCHANGÉ
 * -- ce n'est PAS une capacité secrète) et sert de vérification
 * croisée obligatoire contre le jeton (`verifyReturnRelayToken` exige
 * la correspondance, défense contre un jeton copié vers une autre
 * commande).
 *
 * INVARIANT DUR PRÉSERVÉ (v3, INCHANGÉ) : ce fichier ne lit JAMAIS un
 * paramètre de requête autre que `orderId`/`token` pour décider QUELLE
 * commande consulter, et n'infère JAMAIS un résultat depuis la route
 * empruntée (ok/err) ou un paramètre "status"/"success"/"code-retour"
 * -- `getOrderPaymentStatusSnapshot` (lecture SERVEUR pure) reste
 * l'UNIQUE source de vérité.
 *
 * Toute défaillance de décodage du jeton (absent, malformé, falsifié,
 * expiré, commande incohérente) est REGROUPÉE avec toute autre
 * indisponibilité sous `"unavailable"` -- même posture anti-fuite que
 * v3, étendue ici au jeton de relais lui-même (jamais de distinction
 * observable "jeton expiré" vs "jeton falsifié" vs "commande
 * inexistante" vs "panne").
 */
export type PaymentReturnStatus =
  | { kind: "unavailable" }
  | { kind: "paid" }
  | { kind: "pending" }
  | { kind: "not_required" }
  | { kind: "failed_or_cancelled" };

function firstStringParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function resolvePaymentReturnStatus(
  searchParams: Record<string, string | string[] | undefined>
): Promise<PaymentReturnStatus> {
  const orderId = firstStringParam(searchParams.orderId);
  const token = firstStringParam(searchParams.token);

  if (typeof orderId !== "string" || orderId.length === 0) return { kind: "unavailable" };
  if (typeof token !== "string" || token.length === 0) return { kind: "unavailable" };

  let publicToken: string;
  try {
    const relay = verifyReturnRelayToken(token, orderId);
    publicToken = relay.publicToken;
  } catch {
    return { kind: "unavailable" };
  }

  let snapshot: Awaited<ReturnType<typeof getOrderPaymentStatusSnapshot>>;
  try {
    snapshot = await getOrderPaymentStatusSnapshot({ orderId, publicToken });
  } catch {
    return { kind: "unavailable" };
  }
  if (snapshot === null) return { kind: "unavailable" };

  switch (snapshot.paymentStatus) {
    case "paid":
      return { kind: "paid" };
    case "pending":
      return { kind: "pending" };
    case "not_required":
      return { kind: "not_required" };
    default:
      // "failed"/"cancelled" -- gérée uniquement par robustesse
      // (état antérieur/legacy/ops), structurellement inatteignable via
      // un simple refus/abandon (INCHANGÉ, voir payment-callback-runtime.ts).
      return { kind: "failed_or_cancelled" };
  }
}
