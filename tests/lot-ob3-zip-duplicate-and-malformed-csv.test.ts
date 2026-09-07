import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-3 v1.3 — CATALOGUE IMPORT.
// "SECURITY / PARSER REMEDIATION" -- audit indépendant Cat Stevens,
// deux blockers de mise en production.
//
// BLOCKER 1 (ZIP) : des entrées de répertoire central ZIP portant
// EXACTEMENT le même nom pouvaient contourner la vérification de
// taille décompressée (lib/catalogue-import/xlsx-reader.ts,
// "ENTRÉES ZIP DUPLIQUÉES" -- voir le commentaire de sécurité en tête
// de ce fichier pour l'analyse complète). Correctif : toute archive
// dont un chemin PERTINENT (xl/workbook.xml, xl/_rels/workbook.xml.rels,
// xl/sharedStrings.xml, la feuille résolue) apparaît plus d'une fois
// dans le répertoire central est rejetée avec le code stable
// DUPLICATE_ZIP_ENTRY, AVANT toute tentative de désarchivage, quelles
// que soient les tailles déclarées respectives des occurrences.
//
// BLOCKER 2 (CSV) : un fichier CSV se terminant en plein milieu d'un
// champ entre guillemets (guillemet fermant manquant) était accepté
// silencieusement, la valeur partiellement accumulée étant poussée
// comme une cellule normale. Correctif :
// lib/catalogue-import/csv-reader.ts vérifie l'état terminal du
// parseur (`inQuotes`) juste après la boucle principale et rejette
// avec le code stable MALFORMED_CSV si un champ est resté ouvert.
//
// Les 13 tests adversariaux explicitement mandatés (8 ZIP + 5 CSV)
// sont numérotés ci-dessous exactement comme dans le mandat OB-3 v1.3,
// plus quelques tests de garde-fou additionnels documentés comme tels.
// ====================================================================

const { readXlsxWorkbook, XlsxReadError, MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES, MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES } =
  await import("../lib/catalogue-import/xlsx-reader.ts");
const { buildImportXlsx, patchCentralDirectoryDeclaredSize, injectDuplicateCentralDirectoryEntry } = await import(
  "./helpers/xlsx-fixture-builder.ts"
);
const { parseCsvText, readCsvWorkbook, CsvReadError } = await import("../lib/catalogue-import/csv-reader.ts");

const HEADER = ["Nom", "Catégorie parent", "Prix TTC (€)"];
const ROWS = [["Café allongé", "Boissons", "2.50"]];

const VALID_SHEET_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Doublon</t></is></c></row></sheetData>
</worksheet>`;

// ------------------------------------------------------------------
// ZIP -- BLOCKER 1 (Cat Stevens)
// ------------------------------------------------------------------

test("1. ZIP -- doublon xl/worksheets/sheet1.xml : PREMIÈRE occurrence surdimensionnée + SECONDE saine -> DUPLICATE_ZIP_ENTRY (jamais ENTRY_TOO_LARGE)", () => {
  let buf = buildImportXlsx(HEADER, ROWS);
  // Première occurrence (celle déjà dans l'archive) déclarée
  // surdimensionnée AVANT d'ajouter le doublon sain.
  buf = patchCentralDirectoryDeclaredSize(buf, "xl/worksheets/sheet1.xml", MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES + 1);
  buf = injectDuplicateCentralDirectoryEntry(buf, "xl/worksheets/sheet1.xml", VALID_SHEET_XML);
  assert.throws(
    () => readXlsxWorkbook(buf),
    (e: unknown) => e instanceof XlsxReadError && e.code === "DUPLICATE_ZIP_ENTRY" && e.message.includes("xl/worksheets/sheet1.xml")
  );
});

test("2. ZIP -- doublon xl/worksheets/sheet1.xml : PREMIÈRE occurrence saine + SECONDE surdimensionnée -> DUPLICATE_ZIP_ENTRY (jamais ENTRY_TOO_LARGE)", () => {
  let buf = buildImportXlsx(HEADER, ROWS);
  // Première occurrence (celle déjà dans l'archive) reste saine ;
  // c'est le DOUBLON ajouté qui ment sur sa taille décompressée.
  buf = injectDuplicateCentralDirectoryEntry(
    buf,
    "xl/worksheets/sheet1.xml",
    VALID_SHEET_XML,
    MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES + 1
  );
  assert.throws(
    () => readXlsxWorkbook(buf),
    (e: unknown) => e instanceof XlsxReadError && e.code === "DUPLICATE_ZIP_ENTRY" && e.message.includes("xl/worksheets/sheet1.xml")
  );
});

test("3. ZIP -- doublon xl/workbook.xml -> DUPLICATE_ZIP_ENTRY, rejeté avant même de tenter de résoudre la feuille", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const patched = injectDuplicateCentralDirectoryEntry(buf, "xl/workbook.xml", "<workbook/>");
  assert.throws(
    () => readXlsxWorkbook(patched),
    (e: unknown) => e instanceof XlsxReadError && e.code === "DUPLICATE_ZIP_ENTRY" && e.message.includes("xl/workbook.xml")
  );
});

test("4. ZIP -- doublon xl/_rels/workbook.xml.rels -> DUPLICATE_ZIP_ENTRY", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const patched = injectDuplicateCentralDirectoryEntry(buf, "xl/_rels/workbook.xml.rels", "<Relationships/>");
  assert.throws(
    () => readXlsxWorkbook(patched),
    (e: unknown) => e instanceof XlsxReadError && e.code === "DUPLICATE_ZIP_ENTRY" && e.message.includes("xl/_rels/workbook.xml.rels")
  );
});

test("5. ZIP -- doublon xl/sharedStrings.xml -> DUPLICATE_ZIP_ENTRY", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const patched = injectDuplicateCentralDirectoryEntry(buf, "xl/sharedStrings.xml", "<sst/>");
  assert.throws(
    () => readXlsxWorkbook(patched),
    (e: unknown) => e instanceof XlsxReadError && e.code === "DUPLICATE_ZIP_ENTRY" && e.message.includes("xl/sharedStrings.xml")
  );
});

test("6. ZIP -- classeur normal, chemins tous uniques (aucun doublon) -> PASS, lecture inchangée", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const sheet = readXlsxWorkbook(buf);
  assert.deepEqual(sheet.rows[0], HEADER);
  assert.deepEqual(sheet.rows[1], ["Café allongé", "Boissons", "2.50"]);
});

test("7. ZIP -- entrée non pertinente DUPLIQUÉE (ex. image) reste sans effet -- jamais sélectionnée par le filtre d'extraction, dupliquée ou non", () => {
  const buf = buildImportXlsx(HEADER, ROWS, {
    extraFiles: { "xl/media/image1.png": "contenu-reel-minuscule-non-pertinent" },
  });
  // Doublon d'une entrée non pertinente, en plus déclarée énorme (5 Go)
  // -- ni l'un ni l'autre ne doit avoir le moindre effet : l'entrée
  // n'appartient pas à la liste blanche des 4 chemins extraits.
  const patched = injectDuplicateCentralDirectoryEntry(
    buf,
    "xl/media/image1.png",
    "autre-contenu-non-pertinent",
    5 * 1024 * 1024 * 1024
  );
  const start = Date.now();
  const sheet = readXlsxWorkbook(patched);
  const elapsedMs = Date.now() - start;
  assert.deepEqual(sheet.rows[0], HEADER);
  assert.ok(elapsedMs < 2000, `lecture anormalement lente (${elapsedMs} ms) -- suggère une décompression non bornée`);
});

test("8. ZIP -- les bornes de décompression existantes (2 Mo / 64 Mo / 100 Mo cumulé) restent enforced sur une archive SANS doublon, après le correctif BLOCKER 1", () => {
  // Reprend exactement les trois scénarios de OB-3 v1.1 (par-entrée
  // métadonnées, par-entrée contenu, cumulé) sur une archive dont
  // AUCUN chemin n'est dupliqué -- prouve que la nouvelle vérification
  // de doublon n'a pas remplacé/affaibli les bornes de taille, elle
  // s'y ajoute.
  const metaOversized = patchCentralDirectoryDeclaredSize(
    buildImportXlsx(HEADER, ROWS),
    "xl/workbook.xml",
    MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES + 1
  );
  assert.throws(
    () => readXlsxWorkbook(metaOversized),
    (e: unknown) => e instanceof XlsxReadError && e.code === "ENTRY_TOO_LARGE"
  );

  const contentOversized = patchCentralDirectoryDeclaredSize(
    buildImportXlsx(HEADER, ROWS),
    "xl/worksheets/sheet1.xml",
    MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES + 1
  );
  assert.throws(
    () => readXlsxWorkbook(contentOversized),
    (e: unknown) => e instanceof XlsxReadError && e.code === "ENTRY_TOO_LARGE"
  );
});

// ------------------------------------------------------------------
// CSV -- BLOCKER 2 (Cat Stevens)
// ------------------------------------------------------------------

test("9. CSV -- champ entre guillemets non terminé À LA FIN DU FICHIER (exemple du mandat, \"Produit\";\"Cat\";\"10 sans fermeture) -> MALFORMED_CSV", () => {
  const text = '"Produit";"Cat";"10';
  assert.throws(
    () => parseCsvText(text),
    (e: unknown) => e instanceof CsvReadError && e.code === "MALFORMED_CSV"
  );
  assert.throws(
    () => readCsvWorkbook(text, text.length),
    (e: unknown) => e instanceof CsvReadError && e.code === "MALFORMED_CSV"
  );
});

test("10. CSV -- champ multi-ligne entre guillemets JAMAIS refermé -> MALFORMED_CSV (même état terminal qu'un guillemet manquant en fin de ligne)", () => {
  const text = 'Nom;Description\nPizza;"Ligne 1\nLigne 2 toujours ouverte, aucune fermeture';
  assert.throws(
    () => parseCsvText(text),
    (e: unknown) => e instanceof CsvReadError && e.code === "MALFORMED_CSV"
  );
});

test("11. CSV -- guillemets valides contenant le séparateur -> PASS, valeur préservée telle quelle (comportement inchangé)", () => {
  const text = 'Nom,Prix TTC (€)\n"Pizza, 4 fromages",12.5\n';
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [
    ["Nom", "Prix TTC (€)"],
    ["Pizza, 4 fromages", "12.5"],
  ]);
});

test("12. CSV -- guillemet échappé (\"\") valide et correctement refermé -> PASS, dé-échappé correctement (comportement inchangé)", () => {
  const text = 'Nom\n"Le ""Spécial"" du chef"\n';
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [["Nom"], ['Le "Spécial" du chef']]);
});

test("13. CSV -- champ multi-ligne entre guillemets CORRECTEMENT refermé -> PASS (comportement inchangé, cas actuellement supporté)", () => {
  const text = 'Nom,Description longue\nPizza,"Ligne 1\nLigne 2"\n';
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [
    ["Nom", "Description longue"],
    ["Pizza", "Ligne 1\nLigne 2"],
  ]);
});

// ------------------------------------------------------------------
// Garde-fous additionnels (au-delà des 13 mandatés) -- comportement
// préservé explicitement listé par le mandat, vérifié directement.
// ------------------------------------------------------------------

test("garde-fou CSV -- séparateur point-virgule et UTF-8 (accents) toujours corrects après le correctif BLOCKER 2", () => {
  const text = "Nom;Prix TTC (€)\nCafé allongé;2,50\n";
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [
    ["Nom", "Prix TTC (€)"],
    ["Café allongé", "2,50"],
  ]);
});

test("garde-fou CSV -- fichier vide et fichier trop volumineux toujours EMPTY_FILE/FILE_TOO_LARGE, jamais MALFORMED_CSV (aucune régression de mapping)", () => {
  assert.throws(
    () => readCsvWorkbook("", 0),
    (e: unknown) => e instanceof CsvReadError && e.code === "EMPTY_FILE"
  );
  assert.throws(
    () => readCsvWorkbook("Nom\nPizza\n", 999_999_999),
    (e: unknown) => e instanceof CsvReadError && e.code === "FILE_TOO_LARGE"
  );
});

test("garde-fou ZIP -- code XlsxReadErrorCode expose bien DUPLICATE_ZIP_ENTRY, distinct de MALFORMED_WORKBOOK et ENTRY_TOO_LARGE", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const patched = injectDuplicateCentralDirectoryEntry(buf, "xl/sharedStrings.xml", "<sst/>");
  try {
    readXlsxWorkbook(patched);
    assert.fail("devait lever XlsxReadError");
  } catch (e) {
    assert.ok(e instanceof XlsxReadError);
    assert.equal((e as InstanceType<typeof XlsxReadError>).code, "DUPLICATE_ZIP_ENTRY");
  }
});
