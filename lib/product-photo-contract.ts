/**
 * BULK PRODUCT PHOTOS v1.4/v1.5 — CONTRAT DE FICHIER PARTAGÉ.
 *
 * Module pur, SANS dépendance Supabase/réseau (même convention que
 * lib/invoice-request.ts/lib/customer.ts) -- extrait de
 * lib/services/product-photo.ts (V67/v1.1-v1.3) pour être réutilisable
 * TEL QUEL par deux appelants désormais distincts :
 *   - lib/services/product-photo.ts (navigateur -- validation UX
 *     précoce, avant l'envoi réseau) ;
 *   - lib/server/product-photo-service.ts (serveur, nouveau en v1.4 --
 *     validation AUTORITAIRE, la seule qui compte réellement pour la
 *     sécurité : détection du type réel par signature binaire, jamais
 *     par extension ni par file.type annoncé, exactement comme avant).
 * Aucune logique de confiance ni d'accès réseau ici -- uniquement des
 * fonctions pures opérant sur les octets/la taille d'un fichier.
 *
 * `lib/services/establishment-assets.ts` (V68, bucket différent) garde
 * sa PROPRE copie indépendante de ces mêmes fonctions (convention déjà
 * établie dans ce dépôt avant v1.4 -- pas de couplage entre buckets) ;
 * ce module n'est PAS partagé avec lui.
 */

/** Doit rester synchronisé avec `file_size_limit` dans migration-v67-product-photos.sql. */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Résultat du nettoyage Storage de l'ANCIENNE image, après un
 * remplacement/une suppression réussi(e) (BULK PRODUCT PHOTOS v1.4/
 * v1.5). Type PARTAGÉ (module pur, sans dépendance Supabase) --
 * `lib/server/product-photo-service.ts` le produit, `lib/services/
 * product-photo.ts` (navigateur) le consomme, sans jamais dupliquer sa
 * définition (le module navigateur ne peut PAS importer `lib/server/*`
 * -- garde structurelle v110c-payment-p3a1-structural).
 *   - "removed" : l'ancienne image a été supprimée via l'API Storage
 *     réelle.
 *   - "not_applicable" : le produit n'avait pas d'ancienne photo
 *     (aucune suppression nécessaire).
 *   - "failed" : une ancienne image VALIDE existait mais sa
 *     suppression Storage a échoué (compensation best-effort --
 *     orphelin toléré, coût de stockage uniquement, jamais un
 *     rollback de la nouvelle valeur DB déjà autoritaire -- voir
 *     FAILURE-COMPENSATION-MATRIX.md).
 *   - "skipped_unsafe_legacy" (NOUVEAU v1.5, Cat Stevens Blocker 2) :
 *     la valeur `image_url` lue en DB avant le remplacement NE
 *     correspondait PAS exactement au contrat de chemin de confiance
 *     (bucket/origine, segments restaurant/produit, contrat UUID v4,
 *     extension) -- référence historique potentiellement empoisonnée,
 *     JAMAIS transmise à Storage `.remove()`, JAMAIS normalisée en une
 *     cible de suppression. Le remplacement lui-même reste réussi
 *     (nouvelle valeur déjà écrite) ; seul le nettoyage de cette
 *     référence non sûre est explicitement sauté -- voir
 *     POISONED-HISTORICAL-IMAGE-EVIDENCE.md.
 */
export type OldImageCleanupOutcome =
  | "removed"
  | "not_applicable"
  | "failed"
  | "skipped_unsafe_legacy";

export class InvalidFileTypeError extends Error {
  constructor() {
    super("Invalid file type");
    this.name = "InvalidFileTypeError";
  }
}

export class FileTooLargeError extends Error {
  constructor() {
    super("File too large");
    this.name = "FileTooLargeError";
  }
}

export interface ImageSignature {
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  matches: (head: Uint8Array) => boolean;
}

// Doit rester synchronisé avec `allowed_mime_types` dans
// migration-v67-product-photos.sql.
export const SIGNATURES: ImageSignature[] = [
  {
    mime: "image/jpeg",
    ext: "jpg",
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/png",
    ext: "png",
    matches: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/webp",
    ext: "webp",
    // RIFF <4 octets taille> WEBP
    matches: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

/**
 * Détecte le type d'image réel à partir des octets du fichier (pas de
 * l'extension du nom, pas seulement de `file.type`). Renvoie `null`
 * si aucune signature connue ne correspond. Fonctionne aussi bien avec
 * un `File` navigateur qu'avec un `File`/`Blob` du runtime Node (Next.js
 * App Router, `request.formData()`) -- les deux exposent `.slice()`.
 */
export async function detectImageType(
  file: Pick<File, "slice">
): Promise<{ mime: string; ext: string } | null> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  for (const sig of SIGNATURES) {
    if (sig.matches(head)) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

/**
 * Valide un fichier candidat avant tout upload : taille, puis type
 * réel (signature binaire). Lève une erreur typée précise, jamais un
 * message générique, pour que l'appelant affiche/journalise le bon
 * diagnostic. CÔTÉ SERVEUR (v1.4), c'est CETTE fonction, exécutée sur
 * le fichier reçu par la route de confiance, qui constitue la
 * validation AUTORITAIRE -- un appel côté navigateur qui la contourne
 * ou la trompe (file.type usurpé, extension trompeuse) échoue de
 * toute façon ici, sur les octets réels.
 */
export async function validateProductPhotoFile(
  file: Pick<File, "slice" | "size">
): Promise<{ mime: string; ext: string }> {
  if (file.size > MAX_FILE_SIZE_BYTES) throw new FileTooLargeError();
  const detected = await detectImageType(file);
  if (!detected) throw new InvalidFileTypeError();
  return detected;
}

/**
 * Chemin de stockage extrait d'une URL publique du bucket
 * product-photos, ou `null` si l'URL ne vient pas de ce bucket. Pur
 * utilitaire d'inspection, testé indépendamment -- documente le
 * contrat URL -> chemin partagé avec la validation SQL de
 * apply_product_photo_replacement (même marqueur
 * `/object/public/product-photos/`).
 */
export function extractStoragePath(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  const marker = "/object/public/product-photos/";
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) return null;
  return imageUrl.slice(idx + marker.length);
}

/**
 * Contrat EXACT `crypto.randomUUID()` v4 (Cat Stevens Blocker 3, v1.4)
 * + extension autorisée -- réplique JS de la regex SQL appliquée par
 * apply_product_photo_replacement (DRAFT-lot-bulk-product-photos-
 * storage-authorization-v1.sql). Minuscules uniquement, version
 * littérale '4' (13e caractère hex), variante RFC 4122 in (8,9,a,b)
 * (17e caractère hex) -- l'UUID nil est automatiquement rejeté (son
 * 13e caractère hex est '0', jamais '4'). "Do NOT invent constraints
 * beyond what crypto.randomUUID() and the actual application
 * produce" (mandat) -- cette regex n'encode rien de plus.
 */
export const CRYPTO_RANDOM_UUID_V4_FILENAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/**
 * Nom de fichier de stockage généré CÔTÉ SERVEUR (v1.4 -- avant v1.4,
 * généré côté navigateur, voir OLD-IMAGE-PROVENANCE.md/TRUST-BOUNDARY-
 * DESIGN.md pour la raison du déplacement) : jamais dérivé de
 * l'entrée utilisateur. `crypto.randomUUID()` est disponible
 * nativement dans le runtime Node du App Router (global `crypto`,
 * Node >= 19) exactement comme dans le navigateur -- aucune nouvelle
 * dépendance.
 */
export function randomFileName(ext: string): string {
  return `${crypto.randomUUID()}.${ext}`;
}

/**
 * Chemin de stockage déterministe et multi-tenant :
 * {restaurant_id}/{product_id}/{nom généré}. EXACTEMENT 3 segments --
 * contrat vérifié à l'identique côté SQL (apply_product_photo_
 * replacement) avant d'écrire quoi que ce soit en DB.
 */
export function objectPath(
  restaurantId: string,
  productId: string,
  fileName: string
): string {
  return `${restaurantId}/${productId}/${fileName}`;
}
