import type { Lang } from "@/lib/i18n";

/**
 * Résolution générique des contenus traduits (LOT 1B).
 *
 * Remplace le contrat précédemment codé en dur dans lib/menu-i18n.ts
 * (`if (lang === "fr") return entity.name`), qui supposait le
 * français comme langue source de TOUT établissement -- une
 * hypothèse fausse dès qu'un établissement a une source_language
 * différente (ex. Sirocco/AR, tout établissement créé via
 * create_establishment avec une autre langue source depuis LOT 1A).
 * Découverte documentée dans le rapport de livraison LOT 1B, pas
 * silencieusement contournée.
 *
 * Contrat (section 4 de la mission, décision CIO) :
 *   1. si la langue demandée EST la langue source -> contenu source ;
 *   2. sinon, si une traduction VALIDÉE et à jour existe -> traduction ;
 *   3. sinon -> repli sur le contenu source (jamais une chaîne vide).
 *
 * "À jour" = statut "validated" ET le hash stocké au moment de la
 * traduction correspond EXACTEMENT au hash actuel du contenu source
 * (colonne générée par PostgreSQL, jamais recalculée ici -- ce module
 * ne fait QUE comparer deux chaînes déjà calculées côté serveur,
 * jamais un algorithme de hash réimplémenté côté client).
 */

export type TranslationDisplayStatus = "missing" | "to_review" | "validated" | "stale";

interface TranslationEntryLike {
  [key: string]: string | undefined;
}

export interface TranslatableEntity {
  translations?: Record<string, TranslationEntryLike | undefined> | null;
}

/**
 * Résout la valeur affichée publiquement d'un champ traduisible.
 *
 * @param sourceValue   valeur actuelle du champ source (ex. entity.name)
 * @param sourceHash    hash actuel du champ source (colonne générée,
 *                      ex. entity.name_hash) -- jamais calculé ici
 * @param translations  colonne JSONB translations de l'entité
 * @param lang          langue publique demandée
 * @param sourceLanguage langue source de CET établissement (jamais "fr" supposé)
 * @param field         nom du champ ("name", "description", "intro_text", ...)
 */
export function resolveTranslatedField(
  sourceValue: string | null | undefined,
  sourceHash: string | null | undefined,
  translations: Record<string, TranslationEntryLike | undefined> | null | undefined,
  lang: Lang,
  sourceLanguage: Lang,
  field: string
): string | null {
  const source = sourceValue ?? null;
  if (lang === sourceLanguage) return source;

  const entry = translations?.[lang];
  if (!entry) return source;

  const value = entry[field];
  const status = entry[`${field}_status`];
  const storedHash = entry[`${field}_source_hash`];

  if (value && status === "validated" && storedHash === sourceHash) {
    return value;
  }
  return source;
}

/**
 * Statut d'affichage d'une traduction pour LE DASHBOARD (distinct de
 * resolveTranslatedField, qui décide ce que voit le CLIENT PUBLIC).
 * "stale" n'est JAMAIS stocké en base : il est dérivé ici, à la
 * lecture, par comparaison de hash -- jamais une troisième copie de
 * la donnée à maintenir en synchronisation.
 */
export function getTranslationStatus(
  sourceHash: string | null | undefined,
  translations: Record<string, TranslationEntryLike | undefined> | null | undefined,
  lang: string,
  field: string
): TranslationDisplayStatus {
  const entry = translations?.[lang];
  const value = entry?.[field];
  if (!entry || !value) return "missing";

  const status = entry[`${field}_status`];
  const storedHash = entry[`${field}_source_hash`];

  if (status === "validated") {
    return storedHash === sourceHash ? "validated" : "stale";
  }
  return "to_review";
}
