import { supabase } from "@/lib/supabase";
import { setRestaurantLogo, setRestaurantCover } from "@/lib/services/dashboard";

/**
 * Identité visuelle de l'établissement — logo & cover (V68), Supabase
 * Storage.
 *
 * Seul point du projet à parler au bucket "establishment-assets" —
 * DISTINCT de "product-photos" (lib/services/product-photo.ts), volontairement
 * non partagé (voir migration-v68-establishment-assets.sql). La
 * détection de type par signature binaire ci-dessous est dupliquée
 * depuis product-photo.ts (choix délibéré : chaque module reste
 * autonome, sans dépendance croisée entre les deux périmètres Storage,
 * et sans risque de régression sur le module V67 déjà audité et en
 * production).
 *
 * Le nom de fichier stocké n'est JAMAIS dérivé du nom fourni par
 * l'utilisateur : chaque upload obtient un nom neuf (crypto.randomUUID()),
 * donc une URL neuve — évite tout souci de cache lors d'un remplacement
 * et élimine tout risque de collision/chemin dangereux.
 */

const BUCKET = "establishment-assets";

export type EstablishmentAssetKind = "logo" | "cover";

/** Doit rester synchronisé avec `file_size_limit` dans migration-v68-establishment-assets.sql. */
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
 * Échec d'ajout/remplacement d'asset (upload Storage OU RPC
 * set_restaurant_logo/_cover). Le message technique d'origine reste
 * disponible via `cause` (log/debug) ; jamais affiché tel quel à
 * l'utilisateur (même principe que product-photo.ts après audit M-01) —
 * l'appelant (dashboard) affiche un message traduit générique.
 */
export class AssetUploadError extends Error {
  constructor(cause: unknown) {
    super("Establishment asset upload failed", { cause });
    this.name = "AssetUploadError";
  }
}

/** Même principe que AssetUploadError, pour la suppression. */
export class AssetRemoveError extends Error {
  constructor(cause: unknown) {
    super("Establishment asset remove failed", { cause });
    this.name = "AssetRemoveError";
  }
}

interface ImageSignature {
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  matches: (head: Uint8Array) => boolean;
}

// Doit rester synchronisé avec `allowed_mime_types` dans
// migration-v68-establishment-assets.sql.
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
 * message générique, pour que l'appelant affiche le bon texte traduit.
 * Exportée : utilisée aussi pour la validation immédiate côté UI
 * (aperçu local avant sauvegarde), avant tout appel réseau.
 */
export async function validateEstablishmentAssetFile(
  file: Pick<File, "slice" | "size">
): Promise<{ mime: string; ext: string }> {
  if (file.size > MAX_FILE_SIZE_BYTES) throw new FileTooLargeError();
  const detected = await detectImageType(file);
  if (!detected) throw new InvalidFileTypeError();
  return detected;
}

function randomFileName(ext: string): string {
  return `${crypto.randomUUID()}.${ext}`;
}

/**
 * Chemin de stockage : {restaurant_id}/{logo|cover}/{nom généré}. Le
 * premier segment (restaurant_id, UUID) est ce que vérifient les
 * policies storage.objects de establishment-assets.
 */
function objectPath(
  restaurantId: string,
  kind: EstablishmentAssetKind,
  fileName: string
): string {
  return `${restaurantId}/${kind}/${fileName}`;
}

function publicAssetUrl(path: string): string {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Chemin de stockage extrait d'une URL publique du bucket
 * establishment-assets, ou `null` si l'URL ne vient pas de ce bucket :
 * dans ce cas il n'y a rien à supprimer côté Storage, ce n'est pas une
 * erreur (ex. une éventuelle ancienne valeur non issue de ce module).
 */
export function extractStoragePath(assetUrl: string | null): string | null {
  if (!assetUrl) return null;
  const marker = `/object/public/${BUCKET}/`;
  const idx = assetUrl.indexOf(marker);
  if (idx === -1) return null;
  return assetUrl.slice(idx + marker.length);
}

/**
 * Best-effort : un échec de suppression Storage ne doit jamais bloquer
 * le flux utilisateur (fichier orphelin toléré, documenté).
 *
 * Correction (finding "fichiers Storage orphelins") : le client
 * Supabase NE LÈVE JAMAIS d'exception pour un échec Storage — il
 * renvoie `{ data, error }`, `error` étant simplement peuplé sans
 * jamais rejeter la promesse. Le `try/catch` seul ne détectait donc
 * RIEN de significatif (il n'aurait intercepté qu'une exception
 * réseau bas niveau, jamais une erreur API Storage normale) : un échec
 * réel restait invisible, y compris en développement. Corrigé en
 * inspectant explicitement `error`, et en le journalisant — le flux
 * utilisateur reste inchangé (best-effort, jamais bloquant), mais le
 * fichier orphelin potentiel devient au moins observable.
 */
async function deleteStorageFileBestEffort(
  assetUrl: string | null
): Promise<void> {
  const path = extractStoragePath(assetUrl);
  if (!path) return;
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) {
      console.error(`establishment-assets: orphan cleanup failed for "${path}" (fichier potentiellement orphelin) :`, error);
    }
  } catch (e) {
    console.error(`establishment-assets: orphan cleanup threw for "${path}" (fichier potentiellement orphelin) :`, e);
  }
}

async function persistAssetUrl(
  restaurantId: string,
  kind: EstablishmentAssetKind,
  url: string | null
): Promise<void> {
  if (kind === "logo") {
    await setRestaurantLogo(restaurantId, url);
  } else {
    await setRestaurantCover(restaurantId, url);
  }
}

/**
 * Ajoute ou remplace le logo ou le cover d'un établissement. Ordre
 * exact des opérations (même principe que product-photo.ts) :
 *   1. upload du nouveau fichier vers un chemin neuf (jamais un
 *      remplacement en place) ;
 *   2. mise à jour de restaurant_configs.logo_url/cover_url via la RPC
 *      dédiée (source de vérité) ;
 *   3. si (2) échoue : suppression best-effort du fichier tout juste
 *      uploadé (pas d'orphelin créé par une tentative ratée),
 *      l'ancienne valeur reste référencée, PUIS l'erreur est relancée ;
 *   4. si (2) réussit : suppression best-effort de l'ANCIEN fichier,
 *      seulement après que la DB pointe déjà vers le nouveau — la DB
 *      ne référence jamais un fichier supprimé.
 */
export async function addOrReplaceEstablishmentAsset(
  restaurantId: string,
  kind: EstablishmentAssetKind,
  file: File,
  previousUrl: string | null
): Promise<string> {
  const { mime, ext } = await validateEstablishmentAssetFile(file);
  const path = objectPath(restaurantId, kind, randomFileName(ext));

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: mime, upsert: false });
  if (uploadError) throw new AssetUploadError(uploadError);

  const newUrl = publicAssetUrl(path);

  try {
    await persistAssetUrl(restaurantId, kind, newUrl);
  } catch (e) {
    await deleteStorageFileBestEffort(newUrl);
    throw new AssetUploadError(e);
  }

  if (previousUrl && previousUrl !== newUrl) {
    await deleteStorageFileBestEffort(previousUrl);
  }

  return newUrl;
}

/**
 * Supprime le logo ou le cover d'un établissement. Ordre exact : la DB
 * est mise à jour (logo_url/cover_url = null) AVANT toute suppression
 * Storage — si la DB échoue, rien n'est supprimé côté Storage et
 * l'ancien fichier reste intact et référencé.
 */
export async function removeEstablishmentAsset(
  restaurantId: string,
  kind: EstablishmentAssetKind,
  currentUrl: string | null
): Promise<void> {
  try {
    await persistAssetUrl(restaurantId, kind, null);
  } catch (e) {
    throw new AssetRemoveError(e);
  }
  await deleteStorageFileBestEffort(currentUrl);
}
