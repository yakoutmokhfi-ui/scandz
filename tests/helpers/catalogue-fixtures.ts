/**
 * Scanym — OB-3 CATALOGUE IMPORT — TEST HELPER (jamais du code de
 * production). Construit des `CatalogueCategory`/`CatalogueProduct`
 * minimaux mais complets (mêmes types que lib/services/dashboard.ts,
 * jamais une redéfinition parallèle) pour les tests de résolution/
 * correspondance/preview, sans dépendre d'une base de données.
 */

import type { CatalogueCategory, CatalogueProduct, CatalogueSubcategory } from "@/lib/services/dashboard";

export function makeProduct(overrides: Partial<CatalogueProduct> & { product_id: string; name: string }): CatalogueProduct {
  return {
    category_id: "cat-default",
    category_name: "Catégorie",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name_hash: "",
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 0,
    is_available: true,
    archived_at: null,
    display_order: 0,
    is_option_source: false,
    image_url: null,
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: false,
    reference_price_per_kg: null,
    ...overrides,
  };
}

export function makeSubcategory(
  overrides: Partial<CatalogueSubcategory> & { subcategory_id: string; subcategory_name: string }
): CatalogueSubcategory {
  return {
    subcategory_display_order: 0,
    products: [],
    ...overrides,
  };
}

export function makeCategory(
  overrides: Partial<CatalogueCategory> & { category_id: string; category_name: string }
): CatalogueCategory {
  return {
    category_name_hash: "",
    category_translations: null,
    category_display_order: 0,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    products: [],
    subcategories: [],
    ...overrides,
  };
}
