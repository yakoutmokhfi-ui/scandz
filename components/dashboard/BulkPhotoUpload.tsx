"use client";

/**
 * BULK PRODUCT PHOTOS v1.
 *
 * Panneau d'envoi groupé de photos produit, intégré à
 * app/dashboard/catalogue/page.tsx. Réutilise EXCLUSIVEMENT les
 * primitives déjà publiées :
 *   - lib/services/product-photo.ts : validateProductPhotoFile,
 *     addOrReplaceProductPhoto. v1.4 (Cat Stevens, réaudit final --
 *     TRUSTED SERVER-SIDE REPLACEMENT HARDENING) : ce module ne parle
 *     plus jamais directement à Storage ni à une RPC -- il délègue
 *     intégralement à la route de confiance app/api/dashboard/
 *     catalogue/product-photo/route.ts (lib/server/
 *     product-photo-service.ts), qui résout restaurant_id, génère le
 *     chemin final et effectue upload + écriture DB + nettoyage
 *     Storage de l'ancienne photo, de façon prouvée, côté serveur. Ce
 *     composant n'a, comme avant v1.4, RIEN à transmettre au sujet de
 *     l'ancienne image ;
 *   - lib/services/bulk-product-photo-matching.ts (pur, sans I/O) :
 *     appariement nom de fichier -> produit, détection d'ambiguïté/
 *     conflit.
 *
 * Aucun second modèle de stockage n'est introduit : ce composant ne
 * fait jamais d'appel Storage/RPC directement -- seulement via
 * addOrReplaceProductPhoto, un produit à la fois, exactement comme le
 * fait déjà ProductPhotoField pour une photo unique.
 *
 * Sécurité multi-tenant : la liste `products` fournie par l'appelant
 * (app/dashboard/catalogue/page.tsx) est déjà strictement scoped au
 * restaurant courant (get_merchant_catalogue(restaurantId)). Le
 * module d'appariement ne peut structurellement produire que des
 * product_id présents dans cette liste (voir
 * bulk-product-photo-matching.ts). Une garde défensive supplémentaire
 * est appliquée juste avant chaque appel réel (voir handleApply) :
 * un product_id qui ne serait plus retrouvé dans `products` au moment
 * de l'application est ignoré et rapporté en échec, jamais transmis
 * en aveugle. L'autorité finale reste néanmoins côté serveur
 * (assert_product_role, déjà publié, jamais modifié par ce lot).
 *
 * v2.1 (BULK PRODUCT PHOTOS -- FINAL MVP) -- HISTORIQUE, REMPLACÉE PAR
 * v2.2 CI-DESSOUS. v2.1 introduisait UNE SEULE case globale "Remplacer
 * les photos existantes" (décochée par défaut) plus une clé
 * d'idempotence PAR FICHIER. Ce modèle est intégralement retiré par
 * v2.2 -- il n'en reste plus aucune trace dans ce composant.
 *
 * v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, décision CIO qui
 * ANNULE ET REMPLACE v2.1). Bulk sert exclusivement l'onboarding/le
 * re-onboarding catalogue -- un cas d'usage OCCASIONNEL, distinct de
 * l'édition manuelle quotidienne d'une seule photo (page catalogue,
 * inchangée). RÈGLE MÉTIER, encore plus simple que v2.1 : CONFIRMER
 * L'IMPORT BULK LUI-MÊME autorise le remplacement des photos
 * existantes de TOUT produit correctement apparié -- il n'existe PLUS
 * ni case globale ni case par ligne (mandat : "There is no OFF/ON
 * replacement mode. There is no per-row replacement mode."). Une note
 * de confirmation STATIQUE (jamais une case à cocher) informe une
 * seule fois l'opérateur. Un fichier apparu ENTRE la prévisualisation
 * et la confirmation reste couvert par cette même autorisation de lot
 * (mandat : "Do NOT implement expected-image authorization or TOCTOU
 * replacement blocking").
 *
 * v2.2 ferme le blocker technique "LOST HTTP RESPONSE / SUCCESSFUL
 * REPLAY" par un `batchId` STABLE PAR LOT (généré une seule fois à la
 * sélection des fichiers, réutilisé pour CHAQUE produit du lot et pour
 * TOUT retry -- jamais par fichier, contrairement à la clé v2.1) +
 * l'image observée pour chaque produit AVANT sa toute première
 * tentative (utilisée UNIQUEMENT sur un retry, jamais sur la première
 * tentative -- voir lib/server/product-photo-service.ts pour le
 * mécanisme serveur complet, entièrement côté Node). Relayés à
 * `addOrReplaceProductPhoto`, jamais interprétés ici.
 */

import { useRef, useState } from "react";
import {
  addOrReplaceProductPhoto,
  retryOldPhotoCleanup,
  validateProductPhotoFile,
  InvalidFileTypeError,
  FileTooLargeError,
  PhotoConflictError,
  type BulkPhotoApplyContext,
} from "@/lib/services/product-photo";
import {
  matchFilesByName,
  applyValidationResult,
  applyManualMatch,
  resolveConflicts,
  getReadyToApply,
  countByState,
  hasExistingImageAtTarget,
  type BulkPhotoCandidate,
  type BulkPhotoMatchProduct,
} from "@/lib/services/bulk-product-photo-matching";
import type { Translator } from "@/lib/i18n";

const ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

function hasAcceptedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface ApplyResult {
  fileKey: string;
  fileName: string;
  productId: string;
  productName: string;
  success: boolean;
  errorKey: string | null;
  /**
   * BULK PRODUCT PHOTOS v1.5 (Cat Stevens MEDIUM -- "DB SUCCESS + OLD
   * DELETE FAILURE NOT SURFACED TO UI"). `true` UNIQUEMENT quand le
   * remplacement a RÉUSSI (nouvelle photo autoritaire en DB) mais que
   * le nettoyage de l'ancienne image a été soit tenté-et-échoué
   * (`oldImageCleanup: "failed"`), soit explicitement sauté car jugé
   * non sûr (`"skipped_unsafe_legacy"`) -- jamais un échec du
   * remplacement lui-même, jamais bloquant : un orphelin de stockage
   * possible, rien de plus (voir FAILURE-COMPENSATION-MATRIX.md).
   */
  cleanupWarning?: boolean;
  /**
   * NOUVEAU v1.6 (MEDIUM cleanup retry -- Cat Stevens : "cleanup
   * failure ... is not retriable"). Distingue les DEUX raisons
   * possibles de `cleanupWarning` : "failed" (tentative Storage réelle
   * échouée -- RETRIABLE, voir handleRetryCleanup ci-dessous) vs
   * "skipped_unsafe_legacy" (référence historique jugée non sûre --
   * JAMAIS retriable, rien de légitime n'a jamais existé à retenter).
   */
  cleanupOutcome?: "failed" | "skipped_unsafe_legacy";
  /**
   * NOUVEAU v1.7 (REMPLACE `oldPath`, v1.6 -- SEUL blocker fermé par ce
   * lot, Cat Stevens : "cleanup-retry accepts a client-supplied
   * oldPath"). Identifiant OPAQUE (uuid), EXACTEMENT tel que renvoyé
   * par la route de confiance -- requis pour un retry cleanup-only.
   * JAMAIS un chemin Storage : ce composant ne construit, ne parse, ni
   * ne transmet plus aucun chemin pour ce flux.
   */
  cleanupId?: string | null;
}

function isCleanupWarning(outcome: { oldImageCleanup: string }): boolean {
  return outcome.oldImageCleanup === "failed" || outcome.oldImageCleanup === "skipped_unsafe_legacy";
}

/** NOUVEAU v1.6 -- extrait "failed"/"skipped_unsafe_legacy" (ou undefined) depuis un résultat addOrReplaceProductPhoto. */
function cleanupOutcomeOf(outcome: {
  oldImageCleanup: string;
}): "failed" | "skipped_unsafe_legacy" | undefined {
  if (outcome.oldImageCleanup === "failed") return "failed";
  if (outcome.oldImageCleanup === "skipped_unsafe_legacy") return "skipped_unsafe_legacy";
  return undefined;
}

export default function BulkPhotoUpload({
  restaurantId,
  products,
  t,
  onApplied,
  onClose,
}: {
  restaurantId: string;
  /** Catalogue courant, DÉJÀ strictement scoped au restaurant actif
   *  (voir commentaire d'en-tête) -- jamais élargi ni re-fetché par
   *  ce composant. */
  products: BulkPhotoMatchProduct[];
  t: Translator;
  /** Appelé après une application réussie (au moins un succès) pour
   *  que la page parente recharge le catalogue -- jamais appelé
   *  automatiquement pendant la prévisualisation (aucune mutation
   *  avant confirmation explicite). */
  onApplied: () => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [candidates, setCandidates] = useState<BulkPhotoCandidate[]>([]);
  const [validating, setValidating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  // BULK PRODUCT PHOTOS v1.1 -- remédiation Cat Stevens Blocker 2
  // (retry successful files replay). État LOCAL, propre au lot en
  // cours (jamais dérivé d'un rechargement du catalogue parent, qui
  // est asynchrone et peut ne pas encore avoir résolu quand
  // l'opérateur reclique -- voir CASE 5 du mandat) : l'ensemble des
  // fileKey déjà appliqués AVEC SUCCÈS dans CE panneau. Consulté par
  // `ready` ci-dessous pour retirer définitivement un fichier déjà
  // uploadé de tout candidat "prêt à appliquer" -- ni le bouton
  // principal ni "Réessayer les échecs" ne peuvent plus jamais le
  // rejouer, même si son état d'appariement (candidates) reste
  // "matched" par ailleurs (l'appariement et le statut d'application
  // sont deux préoccupations volontairement séparées : ce lot ne
  // touche pas au contrat d'appariement v1, préservé tel quel).
  const [appliedFileKeys, setAppliedFileKeys] = useState<Set<string>>(new Set());
  // BULK PRODUCT PHOTOS v1.1 -- garde de ré-entrance SYNCHRONE
  // (Cat Stevens Blocker 2, CASE 5 : double clic rapide). `applying`
  // (useState) ne suffit pas seul : deux clics synchrones (avant que
  // React ne recalcule le DOM et ne désactive réellement le bouton --
  // ou dans un test qui dispatche deux clicks() consécutifs sans
  // attendre de rerender) peuvent tous deux entrer dans handleApply
  // avant que `applying` ne soit devenu true dans un rendu observable.
  // Une ref est lue/écrite de façon synchrone et immédiate, donc un
  // second appel concurrent est bloqué dès la première ligne de
  // handleApply/handleRetryFailed, indépendamment du cycle de rendu.
  const applyingRef = useRef(false);
  // NOUVEAU v1.6 (MEDIUM cleanup retry) -- fileKey(s) actuellement en
  // cours de retry de nettoyage UNIQUEMENT (jamais un remplacement
  // rejoué -- voir handleRetryCleanup). Ensemble, jamais un booléen
  // global : plusieurs items peuvent être en retry indépendamment.
  const [retryingCleanupKeys, setRetryingCleanupKeys] = useState<Set<string>>(new Set());

  const multiInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const fileByKey = useRef<Map<string, File>>(new Map());
  // NOUVEAU v2.2 (LOST HTTP RESPONSE / SUCCESSFUL REPLAY) -- ANNULE ET
  // REMPLACE la clé d'idempotence PAR FICHIER de v2.1. `batchId` est
  // désormais STABLE PAR LOT (une seule valeur pour TOUT le lot en
  // cours, jamais une par fichier) -- réutilisée pour chaque produit
  // ET pour tout retry. Régénérée à chaque nouvelle sélection (voir
  // handleSelect) -- un nouveau lot, une nouvelle identité d'opération.
  const batchIdRef = useRef<string>(crypto.randomUUID());
  // NOUVEAU v2.2.1 (Cat Stevens, SOLE BLOCKER FIX) -- REMPLACE
  // `priorImageByFileKey` (v2.2, Map<string, string | null>). Ce
  // composant n'a plus besoin de connaître/transmettre AUCUNE "image
  // attendue" -- la décision ALREADY_APPLIED / CONFLICT est désormais
  // prise ENTIÈREMENT côté SQL, SOUS le verrou de ligne autoritaire
  // (voir lib/server/product-photo-service.ts). Seul reste nécessaire
  // ICI : SAVOIR si ce fileKey a déjà été tenté dans CE lot, pour
  // transmettre `isRetry: true`/`false` au serveur -- un simple
  // ensemble suffit. Réinitialisé à chaque nouvelle sélection.
  const attemptedFileKeys = useRef<Set<string>>(new Set());

  /**
   * Point d'entrée UNIQUE pour appliquer UN candidat (première
   * tentative OU retry) -- factorisé entre handleApply et
   * handleRetryFailed, jamais deux implémentations divergentes.
   * Détecte lui-même s'il s'agit d'un retry (fileKey déjà présent dans
   * attemptedFileKeys) et construit le contexte Bulk en conséquence --
   * voir lib/services/product-photo.ts (BulkPhotoApplyContext) et
   * lib/server/product-photo-service.ts pour le mécanisme complet.
   * v2.2.1 -- ne transmet plus AUCUNE "image attendue" : `isRetry`
   * (booléen simple) est désormais le SEUL signal, la décision
   * ALREADY_APPLIED / CONFLICT étant prise ENTIÈREMENT côté SQL, sous
   * le verrou de ligne autoritaire.
   */
  async function applyCandidate(item: { fileKey: string; productId: string }): Promise<ApplyResult> {
    const file = fileByKey.current.get(item.fileKey);
    const product = products.find((p) => p.product_id === item.productId);
    const candidate = candidates.find((c) => c.fileKey === item.fileKey);
    if (!file || !product || !candidate) {
      return {
        fileKey: item.fileKey,
        fileName: candidate?.fileName ?? item.fileKey,
        productId: item.productId,
        productName: product?.name ?? "",
        success: false,
        errorKey: "mcBulkPhotoErrorUnknown",
      };
    }

    const seenBefore = attemptedFileKeys.current.has(item.fileKey);
    if (!seenBefore) {
      attemptedFileKeys.current.add(item.fileKey);
    }
    const bulkContext: BulkPhotoApplyContext = { batchId: batchIdRef.current, isRetry: seenBefore };

    try {
      const result = await addOrReplaceProductPhoto(restaurantId, product.product_id, file, bulkContext);
      return {
        fileKey: item.fileKey,
        fileName: candidate.fileName,
        productId: product.product_id,
        productName: product.name,
        success: true,
        errorKey: null,
        cleanupWarning: isCleanupWarning(result),
        cleanupOutcome: cleanupOutcomeOf(result),
        cleanupId: result.cleanupId,
      };
    } catch (e) {
      // Le message technique brut n'est jamais affiché -- seul un
      // texte traduit générique par fichier. Un CONFLICT (v2.2, SAFE
      // RETRY) est distingué d'un échec ordinaire : le serveur a
      // délibérément refusé d'écraser un autre changement de photo
      // légitime survenu entre-temps -- jamais un échec d'upload/de
      // remplacement à proprement parler.
      const errorKey = e instanceof PhotoConflictError ? "mcBulkPhotoErrorConflict" : "mcBulkPhotoErrorUpload";
      return {
        fileKey: item.fileKey,
        fileName: candidate.fileName,
        productId: product.product_id,
        productName: product.name,
        success: false,
        errorKey,
      };
    }
  }

  /**
   * Sélection (fichiers multiples OU dossier) : REMPLACE totalement
   * le lot précédent -- comportement volontairement simple et
   * prévisible (pas d'accumulation implicite entre deux sélections),
   * documenté dans BULK-PHOTO-CONTRACT.md. Toute confirmation/résultat
   * précédent est réinitialisé : une nouvelle sélection démarre un
   * nouveau cycle prévisualisation -> confirmation.
   */
  async function handleSelect(fileList: FileList | null) {
    if (!fileList) return;
    const all = Array.from(fileList);
    const imagesOnly = all.filter((f) => hasAcceptedExtension(f.name));

    setResults(null);
    setAppliedFileKeys(new Set()); // nouveau lot -- aucun fichier "déjà appliqué" n'a de sens ici
    setFiles(imagesOnly);
    fileByKey.current = new Map(imagesOnly.map((f, i) => [`f${i}`, f]));
    // v2.2 -- nouveau lot, nouvelle identité d'opération : un nouveau
    // batchId (jamais réutilisé d'un lot précédent). v2.2.1 -- aucun
    // fileKey de ce nouveau lot n'a encore été tenté.
    batchIdRef.current = crypto.randomUUID();
    attemptedFileKeys.current = new Set();

    if (imagesOnly.length === 0) {
      setCandidates([]);
      return;
    }

    let next = matchFilesByName(imagesOnly, products);
    setCandidates(next);

    // Validation binaire réelle (signature de fichier), un fichier à
    // la fois -- jamais avant l'appariement par nom (qui ne lit aucun
    // octet), et jamais sautée même pour un fichier "matched" :
    // mandat "malformed file metadata" / "no executable/script
    // disguised as image" doivent être détectés dès la
    // prévisualisation, pas seulement au moment d'appliquer.
    setValidating(true);
    for (const [key, file] of fileByKey.current.entries()) {
      try {
        await validateProductPhotoFile(file);
        next = applyValidationResult(next, key, null);
      } catch (e) {
        const errorCode =
          e instanceof FileTooLargeError
            ? "too_large"
            : e instanceof InvalidFileTypeError
              ? "invalid_type"
              : "invalid_type";
        next = applyValidationResult(next, key, errorCode);
      }
      next = resolveConflicts(next);
      setCandidates([...next]);
    }
    setValidating(false);
  }

  function handleManualMatch(fileKey: string, productId: string | null) {
    let next = applyManualMatch(candidates, fileKey, productId);
    next = resolveConflicts(next);
    setCandidates(next);
  }


  async function handleApply() {
    // BULK PRODUCT PHOTOS v1.1 -- ne recalcule JAMAIS "ready" à partir
    // du seul état d'appariement (candidates) : un fichier déjà
    // appliqué avec succès (appliedFileKeys) reste "matched" dans
    // candidates par construction (l'appariement et le statut
    // d'application sont deux préoccupations séparées, voir
    // commentaire sur appliedFileKeys), mais ne doit PLUS JAMAIS
    // pouvoir être rejoué -- c'est exactement le Blocker 2 Cat
    // Stevens (retry successful files replay). Ce filtre est la
    // garde structurelle : indépendante de tout rechargement
    // catalogue parent (asynchrone, potentiellement pas encore résolu
    // -- voir CASE 5 du mandat), elle vit entièrement dans l'état
    // local de CE composant.
    // Garde de ré-entrance synchrone (voir commentaire sur
    // applyingRef) -- doit être la toute première chose évaluée après
    // le calcul de `ready`, avant tout `await`, pour qu'un second
    // appel synchrone concurrent (double clic rapide, CASE 5) soit
    // rejeté immédiatement plutôt que de recalculer son propre
    // `ready` à partir d'un état pas encore mis à jour.
    if (applyingRef.current) return;
    // v2.2 -- garde à 2 paramètres, plus aucun drapeau de remplacement
    // (global ni par ligne) : voir bulk-product-photo-matching.ts.
    const ready = getReadyToApply(candidates, products).filter(
      (item) => !appliedFileKeys.has(item.fileKey)
    );
    if (ready.length === 0) return;

    applyingRef.current = true;
    setApplying(true);
    const outcome: ApplyResult[] = [];

    // v2.2 -- délégation à applyCandidate (voir sa définition
    // ci-dessus), factorisé avec handleRetryFailed : cette boucle ne
    // fait plus que détecter les candidats manquants (défense en
    // profondeur -- déjà garanti par bulk-product-photo-matching.ts).
    for (const item of ready) {
      outcome.push(await applyCandidate(item));
    }

    // Chaque appel réussi de CE lot devient définitivement
    // non-rejouable, quel que soit ce qui se passe ensuite (rerender,
    // rechargement catalogue parent en cours, nouvel essai sur
    // d'autres fichiers) -- ajout, jamais un remplacement (results
    // s'accumule de la même façon lors d'un futur "Réessayer les
    // échecs", voir plus bas).
    const succeededKeys = outcome.filter((r) => r.success).map((r) => r.fileKey);
    if (succeededKeys.length > 0) {
      setAppliedFileKeys((prev) => new Set([...prev, ...succeededKeys]));
    }

    setResults(outcome);
    applyingRef.current = false;
    setApplying(false);
    if (outcome.some((r) => r.success)) {
      onApplied();
    }
  }

  async function handleRetryFailed() {
    // Même garde de ré-entrance synchrone que handleApply -- un
    // double clic rapide sur "Réessayer les échecs" ne doit pas non
    // plus pouvoir rejouer un fichier déjà en cours de retry.
    if (applyingRef.current) return;
    if (!results) return;
    // "Réessayer les échecs" ne doit REJOUER que les fichiers encore
    // en échec -- jamais un fichier déjà marqué appliqué avec succès,
    // même par un appel PRÉCÉDENT à handleRetryFailed lui-même (cas
    // d'un troisième clic après un deuxième batch partiellement
    // réussi). Double garde : `!r.success` (état affiché) ET
    // `!appliedFileKeys.has(...)` (état d'application faisant
    // autorité) -- la seconde ne peut normalement jamais diverger de
    // la première ici, mais reste la source de vérité structurelle,
    // cohérente avec handleApply ci-dessus.
    const failed = results.filter((r) => !r.success && !appliedFileKeys.has(r.fileKey));
    if (failed.length === 0) return;

    applyingRef.current = true;
    setApplying(true);
    // v2.2 (délégation), v2.2.1 (mécanisme RÉÉCRIT, SOLE BLOCKER FIX) --
    // délégation à applyCandidate (voir sa définition ci-dessus,
    // factorisée avec handleApply). `attemptedFileKeys` contient
    // nécessairement déjà chacun de ces fileKey depuis leur toute
    // première tentative -- applyCandidate détecte donc automatiquement
    // qu'il s'agit d'un retry et transmet `isRetry: true` en
    // conséquence (voir "SAFE RETRY" du mandat) : la décision
    // ALREADY_APPLIED / CONFLICT est alors prise ENTIÈREMENT côté SQL,
    // SOUS le verrou de ligne autoritaire -- si le premier essai avait
    // en réalité réussi côté serveur (réponse simplement perdue), le
    // serveur le reconnaît et NE RÉ-APPLIQUE RIEN -- c'est exactement
    // l'invariant exigé, désormais SANS aucune fenêtre de course.
    const retried: ApplyResult[] = [];
    for (const r of failed) {
      retried.push(await applyCandidate({ fileKey: r.fileKey, productId: r.productId }));
    }

    const succeededKeys = retried.filter((r) => r.success).map((r) => r.fileKey);
    if (succeededKeys.length > 0) {
      setAppliedFileKeys((prev) => new Set([...prev, ...succeededKeys]));
    }

    setResults((prev) =>
      (prev ?? []).map((r) => retried.find((x) => x.fileKey === r.fileKey) ?? r)
    );
    applyingRef.current = false;
    setApplying(false);
    if (retried.some((r) => r.success)) {
      onApplied();
    }
  }

  /**
   * v1.6 (MEDIUM cleanup retry). RÉÉCRITE v1.7 (Cat Stevens, SEUL
   * blocker de v1.6 -- TRUST BOUNDARY) : transmet désormais
   * `current.cleanupId` (identifiant OPAQUE), JAMAIS un chemin Storage.
   * Retente UNIQUEMENT le nettoyage Storage de l'ancienne image pour UN
   * item déjà réussi -- délégation à retryOldPhotoCleanup, qui
   * n'appelle JAMAIS addOrReplaceProductPhoto : AUCUN nouvel upload,
   * AUCUNE écriture menu_items rejouée (BULK RETRY INVARIANT -- un
   * remplacement déjà réussi n'est jamais rejoué par cette fonction,
   * distincte de handleRetryFailed ci-dessus qui ne rejoue QUE les
   * items en échec d'upload/remplacement -- jamais conflaté). N'est
   * proposé QUE pour `cleanupOutcome === "failed"`.
   */
  async function handleRetryCleanup(fileKey: string) {
    if (retryingCleanupKeys.has(fileKey)) return;
    const current = (results ?? []).find((r) => r.fileKey === fileKey);
    if (!current || current.cleanupOutcome !== "failed" || !current.cleanupId) return;

    setRetryingCleanupKeys((prev) => new Set([...prev, fileKey]));
    try {
      const result = await retryOldPhotoCleanup(current.productId, current.cleanupId);
      setResults((prev) =>
        (prev ?? []).map((r) =>
          r.fileKey === fileKey
            ? {
                ...r,
                cleanupWarning: isCleanupWarning(result),
                cleanupOutcome: cleanupOutcomeOf(result),
              }
            : r
        )
      );
    } catch {
      // Échec du RETRY lui-même (réseau/serveur) -- l'item reste
      // marqué EXACTEMENT comme avant, jamais effacé sur un échec.
    } finally {
      setRetryingCleanupKeys((prev) => {
        const next = new Set(prev);
        next.delete(fileKey);
        return next;
      });
    }
  }

  const counts = countByState(candidates);
  // Regroupement en 4 compteurs exactement -- mandat UX : "files
  // selected count / matched count / unmatched count / conflict-error
  // count". Le tableau détaillé ci-dessous garde la distinction fine
  // (ambiguous vs unmatched, conflict vs invalid) pour chaque ligne.
  const unmatchedBucket = counts.unmatched + counts.ambiguous;
  const conflictErrorBucket = counts.conflict + counts.invalid;
  // BULK PRODUCT PHOTOS v1.1 -- même filtre qu'à l'intérieur de
  // handleApply (voir son commentaire) : un fichier déjà appliqué
  // avec succès ne compte plus jamais comme "prêt", ni dans le
  // libellé du bouton ("Confirmer et appliquer (N)") ni dans son
  // état disabled -- c'est ce qui rend un second clic structurellement
  // sans effet dès que ready.length retombe à 0 (CASE 1 du mandat :
  // "3 files, all succeed -> apply button disabled").
  // v2.2 -- confirmer le lot autorise déjà le remplacement de TOUT
  // produit correctement apparié : plus aucun drapeau, ni global ni
  // par ligne. Voir getReadyToApply (bulk-product-photo-matching.ts).
  const ready = getReadyToApply(candidates, products).filter(
    (item) => !appliedFileKeys.has(item.fileKey)
  );
  // Au moins une ligne "matched" a une cible qui a déjà une photo --
  // pilote UNIQUEMENT l'affichage de la note de confirmation statique
  // ci-dessous (v2.2 : n'a plus AUCUNE incidence sur ce qui est
  // appliqué, contrairement à v2.1).
  const anyExistingPhotoTarget = candidates.some(
    (c) => c.state === "matched" && hasExistingImageAtTarget(c, products)
  );

  function stateLabel(c: BulkPhotoCandidate): string {
    switch (c.state) {
      case "matched":
        return t("mcBulkPhotoStateMatched");
      case "ambiguous":
        return t("mcBulkPhotoStateAmbiguous");
      case "unmatched":
        return t("mcBulkPhotoStateUnmatched");
      case "conflict":
        return t("mcBulkPhotoStateConflict");
      case "invalid":
        return c.validationError === "too_large"
          ? t("mcPhotoTooLarge")
          : t("mcPhotoInvalidType");
    }
  }

  function stateBadgeClass(c: BulkPhotoCandidate): string {
    switch (c.state) {
      case "matched":
        return "bg-emerald-50 text-emerald-800 border-emerald-300";
      case "ambiguous":
      case "unmatched":
        return "bg-amber-50 text-amber-900 border-amber-300";
      case "conflict":
      case "invalid":
        return "bg-red-50 text-red-800 border-red-300";
    }
  }

  return (
    <div
      role="region"
      aria-label={t("mcBulkPhotoTitle")}
      className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-stone-900">{t("mcBulkPhotoTitle")}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700"
        >
          {t("mcBulkPhotoClose")}
        </button>
      </div>

      <p className="mb-3 text-xs text-stone-600">{t("mcBulkPhotoHint")}</p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold">
          {t("mcBulkPhotoSelectFiles")}
          <input
            ref={multiInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              void handleSelect(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <label className="cursor-pointer rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold">
          {t("mcBulkPhotoSelectFolder")}
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // webkitdirectory : attribut non standard mais largement
            // supporté (navigateurs Chromium/Safari/Firefox récents),
            // dégrade sans erreur vers une sélection de fichiers
            // classique si absent -- jamais bloquant.
            // @ts-expect-error -- attribut HTML non typé par React
            webkitdirectory=""
            className="hidden"
            onChange={(e) => {
              void handleSelect(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {files.length === 0 ? (
        <p className="text-xs text-stone-500">{t("mcBulkPhotoNoSelection")}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-stone-700">
            <span>{t("mcBulkPhotoCountSelected", { n: counts.total })}</span>
            <span className="font-semibold text-emerald-800">
              {t("mcBulkPhotoCountMatched", { n: counts.matched })}
            </span>
            <span className="font-semibold text-amber-900">
              {t("mcBulkPhotoCountUnmatched", { n: unmatchedBucket })}
            </span>
            <span className="font-semibold text-red-800">
              {t("mcBulkPhotoCountConflictError", { n: conflictErrorBucket })}
            </span>
          </div>

          {validating && (
            <p className="mb-3 text-xs text-stone-500">{t("mcBulkPhotoValidating")}</p>
          )}

          <div className="mb-3 overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="border-b border-stone-200 text-stone-500">
                  <th className="px-2 py-2 font-semibold">{t("mcBulkPhotoColFile")}</th>
                  <th className="px-2 py-2 font-semibold">{t("mcBulkPhotoColStatus")}</th>
                  <th className="px-2 py-2 font-semibold">{t("mcBulkPhotoColTarget")}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const selectableProducts =
                    c.state === "ambiguous"
                      ? products.filter((p) => c.ambiguousProductIds.includes(p.product_id))
                      : products;
                  // v2.1 -- indicateur PASSIF, purement informatif :
                  // aucune case par ligne (mandat : "No per-row
                  // replacement checkbox"). Le badge/état affiché ici
                  // reste `c.state` seul (stateLabel/stateBadgeClass) ;
                  // la décision de remplacer une photo existante est
                  // désormais EXCLUSIVEMENT globale (voir la case à
                  // cocher unique près du bouton de confirmation).
                  const hasExistingPhoto =
                    c.state === "matched" && hasExistingImageAtTarget(c, products);

                  return (
                    <tr key={c.fileKey} className="border-b border-stone-100 last:border-0">
                      <td className="max-w-[180px] truncate px-2 py-2" title={c.fileName}>
                        {c.fileName}
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stateBadgeClass(c)}`}
                        >
                          {stateLabel(c)}
                        </span>
                        {hasExistingPhoto && (
                          <span className="ml-1 inline-block rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600">
                            {t("mcBulkPhotoExistingPhotoIndicator")}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {c.state === "invalid" ? (
                          <span className="text-stone-400">—</span>
                        ) : (
                          <select
                            aria-label={t("mcBulkPhotoColTarget")}
                            value={c.resolvedProductId ?? ""}
                            onChange={(e) =>
                              handleManualMatch(c.fileKey, e.target.value || null)
                            }
                            className="rounded-lg border border-stone-300 px-2 py-1 text-xs"
                          >
                            <option value="">{t("mcBulkPhotoPickProduct")}</option>
                            {selectableProducts.map((p) => (
                              <option key={p.product_id} value={p.product_id}>
                                {p.category_name} — {p.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {anyExistingPhotoTarget && (
            // NOUVEAU v2.2 -- ANNULE ET REMPLACE la case à cocher
            // unique de v2.1 (mandat CIO : "Remove: 'Replace existing
            // product photos'. There is no OFF/ON replacement mode.").
            // Note STATIQUE, jamais interactive, jamais une case à
            // cocher -- affichée UNE FOIS quand au moins une ligne
            // appariée a déjà une photo. Confirmer le lot (le bouton
            // ci-dessous) vaut déjà autorisation explicite -- rien de
            // plus à cocher.
            <p className="mb-3 rounded-xl border border-amber-300 bg-amber-100/60 px-3 py-2 text-xs font-medium text-amber-900">
              {t("mcBulkPhotoReplaceNotice")}
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={applying || validating || ready.length === 0}
            className="rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {applying
              ? t("mcBulkPhotoApplying")
              : t("mcBulkPhotoConfirm", { n: ready.length })}
          </button>
        </>
      )}

      {results && (
        <div className="mt-4 rounded-xl border border-stone-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold text-stone-800">
            {t("mcBulkPhotoResultSummary", {
              success: results.filter((r) => r.success).length,
              total: results.length,
            })}
          </p>
          <ul className="mb-2 space-y-1 text-xs">
            {results.map((r) => (
              <li
                key={r.fileKey}
                className={r.success ? "text-emerald-800" : "text-red-800"}
              >
                {r.success ? "✓" : "✗"} {r.fileName} → {r.productName}
                {!r.success && r.errorKey ? ` — ${t(r.errorKey)}` : ""}
                {r.success && r.cleanupWarning ? ` — ${t("mcBulkPhotoCleanupWarning")}` : ""}
                {r.success && r.cleanupOutcome === "failed" && (
                  <button
                    type="button"
                    onClick={() => void handleRetryCleanup(r.fileKey)}
                    disabled={retryingCleanupKeys.has(r.fileKey)}
                    className="ml-2 rounded-md border border-amber-400 bg-white px-1.5 py-0.5 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                  >
                    {retryingCleanupKeys.has(r.fileKey)
                      ? t("mcPhotoCleanupRetrying")
                      : t("mcPhotoCleanupRetry")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {results.some((r) => !r.success) && (
            <button
              type="button"
              onClick={() => void handleRetryFailed()}
              disabled={applying}
              className="rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 disabled:opacity-40"
            >
              {t("mcBulkPhotoRetryFailed")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
