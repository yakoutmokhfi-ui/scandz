/**
 * Scanym — OPERATOR BACKOFFICE — OB-4 v1.1.
 * CATALOGUE IMPORT COMMIT / IDEMPOTENCY — orchestration IMPURE (réseau
 * Supabase, RPC mutantes) : "Preview approved -> explicit Confirm
 * import -> server-side revalidation -> deterministic catalogue commit
 * -> result summary. No automatic commit."
 *
 * SERVER-SIDE REVALIDATION (ce dépôt n'a pas de couche API séparée --
 * chaque RPC SECURITY DEFINER EST l'autorité serveur, cf. OB-2) :
 * `commitCatalogueImport` ré-exécute intégralement
 * `analyzeCatalogueImportFile` -- relecture du fichier local ET
 * relecture FRAÎCHE de `getMerchantCatalogue` -- au tout début de
 * l'appel. AUCUN `PreviewReport` fourni par l'appelant n'est jamais
 * accepté en paramètre : un objet Preview conservé en mémoire
 * navigateur (potentiellement manipulé -- DevTools, extension, bug
 * d'état React) n'a donc AUCUNE influence sur ce qui est réellement
 * écrit. C'est la traduction directe, dans une architecture sans
 * backend séparé, de l'exigence mandat "re-derive plannedAction fresh
 * at commit time... never trust client-posted plannedAction" / "Do not
 * rely on client/browser pre-checks for concurrency safety".
 *
 * IDEMPOTENCE / CONCURRENCE : la sécurité structurelle vient de
 * idx_menu_items_unique_active_name (OB-4 v1.1 SQL) -- ce module ne
 * fait JAMAIS de "vérifier puis écrire" applicatif, il laisse toujours
 * la contrainte serveur trancher et traite le rejet (23505 ->
 * *DuplicateNameError) comme un signal de convergence, jamais une
 * anomalie à propager telle quelle.
 *
 * TRANSACTION MODEL (documenté explicitement, mandat v1.1) : AUCUNE
 * transaction unique ne couvre l'ensemble de l'import -- chaque ligne
 * (et chaque création de catégorie/sous-catégorie) est un appel RPC
 * indépendant. Une ligne en échec n'empêche JAMAIS l'exécution des
 * lignes suivantes (best-effort, maximise la progression utile) --
 * voir IDEMPOTENCY-EVIDENCE.md pour le détail "ce qui peut réussir
 * avant qu'une ligne postérieure échoue" et "comment une ré-exécution
 * converge" (réponse courte : en relisant `getMerchantCatalogue` à
 * chaque appel, exactement comme au tout début de cette fonction --
 * toute ligne déjà appliquée ressort EXISTING/SKIP à la ré-exécution,
 * jamais recréée).
 *
 * STRICT SCOPE (mandat) : catégories, sous-catégories, produits
 * UNIQUEMENT. AUCUN upload Storage, AUCUNE persistance Tags/
 * Collections, AUCUNE écriture liée à Photo (le nom de fichier est lu
 * par preview.ts mais n'est JAMAIS transmis à create_product/
 * update_product ici -- aucun paramètre photo n'existe sur ces RPC).
 */

import { analyzeCatalogueImportFile } from "@/lib/services/catalogue-import";
import type { CatalogueImportStructuralError } from "@/lib/services/catalogue-import";
import { buildCommitPlan } from "@/lib/catalogue-import/commit-plan";
import { normalizedKey } from "@/lib/catalogue-import/normalization";
import type { PreviewReport } from "@/lib/catalogue-import/types";
import {
  createCategory,
  createSubcategory,
  createProduct,
  updateProduct,
  CategoryDuplicateNameError,
  SubcategoryDuplicateNameError,
  ProductDuplicateNameError,
} from "@/lib/services/dashboard";

export type CommitRowOutcome = "CREATED" | "UPDATED" | "SKIPPED" | "FAILED";

export interface CommitRowResult {
  row: number;
  outcome: CommitRowOutcome;
  /** productId concerné -- id créé (CREATED), id existant (UPDATED,
   *  SKIPPED), absent pour FAILED. */
  productId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CatalogueImportCommitSummary {
  kind: "COMMITTED";
  fileName: string;
  categoriesCreated: number;
  subcategoriesCreated: number;
  productsCreated: number;
  productsUpdated: number;
  productsSkipped: number;
  productsFailed: number;
  rows: CommitRowResult[];
}

/** Le fichier revalidé n'est PLUS éligible (au moins un blocage
 *  persiste après relecture fraîche -- ex. le catalogue a changé entre
 *  l'affichage du Preview et la Confirmation) : AUCUNE écriture n'est
 *  tentée, le `report` frais est renvoyé pour ré-affichage. */
export interface CatalogueImportNotEligible {
  kind: "NOT_ELIGIBLE";
  report: PreviewReport;
}

export type CatalogueImportCommitResult =
  | CatalogueImportStructuralError
  | CatalogueImportNotEligible
  | CatalogueImportCommitSummary;

interface CreationFailure {
  code?: string;
  message: string;
}

/**
 * Point d'entrée COMMIT du mandat OB-4 v1.1. `file`/`restaurantId` --
 * jamais un `PreviewReport` -- sont les SEULES entrées acceptées : voir
 * le commentaire d'en-tête (SERVER-SIDE REVALIDATION).
 */
export async function commitCatalogueImport(
  file: File,
  restaurantId: string
): Promise<CatalogueImportCommitResult> {
  const analysis = await analyzeCatalogueImportFile(file, restaurantId);
  if (analysis.kind === "STRUCTURAL_ERROR") return analysis;

  const { report } = analysis;
  if (report.eligibility === "NOT_ELIGIBLE") {
    return { kind: "NOT_ELIGIBLE", report };
  }

  const plan = buildCommitPlan(report);
  const categoryIdByKey = new Map<string, string>();
  const subcategoryIdByKey = new Map<string, string>();

  // Amorçage : catégories/sous-catégories DÉJÀ existantes (résolution
  // EXISTING) -- une clé normalisée donnée est TOUJOURS résolue de la
  // même façon pour toutes les lignes qui la référencent
  // (resolveCategoriesForRows/resolveSubcategoriesForRows, garanti),
  // donc cet amorçage ne peut jamais entrer en conflit avec les
  // créations de la section suivante.
  for (const row of report.rows) {
    if (row.resolvedCategory.state === "EXISTING" && row.resolvedCategory.existingId) {
      categoryIdByKey.set(normalizedKey(row.normalizedValues.categoryNameRaw), row.resolvedCategory.existingId);
    }
    if (row.resolvedSubcategory?.state === "EXISTING" && row.resolvedSubcategory.existingId) {
      const catKey = normalizedKey(row.normalizedValues.categoryNameRaw);
      const subKey = normalizedKey(row.normalizedValues.subcategoryNameRaw);
      subcategoryIdByKey.set(`${catKey}\0${subKey}`, row.resolvedSubcategory.existingId);
    }
  }

  // ------------------------------------------------------------
  // 1. Catégories WOULD_CREATE -- une fois par clé (plan déjà dédupliqué).
  // ------------------------------------------------------------
  let categoriesCreated = 0;
  const categoryCreationFailure = new Map<string, CreationFailure>();
  for (const entry of plan.categoriesToCreate) {
    try {
      const id = await createCategory(restaurantId, entry.displayName);
      categoryIdByKey.set(entry.key, id);
      categoriesCreated++;
    } catch (e) {
      // Concurrence réelle (une autre session a créé cette catégorie
      // entre la relecture fraîche ci-dessus et cet appel) : jamais
      // deviner son id -- toute ligne qui en dépend échoue proprement
      // (FAILED), récupérable par une simple ré-exécution du commit
      // (la relecture fraîche du prochain appel la verra EXISTING).
      categoryCreationFailure.set(entry.key, {
        code: e instanceof CategoryDuplicateNameError ? "SCANYM_CATEGORY_DUPLICATE_NAME" : undefined,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ------------------------------------------------------------
  // 2. Sous-catégories WOULD_CREATE -- même principe.
  // ------------------------------------------------------------
  let subcategoriesCreated = 0;
  const subcategoryCreationFailure = new Map<string, CreationFailure>();
  for (const entry of plan.subcategoriesToCreate) {
    const categoryId = categoryIdByKey.get(entry.categoryKey);
    if (!categoryId) {
      subcategoryCreationFailure.set(entry.key, {
        message: "Catégorie parente non disponible (échec de création de la catégorie ci-dessus).",
      });
      continue;
    }
    try {
      const id = await createSubcategory(categoryId, entry.displayName);
      subcategoryIdByKey.set(entry.key, id);
      subcategoriesCreated++;
    } catch (e) {
      subcategoryCreationFailure.set(entry.key, {
        code: e instanceof SubcategoryDuplicateNameError ? "SCANYM_SUBCATEGORY_DUPLICATE_NAME" : undefined,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ------------------------------------------------------------
  // 3. Produits -- une exécution par ligne, dans l'ordre du fichier.
  //    Best-effort (voir TRANSACTION MODEL en en-tête de fichier).
  // ------------------------------------------------------------
  const rows: CommitRowResult[] = [];
  let productsCreated = 0;
  let productsUpdated = 0;
  let productsSkipped = 0;
  let productsFailed = 0;

  for (const row of report.rows) {
    // Ne devrait jamais se produire : l'éligibilité du fichier entier a
    // déjà été vérifiée ci-dessus (report.eligibility !== NOT_ELIGIBLE
    // implique zéro ligne BLOCKED). Filet de sécurité déterministe.
    if (row.plannedAction === "BLOCKED") continue;

    const categoryKey = normalizedKey(row.normalizedValues.categoryNameRaw);
    const categoryId = categoryIdByKey.get(categoryKey);
    if (!categoryId) {
      const failure = categoryCreationFailure.get(categoryKey);
      rows.push({
        row: row.row,
        outcome: "FAILED",
        errorCode: failure?.code,
        errorMessage: failure?.message ?? "Catégorie non disponible.",
      });
      productsFailed++;
      continue;
    }

    let subcategoryId: string | null = null;
    if (row.resolvedSubcategory) {
      const subKey = normalizedKey(row.normalizedValues.subcategoryNameRaw);
      const scoped = `${categoryKey}\0${subKey}`;
      const id = subcategoryIdByKey.get(scoped);
      if (!id) {
        const failure = subcategoryCreationFailure.get(scoped);
        rows.push({
          row: row.row,
          outcome: "FAILED",
          errorCode: failure?.code,
          errorMessage: failure?.message ?? "Sous-catégorie non disponible.",
        });
        productsFailed++;
        continue;
      }
      subcategoryId = id;
    }

    if (row.plannedAction === "SKIP") {
      rows.push({ row: row.row, outcome: "SKIPPED", productId: row.productMatch.existingId });
      productsSkipped++;
      continue;
    }

    const values = row.normalizedValues;
    // Filet de sécurité déterministe (jamais censé se déclencher : une
    // ligne CREATE/UPDATE d'un fichier éligible a toujours un prix
    // numérique valide, cf. validateRow) -- jamais transmettre une
    // valeur non numérique à create_product/update_product.
    if (typeof values.price !== "number" || !Number.isFinite(values.price)) {
      rows.push({
        row: row.row,
        outcome: "FAILED",
        errorMessage: "Prix invalide (incohérence interne -- ne devrait jamais se produire pour une ligne éligible).",
      });
      productsFailed++;
      continue;
    }

    const fiscal = {
      taxRate: values.taxRate ?? null,
      unitWeightGrams: values.unitWeightGrams ?? null,
      weightIsApproximate: values.weightIsApproximate,
    };

    try {
      if (row.plannedAction === "CREATE") {
        const productId = await createProduct(
          categoryId,
          values.name,
          values.description,
          values.price,
          values.shortDescription,
          fiscal,
          subcategoryId
        );
        rows.push({ row: row.row, outcome: "CREATED", productId });
        productsCreated++;
      } else if (row.plannedAction === "UPDATE" && row.productMatch.existingId) {
        await updateProduct(
          row.productMatch.existingId,
          values.name,
          values.description,
          values.price,
          values.shortDescription,
          fiscal,
          subcategoryId
        );
        rows.push({ row: row.row, outcome: "UPDATED", productId: row.productMatch.existingId });
        productsUpdated++;
      } else {
        // AMBIGUOUS_DUPLICATE sans erreur bloquante -- même filet de
        // sécurité déterministe que preview.ts (ne devrait jamais se
        // produire, validateRow bloque toujours ce cas).
        rows.push({ row: row.row, outcome: "FAILED", errorMessage: "État de ligne inattendu." });
        productsFailed++;
      }
    } catch (e) {
      rows.push({
        row: row.row,
        outcome: "FAILED",
        errorCode: e instanceof ProductDuplicateNameError ? "SCANYM_PRODUCT_DUPLICATE_NAME" : undefined,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      productsFailed++;
    }
  }

  return {
    kind: "COMMITTED",
    fileName: analysis.fileName,
    categoriesCreated,
    subcategoriesCreated,
    productsCreated,
    productsUpdated,
    productsSkipped,
    productsFailed,
    rows,
  };
}
