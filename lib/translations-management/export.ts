/**
 * Scanym — TRANSLATIONS MANAGEMENT v2.
 * Export des traductions en .xlsx. PUR : produit des octets, l'écran
 * se charge de les proposer au téléchargement.
 *
 * Le classeur est construit par `buildCatalogueXlsx`
 * (lib/catalogue-management/export.ts) -- le MÊME écrivain XLSX que
 * l'export catalogue, lui-même relu par le lecteur d'import de
 * production. Aucune bibliothèque tableur supplémentaire n'est
 * introduite.
 *
 * SCHÉMA (mandat §11) -- déterministe et machine-lisible :
 *   entity_type | entity_id | category | subcategory | field |
 *   source_text | source_hash | target_language | translation | status
 *
 * - `entity_id` est l'identifiant de base STABLE ; `category`/
 *   `subcategory` ne servent QU'À la lisibilité humaine (jamais à
 *   identifier une entité -- mandat §11, littéral).
 * - `source_hash` est la colonne GÉNÉRÉE lue en base : c'est le garde
 *   de concurrence de l'import (mandat §13).
 * - `status` est le statut DÉRIVÉ pour la langue cible (manquant / à
 *   relire / validé / périmé), via l'autorité unique
 *   `getTranslationStatus`.
 * - Aucun secret, aucun identifiant d'autorisation, aucun rôle,
 *   aucune donnée interne (provider, code de routage, jeton) n'est
 *   exporté.
 * - UTF-8 / Unicode (donc arabe) : les valeurs sont écrites en
 *   `inlineStr` échappé par l'écrivain partagé, jamais en table de
 *   chaînes partagées dépendante d'un encodage tiers.
 */
import { buildCatalogueXlsx, type ExportCell } from "@/lib/catalogue-management/export";
import { rowStatus, rowStoredTranslation, type TranslationRow } from "@/lib/translations-management/rows";

export const TRANSLATION_EXPORT_COLUMNS = [
  "entity_type",
  "entity_id",
  "category",
  "subcategory",
  "field",
  "source_text",
  "source_hash",
  "target_language",
  "translation",
  "status",
] as const;

export type TranslationExportColumn = (typeof TRANSLATION_EXPORT_COLUMNS)[number];

export function buildTranslationExportRows(
  rows: ReadonlyArray<TranslationRow>,
  targetLanguage: string
): ExportCell[][] {
  return rows.map((row) => [
    row.entityType,
    row.entityId,
    row.categoryName ?? "",
    row.subcategoryName ?? "",
    row.field,
    row.sourceText,
    row.sourceHash ?? "",
    targetLanguage,
    rowStoredTranslation(row, targetLanguage),
    rowStatus(row, targetLanguage),
  ]);
}

export function buildTranslationExport(
  rows: ReadonlyArray<TranslationRow>,
  targetLanguage: string
): Uint8Array {
  return buildCatalogueXlsx(
    [...TRANSLATION_EXPORT_COLUMNS],
    buildTranslationExportRows(rows, targetLanguage),
    "Traductions"
  );
}

/** Nom de fichier horodaté, distinguant l'export COMPLET de l'export
 *  du RÉSULTAT FILTRÉ et portant la langue cible -- le commerçant
 *  retrouve sans ambiguïté ce qu'il a téléchargé. */
export function translationExportFileName(
  scope: "complet" | "filtre",
  targetLanguage: string,
  now: Date = new Date()
): string {
  const d = now.toISOString().slice(0, 10);
  const lang = targetLanguage || "xx";
  return scope === "complet"
    ? `traductions-${lang}-completes-${d}.xlsx`
    : `traductions-${lang}-resultats-${d}.xlsx`;
}
