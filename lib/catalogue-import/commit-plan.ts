/**
 * Scanym — OPERATOR BACKOFFICE — OB-4 v1.1 — CATALOGUE IMPORT COMMIT.
 * Planification PURE des créations de catégories/sous-catégories
 * déduites d'un `PreviewReport` déjà calculé (aucun accès réseau,
 * aucune écriture -- même discipline que lib/catalogue-import/*.ts).
 *
 * Un `PreviewReport` peut contenir PLUSIEURS lignes référençant la
 * même catégorie/sous-catégorie WOULD_CREATE (ex. 20 produits dans une
 * catégorie qui n'existe pas encore) -- ce module déduplique par clé
 * normalisée pour que l'orchestrateur impur (lib/services/catalogue-
 * import-commit.ts) n'appelle `create_category`/`create_subcategory`
 * qu'UNE SEULE fois par clé, jamais une fois par ligne (déterministe,
 * ordre de première apparition dans le fichier -- même règle EXACTE
 * que resolveCategoriesForRows/resolveSubcategoriesForRows, dont la
 * `displayName` déjà calculée est reprise telle quelle ici, jamais
 * recalculée).
 */

import { normalizedKey } from "@/lib/catalogue-import/normalization";
import type { PreviewReport } from "@/lib/catalogue-import/types";

export interface PlannedCategoryCreation {
  /** Clé normalisée (lib/catalogue-import/normalization::normalizedKey
   *  du nom de catégorie brut) -- identique à la clé utilisée par
   *  l'index unique partiel côté base (contrat vérifié, voir migration
   *  OB-4 v1.1, section 3). */
  key: string;
  displayName: string;
  /** Numéros de ligne (fichier) qui référencent cette catégorie --
   *  informatif uniquement, jamais utilisé pour l'ordre d'exécution. */
  rows: number[];
}

export interface PlannedSubcategoryCreation {
  /** Clé scopée à la catégorie : `${categoryKey}\0${subcategoryKey}` --
   *  jamais la clé sous-catégorie seule (deux catégories différentes
   *  peuvent légitimement partager un nom de sous-catégorie). */
  key: string;
  categoryKey: string;
  displayName: string;
  rows: number[];
}

export interface CommitPlan {
  /** Ordre de première apparition dans le fichier -- déterministe. */
  categoriesToCreate: PlannedCategoryCreation[];
  subcategoriesToCreate: PlannedSubcategoryCreation[];
}

export function buildCommitPlan(report: PreviewReport): CommitPlan {
  const categories = new Map<string, PlannedCategoryCreation>();
  const subcategories = new Map<string, PlannedSubcategoryCreation>();

  for (const row of report.rows) {
    // BLOCKED ne devrait jamais atteindre ce module (le point d'entrée
    // commit refuse tout le fichier tant qu'il reste un blocage --
    // "Preview approved -> explicit Confirm import"), mais un filet de
    // sécurité déterministe reste préférable à une hypothèse silencieuse.
    if (row.plannedAction === "BLOCKED") continue;

    if (row.resolvedCategory.state === "WOULD_CREATE") {
      const key = normalizedKey(row.normalizedValues.categoryNameRaw);
      let entry = categories.get(key);
      if (!entry) {
        entry = { key, displayName: row.resolvedCategory.displayName, rows: [] };
        categories.set(key, entry);
      }
      entry.rows.push(row.row);
    }

    if (row.resolvedSubcategory && row.resolvedSubcategory.state === "WOULD_CREATE") {
      const catKey = normalizedKey(row.normalizedValues.categoryNameRaw);
      const subKey = normalizedKey(row.normalizedValues.subcategoryNameRaw);
      const scoped = `${catKey}\0${subKey}`;
      let entry = subcategories.get(scoped);
      if (!entry) {
        entry = { key: scoped, categoryKey: catKey, displayName: row.resolvedSubcategory.displayName, rows: [] };
        subcategories.set(scoped, entry);
      }
      entry.rows.push(row.row);
    }
  }

  return {
    categoriesToCreate: Array.from(categories.values()),
    subcategoriesToCreate: Array.from(subcategories.values()),
  };
}
