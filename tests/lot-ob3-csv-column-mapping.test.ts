import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
// lib/catalogue-import/csv-reader.ts + column-mapping.ts.
// ====================================================================

const { parseCsvText, readCsvWorkbook, CsvReadError } = await import("../lib/catalogue-import/csv-reader.ts");
const { resolveColumnMap, REQUIRED_IMPORT_COLUMNS, IMPORT_COLUMNS } = await import(
  "../lib/catalogue-import/column-mapping.ts"
);

test("CSV : séparateur virgule, guillemets, champ contenant le séparateur", () => {
  const text = 'Nom,Prix TTC (€)\n"Pizza, 4 fromages",12.5\nSalade,5\n';
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [
    ["Nom", "Prix TTC (€)"],
    ["Pizza, 4 fromages", "12.5"],
    ["Salade", "5"],
  ]);
});

test("CSV : séparateur point-virgule détecté automatiquement (export tableur FR)", () => {
  const text = "Nom;Prix TTC (€)\nPizza;12,5\n";
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [
    ["Nom", "Prix TTC (€)"],
    ["Pizza", "12,5"],
  ]);
});

test("CSV : guillemets échappés (\"\") à l'intérieur d'un champ entre guillemets", () => {
  const text = 'Nom\n"Le ""Spécial"" du chef"\n';
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [["Nom"], ['Le "Spécial" du chef']]);
});

test("CSV : retour à la ligne À L'INTÉRIEUR d'un champ entre guillemets (description longue multi-ligne)", () => {
  const text = 'Nom,Description longue\nPizza,"Ligne 1\nLigne 2"\n';
  const rows = parseCsvText(text);
  assert.deepEqual(rows, [
    ["Nom", "Description longue"],
    ["Pizza", "Ligne 1\nLigne 2"],
  ]);
});

test("CSV : BOM UTF-8 initial retiré avant lecture de l'en-tête", () => {
  const text = "﻿Type,Nom\nProduit,Pizza\n";
  const rows = parseCsvText(text);
  assert.deepEqual(rows[0], ["Type", "Nom"]);
});

test("CSV : fichier vide -> CsvReadError EMPTY_FILE", () => {
  assert.throws(
    () => readCsvWorkbook("", 0),
    (e: unknown) => e instanceof CsvReadError && e.code === "EMPTY_FILE"
  );
});

test("CSV : fichier trop volumineux -> CsvReadError FILE_TOO_LARGE", () => {
  assert.throws(
    () => readCsvWorkbook("Nom\nPizza\n", 999_999_999),
    (e: unknown) => e instanceof CsvReadError && e.code === "FILE_TOO_LARGE"
  );
});

// ------------------------------------------------------------------
// column-mapping.ts
// ------------------------------------------------------------------

test("2. missing required columns : Nom absent -> missingRequired contient 'Nom'", () => {
  const map = resolveColumnMap(["Type", "Catégorie parent", "Prix TTC (€)"]);
  assert.deepEqual(map.missingRequired, ["Nom"]);
});

test("toutes les colonnes requises absentes -> les 3 sont listées", () => {
  const map = resolveColumnMap(["Type", "Tags / Collections"]);
  assert.deepEqual(map.missingRequired, [...REQUIRED_IMPORT_COLUMNS]);
});

test("en-tête complet et exact -> aucune colonne manquante, tous les index résolus", () => {
  const map = resolveColumnMap([...IMPORT_COLUMNS]);
  assert.deepEqual(map.missingRequired, []);
  for (let i = 0; i < IMPORT_COLUMNS.length; i++) {
    assert.equal(map.indexOf[IMPORT_COLUMNS[i]], i);
  }
});

test("en-tête insensible à la casse et aux espaces superflus", () => {
  const map = resolveColumnMap(["  nom  ", "PRIX TTC (€)", "catégorie parent"]);
  assert.deepEqual(map.missingRequired, []);
});

test("alias tolérés explicitement (Tags/Collections sans espaces, TVA seul, Poids seul)", () => {
  const map = resolveColumnMap(["Nom", "Catégorie parent", "Prix TTC (€)", "Tags/Collections", "TVA", "Poids"]);
  assert.equal(map.indexOf["Tags / Collections"], 3);
  assert.equal(map.indexOf["TVA (%)"], 4);
  assert.equal(map.indexOf["Poids (g)"], 5);
});

test("colonne non reconnue -> surfacée dans unrecognizedHeaders, jamais une erreur bloquante ni une correspondance devinée", () => {
  const map = resolveColumnMap(["Nom", "Catégorie parent", "Prix TTC (€)", "Colonne Mystère"]);
  assert.deepEqual(map.missingRequired, []);
  assert.deepEqual(map.unrecognizedHeaders, ["Colonne Mystère"]);
});

test("colonne dupliquée dans l'en-tête -> la PREMIÈRE occurrence gagne (déterministe)", () => {
  const map = resolveColumnMap(["Nom", "Nom", "Catégorie parent", "Prix TTC (€)"]);
  assert.equal(map.indexOf["Nom"], 0);
});
