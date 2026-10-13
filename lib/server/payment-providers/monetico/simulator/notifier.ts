import "server-only";
import { APPLICATION_CALLBACK_PATH } from "@/lib/server/payment-providers/monetico/simulator/policy";

/**
 * MONETICO PAYMENT SIMULATOR v1 — SERVER-TO-SERVER NOTIFIER.
 *
 * Plays the role of Monetico's notifier: POSTs the signed callback
 * fields (`application/x-www-form-urlencoded`) to the application's OWN
 * callback route, derived from the canonical public origin -- NEVER a
 * request header, NEVER any external host. A structural test asserts
 * this module contains no provider hostname and only ever targets
 * `APPLICATION_CALLBACK_PATH`.
 *
 * RETRY POLICY (bounded, deterministic):
 *   - transport error / non-200 / unreadable body  -> retry, up to
 *     `maxAttempts` (default 3);
 *   - HTTP 200 with ACK "version=2\ncdr=0"          -> delivered, stop;
 *   - HTTP 200 with ACK "version=2\ncdr=1"          -> explicit negative
 *     acknowledgement (the application refused the message, e.g. invalid
 *     MAC) -> stop WITHOUT retrying (replaying a message the application
 *     authenticated and rejected cannot change the outcome);
 *   - `simulatedTransportFailures` leading attempts are counted as
 *     timeouts WITHOUT any HTTP call (deterministic scenario modifier).
 * Never throws; the result reports exactly what happened.
 *
 * `fetchImpl`/`delay` are injectable for tests (no real sleeping).
 */

export const SUCCESS_ACK_PREFIX = "version=2\ncdr=0";
export const FAILURE_ACK_PREFIX = "version=2\ncdr=1";
export const DEFAULT_MAX_ATTEMPTS = 3;

export type NotificationAttemptOutcome =
  | "simulated_timeout"
  | "transport_error"
  | `http_${number}`
  | "ack_success"
  | "ack_failure";

export interface NotifyResult {
  delivered: boolean;
  /** `true` when the application answered cdr=1 (authenticated rejection). */
  rejected: boolean;
  attempts: number;
  attemptOutcomes: NotificationAttemptOutcome[];
  ack: string | null;
}

export interface NotifyOptions {
  canonicalOrigin: string;
  fields: Record<string, string>;
  maxAttempts?: number;
  simulatedTransportFailures?: number;
  fetchImpl?: typeof fetch;
  delay?: (attemptIndex: number) => Promise<void>;
}

const noDelay = async () => {};

export function buildCallbackUrl(canonicalOrigin: string): string {
  return new URL(APPLICATION_CALLBACK_PATH, canonicalOrigin).toString();
}

export async function notifyApplicationCallback(options: NotifyOptions): Promise<NotifyResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const simulatedFailures = Math.max(0, options.simulatedTransportFailures ?? 0);
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delay ?? noDelay;
  const url = buildCallbackUrl(options.canonicalOrigin);
  const body = new URLSearchParams(options.fields).toString();

  const attemptOutcomes: NotificationAttemptOutcome[] = [];
  let ack: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await delay(attempt);

    if (attempt < simulatedFailures) {
      attemptOutcomes.push("simulated_timeout");
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
      });
    } catch {
      attemptOutcomes.push("transport_error");
      continue;
    }

    if (response.status !== 200) {
      attemptOutcomes.push(`http_${response.status}`);
      continue;
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      attemptOutcomes.push("transport_error");
      continue;
    }

    if (text.startsWith(SUCCESS_ACK_PREFIX)) {
      attemptOutcomes.push("ack_success");
      ack = text;
      return { delivered: true, rejected: false, attempts: attempt + 1, attemptOutcomes, ack };
    }
    if (text.startsWith(FAILURE_ACK_PREFIX)) {
      attemptOutcomes.push("ack_failure");
      ack = text;
      return { delivered: false, rejected: true, attempts: attempt + 1, attemptOutcomes, ack };
    }
    attemptOutcomes.push("transport_error");
  }

  return { delivered: false, rejected: false, attempts: attemptOutcomes.length, attemptOutcomes, ack };
}
