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
 *   - XML PARSER HAZARDS (mandate §8): CONTENT EXTRACTION is still
 *     targeted regex only, never a generic engine's DOM tree — same
 *     discipline as xlsx-reader.ts and cgv-document-model.ts. WELL-
 *     FORMEDNESS CHECKING, as of the W1 SECOND REMEDIATION (W1-03),
 *     is delegated to `saxes`, a small pure-JS SAX parser — see
 *     `assertWellFormedXml` below for the full justification of why
 *     this is still safe: the library has no code path capable of
 *     network I/O, file I/O, external entity resolution, or DTD-
 *     driven entity expansion at all (not merely configured off), a
 *     `<!DOCTYPE` is additionally rejected outright before parsing as
 *     defense in depth, and the parser's own tree/result is discarded
 *     immediately — it answers exactly one question ("is this
 *     well-formed?") and is never used for extraction. (The FIRST
 *     remediation's hand-rolled tag-balance regex validator is what
 *     this replaces — it missed unquoted attribute values and
 *     undefined entity references, both genuine well-formedness
 *     violations a tag-balance replay can never fully cover.)
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
 *     lives in a separate part (`word/comments.xml`). The FIRST
 *     remediation left that part unextracted and therefore unrejected
 *     entirely; the BOULEZ delta re-audit correctly identified this as
 *     a silent-loss hole for a legal CGV review (a reviewer-visible
 *     comment such as "remplacer 30 jours par 14 jours" could vanish
 *     with `hasNoMeaningfulChanges = true`). The W1 SECOND REMEDIATION
 *     (W1-02) fixes this — see `assertNoWordComments` below and the
 *     "W1 SECOND REMEDIATION" doc block further down for the full
 *     policy and detection strategy.
 *   - PREAMBLE/TITLE: `imported.leadingContent` (unchanged shape) is
 *     now actually DIFFED by `lib/legal/cgv-docx-diff.ts` against
 *     `currentModel.frontMatter` (see that file) — this reader's job
 *     stops at faithfully collecting it, which it already did.
 *
 * ====================================================================
 * W1 SECOND TARGETED REMEDIATION (BOULEZ delta re-audit, candidate
 * 710a62c6, FAIL) — W1-02 (Word comments) / W1-03 (XML parser) — this
 * section documents the fixes added on top of the FIRST remediation
 * above, which the delta re-audit confirmed PASS for W1-01 and W1-04
 * (left entirely unchanged by this second pass).
 * ====================================================================
 *
 * W1-03 — see `assertWellFormedXml` below (STAGE 1) for the full
 * write-up: the hand-rolled tag-balance validator is replaced by a
 * standards-conforming `saxes` parser used for well-formedness ONLY,
 * with a zero-I/O/zero-entity-expansion guarantee verified by
 * inspection, not merely configuration.
 *
 * W1-02 — WORD COMMENT TEXT, FAIL CLOSED (never silently zero-diffed).
 *
 * PRODUCT RULE (OPTION A, the mandate's preferred v1 strategy): a
 * DOCX whose package contains `word/comments.xml` with at least one
 * non-blank comment is REJECTED WHOLE with a new, stable
 * `UNSUPPORTED_WORD_COMMENTS` code — never imported as contractual
 * body text, never silently ignored. This is deliberately the
 * simplest fail-closed legal behavior available (OPTION B, surfacing
 * comments as visible-but-unimported annotations in the merchant-
 * facing review UI, was considered and rejected for v1: it requires
 * new UI surface area and a new `DocxImportResult` field this
 * targeted remediation's "do NOT redesign W1" scope does not call
 * for; REJECTING is strictly safer and smaller).
 *
 * COMMENT DETECTION STRATEGY — bounded, "prevented by construction"
 * (same doctrine as the rest of this file), never a general-purpose
 * OOXML-relationship resolver:
 *
 *   1. `word/comments.xml` is added to `RELEVANT_PART_NAMES` (now
 *      three fixed names, not two) and extracted through the EXACT
 *      SAME `zip-safe.ts` three-pass bounded-decompression primitives
 *      already governing the other two parts (manifest-only pass,
 *      then duplicate + size checks, then bounded extraction) — see
 *      `readDocxDocument` below. The whitelist grows by one
 *      well-known, standard part name; the bound around it does not
 *      change at all. No new ZIP-bomb or path-traversal surface is
 *      introduced.
 *   2. This module identifies the comments part SOLELY by that fixed,
 *      canonical path, exactly as it already does for
 *      `word/document.xml` — it does NOT parse
 *      `word/_rels/document.xml.rels` or `[Content_Types].xml`'s
 *      comments-specific `Override` to "discover" where comments
 *      might live. This is a deliberate scope boundary, not an
 *      oversight: chasing an attacker- or tool-redirected relationship
 *      Target to an arbitrary, non-standard path would mean extracting
 *      a path this module cannot bound in advance — exactly what the
 *      mandate's "do not suddenly extract arbitrary DOCX contents"
 *      warns against. A comments part saved at any OTHER path (test
 *      case "unexpected comments relationship/path") is, by this
 *      policy, simply not inspected — documented below as an accepted
 *      v1 limitation, consistent with how `word/vbaProject.bin` and
 *      external relationship targets are already handled elsewhere in
 *      this file (never chased, never actioned, because never on the
 *      fixed whitelist).
 *   3. If present, `word/comments.xml` is first run through the SAME
 *      `assertWellFormedXml` well-formedness check as
 *      `word/document.xml` (STAGE 1 re-applied to a second part) — a
 *      malformed comments part fails CLOSED with `MALFORMED_DOCUMENT`,
 *      never silently treated as "no comments found" (test case
 *      "malformed comments.xml").
 *   4. Once proven well-formed, EVERY `<w:t>` run inside the WHOLE
 *      `word/comments.xml` document is concatenated (reusing the same
 *      targeted-regex token extraction as paragraph text) and trimmed.
 *      Any non-blank result anywhere in the part → rejected with
 *      `UNSUPPORTED_WORD_COMMENTS` (covers one comment, several
 *      comments, and a comment nested anywhere in the structure
 *      identically — no per-comment special-casing needed, because
 *      the product rule does not distinguish "one comment" from
 *      "many": any visible comment text at all is unsupported).
 *   5. If `word/comments.xml` is ABSENT from the archive entirely
 *      (no comments ever existed, OR a relationship nominally
 *      "declares" one that the ZIP itself does not actually contain —
 *      test case "comments part declared but missing"), or present
 *      but contains ONLY empty/whitespace `<w:comment>` elements with
 *      no visible text (test case "comment markers only with no
 *      comment text") — the import proceeds exactly as before: there
 *      is no comment TEXT to lose, so there is nothing this product
 *      rule needs to guard against. In-body comment-RANGE MARKERS
 *      (`w:commentRangeStart`/`w:commentRangeEnd`/`w:commentReference`)
 *      remain harmless and unrejected by themselves, unchanged from
 *      the first remediation — they carry no text of their own; only
 *      actual comment TEXT in `word/comments.xml` ever triggers
 *      rejection.
 *
 * DOCUMENTED SUPPORTED POLICY (summary): "If a DOCX contains any
 * visible Word comment text, reject the import with
 * UNSUPPORTED_WORD_COMMENTS. A document with no comments, or whose
 * comments are all empty, imports exactly as before this
 * remediation."
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
// W1 SECOND REMEDIATION (W1-03) -- see "XML WELL-FORMEDNESS (STAGE 1)"
// below for the full justification of why this specific, pure,
// zero-I/O library is safe to depend on here (no XXE/DTD/network
// capability exists anywhere in it -- not merely disabled by an
// option, simply never implemented).
import { SaxesParser } from "saxes";

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
  | "UNSUPPORTED_TRACKED_CHANGES"
  // W1 SECOND REMEDIATION (W1-02) -- Word comment text, fail closed.
  | "UNSUPPORTED_WORD_COMMENTS";

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
// W1 SECOND REMEDIATION (W1-02) -- the OOXML-standard, fixed location
// for Word comment TEXT (never the in-body range markers, which carry
// no text of their own -- see "COMMENT DETECTION STRATEGY" below).
const COMMENTS_PART = "word/comments.xml";
const WORDPROCESSING_MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/** The ONLY three ZIP entries this module ever decompresses, whatever
 *  else the archive declares (see file header, "PATH TRAVERSAL /
 *  UNEXPECTED FILES"). `COMMENTS_PART` was added by the W1 SECOND
 *  REMEDIATION (W1-02): reusing the EXACT same bounded, duplicate-
 *  checked, size-checked `zip-safe.ts` primitives already applied to
 *  the first two names (see `readDocxDocument` below) -- the
 *  whitelist grows by one well-known, standard OOXML part name, the
 *  discipline around it does not change at all. */
const RELEVANT_PART_NAMES = [CONTENT_TYPES_PART, DOCUMENT_PART, COMMENTS_PART] as const;

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
 * W1 SECOND REMEDIATION (W1-03) -- STAGE 1 well-formedness check,
 * REPLACING the first remediation's hand-rolled tag-balance validator
 * (kept in history/git-blame only). The BOULEZ delta re-audit
 * reproduced two concrete acceptance holes the hand-rolled regex
 * validator could not see because it never looked at attribute syntax
 * or entity references at all:
 *
 *   - `<w:t x=1>AB</w:t>`  (an UNQUOTED attribute value -- not legal
 *     XML; a conforming parser requires `'...'`/`"..."`)
 *   - `AB &bogus; CD`      (an UNDEFINED entity reference -- XML only
 *     ever predefines `&amp; &lt; &gt; &quot; &apos;`; anything else
 *     must be declared, and this module never trusts/expands any
 *     declaration at all -- see below)
 *
 * Both are well-formedness violations under the XML 1.0 grammar
 * itself, not just "things this one legal use case happens to care
 * about" -- which is exactly why the audit's verdict was "the
 * hand-written validator is insufficient" rather than "add two more
 * regexes": a tag-balance replay can never be complete coverage of
 * XML's actual grammar (attribute-value quoting, entity-reference
 * syntax, character-range restrictions, namespace well-formedness,
 * CDATA/comment nesting rules, …), and each audit round finding one
 * more hole it misses is the predictable result of that approach.
 *
 * FIX: delegate well-formedness ONLY (never content extraction, see
 * below) to `saxes` -- a small (~2,050-line, one-dependency, pure-JS)
 * SAX-style XML parser already present in this repository's own
 * dependency tree (pulled in transitively by `jsdom`, which this
 * project already uses for its own `.dom.test.ts` harness) and now
 * promoted to a direct `dependencies` entry in package.json (never a
 * `devDependency`-only tool masquerading as production-safe). It:
 *
 *   - has NO code path that performs network I/O, file I/O, or any
 *     other external resource access AT ALL -- not an option that is
 *     merely turned off, but a capability the library's ~2,050 lines
 *     simply never implement (grep the source for yourself: the only
 *     `require()`s are its own character-class tables). This is the
 *     SAME "prevented by construction, not merely disabled" doctrine
 *     this file already applies to path traversal and macro/OLE
 *     parts (file header, above) -- extended here to XXE;
 *   - NEVER expands any entity beyond the five predefined XML
 *     entities (`&amp; &lt; &gt; &quot; &apos;`) and numeric character
 *     references -- its own documentation states plainly: "It's
 *     possible to define additional entities in XML by putting them
 *     in the DTD. This parser doesn't do anything with that."
 *     Concretely, `<!DOCTYPE … [ <!ENTITY xxe SYSTEM "…"> ]>` is
 *     tokenized as opaque, un-interpreted text (the internal DTD
 *     subset is scanned only far enough to find its closing `]>`,
 *     never parsed into entity declarations), so `&xxe;` later in the
 *     document still fails as an "undefined entity" -- verified
 *     directly against this exact payload before relying on it here;
 *   - is non-validating (no DTD/schema is ever loaded or enforced) --
 *     it is used here for ONE question only ("is this well-formed
 *     XML?"), never for data binding, DOM construction kept around
 *     afterwards, or schema validation;
 *   - is the SAME library `jsdom` (an existing devDependency, used
 *     by this repo's own `.dom.test.ts` harness) uses internally for
 *     its own XML/XHTML parsing, so its XML-conformance behavior is
 *     already exercised, at scale, by this codebase's existing test
 *     suite indirectly -- not a brand-new, unvetted dependency;
 *   - is pure JS with zero Node-only built-in `require()`s (`fs`,
 *     `net`, `http`, …) and no browser-incompatible API usage, so it
 *     runs identically in this module's two real hosts: the Node
 *     test runner (`node --experimental-strip-types --test`, no
 *     jsdom) AND the actual browser runtime of
 *     `app/dashboard/legal-cgv/page.tsx` (this page is entirely
 *     client-side, per the architecture this file's header already
 *     documents) -- confirmed by inspection of its own `require()`
 *     graph (only its sibling `xmlchars` package, itself dependency-
 *     free) and by this module's own full test suite passing under
 *     both the plain Node pure-test harness and the esbuild+jsdom DOM
 *     harness.
 *
 * DEFENSE IN DEPTH: a `<!DOCTYPE` declaration is rejected OUTRIGHT by
 * this function, BEFORE the document is even handed to the parser.
 * `saxes` already makes any DTD-declared entity permanently unusable
 * (see above), so this extra guard is not load-bearing for the XXE
 * guarantee -- but a legitimate `word/document.xml` produced by Word,
 * or by this codebase's own `lib/docx/docx-writer.ts`, NEVER contains
 * a DOCTYPE declaration at all, so rejecting it outright costs zero
 * legitimate documents while collapsing the entire "does this parser
 * correctly refuse to act on a DTD" question to "is a DOCTYPE present
 * at all", independent of any one parser's internal behavior -- the
 * same "fail closed on anything not already known to be needed"
 * doctrine this module applies everywhere else (tables, tracked
 * changes, unrecognized content types, …).
 *
 * The parser answers well-formedness ONLY -- it is never kept around,
 * its tree is never read, and it never replaces the existing targeted
 * regex extraction (`extractParagraphText`, `splitBodyIntoParagraphs`,
 * `validateAndCollectCgvBookmarks`, …) downstream, which still runs
 * exactly as before, now only ever over XML already proven
 * well-formed by a standards-conforming check.
 */
function assertWellFormedXml(xml: string): void {
  if (/<!DOCTYPE\b/i.test(xml)) {
    throw new DocxReadError(
      "MALFORMED_DOCUMENT",
      "Déclaration DOCTYPE présente dans le document -- jamais attendue dans un word/document.xml légitime, document rejeté (échec fermé, aucune résolution de DTD tentée)."
    );
  }
  const parser = new SaxesParser({ xmlns: true });
  try {
    parser.write(xml).close();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new DocxReadError(
      "MALFORMED_DOCUMENT",
      `XML mal formé (${detail}) -- document rejeté, aucune tentative de récupération.`
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

// ====================================================================
// W1 SECOND REMEDIATION (W1-02) -- Word comment text, fail closed.
// ====================================================================

/**
 * Extracts and concatenates every `<w:t>…</w:t>` run's text found
 * ANYWHERE in `commentsXml` (the whole `word/comments.xml` part, not
 * one paragraph) — deliberately simpler than `extractParagraphText`
 * (no `w:tab`/`w:br` modeling, no per-paragraph boundary tracking):
 * this function only ever needs to answer "is there ANY visible
 * comment text at all", never "what exactly does it say, in what
 * structure" (this v1 never imports comment text as CGV body content
 * — see the "W1 SECOND REMEDIATION" doc block above — so no
 * structural fidelity is needed for text this module will never use
 * as anything other than a yes/no trigger).
 */
function extractAllRunText(xml: string): string {
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let text = "";
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml)) !== null) {
    text += unescapeXmlEntities(match[1]);
  }
  return text;
}

/**
 * W1 SECOND REMEDIATION (W1-02) — see the "W1 SECOND REMEDIATION" doc
 * block above for the full product rule and detection strategy. Called
 * ONLY when `word/comments.xml` is actually present in the archive
 * (absence is handled by the caller — absence means "nothing to guard
 * against", never an error). Throws `UNSUPPORTED_WORD_COMMENTS` the
 * moment ANY non-blank comment text is found anywhere in the part;
 * otherwise returns normally (comment markers/empty comments stay
 * harmless, unchanged from the first remediation).
 */
function assertNoWordComments(commentsXml: string): void {
  // Re-applies STAGE 1 well-formedness to this SECOND part: a
  // malformed word/comments.xml fails CLOSED (MALFORMED_DOCUMENT),
  // never silently treated as "no comments found".
  assertWellFormedXml(commentsXml);

  const visibleText = extractAllRunText(commentsXml).trim();
  if (visibleText.length > 0) {
    throw new DocxReadError(
      "UNSUPPORTED_WORD_COMMENTS",
      "Le document importé contient un ou plusieurs commentaires Word avec du texte visible -- non importé automatiquement comme contenu contractuel (échec fermé ; le commentaire n'est jamais silencieusement ignoré, voir la politique documentée dans docx-reader.ts)."
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
  // W1 SECOND REMEDIATION (W1-02) -- word/comments.xml is OPTIONAL
  // (most documents have none), but when the manifest declares it,
  // it gets the EXACT SAME duplicate + bounded-size checks as the two
  // mandatory parts, before any decompression. Both helpers below are
  // no-ops when the manifest does not contain the name at all.
  assertNoDuplicateRelevantEntry(manifest, COMMENTS_PART);
  assertEntryDecompressionSafe(manifest, CONTENT_TYPES_PART, MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES, runningTotal);
  assertEntryDecompressionSafe(manifest, DOCUMENT_PART, MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES, runningTotal);
  assertEntryDecompressionSafe(manifest, COMMENTS_PART, MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES, runningTotal);

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

  // W1 SECOND REMEDIATION (W1-02) -- checked BEFORE paragraph
  // extraction, fail closed as early as possible. Absence is NOT an
  // error (see "W1 SECOND REMEDIATION" doc block, point 5): most
  // documents never had comments at all, or a stale relationship
  // "declared" one the ZIP does not actually contain -- either way,
  // there is no comment text to lose.
  const commentsBytes = extracted[COMMENTS_PART];
  if (commentsBytes) {
    assertNoWordComments(decodeUtf8(commentsBytes));
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
