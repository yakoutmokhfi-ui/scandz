/**
 * CGV W1 — DOCX EXPORT / IMPORT ROUND-TRIP — document model.
 *
 * PURE, read-only. Turns the TRUSTED output of `renderCgv()`
 * (lib/legal/render.ts, never modified by this lot) into an ordered,
 * structured representation that the DOCX writer/reader/diff modules
 * all share. `renderCgv()` itself keeps producing exactly the same
 * HTML string, byte for byte, as before this lot (verified by the
 * existing cgv-document-presentation-v1 / seller-legal-profile-cgv-
 * engine-v2-1-render test suites, unmodified) — this file never
 * changes what gets published, only how the ALREADY-rendered content
 * is re-expressed as chapters for the Word round trip.
 *
 * CANONICAL SERIALIZATION PATH (mandate §"TECHNICAL APPROACH"): the
 * one and only place in this project that renders a CGV document is
 * `renderCgv()`. This module reads ITS output — never re-derives
 * content independently, never calls any RPC, never invents text.
 *
 * STABLE STRUCTURAL IDENTITY (mandate §2, "Do NOT rely only on
 * paragraph position"): `renderCgv()` already wraps every section in
 * `<section class="cgv-section" data-chapter="N">`, with a `<h2>`
 * whose `cgv-chapter-title` span carries the section's HEADING —
 * itself Scanym-controlled, deterministic text (see
 * lib/legal/section-classification.ts: every heading is either
 * GENERIC_FIXED/GENERIC_CONDITIONAL/MERCHANT_VALUE template text, or a
 * MERCHANT_POLICY section's own template-controlled label
 * (`cancellation_clause_label`/`substitution_clause_label`) — never
 * merchant-authored free text). The chapter NUMBER (`data-chapter`)
 * shifts whenever an earlier CONDITIONAL section appears/disappears
 * (cold chain toggle, portion pricing mode, withdrawal regime) — so it
 * is a FRAGILE identity across two renders of the same restaurant at
 * different times. The HEADING, however, is POSITION-INDEPENDENT and
 * (within one render) unique, so this module derives each chapter's
 * `bookmarkName` from a deterministic slug of its heading, never from
 * `data-chapter`. This is the identity the DOCX writer embeds as a
 * native OOXML bookmark, and the one the reader/diff match on.
 *
 * Only two markup shapes exist inside a chapter body, both emitted by
 * `renderCgv()` itself: plain `<p>…</p>` paragraphs, and
 * `<div class="cgv-identity-row"><dt>…</dt><dd>…</dd></div>` label/value
 * rows (used for the seller-identity and customer-service "lists").
 * Both are extracted, in document order, into one flat `paragraphs`
 * array per chapter — "Do not flatten everything into one text blob"
 * is honored at the CHAPTER level (titles/sections/paragraphs stay
 * distinct), while within a chapter a label/value row becomes one
 * "Label : Value" line, which is exactly how it reads on the public
 * legal page and is perfectly round-trippable as plain text.
 *
 * Never a generic HTML/DOM parser (`DOMParser`, `innerHTML` traversal)
 * — targeted regexes only, same discipline as
 * lib/catalogue-import/xlsx-reader.ts's own header comment, and safe
 * here for an additional reason that file doesn't have: this HTML is
 * never untrusted input, it is Scanym's own server-rendered output.
 */

import { unescapeXmlEntities } from "@/lib/ooxml/zip-safe";

export interface CgvDocumentChapter {
  /** Deterministic, position-independent identity — see file header.
   *  Embedded as a native OOXML bookmark name by the DOCX writer. */
  bookmarkName: string;
  /** The exact heading text at export time (display only — the
   *  reader/diff never trust a heading string found inside an
   *  imported DOCX; they trust the bookmark it was wrapped in). */
  heading: string;
  /** One entry per paragraph / identity row, in document order. */
  paragraphs: string[];
}

export interface CgvDocumentModel {
  /** Document title + seller name + preamble — exported as plain
   *  context paragraphs ahead of the first chapter, but intentionally
   *  OUTSIDE the bookmarked/diffable chapter set: it is not one of the
   *  26 mandate CGV sections, and this lot does not diff it. */
  frontMatter: string[];
  chapters: CgvDocumentChapter[];
}

/** ASCII, lowercase, dash-separated slug of a heading — stable across
 *  renders as long as the heading text itself does not change (it is
 *  Scanym-controlled template text, not merchant-authored). */
export function slugifyCgvHeading(heading: string): string {
  return (
    heading
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * Maps an internal `bookmarkName` (dash-separated, see
 * `slugifyCgvHeading` above) to the literal OOXML bookmark name the
 * DOCX writer embeds and the DOCX reader/diff look for. OOXML tolerates
 * most characters in `w:bookmarkStart/@w:name`, but Word's own UI (and
 * some validators) expect a leading letter/underscore and no hyphens —
 * so this is the ONE place that encoding is decided, imported by both
 * the writer (to embed) and the diff engine (to know what to look
 * for in an imported document's raw bookmark names). There is
 * deliberately no inverse "decode" function: the reader never needs
 * to recover a `bookmarkName` from an arbitrary OOXML name (it could
 * be anything in a hand-edited or foreign document) — it only ever
 * checks raw bookmark names found in the import against
 * `toOoxmlBookmarkName(x)` for each `x` already known from the CURRENT
 * model. An unrecognized raw name is never guessed at — see
 * lib/legal/cgv-docx-diff.ts.
 */
export function toOoxmlBookmarkName(bookmarkName: string): string {
  return `cgv_${bookmarkName.replace(/-/g, "_")}`;
}

/** Stable bookmark name for the one section `renderCgv()` deliberately
 *  never numbers (mandate: "not a chapter of its own" — see
 *  render.ts's own v2.5 comment). Fixed, never derived from a heading
 *  that could theoretically collide with a numbered chapter's slug. */
const LEGAL_GUARANTEE_ENCADRE_BOOKMARK = "legal-guarantee-encadre";

function extractParagraphs(bodyHtml: string): string[] {
  const paragraphs: string[] = [];
  const blockRe =
    /<div class="cgv-identity-row"><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/div>|<p[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(bodyHtml))) {
    if (match[1] !== undefined) {
      const label = unescapeXmlEntities(match[1]);
      const value = unescapeXmlEntities(match[2] ?? "");
      paragraphs.push(`${label} : ${value}`);
    } else {
      paragraphs.push(unescapeXmlEntities(match[3] ?? ""));
    }
  }
  return paragraphs;
}

/**
 * Parses the TRUSTED HTML produced by `renderCgv()` into the shared
 * document model. Never throws on well-formed renderer output; an
 * empty/unexpected input simply produces an empty model (this is a
 * read path over Scanym's own trusted content, not a validator of
 * untrusted data — the DOCX *reader*, a separate module, is where
 * untrusted-input hardening lives).
 */
export function parseCgvDocumentModel(renderedHtml: string): CgvDocumentModel {
  const frontMatter: string[] = [];

  const headerMatch = /<header class="cgv-document-header">([\s\S]*?)<\/header>/.exec(renderedHtml);
  if (headerMatch) {
    const titleMatch = /<h1 class="cgv-document-title">([\s\S]*?)<\/h1>/.exec(headerMatch[1]);
    const sellerMatch = /<p class="cgv-document-seller">([\s\S]*?)<\/p>/.exec(headerMatch[1]);
    if (titleMatch) frontMatter.push(unescapeXmlEntities(titleMatch[1]));
    if (sellerMatch) frontMatter.push(unescapeXmlEntities(sellerMatch[1]));
  }
  const preambleMatch = /<p class="cgv-preamble">([\s\S]*?)<\/p>/.exec(renderedHtml);
  if (preambleMatch) frontMatter.push(unescapeXmlEntities(preambleMatch[1]));

  const chapters: CgvDocumentChapter[] = [];
  const usedBookmarks = new Set<string>();
  const sectionRe = /<section class="(cgv-section|legal-guarantee-encadre)"[^>]*>([\s\S]*?)<\/section>/g;
  let sectionMatch: RegExpExecArray | null;
  while ((sectionMatch = sectionRe.exec(renderedHtml))) {
    const kind = sectionMatch[1];
    const inner = sectionMatch[2];

    let heading: string | null = null;
    let bodyHtml = inner;
    if (kind === "cgv-section") {
      const h2Match = /<h2 class="cgv-section-heading">[\s\S]*?<span class="cgv-chapter-title">([\s\S]*?)<\/span><\/h2>/.exec(
        inner
      );
      if (!h2Match) continue; // defensive -- renderCgv() always emits this shape; never a crash on a future shape change.
      heading = unescapeXmlEntities(h2Match[1]);
      bodyHtml = inner.slice(h2Match.index + h2Match[0].length);
    } else {
      const h2Match = /<h2 class="cgv-encadre-heading">([\s\S]*?)<\/h2>/.exec(inner);
      if (!h2Match) continue;
      heading = unescapeXmlEntities(h2Match[1]);
      bodyHtml = inner.slice(h2Match.index + h2Match[0].length);
    }

    // Deterministic bookmark name — see file header. A heading
    // collision (should never happen given renderCgv()'s fixed,
    // distinct heading set) is made safe rather than silently
    // overwriting an earlier chapter: a numeric suffix disambiguates,
    // and the diff engine still matches each exported bookmark
    // exactly, byte for byte, on import.
    let bookmarkName = kind === "legal-guarantee-encadre" ? LEGAL_GUARANTEE_ENCADRE_BOOKMARK : slugifyCgvHeading(heading);
    let suffix = 2;
    const base = bookmarkName;
    while (usedBookmarks.has(bookmarkName)) {
      bookmarkName = `${base}-${suffix}`;
      suffix += 1;
    }
    usedBookmarks.add(bookmarkName);

    chapters.push({ bookmarkName, heading, paragraphs: extractParagraphs(bodyHtml) });
  }

  return { frontMatter, chapters };
}
