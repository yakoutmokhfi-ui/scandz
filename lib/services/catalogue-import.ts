/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Orchestration IMPURE (fichier navigateur + réseau) -- le SEUL
 * module de ce lot qui touche `File`/réseau. Tout le reste
 * (lib/catalogue-import/*) est pur et testable sans DOM ni Supabase.
 *
 * TENANT ISOLATION (mandat OB-3) : ce module n'appelle QUE
 * `getMerchantCatalogue(restaurantId)`, déjà publié et déjà audité
 * (OB-2/OB-2 v1.1) -- RLS + bypass `is_scanym_operator()` inchangés,
 * jamais réimplémentés ici. AUCUN `service_role`, AUCUNE écriture
 * Storage, AUCUN appel RPC mutant (`create_category`, `update_category`,
 * `create_subcategory`, `update_subcategory`, `create_product`,
 * `update_product`, `set_product_photo`, `archive_product`,
 * `restore_product`, `set_product_order` -- ZÉRO occurrence de ces
 * noms dans ce fichier, vérifié structurellement par
 * tests/lot-ob3-catalogue-import-structural.test.ts).
 */

import {
  readXlsxWorkbook,
  XlsxReadError,
  MAX_IMPORT_FILE_SIZE_BYTES,
  checkZipSignature,
} from "@/lib/catalogue-import/xlsx-reader";
import { readCsvWorkbook, CsvReadError } from "@/lib/catalogue-import/csv-reader";
import { resolveColumnMap, type ImportColumn } from "@/lib/catalogue-import/column-mapping";
import { buildPreviewReport, type RawImportRow } from "@/lib/catalogue-import/preview";
import type { ImportIssue, PreviewReport } from "@/lib/catalogue-import/types";
import { getMerchantCatalogue } from "@/lib/services/dashboard";

export type CatalogueImportStructuralErrorCode =
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "MALFORMED_WORKBOOK"
  | "EMPTY_FILE"
  | "MISSING_REQUIRED_HEADERS"
  | "TENANT_ACCESS_DENIED";

export interface CatalogueImportStructuralError {
  kind: "STRUCTURAL_ERROR";
  code: CatalogueImportStructuralErrorCode;
  message: string;
  missingHeaders?: ImportColumn[];
}

export interface CatalogueImportAnalysis {
  kind: "OK";
  fileName: string;
  sourceFormat: "xlsx" | "csv";
  report: PreviewReport;
}

export type CatalogueImportAnalysisResult = CatalogueImportStructuralError | CatalogueImportAnalysis;

const ACCEPTED_EXTENSIONS = [".xlsx", ".csv"] as const;

function hasExtension(fileName: string, ext: string): boolean {
  return fileName.toLowerCase().endsWith(ext);
}

function unrecognizedHeaderIssues(headers: string[]): ImportIssue[] {
  return headers.map((h) => ({
    code: "SCANYM_IMPORT_UNRECOGNIZED_HEADER",
    severity: "INFO" as const,
    message: `Colonne du fichier non reconnue, ignorée : « ${h} ».`,
  }));
}

/**
 * Point d'entrée principal du lot OB-3 : Upload -> Analyse -> Preview.
 * `restaurantId` doit provenir d'une sélection EXPLICITE (jamais une
 * valeur par défaut implicite -- mandat "Preview must operate only on
 * the explicitly selected restaurant").
 *
 * AUCUN appel RPC mutant, AUCUNE écriture Storage : ce point d'entrée
 * ne fait que LIRE (le fichier local, puis `getMerchantCatalogue`) et
 * calculer -- jamais écrire.
 */
export async function analyzeCatalogueImportFile(
  file: File,
  restaurantId: string
): Promise<CatalogueImportAnalysisResult> {
  if (!restaurantId) {
    return {
      kind: "STRUCTURAL_ERROR",
      code: "TENANT_ACCESS_DENIED",
      message: "Aucun restaurant sélectionné.",
    };
  }

  if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
    return {
      kind: "STRUCTURAL_ERROR",
      code: "FILE_TOO_LARGE",
      message: `Fichier trop volumineux (${file.size} octets, limite ${MAX_IMPORT_FILE_SIZE_BYTES} octets).`,
    };
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isXlsxByExtension = hasExtension(file.name, ".xlsx");
  const isCsvByExtension = hasExtension(file.name, ".csv");
  const isZipSigned = checkZipSignature(bytes);

  let headerRow: string[];
  let dataRows: string[][];
  let dataRowNumbers: number[];
  let sourceFormat: "xlsx" | "csv";

  if (isZipSigned || isXlsxByExtension) {
    sourceFormat = "xlsx";
    try {
      const sheet = readXlsxWorkbook(buffer);
      [headerRow, ...dataRows] = sheet.rows;
      dataRowNumbers = sheet.rowNumbers.slice(1);
    } catch (e) {
      if (e instanceof XlsxReadError) {
        // ENTRY_TOO_LARGE (OB-3 v1.1, "XLSX DECOMPRESSION SAFETY") est
        // regroupé sous FILE_TOO_LARGE côté opérateur : le fichier a
        // été rejeté pour une raison de taille -- décompressée plutôt
        // que compressée -- sans introduire une nouvelle catégorie
        // d'erreur structurelle publique ; e.message reste précis.
        // DUPLICATE_ZIP_ENTRY (OB-3 v1.3, BLOCKER 1 -- Cat Stevens) est
        // regroupé sous MALFORMED_WORKBOOK (dernière branche ci-dessous,
        // atteinte automatiquement puisque ce n'est ni FILE_TOO_LARGE/
        // ENTRY_TOO_LARGE ni NOT_A_ZIP_CONTAINER) : une archive dont un
        // chemin pertinent est dupliqué est structurellement invalide,
        // exactement comme un classeur illisible -- e.message reste
        // précis sur la cause réelle (nom du chemin dupliqué).
        const code: CatalogueImportStructuralErrorCode =
          e.code === "FILE_TOO_LARGE" || e.code === "ENTRY_TOO_LARGE"
            ? "FILE_TOO_LARGE"
            : e.code === "NOT_A_ZIP_CONTAINER"
              ? "UNSUPPORTED_FILE_TYPE"
              : "MALFORMED_WORKBOOK";
        return { kind: "STRUCTURAL_ERROR", code, message: e.message };
      }
      return { kind: "STRUCTURAL_ERROR", code: "MALFORMED_WORKBOOK", message: "Classeur XLSX illisible." };
    }
  } else if (isCsvByExtension) {
    sourceFormat = "csv";
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return { kind: "STRUCTURAL_ERROR", code: "MALFORMED_WORKBOOK", message: "Fichier CSV illisible (encodage)." };
    }
    try {
      const rows = readCsvWorkbook(text, file.size);
      [headerRow, ...dataRows] = rows;
      dataRowNumbers = dataRows.map((_, i) => i + 2); // ligne 1 = en-tête
    } catch (e) {
      if (e instanceof CsvReadError) {
        // MALFORMED_CSV (OB-3 v1.3, BLOCKER 2 -- Cat Stevens) est
        // regroupé sous MALFORMED_WORKBOOK, même catégorie publique que
        // pour un classeur XLSX structurellement invalide -- un CSV mal
        // formé (guillemet non terminé) n'est ni "fichier trop
        // volumineux" ni "fichier vide", donc EMPTY_FILE n'est plus la
        // valeur par défaut : seul FILE_TOO_LARGE et EMPTY_FILE gardent
        // leur mapping direct, tout le reste (dont MALFORMED_CSV) tombe
        // sur MALFORMED_WORKBOOK.
        const code: CatalogueImportStructuralErrorCode =
          e.code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : e.code === "EMPTY_FILE" ? "EMPTY_FILE" : "MALFORMED_WORKBOOK";
        return { kind: "STRUCTURAL_ERROR", code, message: e.message };
      }
      return { kind: "STRUCTURAL_ERROR", code: "MALFORMED_WORKBOOK", message: "Fichier CSV illisible." };
    }
  } else {
    return {
      kind: "STRUCTURAL_ERROR",
      code: "UNSUPPORTED_FILE_TYPE",
      message: `Type de fichier non pris en charge (« ${file.name} ») -- extensions acceptées : ${ACCEPTED_EXTENSIONS.join(", ")} (.xlsx prioritaire).`,
    };
  }

  if (headerRow === undefined) {
    return { kind: "STRUCTURAL_ERROR", code: "EMPTY_FILE", message: "Le fichier ne contient aucune ligne d'en-tête." };
  }

  const columnMap = resolveColumnMap(headerRow);
  if (columnMap.missingRequired.length > 0) {
    return {
      kind: "STRUCTURAL_ERROR",
      code: "MISSING_REQUIRED_HEADERS",
      message: `Colonne(s) obligatoire(s) manquante(s) : ${columnMap.missingRequired.join(", ")}.`,
      missingHeaders: columnMap.missingRequired,
    };
  }

  const rawRows: RawImportRow[] = [];
  dataRows.forEach((rawCells, i) => {
    const rowNumber = dataRowNumbers[i];
    const cells: Partial<Record<ImportColumn, string>> = {};
    let hasAnyValue = false;
    for (const [column, index] of Object.entries(columnMap.indexOf) as [ImportColumn, number][]) {
      const cellValue = rawCells[index] ?? "";
      cells[column] = cellValue;
      if (cellValue.trim() !== "") hasAnyValue = true;
    }
    // Ligne intégralement vide (aucune des colonnes reconnues n'a de
    // valeur) : ignorée silencieusement -- artefact d'export tableur
    // courant (ligne de fin de feuille), jamais une erreur pour
    // l'opérateur (décision documentée, IMPORT-CONTRACT.md).
    if (hasAnyValue) rawRows.push({ row: rowNumber, cells });
  });

  let existingCategories;
  try {
    existingCategories = await getMerchantCatalogue(restaurantId, false);
  } catch {
    // Message générique volontaire (mandat, tenant isolation) :
    // jamais distinguer "restaurant introuvable" de "non autorisé"
    // -- la RPC get_merchant_catalogue produit déjà ce comportement,
    // ce module ne fait que le relayer sans ajouter de détail.
    return {
      kind: "STRUCTURAL_ERROR",
      code: "TENANT_ACCESS_DENIED",
      message: "Impossible de lire le catalogue de ce restaurant (accès refusé ou restaurant introuvable).",
    };
  }

  const report = buildPreviewReport(rawRows, existingCategories, unrecognizedHeaderIssues(columnMap.unrecognizedHeaders));

  return { kind: "OK", fileName: file.name, sourceFormat, report };
}
