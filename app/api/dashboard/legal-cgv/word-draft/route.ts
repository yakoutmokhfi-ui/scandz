import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { cgvWordDraft, WordDraftServiceError } from "@/lib/server/legal-cgv-word-draft-service";
export const runtime = "nodejs";
const MAX_FILE = 2 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function handle(request: NextRequest, save: boolean) {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return NextResponse.json({ outcome: "auth" }, { status: 401 });
  const restaurantId = request.nextUrl.searchParams.get("restaurantId") ?? "";
  if (!uuid.test(restaurantId)) return NextResponse.json({ outcome: "invalid_field" }, { status: 400 });
  try {
    let bytes: ArrayBuffer | undefined;
    if (save) {
      // Raw DOCX stream, bounded even when Content-Length is absent or forged.
      const reader = request.body?.getReader();
      if (!reader) return NextResponse.json({ outcome: "invalid_document" }, { status: 400 });
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > MAX_FILE) { await reader.cancel(); return NextResponse.json({ outcome: "too_large" }, { status: 413 }); }
        chunks.push(value);
      }
      const buffer = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      bytes = buffer.buffer;
    }
    const draft = await cgvWordDraft(token, restaurantId, bytes, request.headers.get("x-cgv-review-hash") ?? undefined);
    return NextResponse.json({ outcome: "ok", draft }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const outcome = e instanceof WordDraftServiceError ? e.outcome : "unavailable";
    return NextResponse.json({ outcome }, { status: outcome === "auth" ? 401 : outcome === "forbidden" ? 403 : outcome === "stale_context" ? 409 : outcome === "invalid_document" ? 422 : 502 });
  }
}
export async function GET(request: NextRequest) { return handle(request, false); }
export async function POST(request: NextRequest) { return handle(request, true); }
