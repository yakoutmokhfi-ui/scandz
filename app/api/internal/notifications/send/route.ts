import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isMerchantSmtpEncryptionConfigured } from "@/lib/server/merchant-email-provider";
import { isRealEmailSendActivated } from "@/lib/server/notifications/real-email-activation-gate";
import { resolveMerchantSmtpProvider } from "@/lib/server/notifications/merchant-smtp-provider";
import { reapStaleNotificationClaims } from "@/lib/server/notifications/notification-outbox-service";
import { createRunBudget } from "@/lib/server/notifications/run-budget";
import { runTransactionalEmailWorker } from "@/lib/server/notifications/notification-worker";
import {
  WORKER_BATCH_SIZE,
  WORKER_LEASE_SECONDS,
  WORKER_RUN_BUDGET_MS,
} from "@/lib/server/notifications/merchant-smtp-worker-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Doit rester égal à WORKER_MAX_DURATION_SECONDS (vérifié par tests/merchant-smtp-cron-route.test.ts) :
// un littéral est exigé par Next pour les options de segment de route.
export const maxDuration = 300;

const BEARER_PREFIX = "Bearer ";

/** Schéma `Authorization: Bearer <CRON_SECRET>` STRICT (convention Vercel Cron), comparaison à temps constant. */
function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  if (!expected || !header.startsWith(BEARER_PREFIX)) return false;
  const supplied = header.slice(BEARER_PREFIX.length);
  if (!supplied) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(supplied));
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok: false }, { status: 401 });
  // The route can be deployed safely while the global production gate is off.
  // It does not reap or claim rows until both gates are available.
  if (!isRealEmailSendActivated() || !isMerchantSmtpEncryptionConfigured()) {
    return NextResponse.json({ ok: true, status: "disabled" });
  }
  try {
    const startedAt = Date.now();
    // R3 : le budget se mesure sur l'horloge MONOTONE, créée avant le reap comme `startedAt`. `deadlineAt` (date murale)
    // reste un garde-fou supplémentaire, mais ne suffit pas seul : si l'horloge système recule, il ne se déclencherait pas.
    const budget = createRunBudget(WORKER_RUN_BUDGET_MS);
    const reaped = await reapStaleNotificationClaims({ batchSize: 100 });
    const result = await runTransactionalEmailWorker(null, {
      batchSize: WORKER_BATCH_SIZE,
      leaseSeconds: WORKER_LEASE_SECONDS,
      deadlineAt: startedAt + WORKER_RUN_BUDGET_MS,
      budget,
      providerForNotification: (notification) => resolveMerchantSmtpProvider(notification.restaurantId),
    });
    const deferred = result.status === "processed"
      ? Math.max(0, result.claimed - result.sent - result.retriedRetryable - result.failedTerminal)
      : 0;
    return NextResponse.json({ ok: true, reaped, result, deferred });
  } catch {
    return NextResponse.json({ ok: false, status: "worker_failed" }, { status: 503 });
  }
}
