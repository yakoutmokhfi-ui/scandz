/**
 * Scanym — TRANSLATIONS MANAGEMENT v2.
 * Modèle de LIGNE DE TRADUCTION : une entité + un champ traduisible.
 * PUR -- aucun accès réseau, aucune écriture, aucun état, aucun DOM.
 *
 * ------------------------------------------------------------------
 * POURQUOI CE MODULE EXISTE
 * ------------------------------------------------------------------
 * Avant ce lot, l'écran de traduction construisait SA PROPRE liste en
 * parcourant `cat.products` directement -- ce qui rendait INVISIBLES
 * tous les produits rattachés à une SOUS-CATÉGORIE
 * (`cat.subcategories[].products`), pourtant déjà chargés (défaut
 * PRODUIT confirmé par le mandat §2). Le parcours du catalogue est
 * désormais délégué à `flattenCatalogue` (lib/catalogue-management/
 * filtering.ts), la MÊME fonction que l'écran Catalogue -- jamais une
 * seconde implémentation d'aplatissement qui pourrait diverger à
 * nouveau.
 *
 * Ce module est la SEULE autorité de la liste des lignes traduisibles.
 * L'écran, les filtres, l'export Excel et l'aperçu d'import lisent
 * tous la MÊME structure : une ligne ne peut donc pas exister à
 * l'écran et manquer dans l'export (ni l'inverse).
 *
 * Le STATUT (manquant / à relire / validé / périmé) n'est jamais
 * recalculé ici : il est délégué à `getTranslationStatus`
 * (lib/translation-resolver.ts), déjà l'autorité unique du produit.
 */
import type { Translations } from "@/lib/types";
import type { CatalogueCategory } from "@/lib/services/dashboard";
import type { MerchantDeliveryMethodNotice, MerchantDeliveryFulfillmentPricingRule } from "@/lib/dashboard-types";
import { flattenCatalogue, type FlatProduct } from "@/lib/catalogue-management/filtering";
import { getTranslationStatus, type TranslationDisplayStatus } from "@/lib/translation-resolver";

/** Types d'entité traduisibles -- STRICTEMENT ceux acceptés par la RPC
 *  `write_translation` (SEULE autorité ; cette union la reflète). */
export type TranslationEntityType =
  | "restaurant"
  | "category"
  | "subcategory"
  | "item"
  | "customer_notice";

/** Champs traduisibles, par type d'entité -- même table de vérité que
 *  la RPC. Toute valeur hors de cette table est REFUSÉE à l'import
 *  avant même d'atteindre le serveur (défense en profondeur, jamais un
 *  remplacement du contrôle serveur). */
export const TRANSLATABLE_FIELDS: Record<TranslationEntityType, readonly string[]> = {
  restaurant: ["intro_text", "announcement_text"],
  category: ["name", "description"],
  subcategory: ["name"],
  item: ["name", "short_description", "description"],
  customer_notice: ["customer_text"],
};

export function isTranslatableField(entityType: string, field: string): boolean {
  const fields = TRANSLATABLE_FIELDS[entityType as TranslationEntityType];
  return fields !== undefined && fields.includes(field);
}

/** Contexte d'affichage d'une ligne : « Catégorie > Sous-catégorie >
 *  Produit », ou « Catégorie > Produit » pour un produit direct. */
export interface TranslationRowContext {
  categoryId: string | null;
  categoryName: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
}

export interface TranslationRow extends TranslationRowContext {
  entityType: TranslationEntityType;
  /** Identifiant STABLE, jamais un libellé affiché : id d'entité en
   *  base (restaurant_id pour les textes d'établissement, id du mode
   *  de vente ou de la règle de livraison pour un texte client). */
  entityId: string;
  /** Nom lisible de l'entité (produit, catégorie, mode…) -- pour
   *  l'affichage et la colonne de contexte de l'export, JAMAIS pour
   *  identifier l'entité. */
  entityLabel: string;
  field: string;
  /** Libellé humain du champ (français, langue du back-office). */
  fieldLabel: string;
  sourceText: string;
  /** Hash de la valeur source, tel que renvoyé par la base (colonne
   *  générée). Jamais recalculé côté client. */
  sourceHash: string | null;
  translations: Translations | null;
  /** Disponibilité du produit -- uniquement pour `item`, sinon `null`
   *  (utilisé par le filtre de disponibilité, voir filtering.ts). */
  isAvailable: boolean | null;
  /** Prix du produit -- uniquement pour `item` (tri par prix). */
  price: number | null;
  /** Tags du produit -- uniquement pour `item` (filtre par tag). */
  tagIds: readonly string[];
}

export const FIELD_LABELS: Record<string, string> = {
  intro_text: "Texte de présentation",
  announcement_text: "Message temporaire",
  name: "Nom",
  description: "Description longue",
  short_description: "Description courte",
  customer_text: "Message client",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** Statut d'une ligne pour une langue cible -- délégué à l'autorité
 *  unique du produit, jamais recalculé. */
export function rowStatus(row: TranslationRow, lang: string): TranslationDisplayStatus {
  return getTranslationStatus(row.sourceHash, row.translations, lang, row.field);
}

/** Traduction actuellement enregistrée pour cette ligne (chaîne vide
 *  si aucune) -- lue au MÊME endroit que le statut. */
export function rowStoredTranslation(row: TranslationRow, lang: string): string {
  return row.translations?.[lang]?.[row.field] ?? "";
}

export interface RestaurantTranslatableTexts {
  restaurantId: string;
  restaurantName: string;
  introText: string | null;
  introTextHash: string | null;
  announcementText: string | null;
  announcementTextHash: string | null;
  translations: Translations | null;
}

export interface BuildTranslationRowsInput {
  restaurant: RestaurantTranslatableTexts | null;
  categories: ReadonlyArray<CatalogueCategory>;
  /** Tags par produit, EXACTEMENT la structure attendue par
   *  `flattenCatalogue` (aucune seconde forme). */
  tagsByProductId?: ReadonlyMap<string, { tagIds: string[]; tagNames: string[] }>;
  /** Textes client configurables : modes de vente (retrait/livraison)
   *  et règles de livraison. Jamais un libellé d'interface Scanym. */
  methodNotices?: ReadonlyArray<MerchantDeliveryMethodNotice>;
  fulfillmentNotices?: ReadonlyArray<MerchantDeliveryFulfillmentPricingRule>;
}

/**
 * Construit TOUTES les lignes traduisibles d'un établissement.
 *
 * Ordre : textes d'établissement, puis textes client configurables,
 * puis le catalogue dans son ordre d'affichage (catégorie, ses
 * champs, ses sous-catégories, ses produits). Aucun produit n'est
 * dupliqué : les produits proviennent d'un UNIQUE aplatissement.
 */
export function buildTranslationRows(input: BuildTranslationRowsInput): TranslationRow[] {
  const rows: TranslationRow[] = [];
  const noContext: TranslationRowContext = {
    categoryId: null,
    categoryName: null,
    subcategoryId: null,
    subcategoryName: null,
  };

  const r = input.restaurant;
  if (r) {
    const restaurantFields: Array<[string, string | null, string | null]> = [
      ["intro_text", r.introText, r.introTextHash],
      ["announcement_text", r.announcementText, r.announcementTextHash],
    ];
    for (const [field, value, hash] of restaurantFields) {
      if (!value) continue;
      rows.push({
        ...noContext,
        entityType: "restaurant",
        entityId: r.restaurantId,
        entityLabel: r.restaurantName,
        field,
        fieldLabel: fieldLabel(field),
        sourceText: value,
        sourceHash: hash,
        translations: r.translations,
        isAvailable: null,
        price: null,
        tagIds: [],
      });
    }
  }

  for (const notice of input.methodNotices ?? []) {
    // Un mode sans texte client configuré n'a rien à traduire -- jamais
    // une ligne vide qui inviterait à « traduire » l'absence de texte.
    if (!notice.customerText || !notice.saleModeId) continue;
    rows.push({
      ...noContext,
      entityType: "customer_notice",
      entityId: notice.saleModeId,
      entityLabel: notice.modeLabel,
      field: "customer_text",
      fieldLabel: fieldLabel("customer_text"),
      sourceText: notice.customerText,
      sourceHash: notice.customerTextHash,
      translations: notice.translations,
      isAvailable: null,
      price: null,
      tagIds: [],
    });
  }

  for (const rule of input.fulfillmentNotices ?? []) {
    if (!rule.customerText) continue;
    rows.push({
      ...noContext,
      entityType: "customer_notice",
      entityId: rule.ruleId,
      entityLabel: rule.fulfillmentLabel,
      field: "customer_text",
      fieldLabel: fieldLabel("customer_text"),
      sourceText: rule.customerText,
      sourceHash: rule.customerTextHash,
      translations: rule.translations,
      isAvailable: null,
      price: null,
      tagIds: [],
    });
  }

  for (const category of input.categories) {
    const categoryContext: TranslationRowContext = {
      categoryId: category.category_id,
      categoryName: category.category_name,
      subcategoryId: null,
      subcategoryName: null,
    };
    rows.push({
      ...categoryContext,
      entityType: "category",
      entityId: category.category_id,
      entityLabel: category.category_name,
      field: "name",
      fieldLabel: fieldLabel("name"),
      sourceText: category.category_name,
      sourceHash: category.category_name_hash,
      translations: category.category_translations,
      isAvailable: null,
      price: null,
      tagIds: [],
    });
    if (category.category_description) {
      rows.push({
        ...categoryContext,
        entityType: "category",
        entityId: category.category_id,
        entityLabel: category.category_name,
        field: "description",
        fieldLabel: fieldLabel("description"),
        sourceText: category.category_description,
        sourceHash: category.category_description_hash,
        translations: category.category_translations,
        isAvailable: null,
        price: null,
        tagIds: [],
      });
    }

    for (const sub of category.subcategories ?? []) {
      rows.push({
        categoryId: category.category_id,
        categoryName: category.category_name,
        subcategoryId: sub.subcategory_id,
        subcategoryName: sub.subcategory_name,
        entityType: "subcategory",
        entityId: sub.subcategory_id,
        entityLabel: sub.subcategory_name,
        field: "name",
        fieldLabel: fieldLabel("name"),
        sourceText: sub.subcategory_name,
        sourceHash: sub.subcategory_name_hash ?? null,
        translations: sub.subcategory_translations ?? null,
        isAvailable: null,
        price: null,
        tagIds: [],
      });
    }
  }

  // PRODUITS -- UNE SEULE source : l'aplatissement partagé avec l'écran
  // Catalogue. Couvre par construction les produits directs ET ceux
  // rattachés à une sous-catégorie (le défaut corrigé par ce lot).
  for (const fp of flattenCatalogue(input.categories, input.tagsByProductId ?? new Map())) {
    rows.push(...productRows(fp));
  }

  return rows;
}

function productRows(fp: FlatProduct): TranslationRow[] {
  const p = fp.product;
  const context: TranslationRowContext = {
    categoryId: fp.categoryId,
    categoryName: fp.categoryName,
    subcategoryId: fp.subcategoryId,
    subcategoryName: fp.subcategoryName,
  };
  const fields: Array<[string, string | null, string | null]> = [
    ["name", p.name, p.name_hash],
    ["short_description", p.short_description, p.short_description_hash],
    ["description", p.description, p.description_hash],
  ];
  const out: TranslationRow[] = [];
  for (const [field, value, hash] of fields) {
    if (!value) continue;
    out.push({
      ...context,
      entityType: "item",
      entityId: p.product_id,
      entityLabel: p.name,
      field,
      fieldLabel: fieldLabel(field),
      sourceText: value,
      sourceHash: hash,
      translations: p.translations,
      isAvailable: p.is_available,
      price: p.price,
      tagIds: fp.tagIds,
    });
  }
  return out;
}

/** Clé d'ENTITÉ (pas de ligne) : sert au filtre de statut, qui
 *  raisonne par entité (voir filtering.ts). */
export function entityKey(row: TranslationRow): string {
  return `${row.entityType}\u0000${row.entityId}`;
}
