import "server-only";
import { timingSafeEqual } from "node:crypto";
import { SIMULATOR_SECRET_ENV, SIMULATOR_SECRET_MIN_LENGTH } from "@/lib/server/payment-providers/monetico/simulator/policy";

/**
 * MONETICO PAYMENT SIMULATOR v1 — OPERATOR AUTHENTICATION.
 *
 * Scenario selection is an OPERATOR act: it decides whether a (test)
 * order becomes `paid`. It is therefore authenticated with a dedicated
 * operator secret (`PAYMENT_MONETICO_SIMULATOR_SECRET`), which is:
 *   - NEVER the Monetico security key, NEVER `CRON_SECRET`, NEVER the
 *     Supabase service-role key (separation of secrets, same posture as
 *     the recovery worker's CRON-AUTH-SEPARATION);
 *   - compared in constant time;
 *   - accepted ONLY from an `Authorization: Bearer` header or from a POST
 *     body field -- NEVER from a query string (CTO decision Q3: "reject
 *     unauthenticated scenario selection, including scenario overrides in
 *     query parameters" -- and no secret in any URL).
 */

export function verifySimulatorOperatorSecret(
  provided: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const expected = env[SIMULATOR_SECRET_ENV];
  if (typeof expected !== "string" || expected.length < SIMULATOR_SECRET_MIN_LENGTH) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extracts a Bearer token from an Authorization header value, or null. */
export function extractBearer(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(\S+)$/.exec(headerValue.trim());
  return match ? match[1] : null;
}
