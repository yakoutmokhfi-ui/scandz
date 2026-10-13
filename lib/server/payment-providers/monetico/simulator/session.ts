import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SIMULATOR_SECRET_ENV } from "@/lib/server/payment-providers/monetico/simulator/policy";

/**
 * MONETICO PAYMENT SIMULATOR v1.1 — SINGLE-USE DECISION TOKEN
 * (MSIM-AUTH-03, replaces the v1 stateless binding).
 *
 * A decision (which scenario to apply to which attempt) is authorized
 * by a token that is:
 *   - ORDER-BOUND : carries the provider reference AND the payment
 *                   transaction id it was issued for, plus both return
 *                   URLs; the decide route re-derives the attempt from
 *                   the reference and refuses any divergence;
 *   - SHORT-LIVED : `exp` = issue time + DECISION_TOKEN_TTL_SECONDS;
 *   - SINGLE-USE  : carries a 128-bit random nonce; `consumeDecisionToken`
 *                   marks the nonce used (bounded in-process registry
 *                   keyed by nonce, pruned on expiry) -- a replay of the
 *                   same POST is refused with `token_already_used`;
 *   - AUTHENTICATED: HMAC-SHA256 over the canonical payload with the
 *                   operator secret, compared in constant time.
 *
 * Replay resistance is LAYERED (defense in depth, documented limits):
 *   1. nonce registry -- authoritative within one server instance;
 *   2. TTL -- bounds any cross-instance replay window to a few minutes;
 *   3. ATTEMPT STATE -- the decide route additionally refuses any
 *      decision whose attempt is no longer `pending` (terminal lock-in
 *      makes a replayed `paid`/`refused` decision meaningless);
 *   4. CALLBACK IDEMPOTENCY (unchanged, P3-B5 fingerprint dedup) remains
 *      the application's own, independent protection.
 *
 * Nothing financial depends on the token: amount/currency are ALWAYS
 * re-read server-side at decision time.
 */

export const DECISION_TOKEN_TTL_SECONDS = 10 * 60;
const NONCE_REGISTRY_MAX = 10_000;

export interface DecisionTokenPayload {
  reference: string;
  transactionId: string;
  urlRetourOk: string;
  urlRetourErr: string;
  nonce: string;
  iat: number;
  exp: number;
}

export type DecisionTokenRejection =
  | "token_malformed"
  | "token_signature_invalid"
  | "token_expired"
  | "token_already_used"
  | "token_binding_mismatch";

type Registry = Map<string, number>;
const usedNonces: Registry = new Map();

function secretFrom(env: Readonly<Record<string, string | undefined>>): string {
  const secret = env[SIMULATOR_SECRET_ENV];
  if (typeof secret !== "string" || secret.length === 0) throw new Error("MONETICO_SIMULATOR_SECRET_MISSING");
  return secret;
}

function canonical(p: DecisionTokenPayload): string {
  return [p.reference, p.transactionId, p.urlRetourOk, p.urlRetourErr, p.nonce, String(p.iat), String(p.exp)]
    .map((v) => encodeURIComponent(v))
    .join("&");
}

function sign(canonicalPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(canonicalPayload, "utf8").digest("hex");
}

function pruneRegistry(registry: Registry, nowSeconds: number): void {
  for (const [nonce, exp] of registry) if (exp <= nowSeconds) registry.delete(nonce);
  if (registry.size > NONCE_REGISTRY_MAX) {
    // Bounded memory: drop the oldest entries (insertion order). An
    // evicted-but-unexpired nonce falls back to layers 2-4.
    const excess = registry.size - NONCE_REGISTRY_MAX;
    let i = 0;
    for (const nonce of registry.keys()) {
      if (i++ >= excess) break;
      registry.delete(nonce);
    }
  }
}

export interface IssueDecisionTokenInput {
  reference: string;
  transactionId: string;
  urlRetourOk: string;
  urlRetourErr: string;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}

export function issueDecisionToken(input: IssueDecisionTokenInput): string {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload: DecisionTokenPayload = {
    reference: input.reference,
    transactionId: input.transactionId,
    urlRetourOk: input.urlRetourOk,
    urlRetourErr: input.urlRetourErr,
    nonce: randomBytes(16).toString("hex"),
    iat: nowSeconds,
    exp: nowSeconds + DECISION_TOKEN_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(canonical(payload), secretFrom(input.env ?? process.env))}`;
}

export interface ConsumeDecisionTokenInput {
  token: unknown;
  /** Values the caller received alongside the token -- MUST match the
   *  token's own binding (prevents mixing a token with other fields). */
  expected: { reference: string; urlRetourOk: string; urlRetourErr: string };
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable for tests (defaults to the process-wide registry). */
  registry?: Registry;
}

export type ConsumeDecisionTokenResult =
  | { ok: true; payload: DecisionTokenPayload }
  | { ok: false; reason: DecisionTokenRejection };

/** Verifies and CONSUMES a token: on success the nonce can never be used again. */
export function consumeDecisionToken(input: ConsumeDecisionTokenInput): ConsumeDecisionTokenResult {
  const registry = input.registry ?? usedNonces;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  pruneRegistry(registry, nowSeconds);

  if (typeof input.token !== "string") return { ok: false, reason: "token_malformed" };
  const parts = input.token.split(".");
  if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[1])) return { ok: false, reason: "token_malformed" };

  let payload: DecisionTokenPayload;
  try {
    const raw = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    const str = (k: string) => (typeof raw[k] === "string" && (raw[k] as string).length > 0 ? (raw[k] as string) : null);
    const num = (k: string) => (Number.isInteger(raw[k]) ? (raw[k] as number) : null);
    const reference = str("reference"), transactionId = str("transactionId"), urlRetourOk = str("urlRetourOk"), urlRetourErr = str("urlRetourErr"), nonce = str("nonce");
    const iat = num("iat"), exp = num("exp");
    if (!reference || !transactionId || !urlRetourOk || !urlRetourErr || !nonce || iat === null || exp === null || !/^[0-9a-f]{32}$/.test(nonce)) {
      return { ok: false, reason: "token_malformed" };
    }
    payload = { reference, transactionId, urlRetourOk, urlRetourErr, nonce, iat, exp };
  } catch {
    return { ok: false, reason: "token_malformed" };
  }

  let expected: string;
  try {
    expected = sign(canonical(payload), secretFrom(input.env ?? process.env));
  } catch {
    return { ok: false, reason: "token_signature_invalid" };
  }
  if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(parts[1], "utf8"))) {
    return { ok: false, reason: "token_signature_invalid" };
  }
  if (payload.exp <= nowSeconds || payload.exp - payload.iat > DECISION_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: "token_expired" };
  }
  if (
    payload.reference !== input.expected.reference ||
    payload.urlRetourOk !== input.expected.urlRetourOk ||
    payload.urlRetourErr !== input.expected.urlRetourErr
  ) {
    return { ok: false, reason: "token_binding_mismatch" };
  }
  if (registry.has(payload.nonce)) return { ok: false, reason: "token_already_used" };
  registry.set(payload.nonce, payload.exp);
  return { ok: true, payload };
}

/** Test-only helper: a fresh, isolated nonce registry. */
export function createDecisionTokenRegistry(): Registry {
  return new Map();
}

/** `true` only if `url` parses and its origin is EXACTLY `canonicalOrigin`. */
export function isSameCanonicalOrigin(url: string, canonicalOrigin: string): boolean {
  try {
    return new URL(url).origin === canonicalOrigin;
  } catch {
    return false;
  }
}
