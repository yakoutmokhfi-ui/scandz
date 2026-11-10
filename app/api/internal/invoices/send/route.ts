import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  invoicePdfEnabled,
  runInvoiceWorker,
} from "@/lib/server/invoices/service";
import { isRealEmailSendActivated } from "@/lib/server/notifications/real-email-activation-gate";
import { isMerchantSmtpEncryptionConfigured } from "@/lib/server/merchant-email-provider";
import { createRunBudget } from "@/lib/server/notifications/run-budget";
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
  if (
    !invoicePdfEnabled() ||
    !isRealEmailSendActivated() ||
    !isMerchantSmtpEncryptionConfigured()
  )
    return NextResponse.json({ status: "disabled" });
  try {
    return NextResponse.json(await runInvoiceWorker(createRunBudget(130000)));
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
