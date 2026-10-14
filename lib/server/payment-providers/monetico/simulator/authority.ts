import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import { PaymentServerRpcError, PaymentServerUnavailableError } from "@/lib/server/payment-errors";

/**
 * MONETICO PAYMENT SIMULATOR v1.2 — TEST-PROJECT AUTHORITY CLIENT
 * (MSIM-SEC-01, MSIM-AUTH-03).
 *
 * Thin, typed wrappers over the three RPCs created by
 * `supabase/DRAFT-lot-monetico-simulator-test-authority-v1.sql` on the
 * DEDICATED TEST PROJECT ONLY. They use the SAME service-role client as
 * the rest of the payment layer (`getServiceRoleSupabaseClient`) -- the
 * simulator never builds a client of its own and never reads another key.
 *
 * On the production project these functions DO NOT EXIST: every call
 * fails (`PaymentServerRpcError`, PostgREST 404/42883) and the gate stays
 * closed. That is the point: no environment variable can create a SQL
 * function in a database.
 */

export interface SimulatorAuthority {
  projectRef: string;
  authoritySecret: string;
  allowedTpes: string[];
}

export async function getSimulatorAuthority(): Promise<SimulatorAuthority> {
  const client = getServiceRoleSupabaseClient();
  let data: unknown;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_simulator_authority", {}));
  } catch {
    throw new PaymentServerUnavailableError();
  }
  if (error) throw new PaymentServerRpcError("get_simulator_authority", error.code);
  const row = (Array.isArray(data) ? data[0] : data) as { project_ref?: unknown; authority_secret?: unknown; allowed_tpes?: unknown } | null;
  if (!row || typeof row.project_ref !== "string" || typeof row.authority_secret !== "string" || !Array.isArray(row.allowed_tpes)) {
    throw new PaymentServerRpcError("get_simulator_authority", "EMPTY_ROW");
  }
  return {
    projectRef: row.project_ref,
    authoritySecret: row.authority_secret,
    allowedTpes: row.allowed_tpes.filter((t): t is string => typeof t === "string"),
  };
}

export interface IssueSimulatorDecisionTokenInput {
  nonce: string;
  providerCode: string;
  providerReference: string;
  urlRetourOk: string;
  urlRetourErr: string;
  ttlSeconds: number;
}

export interface IssuedSimulatorDecisionToken {
  nonce: string;
  transactionId: string;
  orderId: string;
  restaurantId: string;
  expiresAt: string;
}

export async function issueSimulatorDecisionToken(input: IssueSimulatorDecisionTokenInput): Promise<IssuedSimulatorDecisionToken> {
  const client = getServiceRoleSupabaseClient();
  let data: unknown;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("issue_simulator_decision_token", {
      p_nonce: input.nonce,
      p_provider_code: input.providerCode,
      p_provider_reference: input.providerReference,
      p_url_retour_ok: input.urlRetourOk,
      p_url_retour_err: input.urlRetourErr,
      p_ttl_seconds: input.ttlSeconds,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }
  if (error) throw new PaymentServerRpcError("issue_simulator_decision_token", error.code);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new PaymentServerRpcError("issue_simulator_decision_token", "EMPTY_ROW");
  return {
    nonce: String(row.nonce),
    transactionId: String(row.transaction_id),
    orderId: String(row.order_id),
    restaurantId: String(row.restaurant_id),
    expiresAt: String(row.expires_at),
  };
}

export interface ConsumeSimulatorDecisionTokenInput {
  nonce: string;
  providerReference: string;
  urlRetourOk: string;
  urlRetourErr: string;
}

export type ConsumeSimulatorDecisionTokenResult =
  | { ok: true; transactionId: string; orderId: string; restaurantId: string }
  | { ok: false; reason: "token_unknown" | "token_already_used" | "token_expired" | "token_binding_mismatch" | "token_service_unavailable" };

/** Atomic, server-authoritative consumption (SQL `for update` + conditional UPDATE). */
export async function consumeSimulatorDecisionToken(input: ConsumeSimulatorDecisionTokenInput): Promise<ConsumeSimulatorDecisionTokenResult> {
  const client = getServiceRoleSupabaseClient();
  let data: unknown;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("consume_simulator_decision_token", {
      p_nonce: input.nonce,
      p_provider_reference: input.providerReference,
      p_url_retour_ok: input.urlRetourOk,
      p_url_retour_err: input.urlRetourErr,
    }));
  } catch {
    return { ok: false, reason: "token_service_unavailable" };
  }
  if (error) {
    switch (error.code) {
      case "P0002":
        return { ok: false, reason: "token_unknown" };
      case "42501":
        return { ok: false, reason: "token_already_used" };
      case "22023":
        return { ok: false, reason: "token_expired" };
      case "23514":
        return { ok: false, reason: "token_binding_mismatch" };
      default:
        return { ok: false, reason: "token_service_unavailable" };
    }
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return { ok: false, reason: "token_service_unavailable" };
  return { ok: true, transactionId: String(row.transaction_id), orderId: String(row.order_id), restaurantId: String(row.restaurant_id) };
}
