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
 * STRICT SCOPE : catégories, sous-catégories, produits, et -- depuis
 * COLLECTIONS / TAGS FOUNDATION v1 -- association des Tags/Collections
 * aux produits écrits (via la RPC add_product_tags, idempotente et
 * STRICTEMENT ADDITIVE : un import n'enlève jamais un tag posé à la
 * main). Un échec d'association ne fait jamais échouer la ligne : le
 * produit est écrit, l'échec est compté à part (tagAssociationFailures)
 * et rattrapé par une simple ré-exécution. AUCUN upload Storage,
 * AUCUNE écriture liée à Photo (le nom de fichier est lu
 * par preview.ts mais n'est JAMAIS transmis à create_product/
 * update_product ici -- aucun paramètre photo n'existe sur ces RPC).
 *
 * CATEGORY / SUBCATEGORY ROW SUPPORT v1 (remédiation ciblée) -- une
 * ligne dont `rowType` est CATEGORY ou SUBCATEGORY n'aboutit JAMAIS à
 * un appel `create_product`/`update_product` (mandat, section 3/4 :
 * "do NOT create a product") : son seul rôle est déjà rempli par la
 * création de catégorie/sous-catégorie ci-dessous (étapes 1-2, plan
 * DÉJÀ dédupliqué par clé normalisée -- `buildCommitPlan`,
 * commit-plan.ts, INCHANGÉ). La boucle "étape 3" se contente de
 * RAPPORTER, pour CETTE ligne précise, le résultat de la création de
 * SA clé (CREATED si nouvellement créée par ce commit, SKIPPED si déjà
 * existante/réutilisée, FAILED si la création de cette clé a échoué en
 * amont -- ex. collision de concurrence) -- jamais une seconde
 * tentative de création, jamais un produit fabriqué à partir d'une
 * ligne structurelle.
 */

import { analyzeCatalogueImportFile } from "@/lib/services/catalogue-import";
import type { CatalogueImportStructuralError } from "@/lib/services/catalogue-import";
import { buildCommitPlan } from "@/lib/catalogue-import/commit-plan";
import { addProductTags } from "@/lib/services/catalogue-tags";
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
  TaxRateRequiredForAvailabilityError,
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
  /** CATEGORY / SUBCATEGORY ROW SUPPORT v1 -- lignes CATEGORY dont la
   *  création de la clé référencée a échoué (ex. collision de
   *  concurrence détectée à l'étape 1) ; DISTINCT de `productsFailed`
   *  (une ligne structurelle en échec n'est jamais un "produit en
   *  échec" -- décompte honnête, jamais une catégorie sémantique
   *  inventée). */
  categoriesFailed: number;
  /** Même principe que `categoriesFailed`, pour les lignes SUBCATEGORY. */
  subcategoriesFailed: number;
  productsCreated: number;
  productsUpdated: number;
  productsSkipped: number;
  productsFailed: number;
  /** COLLECTIONS / TAGS FOUNDATION v1 -- associations de tags
   *  RÉELLEMENT créées par ce commit (0 = tout était déjà à jour, ce
   *  qui est le cas normal d'un réimport : l'association est
   *  idempotente côté serveur). */
  tagsAssociated: number;
  /** Produits correctement écrits dont l'association de tags a
   *  échoué. Un échec de tag ne fait JAMAIS échouer la ligne : le
   *  produit, lui, a bien été créé/mis à jour -- le compter comme
   *  `productsFailed` serait un mensonge. Compté à part pour rester
   *  visible plutôt que silencieux. */
  tagAssociationFailures: number;
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
  // 3. Lignes restantes -- une exécution par ligne, dans l'ordre du
  //    fichier. Best-effort (voir TRANSACTION MODEL en en-tête de
  //    fichier). CATEGORY / SUBCATEGORY ROW SUPPORT v1 : une ligne
  //    CATEGORY ou SUBCATEGORY ne crée/modifie JAMAIS de produit --
  //    voir le commentaire d'en-tête de ce fichier.
  // ------------------------------------------------------------
  const rows: CommitRowResult[] = [];
  let productsCreated = 0;
  let productsUpdated = 0;
  let productsSkipped = 0;
  let productsFailed = 0;
  let tagsAssociated = 0;
  let tagAssociationFailures = 0;
  let categoriesFailed = 0;
  let subcategoriesFailed = 0;

  /**
   * Associe les tags d'une ligne au produit qui vient d'être écrit.
   *
   * NE PROPAGE JAMAIS : à ce point, le produit EST créé/mis à jour en
   * base. Faire échouer la ligne pour un tag non associé décrirait
   * faussement ce qui s'est passé et, à la ré-exécution, ferait
   * ressortir la ligne comme déjà appliquée (SKIP) -- l'échec de tag
   * deviendrait invisible. Il est donc compté séparément, et une
   * simple ré-exécution de l'import le rattrape (add_product_tags est
   * idempotente).
   */
  async function associateTags(menuItemId: string, tagNames: string[]): Promise<void> {
    if (tagNames.length === 0) return;
    try {
      tagsAssociated += await addProductTags(menuItemId, tagNames);
    } catch {
      tagAssociationFailures++;
    }
  }

  for (const row of report.rows) {
    // Ne devrait jamais se produire : l'éligibilité du fichier entier a
    // déjà été vérifiée ci-dessus (report.eligibility !== NOT_ELIGIBLE
    // implique zéro ligne BLOCKED). Filet de sécurité déterministe.
    if (row.plannedAction === "BLOCKED") continue;

    if (row.rowType === "CATEGORY") {
      const key = normalizedKey(row.normalizedValues.categoryNameRaw);
      if (categoryIdByKey.has(key)) {
        rows.push({ row: row.row, outcome: row.plannedAction === "CREATE" ? "CREATED" : "SKIPPED" });
      } else {
        const failure = categoryCreationFailure.get(key);
        rows.push({
          row: row.row,
          outcome: "FAILED",
          errorCode: failure?.code,
          errorMessage: failure?.message ?? "Catégorie non disponible.",
        });
        categoriesFailed++;
      }
      continue;
    }

    if (row.rowType === "SUBCATEGORY") {
      const catKey = normalizedKey(row.normalizedValues.categoryNameRaw);
      const subKey = normalizedKey(row.normalizedValues.subcategoryNameRaw);
      const scoped = `${catKey}\0${subKey}`;
      if (subcategoryIdByKey.has(scoped)) {
        rows.push({ row: row.row, outcome: row.plannedAction === "CREATE" ? "CREATED" : "SKIPPED" });
      } else {
        const failure = subcategoryCreationFailure.get(scoped);
        rows.push({
          row: row.row,
          outcome: "FAILED",
          errorCode: failure?.code,
          errorMessage: failure?.message ?? "Sous-catégorie non disponible.",
        });
        subcategoriesFailed++;
      }
      continue;
    }

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

    const values = row.normalizedValues;

    if (row.plannedAction === "SKIP") {
      // COLLECTIONS / TAGS v1.1 — CONSTAT A (Cat Stevens 2, reproduit
      // puis confirmé). Une ligne SKIP signifie « les champs CATALOGUE
      // du produit sont déjà identiques », jamais « il n'y a plus rien
      // à faire » : la colonne « Tags / Collections » peut parfaitement
      // désigner un tag que ce produit ne porte pas encore. En v1 le
      // `continue` ci-dessous sautait aussi l'association, si bien
      // qu'un produit déjà à jour ne recevait JAMAIS ses nouveaux tags.
      //
      // L'association est donc indépendante de la mutation produit :
      // le produit reste SKIP (jamais transformé en faux UPDATE pour
      // faire passer les tags), et `add_product_tags` — idempotente et
      // strictement additive côté serveur — est appelée pour lui.
      const skippedProductId = row.productMatch.existingId;
      if (skippedProductId) {
        await associateTags(skippedProductId, values.tags);
      }
      rows.push({ row: row.row, outcome: "SKIPPED", productId: skippedProductId });
      productsSkipped++;
      continue;
    }

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
        await associateTags(productId, values.tags);
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
        await associateTags(row.productMatch.existingId, values.tags);
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
      // CATALOGUE VAT COMPLETENESS GUARD v1 -- une ligne UPDATE qui
      // effacerait la TVA d'un produit EXISTANT actuellement disponible
      // est rejetée par la contrainte serveur (jamais une désactivation
      // silencieuse) : cette ligne échoue (FAILED, errorCode dédié),
      // les lignes suivantes continuent (même modèle "best-effort" que
      // ProductDuplicateNameError ci-dessous -- AUCUNE transaction
      // unique ne couvre l'import, voir en-tête de ce fichier).
      rows.push({
        row: row.row,
        outcome: "FAILED",
        errorCode: e instanceof ProductDuplicateNameError
          ? "SCANYM_PRODUCT_DUPLICATE_NAME"
          : e instanceof TaxRateRequiredForAvailabilityError
            ? "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY"
            : undefined,
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
    categoriesFailed,
    subcategoriesFailed,
    productsCreated,
    productsUpdated,
    productsSkipped,
    productsFailed,
    tagsAssociated,
    tagAssociationFailures,
    rows,
  };
}
