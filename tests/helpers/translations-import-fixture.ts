/**
 * Scanym — TRANSLATIONS MANAGEMENT v2 — aide de test.
 *
 * Construit un classeur .xlsx à partir d'un en-tête et de lignes
 * DÉJÀ prêtes, en réutilisant l'écrivain XLSX DE PRODUCTION
 * (`buildCatalogueXlsx`) -- jamais un second générateur de test, qui
 * pourrait produire un fichier qu'aucun utilisateur ne verra jamais.
 *
 * Sert uniquement à simuler « le commerçant ouvre l'export, complète
 * une colonne et réimporte le fichier ».
 */
import { buildCatalogueXlsx, type ExportCell } from "@/lib/catalogue-management/export";

export function buildTranslationXlsxForTest(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string>>
): ArrayBuffer {
  const bytes = buildCatalogueXlsx(header, rows as ReadonlyArray<ReadonlyArray<ExportCell>>, "Traductions");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
