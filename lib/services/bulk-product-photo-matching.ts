/**
 * BULK PRODUCT PHOTOS v1 -- appariement fichier -> produit (pur, sans I/O).
 *
 * Contexte (voir README-AUDIT.md / BULK-PHOTO-CONTRACT.md du lot) :
 * le catalogue Scanym ne possède aujourd'hui AUCUNE référence/SKU
 * commerçant stable et distincte de l'UUID interne (`menu_items.id`).
 * Le seul identifiant "métier" disponible côté commerçant est le NOM
 * du produit -- déjà utilisé comme clé d'appariement (sans garantie
 * d'unicité) par le module de prévisualisation d'import catalogue
 * (OB-3, `lib/catalogue-import/resolution.ts`), qui traite lui aussi
 * toute collision de nom comme un état AMBIGUOUS à ne jamais résoudre
 * automatiquement. Ce module suit exactement le même principe, en
 * restant totalement indépendant de `lib/catalogue-import/` (aucun
 * import, aucun couplage -- ce lot n'intègre PAS avec le pipeline
 * d'import catalogue, qui reste le territoire réservé d'un futur lot
 * séparé, voir le commentaire "OB-5" dans
 * lib/catalogue-import/validation.ts).
 *
 * Principe non négociable (mandat) : la comparaison est une égalité
 * EXACTE après une normalisation déterministe et documentée
 * (casse, espaces, séparateurs, accents) -- JAMAIS une correspondance
 * floue/approximative (pas de distance de Levenshtein, pas de
 * correspondance partielle, pas de tolérance aux fautes de frappe).
 * Une clé normalisée identique produit TOUJOURS le même résultat ;
 * il n'y a aucune notion de "meilleur score" ni de seuil de
 * similarité. C'est ce qui permet de qualifier ce module de
 * "déterministe" au sens du mandat, par opposition à un matching
 * flou qui ne pourrait jamais servir d'autorité de contenu.
 *
 * Aucune écriture, aucun appel réseau/Storage/RPC dans ce fichier :
 * la prévisualisation ne doit jamais avoir d'effet de bord (mandat
 * "preview performs no business mutation"). L'application réelle des
 * photos (upload + RPC) est effectuée ailleurs (BulkPhotoUpload.tsx),
 * exclusivement via `addOrReplaceProductPhoto` (déjà publié, V67),
 * jamais réimplémentée ici.
 *
 * EXTENSION v2.0 (BULK PRODUCT PHOTOS -- ONBOARDING MVP FINALIZATION,
 * décision CIO) -- HISTORIQUE, REMPLACÉE PAR v2.1 CI-DESSOUS. v2.0
 * introduisait un modèle "skip par défaut + override explicite PAR
 * LIGNE" (`replaceExistingPhoto` par candidat). Ce modèle est
 * intégralement retiré par v2.1 (voir ci-dessous) -- il n'en reste
 * plus aucune trace dans ce fichier.
 *
 * EXTENSION v2.1 (BUSINESS SCOPE SIMPLIFICATION / ONE-TIME ONBOARDING
 * / RE-ONBOARDING TOOL) -- HISTORIQUE, REMPLACÉE PAR v2.2 CI-DESSOUS.
 * v2.1 introduisait UNE SEULE confirmation GLOBALE ("Remplacer les
 * photos existantes", décochée par défaut) gouvernant uniformément les
 * lignes appariées ayant déjà une photo. Ce modèle est intégralement
 * retiré par v2.2 -- il n'en reste plus aucune trace dans ce fichier.
 *
 * EXTENSION v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, décision
 * CIO qui ANNULE ET REMPLACE la décision v2.1 ci-dessus). Clarification
 * métier autoritative, ENCORE plus simple que v2.1 : Bulk est un outil
 * d'onboarding/ré-onboarding OCCASIONNEL -- CONFIRMER L'IMPORT BULK
 * LUI-MÊME autorise le remplacement des photos existantes de TOUT
 * produit correctement apparié de ce lot. Il n'existe PLUS de mode
 * marche/arrêt de remplacement (le drapeau global `replaceExistingPhotos`
 * de v2.1 est intégralement retiré), et il n'y a JAMAIS eu de mode par
 * ligne. `getReadyToApply` redevient une garde PURE à 2 paramètres :
 * TOUTE ligne "matched" avec une cible résolue et sans erreur de
 * validation est prête, qu'elle ait ou non déjà une photo -- la
 * distinction "a déjà une photo" n'a plus AUCUNE incidence sur
 * l'inclusion (elle reste néanmoins affichée à titre PUREMENT
 * informatif dans l'UI, voir `hasExistingImageAtTarget` ci-dessous).
 * Après l'onboarding, les changements de photo normaux se font
 * manuellement depuis le catalogue (Single Photo Edit,
 * app/dashboard/catalogue/page.tsx, inchangé par ce lot). Le
 * mécanisme partagé de nettoyage Storage de l'ancienne image
 * (`product_photo_pending_cleanups`, claim/finalize/release, v1.8)
 * n'est PAS modifié par ce lot -- ni le mécanisme LOST HTTP RESPONSE /
 * SUCCESSFUL REPLAY, dont le blocker technique reste fermé mais par un
 * mécanisme DIFFÉRENT, strictement côté Node (chemin Storage
 * déterministe batchId + restaurant_id + product_id), voir
 * lib/server/product-photo-service.ts -- ce module PUR n'a besoin
 * d'aucun changement pour cela.
 */

export interface BulkPhotoMatchProduct {
  product_id: string;
  name: string;
  category_name: string;
  /** Produit archivé exclu de l'appariement (même garde que la RPC
   *  set_product_photo : `archived_at is null`). Filtré par
   *  `buildNameIndex`/`matchFilesByName`, mais conservé ici pour que
   *  l'appelant puisse passer directement le catalogue complet sans
   *  pré-filtrage. */
  archived_at: string | null;
  image_url: string | null;
}

export type BulkPhotoFileState =
  | "matched"
  | "ambiguous"
  | "unmatched"
  | "conflict"
  | "invalid";

export type BulkPhotoValidationError = "too_large" | "invalid_type" | null;

export interface BulkPhotoCandidate {
  /** Clé stable au sein d'un lot (index de sélection) -- un objet
   *  File n'est pas comparable de façon fiable (deux fichiers
   *  identiques en apparence peuvent être deux entrées distinctes de
   *  la FileList), donc jamais utilisé comme identité. */
  fileKey: string;
  fileName: string;
  fileSize: number;
  state: BulkPhotoFileState;
  /** Suggestion automatique par nom normalisé -- `null` si aucune
   *  correspondance unique n'a été trouvée. Ne change jamais après le
   *  calcul initial (contrairement à `resolvedProductId`) : sert de
   *  référence pour l'affichage ("suggestion : ..."). */
  autoMatchedProductId: string | null;
  /** Candidats en cas d'ambiguïté (2+ produits partageant la même clé
   *  normalisée) -- vide sinon. */
  ambiguousProductIds: string[];
  /** Cible finale retenue après résolution manuelle éventuelle.
   *  `null` = fichier exclu de l'application (non résolu). */
  resolvedProductId: string | null;
  /** Renseigné uniquement par l'appelant, après validation binaire
   *  asynchrone du fichier (voir validateProductPhotoFile côté
   *  lib/services/product-photo.ts) -- ce module ne lit jamais le
   *  contenu d'un fichier. */
  validationError: BulkPhotoValidationError;
}

/**
 * Normalisation déterministe d'une chaîne pour comparaison :
 * NFKC (accents/caractères composés canonicalisés), tirets/underscores
 * traités comme des séparateurs de mots (convention de nommage de
 * fichier "PRODUCT_REFERENCE.jpg" du mandat), espaces multiples
 * réduits à un seul, casse ignorée, espaces de bord retirés.
 *
 * Exporté pour être testé directement et pour rester la SEULE
 * définition de "normalisation" du module (jamais dupliquée).
 */
export function normalizeMatchKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Nom de fichier sans son extension (dernier "." uniquement -- un nom
 *  sans extension est retourné inchangé). */
export function stripFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0) return fileName;
  return fileName.slice(0, idx);
}

/**
 * Index nom-normalisé -> liste des product_id qui y correspondent.
 * Les produits archivés sont exclus (jamais une cible valide -- même
 * garde que `set_product_photo`, qui refuse silencieusement toute
 * mise à jour sur un produit dont `archived_at is not null`).
 */
export function buildNameIndex(
  products: BulkPhotoMatchProduct[]
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const p of products) {
    if (p.archived_at !== null) continue;
    const key = normalizeMatchKey(p.name);
    const existing = index.get(key);
    if (existing) {
      existing.push(p.product_id);
    } else {
      index.set(key, [p.product_id]);
    }
  }
  return index;
}

/**
 * Phase A -- appariement initial par nom, à partir des SEULS noms de
 * fichiers (aucune lecture de contenu). Synchrone et pur.
 */
export function matchFilesByName(
  files: { name: string; size: number }[],
  products: BulkPhotoMatchProduct[]
): BulkPhotoCandidate[] {
  const index = buildNameIndex(products);

  return files.map((file, i) => {
    const key = normalizeMatchKey(stripFileExtension(file.name));
    const candidateIds = index.get(key) ?? [];

    const base = {
      fileKey: `f${i}`,
      fileName: file.name,
      fileSize: file.size,
      validationError: null as BulkPhotoValidationError,
    };

    if (candidateIds.length === 1) {
      return {
        ...base,
        state: "matched" as const,
        autoMatchedProductId: candidateIds[0],
        ambiguousProductIds: [],
        resolvedProductId: candidateIds[0],
      };
    }

    if (candidateIds.length > 1) {
      return {
        ...base,
        state: "ambiguous" as const,
        autoMatchedProductId: null,
        ambiguousProductIds: candidateIds,
        // Aucune écriture automatique en cas d'ambiguïté (mandat :
        // "ambiguous match -> no automatic write") -- l'utilisateur
        // doit choisir explicitement.
        resolvedProductId: null,
      };
    }

    return {
      ...base,
      state: "unmatched" as const,
      autoMatchedProductId: null,
      ambiguousProductIds: [],
      resolvedProductId: null,
    };
  });
}

/**
 * Phase B -- fusionne le résultat de la validation binaire
 * asynchrone (effectuée par l'appelant, un seul fichier à la fois,
 * via validateProductPhotoFile). Un fichier invalide reste marqué
 * "invalid" quel que soit son état d'appariement -- ne peut jamais
 * être appliqué, même s'il a par ailleurs une correspondance unique.
 */
export function applyValidationResult(
  candidates: BulkPhotoCandidate[],
  fileKey: string,
  error: BulkPhotoValidationError
): BulkPhotoCandidate[] {
  return candidates.map((c) =>
    c.fileKey === fileKey
      ? {
          ...c,
          validationError: error,
          state: error ? ("invalid" as const) : c.state,
        }
      : c
  );
}

/**
 * Résolution manuelle explicite par l'utilisateur (choix dans un
 * menu déroulant pour un fichier ambigu/non apparié, ou correction
 * d'une suggestion automatique). `productId = null` retire toute
 * cible (fichier exclu de l'application).
 *
 * Ne recalcule PAS les conflits -- appeler `resolveConflicts` juste
 * après (séparation volontaire : permet d'appliquer plusieurs
 * corrections manuelles d'affilée avant de recalculer une seule
 * fois, ex. dans un traitement par lot de l'UI).
 */
export function applyManualMatch(
  candidates: BulkPhotoCandidate[],
  fileKey: string,
  productId: string | null
): BulkPhotoCandidate[] {
  return candidates.map((c) => {
    if (c.fileKey !== fileKey) return c;
    if (c.validationError) {
      // Un fichier invalide ne devient jamais "matched" par un choix
      // manuel -- la validation de contenu prime toujours.
      return { ...c, resolvedProductId: productId };
    }
    return {
      ...c,
      resolvedProductId: productId,
      state: productId ? ("matched" as const) : ("unmatched" as const),
    };
  });
}

/**
 * Phase C -- détecte les conflits : deux fichiers (ou plus) du même
 * lot dont la résolution actuelle pointe vers le MÊME product_id.
 * Mandat : "duplicate files for same product -> explicit conflict",
 * "one file must not silently update multiple products" (la
 * réciproque -- un même produit ne doit jamais recevoir deux photos
 * différentes dans la même confirmation sans que l'utilisateur ne le
 * voie et ne tranche).
 *
 * Un fichier "invalid" n'entre jamais dans le calcul de conflit (il
 * ne sera de toute façon jamais appliqué).
 */
export function resolveConflicts(
  candidates: BulkPhotoCandidate[]
): BulkPhotoCandidate[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (c.validationError) continue;
    if (!c.resolvedProductId) continue;
    counts.set(
      c.resolvedProductId,
      (counts.get(c.resolvedProductId) ?? 0) + 1
    );
  }

  return candidates.map((c) => {
    if (c.validationError) return c;
    if (!c.resolvedProductId) return c;
    const count = counts.get(c.resolvedProductId) ?? 0;
    if (count > 1 && c.state !== "conflict") {
      return { ...c, state: "conflict" as const };
    }
    if (count <= 1 && c.state === "conflict") {
      // Le conflit vient d'être résolu (l'utilisateur a réassigné ou
      // exclu l'un des fichiers concurrents) -- redevient "matched"
      // puisqu'une cible reste assignée.
      return { ...c, state: "matched" as const };
    }
    return c;
  });
}

/**
 * La cible actuellement résolue pour `candidate` a-t-elle déjà une
 * photo (`image_url` non nul) dans le catalogue fourni ? `false` si
 * aucune cible n'est résolue (ambiguous/unmatched/conflict) -- cette
 * notion n'a alors pas de sens. Pure, sans I/O : lit uniquement le
 * catalogue déjà chargé par l'appelant (jamais un fetch).
 *
 * v2.2 : CONSERVÉE, mais n'alimente PLUS AUCUNE garde (v2.1 l'utilisait
 * pour piloter la case à cocher globale ET la garde de
 * `getReadyToApply` -- toutes deux retirées). Sert désormais
 * UNIQUEMENT à afficher un indicateur PASSIF, informatif, par ligne
 * ("Photo déjà présente") -- n'a plus AUCUNE incidence sur ce qui est
 * appliqué : Bulk confirmé remplace toujours, avec ou sans photo
 * existante.
 */
export function hasExistingImageAtTarget(
  candidate: BulkPhotoCandidate,
  products: BulkPhotoMatchProduct[]
): boolean {
  if (!candidate.resolvedProductId) return false;
  const target = products.find((p) => p.product_id === candidate.resolvedProductId);
  return !!target?.image_url;
}

/** Sous-ensemble prêt à être appliqué : candidats "matched" avec une
 *  cible résolue et sans erreur de validation. Tout le reste
 *  (ambiguous/unmatched/conflict/invalid) est explicitement exclu de
 *  la confirmation -- jamais une écriture "au mieux" sur un état
 *  incertain.
 *
 *  RÉÉCRITE v2.2 (FINAL SIMPLIFICATION, décision CIO qui ANNULE ET
 *  REMPLACE la garde par-drapeau-global v2.1, elle-même remplaçante de
 *  la garde par-ligne v2.0) : CONFIRMER LE LOT BULK LUI-MÊME autorise
 *  le remplacement de TOUT produit correctement apparié -- il n'y a
 *  PLUS aucun paramètre de remplacement, ni global ni par ligne.
 *  `products` reste un paramètre de cette fonction (signature stable,
 *  et potentiellement utile à un appelant futur) mais n'est PLUS LU
 *  du tout par cette garde -- `hasExistingImageAtTarget` (conservée
 *  plus haut) n'alimente plus que l'affichage :
 *
 *    matched + no existing image      -> included
 *    matched + existing image         -> included (INCHANGÉ -- Bulk
 *                                         confirmé remplace toujours)
 *
 *  Aucune notion de TOCTOU/comparaison optimiste image_url ici NON
 *  PLUS (mandat v2.2, inchangé depuis v2.1 sur ce point précis) : un
 *  fichier apparu entre la prévisualisation et la confirmation reste
 *  couvert par cette même autorisation de lot.
 */
export function getReadyToApply(
  candidates: BulkPhotoCandidate[],
  products: BulkPhotoMatchProduct[]
): { fileKey: string; productId: string }[] {
  void products; // v2.2 -- n'alimente plus la garde, voir commentaire ci-dessus.
  return candidates
    .filter(
      (c) => c.state === "matched" && c.resolvedProductId !== null && !c.validationError
    )
    .map((c) => ({ fileKey: c.fileKey, productId: c.resolvedProductId as string }));
}

export interface BulkPhotoCounts {
  total: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  conflict: number;
  invalid: number;
}

export function countByState(candidates: BulkPhotoCandidate[]): BulkPhotoCounts {
  const counts: BulkPhotoCounts = {
    total: candidates.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    conflict: 0,
    invalid: 0,
  };
  for (const c of candidates) {
    counts[c.state] += 1;
  }
  return counts;
}
