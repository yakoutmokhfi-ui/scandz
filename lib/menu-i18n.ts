import type { Lang } from "@/lib/i18n";
import type { MenuCategory, MenuItem } from "@/lib/types";

/**
 * Traductions du contenu du menu.
 *
 * Elles sont lues dans la colonne optionnelle `translations` (JSONB)
 * des tables menu_items et menu_categories, au format :
 *   { "ar": { "name": "…", "description": "…" } }
 *
 * Tant que la colonne n'existe pas en base, la valeur est absente et
 * l'application retombe automatiquement sur le texte français : rien
 * ne casse. Le script d'ajout de la colonne est fourni dans
 * supabase/migration-translations.sql, à valider par le CTO.
 */
export function tName(entity: MenuItem | MenuCategory, lang: Lang): string {
  if (lang === "fr") return entity.name;
  return entity.translations?.[lang]?.name ?? entity.name;
}

export function tDescription(item: MenuItem, lang: Lang): string | null {
  if (lang === "fr") return item.description;
  return item.translations?.[lang]?.description ?? item.description;
}

/**
 * Description courte (V66) — même repli sur le français que
 * tDescription : tant qu'aucune traduction n'existe pour la langue
 * active, on retombe sur la valeur de base plutôt que d'afficher un
 * vide.
 */
export function tShortDescription(item: MenuItem, lang: Lang): string | null {
  if (lang === "fr") return item.short_description;
  return item.translations?.[lang]?.short_description ?? item.short_description;
}
