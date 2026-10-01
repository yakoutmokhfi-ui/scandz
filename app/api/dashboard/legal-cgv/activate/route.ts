import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  activateMerchantCgvServerAuthoritative,
  LegalCgvActivateServerError,
} from "@/lib/server/legal-cgv-activate-service";

/**
 * CGV W2 — PUBLICATION BOUNDARY FIXES (Noether, scanym-orchestrator#23,
 * W2-6). Même patron qu'app/api/dashboard/legal-cgv/publish/route.ts :
 * adaptateur HTTP fin, toute la logique vit dans
 * lib/server/legal-cgv-activate-service.ts, jamais dupliquée ici.
 *
 * Corps de requête : `{ "restaurantId": "<uuid>" }` UNIQUEMENT.
 * Authentification : jeton d'accès du DEMANDEUR HTTP lui-même, extrait
 * de son PROPRE en-tête `Authorization: Bearer <token>` -- jamais un
 * secret serveur (voir lib/server/supabase-as-user.ts).
 *
 * ZÉRO SQL : `activate_merchant_cgv` (DRAFT-lot-seller-legal-profile-
 * cgv-engine-v1-1.sql) n'est ni modifiée ni re-grantée -- seul le
 * point d'appel change (ici, au lieu du navigateur). Voir le
 * commentaire d'en-tête de legal-cgv-activate-service.ts pour le
 * détail de l'invariant "frontière technique, pas nouveau modèle
 * métier".
 */
export const runtime = "nodejs";

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function statusForReason(reason: LegalCgvActivateServerError["reason"]): number {
  switch (reason) {
    case "auth":
      return 401;
    case "forbidden":
      return 403;
    case "incomplete":
    case "not_published":
      // Retriable : le marchand peut compléter son profil ou publier
      // une version avant de réessayer -- jamais une erreur client
      // permanente (même discipline que publish/route.ts).
      return 409;
    default:
      return 502;
  }
}

/**
 * Réponse d'erreur générique -- jamais un message SQL brut, jamais le
 * détail interne exposé au corps de réponse (même discipline que
 * publish/route.ts).
 */
function failureResponse(err: LegalCgvActivateServerError): NextResponse {
  return NextResponse.json({ outcome: err.reason }, { status: statusForReason(err.reason) });
}

export async function POST(request: NextRequest) {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    return NextResponse.json({ outcome: "auth" }, { status: 401 });
  }

  let body: { restaurantId?: unknown };
  try {
    body = (await request.json()) as { restaurantId?: unknown };
  } catch {
    return NextResponse.json({ outcome: "unavailable" }, { status: 400 });
  }

  if (!isNonEmptyString(body.restaurantId)) {
    return NextResponse.json({ outcome: "invalid_field", field: "restaurantId" }, { status: 400 });
  }

  try {
    await activateMerchantCgvServerAuthoritative(accessToken, body.restaurantId);
    return NextResponse.json({ outcome: "ok" });
  } catch (err) {
    if (err instanceof LegalCgvActivateServerError) return failureResponse(err);
    return NextResponse.json({ outcome: "unavailable" }, { status: 502 });
  }
}
