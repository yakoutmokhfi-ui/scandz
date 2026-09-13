import "server-only";
import { getOrderPaymentStatusSnapshot } from "@/lib/server/payment-service";
import { verifyReturnRelayToken } from "@/lib/server/payment-return-relay";
import { buildTrackingPath } from "@/lib/tracking/link";

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
 *
 * CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "payment-return
 * experience" / "fulfillment wording") — chaque variante RÉSOLUE (donc
 * PAS `"unavailable"`) porte désormais `trackingPath`, construit
 * UNIQUEMENT à partir du `publicToken` déjà vérifié ci-dessus par
 * `verifyReturnRelayToken` (jamais un second secret, jamais une
 * nouvelle décision de confiance -- `lib/tracking/link.ts::
 * buildTrackingPath` est une fonction PURE, aucun accès réseau/SQL).
 * `"unavailable"` n'a structurellement AUCUN `publicToken` vérifié à
 * cet endroit (jeton de relais absent/invalide/expiré, ou commande
 * incohérente) -- il ne peut donc JAMAIS porter de lien de suivi, ce
 * qui reste cohérent avec la posture anti-fuite ci-dessus.
 */
export type PaymentReturnStatus =
  | { kind: "unavailable" }
  | { kind: "paid"; trackingPath: string }
  | { kind: "pending"; trackingPath: string }
  | { kind: "not_required"; trackingPath: string }
  | { kind: "failed_or_cancelled"; trackingPath: string };

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

  // CUSTOMER CONFIRMATION + TRACKING FINAL v1 : `publicToken` a déjà
  // été vérifié ci-dessus (issu du jeton de relais décodé, jamais du
  // query string en clair) -- ce chemin, PAS de SQL supplémentaire.
  const trackingPath = buildTrackingPath(orderId, publicToken);

  switch (snapshot.paymentStatus) {
    case "paid":
      return { kind: "paid", trackingPath };
    case "pending":
      return { kind: "pending", trackingPath };
    case "not_required":
      return { kind: "not_required", trackingPath };
    default:
      // "failed"/"cancelled" -- gérée uniquement par robustesse
      // (état antérieur/legacy/ops), structurellement inatteignable via
      // un simple refus/abandon (INCHANGÉ, voir payment-callback-runtime.ts).
      return { kind: "failed_or_cancelled", trackingPath };
  }
}
