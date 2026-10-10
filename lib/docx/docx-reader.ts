/**
 * CGV W1 — DOCX EXPORT / IMPORT ROUND-TRIP — DOCX *reader* (import).
 *
 * PURE, read-only, no network/Storage/DOM access — testable in
 * `node --test` without jsdom, exactly like
 * lib/catalogue-import/xlsx-reader.ts. This module treats EVERY byte
 * of its input as UNTRUSTED (mandate §3/§8): a merchant-returned
 * .docx has been opened, edited and re-saved by an arbitrary version
 * of Word (or any other OOXML-producing tool) outside Scanym's
 * control.
 *
 * SECURITY ARCHITECTURE — reuses lib/ooxml/zip-safe.ts's "W0" bounded
 * ZIP primitives EXACTLY as xlsx-reader.ts does (same three-pass
 * discipline: manifest-only pass with zero decompression, then a
 * bounded, duplicate-checked extraction of a small, fixed whitelist
 * of part names). See that file's header comment for the full
 * rationale; only the DOCX-specific decisions are documented here.
 *
 *   - PATH TRAVERSAL / UNEXPECTED FILES (mandate §8): never
 *     sanitized, never checked against "../" patterns — prevented BY
 *     CONSTRUCTION instead, the same way xlsx-reader.ts prevents
 *     macro execution: `extractOnly` only ever decompresses an entry
 *     whose name EXACTLY matches one of the two names in
 *     `RELEVANT_PART_NAMES` below. An entry named
 *     "../../../etc/passwd" or "word/vbaProject.bin" is simply never
 *     selected by the extraction filter, whatever its declared size
 *     or position in the archive — there is no code path in this
 *     module capable of opening it.
 *   - MACROS / EMBEDDED OBJECTS / EXTERNAL RELATIONSHIPS (mandate
 *     §3/§8): same reasoning — `xl/vbaProject.bin`-equivalent parts
 *     (`word/vbaProject.bin`), OLE objects (`word/embeddings/*`), and
 *     `word/_rels/document.xml.rels` (which is where an external
 *     relationship — a remote template, a remote image — would be
 *     declared) are never in the whitelist, so never read, so never
 *     actioned. This module does not need to detect or reject
 *     `TargetMode="External"` relationships; it never looks at the
 *     relationships part at all.
 *   - DECOMPRESSION ABUSE (mandate §8): identical three-pass bounded
 *     discipline as xlsx-reader.ts — see MAX_* constants imported
 *     from zip-safe.ts. `[Content_Types].xml` is treated as
 *     "metadata" (bounded by MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES),
 *     `word/document.xml` as "content" (bounded by
 *     MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES and the cumulative
 *     MAX_TOTAL_UNCOMPRESSED_BYTES ceiling) — both individually
 *     size-checked against the ZIP central directory's DECLARED
 *     uncompressed size before either is ever decompressed.
 *   - DUPLICATE ZIP ENTRIES (OB-3 v1.3 precedent, Cat Stevens audit):
 *     both whitelisted part names are checked via
 *     `assertNoDuplicateRelevantEntry` before any extraction — an
 *     archive declaring either name twice is rejected whole, never
 *     "first/last wins".
 *   - XML PARSER HAZARDS (mandate §8): never a generic XML/DOM engine
 *     (`DOMParser`, any XML library) — targeted regex extraction only,
 *     same discipline as xlsx-reader.ts and cgv-document-model.ts.
 *     There is no code path here capable of resolving an XML external
 *     entity, a DTD, or a processing instruction, because there is no
 *     XML parser at all. (W1 REMEDIATION, W1-03 — see
 *     `assertWellFormedXml` below: a hand-rolled TAG-BALANCE
 *     well-formedness check was added so malformed XML is rejected
 *     BEFORE any content extraction, but it is still not a generic
 *     XML engine: it never resolves entities, DTDs or PIs, it only
 *     verifies that every opened element tag is eventually closed.)
 *   - WRONG / FOREIGN CONTAINER FORMAT (mandate §3, "accept only the
 *     intended DOCX format"): `[Content_Types].xml` is checked for an
 *     explicit `<Override PartName="/word/document.xml"
 *     ContentType="...wordprocessingml.document.main+xml"/>` entry —
 *     a renamed .xlsx/.pptx, a "Strict OOXML" document (different
 *     content-type string, not supported by this v1), or any other
 *     OOXML package is rejected with `WRONG_CONTENT_TYPE` before its
 *     `word/document.xml` (which may not even exist, or may mean
 *     something entirely different) is ever interpreted as CGV
 *     content.
 *
 * STABLE IDENTITY / FAIL CLOSED (mandate §2/§5): a paragraph is
 * recognized as a chapter boundary ONLY when it carries a native
 * `w:bookmarkStart` whose name starts with the `cgv_` prefix that
 * `lib/legal/cgv-document-model.ts`'s `toOoxmlBookmarkName` always
 * produces. Word itself silently inserts its OWN housekeeping
 * bookmarks on save (most commonly `_GoBack`, marking the last edit
 * position) — these are deliberately ignored rather than trusted as
 * identity, specifically so a stray editor-inserted bookmark can
 * never be mistaken for a CGV chapter boundary. If NO `cgv_`-prefixed
 * bookmark is found anywhere in the whole document, the import is
 * structurally unmappable and is rejected whole with
 * `NO_RECOGNIZED_BOOKMARK` — this module never guesses a mapping from
 * paragraph position alone. Whether each INDIVIDUAL found bookmark
 * name corresponds to a CURRENT CGV chapter is a separate, model-
 * dependent question this module does not answer — that is
 * `lib/legal/cgv-docx-diff.ts`'s responsibility, which alone knows
 * the current model's chapter set.
 *
 * ====================================================================
 * W1 TARGETED REMEDIATION (BOULEZ audit, candidate c5924a5, FAIL) —
 * W1-02 / W1-03 — this header section documents the fixes added on
 * top of the W1 foundation; everything above is unchanged from that
 * foundation.
 * ====================================================================
 *
 * W1-03 — XML / BOOKMARK VALIDATION, FAIL CLOSED BEFORE MODEL
 * CONSTRUCTION. The audit found two concrete acceptance bugs: (a)
 * malformed XML (an unclosed `<w:r>`/`<w:p>`) was silently tolerated
 * because the OLD per-paragraph regex only ever looked for the
 * SUBSTRINGS it cared about, never verifying the surrounding markup
 * was even well-formed; (b) two identical `cgv_*` bookmarks inside the
 * SAME paragraph were silently accepted (the old `extractCgvBookmarkName`
 * took "the first one, per paragraph" — exactly the "first/last wins"
 * shortcut this codebase's own doctrine (see DUPLICATE_ZIP_ENTRY above)
 * otherwise always forbids). Fixed by a strict two-stage pipeline,
 * entirely BEFORE any `DocxImportResult` is ever constructed:
 *
 *   STAGE 1 — `assertWellFormedXml(documentXml)`. A hand-rolled
 *   TAG-BALANCE validator (never a generic XML engine, see above): it
 *   strips comments/processing instructions, tokenizes every
 *   `<tag>`/`</tag>`/`<tag/>` via regex, and replays them against an
 *   explicit stack — every opening tag must be closed, by the same
 *   name, before the document ends, and every closing tag must match
 *   the stack's top. A stray `<w:r>` with no `</w:r>`, or a `</w:p>`
 *   that closes the wrong element, raises `MALFORMED_DOCUMENT` here,
 *   before a single paragraph is ever extracted. This also fixes the
 *   "parse/validate XML structurally… do not rely on permissive
 *   regex/string scanning for correctness" requirement for the
 *   well-formedness question specifically (content EXTRACTION
 *   downstream is still targeted regex, deliberately, per the file
 *   header above — but it now only ever runs over XML already proven
 *   well-formed).
 *
 *   STAGE 2 — `validateAndCollectCgvBookmarks(bodyXml, paragraphs)`. A
 *   GLOBAL pass (never per-paragraph in isolation) that:
 *     1. collects every `w:bookmarkStart`/`w:bookmarkEnd` in the
 *        document, each tagged with the index of the paragraph it was
 *        found inside (paragraphs are now split by a corrected
 *        tokenizer, `PARAGRAPH_TOKEN_RE`, that treats a self-closed
 *        `<w:p/>` as its own, separately-indexed, empty paragraph —
 *        see that constant's own comment for why the OLD regex's
 *        self-close handling was replaced rather than reused);
 *     2. pairs every bookmark id GLOBALLY (never assuming a start and
 *        its end share a paragraph) and rejects a start with no end,
 *        an end with no start, or an id reused by more than one start
 *        or end (`UNBALANCED_BOOKMARK` / `MALFORMED_BOOKMARK_NESTING`);
 *     3. for every resulting `cgv_`-prefixed bookmark whose start/end
 *        land in DIFFERENT paragraphs, rejects it
 *        (`MALFORMED_BOOKMARK_NESTING` — a CGV chapter boundary must
 *        stay inside one paragraph, exactly as the writer always
 *        produces it); non-`cgv_` bookmarks (Word's own `_GoBack`,
 *        etc.) are NEVER held to this rule — see file header, "STABLE
 *        IDENTITY", they stay harmless whatever shape they take;
 *     4. validates each surviving `cgv_` bookmark's NAME syntax
 *        (`INVALID_BOOKMARK_IDENTITY` for an empty/malformed slug such
 *        as a bare `cgv_`);
 *     5. rejects more than one `cgv_` bookmark landing in the SAME
 *        paragraph (`AMBIGUOUS_BOOKMARK_PARAGRAPH` — this is the exact
 *        shape of the audit's reproduction case, "two identical cgv_*
 *        bookmarks inside one paragraph", and also catches two
 *        DIFFERENT `cgv_` bookmarks sharing a paragraph, equally
 *        ambiguous);
 *     6. rejects the same `cgv_` bookmark NAME appearing in more than
 *        one paragraph (`DUPLICATE_BOOKMARK_IDENTITY`).
 *
 *   Only once stages 1–2 succeed is a `paragraphIndex -> raw bookmark
 *   name` map handed to `extractRawParagraphs`/`groupIntoChapters` —
 *   the document model is built STRICTLY AFTER validation, never
 *   before or alongside it (mandate §3's "only construct the document
 *   model after bookmark validation succeeds").
 *
 * W1-02 — CONTENT FIDELITY / NO SILENT LOSS. The audit found the old
 * `extractParagraphText` only ever collected `<w:t>` run text, so
 * `w:tab`/`w:br` vanished with no trace and no error. Fixed:
 *   - `w:tab` -> `"\t"`, `w:br` -> `"\n"`, both MODELED deterministically
 *     (never dropped) directly inside `extractParagraphText`, in
 *     document order alongside `<w:t>` runs (so "A<tab>B" and "A B"
 *     are never conflated — the diff below sees a real difference).
 *   - multi-run text, bold/italic-split runs, and hyperlink-contained
 *     visible text were ALREADY correctly preserved by the pre-
 *     existing flat `<w:t>` concatenation (a hyperlink's visible text
 *     still lives in ordinary `<w:r><w:t>` runs, just wrapped one level
 *     deeper in `<w:hyperlink>`, which this module never needed to
 *     parse specially) — unchanged, now simply covered by new tests.
 *   - LISTS: a paragraph carrying `<w:numPr>` (Word's list-membership
 *     marker, inside `<w:pPr>`) is modeled deterministically with a
 *     fixed `"• "` prefix (`isListParagraph`) — never silently
 *     flattened into an indistinguishable plain paragraph.
 *   - TABLES / TRACKED CHANGES: neither is safely representable as a
 *     flat paragraph list without a much larger, out-of-scope model
 *     change (table cell structure; insertion/deletion authorship and
 *     provenance) — per the mandate's "A. model it, or B. reject it,
 *     never ignore it" principle, this v1 takes **B**: a document
 *     containing `<w:tbl>` (a table) or `<w:ins>`/`<w:del>`/`<w:delText>`
 *     (an UNACCEPTED tracked change — Word keeps these in the XML
 *     until a reviewer accepts/rejects them) is rejected WHOLE, before
 *     any paragraph is extracted, with its own stable code
 *     (`UNSUPPORTED_TABLE_STRUCTURE` / `UNSUPPORTED_TRACKED_CHANGES`).
 *   - COMMENTS: Word's in-body comment-range markers
 *     (`w:commentRangeStart`/`w:commentRangeEnd`/`w:commentReference`)
 *     carry no visible text of their own — the comment TEXT itself
 *     lives in a separate part (`word/comments.xml`) this module never
 *     extracts (not in `RELEVANT_PART_NAMES`, unchanged by this
 *     remediation). A document containing comment markers therefore
 *     loses nothing from the reviewable paragraph text (there was
 *     nothing legally meaningful there to begin with) and is
 *     deliberately left unrejected — an explicit decision, not an
 *     oversight, per the mandate's "explicitly decide treatment of…
 *     comments" instruction.
 *   - PREAMBLE/TITLE: `imported.leadingContent` (unchanged shape) is
 *     now actually DIFFED by `lib/legal/cgv-docx-diff.ts` against
 *     `currentModel.frontMatter` (see that file) — this reader's job
 *     stops at faithfully collecting it, which it already did.
 */

import {
  MAX_IMPORT_FILE_SIZE_BYTES,
  MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES,
  MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES,
  checkZipSignature,
  decodeUtf8,
  unescapeXmlEntities,
  buildZipManifest as buildManifest,
  assertNoDuplicateRelevantEntry as assertNoDuplicate,
  assertEntryDecompressionSafe as assertSafe,
  extractOnly as extractEntries,
  type OoxmlZipErrorFactory,
} from "@/lib/ooxml/zip-safe";

export type DocxReadErrorCode =
  | "FILE_TOO_LARGE"
  | "NOT_A_ZIP_CONTAINER"
  | "MALFORMED_DOCUMENT"
  | "WRONG_CONTENT_TYPE"
  | "NO_RECOGNIZED_BOOKMARK"
  | "ENTRY_TOO_LARGE"
  | "DUPLICATE_ZIP_ENTRY"
  // W1 REMEDIATION (W1-03) -- global bookmark validation failures.
  | "AMBIGUOUS_BOOKMARK_PARAGRAPH"
  | "DUPLICATE_BOOKMARK_IDENTITY"
  | "UNBALANCED_BOOKMARK"
  | "INVALID_BOOKMARK_IDENTITY"
  | "MALFORMED_BOOKMARK_NESTING"
  // W1 REMEDIATION (W1-02) -- fail-closed unsupported OOXML constructs.
  | "UNSUPPORTED_TABLE_STRUCTURE"
  | "UNSUPPORTED_TRACKED_CHANGES";

export class DocxReadError extends Error {
  readonly code: DocxReadErrorCode;
  constructor(code: DocxReadErrorCode, message: string) {
    super(message);
    this.name = "DocxReadError";
    this.code = code;
  }
}

/** Preserve the public error class and this module's own vocabulary —
 *  identical currying pattern as xlsx-reader.ts. */
const makeZipError: OoxmlZipErrorFactory = (code, message) =>
  new DocxReadError(code === "MALFORMED_CONTAINER" ? "MALFORMED_DOCUMENT" : code, message);
const buildZipManifest = buildManifest.bind(null, makeZipError);
const assertNoDuplicateRelevantEntry = assertNoDuplicate.bind(null, makeZipError);
const assertEntryDecompressionSafe = assertSafe.bind(null, makeZipError);
const extractOnly = extractEntries.bind(null, makeZipError);

const CONTENT_TYPES_PART = "[Content_Types].xml";
const DOCUMENT_PART = "word/document.xml";
const WORDPROCESSING_MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/** The ONLY two ZIP entries this module ever decompresses, whatever
 *  else the archive declares (see file header, "PATH TRAVERSAL /
 *  UNEXPECTED FILES"). */
const RELEVANT_PART_NAMES = [CONTENT_TYPES_PART, DOCUMENT_PART] as const;

/** One paragraph of the imported document body, in document order,
 *  after validated bookmark assignment and multi-run `<w:t>`/`<w:tab>`/
 *  `<w:br>` concatenation — but BEFORE empty-paragraph normalization
 *  and chapter grouping (that happens in `readDocxDocument`). */
interface RawDocxParagraph {
  bookmarkName: string | null;
  text: string;
}

export interface DocxImportedChapter {
  /** Raw OOXML bookmark name exactly as found in the import (e.g.
   *  "cgv_duree_du_contrat") — never decoded back to an internal
   *  slug. The diff engine compares this, byte for byte, against
   *  `toOoxmlBookmarkName(x)` for each `x` in the CURRENT model; an
   *  import-side name with no match in the current model is that
   *  engine's concern, not this reader's. */
  bookmarkName: string;
  /** Non-blank paragraphs belonging to this chapter, in document
   *  order, blank/whitespace-only paragraphs already dropped (see
   *  "BLANK PARAGRAPH NORMALIZATION" below). */
  paragraphs: string[];
}

export interface DocxImportResult {
  /** Non-blank paragraphs found before the first recognized
   *  `cgv_`-prefixed bookmark. Surfaced for review (and, as of the W1
   *  remediation, diffed against `currentModel.frontMatter` by
   *  lib/legal/cgv-docx-diff.ts), never silently discarded. */
  leadingContent: string[];
  chapters: DocxImportedChapter[];
}

/**
 * Robust XML attribute lookup within one tag's attribute text,
 * independent of attribute order — same reasoning and implementation
 * as xlsx-reader.ts's own `extractXmlAttribute` (duplicated here
 * deliberately rather than shared, so each untrusted-input reader
 * stays independently auditable with no shared mutable state and no
 * cross-module coupling beyond the zip-safe.ts primitives both
 * already depend on).
 */
function extractXmlAttribute(attributeText: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
  const match = re.exec(attributeText);
  return match ? match[1] : null;
}

/**
 * `[Content_Types].xml` declares, among other things, which content
 * type governs `/word/document.xml`. A renamed .xlsx/.pptx, a
 * "Strict OOXML" document, or any other OOXML-family package will
 * either lack this override entirely or declare a different content
 * type string — both rejected here, before `word/document.xml` is
 * ever opened, let alone interpreted as CGV content (mandate §3).
 */
function assertWordprocessingMainDocument(contentTypesXml: string): void {
  const overrideRe = /<Override\b([^>]*)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = overrideRe.exec(contentTypesXml)) !== null) {
    const attributeText = match[1];
    const partName = extractXmlAttribute(attributeText, "PartName");
    if (partName !== "/word/document.xml") continue;
    const contentType = extractXmlAttribute(attributeText, "ContentType");
    if (contentType === WORDPROCESSING_MAIN_DOCUMENT_CONTENT_TYPE) return;
    throw new DocxReadError(
      "WRONG_CONTENT_TYPE",
      `Le fichier déclare /word/document.xml avec un type de contenu inattendu (« ${contentType ?? "absent"} ») -- ce n'est pas un document Word (.docx) transitionnel pris en charge.`
    );
  }
  throw new DocxReadError(
    "WRONG_CONTENT_TYPE",
    "Aucune déclaration de type de contenu pour /word/document.xml -- ce n'est pas un conteneur .docx reconnu."
  );
}

// ====================================================================
// W1 REMEDIATION (W1-03) -- XML well-formedness (STAGE 1).
// ====================================================================

/**
 * Hand-rolled TAG-BALANCE well-formedness check -- NEVER a generic
 * XML/DOM engine (file header, "XML PARSER HAZARDS"): it never
 * resolves an entity, a DTD, or a processing instruction, it only
 * tokenizes `<tag>`/`</tag>`/`<tag/>` boundaries via regex and replays
 * them against an explicit stack. This is the "parse/validate XML
 * structurally… do not rely on permissive regex/string scanning for
 * correctness" fix for malformed-XML acceptance (BOULEZ audit,
 * W1-03): an unclosed `<w:r>` or `<w:p>` -- previously invisible to
 * the OLD code, which only ever looked for the handful of substrings
 * it cared about -- now fails this check BEFORE any content is ever
 * extracted from the document.
 *
 * Comments (`<!--…-->`) and processing instructions (`<?…?>`,
 * including the leading `<?xml …?>` declaration) are stripped first
 * and never pushed onto the stack -- same as any conformant XML
 * processor would skip them for well-formedness purposes.
 *
 * A final sanity check compares the number of `<` characters in the
 * stripped text against the number of tag tokens actually matched:
 * if they differ, some `<` in the document never formed a recognized
 * tag at all (e.g. a stray, unescaped `<` in what was meant to be
 * text content) -- itself a well-formedness violation under plain
 * XML rules, rejected here rather than silently ignored.
 */
function assertWellFormedXml(xml: string): void {
  const stripped = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<(\/)?([A-Za-z_][\w.:-]*)\b[^<>]*?(\/)?>/g;
  const stack: string[] = [];
  let matchCount = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(stripped)) !== null) {
    matchCount += 1;
    const [, closing, name, selfClosing] = match;
    if (closing) {
      const top = stack.pop();
      if (top !== name) {
        throw new DocxReadError(
          "MALFORMED_DOCUMENT",
          `Balise fermante inattendue « </${name}> » -- XML mal formé (document rejeté, aucune tentative de récupération).`
        );
      }
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  const totalLt = (stripped.match(/</g) ?? []).length;
  if (totalLt !== matchCount) {
    throw new DocxReadError(
      "MALFORMED_DOCUMENT",
      "Caractère « < » isolé ou balise non reconnue -- XML mal formé (document rejeté, aucune tentative de récupération)."
    );
  }
  if (stack.length > 0) {
    throw new DocxReadError(
      "MALFORMED_DOCUMENT",
      `Balise(s) jamais fermée(s) (${stack.join(", ")}) -- XML mal formé (document rejeté, aucune tentative de récupération).`
    );
  }
}

// ====================================================================
// W1 REMEDIATION (W1-02) -- fail-closed unsupported constructs.
// ====================================================================

/**
 * Tables (`<w:tbl>`) and UNACCEPTED tracked changes (`<w:ins>`,
 * `<w:del>`, `<w:delText>` -- Word keeps these in the XML until a
 * reviewer explicitly accepts or rejects each change) are not safely
 * representable by this v1's flat paragraph-list model without a
 * materially larger change this targeted remediation does not make.
 * Per the mandate's "A. model it, or B. reject it -- never ignore it"
 * principle, this is explicit choice **B**: the WHOLE document is
 * rejected, before a single paragraph is extracted, rather than
 * silently dropping a table row or an unaccepted edit and reporting a
 * clean diff that omits them.
 */
function assertNoUnsupportedStructure(bodyXml: string): void {
  if (/<w:tbl\b/.test(bodyXml)) {
    throw new DocxReadError(
      "UNSUPPORTED_TABLE_STRUCTURE",
      "Le document importé contient un tableau Word (w:tbl) -- structure non prise en charge par cette version (échec fermé, jamais une perte silencieuse)."
    );
  }
  if (/<w:ins\b|<w:del\b|<w:delText\b/.test(bodyXml)) {
    throw new DocxReadError(
      "UNSUPPORTED_TRACKED_CHANGES",
      "Le document importé contient des modifications suivies non acceptées (suivi des modifications Word) -- non pris en charge par cette version (échec fermé, jamais une perte silencieuse)."
    );
  }
}

/**
 * Concatenates ALL `<w:t>…</w:t>` run text, `<w:tab/>`, and
 * `<w:br/>` found within one paragraph's raw XML, IN DOCUMENT ORDER.
 * Essential for a real-world round trip: Word routinely splits a
 * single sentence across several runs (spell-check markers, tracked
 * formatting, language tags) even when the merchant's own edit
 * touched none of that -- reading only the first `<w:t>` would
 * silently truncate the paragraph. A hyperlink's visible text lives
 * in ordinary `<w:r><w:t>` runs one level deeper inside
 * `<w:hyperlink>…</w:hyperlink>` -- this flat scan finds it exactly
 * the same way, with no special-casing needed.
 *
 * W1 REMEDIATION (W1-02): `w:tab` and `w:br` -- previously invisible
 * to this function entirely -- are now modeled deterministically as
 * `"\t"` / `"\n"` respectively, interleaved in document order with
 * the surrounding run text, so a tab or line break inserted by a
 * merchant's edit changes the extracted text (and therefore the
 * diff) instead of silently disappearing. The three alternatives are
 * mutually exclusive by construction: `<w:t\b` requires a WORD
 * BOUNDARY immediately after "t", so it can never match the start of
 * `<w:tab` (where "t" is immediately followed by the word character
 * "a" -- no boundary there); `<w:tab` and `<w:br` are themselves
 * never confusable prefixes of one another.
 */
function extractParagraphText(paragraphXml: string): string {
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  let text = "";
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(paragraphXml)) !== null) {
    if (match[1] !== undefined) {
      text += unescapeXmlEntities(match[1]);
    } else if (match[0].startsWith("<w:tab")) {
      text += "\t";
    } else {
      text += "\n";
    }
  }
  return text;
}

/**
 * W1 REMEDIATION (W1-02) -- a paragraph carrying Word's list-
 * membership marker (`<w:numPr>`, always nested inside `<w:pPr>`) is
 * modeled with a fixed, deterministic `"• "` prefix rather than being
 * silently flattened into an indistinguishable plain paragraph. This
 * is a presentation-level marker only (never "model the whole list
 * structure" -- numbering level, list type, and restart semantics are
 * out of this v1's scope and were never part of the mandate's minimum
 * list), but it satisfies "unsupported list structure never
 * disappears silently": the paragraph's own text is still fully
 * preserved, now with an explicit, reviewable marker showing it was a
 * list item.
 */
function isListParagraph(paragraphXml: string): boolean {
  return /<w:numPr\b/.test(paragraphXml);
}

// ====================================================================
// W1 REMEDIATION (W1-03) -- global bookmark validation (STAGE 2).
// ====================================================================

/** Splits `bodyXml` into one entry per paragraph, IN DOCUMENT ORDER,
 *  correctly distinguishing a self-closed `<w:p/>` (a genuinely empty
 *  paragraph -- entry `""`) from an ordinary `<w:p>…</w:p>` pair.
 *
 *  Replaces the OLD `pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g`: that
 *  pattern's `[^>]*` happily consumed a self-closing tag's trailing
 *  "/" as if it were just another attribute character, so
 *  `<w:p\b[^>]*>` alone already matched the WHOLE of `<w:p/>` --
 *  leaving the following `([\s\S]*?)<\/w:p>` to scan forward and
 *  swallow everything up to the NEXT real paragraph's own closing tag
 *  as if it belonged to the empty one. Each individual regex used by
 *  `extractParagraphText`/bookmark-scanning still happened to find the
 *  right substrings inside that merged blob (by accident -- they
 *  search anywhere in the string, not structurally), which is why
 *  this went unnoticed; but it collapses two paragraphs' worth of
 *  content into one `RawDocxParagraph` record, which the new
 *  paragraph-indexed global bookmark validation (this remediation)
 *  cannot tolerate -- it needs one array entry per REAL paragraph, in
 *  order, with no merging. The fix tries the explicit self-closing
 *  form FIRST (`<w:p\b[^>]*\/>`, requiring the tag to end in "/>"),
 *  which an ordinary open tag's attributes essentially never do, so
 *  the two alternatives never cross-match in practice. */
const PARAGRAPH_TOKEN_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;

function splitBodyIntoParagraphs(bodyXml: string): string[] {
  const paragraphs: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(PARAGRAPH_TOKEN_RE.source, "g");
  while ((match = re.exec(bodyXml)) !== null) {
    paragraphs.push(match[1] ?? "");
  }
  return paragraphs;
}

interface BookmarkIdRecord {
  name: string | null;
  starts: number[]; // paragraph indices where a start with this id was found
  ends: number[]; // paragraph indices where an end with this id was found
}

/**
 * GLOBAL bookmark validation (mandate §W1-03: "Validate ALL CGV
 * bookmarks globally before review construction"). Returns a
 * `paragraphIndex -> raw cgv_ bookmark name` map once every check
 * below has passed; throws the first applicable `DocxReadError`
 * otherwise. Never partially applied -- either the whole map is
 * returned, or nothing is (fail closed, mandate §3).
 */
function validateAndCollectCgvBookmarks(paragraphs: string[]): Map<number, string> {
  const byId = new Map<string, BookmarkIdRecord>();
  const bookmarkRe = /<w:bookmarkStart\b([^>]*)\/>|<w:bookmarkEnd\b([^>]*)\/>/g;

  paragraphs.forEach((paragraphXml, index) => {
    let match: RegExpExecArray | null;
    const re = new RegExp(bookmarkRe.source, "g");
    while ((match = re.exec(paragraphXml)) !== null) {
      const isStart = match[1] !== undefined;
      const attrs = isStart ? match[1] : (match[2] as string);
      const id = extractXmlAttribute(attrs, "w:id");
      if (id === null) continue; // defensive -- Word always emits w:id; never a crash on a future shape change.
      let record = byId.get(id);
      if (!record) {
        record = { name: null, starts: [], ends: [] };
        byId.set(id, record);
      }
      if (isStart) {
        record.starts.push(index);
        // Word never reuses an id with two different names; the first
        // name seen for an id is kept (defensive, not itself a
        // validity check -- a duplicate-id violation is caught below
        // regardless of what name(s) were attached to it).
        if (record.name === null) record.name = extractXmlAttribute(attrs, "w:name");
      } else {
        record.ends.push(index);
      }
    }
  });

  // -- General OOXML balance, for EVERY bookmark id, cgv_ or not
  //    (mandate: "missing bookmark end if required", "bookmark start
  //    without end", "bookmark end without start", "malformed
  //    bookmark nesting" are listed without being scoped to CGV
  //    identities specifically) --
  for (const [id, record] of byId) {
    if (record.starts.length === 0 && record.ends.length > 0) {
      throw new DocxReadError(
        "UNBALANCED_BOOKMARK",
        `Le repère d'identifiant « ${id} » a une fin sans début -- document rejeté (échec fermé).`
      );
    }
    if (record.starts.length > 0 && record.ends.length === 0) {
      throw new DocxReadError(
        "UNBALANCED_BOOKMARK",
        `Le repère d'identifiant « ${id} » a un début sans fin -- document rejeté (échec fermé).`
      );
    }
    if (record.starts.length > 1 || record.ends.length > 1) {
      throw new DocxReadError(
        "MALFORMED_BOOKMARK_NESTING",
        `L'identifiant de repère « ${id} » est réutilisé plusieurs fois -- imbrication invalide (document rejeté, échec fermé).`
      );
    }
  }

  // -- CGV-specific: a chapter boundary must stay inside ONE
  //    paragraph (exactly as the writer always produces it); never
  //    enforced for non-cgv_ bookmarks (Word's own housekeeping
  //    bookmarks stay harmless whatever shape they take -- file
  //    header, "STABLE IDENTITY") --
  const cgvOccurrences: { name: string; paragraphIndex: number }[] = [];
  for (const [id, record] of byId) {
    const name = record.name;
    if (!name || !name.startsWith("cgv_")) continue;
    const startParagraph = record.starts[0];
    const endParagraph = record.ends[0];
    if (startParagraph !== endParagraph) {
      throw new DocxReadError(
        "MALFORMED_BOOKMARK_NESTING",
        `Le repère CGV « ${name} » (identifiant ${id}) s'étend sur plusieurs paragraphes -- imbrication invalide pour une limite de chapitre (document rejeté, échec fermé).`
      );
    }
    cgvOccurrences.push({ name, paragraphIndex: startParagraph });
  }

  // -- Identity syntax: a cgv_ bookmark name must carry a real,
  //    non-empty slug after the prefix (mandate: "invalid/empty
  //    bookmark identity") --
  for (const occ of cgvOccurrences) {
    if (!/^cgv_[A-Za-z0-9_-]+$/.test(occ.name)) {
      throw new DocxReadError(
        "INVALID_BOOKMARK_IDENTITY",
        `Le repère « ${occ.name} » n'a pas une identité CGV valide (préfixe « cgv_ » suivi d'un identifiant vide ou invalide) -- document rejeté (échec fermé).`
      );
    }
  }

  // -- Ambiguity within one paragraph: this is the EXACT shape of the
  //    audit's reproduction case ("two identical cgv_* bookmarks
  //    inside one paragraph"), and -- deliberately -- also catches two
  //    DIFFERENT cgv_ bookmarks sharing a paragraph: either way, which
  //    one is "the" chapter boundary for that paragraph is ambiguous,
  //    and this module never guesses --
  const byParagraph = new Map<number, string[]>();
  for (const occ of cgvOccurrences) {
    const list = byParagraph.get(occ.paragraphIndex) ?? [];
    list.push(occ.name);
    byParagraph.set(occ.paragraphIndex, list);
  }
  for (const [paragraphIndex, names] of byParagraph) {
    if (names.length > 1) {
      throw new DocxReadError(
        "AMBIGUOUS_BOOKMARK_PARAGRAPH",
        `Le paragraphe n°${paragraphIndex} porte plusieurs repères CGV (${names.join(", ")}) -- mapping ambigu, document rejeté en entier (échec fermé, jamais « le premier » ne gagne).`
      );
    }
  }

  // -- Cross-paragraph duplicate identity: the SAME cgv_ name must
  //    never designate more than one paragraph (mandate: "duplicate
  //    CGV bookmark name" / "duplicate CGV identity") --
  const paragraphIndexToName = new Map<number, string>();
  const seenNames = new Set<string>();
  for (const [paragraphIndex, names] of byParagraph) {
    const name = names[0];
    if (seenNames.has(name)) {
      throw new DocxReadError(
        "DUPLICATE_BOOKMARK_IDENTITY",
        `Le repère « ${name} » désigne plus d'un paragraphe -- identité CGV dupliquée, document rejeté en entier (échec fermé, jamais « le premier » ou « le dernier » ne gagne).`
      );
    }
    seenNames.add(name);
    paragraphIndexToName.set(paragraphIndex, name);
  }

  return paragraphIndexToName;
}

/**
 * Walks `word/document.xml`'s body into an ordered list of raw
 * paragraphs, using a bookmark map ALREADY validated (W1-03) by
 * `validateAndCollectCgvBookmarks` -- this function never re-derives
 * or re-checks bookmark validity itself, it only looks each
 * paragraph's assigned name up by index. Paragraphs nested inside a
 * table cell never reach here: `assertNoUnsupportedStructure` rejects
 * any document containing `<w:tbl>` before this function is ever
 * called (W1-02).
 */
function extractRawParagraphs(documentXml: string): RawDocxParagraph[] {
  assertWellFormedXml(documentXml);

  const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(documentXml);
  if (!bodyMatch) {
    throw new DocxReadError("MALFORMED_DOCUMENT", "Aucun <w:body> trouvé dans word/document.xml.");
  }
  const bodyXml = bodyMatch[1];

  assertNoUnsupportedStructure(bodyXml);

  const paragraphXmls = splitBodyIntoParagraphs(bodyXml);
  const bookmarkByParagraph = validateAndCollectCgvBookmarks(paragraphXmls);

  return paragraphXmls.map((paragraphXml, index) => {
    const rawText = extractParagraphText(paragraphXml);
    const text = isListParagraph(paragraphXml) && rawText.trim().length > 0 ? `• ${rawText}` : rawText;
    return { bookmarkName: bookmarkByParagraph.get(index) ?? null, text };
  });
}

/**
 * Groups raw paragraphs into `leadingContent` + chapters, dropping
 * blank/whitespace-only paragraphs along the way.
 *
 * BLANK PARAGRAPH NORMALIZATION (documented, not silent — mandate §4
 * forbids silently normalizing away MEANINGFUL legal edits, which
 * this is not): Word freely inserts and removes purely cosmetic empty
 * paragraphs during ordinary editing (spacing, cursor artifacts) that
 * carry no legal content whatsoever and that `renderCgv()`'s own HTML
 * output never produces in the first place — keeping them would only
 * manufacture spurious "added paragraph" / "removed paragraph" diff
 * noise for every merchant edit, obscuring the meaningful ones this
 * feature exists to surface.
 */
function groupIntoChapters(rawParagraphs: RawDocxParagraph[]): DocxImportResult {
  const leadingContent: string[] = [];
  const chapters: DocxImportedChapter[] = [];
  let current: DocxImportedChapter | null = null;

  for (const raw of rawParagraphs) {
    if (raw.bookmarkName) {
      current = { bookmarkName: raw.bookmarkName, paragraphs: [] };
      chapters.push(current);
      // The heading paragraph's own text (if non-blank) is itself the
      // chapter's first body line -- matches the writer, which emits
      // the heading as plain run text inside the same bookmarked
      // paragraph rather than as a separate, un-bookmarked paragraph.
      if (raw.text.trim().length > 0) current.paragraphs.push(raw.text);
      continue;
    }
    if (raw.text.trim().length === 0) continue;
    if (current) current.paragraphs.push(raw.text);
    else leadingContent.push(raw.text);
  }

  return { leadingContent, chapters };
}

/**
 * Main entry point, PURE: ArrayBuffer -> DocxImportResult. Throws
 * `DocxReadError` with a stable code for every failure mode (never a
 * raw, untyped exception reaching the caller).
 *
 * Mirrors xlsx-reader.ts's `readXlsxWorkbook` three-pass bounded
 * discipline exactly (see that file's header comment for the full
 * zip-bomb rationale this reuses verbatim via zip-safe.ts):
 *   1. Manifest pass -- zero decompression, central-directory only.
 *   2. Duplicate + size checks for BOTH whitelisted parts, BEFORE
 *      either is extracted -- an oversized or duplicated
 *      `[Content_Types].xml` or `word/document.xml` is rejected
 *      before any decompression happens for it.
 *   3. Bounded extraction of exactly those two parts, nothing else.
 *   4. (W1-03) XML well-formedness + global bookmark validation,
 *      STRICTLY before the document model (step 5) is ever built.
 *   5. Document model construction (grouping into chapters).
 */
export function readDocxDocument(buffer: ArrayBuffer): DocxImportResult {
  if (buffer.byteLength > MAX_IMPORT_FILE_SIZE_BYTES) {
    throw new DocxReadError(
      "FILE_TOO_LARGE",
      `Fichier trop volumineux (${buffer.byteLength} octets, limite ${MAX_IMPORT_FILE_SIZE_BYTES} octets).`
    );
  }

  const bytes = new Uint8Array(buffer);
  if (!checkZipSignature(bytes)) {
    throw new DocxReadError(
      "NOT_A_ZIP_CONTAINER",
      "Le fichier ne commence pas par une signature ZIP valide -- ce n'est pas un fichier .docx (jamais une confiance dans l'extension seule)."
    );
  }

  // Passe 1 -- manifeste : aucune décompression, uniquement le
  // répertoire central (nom, tailles déclarées, méthode, occurrences)
  // de chaque entrée, pertinente ou non.
  const manifest = buildZipManifest(bytes);

  // Passe 2 -- duplicats puis tailles, pour les DEUX seules entrées
  // jamais décompressées par ce module (voir RELEVANT_PART_NAMES et
  // l'en-tête du fichier, "PATH TRAVERSAL / UNEXPECTED FILES").
  // Duplicat rejeté AVANT toute vérification de taille (précédent
  // OB-3 v1.3, BLOCKER 1) : une entrée dupliquée ne peut pas être
  // classée "sûre" sur la seule foi d'une occurrence quelconque.
  const runningTotal = { bytes: 0 };
  assertNoDuplicateRelevantEntry(manifest, CONTENT_TYPES_PART);
  assertNoDuplicateRelevantEntry(manifest, DOCUMENT_PART);
  assertEntryDecompressionSafe(manifest, CONTENT_TYPES_PART, MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES, runningTotal);
  assertEntryDecompressionSafe(manifest, DOCUMENT_PART, MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES, runningTotal);

  // Passe 3 -- extraction bornée des deux seules entrées autorisées.
  const extracted = extractOnly(bytes, new Set(RELEVANT_PART_NAMES));

  const contentTypesBytes = extracted[CONTENT_TYPES_PART];
  if (!contentTypesBytes) {
    throw new DocxReadError("MALFORMED_DOCUMENT", "[Content_Types].xml introuvable dans l'archive -- conteneur OOXML invalide.");
  }
  assertWordprocessingMainDocument(decodeUtf8(contentTypesBytes));

  const documentBytes = extracted[DOCUMENT_PART];
  if (!documentBytes) {
    throw new DocxReadError("MALFORMED_DOCUMENT", "word/document.xml introuvable dans l'archive.");
  }

  let rawParagraphs: RawDocxParagraph[];
  try {
    rawParagraphs = extractRawParagraphs(decodeUtf8(documentBytes));
  } catch (e) {
    if (e instanceof DocxReadError) throw e;
    throw new DocxReadError("MALFORMED_DOCUMENT", "Contenu de word/document.xml illisible.");
  }

  const result = groupIntoChapters(rawParagraphs);

  if (result.chapters.length === 0) {
    throw new DocxReadError(
      "NO_RECOGNIZED_BOOKMARK",
      "Aucun repère de chapitre CGV reconnu dans le document -- impossible de mapper ce document en toute sécurité (échec fermé, aucune supposition)."
    );
  }

  return result;
}
