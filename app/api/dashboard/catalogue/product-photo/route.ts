import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  replaceProductPhoto,
  removeProductPhoto,
  ProductPhotoServerError,
} from "@/lib/server/product-photo-service";

/**
 * BULK PRODUCT PHOTOS v1.4/v1.5 — ROUTE DE REMPLACEMENT DE CONFIANCE.
 *
 * v1.5 (Cat Stevens, réaudit de v1.4) : la mutation SQL sous-jacente
 * (apply_product_photo_replacement) n'est désormais plus JAMAIS
 * accessible directement à `authenticated` (Blocker 1 v1.5) -- CETTE
 * ROUTE reste le SEUL chemin, quel qu'il soit, par lequel un
 * navigateur peut déclencher un remplacement/une suppression de photo
 * produit. `oldImageCleanup` (déjà renvoyé ici depuis v1.4) inclut
 * désormais la valeur `"skipped_unsafe_legacy"` (v1.5, Blocker 2) --
 * aucun changement de forme de réponse n'était nécessaire ici, le
 * champ était déjà transmis tel quel ; seul lib/services/
 * product-photo.ts (navigateur) l'ignorait encore avant v1.5 (MEDIUM,
 * fermé côté navigateur uniquement).
 *
 * v1.6 : `p_expected_origin` (Blocker 1 v1.6, origine Storage
 * historique jamais vérifiée) est désormais calculé et transmis
 * EXCLUSIVEMENT dans lib/server/product-photo-service.ts -- cette
 * route n'a AUCUN changement à ce sujet. `oldPath` était renvoyé (voir
 * ci-dessous, MEDIUM cleanup retry) ; le nouvel endpoint frère
 * `product-photo/retry-cleanup/route.ts` est le SEUL point d'entrée
 * pour retenter UNIQUEMENT le nettoyage Storage, sans jamais rejouer ce
 * POST/DELETE.
 *
 * v1.7 (Cat Stevens, SEUL blocker de v1.6 -- TRUST BOUNDARY) : `oldPath`
 * est REMPLACÉ par `cleanupId`, un identifiant OPAQUE (uuid) -- cette
 * route ne renvoie plus JAMAIS de chemin Storage au navigateur. Voir
 * lib/server/product-photo-service.ts (cleanupOldImage) et
 * CLEANUP-RETRY-TRUST-BOUNDARY.md pour l'analyse complète.
 *
 * v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, LOST HTTP
 * RESPONSE / SUCCESSFUL REPLAY) : ANNULE ET REMPLACE le champ
 * `idempotencyKey` v2.1. POST accepte désormais un champ optionnel
 * `batchId` (texte, identifiant de lot Bulk) -- transmis TEL QUEL à
 * replaceProductPhoto, voir lib/server/product-photo-service.ts pour
 * le mécanisme complet. Absent -> comportement byte pour byte inchangé
 * (Single Photo Edit).
 *
 * v2.2.1 (Cat Stevens, SOLE BLOCKER FIX -- voir lib/server/
 * product-photo-service.ts pour l'analyse complète) : le champ
 * `expectedPriorImageUrl` (v2.2) est RETIRÉ -- la décision de retry
 * (ALREADY_APPLIED / CONFLICT) est désormais prise ENTIÈREMENT côté
 * SQL, SOUS le verrou de ligne autoritaire, à partir de la SEULE cible
 * déterministe déjà connue serveur-side ; aucune valeur "image
 * attendue" fournie par le client n'est plus nécessaire ni acceptée.
 * `isRetry` ("1"/"0") reste le SEUL signal transmis, tel quel, à
 * replaceProductPhoto.
 *
 * Adaptateur HTTP fin (même patron que
 * app/api/checkout/invoice-request/route.ts) -- toute la logique de
 * confiance vit dans lib/server/product-photo-service.ts, jamais
 * dupliquée ici. Seul point du projet appelé par le navigateur pour
 * poser/remplacer/retirer une photo produit -- lib/services/
 * product-photo.ts (navigateur) ne parle plus jamais directement à
 * Supabase Storage ni à une RPC pour ce flux (voir NON-MODIFICATION-
 * PROOF.md).
 *
 * Authentification : jeton d'accès de l'appelant, extrait de son
 * PROPRE en-tête `Authorization: Bearer <token>` -- transmis tel quel
 * à lib/server/supabase-as-user.ts, jamais un secret serveur, jamais
 * une variable d'environnement. Une requête sans en-tête `Authorization`
 * valide échoue au niveau de begin_/apply_ elles-mêmes
 * (auth.uid() is null -> 28000) -- pas de duplication de logique
 * d'authentification ici.
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
    // NOUVEAU v2.2 -- retry Bulk dont l'image actuellement autoritaire
    // n'est ni la cible déterministe de CETTE opération ni l'état
    // observé avant la toute première tentative -- voir
    // lib/server/product-photo-service.ts (replaceProductPhoto).
    case "conflict":
      return 409;
    default:
      return 502;
  }
}

/**
 * Réponse d'erreur -- ne distingue JAMAIS observablement "produit
 * fabriqué" de "produit d'un autre restaurant" de "produit archivé"
 * (tous mappés à `not_found`, 404, message générique) : seules les
 * erreurs de VALIDATION DE FICHIER (type/taille -- l'utilisateur doit
 * savoir CE QU'IL a mal envoyé) sont distinguées.
 */
function failureResponse(err: ProductPhotoServerError): NextResponse {
  const status = statusForReason(err.reason);
  if (err.reason === "invalid_file") {
    return NextResponse.json({ outcome: "invalid_file" }, { status });
  }
  // NOUVEAU v2.2 -- distingué de "denied" : ce n'est ni une autorisation
  // refusée ni une erreur serveur, mais un retry Bulk incertain qui a
  // délibérément renoncé à écraser un changement de photo légitime
  // survenu entre-temps (voir statusForReason ci-dessus).
  if (err.reason === "conflict") {
    return NextResponse.json({ outcome: "conflict" }, { status });
  }
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
 * POST — pose ou remplace la photo d'un produit. Corps :
 * multipart/form-data, champs `productId` (string) et `file` (fichier
 * image). Le fichier est validé sur ses octets réels (jamais
 * l'extension) dans lib/server/product-photo-service.ts -- ce module
 * ne fait aucune validation dupliquée.
 */
export async function POST(request: NextRequest) {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    return NextResponse.json({ outcome: "denied" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return genericFailureResponse();
  }

  const productId = form.get("productId");
  const file = form.get("file");
  // NOUVEAU v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, LOST
  // HTTP RESPONSE / SUCCESSFUL REPLAY) -- ANNULE ET REMPLACE le champ
  // `idempotencyKey` v2.1. `batchId` optionnel, transmis tel quel à
  // replaceProductPhoto (voir lib/server/product-photo-service.ts) --
  // absent -> `undefined` -> comportement BYTE POUR BYTE inchangé
  // (chemin final ALÉATOIRE, aucune vérification de rejeu -- Single
  // Photo Edit). `isRetry` n'a de sens QUE lorsque `batchId` est fourni
  // (voir replaceProductPhoto, v2.2.1 : ignoré côté service si
  // `batchId` est absent). Aucun de ces champs n'accorde d'autorisation
  // en lui-même : l'authentification/l'autorisation restent entièrement
  // gérées par begin_/apply_, indépendamment de leur valeur.
  const batchIdField = form.get("batchId");
  const batchId = isNonEmptyString(batchIdField) ? batchIdField : undefined;
  const isRetry = form.get("isRetry") === "1";

  if (!isNonEmptyString(productId)) {
    return NextResponse.json({ outcome: "invalid_field", field: "productId" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ outcome: "invalid_field", field: "file" }, { status: 400 });
  }

  try {
    const result = await replaceProductPhoto({
      accessToken,
      productId,
      file,
      batchId,
      isRetry,
    });
    return NextResponse.json({
      outcome: "ok",
      imageUrl: result.imageUrl,
      oldImageCleanup: result.oldImageCleanup,
      // NOUVEAU v1.7 (REMPLACE oldPath, v1.6) -- identifiant OPAQUE
      // exposé pour permettre un retry ultérieur (voir
      // /product-photo/retry-cleanup ci-dessous) uniquement quand
      // oldImageCleanup === "failed" ; n'accorde AUCUNE capacité
      // supplémentaire (retryOldImageCleanup résout/revalide le chemin
      // EXCLUSIVEMENT côté serveur avant tout Storage .remove() -- ce
      // n'est jamais le navigateur qui fournit le chemin).
      cleanupId: result.cleanupId,
      // NOUVEAU v2.2 -- voir ReplaceProductPhotoResult.alreadyApplied.
      alreadyApplied: result.alreadyApplied,
    });
  } catch (err) {
    if (err instanceof ProductPhotoServerError) return failureResponse(err);
    return genericFailureResponse();
  }
}

/**
 * DELETE — retire la photo d'un produit (`image_url` -> null).
 * Corps : JSON `{ "productId": "..." }`.
 */
export async function DELETE(request: NextRequest) {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    return NextResponse.json({ outcome: "denied" }, { status: 401 });
  }

  let body: { productId?: unknown };
  try {
    body = (await request.json()) as { productId?: unknown };
  } catch {
    return genericFailureResponse();
  }

  if (!isNonEmptyString(body.productId)) {
    return NextResponse.json({ outcome: "invalid_field", field: "productId" }, { status: 400 });
  }

  try {
    const result = await removeProductPhoto({ accessToken, productId: body.productId });
    return NextResponse.json({
      outcome: "ok",
      oldImageCleanup: result.oldImageCleanup,
      // NOUVEAU v1.7 -- voir POST ci-dessus.
      cleanupId: result.cleanupId,
    });
  } catch (err) {
    if (err instanceof ProductPhotoServerError) return failureResponse(err);
    return genericFailureResponse();
  }
}
