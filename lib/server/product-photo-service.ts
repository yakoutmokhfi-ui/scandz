import "server-only";
import { createHash } from "node:crypto";
import { getServiceRoleSupabaseClient, getTrustedStorageOrigin } from "@/lib/server/supabase-admin";
import { asUserSupabaseClientFactory } from "@/lib/server/supabase-as-user";
import {
  validateProductPhotoFile,
  objectPath,
  randomFileName,
  InvalidFileTypeError,
  FileTooLargeError,
  type OldImageCleanupOutcome,
} from "@/lib/product-photo-contract";

/**
 * BULK PRODUCT PHOTOS v1.4/v1.5 — TRUSTED SERVER-SIDE REPLACEMENT.
 *
 * Ferme les 3 blockers + 2 findings MEDIUM du réaudit Cat Stevens sur
 * v1.3, PUIS (v1.5) les 2 blockers + 1 finding MEDIUM du réaudit
 * suivant sur v1.4 (voir CAT-STEVENS-FINDINGS-REMEDIATION.md/
 * TRUST-BOUNDARY-DESIGN.md pour l'analyse complète). Seul point du
 * projet, avec la route app/api/dashboard/catalogue/product-photo/
 * route.ts qui l'appelle, à orchestrer : (1) authentification du
 * demandeur (jeton transmis, jamais lu depuis une variable
 * d'environnement) ; (2) résolution AUTORITAIRE de restaurant_id +
 * IDENTITÉ VÉRIFIÉE de l'appelant (jamais transmises par le client --
 * begin_product_photo_replacement) ; (3) upload vers un chemin
 * ENTIÈREMENT généré ici, jamais choisi par le client ; (4) écriture
 * DB + capture/validation de l'ancienne image, verrouillée côté SQL
 * (apply_product_photo_replacement, appelée EN service_role depuis
 * v1.5 -- voir Blocker 1 v1.5 ci-dessous) ; (5) suppression physique
 * de l'ancienne image via l'API Storage réelle (jamais une suppression
 * directe de ligne storage.objects -- Blocker 2 v1.4), SEULEMENT si le
 * chemin ancien a été jugé sûr côté SQL (Blocker 2 v1.5).
 *
 * MODÈLE DE CLIENTS (v1.5, Cat Stevens Blocker 1 -- APPEL DIRECT
 * authenticated CONTOURNAIT LA ROUTE DE CONFIANCE) :
 *   - asUserSupabaseClientFactory.create(token) pour begin_
 *     UNIQUEMENT (auth.uid()/assert_product_role doivent résoudre
 *     l'appelant RÉEL -- lecture seule, aucune mutation, jamais le
 *     vecteur du Blocker 1 v1.5) ;
 *   - getServiceRoleSupabaseClient() pour apply_ (GRANT EXECUTE retiré
 *     à authenticated/anon/public côté SQL -- plus jamais exposée en
 *     REST à un porteur de jeton de session, quel qu'il soit ;
 *     l'identité de l'appelant, déjà vérifiée par begin_ ci-dessus,
 *     lui est transmise en PARAMÈTRE EXPLICITE, p_caller_user_id,
 *     jamais via auth.uid() qui n'est plus un signal de confiance une
 *     fois appelée en service_role) ET pour TOUTE opération Storage
 *     physique (upload, remove) -- la clé service_role ne quitte
 *     jamais ce module serveur (voir supabase-admin.ts).
 *
 * COMPENSATION EXPLICITE (Storage et PostgreSQL ne partagent AUCUNE
 * transaction ACID commune -- voir FAILURE-COMPENSATION-MATRIX.md
 * pour l'audit complet des scénarios A-F) :
 *   A. upload échoue                    -> DB inchangée, rien à nettoyer.
 *   B. upload réussit, apply_ échoue    -> le nouvel upload orphelin
 *      est supprimé ici, best-effort (échec de CETTE suppression
 *      compensatoire n'est pas remonté comme échec de l'opération
 *      globale -- déjà un état seulement dégradé en coût de stockage,
 *      jamais un état incohérent en DB, puisque apply_ elle-même a
 *      échoué -- aucune ligne DB ne référence ce fichier).
 *   C. apply_ réussit, suppression de l'ancienne image échoue -> la
 *      nouvelle valeur DB reste AUTORITAIRE (aucun rollback vers un
 *      chemin choisi par le client), l'échec de nettoyage est
 *      surfacé via `oldImageCleanup: "failed"` dans le résultat --
 *      jamais silencieux, jamais bloquant pour l'utilisateur.
 *   D. ancienne image déjà absente     -> `.remove()` sur un chemin
 *      inexistant est un no-op côté Storage -- comportement
 *      déterministe et sûr, aucune branche spéciale nécessaire.
 *   E. ancienne valeur DB non sûre (NOUVEAU v1.5, Blocker 2) -> SQL
 *      renvoie old_path=NULL, old_path_cleanup_skipped=true ; ce
 *      module NE TENTE JAMAIS `.remove()` pour ce cas -- surfacé via
 *      `oldImageCleanup: "skipped_unsafe_legacy"`, jamais silencieux.
 *   F. interruption serveur après COMMIT DB, avant suppression
 *      Storage -- orphelin toléré (coût de stockage uniquement,
 *      jamais une faille de sécurité ni un état DB incohérent),
 *      cohérent avec la philosophie déjà documentée de ce module
 *      avant v1.4 -- aucun balayage de nettoyage en arrière-plan
 *      ajouté (hors périmètre du plus petit changement sûr).
 *
 * v1.6 (Cat Stevens, réaudit de v1.5) :
 *   Blocker 1 -- l'ORIGINE de l'ancienne URL Storage lue en DB n'était
 *     jamais vérifiée (SQL ne faisait qu'une recherche de sous-chaîne
 *     du marqueur Storage). Fermé côté SQL
 *     (_product_photo_path_segments -- vérification ANCRÉE,
 *     `starts_with`, jamais `position()`) ; ce module transmet
 *     désormais explicitement `p_expected_origin` (via
 *     `getTrustedStorageOrigin()`, calculée UNIQUEMENT côté serveur à
 *     partir de NEXT_PUBLIC_SUPABASE_URL, JAMAIS une valeur cliente)
 *     à CHAQUE appel `apply_product_photo_replacement` -- voir
 *     TRUSTED-STORAGE-ORIGIN-CONTRACT.md.
 *   MEDIUM -- l'échec de nettoyage (scénario C ci-dessus) n'était pas
 *     ré-essayable sans rejouer tout le remplacement. Fermé (v1.6) par
 *     `retryOldImageCleanup` ci-dessous -- validation SQL pure
 *     (`retry_product_photo_cleanup_path`, AUCUNE mutation), puis
 *     SEULEMENT Storage `.remove()` réel -- ne rejoue JAMAIS
 *     `apply_product_photo_replacement`, ne re-uploade/ne réapplique
 *     JAMAIS la nouvelle image déjà réussie. Voir CLEANUP-RETRY-DESIGN.md.
 *
 * v1.7 (Cat Stevens, réaudit de v1.6 -- SEUL blocker restant, RELEASE-
 * BLOCKING) : `retry_product_photo_cleanup_path` (v1.6) acceptait un
 * `oldPath` FOURNI PAR LE NAVIGATEUR -- même intégralement revalidé
 * côté SQL (restaurant/produit/UUID v4/distinct de l'image en cours),
 * RIEN ne prouvait que ce chemin correspondait à un échec de nettoyage
 * RÉELLEMENT produit par le flux de remplacement de confiance. FERMÉ en
 * remplaçant ENTIÈREMENT `retry_product_photo_cleanup_path` (SUPPRIMÉE,
 * jamais recréée) par un mécanisme d'ÉTAT DURABLE côté serveur --
 * `create_product_photo_pending_cleanup` (service_role), appelée
 * UNIQUEMENT par `cleanupOldImage` ci-dessous, UNIQUEMENT après un échec
 * RÉEL de `admin.storage.remove()` sur un `old_path` qui vient LUI-MÊME
 * d'être validé par `apply_product_photo_replacement`, renvoie un
 * `cleanup_id` (uuid) OPAQUE -- SEULE valeur, JAMAIS `old_path`, qui
 * atteint le navigateur.
 *
 * v1.8 (Cat Stevens, réaudit de v1.7 -- SEUL blocker restant, RELEASE-
 * BLOCKING) : `claim_product_photo_pending_cleanup` (v1.7) marquait une
 * ligne 'completed' de façon ATOMIQUE côté SQL, mais TOUJOURS AVANT
 * l'appel `admin.storage.remove()` réel côté Node (Storage n'étant
 * jamais transactionnel avec PostgreSQL). Si cette suppression Storage
 * échouait ENSUITE : un crash serveur survenu entre le claim et l'appel
 * `reopen_product_photo_pending_cleanup` (v1.7) laissait la ligne
 * 'completed' à jamais SANS qu'aucune suppression physique n'ait eu
 * lieu ; un échec/rejet de `reopen_` elle-même était avalé par un simple
 * `catch { }` ; et un résultat Supabase `{ error }` NORMAL (sans
 * exception JS) renvoyé par `reopen_` n'était JAMAIS vérifié -- le code
 * appelait `await admin.rpc(...)` sans jamais inspecter `.error`. FERMÉ
 * en remplaçant la machine à 2 états (pending/completed) par une
 * machine à 3 états, avec bail (lease) à expiration automatique :
 *   - `claim_product_photo_pending_cleanup` (RÉÉCRITE v1.8) -- ne
 *     transitionne PLUS JAMAIS vers 'completed'. Transitionne
 *     UNIQUEMENT vers 'processing' (depuis 'pending', OU depuis
 *     'processing' si le bail précédent a expiré -- récupération
 *     AUTOMATIQUE d'un claim abandonné, aucun appel explicite requis).
 *     Renvoie `{ old_path, claim_token }` -- `claim_token` est un
 *     second secret OPAQUE, SERVEUR UNIQUEMENT (JAMAIS sérialisé dans
 *     une réponse HTTP, JAMAIS transmis au navigateur -- voir
 *     `RetryOldImageCleanupResult` ci-dessous, qui ne l'expose jamais),
 *     requis par `finalize_`/`release_` pour prouver qu'ils agissent
 *     sur LA MÊME tentative de claim qui l'a obtenu.
 *   - `finalize_product_photo_pending_cleanup` (NOUVELLE, service_role)
 *     -- appelée EXCLUSIVEMENT après le succès RÉEL et CONFIRMÉ de
 *     `admin.storage.remove()`. SEULE fonction qui transitionne vers
 *     'completed'. Node vérifie EXPLICITEMENT les DEUX formes d'échec
 *     (exception JS levée par le SDK ET résultat `{ error }` normal
 *     Supabase) -- aucune n'est plus jamais ignorée.
 *   - `release_product_photo_pending_cleanup` (REMPLACE `reopen_`,
 *     service_role) -- appelée si `admin.storage.remove()` échoue,
 *     ramène IMMÉDIATEMENT la ligne à 'pending' pour un retry sans
 *     attendre. NON-BLOQUANT PAR CONCEPTION (mandat : "no reopen-or-die
 *     design") : que cet appel réussisse, lève une exception, ou
 *     renvoie `{ error }` (les deux formes sont vérifiées, jamais
 *     ignorées), la ligne redevient de toute façon réclamable
 *     AUTOMATIQUEMENT dès l'expiration de son bail -- la durabilité du
 *     retry ne dépend JAMAIS du succès de cet appel, uniquement du bail
 *     déjà posé par `claim_`.
 * `retryOldImageCleanup` ne rejoue TOUJOURS JAMAIS
 * `apply_product_photo_replacement` (invariant BULK RETRY, inchangé
 * depuis v1.6). Voir CLEANUP-STATE-MACHINE.md/CLEANUP-LEASE-RECOVERY.md
 * pour l'analyse complète.
 *
 * v2.2.1 (Cat Stevens, réaudit final de v2.2 -- SEUL blocker restant,
 * tout le reste PASS, NON REDESIGNÉ) : la détection de conflit d'un
 * retry v2.2 s'appuyait sur `current_image_url` lue par begin_
 * (AS-USER, AVANT tout upload -- donc AVANT toute tentative
 * d'acquisition du verrou de ligne autoritaire par apply_) -- une
 * modification manuelle légitime (Single Photo Edit) pouvait
 * s'intercaler ENTRE cette lecture et l'obtention ultérieure du verrou,
 * et un retry Bulk indéterminé écrasait alors SANS CONDITION la photo
 * installée entre-temps. UNLOCKED RETRY CHECK: YES -> NO (fermé ici).
 * FERMÉ en déplaçant la décision ENTIÈREMENT dans
 * apply_product_photo_replacement, SOUS le verrou `for update` déjà
 * existant (nouveau paramètre additif `p_is_retry`, voir
 * DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql, ADDENDUM
 * v2.2.1) -- ce module n'utilise plus JAMAIS `current_image_url` pour
 * une décision de rejeu/conflit, et n'envoie plus jamais
 * `expectedPriorImageUrl` (RETIRÉ -- remplacé par un simple booléen
 * `isRetry`, la comparaison elle-même n'a plus besoin d'aucune valeur
 * "attendue" transmise par le client : SEULE la cible déterministe de
 * CETTE opération, déjà un paramètre existant, compte). Modèle
 * strictement BINAIRE pour toute relecture (remplace le modèle à 3 cas
 * A/B/C de v2.2) : ALREADY_APPLIED ou CONFLICT, jamais un troisième
 * cas "continue sous incertitude". Voir replaceProductPhoto ci-dessous
 * pour le nouveau flux complet.
 */

const BUCKET = "product-photos";

export type ProductPhotoServerErrorReason =
  | "config"
  | "auth"
  | "forbidden"
  | "not_found"
  | "invalid_file"
  | "invalid_request"
  | "unavailable"
  /**
   * NOUVEAU v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, SAFE
   * RETRY), mécanisme de détection RÉÉCRIT en v2.2.1 (SOLE BLOCKER
   * FIX). Une opération Bulk (`batchId` fourni) marquée comme retry
   * (`isRetry: true`) a trouvé, SOUS LE VERROU DE LIGNE AUTORITAIRE
   * (voir apply_product_photo_replacement, ADDENDUM v2.2.1), l'image
   * actuellement autoritaire DIFFÉRENTE de la cible déterministe de
   * CETTE opération (ce ne serait pas "conflict", ce serait
   * "already_applied") -- un autre changement de photo légitime a eu
   * lieu entre-temps (édition manuelle, ou une autre opération).
   * Jamais transmise à l'upload/à l'écriture DB -- voir
   * replaceProductPhoto. N'affecte JAMAIS la toute première tentative
   * d'un lot (`isRetry: false`) ni Single Photo Edit (qui n'envoie
   * jamais `batchId`).
   */
  | "conflict";

/**
 * Erreur serveur dédiée -- ne fuite JAMAIS le message SQL/Storage brut
 * au client (même posture que InvoiceRequestServerError/
 * PaymentServerRpcError). `reason` est une classification INTERNE,
 * traduite par la route HTTP appelante en un code de statut/une
 * réponse générique -- jamais sérialisée telle quelle.
 */
export class ProductPhotoServerError extends Error {
  readonly reason: ProductPhotoServerErrorReason;

  constructor(reason: ProductPhotoServerErrorReason, cause?: unknown) {
    super(`ProductPhotoServerError: ${reason}`, cause !== undefined ? { cause } : undefined);
    this.name = "ProductPhotoServerError";
    this.reason = reason;
  }
}

/** Classifie une erreur RPC (begin_/apply_) par SQLSTATE -- jamais par le message brut. */
function reasonFromSqlState(sqlState: string | null | undefined): ProductPhotoServerErrorReason {
  switch (sqlState) {
    case "28000":
      return "auth";
    case "42501":
      return "forbidden";
    case "P0002":
      return "not_found";
    case "22023":
      return "invalid_request";
    /**
     * NOUVEAU v2.2.1 -- levée par apply_product_photo_replacement
     * UNIQUEMENT quand `p_is_retry=true` et que l'image actuellement
     * autoritaire, SOUS VERROU, ne correspond PAS à la cible
     * déterministe de cette opération Bulk (voir ADDENDUM v2.2.1,
     * DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql).
     * Précédent de code réutilisé -- déjà utilisé pour des scénarios
     * analogues de conflit de claim/bail ailleurs dans ce dépôt (voir
     * DRAFT-lot-payment-p3b-monetico-checkout-runtime-v46-forward.sql
     * et DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql).
     */
    case "P0004":
      return "conflict";
    default:
      return "unavailable";
  }
}

export type { OldImageCleanupOutcome };

export interface ReplaceProductPhotoInput {
  /** Jeton d'accès BRUT de l'appelant HTTP -- jamais lu depuis l'environnement. */
  accessToken: string;
  productId: string;
  /** `File`/`Blob` du runtime Node (Next.js `request.formData()`). */
  file: Pick<File, "slice" | "size" | "arrayBuffer">;
  /**
   * NOUVEAU v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, SEUL
   * blocker technique restant : "LOST HTTP RESPONSE / SUCCESSFUL
   * REPLAY"). Identifiant OPAQUE d'un LOT Bulk -- généré UNE SEULE
   * FOIS par lot par l'appelant (BulkPhotoUpload.tsx), RÉUTILISÉ tel
   * quel pour CHAQUE produit du lot et pour TOUT retry. `undefined`
   * pour Single Photo Edit (lib/services/product-photo.ts ne le
   * transmet jamais) -- comportement byte pour byte inchangé : chemin
   * final ALÉATOIRE (`randomFileName`), aucune vérification de rejeu.
   * Quand fourni, combiné à restaurant_id/product_id (résolus
   * AUTORITAIREMENT ici, jamais transmis par le client -- voir
   * "CROSS-PRODUCT KEY ISSUE" du mandat : ce triplet, JAMAIS `batchId`
   * seul, forme l'identité logique de l'opération) pour dériver un
   * chemin Storage DÉTERMINISTE (`deterministicBulkFileName`
   * ci-dessous) -- voir replaceProductPhoto pour le mécanisme complet.
   */
  batchId?: string;
  /**
   * NOUVEAU v2.2.1 -- REMPLACE `expectedPriorImageUrl` (v2.2, RETIRÉ).
   * N'a de sens QUE lorsque `batchId` est fourni. `false`/`undefined`
   * (défaut) signifie "premier Apply de ce batchId×productId" --
   * remplacement de masse normal, INCONDITIONNEL, AUCUNE comparaison
   * (mandat "FIRST BULK APPLY... no expected-image compare-and-set
   * required"). `true` signifie "ceci est un RETRY" -- la décision
   * (ALREADY_APPLIED / CONFLICT) est alors prise ENTIÈREMENT côté SQL,
   * SOUS le verrou de ligne autoritaire (`apply_product_photo_
   * replacement`, `p_is_retry: true`) -- ce module ne transmet plus
   * AUCUNE valeur "image attendue" : seule la cible déterministe de
   * cette opération (déjà calculée, voir replaceProductPhoto) est
   * comparée, à l'intérieur de la RPC, à l'image RÉELLEMENT
   * autoritaire au moment du verrou -- fermant l'ancienne fenêtre de
   * course d'une lecture Node non verrouillée (voir en-tête de
   * fichier, SOLE BLOCKER v2.2.1). Ignoré (traité comme `false`) si
   * `batchId` est absent -- Single Photo Edit n'envoie jamais ce champ.
   */
  isRetry?: boolean;
}

export interface ReplaceProductPhotoResult {
  imageUrl: string;
  oldImageCleanup: OldImageCleanupOutcome;
  /**
   * NOUVEAU v1.7 (REMPLACE `oldPath`, v1.6 -- SEUL blocker fermé par ce
   * lot). Identifiant OPAQUE (uuid) d'une ligne
   * `product_photo_pending_cleanups`, créée UNIQUEMENT lorsque
   * `oldImageCleanup === "failed"` (échec RÉEL de Storage `.remove()`
   * sur un `old_path` déjà validé par apply_ -- voir `cleanupOldImage`
   * ci-dessous). `null` dans tous les autres cas ("removed",
   * "not_applicable", "skipped_unsafe_legacy"). CE `cleanup_id`, JAMAIS
   * `old_path` lui-même, est la SEULE chose que le navigateur reçoit et
   * peut retransmettre -- il n'accorde AUCUNE autorisation en
   * lui-même : `retryOldImageCleanup` revalide intégralement le
   * chemin stocké côté serveur (restaurant/produit/forme EXACTE) avant
   * tout Storage `.remove()`, exactement comme si le client n'avait
   * jamais rien transmis.
   */
  cleanupId: string | null;
  /**
   * NOUVEAU v2.2 -- `true` UNIQUEMENT quand cette opération Bulk
   * (`batchId` fourni) a été reconnue, AVANT tout upload, comme un
   * REJEU d'une opération déjà appliquée avec succès pour ce
   * batchId×restaurant_id×product_id (l'image actuellement
   * autoritaire égale déjà l'image déterministe de CETTE opération) --
   * ZÉRO upload, ZÉRO mutation DB supplémentaire n'a eu lieu. Toujours
   * `false` pour Single Photo Edit (`batchId` absent) et pour la toute
   * première tentative réussie d'une opération Bulk.
   */
  alreadyApplied: boolean;
}

export interface RemoveProductPhotoInput {
  accessToken: string;
  productId: string;
}

export interface RemoveProductPhotoResult {
  oldImageCleanup: OldImageCleanupOutcome;
  /** NOUVEAU v1.7 -- voir ReplaceProductPhotoResult.cleanupId ci-dessus. */
  cleanupId: string | null;
}

/**
 * v1.6 (MEDIUM cleanup retry) -- retentait UNIQUEMENT le nettoyage
 * Storage de l'ancienne image, SANS JAMAIS rejouer replaceProductPhoto/
 * apply_product_photo_replacement. RÉÉCRITE v1.7 (Cat Stevens, SEUL
 * blocker de v1.6 -- TRUST BOUNDARY) pour ne plus jamais accepter de
 * CHEMIN depuis le client : `cleanupId` est un identifiant OPAQUE
 * (uuid) -- EXACTEMENT la valeur `cleanupId` déjà renvoyée UNE FOIS par
 * un appel replaceProductPhoto/removeProductPhoto antérieur (jamais un
 * chemin, jamais une URL). N'appelle TOUJOURS JAMAIS
 * apply_product_photo_replacement (donc sans jamais re-uploader/
 * réappliquer la nouvelle image déjà réussie) -- le chemin réellement
 * supprimé est résolu et revalidé intégralement côté serveur
 * (claim_product_photo_pending_cleanup) à partir de l'ÉTAT DURABLE,
 * jamais depuis ce paramètre lui-même au-delà de son rôle de clé de
 * recherche opaque.
 */
export interface RetryOldImageCleanupInput {
  accessToken: string;
  productId: string;
  cleanupId: string;
}

export interface RetryOldImageCleanupResult {
  oldImageCleanup: OldImageCleanupOutcome;
}

interface BeginRow {
  restaurant_id: string;
  caller_user_id: string;
  /** NOUVEAU v1.6 -- valeur AUTORITAIRE actuelle, sert exclusivement à retryOldImageCleanup. */
  current_image_url: string | null;
}

interface ApplyRow {
  old_path: string | null;
  image_url: string | null;
  old_path_cleanup_skipped: boolean;
  /**
   * NOUVEAU v2.2.1 -- `true` UNIQUEMENT pour une réponse de retry
   * (`p_is_retry: true`) reconnue, SOUS VERROU, comme un rejeu d'une
   * opération déjà appliquée avec succès -- voir ADDENDUM v2.2.1,
   * DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql.
   * Toujours `false` pour un premier Apply (Bulk ou Single Photo
   * Edit) -- ce chemin ne lève/ne renvoie jamais already_applied=true.
   */
  already_applied: boolean;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  return (data as T) ?? null;
}

/**
 * NOUVEAU v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, LOST HTTP
 * RESPONSE / SUCCESSFUL REPLAY). Dérive un nom de fichier DÉTERMINISTE
 * -- même (restaurantId, productId, batchId) produit TOUJOURS le même
 * nom -- à partir d'un hash SHA-256, mais dont la FORME reste celle
 * d'un UUID v4 (voir CRYPTO_RANDOM_UUID_V4_FILENAME_RE,
 * lib/product-photo-contract.ts) : cette forme est celle validée par
 * `_product_photo_relative_path_shape` côté SQL (INCHANGÉE par ce
 * lot) -- rien n'exige que le nom vienne réellement de
 * `crypto.randomUUID()`, seulement qu'il ait cette forme exacte
 * (minuscules, version='4', variante RFC4122). PAS un UUID -- un hash
 * mis en forme UUID -- jamais utilisé comme source d'aléa ni comme
 * secret : la sécurité de ce chemin repose entièrement sur le fait que
 * SEUL ce module serveur (service_role) peut jamais écrire dans ce
 * bucket (RLS `using(false)/with check(false)` pour tout client, voir
 * migration V67) -- la prévisibilité du chemin n'ouvre donc AUCUNE
 * nouvelle capacité d'écriture non autorisée.
 *
 * "CROSS-PRODUCT KEY ISSUE" (mandat) : `restaurantId`/`productId` sont
 * TOUJOURS résolus AUTORITAIREMENT par `begin_product_photo_replacement`
 * avant cet appel, JAMAIS transmis par le client -- réutiliser le même
 * `batchId` pour un AUTRE produit ou depuis un AUTRE restaurant produit
 * donc STRUCTURELLEMENT un hash (donc un chemin, donc une identité
 * logique) différent. `batchId` seul n'est JAMAIS l'identité -- voir
 * DETERMINISTIC-BULK-PATH-IDEMPOTENCY.md.
 */
function deterministicBulkFileName(
  restaurantId: string,
  productId: string,
  batchId: string,
  ext: string
): string {
  const material = `scanym-bulk-photo-v1:${restaurantId}:${productId}:${batchId}`;
  const digest = createHash("sha256").update(material, "utf8").digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16) as Uint8Array;
  // Force la forme RFC4122 v4 (compat régex SQL/JS) -- PAS un UUID
  // aléatoire, un hash déterministe simplement mis en forme identique.
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // nibble de version = '4'
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // bits de variante RFC4122 (8,9,a,b)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const uuidLike = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return `${uuidLike}.${ext}`;
}

/**
 * Résout old_path/old_path_cleanup_skipped renvoyés par apply_ en un
 * OldImageCleanupOutcome +, NOUVEAU v1.7, un cleanupId OPAQUE
 * exploitable pour un retry ultérieur. Factorisé -- utilisé par
 * replaceProductPhoto ET removeProductPhoto, jamais dupliqué.
 *
 * v1.7 -- quand la suppression Storage RÉELLE échoue (scénario C, voir
 * en-tête de fichier), ce module crée désormais lui-même une AUTORITÉ
 * DE NETTOYAGE DURABLE (create_product_photo_pending_cleanup,
 * service_role) à partir du old_path DÉJÀ validé par apply_ à
 * l'instant -- JAMAIS une valeur cliente, JAMAIS un chemin reconstruit
 * ici. C'est le cleanup_id (uuid) OPAQUE ainsi obtenu, et LUI SEUL, qui
 * remonte jusqu'au navigateur.
 */
async function cleanupOldImage(
  admin: ReturnType<typeof getServiceRoleSupabaseClient>,
  applyRow: ApplyRow,
  ctx: { callerUserId: string; productId: string }
): Promise<{ outcome: OldImageCleanupOutcome; cleanupId: string | null }> {
  // NOUVEAU v1.5 (Blocker 2) : une ancienne valeur DB jugée non sûre
  // (ne correspondant pas exactement au contrat de chemin de
  // confiance) n'est JAMAIS transmise à Storage .remove() -- SQL l'a
  // déjà exclue de old_path, ce module respecte cette décision sans
  // jamais la recalculer ni la contourner.
  if (applyRow.old_path_cleanup_skipped) {
    return { outcome: "skipped_unsafe_legacy", cleanupId: null };
  }
  if (!applyRow.old_path) {
    return { outcome: "not_applicable", cleanupId: null };
  }
  const { error: removeError } = await admin.storage.from(BUCKET).remove([applyRow.old_path]);
  if (!removeError) {
    return { outcome: "removed", cleanupId: null };
  }

  // NOUVEAU v1.7 -- échec RÉEL de Storage .remove() : crée l'autorité
  // de nettoyage durable, UNIQUEMENT à partir de applyRow.old_path
  // (déjà revalidé côté SQL par apply_ lui-même). Un échec de CETTE
  // création (dégradation supplémentaire, jamais observée en pratique
  // -- le chemin vient d'être validé à l'instant) laisse le cleanup
  // "failed" sans cleanup_id exploitable -- jamais un état incohérent,
  // seulement une capacité de retry dégradée (un nouveau remplacement
  // complet resterait possible).
  const { data: cleanupId, error: createError } = await admin.rpc(
    "create_product_photo_pending_cleanup",
    {
      p_caller_user_id: ctx.callerUserId,
      p_product_id: ctx.productId,
      p_old_path: applyRow.old_path,
      p_expected_origin: getTrustedStorageOrigin(),
    }
  );
  return {
    outcome: "failed",
    cleanupId: createError ? null : ((cleanupId as string | null) ?? null),
  };
}

/**
 * Résout restaurant_id + l'identité VÉRIFIÉE de l'appelant, via le
 * SEUL appel AS-USER restant de ce flux -- begin_product_photo_
 * replacement (lecture seule, authentification + rôle + existence +
 * appartenance + statut actif). Commun aux deux opérations
 * (remplacement ET suppression) depuis v1.5 : la suppression a
 * désormais elle aussi besoin de caller_user_id pour appeler apply_ en
 * service_role (voir Blocker 1 v1.5, en-tête de fichier) -- avant
 * v1.5, la suppression appelait apply_ directement en AS-USER et
 * n'avait pas besoin de cette étape ; ce n'est plus le cas.
 */
async function beginReplacement(
  asUser: ReturnType<typeof asUserSupabaseClientFactory.create>,
  productId: string
): Promise<BeginRow> {
  const { data, error } = await asUser.rpc("begin_product_photo_replacement", {
    p_product_id: productId,
  });
  if (error) {
    throw new ProductPhotoServerError(reasonFromSqlState(error.code ?? null), error);
  }
  const row = firstRow<BeginRow>(data);
  if (!row?.restaurant_id || !row?.caller_user_id) {
    throw new ProductPhotoServerError("unavailable", data);
  }
  return row;
}

/**
 * Remplace (ou pose pour la première fois) la photo d'un produit.
 * Ordre EXACT des opérations, jamais réordonné (voir en-tête de
 * fichier pour la justification de chaque étape) :
 *   1. begin_product_photo_replacement -- authentification + rôle +
 *      existence + appartenance + statut actif, restaurant_id +
 *      caller_user_id + image ACTUELLEMENT autoritaire résolus
 *      AUTORITAIREMENT (AS-USER -- le seul appel de ce flux qui l'est
 *      encore, v1.5) ;
 *   2. validation du fichier (octets réels, jamais l'extension/
 *      file.type) ;
 *   3. génération du chemin final -- ENTIÈREMENT ici, jamais transmis
 *      par le client (v2.2 : DÉTERMINISTE quand `input.batchId` est
 *      fourni, ALÉATOIRE sinon -- inchangé pour Single Photo Edit) ;
 *   3bis. NOUVEAU v2.2 -- UNIQUEMENT si `input.batchId` est fourni,
 *      AVANT tout upload : reconnaissance de rejeu / détection de
 *      conflit (voir ci-dessous, "LOST HTTP RESPONSE / SUCCESSFUL
 *      REPLAY") ;
 *   4. upload via l'API Storage réelle (service_role) ;
 *   5. apply_product_photo_replacement -- appelée EN service_role
 *      (v1.5, Blocker 1 : plus jamais exposée en REST à authenticated),
 *      p_caller_user_id transmis explicitement (résolu à l'étape 1,
 *      jamais recalculé ni fait confiance autrement) -- revalide
 *      l'autorisation DE NOUVEAU (assert_product_role_for), verrouille,
 *      capture ET REVALIDE l'ancienne valeur (v1.5, Blocker 2), écrit
 *      la nouvelle, DE FAÇON ATOMIQUE côté SQL ;
 *   6. suppression physique de l'ancienne image (API Storage réelle),
 *      SEULEMENT après le succès de l'étape 5, SEULEMENT si SQL l'a
 *      jugée sûre (jamais si old_path_cleanup_skipped -- v1.5).
 *
 * NOUVEAU v2.2.1 (SOLE BLOCKER FIX -- remplace le mécanisme de
 * décision v2.2, qui comparait `current_image_url` lue par begin_
 * AVANT tout verrou -- voir en-tête de fichier) :
 *   - le chemin/l'image DÉTERMINISTE de CETTE opération
 *     (batchId×restaurant_id×product_id, voir
 *     `deterministicBulkFileName` ci-dessus) est calculé AVANT tout
 *     upload ET AVANT tout appel RPC (getPublicUrl est une
 *     construction d'URL PURE, aucun I/O réseau) -- IDENTIQUE pour un
 *     premier Apply et pour un retry (mandat, ordre 1 : "identify
 *     deterministic target") ;
 *   - `input.isRetry` FAUX (premier Apply, Bulk ou Single Photo Edit) :
 *     comportement INCHANGÉ -- upload puis apply_ (p_is_retry omis,
 *     défaut false), remplacement DE MASSE inconditionnel pour Bulk
 *     (mandat "FIRST BULK APPLY... no expected-image compare-and-set
 *     required"), AUCUNE comparaison ;
 *   - `input.isRetry` VRAI : ZÉRO upload -- ce module entre
 *     DIRECTEMENT dans apply_product_photo_replacement
 *     (`p_is_retry: true`, mandat ordre 2 : "enter trusted server/RPC
 *     path"). La RPC acquiert le verrou de ligne autoritaire (ordre 3),
 *     PUIS SEULEMENT ALORS compare l'image actuellement autoritaire à
 *     la cible déterministe transmise (ordre 4) -- AUCUNE lecture Node
 *     non verrouillée n'intervient plus dans cette décision, fermant
 *     exactement la fenêtre de course du SOLE BLOCKER v2.2.1.
 *     Renvoie ALREADY_APPLIED (`already_applied: true`, succès, ZÉRO
 *     mutation) ou lève CONFLICT (SQLSTATE 'P0004', ZÉRO mutation --
 *     jamais un troisième cas, jamais une tentative d'inférer que la
 *     première requête a "probablement" échoué) -- ordre 5. AUCUNE
 *     mutation n'est jamais tentée par ce module pour une relecture
 *     (ordre 6, non applicable ici).
 *   - invariant préservé, SANS CONDITION, pour toute relecture,
 *     y compris exactement le scénario de course mandaté : SECOND
 *     UPLOAD: NO (aucun appel Storage ne précède JAMAIS la décision
 *     verrouillée -- ce module n'appelle `admin.storage.upload` que
 *     dans la branche `!isRetry` ci-dessous).
 *   - l'upload (branche `!isRetry` uniquement) utilise `upsert: true`
 *     UNIQUEMENT pour un chemin déterministe (`isBulk`) -- un chemin
 *     ALÉATOIRE (Single Photo Edit) garde `upsert: false`, INCHANGÉ.
 * Voir DETERMINISTIC-BULK-PATH-IDEMPOTENCY.md pour l'analyse v2.2
 * d'origine et RACE-CONDITION-FIX-v2.2.1.md (paquet v2.2.1) pour
 * l'analyse complète du correctif et les 3 scénarios mandatés (RACE,
 * ALREADY-APPLIED, FIRST-APPLY-REGRESSION).
 */
export async function replaceProductPhoto(
  input: ReplaceProductPhotoInput
): Promise<ReplaceProductPhotoResult> {
  const asUser = asUserSupabaseClientFactory.create(input.accessToken);
  const admin = getServiceRoleSupabaseClient();

  // 1. Résolution autoritaire de restaurant_id + identité VÉRIFIÉE de
  // l'appelant + toutes les validations d'autorisation/existence/
  // appartenance/statut actif. v2.2.1 -- `current_image_url` (renvoyée
  // par cette RPC) N'EST PLUS JAMAIS lue/utilisée ici pour une décision
  // de rejeu/conflit : c'était exactement la lecture NON VERROUILLÉE à
  // l'origine du SOLE BLOCKER v2.2.1 (voir en-tête de fichier). Cette
  // décision est désormais prise EXCLUSIVEMENT dans
  // apply_product_photo_replacement, SOUS le verrou de ligne (étape
  // 3bis ci-dessous).
  const { restaurant_id: restaurantId, caller_user_id: callerUserId } = await beginReplacement(
    asUser,
    input.productId
  );

  // 2. Validation AUTORITAIRE du fichier -- octets réels, jamais
  // l'extension ni file.type annoncé par le navigateur.
  let mime: string, ext: string;
  try {
    ({ mime, ext } = await validateProductPhotoFile(input.file));
  } catch (e) {
    if (e instanceof FileTooLargeError) throw new ProductPhotoServerError("invalid_file", e);
    if (e instanceof InvalidFileTypeError) throw new ProductPhotoServerError("invalid_file", e);
    throw new ProductPhotoServerError("invalid_file", e);
  }

  // 3. Chemin final -- restaurant_id (résolu ci-dessus, AUTORITAIRE) +
  // product_id (paramètre déjà authentifié/autorisé par begin_) + nom
  // DÉTERMINISTE (`input.batchId` fourni -- opération Bulk, premier
  // Apply ET retry utilisent EXACTEMENT le même calcul) ou ALÉATOIRE
  // (crypto.randomUUID(), Single Photo Edit -- INCHANGÉ), jamais
  // transmis par le client dans les deux cas.
  const isBulk = !!input.batchId;
  const isRetry = isBulk && input.isRetry === true;
  const fileName = isBulk
    ? deterministicBulkFileName(restaurantId, input.productId, input.batchId as string, ext)
    : randomFileName(ext);
  const path = objectPath(restaurantId, input.productId, fileName);

  // getPublicUrl est une construction d'URL PURE (aucun I/O réseau,
  // aucune vérification d'existence) -- sûr à appeler AVANT l'upload.
  const { data: publicUrlData } = admin.storage.from(BUCKET).getPublicUrl(path);
  const newImageUrl = publicUrlData.publicUrl;

  // 3bis. NOUVEAU v2.2.1 -- SOLE BLOCKER FIX. Une relecture n'upload
  // JAMAIS, n'appelle JAMAIS Storage AVANT la décision autoritaire --
  // elle entre DIRECTEMENT dans apply_product_photo_replacement
  // (p_is_retry: true), qui verrouille la ligne PUIS SEULEMENT ALORS
  // compare l'image actuellement autoritaire à cette cible
  // déterministe (voir commentaire de fonction ci-dessus, et ADDENDUM
  // v2.2.1 côté SQL). Modèle strictement binaire.
  if (isRetry) {
    let retryRow: ApplyRow;
    try {
      const { data: retryData, error: retryError } = await admin.rpc(
        "apply_product_photo_replacement",
        {
          p_caller_user_id: callerUserId,
          p_product_id: input.productId,
          p_new_image_url: newImageUrl,
          p_expected_origin: getTrustedStorageOrigin(),
          p_is_retry: true,
        }
      );
      if (retryError) throw retryError;
      const row = firstRow<ApplyRow>(retryData);
      if (!row) throw new Error("apply_product_photo_replacement (retry): empty row");
      retryRow = row;
    } catch (e) {
      // CONFLICT (SQLSTATE 'P0004') passe par ce catch -- classifié
      // "conflict" par reasonFromSqlState, jamais un message SQL brut
      // exposé. ZÉRO upload a eu lieu avant cet appel, dans TOUS les
      // cas (succès ALREADY_APPLIED, exception CONFLICT, ou toute
      // autre erreur) -- invariant "SECOND UPLOAD: NO" préservé sans
      // condition.
      const sqlState = (e as { code?: string })?.code ?? null;
      throw new ProductPhotoServerError(reasonFromSqlState(sqlState), e);
    }
    if (!retryRow.already_applied) {
      // État impossible par construction (la RPC renvoie TOUJOURS
      // already_applied=true OU lève P0004 pour une relecture) --
      // défense en profondeur : jamais accepté silencieusement.
      throw new ProductPhotoServerError("unavailable", retryRow);
    }
    return {
      imageUrl: retryRow.image_url ?? newImageUrl,
      oldImageCleanup: "not_applicable",
      cleanupId: null,
      alreadyApplied: true,
    };
  }

  // 4. Upload -- API Storage réelle, service_role (contourne RLS
  // nativement -- aucun octroi RLS client requis, INSERT client
  // d'ailleurs désormais using(false)/with check(false)). `upsert:
  // true` UNIQUEMENT pour un chemin déterministe (voir commentaire de
  // fonction) -- INCHANGÉ (`false`) pour Single Photo Edit. Cette
  // branche n'est JAMAIS atteinte pour une relecture (retournée ou
  // levée ci-dessus) -- ZÉRO upload pour tout retry, sans exception.
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: isBulk });
  if (uploadError) {
    // Scénario A -- DB inchangée, rien n'a jamais été référencé :
    // rien à compenser au-delà de laisser cet upload avorté (souvent
    // partiel/absent selon la nature de l'échec) tel quel.
    throw new ProductPhotoServerError("unavailable", uploadError);
  }

  // 5. Écriture DB atomique, verrouillée, revalidée -- SEULE autorité
  // pour "l'ancienne image" (jamais une valeur transmise ici). Appelée
  // EN SERVICE_ROLE (v1.5) -- p_caller_user_id transmis explicitement,
  // jamais auth.uid() (indisponible/non fiable dans ce contexte). Cet
  // appel n'est JAMAIS atteint pour une relecture (retournée ou levée
  // ci-dessus) -- UNIQUEMENT premier Apply, Bulk ou Single Photo Edit.
  // `p_is_retry` omis (défaut `false`, v2.2.1) -- ce site d'appel reste
  // STRICTEMENT identique à sa forme v1.6/v2.2 (4 arguments), jamais
  // modifié par ce lot.
  let applyRow: ApplyRow;
  try {
    const { data: applyData, error: applyError } = await admin.rpc(
      "apply_product_photo_replacement",
      {
        p_caller_user_id: callerUserId,
        p_product_id: input.productId,
        p_new_image_url: newImageUrl,
        // NOUVEAU v1.6 (Blocker 1 -- origine Storage historique jamais
        // vérifiée) : calculée UNIQUEMENT côté serveur, à partir de
        // NEXT_PUBLIC_SUPABASE_URL -- JAMAIS une valeur cliente, JAMAIS
        // un en-tête de requête.
        p_expected_origin: getTrustedStorageOrigin(),
      }
    );
    if (applyError) throw applyError;
    const row = firstRow<ApplyRow>(applyData);
    if (!row) throw new Error("apply_product_photo_replacement: empty row");
    applyRow = row;
  } catch (e) {
    // Scénario B -- l'upload a réussi mais la DB n'a JAMAIS référencé
    // ce fichier : orphelin nettoyé ici, best-effort. Un échec de CE
    // nettoyage compensatoire ne change rien à l'état -- déjà un
    // fichier orphelin (coût de stockage), jamais une incohérence DB.
    await admin.storage.from(BUCKET).remove([path]).catch(() => undefined);
    const sqlState = (e as { code?: string })?.code ?? null;
    throw new ProductPhotoServerError(reasonFromSqlState(sqlState), e);
  }

  // 6. Suppression physique de l'ancienne image -- SEULEMENT
  // maintenant, SEULEMENT le chemin EXACT renvoyé par la RPC (jamais
  // une valeur reconstruite ici), SEULEMENT si SQL l'a jugée sûre
  // (v1.5, Blocker 2 -- voir cleanupOldImage). Scénario C : un échec
  // de suppression (chemin sûr) est surfacé, jamais un rollback de la
  // nouvelle valeur DB déjà autoritaire.
  const { outcome: oldImageCleanup, cleanupId } = await cleanupOldImage(admin, applyRow, {
    callerUserId,
    productId: input.productId,
  });

  return {
    imageUrl: applyRow.image_url ?? newImageUrl,
    oldImageCleanup,
    cleanupId,
    alreadyApplied: false,
  };
}

/**
 * Supprime la photo d'un produit. Pas de génération de chemin (aucun
 * nouvel upload), mais begin_product_photo_replacement reste
 * OBLIGATOIRE depuis v1.5 : c'est désormais le SEUL moyen d'obtenir
 * caller_user_id (apply_ n'accepte plus d'appel AS-USER -- Blocker 1
 * v1.5), requis pour appeler apply_product_photo_replacement(
 * caller_user_id, productId, null) en service_role, qui capture/
 * revalide et renvoie l'ancienne image exactement comme pour un
 * remplacement, puis la supprime ici via l'API Storage réelle
 * (seulement si jugée sûre).
 */
export async function removeProductPhoto(
  input: RemoveProductPhotoInput
): Promise<RemoveProductPhotoResult> {
  const asUser = asUserSupabaseClientFactory.create(input.accessToken);
  const admin = getServiceRoleSupabaseClient();

  const { caller_user_id: callerUserId } = await beginReplacement(asUser, input.productId);

  let applyRow: ApplyRow;
  try {
    const { data, error } = await admin.rpc("apply_product_photo_replacement", {
      p_caller_user_id: callerUserId,
      p_product_id: input.productId,
      p_new_image_url: null,
      // NOUVEAU v1.6 -- voir replaceProductPhoto ci-dessus.
      p_expected_origin: getTrustedStorageOrigin(),
    });
    if (error) throw error;
    const row = firstRow<ApplyRow>(data);
    if (!row) throw new Error("apply_product_photo_replacement: empty row");
    applyRow = row;
  } catch (e) {
    const sqlState = (e as { code?: string })?.code ?? null;
    throw new ProductPhotoServerError(reasonFromSqlState(sqlState), e);
  }

  const { outcome: oldImageCleanup, cleanupId } = await cleanupOldImage(admin, applyRow, {
    callerUserId,
    productId: input.productId,
  });

  return { oldImageCleanup, cleanupId };
}

interface ClaimRow {
  old_path: string;
  claim_token: string;
}

/**
 * v1.6 (MEDIUM cleanup retry), v1.7 (client path trust boundary),
 * RÉÉCRITE v1.8 (Cat Stevens, SEUL blocker de v1.7 restant -- RELEASE-
 * BLOCKING, "claim marks completed before storage delete"). N'accepte
 * toujours JAMAIS de CHEMIN depuis le client. N'appelle TOUJOURS JAMAIS
 * apply_product_photo_replacement -- AUCUN nouvel upload, AUCUNE
 * écriture menu_items, AUCUN rejeu du remplacement. Ordre EXACT :
 *   1. begin_product_photo_replacement -- SEUL appel AS-USER, résout
 *      caller_user_id ;
 *   2. claim_product_photo_pending_cleanup (service_role) --
 *      `input.cleanupId` reste un identifiant OPAQUE (uuid), JAMAIS un
 *      chemin. NOUVEAU v1.8 : transitionne la ligne vers 'processing'
 *      (JAMAIS 'completed' -- c'est exactement le défaut fermé ici),
 *      pose un bail (lease) à expiration automatique, renvoie
 *      `{ old_path, claim_token }` -- `claim_token` reste ENTIÈREMENT
 *      côté serveur (variable locale uniquement, jamais placé dans la
 *      valeur de retour de cette fonction, donc jamais sérialisé dans
 *      une réponse HTTP) ;
 *   3. si aucune ligne réclamée (fabriqué/inexistant/déjà 'completed'/
 *      'processing' avec bail encore valide détenu par une autre
 *      tentative/autre tenant-produit/chemin désormais invalide) --
 *      JAMAIS transmis à Storage `.remove()`, surfacé comme
 *      "skipped_unsafe_legacy" ;
 *   4. si une ligne est réclamée -- SEULEMENT ALORS, Storage
 *      `.remove()` réel (service_role) sur le chemin EXACT réclamé ;
 *   5. succès Storage -- finalize_product_photo_pending_cleanup
 *      (service_role, `claim_token` exact requis) transitionne
 *      'processing' -> 'completed'. NOUVEAU v1.8 : la réponse Supabase
 *      est EXPLICITEMENT vérifiée (exception JS ET `{ error }` normal,
 *      jamais l'une sans l'autre) -- mais un échec de CETTE
 *      finalisation seule (réseau, `{ error }`, ligne déjà reréclamée
 *      par un claim plus récent après expiration du bail) ne rend
 *      JAMAIS le retry incohérent : Storage.remove() a réellement
 *      réussi, `oldImageCleanup: "removed"` est renvoyé au navigateur
 *      dans tous les cas, et un futur claim_ sur la même ligne (bail
 *      expiré) retentera Storage.remove() sur un chemin déjà absent --
 *      no-op sûr, sémantique idempotente de l'API Storage réelle, voir
 *      CLEANUP-LEASE-RECOVERY.md ;
 *   6. échec Storage DE NOUVEAU -- release_product_photo_pending_cleanup
 *      (service_role, `claim_token` exact requis) ramène IMMÉDIATEMENT
 *      la MÊME ligne à 'pending' pour un retry sans attendre. NOUVEAU
 *      v1.8 : la réponse Supabase est EXPLICITEMENT vérifiée (exception
 *      JS ET `{ error }` normal) -- mais NON-BLOQUANT PAR CONCEPTION
 *      (mandat "no reopen-or-die design") : que cet appel réussisse ou
 *      échoue sous quelque forme que ce soit, la ligne redevient de
 *      toute façon réclamable AUTOMATIQUEMENT dès l'expiration du bail
 *      déjà posé par claim_ à l'étape 2 -- jamais le SEUL mécanisme de
 *      récupération durable.
 *
 * BULK RETRY INVARIANT : un remplacement déjà réussi n'est JAMAIS
 * rejoué par cette fonction -- elle ne touche jamais menu_items, ne
 * génère jamais de nouveau chemin, n'uploade jamais rien.
 *
 * v2.2 (LOST HTTP RESPONSE / SUCCESSFUL REPLAY) -- cette fonction
 * N'EST PAS le mécanisme qui ferme ce blocker (voir replaceProductPhoto
 * ci-dessous, et DETERMINISTIC-BULK-PATH-IDEMPOTENCY.md) -- listée ici
 * uniquement pour mémoire : `retryOldImageCleanup` reste inchangée,
 * hors périmètre de v2.2 comme de v2.1.
 */
export async function retryOldImageCleanup(
  input: RetryOldImageCleanupInput
): Promise<RetryOldImageCleanupResult> {
  const asUser = asUserSupabaseClientFactory.create(input.accessToken);
  const admin = getServiceRoleSupabaseClient();

  // 1. Réautorise DE NOUVEAU (comme pour un remplacement) -- begin_
  // reste le SEUL appel AS-USER de ce flux.
  const { caller_user_id: callerUserId } = await beginReplacement(asUser, input.productId);

  // 2. Réclamation SEULE (pending/processing-bail-expiré -> processing),
  // AUCUNE mutation de menu_items/storage.objects -- jamais un appel à
  // apply_product_photo_replacement. `cleanupId` n'est ICI qu'une clé
  // de recherche opaque -- toute la revalidation de sécurité
  // (autorisation, tenant, forme de chemin, réclamabilité du bail) se
  // produit côté SQL, à partir de l'état stocké, jamais depuis ce
  // paramètre.
  let claimed: ClaimRow | null;
  try {
    const { data, error } = await admin.rpc("claim_product_photo_pending_cleanup", {
      p_caller_user_id: callerUserId,
      p_product_id: input.productId,
      p_cleanup_id: input.cleanupId,
      p_expected_origin: getTrustedStorageOrigin(),
    });
    if (error) throw error;
    claimed = firstRow<ClaimRow>(data);
  } catch (e) {
    const sqlState = (e as { code?: string })?.code ?? null;
    throw new ProductPhotoServerError(reasonFromSqlState(sqlState), e);
  }

  // 3. Rien à réclamer (fabriqué/inexistant/'completed'/'processing'
  // avec bail encore valide/autre tenant-produit/chemin désormais
  // invalide) -- JAMAIS transmis à Storage .remove().
  if (!claimed?.old_path || !claimed?.claim_token) {
    return { oldImageCleanup: "skipped_unsafe_legacy" };
  }

  // 4. SEULEMENT maintenant -- le chemin EXACT réclamé côté SQL (jamais
  // input.cleanupId ni une valeur reconstruite ici).
  const { error: removeError } = await admin.storage.from(BUCKET).remove([claimed.old_path]);

  if (!removeError) {
    // 5. Storage.remove() a RÉELLEMENT réussi -- SEULEMENT maintenant,
    // finalize_ transitionne processing -> completed. NOUVEAU v1.8 :
    // les DEUX formes d'échec sont vérifiées explicitement, jamais
    // ignorées -- mais un échec ICI ne change jamais la réponse
    // renvoyée au navigateur (le fichier est réellement supprimé) ; la
    // ligne, restée 'processing', redevient réclamable à l'expiration
    // du bail et un futur retry retrouvera Storage déjà vide (no-op sûr).
    try {
      const { error: finalizeError } = await admin.rpc("finalize_product_photo_pending_cleanup", {
        p_caller_user_id: callerUserId,
        p_product_id: input.productId,
        p_cleanup_id: input.cleanupId,
        p_claim_token: claimed.claim_token,
      });
      if (finalizeError) {
        // Vérifié, jamais ignoré -- mais volontairement non fatal, voir
        // commentaire ci-dessus/CLEANUP-LEASE-RECOVERY.md.
      }
    } catch {
      // Vérifié (exception JS), jamais ignoré -- même posture : non
      // fatal, le bail garantit la récupération durable indépendamment.
    }
    return { oldImageCleanup: "removed" };
  }

  // 6. Échec de Storage .remove() DE NOUVEAU -- release_ ramène
  // IMMÉDIATEMENT la MÊME ligne à 'pending' (jamais un nouveau
  // cleanup_id, jamais un retargetage). NON-BLOQUANT PAR CONCEPTION --
  // les DEUX formes d'échec sont vérifiées explicitement (jamais
  // ignorées, contrairement au v1.7 `catch { }` silencieux), mais
  // n'influencent JAMAIS le résultat renvoyé ici ("failed" dans tous
  // les cas) : le bail déjà posé par claim_ garantit la récupération
  // durable même si CET appel échoue sous quelque forme que ce soit.
  try {
    const { error: releaseError } = await admin.rpc("release_product_photo_pending_cleanup", {
      p_caller_user_id: callerUserId,
      p_product_id: input.productId,
      p_cleanup_id: input.cleanupId,
      p_claim_token: claimed.claim_token,
    });
    if (releaseError) {
      // Vérifié, jamais ignoré -- non fatal (bail garantit la
      // récupération durable indépendamment de ce résultat).
    }
  } catch {
    // Vérifié (exception JS), jamais ignoré -- même posture non fatale.
  }
  return { oldImageCleanup: "failed" };
}
