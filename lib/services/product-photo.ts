import { getSession } from "@/lib/services/auth";
import {
  validateProductPhotoFile,
  detectImageType,
  extractStoragePath,
  MAX_FILE_SIZE_BYTES,
  InvalidFileTypeError,
  FileTooLargeError,
  type OldImageCleanupOutcome,
} from "@/lib/product-photo-contract";

export type { OldImageCleanupOutcome };

/**
 * Photo produit — flux de remplacement de confiance côté serveur
 * (BULK PRODUCT PHOTOS v1.4).
 *
 * AVANT v1.4 : ce module parlait DIRECTEMENT à Supabase Storage
 * (upload) puis à la RPC `set_product_photo` -- seul point du projet à
 * le faire. Cat Stevens (réaudit final de v1.3, 3 blockers) a
 * démontré que cette architecture ne pouvait structurellement pas
 * fermer la provenance de l'ancienne image (le NOUVEAU chemin restait
 * librement choisi par ce module, donc par le client) ni garantir une
 * suppression Storage par l'API réelle plutôt qu'une suppression de
 * ligne storage.objects.
 *
 * v1.4 : ce module NE PARLE PLUS JAMAIS directement à Supabase
 * Storage ni à aucune RPC pour ce flux. Il délègue INTÉGRALEMENT à la
 * nouvelle route de confiance, app/api/dashboard/catalogue/
 * product-photo/route.ts, qui authentifie l'appelant (jeton de la
 * session courante, transmis explicitement dans l'en-tête
 * `Authorization`), résout restaurant_id de façon autoritaire,
 * génère le chemin final, effectue l'upload et l'écriture DB, et
 * supprime l'ancienne image via l'API Storage réelle -- voir
 * lib/server/product-photo-service.ts et TRUST-BOUNDARY-DESIGN.md
 * pour le détail complet.
 *
 * La validation de fichier (taille, type réel par signature binaire)
 * reste effectuée ICI AUSSI, AVANT l'envoi réseau -- confort UX
 * (échec immédiat, pas d'aller-retour réseau pour l'erreur la plus
 * fréquente) -- mais n'est plus jamais la validation AUTORITAIRE : la
 * route de confiance revalide les octets réels reçus, indépendamment
 * de ce que ce module a décidé (lib/product-photo-contract.ts,
 * module PARTAGÉ, mêmes fonctions, jamais une seconde implémentation
 * divergente).
 *
 * v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, LOST HTTP
 * RESPONSE / SUCCESSFUL REPLAY) : ANNULE ET REMPLACE le paramètre
 * `idempotencyKey` v2.1. `addOrReplaceProductPhoto` accepte désormais
 * un contexte Bulk optionnel (`BulkPhotoApplyContext`), transmis tel
 * quel au serveur -- voir lib/server/product-photo-service.ts. Ce
 * module ne génère JAMAIS lui-même de `batchId` ni ne décide JAMAIS
 * lui-même si un appel est un retry : c'est à l'APPELANT
 * (BulkPhotoUpload.tsx) de produire le `batchId` une seule fois par
 * lot et de savoir si CET appel est la toute première tentative d'un
 * fileKey ou un retry -- ce module se contente de relayer. Un retry
 * dont le serveur détecte un CONFLICT (un autre changement de photo
 * légitime a eu lieu entre-temps) lève `PhotoConflictError`, distincte
 * de `PhotoUploadError`.
 */

const PHOTO_ROUTE = "/api/dashboard/catalogue/product-photo";
const PHOTO_RETRY_CLEANUP_ROUTE = "/api/dashboard/catalogue/product-photo/retry-cleanup";

export {
  detectImageType,
  validateProductPhotoFile,
  extractStoragePath,
  MAX_FILE_SIZE_BYTES,
  InvalidFileTypeError,
  FileTooLargeError,
};

/**
 * Échec d'ajout/remplacement de photo (validation locale OU appel à
 * la route de confiance). Le message technique d'origine reste
 * disponible via `cause` (pour un log/debug), jamais celui affiché à
 * l'utilisateur : l'appelant (dashboard) affiche un message traduit
 * générique (mcPhotoUploadError).
 */
export class PhotoUploadError extends Error {
  constructor(cause: unknown) {
    super("Photo upload failed", { cause });
    this.name = "PhotoUploadError";
  }
}

/** Même principe que PhotoUploadError, pour la suppression. */
export class PhotoRemoveError extends Error {
  constructor(cause: unknown) {
    super("Photo remove failed", { cause });
    this.name = "PhotoRemoveError";
  }
}

/**
 * NOUVEAU v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, SAFE
 * RETRY). Distincte de `PhotoUploadError` : un retry Bulk a été
 * explicitement REFUSÉ par le serveur parce que l'image actuellement
 * autoritaire du produit n'est ni celle produite par cette opération
 * ni celle observée avant sa toute première tentative -- un autre
 * changement de photo légitime a eu lieu entre-temps (mandat : "do NOT
 * overwrite it during an uncertain retry"). AUCUN upload, AUCUNE
 * mutation n'a eu lieu côté serveur pour CET appel. Ne survient JAMAIS
 * pour Single Photo Edit (qui ne transmet jamais de contexte Bulk) ni
 * pour la toute première tentative d'un fileKey (voir
 * BulkPhotoApplyContext ci-dessous).
 */
export class PhotoConflictError extends Error {
  constructor(cause?: unknown) {
    super("Photo replace conflict", cause !== undefined ? { cause } : undefined);
    this.name = "PhotoConflictError";
  }
}

/**
 * NOUVEAU v2.2 -- contexte Bulk optionnel transmis à
 * `addOrReplaceProductPhoto`. `batchId` : identifiant OPAQUE d'un lot
 * Bulk, généré UNE SEULE FOIS par lot par l'appelant
 * (BulkPhotoUpload.tsx), réutilisé pour CHAQUE produit du lot et pour
 * TOUT retry.
 *
 * v2.2.1 (Cat Stevens, SOLE BLOCKER FIX) -- APLATI depuis l'ancienne
 * union discriminée à deux variantes (`isRetry: false` sans champ
 * supplémentaire, vs `isRetry: true` avec `expectedPriorImageUrl`
 * OBLIGATOIRE). `expectedPriorImageUrl` est RETIRÉ : la décision
 * ALREADY_APPLIED / CONFLICT est désormais prise ENTIÈREMENT côté SQL,
 * SOUS le verrou de ligne autoritaire (voir lib/server/
 * product-photo-service.ts, ADDENDUM v2.2.1 dans
 * DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql) --
 * AUCUNE valeur "image attendue" fournie par ce module n'est plus
 * nécessaire ni utilisée : seule la cible déterministe
 * (batchId×restaurant_id×product_id, déjà résolue côté serveur) compte.
 * Ce module se contente toujours de relayer `isRetry` tel quel -- il ne
 * décide JAMAIS lui-même si un appel est un retry, c'est à l'appelant
 * (BulkPhotoUpload.tsx) de le savoir (voir en-tête de fichier).
 */
export interface BulkPhotoApplyContext {
  batchId: string;
  isRetry: boolean;
}

/**
 * Jeton d'accès de la session courante -- transmis explicitement dans
 * l'en-tête `Authorization` de l'appel à la route de confiance,
 * jamais lu depuis une variable d'environnement ni un secret serveur
 * (il s'agit du jeton du NAVIGATEUR appelant lui-même). Lève une
 * erreur typée si aucune session n'est active -- la route de confiance
 * la refuserait de toute façon (401), mais échouer ici évite un
 * aller-retour réseau inutile pour un cas déjà connu localement.
 */
async function requireAccessToken(): Promise<string> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new Error("No active session");
  }
  return session.access_token;
}

/**
 * Résultat d'un ajout/remplacement réussi -- `oldImageCleanup`
 * (BULK PRODUCT PHOTOS v1.5, Cat Stevens MEDIUM -- "DB SUCCESS + OLD
 * DELETE FAILURE NOT SURFACED TO UI") est désormais PROPAGÉ jusqu'ici,
 * jamais silencieusement ignoré comme avant v1.5 : le remplacement
 * reste réussi quel que soit son contenu (`imageUrl` est toujours
 * autoritaire), mais un appelant qui souhaite avertir l'utilisateur
 * d'un nettoyage non garanti (échec Storage best-effort, ou référence
 * historique jugée non sûre et jamais tentée -- voir
 * FAILURE-COMPENSATION-MATRIX.md) peut désormais le faire.
 */
export interface AddOrReplaceProductPhotoResult {
  imageUrl: string;
  oldImageCleanup: OldImageCleanupOutcome;
  /**
   * NOUVEAU v1.7 (REMPLACE `oldPath`, v1.6). Identifiant OPAQUE (uuid),
   * tel que renvoyé par la route de confiance (jamais une valeur
   * inventée ici, jamais un chemin Storage) -- ce module ne reçoit et
   * ne manipule plus JAMAIS de chemin Storage pour ce flux. N'a
   * d'utilité que lorsque `oldImageCleanup === "failed"` -- à conserver
   * TEL QUEL par l'appelant (état du composant) pour un éventuel retry
   * via retryOldPhotoCleanup ; `null` sinon.
   */
  cleanupId: string | null;
  /**
   * NOUVEAU v2.2 -- `true` UNIQUEMENT quand un contexte Bulk était
   * fourni ET que le serveur a reconnu cet appel, AVANT tout upload,
   * comme un rejeu d'une opération déjà appliquée avec succès (réponse
   * HTTP précédente perdue) -- ZÉRO mutation supplémentaire n'a eu
   * lieu. Toujours `false` pour Single Photo Edit.
   */
  alreadyApplied: boolean;
}

/**
 * Ajoute ou remplace la photo d'un produit. Validation locale
 * (confort UX) puis délégation intégrale à la route de confiance --
 * ce module ne choisit plus jamais le chemin Storage final, ne parle
 * plus jamais à Storage lui-même, et ne transmet plus jamais de
 * "chemin ancien" au serveur (voir en-tête de fichier).
 *
 * `bulk` (NOUVEAU v2.2, LOST HTTP RESPONSE / SUCCESSFUL REPLAY) --
 * ANNULE ET REMPLACE le paramètre `idempotencyKey` v2.1. Optionnel ;
 * omis pour Single Photo Edit (comportement byte pour byte inchangé).
 * Voir BulkPhotoApplyContext ci-dessus et lib/server/
 * product-photo-service.ts pour le mécanisme serveur complet. Une
 * réponse serveur CONFLICT (409) lève `PhotoConflictError`, jamais
 * `PhotoUploadError` -- l'appelant peut ainsi distinguer un échec réel
 * d'un refus délibéré de retry incertain.
 */
export async function addOrReplaceProductPhoto(
  restaurantId: string,
  productId: string,
  file: File,
  bulk?: BulkPhotoApplyContext
): Promise<AddOrReplaceProductPhotoResult> {
  // Validation locale (confort UX uniquement -- la route de confiance
  // revalide les octets réels de façon autoritaire).
  await validateProductPhotoFile(file);
  void restaurantId; // résolu AUTORITAIREMENT côté serveur (begin_product_photo_replacement) -- jamais transmis ni fait confiance ici.

  let accessToken: string;
  try {
    accessToken = await requireAccessToken();
  } catch (e) {
    throw new PhotoUploadError(e);
  }

  const form = new FormData();
  form.set("productId", productId);
  form.set("file", file);
  if (bulk) {
    form.set("batchId", bulk.batchId);
    // v2.2.1 -- signal `isRetry` toujours transmis tel quel (plus de
    // discriminant imbriqué) ; aucune valeur "image attendue" n'existe
    // plus à transmettre (voir BulkPhotoApplyContext ci-dessus).
    form.set("isRetry", bulk.isRetry ? "1" : "0");
  }

  let response: Response;
  try {
    response = await fetch(PHOTO_ROUTE, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
  } catch (e) {
    throw new PhotoUploadError(e);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // pas de corps JSON exploitable -- l'erreur générique suffit.
    }
    if (response.status === 409) {
      throw new PhotoConflictError(body ?? { status: response.status });
    }
    throw new PhotoUploadError(body ?? { status: response.status });
  }

  const data = (await response.json()) as {
    imageUrl?: string;
    oldImageCleanup?: OldImageCleanupOutcome;
    cleanupId?: string | null;
    alreadyApplied?: boolean;
  };
  if (!data.imageUrl) {
    throw new PhotoUploadError(new Error("Trusted route returned no imageUrl"));
  }
  return {
    imageUrl: data.imageUrl,
    oldImageCleanup: data.oldImageCleanup ?? "not_applicable",
    cleanupId: data.cleanupId ?? null,
    alreadyApplied: data.alreadyApplied ?? false,
  };
}

/**
 * Supprime la photo d'un produit -- délégation intégrale à la route
 * de confiance (DELETE), qui capture et supprime l'ancienne image
 * exactement comme pour un remplacement. `oldImageCleanup` propagé
 * (v1.5, même raison que addOrReplaceProductPhoto ci-dessus).
 */
export async function removeProductPhoto(
  productId: string
): Promise<{ oldImageCleanup: OldImageCleanupOutcome; cleanupId: string | null }> {
  let accessToken: string;
  try {
    accessToken = await requireAccessToken();
  } catch (e) {
    throw new PhotoRemoveError(e);
  }

  let response: Response;
  try {
    response = await fetch(PHOTO_ROUTE, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ productId }),
    });
  } catch (e) {
    throw new PhotoRemoveError(e);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // pas de corps JSON exploitable -- l'erreur générique suffit.
    }
    throw new PhotoRemoveError(body ?? { status: response.status });
  }

  const data = (await response.json()) as {
    oldImageCleanup?: OldImageCleanupOutcome;
    cleanupId?: string | null;
  };
  return { oldImageCleanup: data.oldImageCleanup ?? "not_applicable", cleanupId: data.cleanupId ?? null };
}

/**
 * v1.6 (MEDIUM cleanup retry -- Cat Stevens : "échec de nettoyage doit
 * être ré-essayable de bout en bout SANS rejouer le remplacement
 * complet"), SIGNATURE RÉÉCRITE v1.7 (Cat Stevens, SEUL blocker de
 * v1.6 -- TRUST BOUNDARY). Retente UNIQUEMENT le nettoyage Storage de
 * l'ancienne image -- délégation intégrale à la route FRÈRE dédiée
 * (product-photo/retry-cleanup), qui n'appelle jamais
 * replaceProductPhoto/removeProductPhoto : AUCUN nouvel upload, AUCUNE
 * écriture menu_items rejouée. `cleanupId` (JAMAIS un chemin, JAMAIS
 * `oldPath`) DOIT être exactement la valeur `cleanupId` déjà reçue une
 * fois via AddOrReplaceProductPhotoResult/removeProductPhoto ci-dessus
 * -- ce module ne construit, ne parse, ni ne transmet plus JAMAIS de
 * chemin Storage pour ce flux.
 */
export async function retryOldPhotoCleanup(
  productId: string,
  cleanupId: string
): Promise<{ oldImageCleanup: OldImageCleanupOutcome }> {
  let accessToken: string;
  try {
    accessToken = await requireAccessToken();
  } catch (e) {
    throw new PhotoRemoveError(e);
  }

  let response: Response;
  try {
    response = await fetch(PHOTO_RETRY_CLEANUP_ROUTE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ productId, cleanupId }),
    });
  } catch (e) {
    throw new PhotoRemoveError(e);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // pas de corps JSON exploitable -- l'erreur générique suffit.
    }
    throw new PhotoRemoveError(body ?? { status: response.status });
  }

  const data = (await response.json()) as { oldImageCleanup?: OldImageCleanupOutcome };
  return { oldImageCleanup: data.oldImageCleanup ?? "not_applicable" };
}
