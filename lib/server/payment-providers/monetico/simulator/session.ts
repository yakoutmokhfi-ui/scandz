import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SIMULATOR_SECRET_ENV } from "@/lib/server/payment-providers/monetico/simulator/policy";

/**
 * MONETICO PAYMENT SIMULATOR v1 — STATELESS HOSTED-PAGE BINDING.
 *
 * The real Monetico page remembers the merchant's `url_retour_ok`/`err`
 * between the form POST and the end of the customer interaction. The
 * simulator is stateless: it carries them as hidden fields of the
 * scenario form, protected by an HMAC-SHA256 "binding" computed with
 * the operator secret over (reference, url_retour_ok, url_retour_err).
 * The decide route re-verifies the binding before redirecting, so a
 * browser cannot swap the return URLs (open-redirect) nor the
 * reference the decision applies to.
 *
 * Both routes ALSO require every return URL to belong to the canonical
 * public origin (`assertSameOrigin`) -- defense in depth, independent of
 * the binding.
 *
 * Nothing financial depends on these fields: amount/currency are ALWAYS
 * re-read server-side from the correlation RPC at decision time.
 */

export interface HostedPageBinding {
  reference: string;
  urlRetourOk: string;
  urlRetourErr: string;
}

function canonical(b: HostedPageBinding): string {
  return [b.reference, b.urlRetourOk, b.urlRetourErr].map((v) => encodeURIComponent(v)).join("&");
}

export function createHostedPageBinding(
  binding: HostedPageBinding,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const secret = env[SIMULATOR_SECRET_ENV];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("MONETICO_SIMULATOR_SECRET_MISSING");
  }
  return createHmac("sha256", secret).update(canonical(binding), "utf8").digest("hex");
}

export function verifyHostedPageBinding(
  binding: HostedPageBinding,
  provided: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  if (typeof provided !== "string" || !/^[0-9a-f]{64}$/.test(provided)) return false;
  let expected: string;
  try {
    expected = createHostedPageBinding(binding, env);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}

/** `true` only if `url` parses and its origin is EXACTLY `canonicalOrigin`. */
export function isSameCanonicalOrigin(url: string, canonicalOrigin: string): boolean {
  try {
    return new URL(url).origin === canonicalOrigin;
  } catch {
    return false;
  }
}
