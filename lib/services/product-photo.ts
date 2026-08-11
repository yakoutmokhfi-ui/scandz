import { supabase } from "@/lib/supabase";
import { setProductPhoto } from "@/lib/services/dashboard";

/**
 * Photo produit — Supabase Storage (V67).
 *
 * Seul point du projet à parler au bucket "product-photos". Le nom de
 * fichier stocké n'est JAMAIS dérivé du nom fourni par l'utilisateur
 * (voir randomFileName) : élimine tout risque de collision ou de
 * chemin dangereux lié à un nom de fichier malveillant. Le type de
 * fichier n'est jamais déduit de l'extension ni seulement du
 * `file.type` annoncé par le navigateur : detectImageType lit les
 * premiers octets réels du fichier (signature binaire).
 */

const BUCKET = "product-photos";

/** Doit rester synchronisé avec `file_size_limit` dans migration-v67-product-photos.sql. */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

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

/**
 * Échec d'ajout/remplacement de photo (upload Storage OU RPC
 * set_product_photo). Le message technique d'origine reste
 * disponible via `cause` (pour un log/debug), mais n'est jamais celui
 * affiché à l'utilisateur : l'appelant (dashboard) affiche un message
 * traduit générique (mcPhotoUploadError) — corrigé après audit Work
 * (M-01), qui a relevé que e.message brut (Postgres/Storage, souvent
 * en anglais technique) fuitait jusqu'à l'UI.
 */
export class PhotoUploadError extends Error {
  constructor(cause: unknown) {
    super("Photo upload failed", { cause });
    this.name = "PhotoUploadError";
  }
}

/** Même principe que PhotoUploadError, pour la suppression (RPC set_product_photo(null)). */
export class PhotoRemoveError extends Error {
  constructor(cause: unknown) {
    super("Photo remove failed", { cause });
    this.name = "PhotoRemoveError";
  }
}

interface ImageSignature {
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  matches: (head: Uint8Array) => boolean;
}

// Doit rester synchronisé avec `allowed_mime_types` dans
// migration-v67-product-photos.sql.
const SIGNATURES: ImageSignature[] = [
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
 * si aucune signature connue ne correspond.
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
 * message générique, pour que l'appelant affiche le bon texte
 * traduit.
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
 * Nom de fichier de stockage : jamais dérivé de l'entrée utilisateur.
 * Un nom de fichier fourni par l'utilisateur ("../../etc", "a/b.jpg",
 * un nom déjà utilisé par un autre produit…) n'entre jamais dans le
 * chemin final.
 */
function randomFileName(ext: string): string {
  return `${crypto.randomUUID()}.${ext}`;
}

/**
 * Chemin de stockage déterministe et multi-tenant :
 * {restaurant_id}/{product_id}/{nom généré}. Les deux premiers
 * segments sont des UUID, jamais des slugs ni une entrée utilisateur
 * — aucune ambiguïté entre établissements, condition exploitée
 * directement par les policies storage.objects (migration-v67).
 */
function objectPath(
  restaurantId: string,
  productId: string,
  fileName: string
): string {
  return `${restaurantId}/${productId}/${fileName}`;
}

function publicPhotoUrl(path: string): string {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Chemin de stockage extrait d'une URL publique du bucket
 * product-photos, ou `null` si l'URL ne vient pas de ce bucket (ex.
 * anciennes photos statiques servies depuis /public/photos, jamais
 * uploadées par ce module) : dans ce cas il n'y a rien à supprimer
 * côté Storage, ce n'est pas une erreur.
 */
export function extractStoragePath(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  const marker = `/object/public/${BUCKET}/`;
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) return null;
  return imageUrl.slice(idx + marker.length);
}

/** Best-effort : un échec de suppression Storage ne doit jamais bloquer le flux utilisateur (fichier orphelin toléré, documenté). */
async function deleteStorageFileBestEffort(
  imageUrl: string | null
): Promise<void> {
  const path = extractStoragePath(imageUrl);
  if (!path) return;
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch {
    // Volontairement ignoré : voir commentaire ci-dessus.
  }
}

/**
 * Ajoute ou remplace la photo d'un produit. Ordre exact des
 * opérations (documenté dans le rapport de livraison) :
 *   1. upload du nouveau fichier vers un chemin neuf (jamais un
 *      remplacement en place) ;
 *   2. mise à jour de menu_items.image_url via la RPC
 *      set_product_photo (source de vérité) ;
 *   3. si (2) échoue : suppression best-effort du fichier tout juste
 *      uploadé (pas d'orphelin créé par une tentative ratée), l'ancienne
 *      photo reste référencée, PUIS l'erreur est relancée ;
 *   4. si (2) réussit : suppression best-effort de l'ANCIENNE photo,
 *      seulement après que la DB pointe déjà vers la nouvelle — la DB
 *      ne référence jamais un fichier supprimé.
 */
export async function addOrReplaceProductPhoto(
  restaurantId: string,
  productId: string,
  file: File,
  previousImageUrl: string | null
): Promise<string> {
  const { mime, ext } = await validateProductPhotoFile(file);
  const path = objectPath(restaurantId, productId, randomFileName(ext));

  // Le MIME envoyé à Storage est celui RÉELLEMENT détecté par
  // inspection binaire (validateProductPhotoFile), jamais file.type
  // (annoncé par le navigateur, non fiable — c'est précisément ce que
  // ce module refuse de faire confiance ailleurs).
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: mime, upsert: false });
  if (uploadError) throw new PhotoUploadError(uploadError);

  const newUrl = publicPhotoUrl(path);

  try {
    await setProductPhoto(productId, newUrl);
  } catch (e) {
    await deleteStorageFileBestEffort(newUrl);
    throw new PhotoUploadError(e);
  }

  if (previousImageUrl && previousImageUrl !== newUrl) {
    await deleteStorageFileBestEffort(previousImageUrl);
  }

  return newUrl;
}

/**
 * Supprime la photo d'un produit. Ordre exact : la DB est mise à jour
 * (image_url = null) AVANT toute suppression Storage — si la DB
 * échoue, rien n'est supprimé côté Storage et l'ancienne photo reste
 * intacte et référencée (aucun état où la DB pointerait vers un
 * fichier absent). Le menu public revient immédiatement au rendu
 * "sans photo" dès que la DB est mise à jour, indépendamment du
 * nettoyage Storage qui suit.
 */
export async function removeProductPhoto(
  productId: string,
  currentImageUrl: string | null
): Promise<void> {
  try {
    await setProductPhoto(productId, null);
  } catch (e) {
    throw new PhotoRemoveError(e);
  }
  await deleteStorageFileBestEffort(currentImageUrl);
}
