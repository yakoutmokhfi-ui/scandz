import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { NON_LIVE_STUART_WEBHOOK_AUTH_ADAPTER } from "@/lib/server/delivery-providers/stuart/webhook-auth-adapter";
import { ingestStuartWebhookEvent } from "@/lib/server/delivery-providers/stuart/webhook-ingestion";

/**
 * STUART LOT D1 §E — WEBHOOK ROUTE FOUNDATION.
 *
 * FONDATION UNIQUEMENT, POUR TEST LOCAL/FIXTURE (mandat, littéral :
 * "a route/module MAY be created for local/fixture testing, but real
 * Stuart webhook authentication/signature is NOT proven"). Cette route
 * N'EST PAS un point de mutation Production authentifié -- elle utilise
 * INCONDITIONNELLEMENT `NON_LIVE_STUART_WEBHOOK_AUTH_ADAPTER`, qui
 * rejette TOUTE requête (`authenticated: false`) quel que soit son
 * contenu. AUCUN algorithme de signature n'est inventé ici ("do NOT
 * invent a signature algorithm") -- tant qu'aucun contrat réel n'est
 * fourni (D2), cette route répond TOUJOURS 401, sans exception.
 *
 * SÉPARATION EN TROIS COUCHES (mandat §E) :
 *   1. ingestion/stockage : `webhook-ingestion.ts` (jamais appelé ici
 *      si l'authentification échoue) ;
 *   2. adaptateur d'authentification prestataire :
 *      `webhook-auth-adapter.ts` (remplaçable en D2 sans toucher aux
 *      deux autres couches) ;
 *   3. traitement des évènements : `webhook-processor.ts` (asynchrone,
 *      PAS invoqué directement par cette route -- un futur worker/cron
 *      D2 appellera `processClaimedStuartProviderEvents` séparément,
 *      cette route se limite à la RÉCEPTION durable).
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const authResult = await NON_LIVE_STUART_WEBHOOK_AUTH_ADAPTER.verify(rawBody, headers);
  if (!authResult.authenticated) {
    // FAIL CLOSED, TOUJOURS -- aucun contrat de signature Stuart réel
    // n'est prouvé (mandat §E/§J). Ne JAMAIS renvoyer un détail
    // exploitable (pas de raison exposée au corps de réponse).
    return NextResponse.json({ error: "STUART_WEBHOOK_NOT_AUTHENTICATED" }, { status: 401 });
  }

  // Code mort en pratique tant qu'aucun adaptateur réel n'est fourni
  // (D2) -- conservé pour que le câblage de l'ingestion soit déjà
  // correct et testable via un adaptateur mocké dans les tests de ce
  // lot (mandat, "so auth can be completed later without redesign").
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "STUART_WEBHOOK_MALFORMED_BODY" }, { status: 400 });
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  const providerEventType = typeof body.event_type === "string" ? body.event_type : "unknown_event";
  const providerJobIdRaw =
    typeof body.job_id === "number" || typeof body.job_id === "string" ? String(body.job_id) : null;
  const providerStatusRaw = typeof body.status === "string" ? body.status : null;

  const record = await ingestStuartWebhookEvent({
    providerEventType,
    providerJobIdRaw,
    providerStatusRaw,
    rawBody,
  });

  return NextResponse.json({ received: true, isNewEvent: record.isNewEvent }, { status: 200 });
}
