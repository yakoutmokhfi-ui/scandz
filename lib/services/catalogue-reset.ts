import { supabase } from "@/lib/supabase";

/**
 * Scanym — CLAUDE NOUGARO
 * OPERATOR BACKOFFICE — SAFE CATALOGUE RESET v1.1.
 *
 * Couche service pure pour `preview_catalogue_reset`/
 * `reset_merchant_catalogue` (supabase/DRAFT-lot-operator-catalogue-
 * reset-v1.sql). Fichier ENTIÈREMENT ADDITIF -- aucune fonction
 * existante de lib/services/dashboard.ts n'est modifiée, aucun fichier
 * de lib/catalogue-import (ni lib/services/catalogue-import) n'est
 * touché par CE fichier (mandat §18/§22, "must not break importer
 * assumptions" -- le filtrage is_active nécessaire à l'import est fait
 * dans lib/catalogue-import/resolution.ts, voir ce fichier).
 *
 * SERVER-SIDE AUTHORITY (mandat §8) : l'autorisation réelle
 * (`is_scanym_operator()`, sans repli owner/manager) est vérifiée À
 * L'INTÉRIEUR des deux fonctions PostgreSQL SECURITY DEFINER, jamais
 * ici.
 *
 * v1.1 -- STRONG CONFIRMATION SERVEUR (remédiation CTO) : v1
 * transmettait `restaurantId` seul à `reset_merchant_catalogue`, la
 * phrase de confirmation n'étant validée que côté UI -- un appel RPC
 * direct (contournant l'UI) pouvait donc déclencher un reset réel
 * sans jamais prouver la confirmation. Corrigé : `resetMerchantCatalogue`
 * transmet désormais `p_confirmation_phrase` au serveur, qui dérive
 * lui-même la phrase attendue depuis `restaurants.name` (jamais
 * depuis une valeur fournie ici) et compare EXACTEMENT -- ce module
 * ne fait que relayer ce que l'opérateur a saisi, il ne "sait" jamais
 * si c'est correct avant que le serveur ne le dise. Une réponse
 * `result = 'rejected_confirmation'` est TOUJOURS traduite en erreur
 * levée par cette fonction (voir CatalogueResetConfirmationMismatchError
 * ci-dessous) -- aucun appelant ne peut jamais la confondre avec un
 * succès.
 *
 * v1.1 -- la phrase de confirmation N'EST PLUS mise en MAJUSCULES
 * (v1 utilisait `toLocaleUpperCase("fr-FR")`, uniquement côté client).
 * Abandonné : PostgreSQL `upper()` n'est pas garanti identique à
 * `toLocaleUpperCase("fr-FR")` sur des caractères accentués selon la
 * collation de la base -- risque réel de rejet serveur d'une
 * confirmation pourtant correctement recopiée par l'opérateur. v1.1
 * compare le nom du marchand tel quel (casse réelle), seuls les
 * espaces de bordure de la SAISIE opérateur sont ignorés -- comparaison
 * exacte, littérale, identique des deux côtés par construction (le nom
 * affiché à l'opérateur provient de la même source de vérité,
 * `restaurants.name`, que celle relue indépendamment par le serveur).
 */

/** Résultat en LECTURE SEULE de `preview_catalogue_reset` -- aucun appel
 *  de ce module n'entraîne jamais de mutation tant que
 *  `resetMerchantCatalogue` n'est pas explicitement appelée séparément. */
export interface CatalogueResetPreview {
  restaurantId: string;
  /** Produits actuellement actifs (archived_at IS NULL) qui seront
   *  archivés par un commit. */
  activeProductsCount: number;
  /** Produits déjà archivés AVANT ce reset (contexte, jamais
   *  re-comptés par un commit). */
  archivedProductsCount: number;
  subcategoriesTotal: number;
  /** Sous-catégories structurellement vides (aucun produit, actif ou
   *  archivé) -- seront physiquement supprimées par un commit. */
  subcategoriesRemovable: number;
  /** Sous-catégories qui portent au moins un produit (même archivé) --
   *  seront RETENUES (jamais supprimées) ET DÉSACTIVÉES (v1.1,
   *  is_active = false -- mandat §12/v1.1 §2). */
  subcategoriesRetained: number;
  categoriesTotal: number;
  /** Catégories structurellement vides (aucun produit, aucune
   *  sous-catégorie) -- seront physiquement supprimées par un commit. */
  categoriesRemovable: number;
  /** Catégories qui portent au moins un produit ou une sous-catégorie
   *  -- seront RETENUES (jamais supprimées) ET DÉSACTIVÉES (v1.1,
   *  mandat §13/v1.1 §2). */
  categoriesRetained: number;
  /** Signal optionnel "cheaply available" (mandat §6) : nombre de
   *  produits actifs déjà référencés par au moins une commande
   *  historique de ce restaurant. Informationnel uniquement -- ce
   *  lot archive TOUS les produits actifs sans exception, qu'ils
   *  aient ou non un historique de commande. */
  productsWithOrderHistory: number;
  /** v1.1 (mandat §5) -- catégories qui resteront ACTIVES après un
   *  reset réel. TOUJOURS 0 par construction : ce lot désactive sans
   *  condition chaque catégorie retenue (voir supabase/DRAFT-lot-
   *  operator-catalogue-reset-v1.sql). */
  categoriesActiveAfterReset: number;
  /** v1.1 -- équivalent sous-catégories de categoriesActiveAfterReset,
   *  également toujours 0. */
  subcategoriesActiveAfterReset: number;
}

/** Résultat d'un `reset_merchant_catalogue` réellement exécuté (mutation
 *  RÉELLE -- `result` vaut `"completed"` ou `"no_op"`). Une confirmation
 *  refusée par le serveur ne produit JAMAIS cette forme -- voir
 *  `CatalogueResetConfirmationMismatchError`. */
export interface CatalogueResetResult {
  restaurantId: string;
  productsArchived: number;
  subcategoriesRemoved: number;
  subcategoriesRetained: number;
  categoriesRemoved: number;
  categoriesRetained: number;
  /** v1.1 (mandat §5) -- toujours 0 pour un résultat "completed"/
   *  "no_op" réel (voir CatalogueResetPreview.categoriesActiveAfterReset). */
  categoriesActiveAfterReset: number;
  subcategoriesActiveAfterReset: number;
  /** Toujours `true` par construction de ce lot : aucun produit n'est
   *  jamais supprimé physiquement, aucune ligne order_items n'est
   *  jamais mutée -- voir supabase/DRAFT-lot-operator-catalogue-
   *  reset-v1.sql et sa preuve réelle
   *  supabase/tests/operator-catalogue-reset-v1-check.sh. */
  historicalOrdersPreserved: true;
  /** 'no_op' quand rien n'avait besoin d'être muté (reset répété sur un
   *  catalogue déjà réinitialisé -- mandat §16, idempotency). */
  result: "completed" | "no_op";
}

/**
 * v1.1 -- levée par `resetMerchantCatalogue` quand le serveur a
 * répondu `result = 'rejected_confirmation'` : la phrase transmise ne
 * correspondait PAS à la phrase attendue, dérivée côté serveur depuis
 * le nom ACTUEL du marchand. Zéro mutation n'a eu lieu (garanti côté
 * PostgreSQL, voir supabase/DRAFT-lot-operator-catalogue-reset-v1.sql)
 * -- jamais confondue avec un succès par un appelant, y compris un
 * appel RPC direct contournant complètement cette couche/l'UI.
 */
export class CatalogueResetConfirmationMismatchError extends Error {
  constructor() {
    super("Catalogue reset confirmation phrase mismatch — rejected server-side, zero mutation.");
    this.name = "CatalogueResetConfirmationMismatchError";
  }
}

type PreviewRpcRow = {
  restaurant_id: string;
  active_products_count: number;
  archived_products_count: number;
  subcategories_total: number;
  subcategories_removable: number;
  subcategories_retained: number;
  categories_total: number;
  categories_removable: number;
  categories_retained: number;
  products_with_order_history: number;
  categories_active_after_reset: number;
  subcategories_active_after_reset: number;
};

type ResetRpcRow = {
  restaurant_id: string;
  products_archived: number;
  subcategories_removed: number;
  subcategories_retained: number;
  categories_removed: number;
  categories_retained: number;
  categories_active_after_reset: number;
  subcategories_active_after_reset: number;
  historical_orders_preserved: boolean;
  result: string;
};

/**
 * LECTURE SEULE (mandat §6, "Preview must be read-only" / "Repeated
 * preview: NO mutation"). Lève une erreur si l'appelant n'est pas un
 * opérateur Scanym autorisé (42501, traduit tel quel depuis le
 * message RPC -- jamais réinterprété/masqué ici) ou si le restaurant
 * est introuvable (P0002).
 */
export async function previewCatalogueReset(
  restaurantId: string
): Promise<CatalogueResetPreview> {
  const { data, error } = await supabase.rpc("preview_catalogue_reset", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as PreviewRpcRow[];
  const row = rows[0];
  if (!row) throw new Error("Empty preview result");

  return {
    restaurantId: row.restaurant_id,
    activeProductsCount: row.active_products_count,
    archivedProductsCount: row.archived_products_count,
    subcategoriesTotal: row.subcategories_total,
    subcategoriesRemovable: row.subcategories_removable,
    subcategoriesRetained: row.subcategories_retained,
    categoriesTotal: row.categories_total,
    categoriesRemovable: row.categories_removable,
    categoriesRetained: row.categories_retained,
    productsWithOrderHistory: row.products_with_order_history,
    categoriesActiveAfterReset: row.categories_active_after_reset,
    subcategoriesActiveAfterReset: row.subcategories_active_after_reset,
  };
}

/**
 * MUTATION réelle (mandat §7, uniquement après confirmation explicite
 * côté UI -- voir buildCatalogueResetConfirmationPhrase/
 * isCatalogueResetConfirmationPhraseValid ci-dessous, utilisées par
 * l'appelant pour activer le bouton de commit AVANT d'invoquer cette
 * fonction).
 *
 * v1.1 -- `confirmationPhrase` (la saisie BRUTE de l'opérateur, non
 * transformée) est désormais TRANSMISE au serveur, qui est la seule
 * autorité réelle : `reset_merchant_catalogue` re-dérive et compare
 * lui-même la phrase attendue depuis `restaurants.name`, jamais
 * depuis une valeur calculée ici. Un mismatch serveur (y compris
 * phrase vide/absente/pour un autre marchand/différente en casse ou
 * en espaces internes) lève TOUJOURS `CatalogueResetConfirmationMismatchError`
 * -- jamais un `CatalogueResetResult` "réussi".
 *
 * Recalcule tout côté serveur à l'instant de l'appel (mandat §10,
 * "Do not rely only on stale preview counts") -- ce module ne
 * transmet JAMAIS de compteurs déjà affichés, uniquement
 * `restaurantId`/`confirmationPhrase`.
 */
export async function resetMerchantCatalogue(
  restaurantId: string,
  confirmationPhrase: string
): Promise<CatalogueResetResult> {
  const { data, error } = await supabase.rpc("reset_merchant_catalogue", {
    p_restaurant_id: restaurantId,
    p_confirmation_phrase: confirmationPhrase,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ResetRpcRow[];
  const row = rows[0];
  if (!row) throw new Error("Empty reset result");

  if (row.result === "rejected_confirmation") {
    throw new CatalogueResetConfirmationMismatchError();
  }

  const result: "completed" | "no_op" = row.result === "no_op" ? "no_op" : "completed";

  return {
    restaurantId: row.restaurant_id,
    productsArchived: row.products_archived,
    subcategoriesRemoved: row.subcategories_removed,
    subcategoriesRetained: row.subcategories_retained,
    categoriesRemoved: row.categories_removed,
    categoriesRetained: row.categories_retained,
    categoriesActiveAfterReset: row.categories_active_after_reset,
    subcategoriesActiveAfterReset: row.subcategories_active_after_reset,
    historicalOrdersPreserved: true,
    result,
  };
}

/**
 * Phrase de confirmation déterministe (mandat §7) : "RESET " + le nom
 * du marchand TEL QUEL (v1.1 -- plus de transformation de casse, voir
 * en-tête de ce fichier). Pure, sans effet de bord, testable
 * indépendamment de tout appel réseau -- DOIT produire exactement la
 * même chaîne que celle dérivée côté serveur depuis `restaurants.name`
 * (supabase/DRAFT-lot-operator-catalogue-reset-v1.sql), pour la même
 * valeur de `merchantName`.
 *
 * Exemple : "Au Lait Cru" -> "RESET Au Lait Cru".
 */
export function buildCatalogueResetConfirmationPhrase(merchantName: string): string {
  return `RESET ${merchantName.trim()}`;
}

/**
 * Comparaison STRICTE (mandat §7, "The user must type the exact
 * confirmation phrase" -- jamais une comparaison insensible à la
 * casse ou aux espaces internes, seuls les espaces de bordure de la
 * saisie utilisateur sont ignorés, pas ceux de la phrase attendue
 * elle-même). Utilisée UNIQUEMENT pour activer/désactiver le bouton
 * de commit côté UI (garde-fou anti-clic-accidentel) -- la garantie de
 * sécurité RÉELLE est la revalidation serveur dans
 * `resetMerchantCatalogue` ci-dessus, jamais celle-ci seule.
 */
export function isCatalogueResetConfirmationPhraseValid(
  typedPhrase: string,
  merchantName: string
): boolean {
  return typedPhrase.trim() === buildCatalogueResetConfirmationPhrase(merchantName);
}
