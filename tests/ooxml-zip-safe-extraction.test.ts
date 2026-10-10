import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as zip from "../lib/ooxml/zip-safe.ts";
import { buildXlsxWorkbook, patchCentralDirectoryDeclaredSize, injectDuplicateCentralDirectoryEntry } from "./helpers/xlsx-fixture-builder.ts";

// Optional external baseline URL permits the SAME fixtures and literal assertions
// to run against the pinned predecessor without changing any existing suite.
const reader = await import(process.env.W0_READER_URL ?? "../lib/catalogue-import/xlsx-reader.ts");
const { readXlsxWorkbook, XlsxReadError } = reader;
const sharedSource = readFileSync(new URL("../lib/ooxml/zip-safe.ts", import.meta.url), "utf8");
const readerSource = readFileSync(new URL("../lib/catalogue-import/xlsx-reader.ts", import.meta.url), "utf8");
const makeError: zip.OoxmlZipErrorFactory = (code, message) => Object.assign(new Error(message), { code });
const workbook = "xl/workbook.xml";
const sheet = "xl/worksheets/sheet1.xml";
const strings = "xl/sharedStrings.xml";
const fixture = () => buildXlsxWorkbook([["hello", 12]]);

// Change only the selected central record's compression method. For the
// unreadable-stream fixture also poison its local payload with reserved BTYPE=3.
function changeCompression(buffer: ArrayBuffer, name: string, method: number, poison = false): ArrayBuffer {
  const copy = buffer.slice(0);
  const bytes = new Uint8Array(copy);
  const view = new DataView(copy);
  const eocd = bytes.length - 22;
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < view.getUint16(eocd + 10, true); i++) {
    const length = view.getUint16(offset + 28, true);
    const entryName = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length));
    if (entryName === name) {
      view.setUint16(offset + 10, method, true);
      if (poison) {
        const local = view.getUint32(offset + 42, true);
        const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        bytes[data] = 7;
      }
      return copy;
    }
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error("Missing fixture entry");
}

const messageCases = [
  { name: "upload", buffer: () => new ArrayBuffer(10485761), code: "FILE_TOO_LARGE", message: "Fichier trop volumineux (10485761 octets, limite 10485760 octets)." },
  { name: "signature", buffer: () => new ArrayBuffer(4), code: "NOT_A_ZIP_CONTAINER", message: "Le fichier ne commence pas par une signature ZIP valide -- ce n'est pas un fichier .xlsx (jamais une confiance dans l'extension seule)." },
  { name: "central directory", buffer: () => new Uint8Array([80, 75, 3, 4]).buffer, code: "MALFORMED_WORKBOOK", message: "Répertoire central de l'archive ZIP illisible." },
  { name: "compression", buffer: () => changeCompression(fixture(), workbook, 99), code: "MALFORMED_WORKBOOK", message: "Méthode de compression non prise en charge pour « xl/workbook.xml »." },
  { name: "unreadable stream", buffer: () => changeCompression(fixture(), workbook, 8, true), code: "MALFORMED_WORKBOOK", message: "Le conteneur ZIP est corrompu ou illisible." },
  { name: "duplicate", buffer: () => injectDuplicateCentralDirectoryEntry(fixture(), workbook, "duplicate"), code: "DUPLICATE_ZIP_ENTRY", message: "Entrée « xl/workbook.xml » présente 2 fois dans l'archive -- rejetée avant tout désarchivage, aucune résolution automatique entre occurrences." },
  { name: "entry size", buffer: () => patchCentralDirectoryDeclaredSize(fixture(), workbook, 2097153), code: "ENTRY_TOO_LARGE", message: "Entrée « xl/workbook.xml » trop volumineuse une fois décompressée (2097153 octets déclarés, limite 2097152 octets) -- rejetée avant désarchivage." },
  { name: "total size", buffer: () => patchCentralDirectoryDeclaredSize(patchCentralDirectoryDeclaredSize(fixture(), sheet, 67108864), strings, 67108864), code: "ENTRY_TOO_LARGE", message: "Volume total décompressé requis (134218455 octets) dépasse la limite globale 104857600 octets -- rejeté avant désarchivage de « xl/sharedStrings.xml »." },
];

for (const c of messageCases) {
  test(`W0-T-01 | exact public error | ${c.name}`, (t) => {
    assert.throws(() => readXlsxWorkbook(c.buffer()), (error: unknown) => {
      assert.ok(error instanceof XlsxReadError);
      const actual = error as Error & { code: string };
      t.diagnostic(JSON.stringify({ cause: c.name, code: actual.code, message: actual.message }));
      assert.equal(actual.name, "XlsxReadError");
      assert.equal(actual.code, c.code);
      assert.equal(actual.message, c.message);
      return true;
    });
  });
}

function parse(source: string) {
  return ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

test("W0-T-03 | AST dependency allowlist: shared module imports only fflate", () => {
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      assert.fail("No dynamic or CommonJS dependency permitted in the shared module");
    }
    ts.forEachChild(node, visit);
  }
  visit(parse(sharedSource));
  // W1 SECOND REMEDIATION (Windows/fflate harness fix): the shared
  // module now imports the EXPLICIT "fflate/browser" subpath instead
  // of the bare "fflate" specifier -- see lib/docx/docx-writer.ts's
  // own import comment for the full cross-resolver rationale. Still
  // exactly ONE import, still `fflate` (now its own unconditional
  // subpath) and nothing else -- the allowlist itself is unchanged in
  // spirit, only the exact string it permits is updated to match.
  assert.deepEqual(imports, ["fflate/browser"]);
});

test("W0-T-04 | exact exported limits and unchanged public runtime exports", () => {
  for (const [name, value] of Object.entries({ MAX_IMPORT_FILE_SIZE_BYTES: 10485760,
    MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES: 2097152, MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES: 67108864,
    MAX_TOTAL_UNCOMPRESSED_BYTES: 104857600 })) {
    assert.equal(zip[name as keyof typeof zip], value);
    assert.equal(reader[name], value);
  }
  assert.deepEqual(Object.keys(reader).sort(), ["MAX_IMPORT_FILE_SIZE_BYTES", "MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES",
    "MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES", "MAX_TOTAL_UNCOMPRESSED_BYTES", "XlsxReadError", "checkZipSignature",
    "unescapeXmlEntities", "columnLettersToIndex", "parseSharedStrings", "parseWorksheet", "readXlsxWorkbook"].sort());
});

function unionValues(source: string, name: string) {
  const node = parse(source).statements.find((n): n is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(n) && n.name.text === name);
  assert.ok(node && ts.isUnionTypeNode(node.type));
  return node.type.types.map(n => {
    assert.ok(ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal));
    return n.literal.text;
  }).sort();
}

test("W0-T-05 | exact seven public and five internal error codes", () => {
  assert.deepEqual(unionValues(readerSource, "XlsxReadErrorCode"), ["FILE_TOO_LARGE", "NOT_A_ZIP_CONTAINER", "MALFORMED_WORKBOOK",
    "NO_WORKSHEET_FOUND", "EMPTY_WORKSHEET", "ENTRY_TOO_LARGE", "DUPLICATE_ZIP_ENTRY"].sort());
  assert.deepEqual(unionValues(sharedSource, "OoxmlZipFailure"), ["FILE_TOO_LARGE", "NOT_A_ZIP_CONTAINER",
    "MALFORMED_CONTAINER", "ENTRY_TOO_LARGE", "DUPLICATE_ZIP_ENTRY"].sort());
});

test("W0-T-06 | manifest never inflates; oversize beats poisoned deflate; extraction stays targeted", () => {
  const poisoned = changeCompression(fixture(), workbook, 8, true);
  const oversized = patchCentralDirectoryDeclaredSize(poisoned, workbook, 2097153);
  // Positive control: the payload really throws when actually inflated.
  assert.throws(() => zip.extractOnly(makeError, new Uint8Array(poisoned), new Set([workbook])),
    { code: "MALFORMED_CONTAINER", message: "Le conteneur ZIP est corrompu ou illisible." });
  const manifest = zip.buildZipManifest(makeError, new Uint8Array(oversized));
  assert.equal(manifest.get(workbook)?.originalSize, 2097153);
  assert.throws(() => readXlsxWorkbook(oversized), { code: "ENTRY_TOO_LARGE" });
  // Irrelevant poisoned entry is never decompressed during a normal read.
  const unrelated = changeCompression(buildXlsxWorkbook([["hello", 12]], { extraFiles: { "unused.bin": "bad stream" } }), "unused.bin", 8, true);
  assert.deepEqual(readXlsxWorkbook(unrelated).rows, [["hello", "12"]]);
  assert.deepEqual(zip.extractOnly(makeError, new Uint8Array(unrelated), new Set()), {});
});

test("W0-T-07 | shared module contains no format-specific knowledge", () => {
  for (const word of ["XlsxReadError", "xlsx", "worksheet", "sharedStrings"]) {
    assert.equal(sharedSource.toLowerCase().includes(word.toLowerCase()), false, word);
  }
});
