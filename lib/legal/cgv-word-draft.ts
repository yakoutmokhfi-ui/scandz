import type { DocxImportResult } from "@/lib/docx/docx-reader";
import { parseCgvDocumentModel, cgvChapterHeadingLine, toOoxmlBookmarkName } from "@/lib/legal/cgv-document-model";
export class CgvWordDraftError extends Error {
  code: "structure" | "protected_section" | "size";
  constructor(code: "structure" | "protected_section" | "size") { super(code); this.code = code; }
}
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const paragraph = (s: string) => `<p style="white-space:pre-wrap">${escape(s)}</p>`;
/** Database JSON is untrusted too. This contract permits paragraph edits,
 * retaining all chapter identities, headings, order and the statutory block. */
export function renderCgvWordDraft(baselineHtml: string, input: unknown): string {
  const model = parseCgvDocumentModel(baselineHtml);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CgvWordDraftError("structure");
  const d = input as DocxImportResult;
  if (!Array.isArray(d.leadingContent) || d.leadingContent.length < 2 || d.leadingContent.length > 3 || !Array.isArray(d.chapters) || !model.chapters.length || d.chapters.length !== model.chapters.length) throw new CgvWordDraftError("structure");
  let count = 0;
  const check = (s: unknown) => {
    if (typeof s !== "string" || !s.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new CgvWordDraftError("structure");
    count += s.length;
    if (s.length > 40000 || count > 300000) throw new CgvWordDraftError("size");
  };
  d.leadingContent.forEach(check);
  for (let i = 0; i < model.chapters.length; i++) {
    const expected = model.chapters[i], chapter = d.chapters[i];
    if (!chapter || chapter.bookmarkName !== toOoxmlBookmarkName(expected.bookmarkName) || !Array.isArray(chapter.paragraphs) || chapter.paragraphs.length < (expected.paragraphs.some(p => p.trim()) ? 2 : 1) || chapter.paragraphs.length > 500 || chapter.paragraphs[0] !== cgvChapterHeadingLine(expected)) throw new CgvWordDraftError("structure");
    chapter.paragraphs.forEach(check);
    if (expected.bookmarkName === "legal-guarantee-encadre" && JSON.stringify(chapter.paragraphs.slice(1)) !== JSON.stringify(expected.paragraphs.filter(p => p.trim()))) throw new CgvWordDraftError("protected_section");
  }
  let index = 0;
  let html = baselineHtml.replace(/<section class="(cgv-section|legal-guarantee-encadre)"[^>]*>[\s\S]*?<\/section>/g, section => {
    const chapter = d.chapters[index++];
    if (model.chapters[index - 1].bookmarkName === "legal-guarantee-encadre") return section;
    return section.slice(0, section.indexOf("</h2>") + 5) + chapter.paragraphs.slice(1).map(paragraph).join("") + "</section>";
  });
  if (index !== d.chapters.length) throw new CgvWordDraftError("structure");
  html = html.replace(/<header class="cgv-document-header">[\s\S]*?<\/header>/, () => `<header class="cgv-document-header"><h1 class="cgv-document-title">${escape(d.leadingContent[0])}</h1><p class="cgv-document-seller">${escape(d.leadingContent[1])}</p></header>`);
  return html.replace(/<p class="cgv-preamble">[\s\S]*?<\/p>/, () => d.leadingContent[2] ? `<p class="cgv-preamble">${escape(d.leadingContent[2])}</p>` : "");
}
