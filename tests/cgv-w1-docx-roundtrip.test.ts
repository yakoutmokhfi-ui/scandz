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

test("W1-T-14 | a duplicated bookmark name within one import fails closed, never 'first/last wins' (W1-03: now caught earlier, at the reader's global bookmark validation, never even reaching the diff layer)", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const docx = buildMinimalDocx(
    wordDocumentXml(bookmarkedParagraphXml(0, name, "Un") + bookmarkedParagraphXml(1, name, "Deux"))
  );
  // W1-03 REMEDIATION -- the audit's own required fix ("Validate ALL
  // CGV bookmarks globally before review construction… Reject:
  // duplicate CGV bookmark name") moved this rejection from
  // `diffCgvDocxImport` into `readDocxDocument` itself: the document
  // model is now never even constructed for an import this ambiguous,
  // let alone handed to the diff engine. `diffCgvDocxImport`'s own
  // duplicate check (unchanged) remains as defense-in-depth for any
  // caller that builds a `DocxImportResult` by hand instead of via
  // `readDocxDocument` -- but the normal pipeline never reaches it for
  // this case any more.
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "DUPLICATE_BOOKMARK_IDENTITY");
    return true;
  });
});

test("W1-T-15 | a current chapter entirely absent from the import is a non-fatal 'removed chapter', not a failure", () => {
  const model = baseModel();
  const remaining = model.chapters.slice(1); // drop the first chapter's bookmark entirely
  // W1-03 REMEDIATION -- each paragraph now needs its OWN w:id (the
  // new global bookmark validation rejects an id reused across
  // multiple bookmarkStart/End pairs as malformed nesting, exactly as
  // a real document never reuses one); the OLD fixture reused `0`
  // for every chapter, which only ever happened to work because
  // nothing previously cross-checked ids globally.
  const bodyXml = remaining
    .map((c, i) => bookmarkedParagraphXml(i, toOoxmlBookmarkName(c.bookmarkName), c.heading))
    .join("");
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

// ====================================================================
// W1 TARGETED REMEDIATION (BOULEZ audit, candidate c5924a5, FAIL).
// ====================================================================
//
// W1-01 -- CHAPTER ORDER.
// ====================================================================

/** Builds one chapter's exact OOXML block (heading bookmark paragraph
 *  + body paragraphs), mirroring lib/docx/docx-writer.ts's own shape
 *  for a single chapter -- used below to hand-assemble FULL,
 *  reordered exports directly from a `CgvDocumentModel`'s chapters. */
function chapterBlockXml(chapter: { bookmarkName: string; heading: string; paragraphs: string[] }, bookmarkId: number): string {
  return (
    bookmarkedParagraphXml(bookmarkId, toOoxmlBookmarkName(chapter.bookmarkName), chapter.heading) +
    chapter.paragraphs.map((p) => plainParagraphXml(p)).join("")
  );
}

/** Exports a FULL document containing exactly the chapters at
 *  `chapterIndices` (into `model.chapters`), in THAT order -- the one
 *  tool needed for every W1-01 scenario below: unchanged order, swaps,
 *  full reversal, and dropping an index entirely (chapter removed).
 *  Front matter is carried over UNCHANGED (plain paragraphs, matching
 *  `model.frontMatter` exactly) so these order-focused fixtures never
 *  incidentally trip the (separate, W1-02) front-matter diff -- each
 *  W1-01 test below isolates ONE signal at a time. */
function exportChapterSubset(model: CgvDocumentModel, chapterIndices: number[]): ArrayBuffer {
  const frontMatterXml = model.frontMatter.map((line) => plainParagraphXml(line)).join("");
  const body = frontMatterXml + chapterIndices.map((idx, i) => chapterBlockXml(model.chapters[idx], i)).join("");
  return buildMinimalDocx(wordDocumentXml(body));
}

test("W1-T-41 | unchanged chapter order yields orderChanged=false (no spurious reorder signal)", () => {
  const model = baseModel();
  const all = model.chapters.map((_, i) => i);
  const imported = readDocxDocument(exportChapterSubset(model, all));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.orderChanged, false);
  assert.equal(diff.hasNoMeaningfulChanges, true);
});

test("W1-T-42 | an adjacent swap of two chapters is surfaced as a meaningful reorder", () => {
  const model = baseModel();
  assert.ok(model.chapters.length >= 2);
  const swapped = [1, 0, ...model.chapters.map((_, i) => i).slice(2)];
  const imported = readDocxDocument(exportChapterSubset(model, swapped));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.orderChanged, true);
  assert.equal(diff.hasNoMeaningfulChanges, false);
  // Bookmark identity preserved -- never a false added/removed.
  assert.deepEqual(diff.removedChapters, []);
  assert.equal(diff.chapters.length, model.chapters.length);
});

test("W1-T-43 | a full reversal of chapter order is surfaced as a meaningful reorder", () => {
  const model = baseModel();
  const reversed = model.chapters.map((_, i) => i).reverse();
  const imported = readDocxDocument(exportChapterSubset(model, reversed));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.orderChanged, true);
  assert.equal(diff.hasNoMeaningfulChanges, false);
  assert.deepEqual(diff.removedChapters, []);
  assert.deepEqual(diff.importedOrder, reversed.map((i) => model.chapters[i].bookmarkName));
});

test("W1-T-44 | a reorder combined with a body edit surfaces BOTH signals (never one masking the other)", () => {
  const model = baseModel();
  assert.ok(model.chapters.length >= 2);
  const swapped = [1, 0, ...model.chapters.map((_, i) => i).slice(2)];
  const edited = model.chapters.map((c, i) =>
    i === 0 ? { ...c, paragraphs: c.paragraphs.map((p, j) => (j === 0 ? `${p} (modifié)` : p)) } : c
  );
  const frontMatterXml = model.frontMatter.map((line) => plainParagraphXml(line)).join("");
  const body = frontMatterXml + swapped.map((idx, i) => chapterBlockXml(edited[idx], i)).join("");
  const imported = readDocxDocument(buildMinimalDocx(wordDocumentXml(body)));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.orderChanged, true, "the reorder must still be surfaced");
  const editedChapter = diff.chapters.find((c) => c.bookmarkName === model.chapters[0].bookmarkName);
  assert.ok(editedChapter, "the body edit must still be surfaced, on its own chapter");
  assert.ok(
    editedChapter!.entries.some((e) => e.kind !== "unchanged"),
    "the body edit must still be surfaced, independently of the reorder signal"
  );
});

test("W1-T-45 | a chapter removed AND the remaining chapters reordered are BOTH surfaced, independently", () => {
  const model = baseModel();
  assert.ok(model.chapters.length >= 3);
  // Drop chapter 0 entirely, and reorder what remains (2,1 swapped
  // relative to the current model's own order 1,2,...).
  const remainingReordered = [2, 1, ...model.chapters.map((_, i) => i).slice(3)];
  const imported = readDocxDocument(exportChapterSubset(model, remainingReordered));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.removedChapters.length, 1);
  assert.equal(diff.removedChapters[0].bookmarkName, model.chapters[0].bookmarkName);
  assert.equal(diff.orderChanged, true, "the remaining chapters' reorder must still be surfaced despite the removal");
  assert.equal(diff.hasNoMeaningfulChanges, false);
});

test("W1-T-46 | a chapter removed with the remaining chapters UNCHANGED in order never spuriously sets orderChanged (conditional disappearance check)", () => {
  const model = baseModel();
  assert.ok(model.chapters.length >= 3);
  // Drop chapter 0 entirely (simulating a CONDITIONAL section that no
  // longer applies); everything else keeps its current-model order.
  const remainingInOrder = model.chapters.map((_, i) => i).slice(1);
  const imported = readDocxDocument(exportChapterSubset(model, remainingInOrder));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.removedChapters.length, 1);
  assert.equal(
    diff.orderChanged,
    false,
    "removal alone, with no actual reordering of what remains, must never be misreported as a reorder"
  );
});

// ====================================================================
// W1-02 -- CONTENT FIDELITY / NO SILENT LOSS.
// ====================================================================

test("W1-T-47 | a tab character (w:tab) inserted into a paragraph changes the diff, never silently dropped", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const original = "Toute commande peut être annulée avant sa préparation.";
  const withTab =
    `<w:p><w:r><w:t xml:space="preserve">Toute commande peut être annulée</w:t></w:r>` +
    `<w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">avant sa préparation.</w:t></w:r></w:p>`;
  assert.ok(documentXml.includes(plainParagraphXml(original)));
  documentXml = documentXml.replace(plainParagraphXml(original), withTab);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.hasNoMeaningfulChanges, false);
  const chapter = diff.chapters.find((c) => c.entries.some((e) => e.kind === "modified" && e.after.includes("\t")));
  assert.ok(chapter, "expected the tab to surface as part of a modified entry, never silently dropped");
});

test("W1-T-48 | a line break (w:br) inserted into a paragraph changes the diff, never silently dropped", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const original = "Toute commande peut être annulée avant sa préparation.";
  const withBr =
    `<w:p><w:r><w:t xml:space="preserve">Toute commande peut être annulée</w:t></w:r>` +
    `<w:r><w:br/></w:r><w:r><w:t xml:space="preserve">avant sa préparation.</w:t></w:r></w:p>`;
  documentXml = documentXml.replace(plainParagraphXml(original), withBr);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.hasNoMeaningfulChanges, false);
  const chapter = diff.chapters.find((c) => c.entries.some((e) => e.kind === "modified" && e.after.includes("\n")));
  assert.ok(chapter, "expected the line break to surface as part of a modified entry, never silently dropped");
});

test("W1-T-49 | a title/preamble edit (front matter) now changes the diff -- previously excluded entirely", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const originalTitle = model.frontMatter[0];
  assert.ok(originalTitle, "fixture must have a front-matter title");
  const edited = `${originalTitle} (modifié)`;
  assert.ok(documentXml.includes(`>${originalTitle}<`));
  documentXml = documentXml.replace(`>${originalTitle}<`, `>${edited}<`);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.hasNoMeaningfulChanges, false);
  assert.ok(
    diff.frontMatter.entries.some((e) => e.kind === "modified" && e.before === originalTitle && e.after === edited),
    "expected the title edit to surface in the diffed front matter"
  );
});

test("W1-T-50 | a sentence split across multiple <w:t> runs reconstructs to the exact same text (no silent loss)", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const original = "Toute commande peut être annulée avant sa préparation.";
  const split =
    `<w:p><w:r><w:t xml:space="preserve">Toute commande peut </w:t></w:r>` +
    `<w:r><w:t xml:space="preserve">être annulée avant sa préparation.</w:t></w:r></w:p>`;
  documentXml = documentXml.replace(plainParagraphXml(original), split);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  const chapter = diff.chapters.find((c) => c.heading === "Annulation de commande");
  assert.ok(chapter);
  assert.ok(chapter!.entries.every((e) => e.kind === "unchanged"), "run-split text must reconstruct to the exact same string");
});

test("W1-T-51 | bold/italic-formatted runs splitting a sentence reconstruct to the exact same text (no silent loss)", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const original = "Toute commande peut être annulée avant sa préparation.";
  const splitFormatted =
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Toute commande peut être annulée</w:t></w:r>` +
    `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> avant sa préparation.</w:t></w:r></w:p>`;
  documentXml = documentXml.replace(plainParagraphXml(original), splitFormatted);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  const chapter = diff.chapters.find((c) => c.heading === "Annulation de commande");
  assert.ok(chapter);
  assert.ok(chapter!.entries.every((e) => e.kind === "unchanged"), "bold/italic run split must not change the reconstructed text");
});

test("W1-T-52 | hyperlink-contained visible text is preserved and participates in the diff", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const original = "Toute commande peut être annulée avant sa préparation.";
  const withHyperlink =
    `<w:p><w:r><w:t xml:space="preserve">Toute commande peut être annulée avant sa préparation. Voir </w:t></w:r>` +
    `<w:hyperlink r:id="rIdX"><w:r><w:t xml:space="preserve">la politique complète</w:t></w:r></w:hyperlink></w:p>`;
  documentXml = documentXml.replace(plainParagraphXml(original), withHyperlink);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  assert.equal(diff.hasNoMeaningfulChanges, false);
  const chapter = diff.chapters.find((c) =>
    c.entries.some((e) => e.kind === "modified" && e.after.includes("la politique complète"))
  );
  assert.ok(chapter, "expected the hyperlink's visible text to surface in the diff");
});

test("W1-T-53 | a document containing unaccepted tracked changes is rejected whole (fail closed), never silently flattened", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const body =
    bookmarkedParagraphXml(0, name, model.chapters[0].heading) +
    `<w:p><w:ins w:id="1" w:author="Marchand"><w:r><w:t xml:space="preserve">Texte ajouté par suivi des modifications.</w:t></w:r></w:ins></w:p>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "UNSUPPORTED_TRACKED_CHANGES");
    return true;
  });
});

test("W1-T-54 | a document containing a table (w:tbl) is rejected whole (fail closed), never silently flattened", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const body =
    bookmarkedParagraphXml(0, name, model.chapters[0].heading) +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">Cellule</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "UNSUPPORTED_TABLE_STRUCTURE");
    return true;
  });
});

test("W1-T-55 | a list paragraph (w:numPr) is modeled with an explicit marker, never silently flattened away", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const body =
    bookmarkedParagraphXml(0, name, model.chapters[0].heading) +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Premier élément de liste.</w:t></w:r></w:p>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  const imported = readDocxDocument(docx);
  assert.deepEqual(imported.chapters[0].paragraphs, [model.chapters[0].heading, "• Premier élément de liste."]);
});

test("W1-T-56 | Word's in-body comment-range markers are harmless -- never crash, never trigger a spurious diff", () => {
  const model = baseModel();
  let documentXml = extractDocumentXml(exportModel(model));
  const original = "Toute commande peut être annulée avant sa préparation.";
  const withComment =
    `<w:p><w:commentRangeStart w:id="1"/><w:r><w:t xml:space="preserve">${original}</w:t></w:r>` +
    `<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>`;
  documentXml = documentXml.replace(plainParagraphXml(original), withComment);
  const imported = readDocxDocument(buildMinimalDocx(documentXml));
  const diff = diffCgvDocxImport(model, imported);
  const chapter = diff.chapters.find((c) => c.heading === "Annulation de commande");
  assert.ok(chapter);
  assert.ok(chapter!.entries.every((e) => e.kind === "unchanged"));
});

// ====================================================================
// W1-03 -- XML / BOOKMARK VALIDATION.
// ====================================================================

test("W1-T-57 | malformed XML (unclosed <w:r>) is rejected before any content is extracted", () => {
  const body = `<w:p><w:r><w:t xml:space="preserve">Texte</w:t></w:p>`; // missing </w:r>
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "MALFORMED_DOCUMENT");
    return true;
  });
});

test("W1-T-58 | malformed XML (unclosed <w:p>) is rejected before any content is extracted", () => {
  const body = `<w:p><w:r><w:t xml:space="preserve">Texte</w:t></w:r>`; // missing </w:p>
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "MALFORMED_DOCUMENT");
    return true;
  });
});

test("W1-T-59 | two identical cgv_* bookmarks inside the SAME paragraph are rejected (ambiguous), never 'first wins' -- the audit's exact reproduction case", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const body =
    `<w:p><w:bookmarkStart w:id="0" w:name="${name}"/><w:bookmarkStart w:id="1" w:name="${name}"/>` +
    `<w:r><w:t xml:space="preserve">${model.chapters[0].heading}</w:t></w:r>` +
    `<w:bookmarkEnd w:id="0"/><w:bookmarkEnd w:id="1"/></w:p>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "AMBIGUOUS_BOOKMARK_PARAGRAPH");
    return true;
  });
});

test("W1-T-60 | the same cgv_* bookmark name appearing in two DIFFERENT paragraphs is rejected (duplicate identity)", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const body = bookmarkedParagraphXml(0, name, "Un") + bookmarkedParagraphXml(1, name, "Deux");
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "DUPLICATE_BOOKMARK_IDENTITY");
    return true;
  });
});

test("W1-T-61 | a bookmark start with no matching end is rejected (unbalanced)", () => {
  const body = `<w:p><w:bookmarkStart w:id="0" w:name="cgv_identite-du-vendeur"/><w:r><w:t xml:space="preserve">Identité du vendeur</w:t></w:r></w:p>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "UNBALANCED_BOOKMARK");
    return true;
  });
});

test("W1-T-62 | a bookmark end with no matching start is rejected (unbalanced)", () => {
  const body = `<w:p><w:r><w:t xml:space="preserve">Identité du vendeur</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "UNBALANCED_BOOKMARK");
    return true;
  });
});

test("W1-T-63 | a cgv_* bookmark whose start and end land in DIFFERENT paragraphs is rejected (malformed/overlapping nesting)", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const body =
    `<w:p><w:bookmarkStart w:id="0" w:name="${name}"/><w:r><w:t xml:space="preserve">${model.chapters[0].heading}</w:t></w:r></w:p>` +
    `<w:p><w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve">Suite.</w:t></w:r></w:p>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "MALFORMED_BOOKMARK_NESTING");
    return true;
  });
});

test("W1-T-64 | a cgv_* bookmark with an empty identity ('cgv_' alone) is rejected (invalid identity)", () => {
  const body = `<w:p><w:bookmarkStart w:id="0" w:name="cgv_"/><w:r><w:t xml:space="preserve">Vide</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>`;
  const docx = buildMinimalDocx(wordDocumentXml(body));
  assert.throws(() => readDocxDocument(docx), (e: unknown) => {
    assert.ok(e instanceof DocxReadError);
    assert.equal((e as DocxReadError).code, "INVALID_BOOKMARK_IDENTITY");
    return true;
  });
});

test("W1-T-65 | Word's own housekeeping bookmarks remain harmless even when they span multiple paragraphs (crossing-paragraph rule is CGV-scoped only)", () => {
  const model = baseModel();
  const name = toOoxmlBookmarkName(model.chapters[0].bookmarkName);
  const body =
    `<w:p><w:bookmarkStart w:id="9" w:name="_GoBack"/><w:r><w:t xml:space="preserve">Début de sélection.</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">Fin de sélection.</w:t></w:r><w:bookmarkEnd w:id="9"/></w:p>` +
    bookmarkedParagraphXml(0, name, model.chapters[0].heading);
  const docx = buildMinimalDocx(wordDocumentXml(body));
  const imported = readDocxDocument(docx);
  assert.equal(imported.chapters.length, 1);
  assert.deepEqual(imported.leadingContent, ["Début de sélection.", "Fin de sélection."]);
});

