import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import {
  submitWithdrawalRequest,
  WithdrawalAccessError,
  WithdrawalRejectedError,
  WithdrawalUnavailableError,
} from "@/lib/server/withdrawal-service";
import { tryDispatchWithdrawalAcknowledgement } from "@/lib/server/withdrawal-ack-service";
import {
  TRACKING_SESSION_COOKIE_NAME,
  verifyTrackingSessionToken,
} from "@/lib/server/tracking-session";
import { isPlausibleUuid } from "@/lib/tracking/uuid";

/**
 * SCANYM — ONLINE WITHDRAWAL v1 — enregistrement de la déclaration de
 * rétractation (art. L221-21 / D.221-5).
 *
 * AUTORITÉ : la session de suivi HttpOnly déjà auditée, vérifiée POUR
 * CETTE commande. Le corps de la requête ne transporte NI capacité, NI
 * jeton, NI e-mail servant de preuve : la capacité est lue côté serveur
 * dans le cookie chiffré, exactement comme la page de suivi. Un client
 * qui enverrait `orderId` seul n'obtient donc rien.
 *
 * Cette route est le SEUL point d'écriture du parcours : ouvrir l'écran
 * de rétractation ou cocher des produits n'appelle jamais rien.
 *
 * LOT 1 (P0, cookie-path fix, post-release-train live walkthrough) :
 * cette route vivait auparavant sous app/api/track/withdrawal/route.ts.
 * Le cookie `st_session` (lib/server/tracking-session.ts) est posé avec
 * `path: /track/{orderId}` (mandat §10, "narrow path where
 * practical") -- `/api/track/withdrawal` n'est PAS un sous-chemin de
 * `/track/{orderId}` (RFC 6265 §5.1.4, correspondance de PRÉFIXE DE
 * SEGMENT, jamais un simple préfixe textuel), donc le navigateur
 * n'envoyait JAMAIS ce cookie ici : `cookies().get(...)` retournait
 * systématiquement `undefined`, donc `WITHDRAWAL_CAPABILITY_INVALID`
 * à CHAQUE tentative de confirmation, quelle que soit la validité
 * réelle de la capacité -- confirmé en Production par Yakout (issue
 * #11). Déplacée ici, sous `/track/{orderId}/withdrawal`, qui EST un
 * sous-chemin réel de la portée du cookie. Aucun autre changement :
 * `verifyTrackingSessionToken` et la liaison orderId restent
 * strictement identiques, la portée du cookie lui-même reste étroite
 * (jamais élargie à `/`) -- seul l'EMPLACEMENT de cette route change.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, code: string) {
  return NextResponse.json({ ok: false, code }, { status });
}

function isSameOriginJsonRequest(request: NextRequest): boolean {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.split(";")[0]!.trim() !== "application/json") return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) return fetchSite === "same-origin";

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost !== request.headers.get("host")) return false;
  }
  return true;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginJsonRequest(request)) {
    return jsonError(400, "INVALID_REQUEST");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "INVALID_REQUEST");
  }

  const orderId = typeof body.orderId === "string" ? body.orderId : null;
  if (!orderId || !isPlausibleUuid(orderId)) {
    return jsonError(400, "INVALID_REQUEST");
  }

  // La capacité vient EXCLUSIVEMENT de la session vérifiée pour cette
  // commande -- jamais du corps de la requête.
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(TRACKING_SESSION_COOKIE_NAME)?.value ?? null;
  const session = sessionCookie ? verifyTrackingSessionToken(sessionCookie, orderId) : null;
  if (!session) {
    return jsonError(403, "WITHDRAWAL_CAPABILITY_INVALID");
  }

  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const acknowledgementAddress =
    typeof body.acknowledgementAddress === "string" ? body.acknowledgementAddress.trim() : "";
  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : "";

  // D.221-5 : nom, prénom et moyen électronique de réception de
  // l'accusé sont fournis ou confirmés par le consommateur.
  if (!firstName || !lastName) {
    return jsonError(400, "WITHDRAWAL_IDENTITY_REQUIRED");
  }
  if (!acknowledgementAddress.includes("@")) {
    return jsonError(400, "WITHDRAWAL_ACK_ADDRESS_INVALID");
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items: Array<{ orderItemId: string; quantity: number }> = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) return jsonError(400, "WITHDRAWAL_INVALID_ITEM_PAYLOAD");
    const record = raw as Record<string, unknown>;
    const orderItemId = typeof record.orderItemId === "string" ? record.orderItemId : "";
    const quantity = typeof record.quantity === "number" ? record.quantity : Number.NaN;
    if (!isPlausibleUuid(orderItemId) || !Number.isInteger(quantity) || quantity <= 0) {
      return jsonError(400, "WITHDRAWAL_INVALID_ITEM_PAYLOAD");
    }
    items.push({ orderItemId, quantity });
  }
  if (items.length === 0) {
    return jsonError(400, "WITHDRAWAL_NO_ITEM_SELECTED");
  }

  try {
    const receipt = await submitWithdrawalRequest({
      orderId: session.orderId,
      capabilityId: session.capabilityId,
      secret: session.secret,
      firstName,
      lastName,
      acknowledgementChannel: "email",
      acknowledgementAddress,
      items,
      clientRequestId,
    });

    // GAP-01 — BEST-EFFORT, NON BLOQUANT : la déclaration de
    // rétractation est déjà enregistrée avec succès ci-dessus ; un
    // échec d'envoi de l'accusé (canal absent, panne SMTP,
    // ré-attribution concurrente) ne doit JAMAIS transformer cette
    // réponse en erreur -- il est seulement journalisé dans
    // withdrawal_requests via record_withdrawal_acknowledgement_result
    // (voir lib/server/ack-mailer.ts). `void` : ne bloque jamais la
    // réponse HTTP sur l'envoi réel de l'e-mail.
    if (!receipt.replayed) {
      void tryDispatchWithdrawalAcknowledgement(receipt.withdrawalRequestId);
    }

    return NextResponse.json({
      ok: true,
      withdrawalRequestId: receipt.withdrawalRequestId,
      requestedAt: receipt.requestedAt,
      acknowledgementStatus: receipt.acknowledgementStatus,
      replayed: receipt.replayed,
    });
  } catch (err) {
    if (err instanceof WithdrawalRejectedError) {
      return jsonError(err.code === "WITHDRAWAL_CAPABILITY_INVALID" ? 403 : 400, err.code);
    }
    if (err instanceof WithdrawalAccessError) {
      return jsonError(403, "WITHDRAWAL_CAPABILITY_INVALID");
    }
    if (err instanceof WithdrawalUnavailableError) {
      return jsonError(503, "WITHDRAWAL_UNAVAILABLE");
    }
    return jsonError(503, "WITHDRAWAL_UNAVAILABLE");
  }
}
