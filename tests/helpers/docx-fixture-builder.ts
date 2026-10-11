/**
 * CGV W1 — DOCX EXPORT / IMPORT ROUND-TRIP — TEST HELPER (never
 * production code). Builds a minimal but valid .docx package, part by
 * part, mirroring lib/docx/docx-writer.ts's own shape closely enough
 * that fixtures built here exercise the exact same parts
 * lib/docx/docx-reader.ts whitelists -- but gives tests direct control
 * over `word/document.xml`'s raw XML (to construct edge cases the
 * writer itself would never produce: a stray `_GoBack` bookmark, an
 * unrecognized `cgv_` name, a missing bookmark, a foreign content
 * type) and over `[Content_Types].xml` (to construct the "wrong
 * container format" rejection case).
 *
 * Built with `fflate.zipSync` -- the SAME library the writer and the
 * zip-safe.ts primitives both already depend on, exactly like
 * tests/helpers/xlsx-fixture-builder.ts's own documented rationale
 * for the equivalent XLSX helper.
 */

import { zipSync, strToU8 } from "fflate";

export { patchCentralDirectoryDeclaredSize, injectDuplicateCentralDirectoryEntry } from "./xlsx-fixture-builder.ts";

const DEFAULT_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export interface BuildMinimalDocxOptions {
  /** Overrides the whole `[Content_Types].xml` part -- used to build
   *  the "foreign/unsupported container" fixture (wrong or missing
   *  content type for /word/document.xml). */
  contentTypesXmlOverride?: string;
  /** Additional arbitrary ZIP entries (path -> raw string content) --
   *  never whitelisted by the reader, so present only to prove they
   *  are ignored (mirrors xlsx-fixture-builder.ts's `extraFiles`). */
  extraFiles?: Record<string, string>;
}

/**
 * Wraps a caller-supplied `<w:body>` inner XML into a complete, valid
 * `word/document.xml` document element.
 */
export function wordDocumentXml(bodyInnerXml: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyInnerXml}<w:sectPr/></w:body>` +
    `</w:document>`
  );
}

/** One plain run paragraph, no bookmark -- `xml:space="preserve"` as
 *  the real writer does, so leading/trailing-space test cases (not
 *  currently exercised, but kept realistic) are not silently lost. */
export function plainParagraphXml(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** A heading paragraph wrapped in a `w:bookmarkStart`/`w:bookmarkEnd`
 *  pair carrying `rawBookmarkName` verbatim (NOT run through
 *  `toOoxmlBookmarkName` -- callers pass the exact raw OOXML name they
 *  want the reader to see, including deliberately-foreign names for
 *  the "unrecognized bookmark" fixtures). */
export function bookmarkedParagraphXml(bookmarkId: number, rawBookmarkName: string, text: string): string {
  return (
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
    `<w:bookmarkStart w:id="${bookmarkId}" w:name="${rawBookmarkName}"/>` +
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>` +
    `<w:bookmarkEnd w:id="${bookmarkId}"/>` +
    `</w:p>`
  );
}

/** A genuinely empty paragraph (no run, no bookmark) -- the exact
 *  shape the mandate's "blank paragraph normalization" discussion in
 *  docx-reader.ts expects Word to produce for pure cosmetic spacing. */
export function emptyParagraphXml(): string {
  return `<w:p/>`;
}

/**
 * Builds a minimal, otherwise-valid .docx ZIP from a caller-supplied
 * `word/document.xml` string -- full control over the one part this
 * lot's reader actually interprets, everything else held to the same
 * realistic minimal shape lib/docx/docx-writer.ts itself produces.
 */
export function buildMinimalDocx(documentXml: string, options: BuildMinimalDocxOptions = {}): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(options.contentTypesXmlOverride ?? DEFAULT_CONTENT_TYPES),
    "_rels/.rels": strToU8(PACKAGE_RELS),
    "word/document.xml": strToU8(documentXml),
  };
  if (options.extraFiles) {
    for (const [path, content] of Object.entries(options.extraFiles)) {
      files[path] = strToU8(content);
    }
  }
  const zipped = zipSync(files, { level: 0 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}
