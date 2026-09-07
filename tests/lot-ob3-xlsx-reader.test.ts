import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
// lib/catalogue-import/xlsx-reader.ts -- lecteur XLSX minimal maison
// (voir en-tête de ce fichier pour la décision de sécurité complète :
// aucune bibliothèque tierce, `fflate` + scan de texte ciblé
// uniquement).
// ====================================================================

const { readXlsxWorkbook, XlsxReadError, MAX_IMPORT_FILE_SIZE_BYTES, checkZipSignature, columnLettersToIndex, unescapeXmlEntities } =
  await import("../lib/catalogue-import/xlsx-reader.ts");
const { buildImportXlsx, buildXlsxWorkbook } = await import("./helpers/xlsx-fixture-builder.ts");

test("1. valid XLSX parse : en-tête + lignes de données lues correctement, y compris accents", () => {
  const header = ["Nom", "Prix TTC (€)"];
  const rows = [["Café allongé", 2.5], ["Thé à la menthe", 3]];
  const buf = buildImportXlsx(header, rows);
  const sheet = readXlsxWorkbook(buf);
  assert.deepEqual(sheet.rows[0], header);
  assert.deepEqual(sheet.rows[1], ["Café allongé", "2.5"]);
  assert.deepEqual(sheet.rows[2], ["Thé à la menthe", "3"]);
  assert.deepEqual(sheet.rowNumbers, [1, 2, 3]);
});

test("3. malformed workbook : archive ZIP corrompue -> XlsxReadError MALFORMED_WORKBOOK", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
  assert.throws(
    () => readXlsxWorkbook(bytes.buffer),
    (e: unknown) => e instanceof XlsxReadError && e.code === "MALFORMED_WORKBOOK"
  );
});

test("fichier qui n'est pas un ZIP du tout -> NOT_A_ZIP_CONTAINER (jamais une confiance dans l'extension)", () => {
  const bytes = new TextEncoder().encode("PK n'est PAS ici, ceci est un fichier texte quelconque");
  assert.throws(
    () => readXlsxWorkbook(bytes.buffer),
    (e: unknown) => e instanceof XlsxReadError && e.code === "NOT_A_ZIP_CONTAINER"
  );
});

test("fichier trop volumineux -> FILE_TOO_LARGE, jamais désarchivé", () => {
  const oversized = new ArrayBuffer(MAX_IMPORT_FILE_SIZE_BYTES + 1);
  assert.throws(
    () => readXlsxWorkbook(oversized),
    (e: unknown) => e instanceof XlsxReadError && e.code === "FILE_TOO_LARGE"
  );
});

test("feuille vide (aucune ligne) -> EMPTY_WORKSHEET", () => {
  const buf = buildXlsxWorkbook([]);
  assert.throws(
    () => readXlsxWorkbook(buf),
    (e: unknown) => e instanceof XlsxReadError && e.code === "EMPTY_WORKSHEET"
  );
});

test("cellules éparses (colonnes non contiguës, Excel omet les cellules vides) -> alignement colonne correct", () => {
  // Ligne 2 : seulement colonnes A et C renseignées (B vide, omise
  // par l'exportateur, comme Excel le fait réellement).
  const buf = buildXlsxWorkbook([
    ["Nom", "Ignoré", "Prix TTC (€)"],
    ["Pizza", null, 9.9],
  ]);
  const sheet = readXlsxWorkbook(buf);
  assert.deepEqual(sheet.rows[1], ["Pizza", "", "9.9"]);
});

test("SÉCURITÉ (mandat 'no formula execution') : une cellule <f>...</f> avec <v> en cache -> SEULE la valeur en cache est lue, la formule n'est jamais interprétée", () => {
  const buf = buildXlsxWorkbook([["Nom", "Prix TTC (€)"], ["Test", 42]], {
    includeFormulaOnFirstNumericCell: true,
  });
  const sheet = readXlsxWorkbook(buf);
  // La valeur lue est la valeur EN CACHE (42), jamais le résultat
  // d'une évaluation de "1/0" -- et surtout, aucune exception
  // "division by zero" n'est levée, ce qui prouverait que la formule
  // n'a jamais été exécutée.
  assert.equal(sheet.rows[1][1], "42");
});

test("SÉCURITÉ (mandat 'no macro execution') : xl/vbaProject.bin présent dans l'archive -> jamais ouvert, jamais lu, aucune erreur, résultat identique à un classeur sans macro", () => {
  const withMacro = buildXlsxWorkbook([["Nom"], ["Test"]], { includeFakeVbaProject: true });
  const withoutMacro = buildXlsxWorkbook([["Nom"], ["Test"]]);
  const sheetWith = readXlsxWorkbook(withMacro);
  const sheetWithout = readXlsxWorkbook(withoutMacro);
  assert.deepEqual(sheetWith.rows, sheetWithout.rows);
});

test("unescapeXmlEntities : entités standard + références numériques décimales/hex", () => {
  assert.equal(unescapeXmlEntities("A &amp; B &lt;tag&gt; &quot;q&quot; &apos;a&apos;"), 'A & B <tag> "q" \'a\'');
  assert.equal(unescapeXmlEntities("&#233;"), "é");
  assert.equal(unescapeXmlEntities("&#xe9;"), "é");
});

test("columnLettersToIndex : A=0, Z=25, AA=26, AB=27", () => {
  assert.equal(columnLettersToIndex("A1"), 0);
  assert.equal(columnLettersToIndex("Z1"), 25);
  assert.equal(columnLettersToIndex("AA1"), 26);
  assert.equal(columnLettersToIndex("AB1"), 27);
});

test("checkZipSignature : accepte la signature ZIP standard et l'archive vide, rejette tout le reste", () => {
  assert.equal(checkZipSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), true);
  assert.equal(checkZipSignature(new Uint8Array([0x50, 0x4b, 0x05, 0x06])), true);
  assert.equal(checkZipSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46])), false); // %PDF
});

test("21. analyse répétée du MÊME fichier produit un résultat identique (déterminisme)", () => {
  const buf = buildImportXlsx(["Nom", "Prix TTC (€)"], [["Pizza", 9.9], ["Salade", 5]]);
  const first = readXlsxWorkbook(buf.slice(0));
  const second = readXlsxWorkbook(buf.slice(0));
  assert.deepEqual(first, second);
});
