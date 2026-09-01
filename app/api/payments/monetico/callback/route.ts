import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { processMoneticoCallback } from "@/lib/server/payment-callback-runtime";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 — ROUTE DE CALLBACK
 * ("Retour" serveur-à-serveur).
 *
 * `node:crypto` requis en transitif (vérification MAC) -- jamais Edge.
 */
export const runtime = "nodejs";

/** Octet-pour-octet identique au repli défini par ack.ts -- utilisé
 *  UNIQUEMENT comme filet de sécurité si `processMoneticoCallback`
 *  levait malgré tout une exception non rattrapée (ne devrait jamais
 *  arriver -- chaque étage interne a son propre try/catch fail-closed
 *  -- mais un callback Monetico attend TOUJOURS un corps text/plain
 *  dans la fenêtre de 30 s, jamais une page d'erreur HTML générique
 *  Next.js). Dupliqué intentionnellement (pas importé de ack.ts) :
 *  cette route ne doit dépendre d'AUCUN import supplémentaire pour
 *  produire son dernier filet de sécurité. */
const FAILSAFE_ACK = "version=2\ncdr=1\n";

function ackResponse(ack: string): NextResponse {
  return new NextResponse(ack, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Monetico poste le callback en `application/x-www-form-urlencoded`
 * (v2.0 §1.4.3, plage confirmée) -- `request.formData()` gère ce
 * format nativement. Toute entrée qui n'est PAS une chaîne (un
 * `File`, jamais attendu par ce protocole) est simplement omise --
 * `parseMoneticoCallback` (appelé en aval) rejette de toute façon
 * toute structure inattendue, fail-closed.
 */
async function parseRawFields(request: NextRequest): Promise<Record<string, string> | null> {
  try {
    const formData = await request.formData();
    const fields: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    return fields;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const raw = await parseRawFields(request);
  if (raw === null) {
    // Corps illisible -- ne peut même pas tenter de corréler. ACK
    // échec direct, RIEN enregistré (même posture que "malformed" dans
    // processMoneticoCallback, ce filtre est purement une défense de
    // transport HTTP en amont de lui).
    return ackResponse(FAILSAFE_ACK);
  }

  try {
    const result = await processMoneticoCallback(raw);
    return ackResponse(result.ack);
  } catch {
    // Filet de sécurité -- voir le commentaire de FAILSAFE_ACK
    // ci-dessus. Ne devrait structurellement jamais être atteint :
    // chaque branche interne de `processMoneticoCallback` a son propre
    // try/catch fail-closed et ne laisse rien remonter.
    return ackResponse(FAILSAFE_ACK);
  }
}
