import "server-only";
import { randomBytes } from "node:crypto";
import {
  issueSimulatorDecisionToken,
  consumeSimulatorDecisionToken,
  type ConsumeSimulatorDecisionTokenResult,
} from "@/lib/server/payment-providers/monetico/simulator/authority";

/**
 * MONETICO PAYMENT SIMULATOR v1.2 — SERVER-AUTHORITATIVE SINGLE-USE
 * DECISION TOKEN (MSIM-AUTH-03, replaces the v1.1 process-local registry).
 *
 * The token is an opaque 128-bit random nonce. EVERYTHING else lives in
 * the dedicated test database (`simulator_decision_tokens`, created by
 * DRAFT-lot-monetico-simulator-test-authority-v1.sql):
 *   - BINDING   : merchant, order, payment attempt (transaction id),
 *                 provider reference, both return URLs -- written by the
 *                 `issue_…` RPC from the attempt row itself, never from
 *                 the browser;
 *   - EXPIRY    : `expires_at`, enforced by the `consume_…` RPC with the
 *                 database clock;
 *   - SINGLE USE: `consume_…` locks the row (`for update`) and performs a
 *                 conditional UPDATE -- exactly ONE caller succeeds under
 *                 concurrency, across instances and across restarts.
 * Issuance requires the attempt to be `pending` (SQL-enforced).
 *
 * Callback idempotency (P3-B5 fingerprint dedup) is untouched and remains
 * an independent layer.
 */

export const DECISION_TOKEN_TTL_SECONDS = 10 * 60;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export interface IssueDecisionTokenInput {
  providerReference: string;
  urlRetourOk: string;
  urlRetourErr: string;
}

export interface IssuedDecisionToken {
  token: string;
  transactionId: string;
  orderId: string;
  restaurantId: string;
}

export async function issueDecisionToken(input: IssueDecisionTokenInput): Promise<IssuedDecisionToken> {
  const nonce = randomBytes(16).toString("hex");
  const issued = await issueSimulatorDecisionToken({
    nonce,
    providerCode: "monetico",
    providerReference: input.providerReference,
    urlRetourOk: input.urlRetourOk,
    urlRetourErr: input.urlRetourErr,
    ttlSeconds: DECISION_TOKEN_TTL_SECONDS,
  });
  return { token: issued.nonce, transactionId: issued.transactionId, orderId: issued.orderId, restaurantId: issued.restaurantId };
}

export interface ConsumeDecisionTokenInput {
  token: unknown;
  expected: { reference: string; urlRetourOk: string; urlRetourErr: string };
}

export type ConsumeDecisionTokenResult =
  | { ok: true; transactionId: string; orderId: string; restaurantId: string }
  | { ok: false; reason: "token_malformed" | Exclude<ConsumeSimulatorDecisionTokenResult, { ok: true }>["reason"] };

/** Verifies and CONSUMES a token atomically in the test database. */
export async function consumeDecisionToken(input: ConsumeDecisionTokenInput): Promise<ConsumeDecisionTokenResult> {
  if (typeof input.token !== "string" || !NONCE_PATTERN.test(input.token)) return { ok: false, reason: "token_malformed" };
  const result = await consumeSimulatorDecisionToken({
    nonce: input.token,
    providerReference: input.expected.reference,
    urlRetourOk: input.expected.urlRetourOk,
    urlRetourErr: input.expected.urlRetourErr,
  });
  return result;
}

/** `true` only if `url` parses and its origin is EXACTLY `canonicalOrigin`. */
export function isSameCanonicalOrigin(url: string, canonicalOrigin: string): boolean {
  try {
    return new URL(url).origin === canonicalOrigin;
  } catch {
    return false;
  }
}
