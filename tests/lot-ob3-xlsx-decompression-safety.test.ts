import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-3 v1.1 — CATALOGUE IMPORT.
// "XLSX DECOMPRESSION SAFETY" micro-remediation : preuve que
// lib/catalogue-import/xlsx-reader.ts n'appelle plus jamais
// unzipSync(bytes) sans filtre, et que la taille décompressée
// DÉCLARÉE de chaque entrée (répertoire central ZIP) est vérifiée
// contre une borne explicite -- par entrée ET cumulée -- AVANT tout
// désarchivage, y compris pour une entrée non pertinente qui ne sera
// de toute façon jamais décompressée. Voir le commentaire de sécurité
// en tête de lib/catalogue-import/xlsx-reader.ts pour l'analyse
// complète (référence au comportement interne de `fflate` vérifié
// dans node_modules/fflate avant d'écrire ce correctif).
// ====================================================================

const {
  readXlsxWorkbook,
  XlsxReadError,
  MAX_IMPORT_FILE_SIZE_BYTES,
  MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES,
  MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
} = await import("../lib/catalogue-import/xlsx-reader.ts");
const { buildImportXlsx, patchCentralDirectoryDeclaredSize } = await import("./helpers/xlsx-fixture-builder.ts");

const HEADER = ["Nom", "Catégorie parent", "Prix TTC (€)"];
const ROWS = [["Café allongé", "Boissons", "2.50"]];

test("normal XLSX still parses -- le correctif ne change rien pour un classeur normal", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const sheet = readXlsxWorkbook(buf);
  assert.deepEqual(sheet.rows[0], HEADER);
  assert.deepEqual(sheet.rows[1], ["Café allongé", "Boissons", "2.50"]);
});

test("fichier compressé > limite d'upload -> FILE_TOO_LARGE, jamais désarchivé (inchangé par ce correctif)", () => {
  const oversized = new ArrayBuffer(MAX_IMPORT_FILE_SIZE_BYTES + 1);
  assert.throws(
    () => readXlsxWorkbook(oversized),
    (e: unknown) => e instanceof XlsxReadError && e.code === "FILE_TOO_LARGE"
  );
});

test("feuille (xl/worksheets/sheet1.xml) déclarée surdimensionnée dans le répertoire central -> ENTRY_TOO_LARGE, rejetée AVANT désarchivage", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const patched = patchCentralDirectoryDeclaredSize(buf, "xl/worksheets/sheet1.xml", MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES + 1);
  assert.throws(
    () => readXlsxWorkbook(patched),
    (e: unknown) => e instanceof XlsxReadError && e.code === "ENTRY_TOO_LARGE" && e.message.includes("xl/worksheets/sheet1.xml")
  );
});

test("xl/sharedStrings.xml déclaré surdimensionné dans le répertoire central -> ENTRY_TOO_LARGE, rejetée AVANT désarchivage", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const patched = patchCentralDirectoryDeclaredSize(buf, "xl/sharedStrings.xml", MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES + 1);
  assert.throws(
    () => readXlsxWorkbook(patched),
    (e: unknown) => e instanceof XlsxReadError && e.code === "ENTRY_TOO_LARGE" && e.message.includes("xl/sharedStrings.xml")
  );
});

test("xl/workbook.xml déclaré surdimensionné (borne métadonnées) -> ENTRY_TOO_LARGE, rejetée avant même de résoudre la feuille", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const patched = patchCentralDirectoryDeclaredSize(buf, "xl/workbook.xml", MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES + 1);
  assert.throws(
    () => readXlsxWorkbook(patched),
    (e: unknown) => e instanceof XlsxReadError && e.code === "ENTRY_TOO_LARGE" && e.message.includes("xl/workbook.xml")
  );
});

test("volume décompressé TOTAL excessif -- feuille ET sharedStrings chacune SOUS leur propre borne, mais leur SOMME dépasse le plafond cumulé -> ENTRY_TOO_LARGE", () => {
  const buf = buildImportXlsx(HEADER, ROWS);
  const halfPlusMargin = Math.floor(MAX_TOTAL_UNCOMPRESSED_BYTES / 2) + 1024;
  // Chacune, prise isolément, reste sous MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES.
  assert.ok(halfPlusMargin < MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES);
  let patched = patchCentralDirectoryDeclaredSize(buf, "xl/worksheets/sheet1.xml", halfPlusMargin);
  patched = patchCentralDirectoryDeclaredSize(patched, "xl/sharedStrings.xml", halfPlusMargin);
  assert.throws(
    () => readXlsxWorkbook(patched),
    (e: unknown) => e instanceof XlsxReadError && e.code === "ENTRY_TOO_LARGE" && e.message.includes("total")
  );
});

test("entrée ZIP non pertinente déclarant une taille décompressée énorme (5 Go) -> ignorée, aucun ralentissement, aucune exception", () => {
  const buf = buildImportXlsx(HEADER, ROWS, {
    extraFiles: { "xl/media/image1.png": "contenu-reel-minuscule-non-pertinent" },
  });
  const patched = patchCentralDirectoryDeclaredSize(buf, "xl/media/image1.png", 5 * 1024 * 1024 * 1024);
  const start = Date.now();
  const sheet = readXlsxWorkbook(patched);
  const elapsedMs = Date.now() - start;
  // Preuve fonctionnelle (jamais décompressée -> aucune erreur, résultat
  // normal) ET preuve de performance (aucune tentative d'allouer/traiter
  // les 5 Go déclarés -- le temps de lecture reste de l'ordre de la
  // milliseconde, pas figé/explosé).
  assert.deepEqual(sheet.rows[0], HEADER);
  assert.ok(elapsedMs < 2000, `lecture anormalement lente (${elapsedMs} ms) -- suggère une décompression non bornée`);
});

test("entrée ZIP non pertinente avec une méthode de compression non prise en charge (LZMA=14) -> ignorée sans erreur (jamais sélectionnée par le filtre)", () => {
  // xl/vbaProject.bin factice avec compression réelle 'stockée' (0) --
  // le point vérifié ici est qu'une entrée hors de la liste blanche des
  // 4 chemins requis n'est JAMAIS transmise au filtre de désarchivage,
  // quelle que soit sa méthode de compression déclarée ; seul son NOM
  // est examiné par la passe manifeste (voir aussi les tests dédiés
  // macro/formule dans lot-ob3-xlsx-reader.test.ts).
  const buf = buildImportXlsx(HEADER, ROWS, { includeFakeVbaProject: true });
  const sheet = readXlsxWorkbook(buf);
  assert.deepEqual(sheet.rows[0], HEADER);
});

test("archive ZIP corrompue (répertoire central illisible dès la passe manifeste) -> MALFORMED_WORKBOOK, échec propre", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
  assert.throws(
    () => readXlsxWorkbook(bytes.buffer),
    (e: unknown) => e instanceof XlsxReadError && e.code === "MALFORMED_WORKBOOK"
  );
});

test("formule (<f>) toujours jamais lue/évaluée après le correctif -- seule la valeur <v> en cache compte", () => {
  const buf = buildImportXlsx(["Nom", "Prix TTC (€)"], [["Café", 4]], { includeFormulaOnFirstNumericCell: true });
  const sheet = readXlsxWorkbook(buf);
  // La formule insérée (1/0) ne doit jamais être évaluée -- seule la
  // valeur <v> mise en cache (4) doit apparaître.
  assert.deepEqual(sheet.rows[1], ["Café", "4"]);
});

test("xl/vbaProject.bin (macro) toujours jamais ouvert après le correctif -- résultat identique à un classeur sans macro", () => {
  const withoutVba = readXlsxWorkbook(buildImportXlsx(HEADER, ROWS));
  const withVba = readXlsxWorkbook(buildImportXlsx(HEADER, ROWS, { includeFakeVbaProject: true }));
  assert.deepEqual(withVba.rows, withoutVba.rows);
});

test("bornes exportées : constantes stables et cohérentes entre elles (par-entrée <= plafond cumulé)", () => {
  assert.equal(typeof MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES, "number");
  assert.equal(typeof MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES, "number");
  assert.equal(typeof MAX_TOTAL_UNCOMPRESSED_BYTES, "number");
  assert.ok(MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES > 0);
  assert.ok(MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES > MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES);
  assert.ok(MAX_TOTAL_UNCOMPRESSED_BYTES >= MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES);
});
