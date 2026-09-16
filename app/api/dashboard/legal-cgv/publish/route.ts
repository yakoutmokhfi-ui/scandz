import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  publishMerchantCgvVersionServerAuthoritative,
  LegalCgvPublishServerError,
} from "@/lib/server/legal-cgv-publish-service";

/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1.1/v1.2 — AUDIT REMEDIATION
 * (Catimini). v1.2 adds one new retriable outcome, "stale_context"
 * (CGV-V11-PUBLISH-CONTEXT-RACE-01) — the request body/response shape
 * below is otherwise UNCHANGED from v1.1: still `{ restaurantId }` in,
 * still no fingerprint/acting-user-id/template/content ever crosses
 * this boundary in either direction.
 *
 * Adaptateur HTTP fin (même patron que
 * app/api/dashboard/catalogue/product-photo/route.ts et
 * app/api/checkout/invoice-request/route.ts) — toute la logique de
 * confiance vit dans lib/server/legal-cgv-publish-service.ts, jamais
 * dupliquée ici. Seul point du projet appelé par le navigateur pour
 * publier une version CGV — lib/services/legal-cgv.ts
 * (`publishMerchantCgvVersion`) ne parle plus jamais directement à la
 * RPC de persistance (v1.1 : cette RPC n'est de toute façon plus
 * exécutable par `authenticated`, voir la migration SQL).
 *
 * Corps de requête : `{ "restaurantId": "<uuid>" }` UNIQUEMENT — aucun
 * template id, aucune locale, aucune variante de présentation, aucun
 * contenu rendu. Tout le reste est résolu côté serveur (voir
 * lib/server/legal-cgv-publish-service.ts).
 *
 * Authentification : jeton d'accès de l'appelant, extrait de son
 * PROPRE en-tête `Authorization: Bearer <token>` — transmis tel quel à
 * lib/server/supabase-as-user.ts, jamais un secret serveur, jamais une
 * variable d'environnement. Une requête sans en-tête `Authorization`
 * valide échoue au niveau de resolve_cgv_publication_context lui-même
 * (auth.uid() is null -> 28000) — pas de duplication de logique
 * d'authentification ici.
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

function statusForReason(reason: LegalCgvPublishServerError["reason"]): number {
  switch (reason) {
    case "auth":
      return 401;
    case "forbidden":
      return 403;
    case "incomplete":
    case "template_unresolved":
    case "stale_context":
      // v1.2 — a stale-context rejection is retriable: the dashboard
      // can re-resolve and re-render, then retry the publish, exactly
      // like an "incomplete profile" or "template unresolved" outcome
      // — never a permanent client error.
      return 409;
    case "withdrawal_runtime_not_ready":
    case "placeholder_text_detected":
    case "legal_guarantee_block_missing":
      // v2.5 — configuration/content-level publication hard-blocks
      // (Tasks 4/5): the merchant can change their withdrawal regime,
      // remove the placeholder text, or re-pin to a compliant
      // template, then retry — never a permanent client error either.
      return 409;
    default:
      return 502;
  }
}

/**
 * Réponse d'erreur générique — jamais un message SQL brut, jamais le
 * détail interne (`detail`, réservé au diagnostic serveur) exposé au
 * corps de réponse. `outcome` est un code STABLE, suffisant pour que
 * le tableau de bord affiche un message traduit adapté.
 */
function failureResponse(err: LegalCgvPublishServerError): NextResponse {
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
    const version = await publishMerchantCgvVersionServerAuthoritative(accessToken, body.restaurantId);
    return NextResponse.json({ outcome: "ok", version });
  } catch (err) {
    if (err instanceof LegalCgvPublishServerError) return failureResponse(err);
    return NextResponse.json({ outcome: "unavailable" }, { status: 502 });
  }
}
