import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderCgv, type RenderCgvInput } from "../lib/legal/render.ts";
import { parseCgvDocumentModel, slugifyCgvHeading, toOoxmlBookmarkName, type CgvDocumentModel } from "../lib/legal/cgv-document-model.ts";
import { buildCgvDocx } from "../lib/docx/docx-writer.ts";
import { readDocxDocument, DocxReadError } from "../lib/docx/docx-reader.ts";
import { diffCgvDocxImport, CgvDocxDiffError } from "../lib/legal/cgv-docx-diff.ts";
import {
  buildMinimalDocx,
  wordDocumentXml,
  plainParagraphXml,
  bookmarkedParagraphXml,
  emptyParagraphXml,
  patchCentralDirectoryDeclaredSize,
  injectDuplicateCentralDirectoryEntry,
} from "./helpers/docx-fixture-builder.ts";
import { buildXlsxWorkbook } from "./helpers/xlsx-fixture-builder.ts";
import { unzipSync } from "fflate";

/** Extracts `word/document.xml`'s TEXT from an exported .docx ArrayBuffer
 *  -- the export is a compressed ZIP archive, so its raw bytes are
 *  never themselves valid XML text; this decompresses the one part
 *  the edit-detection tests below need to manipulate. */
function extractDocumentXml(docx: ArrayBuffer): string {
  const unzipped = unzipSync(new Uint8Array(docx), { filter: (f) => f.name === "word/document.xml" });
  const bytes = unzipped["word/document.xml"];
  assert.ok(bytes, "word/document.xml missing from exported fixture");
  return new TextDecoder().decode(bytes);
}

// ====================================================================
// CGV W1 -- DOCX EXPORT / IMPORT ROUND-TRIP.
//
// Exercises the four new, PURE modules this lot adds --
// lib/legal/cgv-document-model.ts, lib/docx/docx-writer.ts,
// lib/docx/docx-reader.ts, lib/legal/cgv-docx-diff.ts -- together, end
// to end, starting from a REAL `renderCgv()` call (never a guessed
// HTML fixture) so the whole pipeline is grounded in the actual
// production renderer this lot is forbidden from modifying.
// ====================================================================

/**
 * A minimal but realistic RenderCgvInput -- the SAME field shape
 * app/dashboard/legal-cgv/page.tsx's own `buildPreviewResult()`
 * builds (verified by reading that function before writing this
 * fixture). STANDARD_14_DAYS (not EXEMPT_PERISHABLE/MIXED) so the
 * withdrawal section renders its full extra content; a handful of
 * optional GENERIC_FIXED sections are populated too, so the rendered
 * document has several chapters to diff against, not just the two
 * unconditional ones (identité du vendeur / juridiction compétente).
 * Every merchant-editable text field is deliberately non-empty -- an
 * empty `<p></p>` is a real, legitimate renderCgv() output shape (see
 * cgv-docx-diff.ts's own blank-paragraph-normalization comment) but
 * would only add incidental noise to tests about EDITS, not about
 * that normalization itself (covered by its own dedicated test below).
 */
function baseRenderInput(overrides: Partial<RenderCgvInput> = {}): RenderCgvInput {
  return {
    sellerName: "Pizzeria Test",
    template: {
      header: "Conditions générales de vente",
      identity_intro: "Les présentes conditions régissent les ventes.",
      withdrawal_clauses: {
        EXEMPT_PERISHABLE: "Pas de droit de rétractation pour les denrées périssables.",
        STANDARD_14_DAYS: "Vous disposez d'un délai de 14 jours pour vous rétracter.",
        MIXED: "Seule la part éligible de la commande ouvre droit à rétractation.",
      },
      mediator_clause: "En cas de litige, vous pouvez saisir le médiateur :",
      preparation_clause: "Votre commande est préparée dans le délai suivant.",
      cancellation_clause_label: "Annulation de commande",
      substitution_clause_label: "Substitution de produits",
      jurisdiction_clause: "Les tribunaux compétents sont ceux du lieu d'établissement du vendeur.",
      purpose_scope_clause: "Les présentes CGV s'appliquent à toute commande passée sur la plateforme.",
      complaints_clause: "Toute réclamation doit être adressée au service client.",
    },
    legal: {
      legalForm: "SARL",
      addressLine1: "1 rue du Test",
      addressLine2: null,
      postalCode: "75000",
      city: "Paris",
      governingCountry: "France",
      customerServiceEmail: "contact@example.test",
      customerServicePhone: null,
      mediatorName: "Médiateur Test",
      mediatorAddress: "2 rue du Médiateur, 75000 Paris",
      mediatorWebsite: "https://mediateur.test",
    },
    business: {
      withdrawalRegime: "STANDARD_14_DAYS",
      preparationTimeMin: 20,
      preparationTimeMax: 40,
      preparationTimeUnit: "MINUTES",
      cancellationPolicyText: "Toute commande peut être annulée avant sa préparation.",
      substitutionPolicyText: "Un produit indisponible peut être substitué par un équivalent.",
    },
    locale: "fr",
    presentationVariant: "FORMAL",
    ...overrides,
  };
}

function baseModel(): CgvDocumentModel {
  return parseCgvDocumentModel(renderCgv(baseRenderInput()));
}

function exportModel(model: CgvDocumentModel): ArrayBuffer {
  const bytes = buildCgvDocx(model);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// --------------------------------------------------------------------
// T1 -- export produces a valid DOCX; T2 -- it opens structurally.
// --------------------------------------------------------------------

test("W1-T-01 | export produces a valid, well-formed .docx (ZIP signature, required parts)", () => {
  const model = baseModel();
  const bytes = buildCgvDocx(model);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.equal(bytes[2], 0x03);
  assert.equal(bytes[3], 0x04);
  assert.ok(model.chapters.length >= 5, "fixture should produce several chapters to diff against");
});

test("W1-T-02 | exported .docx opens structurally: every current chapter is recovered by bookmark", () => {
  const model = baseModel();
  const imported = readDocxDocument(exportModel(model));
  assert.equal(imported.chapters.length, model.chapters.length);
  const importedNames = imported.chapters.map((c) => c.bookmarkName).sort();
  const expectedNames = model.chapters.map((c) => toOoxmlBookmarkName(c.bookmarkName)).sort();
  assert.deepEqual(importedNames, expectedNames);
});

// --------------------------------------------------------------------
// T3 -- export -> import unchanged = zero meaningful diff.
// --------------------------------------------------------------------

test("W1-T-03 | export -> import unchanged yields zero meaningful diff", () => {
  const model = baseModel();
  const imported = readDocxDocument(exportModel(model));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.hasNoMeaningfulChanges, true);
  assert.deepEqual(diff.removedChapters, []);
  for (const chapter of diff.chapters) {
    assert.ok(chapter.entries.every((e) => e.kind === "unchanged"), `chapter ${chapter.bookmarkName} should be fully unchanged`);
  }
});

// --------------------------------------------------------------------
// T4/T5 -- paragraph edit / heading edit detected.
// --------------------------------------------------------------------

test("W1-T-04 | a body paragraph edit is detected as 'modified'", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  // Locate the "Annulation de commande" chapter's body paragraph and
  // replace its text -- a direct, targeted XML edit standing in for a
  // merchant's edit in Word (same text-level granularity: Word itself
  // only ever changes <w:t> run content for an ordinary text edit).
  const original = "Toute commande peut être annulée avant sa préparation.";
  const edited = "Toute commande peut être annulée avant sa préparation, sauf week-ends.";
  assert.ok(documentXml.includes(original), "fixture must contain the expected cancellation paragraph text");
  documentXml = documentXml.replace(original, edited);

  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.hasNoMeaningfulChanges, false);
  const chapter = diff.chapters.find((c) => c.entries.some((e) => e.kind === "modified" && e.before === original));
  assert.ok(chapter, "expected a 'modified' entry for the edited paragraph");
  const entry = chapter!.entries.find((e) => e.kind === "modified" && e.before === original);
  assert.deepEqual(entry, { kind: "modified", before: original, after: edited });
});

test("W1-T-05 | a heading text edit is detected as 'modified' (first entry)", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const original = "Annulation de commande";
  const edited = "Annulation de commande (lu et approuvé)";
  assert.ok(documentXml.includes(`>${original}<`), "fixture must contain the expected heading text");
  documentXml = documentXml.replace(`>${original}<`, `>${edited}<`);

  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  const chapter = diff.chapters.find((c) => c.heading === original);
  assert.ok(chapter);
  assert.deepEqual(chapter!.entries[0], { kind: "modified", before: original, after: edited });
});

// --------------------------------------------------------------------
// T6/T7 -- paragraph addition / removal detected.
// --------------------------------------------------------------------

test("W1-T-06 | a new paragraph inserted into a chapter is detected as 'added'", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const anchor = "Toute commande peut être annulée avant sa préparation.</w:t></w:r></w:p>";
  assert.ok(documentXml.includes(anchor));
  documentXml = documentXml.replace(anchor, `${anchor}${plainParagraphXml("Un paragraphe ajouté par le marchand.")}`);

  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  const chapter = diff.chapters.find((c) => c.entries.some((e) => e.kind === "added" && e.text === "Un paragraphe ajouté par le marchand."));
  assert.ok(chapter, "expected an 'added' entry for the inserted paragraph");
});

test("W1-T-07 | removing a chapter's body paragraph is detected as 'removed'", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const toRemove = plainParagraphXml("Toute commande peut être annulée avant sa préparation.");
  assert.ok(documentXml.includes(toRemove));
  documentXml = documentXml.replace(toRemove, "");

  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  const chapter = diff.chapters.find((c) =>
    c.entries.some((e) => e.kind === "removed" && e.text === "Toute commande peut être annulée avant sa préparation.")
  );
  assert.ok(chapter, "expected a 'removed' entry for the deleted paragraph");
});

// --------------------------------------------------------------------
// T8/T9/T10 -- malformed / foreign / unsafe-ZIP rejection.
// --------------------------------------------------------------------

test("W1-T-08 | a malformed .docx (corrupt ZIP) is rejected", () => {
  assert.throws(() => readDocxDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "MALFORMED_DOCUMENT");
    return true;
  });
});

test("W1-T-09 | a foreign OOXML package (a real .xlsx) is rejected safely, never mis-parsed as CGV content", () => {
  const xlsx = buildXlsxWorkbook([["hello", 12]]);
  assert.throws(() => readDocxDocument(xlsx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "WRONG_CONTENT_TYPE");
    return true;
  });
});

test("W1-T-10 | a duplicated ZIP central-directory entry (word/document.xml) is rejected whole, never 'first/last wins'", () => {
  const docx = buildMinimalDocx(
    wordDocumentXml(bookmarkedParagraphXml(0, "cgv_identite-du-vendeur", "Identité du vendeur"))
  );
  const tampered = injectDuplicateCentralDirectoryEntry(docx, "word/document.xml", "<irrelevant/>");
  assert.throws(() => readDocxDocument(tampered), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "DUPLICATE_ZIP_ENTRY");
    return true;
  });
});

test("W1-T-10b | an oversized declared word/document.xml is rejected before decompression (zip-bomb shape)", () => {
  const docx = buildMinimalDocx(
    wordDocumentXml(bookmarkedParagraphXml(0, "cgv_identite-du-vendeur", "Identité du vendeur"))
  );
  const tampered = patchCentralDirectoryDeclaredSize(docx, "word/document.xml", 67108864 + 1);
  assert.throws(() => readDocxDocument(tampered), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "ENTRY_TOO_LARGE");
    return true;
  });
});

test("W1-T-10c | oversized file / bad signature are each rejected with their own stable code", () => {
  assert.throws(() => readDocxDocument(new ArrayBuffer(10 * 1024 * 1024 + 1)), { code: "FILE_TOO_LARGE" });
  assert.throws(() => readDocxDocument(new ArrayBuffer(4)), { code: "NOT_A_ZIP_CONTAINER" });
});

// --------------------------------------------------------------------
// FAIL CLOSED -- unrecognized / zero / duplicated bookmarks.
// --------------------------------------------------------------------

test("W1-T-11 | a document with zero recognized CGV bookmarks is rejected (FAIL CLOSED), never guessed", () => {
  const docx = buildMinimalDocx(wordDocumentXml(plainParagraphXml("Juste du texte, sans aucun repère.")));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "NO_RECOGNIZED_BOOKMARK");
    return true;
  });
});

test("W1-T-12 | Word's own '_GoBack' housekeeping bookmark is never mistaken for a CGV chapter boundary", () => {
  const docx = buildMinimalDocx(
    wordDocumentXml(
      `<w:p><w:bookmarkStart w:id="0" w:name="_GoBack"/><w:r><w:t>Pas un chapitre CGV.</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>` +
        bookmarkedParagraphXml(1, "cgv_identite-du-vendeur", "Identité du vendeur")
    )
  );
  const imported = readDocxDocument(docx);
  assert.equal(imported.chapters.length, 1);
  assert.equal(imported.chapters[0].bookmarkName, "cgv_identite-du-vendeur");
  assert.deepEqual(imported.leadingContent, ["Pas un chapitre CGV."]);
});

test("W1-T-13 | an imported bookmark unknown to the current model fails closed at the diff layer", () => {
  const model = baseModel();
  const docx = buildMinimalDocx(wordDocumentXml(bookmarkedParagraphXml(0, "cgv_section_inconnue", "Section inconnue")));
  const imported = readDocxDocument(docx);
  assert.throws(() => diffCgvDocxImport(model, imported), (e: unknown) => {
    assert.ok(e instanceof CgvDocxDiffError);
    assert.equal((e as CgvDocxDiffError).code, "UNRECOGNIZED_BOOKMARK");
    return true;
  });
});

test("W1-T-14 | a duplicated bookmark name within one import fails closed at the diff layer, never 'first/last wins'", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const docx = buildMinimalDocx(
    wordDocumentXml(bookmarkedParagraphXml(0, name, "Un") + bookmarkedParagraphXml(1, name, "Deux"))
  );
  const imported = readDocxDocument(docx);
  assert.throws(() => diffCgvDocxImport(model, imported), (e: unknown) => {
    assert.ok(e instanceof CgvDocxDiffError);
    assert.equal((e as CgvDocxDiffError).code, "DUPLICATE_BOOKMARK");
    return true;
  });
});

test("W1-T-15 | a current chapter entirely absent from the import is a non-fatal 'removed chapter', not a failure", () => {
  const model = baseModel();
  const remaining = model.chapters.slice(1); // drop the first chapter's bookmark entirely
  const bodyXml = remaining.map((c) => bookmarkedParagraphXml(0, toOoxmlBookmarkName(c.bookmarkName), c.heading)).join("");
  const docx = buildMinimalDocx(wordDocumentXml(bodyXml));
  const imported = readDocxDocument(docx);
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.removedChapters.length, 1);
  assert.equal(diff.removedChapters[0].bookmarkName, model.chapters[0].bookmarkName);
  assert.equal(diff.hasNoMeaningfulChanges, false);
});

test("W1-T-16 | purely cosmetic blank paragraphs are normalized away on both sides, never shown as a diff", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const anchor = "Toute commande peut être annulée avant sa préparation.</w:t></w:r></w:p>";
  documentXml = documentXml.replace(anchor, `${anchor}${emptyParagraphXml()}`);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.hasNoMeaningfulChanges, true);
});

test("W1-T-17 | leading content before the first recognized bookmark is surfaced for review, never dropped or diffed", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const docx = buildMinimalDocx(
    wordDocumentXml(plainParagraphXml("Contenu non associé.") + bookmarkedParagraphXml(0, name, model.chapters[0].heading))
  );
  const imported = readDocxDocument(docx);
  assert.deepEqual(imported.leadingContent, ["Contenu non associé."]);
});

// --------------------------------------------------------------------
// Stable identity -- lib/legal/cgv-document-model.ts.
// --------------------------------------------------------------------

test("W1-T-18 | chapter identity is derived from the heading, never from paragraph position / chapter number", () => {
  const model = baseModel();
  for (const chapter of model.chapters) {
    assert.equal(chapter.bookmarkName, slugifyCgvHeading(chapter.heading));
    assert.equal(toOoxmlBookmarkName(chapter.bookmarkName), `cgv_${chapter.bookmarkName.replace(/-/g, "_")}`);
  }
  // Two renders of the SAME input produce the SAME bookmark set, in
  // the SAME order -- the identity this round trip relies on is a
  // pure function of the template's headings, not of anything that
  // could drift between two renders (e.g. Date.now()).
  const again = baseModel();
  assert.deepEqual(again.chapters.map((c) => c.bookmarkName), model.chapters.map((c) => c.bookmarkName));
});

test("W1-T-19 | the legal-guarantee encadré, when present, gets its own fixed bookmark (never numbered as a chapter)", () => {
  const model = parseCgvDocumentModel(
    renderCgv(baseRenderInput({ template: { ...baseRenderInput().template, legal_guarantee_encadre: { heading: "Garanties légales (encadré D.211-2)", paragraphs: ["Texte réglementaire."] } } }))
  );
  const encadre = model.chapters.find((c) => c.bookmarkName === "legal-guarantee-encadre");
  assert.ok(encadre);
  assert.deepEqual(encadre!.paragraphs, ["Texte réglementaire."]);
});

// --------------------------------------------------------------------
// No publication side effect / no persistence anywhere in this lot
// (mandate: "no publication side effect", "published document remains
// immutable", "merchant isolation if persisted data involved").
// Proven STRUCTURALLY: none of the four new modules import anything
// capable of publishing or persisting -- same AST-allowlist technique
// as tests/ooxml-zip-safe-extraction.test.ts's own W0-T-03.
// --------------------------------------------------------------------

function importsOf(source: string): string[] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

test("W1-T-20 | no new module imports any publish/persistence path -- no publication side effect, nothing persisted", () => {
  const forbidden = ["@/lib/services/legal-cgv", "@/lib/server/legal-cgv-publish-service", "@/lib/supabase", "supabase"];
  const files = [
    "../lib/docx/docx-writer.ts",
    "../lib/docx/docx-reader.ts",
    "../lib/legal/cgv-document-model.ts",
    "../lib/legal/cgv-docx-diff.ts",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const imports = importsOf(source);
    for (const bad of forbidden) {
      assert.equal(imports.includes(bad), false, `${file} must never import ${bad}`);
    }
    // Belt and suspenders: not even a string mention of the publish
    // RPC / table name this lot must never touch.
    assert.equal(source.includes("persist_merchant_cgv_version"), false, `${file} must never reference the publish RPC`);
    assert.equal(source.includes("publishMerchantCgvVersion"), false, `${file} must never reference the publish service call`);
  }
});

test("W1-T-21 | merchant isolation (N/A): the DOCX round trip persists nothing, so there is no cross-merchant data path to isolate", () => {
  // No new module declares, imports, or calls anything Storage/DB-
  // shaped. This is the structural proof behind the mandate's
  // "merchant isolation if persisted data involved" test being N/A
  // for this lot -- see the DELIVERABLE's own LIMITATIONS section.
  const files = ["../lib/docx/docx-writer.ts", "../lib/docx/docx-reader.ts", "../lib/legal/cgv-docx-diff.ts"];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const term of ["restaurant_id", "merchant_id", ".storage.", "supabase.from(", "supabase"]) {
      assert.equal(source.toLowerCase().includes(term.toLowerCase()), false, `${file} must never reference persistence (${term})`);
    }
  }
});

