import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isMerchantSmtpEncryptionConfigured } from "@/lib/server/merchant-email-provider";
import { isRealEmailSendActivated } from "@/lib/server/notifications/real-email-activation-gate";
import { resolveMerchantSmtpProvider } from "@/lib/server/notifications/merchant-smtp-provider";
import { reapStaleNotificationClaims } from "@/lib/server/notifications/notification-outbox-service";
import { runTransactionalEmailWorker } from "@/lib/server/notifications/notification-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok: false }, { status: 401 });
  // The route can be deployed safely while the global production gate is off.
  // It does not reap or claim rows until both gates are available.
  if (!isRealEmailSendActivated() || !isMerchantSmtpEncryptionConfigured()) {
    return NextResponse.json({ ok: true, status: "disabled" });
  }
  try {
    const reaped = await reapStaleNotificationClaims({ batchSize: 100 });
    const result = await runTransactionalEmailWorker(null, {
      batchSize: 25,
      leaseSeconds: 180,
      providerForNotification: (notification) => resolveMerchantSmtpProvider(notification.restaurantId),
    });
    return NextResponse.json({ ok: true, reaped, result });
  } catch {
    return NextResponse.json({ ok: false, status: "worker_failed" }, { status: 503 });
  }
}
