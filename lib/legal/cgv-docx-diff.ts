/**
 * CGV W1 — DOCX EXPORT / IMPORT ROUND-TRIP — structured diff.
 *
 * PURE. Takes the CURRENT CGV document model (lib/legal/
 * cgv-document-model.ts, built from `renderCgv()`'s trusted output)
 * and the result of importing a merchant-edited .docx
 * (lib/docx/docx-reader.ts, already hardened against untrusted
 * input) and produces a structured, human-reviewable diff. This
 * module never touches persistence, never calls the publish path,
 * and never mutates either input — it only compares them (mandate
 * §6/§7: "W1 prepares content for review. It does not redefine
 * publication authority.").
 *
 * MATCHING / FAIL CLOSED (mandate §5, "If the imported document
 * cannot be mapped safely: FAIL CLOSED. Return a reviewable error.
 * Do not guess."):
 *
 *   Chapters are matched EXCLUSIVELY by OOXML bookmark name
 *   (`toOoxmlBookmarkName(currentChapter.bookmarkName)` against the
 *   raw name `docx-reader.ts` found) — never by heading text, never
 *   by position. Two situations are treated as UNSAFE TO MAP and
 *   reject the WHOLE diff with `CgvDocxDiffError`, before producing
 *   any partial result:
 *     1. An imported chapter's bookmark name does not correspond to
 *        ANY chapter of the CURRENT model. Every CGV chapter is
 *        Scanym-template-controlled (lib/legal/
 *        section-classification.ts) — a merchant can edit a
 *        chapter's TEXT in Word, but has no legitimate way to
 *        introduce a brand-new chapter; an unrecognized bookmark
 *        therefore means either document corruption, a bookmark
 *        copy-pasted in from an unrelated CGV export, or deliberate
 *        tampering, and this module refuses to guess which.
 *     2. The SAME raw bookmark name appears on more than one
 *        imported chapter (OOXML itself requires bookmark names to
 *        be unique within a document, but a hand-edited or foreign
 *        file could still violate that) — ambiguous, so the whole
 *        import is rejected, exactly as a duplicated ZIP entry name
 *        is rejected whole in zip-safe.ts/docx-reader.ts, never
 *        "first wins" / "last wins".
 *
 *   By contrast, a chapter of the CURRENT model that is simply ABSENT
 *   from the import (no matching bookmark found at all) is NOT a
 *   failure: it is reported as one `removedChapters` entry — a
 *   legitimate large edit (the merchant deleted that section's
 *   content, bookmark included) that the human reviewer must see,
 *   never silently dropped and never a reason to refuse the rest of
 *   the diff.
 *
 * DIFF GRANULARITY (mandate §4, "meaningful structured diff ...
 * unchanged/modified/added/removed ... Do NOT silently normalize away
 * meaningful legal edits"): for a chapter present on both sides, this
 * module diffs the ORDERED line list `[heading, ...bodyParagraphs]`
 * (so a heading-text-only edit surfaces as a `modified` entry on the
 * first line, satisfying the mandate's "heading edit detected" test)
 * via an LCS-based line diff, then a conservative post-pass pairs up
 * an adjacent equal-length removed-run/added-run as `modified` pairs
 * (a one-line text edit would otherwise show as an unrelated-looking
 * remove+add, which is correct but harder for a human to read as "one
 * edit"). Nothing is normalized away beyond what
 * `lib/docx/docx-reader.ts` already documents (purely cosmetic blank
 * paragraphs) — every remaining textual difference, however small, is
 * surfaced.
 *
 * ====================================================================
 * W1 TARGETED REMEDIATION (BOULEZ audit, candidate c5924a5, FAIL) —
 * W1-01 / W1-02.
 * ====================================================================
 *
 * W1-01 — CHAPTER ORDER. The audit's reproduction case: current model
 * [Alpha, Beta], import [Beta, Alpha] (same two bookmarks, just
 * swapped) used to return `hasNoMeaningfulChanges: true` — order was
 * never compared at all, only per-chapter line content and chapter
 * presence/absence. Fixed by `computeOrderChanged` below: it reduces
 * BOTH sides to the matched-bookmark subset (chapters present on both
 * sides — a chapter the merchant deleted is already its own
 * `removedChapters` signal and must never ALSO manufacture a false
 * order change) and compares the two resulting sequences by bookmark
 * IDENTITY (never heading text, never position) for exact equality.
 * `orderChanged` folds into `hasNoMeaningfulChanges` exactly like
 * `removedChapters`/per-chapter edits already did — a pure reorder
 * with no other edit is now, correctly, a meaningful change. Per-
 * chapter `entries` and `removedChapters` are computed EXACTLY as
 * before this remediation: a reorder is surfaced as its OWN signal,
 * never translated into a false `added`/`removed` chapter (mandate:
 * "Preserve bookmark identity for matching… do not convert a reorder
 * into false added/removed if bookmark identity remains valid").
 *
 * W1-02 — FRONT MATTER / PREAMBLE FIDELITY. The audit found that
 * `imported.leadingContent` (title/seller-name/preamble lines found
 * before the first recognized chapter bookmark) was surfaced for
 * display but never actually COMPARED against anything — a merchant
 * editing the document title in Word produced zero diff signal.
 * Fixed: `frontMatter` below diffs `currentModel.frontMatter` (lib/
 * legal/cgv-document-model.ts, already computed from the SAME trusted
 * `renderCgv()` output the rest of this module already uses) against
 * `imported.leadingContent`, with the exact same LCS + modified-
 * pairing pipeline already used for chapter bodies — no new
 * diffing logic, just applied to one more pair of ordered line lists.
 * `frontMatter`'s non-unchanged entries fold into
 * `hasNoMeaningfulChanges` exactly like a chapter's own entries do.
 * The OLD, undiffed `leadingContent: string[]` field is removed from
 * this result (nothing outside this module's own now-updated caller,
 * app/dashboard/legal-cgv/page.tsx, read it — see that file's own
 * diff for the matching UI update); `docx-reader.ts`'s
 * `DocxImportResult.leadingContent` is UNCHANGED, it is simply fed
 * into this new diff instead of being passed through unexamined.
 */

import type { CgvDocumentModel } from "@/lib/legal/cgv-document-model";
import { toOoxmlBookmarkName } from "@/lib/legal/cgv-document-model";
import type { DocxImportResult } from "@/lib/docx/docx-reader";

export type CgvDocxDiffErrorCode = "EMPTY_IMPORT" | "UNRECOGNIZED_BOOKMARK" | "DUPLICATE_BOOKMARK";

export class CgvDocxDiffError extends Error {
  readonly code: CgvDocxDiffErrorCode;
  constructor(code: CgvDocxDiffErrorCode, message: string) {
    super(message);
    this.name = "CgvDocxDiffError";
    this.code = code;
  }
}

export type CgvDocxDiffEntry =
  | { kind: "unchanged"; text: string }
  | { kind: "modified"; before: string; after: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string };

export interface CgvDocxDiffChapterResult {
  /** Internal slug identity (CgvDocumentChapter.bookmarkName), never
   *  the raw OOXML name -- for display/lookup by callers that already
   *  know the current model. */
  bookmarkName: string;
  /** Current model's heading text, for display purposes (the diff
   *  entries below already surface a heading-text EDIT as the first
   *  entry when one occurred). */
  heading: string;
  entries: CgvDocxDiffEntry[];
}

export interface CgvDocxDiffResult {
  /** Current-model chapters with no matching bookmark anywhere in the
   *  import -- see file header, "MATCHING / FAIL CLOSED". Whole-
   *  chapter granularity deliberately: a human reviewer scans this as
   *  one clear signal per removed chapter, not N removed paragraphs. */
  removedChapters: { bookmarkName: string; heading: string }[];
  /** One entry per chapter present in BOTH the current model and the
   *  import, in current-model document order. */
  chapters: CgvDocxDiffChapterResult[];
  /** W1 REMEDIATION (W1-01) -- true iff the MATCHED chapter subset
   *  (bookmarks present on both sides, i.e. excluding
   *  `removedChapters`) appears in a different sequence in the import
   *  than in the current model. Never set by a chapter's own
   *  presence/absence (that is `removedChapters`' job) or by its line
   *  content (that is `chapters[].entries`' job) -- a PURE reorder,
   *  with no other edit, sets this flag and nothing else. */
  orderChanged: boolean;
  /** W1 REMEDIATION (W1-01) -- the matched chapters' internal
   *  `bookmarkName`s (never the raw OOXML name), in the ORDER found in
   *  the import -- "preserve imported chapter sequence" (mandate),
   *  surfaced for display/review whenever `orderChanged` is true. */
  importedOrder: string[];
  /** W1 REMEDIATION (W1-02) -- diffed title/seller-name/preamble
   *  lines: `currentModel.frontMatter` vs. `imported.leadingContent`,
   *  via the exact same LCS + modified-pairing pipeline as a chapter
   *  body (see file header, "FRONT MATTER / PREAMBLE FIDELITY").
   *  Replaces the OLD, undiffed `leadingContent: string[]` field. */
  frontMatter: { entries: CgvDocxDiffEntry[] };
  /** True iff `removedChapters` is empty, `orderChanged` is false,
   *  `frontMatter.entries` are all "unchanged", AND every chapter's
   *  entries are all "unchanged" -- the mandate's "export -> import
   *  unchanged = zero meaningful diff" test. */
  hasNoMeaningfulChanges: boolean;
}

type RawLineOp = { kind: "unchanged" | "added" | "removed"; text: string };

/**
 * Classic LCS-based line diff over two ordered string lists, exact
 * string equality only (no fuzzy/whitespace-insensitive matching --
 * mandate §4 forbids silently normalizing away meaningful edits).
 * O(n*m) dynamic programming table; chapter-level paragraph counts
 * are always small (a CGV chapter has, at most, a few dozen lines),
 * so this is never a performance concern.
 */
function diffLines(before: string[], after: string[]): RawLineOp[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: RawLineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "unchanged", text: before[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "removed", text: before[i] });
      i += 1;
    } else {
      ops.push({ kind: "added", text: after[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "removed", text: before[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "added", text: after[j] });
    j += 1;
  }
  return ops;
}

/**
 * Pairs an adjacent equal-length removed-run immediately followed by
 * an added-run (or vice versa) into `modified` entries, element-wise
 * in order -- a readability pass only; it reclassifies existing
 * removed/added ops, it never changes which text is attributed to
 * which side, and any run-length mismatch is left as plain
 * added/removed for the excess.
 */
function pairAdjacentReplacements(ops: RawLineOp[]): CgvDocxDiffEntry[] {
  const result: CgvDocxDiffEntry[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === "unchanged") {
      result.push({ kind: "unchanged", text: op.text });
      k += 1;
      continue;
    }

    const runKind = op.kind;
    let runEnd = k;
    while (runEnd < ops.length && ops[runEnd].kind === runKind) runEnd += 1;
    const otherKind: "added" | "removed" = runKind === "removed" ? "added" : "removed";
    let otherEnd = runEnd;
    while (otherEnd < ops.length && ops[otherEnd].kind === otherKind) otherEnd += 1;

    const runLen = runEnd - k;
    const otherLen = otherEnd - runEnd;
    const pairedLen = Math.min(runLen, otherLen);
    for (let p = 0; p < pairedLen; p++) {
      const removedText = runKind === "removed" ? ops[k + p].text : ops[runEnd + p].text;
      const addedText = runKind === "removed" ? ops[runEnd + p].text : ops[k + p].text;
      result.push({ kind: "modified", before: removedText, after: addedText });
    }
    for (let p = pairedLen; p < runLen; p++) {
      result.push({ kind: runKind, text: ops[k + p].text });
    }
    for (let p = pairedLen; p < otherLen; p++) {
      result.push({ kind: otherKind, text: ops[runEnd + p].text });
    }
    k = otherEnd;
  }
  return result;
}

function hasOnlyUnchanged(entries: CgvDocxDiffEntry[]): boolean {
  return entries.every((e) => e.kind === "unchanged");
}

/**
 * W1 REMEDIATION (W1-01) -- true iff the matched-subset order differs
 * between the current model and the import. Both arrays are already
 * restricted, by the caller, to bookmarks present on BOTH sides (a
 * chapter absent from the import is `removedChapters`' concern, never
 * this function's) -- so both arrays always have the same length and
 * the same SET of entries; only their ORDER can differ.
 */
function computeOrderChanged(currentOrder: string[], importedOrder: string[]): boolean {
  if (currentOrder.length !== importedOrder.length) return true; // defensive; should not happen (see caller)
  return currentOrder.some((name, i) => name !== importedOrder[i]);
}

/**
 * Builds the structured diff. Throws `CgvDocxDiffError` (never
 * returns a partial result) when the import cannot be mapped safely
 * -- see file header, "MATCHING / FAIL CLOSED".
 */
export function diffCgvDocxImport(currentModel: CgvDocumentModel, imported: DocxImportResult): CgvDocxDiffResult {
  if (imported.chapters.length === 0) {
    throw new CgvDocxDiffError(
      "EMPTY_IMPORT",
      "Le document importé ne contient aucun chapitre reconnu -- échec fermé, aucune supposition."
    );
  }

  const seenRawNames = new Set<string>();
  for (const chapter of imported.chapters) {
    if (seenRawNames.has(chapter.bookmarkName)) {
      throw new CgvDocxDiffError(
        "DUPLICATE_BOOKMARK",
        `Le repère « ${chapter.bookmarkName} » apparaît plusieurs fois dans le document importé -- mapping ambigu, document rejeté en entier (jamais « le premier » ou « le dernier » gagne).`
      );
    }
    seenRawNames.add(chapter.bookmarkName);
  }

  const rawNameToModelChapter = new Map(currentModel.chapters.map((c) => [toOoxmlBookmarkName(c.bookmarkName), c]));
  for (const chapter of imported.chapters) {
    if (!rawNameToModelChapter.has(chapter.bookmarkName)) {
      throw new CgvDocxDiffError(
        "UNRECOGNIZED_BOOKMARK",
        `Le repère « ${chapter.bookmarkName} » du document importé ne correspond à aucun chapitre CGV actuel -- impossible de mapper ce document en toute sécurité (échec fermé, aucune supposition).`
      );
    }
  }

  const importedByRawName = new Map(imported.chapters.map((c) => [c.bookmarkName, c]));

  const removedChapters: { bookmarkName: string; heading: string }[] = [];
  const chapters: CgvDocxDiffChapterResult[] = [];
  // W1-01 -- matched-subset order, current-model side (internal
  // bookmarkName, document order as the CURRENT model has it).
  const currentMatchedOrder: string[] = [];

  for (const modelChapter of currentModel.chapters) {
    const rawName = toOoxmlBookmarkName(modelChapter.bookmarkName);
    const importedChapter = importedByRawName.get(rawName);
    if (!importedChapter) {
      removedChapters.push({ bookmarkName: modelChapter.bookmarkName, heading: modelChapter.heading });
      continue;
    }
    currentMatchedOrder.push(modelChapter.bookmarkName);

    // Same blank-paragraph normalization as docx-reader.ts applies to
    // the IMPORTED side (file header there, "BLANK PARAGRAPH
    // NORMALIZATION") -- applied here to the CURRENT side too, so an
    // exact, unedited round trip can never show a spurious "removed"
    // entry purely because `renderCgv()` happened to emit an empty
    // `<p></p>` for some unset optional field (e.g. no merchant policy
    // text and no template fallback). Without this, the two sides of
    // an otherwise byte-identical round trip would be normalized
    // asymmetrically -- blanks dropped on import, kept on the current
    // model -- which is exactly the kind of noise mandate §4 asks this
    // diff to avoid.
    const before = [modelChapter.heading, ...modelChapter.paragraphs.filter((line) => line.trim().length > 0)];
    const after = importedChapter.paragraphs;
    const entries = pairAdjacentReplacements(diffLines(before, after));
    chapters.push({ bookmarkName: modelChapter.bookmarkName, heading: modelChapter.heading, entries });
  }

  // W1-01 -- matched-subset order, IMPORT side, mapped back to
  // internal bookmarkName via the already-built rawName -> model
  // chapter lookup (every imported chapter is guaranteed matched at
  // this point -- UNRECOGNIZED_BOOKMARK would already have thrown
  // above otherwise), in the ORDER `docx-reader.ts` found them (i.e.
  // "preserve imported chapter sequence", mandate).
  const importedOrder = imported.chapters.map((c) => rawNameToModelChapter.get(c.bookmarkName)!.bookmarkName);
  const orderChanged = computeOrderChanged(currentMatchedOrder, importedOrder);

  // W1-02 -- front matter (title/seller/preamble) diff, same
  // LCS + modified-pairing pipeline as any chapter body.
  const frontMatterEntries = pairAdjacentReplacements(diffLines(currentModel.frontMatter, imported.leadingContent));

  const hasNoMeaningfulChanges =
    removedChapters.length === 0 &&
    !orderChanged &&
    hasOnlyUnchanged(frontMatterEntries) &&
    chapters.every((c) => hasOnlyUnchanged(c.entries));

  return {
    removedChapters,
    chapters,
    orderChanged,
    importedOrder,
    frontMatter: { entries: frontMatterEntries },
    hasNoMeaningfulChanges,
  };
}
