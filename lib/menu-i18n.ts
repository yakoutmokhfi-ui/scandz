import type { Lang } from "@/lib/i18n";
import type { MenuCategory, MenuItem } from "@/lib/types";
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
