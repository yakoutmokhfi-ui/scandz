import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { retryOldImageCleanup, ProductPhotoServerError } from "@/lib/server/product-photo-service";

/**
 * BULK PRODUCT PHOTOS v1.6 — RETRY-CLEANUP (Cat Stevens, MEDIUM :
 * "échec de nettoyage doit être ré-essayable de bout en bout SANS
 * rejouer le remplacement complet"), CORPS DE REQUÊTE RÉÉCRIT v1.7
 * (Cat Stevens, SEUL blocker de v1.6 -- TRUST BOUNDARY : "le
 * cleanup-retry accepte un oldPath fourni par le client").
 *
 * Endpoint FRÈRE, distinct de app/api/dashboard/catalogue/
 * product-photo/route.ts -- n'appelle JAMAIS replaceProductPhoto ni
 * removeProductPhoto : AUCUN nouvel upload, AUCUNE écriture
 * menu_items. La SEULE opération possible ici est un nouvel essai de
 * suppression Storage de l'ancienne image, résolue et revalidée
 * intégralement CÔTÉ SERVEUR (voir lib/server/product-photo-service.ts::
 * retryOldImageCleanup) avant tout appel Storage réel.
 *
 * Corps : JSON `{ "productId": "...", "cleanupId": "..." }` -- v1.7 :
 * `cleanupId` REMPLACE `oldPath`/`oldImageUrl`/`cleanupPath` (SUPPRIMÉS,
 * ce endpoint n'accepte PLUS AUCUN chemin/URL Storage en provenance du
 * client). `cleanupId` est un identifiant OPAQUE (uuid) -- EXACTEMENT
 * la valeur `cleanupId` déjà renvoyée UNE FOIS par un appel POST/DELETE
 * antérieur sur product-photo/route.ts. Ce paramètre n'est JAMAIS, en
 * lui-même, une autorisation : c'est UNIQUEMENT une clé de recherche
 * vers une ligne `product_photo_pending_cleanups` SERVEUR --
 * retryOldImageCleanup résout le chemin réellement candidat
 * EXCLUSIVEMENT depuis cette ligne, revalide restaurant/produit/forme
 * de chemin EXACTE DE NOUVEAU au moment de la réclamation (jamais une
 * confiance perpétuelle envers une validation passée), et exclut
 * intrinsèquement toute autre cible (cleanup_id fabriqué, d'un autre
 * tenant/produit, ou déjà consommé -> systématiquement refusé côté SQL,
 * jamais un simple filtrage applicatif ici). CLIENT CLEANUP PATH
 * PARAMETER: NONE.
 *
 * BULK RETRY INVARIANT : un remplacement déjà réussi n'est JAMAIS
 * rejoué par cet endpoint.
 */
export const runtime = "nodejs";

function genericFailureResponse(): NextResponse {
  return NextResponse.json({ outcome: "unavailable" }, { status: 502 });
}

function statusForReason(reason: ProductPhotoServerError["reason"]): number {
  switch (reason) {
    case "config":
      return 502;
    case "auth":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "invalid_file":
    case "invalid_request":
      return 400;
    default:
      return 502;
  }
}

function failureResponse(err: ProductPhotoServerError): NextResponse {
  const status = statusForReason(err.reason);
  return NextResponse.json({ outcome: "denied" }, { status });
}

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

/**
 * POST — retente UNIQUEMENT le nettoyage Storage de l'ancienne image.
 * Ne modifie JAMAIS menu_items.image_url, n'uploade JAMAIS rien.
 */
export async function POST(request: NextRequest) {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    return NextResponse.json({ outcome: "denied" }, { status: 401 });
  }

  let body: { productId?: unknown; cleanupId?: unknown };
  try {
    body = (await request.json()) as { productId?: unknown; cleanupId?: unknown };
  } catch {
    return genericFailureResponse();
  }

  if (!isNonEmptyString(body.productId)) {
    return NextResponse.json({ outcome: "invalid_field", field: "productId" }, { status: 400 });
  }
  if (!isNonEmptyString(body.cleanupId)) {
    return NextResponse.json({ outcome: "invalid_field", field: "cleanupId" }, { status: 400 });
  }

  try {
    const result = await retryOldImageCleanup({
      accessToken,
      productId: body.productId,
      cleanupId: body.cleanupId,
    });
    return NextResponse.json({ outcome: "ok", oldImageCleanup: result.oldImageCleanup });
  } catch (err) {
    if (err instanceof ProductPhotoServerError) return failureResponse(err);
    return genericFailureResponse();
  }
}
