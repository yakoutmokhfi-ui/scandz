import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  handleSimulatorHostedPage,
  resolveSimulatorGate,
  verifySimulatorOperatorBearer,
  listSimulatorScenarios,
  renderSimulatorRejectionPage,
} from "@/lib/server/payment-simulator-runtime";

/**
 * MONETICO PAYMENT SIMULATOR v1 — SIMULATED HOSTED PAYMENT PAGE ROUTE.
 *
 * POST: receives the merchant payment form auto-posted by the browser
 * (exactly what the real sandbox endpoint would
 * receive). Thin adapter: form parsing + status mapping only.
 * GET : authenticated scenario catalog (operator Bearer) -- the
 * "protected internal test/demo interface" of the mandate.
 *
 * GATE CLOSED (production, not enabled, no secret) -> 404 for BOTH
 * verbs, with no body that could reveal the facility exists.
 * `node:crypto` required transitively -- never Edge.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => new NextResponse(null, { status: 404 });

async function parseForm(request: NextRequest): Promise<Record<string, string> | null> {
  try {
    const formData = await request.formData();
    const fields: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    return fields;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  if (!(await resolveSimulatorGate()).verdict.active) return NOT_FOUND();
  if (!verifySimulatorOperatorBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ outcome: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    outcome: "ok",
    scenarios: listSimulatorScenarios().map((s) => ({ id: s.id, label: s.label, description: s.description, expected: s.expected })),
  });
}

export async function POST(request: NextRequest) {
  if (!(await resolveSimulatorGate()).verdict.active) return NOT_FOUND();
  const raw = await parseForm(request);
  if (raw === null) return new NextResponse(renderSimulatorRejectionPage("malformed"), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });

  const result = await handleSimulatorHostedPage(raw);
  switch (result.kind) {
    case "gate_closed":
      return NOT_FOUND();
    case "rejected":
      return new NextResponse(renderSimulatorRejectionPage(result.reason), {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    case "page":
      return new NextResponse(result.html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
  }
}
