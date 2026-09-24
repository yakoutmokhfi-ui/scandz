import type { Lang } from "@/lib/i18n";
import type { MenuCategory, MenuItem, Translations } from "@/lib/types";
import { resolveTranslatedField } from "@/lib/translation-resolver";

/**
 * Traductions du contenu du menu (LOT 1A/1B).
 *
 * ⚠️ CORRIGE une hypothèse fausse découverte pendant l'audit LOT 1B :
 * ces fonctions codaient auparavant `if (lang === "fr") return
 * entity.name` -- un français supposé universellement source, faux
 * dès qu'un établissement a source_language != "fr" (Sirocco/AR, tout
 * établissement créé avec une autre langue source depuis LOT 1A). Ce
 * fichier délègue désormais entièrement à
 * lib/translation-resolver.ts (contrat générique, section 4 de la
 * mission LOT 1B) -- `sourceLanguage` doit être transmis
 * explicitement par l'appelant (voir useI18n(), qui l'expose
 * désormais), jamais supposé.
 */
export function tName(entity: MenuItem | MenuCategory, lang: Lang, sourceLanguage: Lang): string {
  return (
    resolveTranslatedField(entity.name, entity.name_hash, entity.translations, lang, sourceLanguage, "name") ??
    entity.name
  );
}

export function tDescription(item: MenuItem, lang: Lang, sourceLanguage: Lang): string | null {
  return resolveTranslatedField(
    item.description,
    item.description_hash,
    item.translations,
    lang,
    sourceLanguage,
    "description"
  );
}

/**
 * Description longue de CATÉGORIE (V67b) — distincte de tDescription
 * (produit) pour rester explicite sur le type attendu.
 */
export function tCategoryDescription(
  category: MenuCategory,
  lang: Lang,
  sourceLanguage: Lang
): string | null {
  return resolveTranslatedField(
    category.description,
    category.description_hash,
    category.translations,
    lang,
    sourceLanguage,
    "description"
  );
}

/** Description courte (V66). */
export function tShortDescription(item: MenuItem, lang: Lang, sourceLanguage: Lang): string | null {
  return resolveTranslatedField(
    item.short_description,
    item.short_description_hash,
    item.translations,
    lang,
    sourceLanguage,
    "short_description"
  );
}

/**
 * TRANSLATIONS MANAGEMENT v2 -- intitulé de SOUS-CATÉGORIE affiché au
 * client.
 *
 * Avant ce lot, les sous-catégories étaient explicitement
 * NON traduisibles (limite documentée de CATALOGUE / SUBCATEGORIES
 * v1) : leur nom source s'affichait tel quel dans toutes les langues.
 * Elles rejoignent ici le contrat GÉNÉRIQUE déjà en place pour les
 * catégories et les produits -- `resolveTranslatedField`, SEULE
 * autorité de repli (langue source -> source ; traduction validée ET
 * hash à jour -> traduction ; sinon -> source, jamais une chaîne
 * vide). Aucune règle de repli n'est réécrite ici.
 */
export function tSubcategoryName(
  sub: { name: string; name_hash?: string | null; translations?: Translations | null },
  lang: Lang,
  sourceLanguage: Lang
): string {
  return (
    resolveTranslatedField(
      sub.name,
      sub.name_hash ?? null,
      sub.translations ?? null,
      lang,
      sourceLanguage,
      "name"
    ) ?? sub.name
  );
}

/**
 * TRANSLATIONS MANAGEMENT v2 -- texte client CONFIGURABLE PAR LE
 * COMMERÇANT (notice de retrait/livraison affichée dans une popup
 * client). MÊME contrat de repli que ci-dessus ; `null` en entrée
 * (aucun texte configuré) reste `null` -- jamais une chaîne vide
 * affichée à la place d'un texte absent.
 *
 * Les libellés d'INTERFACE de ces popups (titre, boutons, « À
 * emporter », « Livraison ») ne passent JAMAIS par ici : ils restent
 * dans les dictionnaires Scanym (lib/i18n.ts, `t(...)`).
 */
export function tCustomerNoticeText(
  notice: {
    customerText: string | null;
    customerTextHash?: string | null;
    translations?: Translations | null;
  },
  lang: Lang,
  sourceLanguage: Lang
): string | null {
  if (!notice.customerText) return notice.customerText ?? null;
  return resolveTranslatedField(
    notice.customerText,
    notice.customerTextHash ?? null,
    notice.translations ?? null,
    lang,
    sourceLanguage,
    "customer_text"
  );
}
