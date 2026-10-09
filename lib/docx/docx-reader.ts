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
 *     XML parser at all.
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
 * `lib/legal/cgv-docx-diff.ts`'s responsibility (Task #101), which
 * alone knows the current model's chapter set.
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
  | "DUPLICATE_ZIP_ENTRY";

export class DocxReadError extends Error {
  readonly code: DocxReadErrorCode;
  constructor(code: DocxReadErrorCode, message: string) {
    super(message);
    this.name = "DocxReadError";
    this.code = code;
  }
}

/** Preserve the public error class and this module's own six-code
 *  vocabulary — identical currying pattern as xlsx-reader.ts. */
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
 *  after `cgv_`-prefixed bookmark detection and multi-run `<w:t>`
 *  concatenation — but BEFORE empty-paragraph normalization and
 *  chapter grouping (that happens in `readDocxDocument`). */
interface RawDocxParagraph {
  bookmarkName: string | null;
  text: string;
}

export interface DocxImportedChapter {
  /** Raw OOXML bookmark name exactly as found in the import (e.g.
   *  "cgv_duree_du_contrat") — never decoded back to an internal
   *  slug. The diff engine (Task #101) compares this, byte for byte,
   *  against `toOoxmlBookmarkName(x)` for each `x` in the CURRENT
   *  model; an import-side name with no match in the current model
   *  is that engine's concern, not this reader's. */
  bookmarkName: string;
  /** Non-blank paragraphs belonging to this chapter, in document
   *  order, blank/whitespace-only paragraphs already dropped (see
   *  "BLANK PARAGRAPH NORMALIZATION" below). */
  paragraphs: string[];
}

export interface DocxImportResult {
  /** Non-blank paragraphs found before the first recognized
   *  `cgv_`-prefixed bookmark. Surfaced for review, never silently
   *  discarded, but deliberately NOT mapped to any chapter — Word
   *  round-trip title/front-matter editing is out of this lot's diff
   *  scope (see lib/legal/cgv-document-model.ts: front matter is
   *  exported but intentionally outside the bookmarked chapter set). */
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

/**
 * Concatenates ALL `<w:t>...</w:t>` run text found within one
 * paragraph's raw XML, in document order. Essential for a real-world
 * round trip: Word routinely splits a single sentence across several
 * runs (spell-check markers, tracked formatting, language tags) even
 * when the merchant's own edit touched none of that — reading only
 * the first `<w:t>` would silently truncate the paragraph.
 */
function extractParagraphText(paragraphXml: string): string {
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let text = "";
  let match: RegExpExecArray | null;
  while ((match = tRe.exec(paragraphXml)) !== null) {
    text += unescapeXmlEntities(match[1]);
  }
  return text;
}

/**
 * First `cgv_`-prefixed `w:bookmarkStart` name found in this
 * paragraph's raw XML, or `null` if none (including when the only
 * bookmarks present are Word's own housekeeping bookmarks such as
 * `_GoBack` — see file header, "STABLE IDENTITY / FAIL CLOSED"). A
 * paragraph can in principle carry more than one bookmark; the first
 * `cgv_`-prefixed one wins, matching the writer, which never emits
 * more than one bookmark per paragraph.
 */
function extractCgvBookmarkName(paragraphXml: string): string | null {
  const bookmarkRe = /<w:bookmarkStart\b([^>]*)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = bookmarkRe.exec(paragraphXml)) !== null) {
    const name = extractXmlAttribute(match[1], "w:name");
    if (name && name.startsWith("cgv_")) return name;
  }
  return null;
}

/**
 * Walks `word/document.xml`'s body into an ordered list of raw
 * paragraphs. Targeted regex only (file header, "XML PARSER
 * HAZARDS") — a self-closed `<w:p/>` (a genuinely empty paragraph,
 * which Word does emit) contributes no bookmark and no text and is
 * naturally dropped by the blank-paragraph normalization in
 * `readDocxDocument`, so it is not matched here at all. Paragraphs
 * nested inside a table cell (`<w:tbl>/<w:tr>/<w:tc>/<w:p>`) are
 * walked exactly like any other body paragraph — this v1 does not
 * model table structure specially (documented limitation).
 */
function extractRawParagraphs(documentXml: string): RawDocxParagraph[] {
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(documentXml);
  if (!bodyMatch) {
    throw new DocxReadError("MALFORMED_DOCUMENT", "Aucun <w:body> trouvé dans word/document.xml.");
  }
  const bodyXml = bodyMatch[1];

  const paragraphs: RawDocxParagraph[] = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = pRe.exec(bodyXml)) !== null) {
    const paragraphXml = match[1];
    paragraphs.push({
      bookmarkName: extractCgvBookmarkName(paragraphXml),
      text: extractParagraphText(paragraphXml),
    });
  }
  return paragraphs;
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
