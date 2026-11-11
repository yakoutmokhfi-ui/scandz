import "server-only";
import { createHash } from "node:crypto";
import { asUserSupabaseClientFactory } from "@/lib/server/supabase-as-user";
import { readDocxDocument } from "@/lib/docx/docx-reader";
import { renderCgvWordDraft } from "@/lib/legal/cgv-word-draft";
import { renderPublicationContext, type PublicationContextRow } from "@/lib/server/legal-cgv-publish-service";

export class WordDraftServiceError extends Error {
  outcome: "auth" | "forbidden" | "stale_context" | "invalid_document" | "unavailable";
  constructor(outcome: WordDraftServiceError["outcome"]) { super(outcome); this.outcome = outcome; }
}
function rpcError(error: { code?: string; message?: string }) {
  throw new WordDraftServiceError(error.code === "28000" ? "auth" : error.code === "42501" ? "forbidden" : error.message?.includes("STALE_CONTEXT") ? "stale_context" : "unavailable");
}
export async function cgvWordDraft(accessToken: string, restaurantId: string, bytes?: ArrayBuffer, reviewHash?: string) {
  const client = asUserSupabaseClientFactory.create(accessToken);
  // Read authorization/draft existence independently from publication readiness.
  // An incomplete legal profile must remain editable, even with a saved Word.
  let existing: { id: string; restaurant_id: string; base_fingerprint: string; document: unknown; published_hash?: string } | null = null;
  if (bytes === undefined) {
    const result = await client.rpc("get_merchant_cgv_word_draft", { p_restaurant_id: restaurantId, p_draft_id: null });
    if (result.error) rpcError(result.error);
    existing = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!existing) return null;
    if (existing.restaurant_id !== restaurantId || !existing.id) throw new WordDraftServiceError("unavailable");
  }
  const stale = () => ({ id: existing!.id, html: null, stale: true, published: false });
  const context = await client.rpc("resolve_cgv_publication_context", { p_restaurant_id: restaurantId });
  if (context.error) {
    if (existing && context.error.code === "P0001" && context.error.message?.includes("CGV_INCOMPLETE")) return stale();
    rpcError(context.error);
  }
  const ctx = (Array.isArray(context.data) ? context.data[0] : context.data) as PublicationContextRow | undefined;
  if (!ctx) throw new WordDraftServiceError("unavailable");
  let baseline: string;
  try { baseline = renderPublicationContext(ctx); } catch { if (existing) return stale(); throw new WordDraftServiceError("unavailable"); }
  if (bytes !== undefined) {
    if (reviewHash !== createHash("sha256").update(baseline).digest("hex")) throw new WordDraftServiceError("stale_context");
    let document, html;
    try { document = readDocxDocument(bytes); html = renderCgvWordDraft(baseline, document); }
    catch { throw new WordDraftServiceError("invalid_document"); }
    const saved = await client.rpc("save_merchant_cgv_word_draft", {
      p_restaurant_id: restaurantId, p_expected_fingerprint: ctx.context_fingerprint, p_document: document,
    });
    if (saved.error) rpcError(saved.error);
    const row = Array.isArray(saved.data) ? saved.data[0] : saved.data;
    if (!row || row.restaurant_id !== restaurantId || !row.id) throw new WordDraftServiceError("unavailable");
    return { id: row.id as string, html, stale: false, published: false };
  }
  const row = existing!;
  if (row.base_fingerprint !== ctx.context_fingerprint) return { id: row.id as string, html: null, stale: true, published: false };
  try { const html = renderCgvWordDraft(baseline, row.document); return { id: row.id as string, html, stale: false, published: createHash("md5").update(html).digest("hex") === row.published_hash }; }
  catch { throw new WordDraftServiceError("invalid_document"); }
}
