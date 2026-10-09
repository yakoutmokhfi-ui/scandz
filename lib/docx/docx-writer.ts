/**
 * CGV W1 — DOCX EXPORT / IMPORT ROUND-TRIP — DOCX *writer*.
 *
 * Hand-written, minimal OOXML (.docx) package builder. Zero new
 * dependency: uses `fflate` (0.8.3, zero-dependency, already an
 * existing, audited dependency of this repository — see
 * lib/catalogue-import/xlsx-reader.ts's own header comment for the
 * SheetJS/exceljs security evaluation that led to that same choice for
 * reading; the identical "write a minimal reader/writer ourselves
 * rather than pull in a large third-party OOXML library" decision is
 * made here for writing, for the same reason: this repository does not
 * currently depend on any package capable of generating .docx files,
 * and introducing one is a larger, separately-auditable change this
 * narrow foundation lot does not need).
 *
 * The output is a plain, uncontroversial OOXML WordprocessingML
 * document: one heading paragraph per CGV chapter, wrapped in a native
 * `w:bookmarkStart`/`w:bookmarkEnd` pair (the SAME stable identity
 * `lib/legal/cgv-document-model.ts` computes — `toOoxmlBookmarkName`),
 * followed by that chapter's body paragraphs as plain runs. No fields,
 * no macros, no embedded objects, no external relationships — nothing
 * for the reader side to ever have to distrust about a file this
 * module itself produced, and nothing a merchant's own edits in Word
 * could corrupt beyond ordinary paragraph text (bookmarks survive
 * ordinary text edits inside the paragraph they wrap).
 */

import { zipSync } from "fflate";
import type { CgvDocumentModel } from "@/lib/legal/cgv-document-model";
import { toOoxmlBookmarkName } from "@/lib/legal/cgv-document-model";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function paragraph(text: string, pStyle?: string): string {
  const style = pStyle ? `<w:pPr><w:pStyle w:val="${pStyle}"/></w:pPr>` : "";
  // xml:space="preserve" -- a merchant's paragraph may legitimately
  // start/end with whitespace after editing in Word; never silently
  // trimmed by this writer or by Word's own XML processing.
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function headingParagraphWithBookmark(bookmarkId: number, bookmarkName: string, heading: string): string {
  const ooxmlName = escapeXml(toOoxmlBookmarkName(bookmarkName));
  return (
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
    `<w:bookmarkStart w:id="${bookmarkId}" w:name="${ooxmlName}"/>` +
    `<w:r><w:t xml:space="preserve">${escapeXml(heading)}</w:t></w:r>` +
    `<w:bookmarkEnd w:id="${bookmarkId}"/>` +
    `</w:p>`
  );
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;

function coreProps(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>Scanym</dc:creator>
</cp:coreProperties>`;
}

const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Scanym CGV W1</Application>
</Properties>`;

/**
 * Builds a complete, valid, minimal .docx package from a CGV document
 * model. Deterministic: the same model always produces the same byte
 * sequence for `word/document.xml` (fflate's zip output itself is not
 * byte-stable across calls due to timestamps in the local file header
 * — this is never relied on for any invariant, unlike `renderCgv()`'s
 * own content-hash determinism, which this module never touches).
 */
export function buildCgvDocx(model: CgvDocumentModel): Uint8Array {
  const bodyParts: string[] = [];

  if (model.frontMatter.length > 0) {
    bodyParts.push(paragraph(model.frontMatter[0] ?? "", "Title"));
    for (const extra of model.frontMatter.slice(1)) {
      bodyParts.push(paragraph(extra));
    }
  }

  let bookmarkId = 0;
  for (const chapter of model.chapters) {
    bodyParts.push(headingParagraphWithBookmark(bookmarkId, chapter.bookmarkName, chapter.heading));
    bookmarkId += 1;
    for (const p of chapter.paragraphs) {
      bodyParts.push(paragraph(p));
    }
  }

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyParts.join("")}<w:sectPr/></w:body>` +
    `</w:document>`;

  const title = model.frontMatter[0] ?? "CGV";
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": encoder.encode(CONTENT_TYPES),
    "_rels/.rels": encoder.encode(PACKAGE_RELS),
    "word/document.xml": encoder.encode(documentXml),
    "word/styles.xml": encoder.encode(STYLES_XML),
    "word/_rels/document.xml.rels": encoder.encode(DOCUMENT_RELS),
    "docProps/core.xml": encoder.encode(coreProps(title)),
    "docProps/app.xml": encoder.encode(APP_PROPS),
  };

  return zipSync(files, { level: 6 });
}
