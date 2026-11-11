import { getSession } from "@/lib/services/auth";
export interface CgvWordDraftView { id: string; html: string | null; stale: boolean; published: boolean }
export async function getCgvWordDraft(restaurantId: string, file?: File, reviewBaseline?: string): Promise<CgvWordDraftView | null> {
  const session = await getSession();
  if (!session?.access_token) throw new Error("auth");
  let reviewHash: string | undefined;
  if (file) {
    if (!reviewBaseline) throw new Error("stale_context");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reviewBaseline));
    reviewHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }
  const response = await fetch(`/api/dashboard/legal-cgv/word-draft?restaurantId=${encodeURIComponent(restaurantId)}`, {
    method: file ? "POST" : "GET", headers: { Authorization: `Bearer ${session.access_token}`, ...(reviewHash ? { "X-Cgv-Review-Hash": reviewHash } : {}) },
    ...(file ? { body: file } : {}), cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok || body.outcome !== "ok") throw new Error(body.outcome ?? "unavailable");
  return body.draft;
}
