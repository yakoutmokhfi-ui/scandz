import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  handleSimulatorDecision,
  evaluateSimulatorEnvironment,
  extractSimulatorBearer,
} from "@/lib/server/payment-simulator-runtime";

/**
 * MONETICO PAYMENT SIMULATOR v1 — OPERATOR DECISION ROUTE.
 *
 * POST only. Body = `application/x-www-form-urlencoded` (the hosted
 * page form) or JSON (automated drivers). Scenario and secret are read
 * EXCLUSIVELY from the body / Authorization header -- the query string
 * is never read (CTO decision Q3). Gate closed -> 404.
 *
 * Browser callers receive a 303 to the merchant return URL (as Monetico
 * does). Callers sending `accept: application/json` receive the
 * notification report instead (for automated drivers/tests).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parseBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const json = (await request.json()) as unknown;
      return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    }
    const formData = await request.formData();
    const fields: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    return fields;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!evaluateSimulatorEnvironment().active) return new NextResponse(null, { status: 404 });
  const body = await parseBody(request);
  if (body === null) return NextResponse.json({ outcome: "invalid_request" }, { status: 400 });

  const result = await handleSimulatorDecision({
    body,
    bearer: extractSimulatorBearer(request.headers.get("authorization")),
  });

  switch (result.kind) {
    case "gate_closed":
      return new NextResponse(null, { status: 404 });
    case "unauthorized":
      return NextResponse.json({ outcome: "unauthorized" }, { status: 401 });
    case "invalid":
      return NextResponse.json({ outcome: "invalid_request", reason: result.reason }, { status: 400 });
    case "redirect": {
      const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
      if (wantsJson) {
        return NextResponse.json({
          outcome: "applied",
          scenario: result.scenario.id,
          redirect: result.location,
          notifications: result.notifications,
        });
      }
      return NextResponse.redirect(result.location, 303);
    }
  }
}
