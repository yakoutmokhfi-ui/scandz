import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  if (
    !expected ||
    !header.startsWith("Bearer ") ||
    !timingSafeEqual(
      createHash("sha256").update(expected).digest(),
      createHash("sha256").update(header.slice(7)).digest(),
    )
  ) {
    return NextResponse.json(
      { ok: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  // Keep this authenticated legacy endpoint inert, including old scheduled deployments.
  return NextResponse.json({ status: "manual_only" }, { headers: { "Cache-Control": "no-store" } });
}
