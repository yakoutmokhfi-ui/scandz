import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderCgv, type RenderCgvInput } from "../lib/legal/render.ts";
import {
  cgvChapterHeadingLine,
  parseCgvDocumentModel,
  slugifyCgvHeading,
  toOoxmlBookmarkName,
  type CgvDocumentModel,
} from "../lib/legal/cgv-document-model.ts";
import { buildCgvDocx } from "../lib/docx/docx-writer.ts";
import { readDocxDocument } from "../lib/docx/docx-reader.ts";
import { diffCgvDocxImport } from "../lib/legal/cgv-docx-diff.ts";
import { buildMinimalDocx } from "./helpers/docx-fixture-builder.ts";
import { unescapeXmlEntities } from "../lib/ooxml/zip-safe.ts";
import { unzipSync } from "fflate";

// ====================================================================
// CGV W1.1 — DOCX VISIBLE CHAPTER NUMBERING.
//
// W1 exported each chapter heading as its bare title ("Prix"), while
// the published CGV page shows "3. Prix". The Word copy of a
// merchant's own CGV was therefore an unnumbered list of chapters, in
// which nothing could be cited as "article 3".
//
// PRESENTATION ONLY. `renderCgv()` is untouched, no legal text
// changes, nothing is persisted, and — the invariant that matters most
// — chapter IDENTITY is untouched: a bookmark is still derived from
// the HEADING alone, never from the number, which legitimately shifts
// whenever a conditional section appears or disappears.
//
// Every test below starts from a REAL `renderCgv()` call, never a
// guessed HTML fixture, exactly like the W1 suite it extends.
// ====================================================================

/** Extracts one part's text from a .docx ArrayBuffer. */
function extractPart(docx: ArrayBuffer, path: string): string | null {
  const unzipped = unzipSync(new Uint8Array(docx), { filter: (f) => f.name === path });
  const bytes = unzipped[path];
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/** Every ZIP entry name in a .docx — used to prove no numbering part
 *  was smuggled in. */
function partNames(docx: ArrayBuffer): string[] {
  return Object.keys(unzipSync(new Uint8Array(docx))).sort();
}

/** The writer's own escaping — assertions on `word/document.xml` must
 *  compare against the ESCAPED form (a heading like « Objet et champ
 *  d'application » is stored as `d&apos;application`). */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function extractDocumentXml(docx: ArrayBuffer): string {
  const xml = extractPart(docx, "word/document.xml");
  assert.ok(xml, "word/document.xml missing from exported fixture");
  return xml!;
}

function exportModel(model: CgvDocumentModel): ArrayBuffer {
  const bytes = buildCgvDocx(model);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Same field shape as the W1 suite's own fixture (and as
 *  app/dashboard/legal-cgv/page.tsx's `buildPreviewResult()`). */
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

/** The numbers the PUBLISHED page shows, read straight out of
 *  `renderCgv()`'s HTML — the reference every test compares against,
 *  so nothing here can accidentally re-derive its own numbering. */
function publishedNumbering(html: string): { number: string; title: string }[] {
  const out: { number: string; title: string }[] = [];
  const re =
    /<h2 class="cgv-section-heading"><span class="cgv-chapter-number">([\s\S]*?)<\/span> <span class="cgv-chapter-title">([\s\S]*?)<\/span><\/h2>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ number: unescapeXmlEntities(m[1]), title: unescapeXmlEntities(m[2]) });
  }
  return out;
}

// --------------------------------------------------------------------
// 1. THE NUMBER IS VISIBLE, AND IT IS THE PUBLISHED ONE.
// --------------------------------------------------------------------

test("W11-T-01 | every exported chapter heading SHOWS its number, as visible run text", () => {
  const model = baseModel();
  const documentXml = extractDocumentXml(exportModel(model));

  const numbered = model.chapters.filter((c) => c.chapterNumber !== null);
  assert.ok(numbered.length >= 5, "fixture should produce several numbered chapters");

  for (const chapter of numbered) {
    const expected = `${chapter.chapterNumber} ${chapter.heading}`;
    assert.ok(
      documentXml.includes(`>${esc(expected)}</w:t>`),
      `heading paragraph for « ${chapter.heading} » must read « ${expected} »`
    );
    // And the bare title alone must no longer be the whole heading run
    // (that WAS the defect).
    assert.ok(
      !documentXml.includes(`>${esc(chapter.heading)}</w:t>`),
      `« ${chapter.heading} » must not appear as an unnumbered heading run`
    );
  }
});

test("W11-T-02 | the numbers are the PUBLISHED ones, read from renderCgv(), never recomputed", () => {
  const html = renderCgv(baseRenderInput());
  const model = parseCgvDocumentModel(html);
  const published = publishedNumbering(html);

  const numbered = model.chapters.filter((c) => c.chapterNumber !== null);
  assert.equal(numbered.length, published.length, "one model chapter per published numbered section");
  numbered.forEach((chapter, i) => {
    assert.equal(chapter.chapterNumber, published[i].number, `chapter ${i + 1} label`);
    assert.equal(chapter.heading, published[i].title, `chapter ${i + 1} title`);
  });

  // The sequence is the renderer's own: 1, 2, 3 … with no gap (an
  // absent conditional section consumes no number — render.ts §3).
  assert.deepEqual(
    numbered.map((c) => c.chapterNumber),
    numbered.map((_, i) => `${i + 1}.`)
  );
});

test("W11-T-03 | the exported heading LINE is composed by one shared function, used by writer AND diff", () => {
  const model = baseModel();
  const documentXml = extractDocumentXml(exportModel(model));
  for (const chapter of model.chapters) {
    assert.ok(documentXml.includes(`>${esc(cgvChapterHeadingLine(chapter))}</w:t>`));
  }
  // Structural: neither module composes the line itself (a second
  // composer would be free to drift from the first, and the round trip
  // compares the writer's output against the diff's expectation).
  const writer = readFileSync(new URL("../lib/docx/docx-writer.ts", import.meta.url), "utf8");
  const diff = readFileSync(new URL("../lib/legal/cgv-docx-diff.ts", import.meta.url), "utf8");
  for (const [name, source] of [
    ["docx-writer.ts", writer],
    ["cgv-docx-diff.ts", diff],
  ] as const) {
    assert.ok(source.includes("cgvChapterHeadingLine"), `${name} must use the shared composer`);
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
      .join("\n");
    // Neither file so much as NAMES the number field in executable
    // code: the only way either can produce a numbered heading is
    // through the shared composer.
    assert.ok(!code.includes("chapterNumber"), `${name} must not compose the numbered heading itself`);
  }
});

// --------------------------------------------------------------------
// 2. THE UNNUMBERED SECTION STAYS UNNUMBERED.
// --------------------------------------------------------------------

test("W11-T-04 | the D.211-2 encadré carries NO number — the export never invents one", () => {
  const html = renderCgv(
    baseRenderInput({
      template: {
        ...baseRenderInput().template,
        legal_guarantee_encadre: {
          heading: "Garanties légales (encadré D.211-2)",
          paragraphs: ["Texte réglementaire."],
        },
      },
    })
  );
  const model = parseCgvDocumentModel(html);
  const encadre = model.chapters.find((c) => c.bookmarkName === "legal-guarantee-encadre");
  assert.ok(encadre, "fixture must produce the regulatory encadré");
  assert.equal(encadre!.chapterNumber, null, "renderCgv() gives it no number; neither may the export");
  assert.equal(cgvChapterHeadingLine(encadre!), encadre!.heading);

  const documentXml = extractDocumentXml(exportModel(model));
  assert.ok(documentXml.includes(`>${esc(encadre!.heading)}</w:t>`), "the encadré heading is exported bare");
  assert.ok(
    !new RegExp(`>\\d+\\.\\s${esc(encadre!.heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</w:t>`).test(documentXml),
    "no number may be prefixed to the encadré"
  );
  // …and the numbered chapters around it are unaffected.
  assert.ok(model.chapters.some((c) => c.chapterNumber === "1."));
});

// --------------------------------------------------------------------
// 3. IDENTITY IS UNTOUCHED — the whole point of W1's design.
// --------------------------------------------------------------------

test("W11-T-05 | bookmark identity is still derived from the HEADING alone, never from the number", () => {
  const model = baseModel();
  for (const chapter of model.chapters) {
    if (chapter.bookmarkName === "legal-guarantee-encadre") continue;
    assert.equal(chapter.bookmarkName, slugifyCgvHeading(chapter.heading));
    // No digit of the number leaked into the identity.
    assert.ok(
      !/\d/.test(toOoxmlBookmarkName(chapter.bookmarkName)),
      `bookmark « ${chapter.bookmarkName} » must not carry the chapter number`
    );
  }
});

test("W11-T-06 | a numbering SHIFT (conditional section removed) changes no bookmark", () => {
  const withScope = parseCgvDocumentModel(renderCgv(baseRenderInput()));
  const templateWithoutScope = { ...baseRenderInput().template };
  delete (templateWithoutScope as Record<string, unknown>).purpose_scope_clause;
  const withoutScope = parseCgvDocumentModel(renderCgv(baseRenderInput({ template: templateWithoutScope })));

  // The early conditional section really did disappear…
  assert.ok(withScope.chapters.some((c) => c.bookmarkName === "objet-et-champ-d-application"));
  assert.ok(!withoutScope.chapters.some((c) => c.bookmarkName === "objet-et-champ-d-application"));

  // …so every later chapter's NUMBER shifted by one…
  const after = "annulation-de-commande";
  const before = withScope.chapters.find((c) => c.bookmarkName === after)!;
  const shifted = withoutScope.chapters.find((c) => c.bookmarkName === after)!;
  assert.notEqual(before.chapterNumber, shifted.chapterNumber, "the number must shift");
  assert.equal(before.chapterNumber, "7.");
  assert.equal(shifted.chapterNumber, "6.");

  // …while its IDENTITY, and the exported bookmark, are identical.
  assert.equal(before.bookmarkName, shifted.bookmarkName);
  assert.equal(toOoxmlBookmarkName(before.bookmarkName), toOoxmlBookmarkName(shifted.bookmarkName));

  // And the export shows the shifted number, i.e. the one actually
  // published at export time — never a cached or recomputed one.
  const documentXml = extractDocumentXml(exportModel(withoutScope));
  assert.ok(documentXml.includes(">6. Annulation de commande</w:t>"));
  assert.ok(!documentXml.includes(">7. Annulation de commande</w:t>"));
});

// --------------------------------------------------------------------
// 4. THE ROUND TRIP STILL WORKS — no phantom heading edits.
// --------------------------------------------------------------------

test("W11-T-07 | export -> import unchanged still yields ZERO meaningful diff (numbering included)", () => {
  const model = baseModel();
  const diff = diffCgvDocxImport(model, readDocxDocument(exportModel(model)));
  assert.equal(diff.hasNoMeaningfulChanges, true);
  assert.deepEqual(diff.removedChapters, []);
  assert.equal(diff.orderChanged, false);
  for (const chapter of diff.chapters) {
    assert.ok(
      chapter.entries.every((e) => e.kind === "unchanged"),
      `chapter ${chapter.bookmarkName}: a numbered heading must not read as an edit`
    );
    // The heading line really is the first compared line, numbering
    // included -- this is the assertion that would have caught the
    // phantom-edit regression a one-sided change would introduce.
    const first = chapter.entries[0];
    assert.equal(first.kind, "unchanged");
    const modelChapter = model.chapters.find((c) => c.bookmarkName === chapter.bookmarkName)!;
    assert.equal(
      first.kind === "unchanged" ? first.text : null,
      cgvChapterHeadingLine(modelChapter)
    );
  }
});

test("W11-T-08 | a merchant editing the NUMBER in Word is surfaced, never normalized away", () => {
  const model = baseModel();
  const target = model.chapters.find((c) => c.heading === "Annulation de commande")!;
  const original = cgvChapterHeadingLine(target);
  const edited = `VII. ${target.heading}`;

  let documentXml = extractDocumentXml(exportModel(model));
  assert.ok(documentXml.includes(`>${esc(original)}<`));
  documentXml = documentXml.replace(`>${esc(original)}<`, `>${esc(edited)}<`);

  const diff = diffCgvDocxImport(model, readDocxDocument(buildMinimalDocx(documentXml)));
  assert.equal(diff.hasNoMeaningfulChanges, false, "a numbering edit is a reviewable change");
  const chapter = diff.chapters.find((c) => c.bookmarkName === target.bookmarkName)!;
  assert.deepEqual(chapter.entries[0], { kind: "modified", before: original, after: edited });
  // Identity survived the edit: the chapter was still MATCHED, not
  // reported as removed + added.
  assert.deepEqual(diff.removedChapters, []);
});

test("W11-T-09 | a STALE export (numbering shifted since) still matches by bookmark, and says so", () => {
  // Merchant exports, then the restaurant's configuration changes so
  // that an earlier conditional section disappears and every later
  // number shifts. Re-importing the OLD file must still map every
  // chapter (identity is the bookmark), and must report the now-stale
  // heading lines as modified rather than hide them.
  const templateWithoutScope = { ...baseRenderInput().template };
  delete (templateWithoutScope as Record<string, unknown>).purpose_scope_clause;
  // Exported BEFORE the conditional section existed (9 chapters,
  // « Annulation » numbered 6.), re-imported against today's model
  // (10 chapters, « Annulation » numbered 7.).
  const exported = parseCgvDocumentModel(renderCgv(baseRenderInput({ template: templateWithoutScope })));
  const current = parseCgvDocumentModel(renderCgv(baseRenderInput()));

  const diff = diffCgvDocxImport(current, readDocxDocument(exportModel(exported)));

  // Mapping is intact: every bookmark of the old file is still
  // recognized (no fail-closed throw), nothing is reordered, and the
  // section the old file simply did not have is reported exactly once,
  // as a removed chapter -- never as a renumbering artefact.
  assert.equal(diff.orderChanged, false);
  assert.deepEqual(diff.removedChapters, [
    { bookmarkName: "objet-et-champ-d-application", heading: "Objet et champ d'application" },
  ]);

  // The stale numbering is surfaced as a heading edit the reviewer can
  // see -- truthfully: that file's numbering no longer matches the
  // published document.
  const shifted = diff.chapters.find((c) => c.bookmarkName === "annulation-de-commande")!;
  assert.deepEqual(shifted.entries[0], {
    kind: "modified",
    before: "7. Annulation de commande",
    after: "6. Annulation de commande",
  });
  assert.equal(diff.hasNoMeaningfulChanges, false);
});

// --------------------------------------------------------------------
// 5. NO WORD AUTO-NUMBERING ANYWHERE.
// --------------------------------------------------------------------

test("W11-T-10 | the numbering is literal text: no numbering part, no numPr, no field", () => {
  const model = baseModel();
  const docx = exportModel(model);

  // No numbering part, declared or present.
  assert.deepEqual(
    partNames(docx),
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/styles.xml",
    ],
    "the package must gain no new part (notably no word/numbering.xml)"
  );
  assert.ok(!extractPart(docx, "[Content_Types].xml")!.includes("numbering"));

  // No auto-numbering, no field, no bookmark-driven counter in the
  // body or the styles: a Word counter could renumber the document
  // away from what Scanym published.
  for (const path of ["word/document.xml", "word/styles.xml"]) {
    const xml = extractPart(docx, path)!;
    for (const forbidden of ["w:numPr", "w:numId", "w:fldSimple", "w:instrText", "fldChar", "SEQ ", "LISTNUM", "w:numbering"]) {
      assert.ok(!xml.includes(forbidden), `${path} must not contain ${forbidden}`);
    }
  }

  // The heading paragraphs are still Heading1-styled (Word outline /
  // navigation pane keeps working exactly as in W1).
  const documentXml = extractDocumentXml(docx);
  const headingCount = [...documentXml.matchAll(/<w:pStyle w:val="Heading1"\/>/g)].length;
  assert.equal(headingCount, model.chapters.length);
});

// --------------------------------------------------------------------
// 6. PRESENTATION ONLY — nothing else moved.
// --------------------------------------------------------------------

test("W11-T-11 | renderCgv() is untouched by this lot: no legal content, no publish path", () => {
  // The renderer is read, never written: this lot's three touched
  // modules must not import it, and must still reference no publish or
  // persistence path (W1's own W1-T-20/21 invariants, re-asserted here
  // because this lot edited two of those very files).
  for (const file of [
    "../lib/legal/cgv-document-model.ts",
    "../lib/docx/docx-writer.ts",
    "../lib/legal/cgv-docx-diff.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
      .join("\n");
    assert.ok(!code.includes("from \"@/lib/legal/render\""), `${file} must not import the renderer`);
    for (const term of ["publishMerchantCgvVersion", "persist_merchant_cgv_version", "supabase", "restaurant_id"]) {
      assert.ok(!code.toLowerCase().includes(term.toLowerCase()), `${file} must not reference ${term}`);
    }
  }
});

test("W11-T-12 | front matter is NOT numbered, and body paragraphs are untouched", () => {
  const model = baseModel();
  const documentXml = extractDocumentXml(exportModel(model));

  // Title / seller / preamble: exported exactly as before, no label.
  for (const line of model.frontMatter) {
    assert.ok(documentXml.includes(`>${esc(line)}</w:t>`), `front-matter line must be exported verbatim: ${line}`);
  }
  // Body paragraphs: still verbatim, never prefixed with anything.
  for (const chapter of model.chapters) {
    for (const paragraph of chapter.paragraphs.filter((p) => p.trim().length > 0)) {
      assert.ok(
        documentXml.includes(`>${esc(paragraph)}</w:t>`),
        `body paragraph must be exported verbatim: ${paragraph.slice(0, 40)}…`
      );
    }
  }
});

test("W11-T-13 | the number label is XML-escaped like any other text", () => {
  // Defence in depth: `chapterNumber` comes from Scanym's own
  // renderer, so it is never hostile — but it is still text that ends
  // up in XML, and it must go through the writer's escaping like
  // everything else rather than being concatenated raw.
  const model = baseModel();
  const crafted: CgvDocumentModel = {
    frontMatter: model.frontMatter,
    chapters: [{ ...model.chapters[0], chapterNumber: 'A & B <"\'>' }],
  };
  const documentXml = extractDocumentXml(exportModel(crafted));
  assert.ok(documentXml.includes("A &amp; B &lt;&quot;&apos;&gt;"), "the label must be escaped");
  assert.ok(!documentXml.includes('A & B <"'), "no raw markup may reach the document");

  // …and it round-trips back to the exact same text.
  const imported = readDocxDocument(exportModel(crafted));
  assert.equal(imported.chapters[0].paragraphs[0], `A & B <"'> ${model.chapters[0].heading}`);
});
