import "server-only";
import type { MoneticoCredentialPayload } from "@/lib/server/payment-providers/monetico/types";
import { transformSecurityKey, verifyMac } from "@/lib/server/payment-providers/monetico/mac";

/**
 * MONETICO PAYMENT SIMULATOR v1 — INBOUND MERCHANT FORM VERIFICATION.
 *
 * Plays the role of the Monetico TPE receiving the merchant's payment
 * form (`buildMoneticoPaymentRequest` output, auto-posted by the
 * browser). It verifies the request EXACTLY as the real endpoint would
 * refuse it: version, TPE/societe matching the merchant credential,
 * `montant` format, `date` format, `reference` length, both return URLs
 * present, and the MAC recomputed over ALL received fields (minus MAC)
 * with the merchant's 40-hex security key.
 *
 * PURE: no I/O, no mutation, no logging. The credential is passed in by
 * the caller (resolved through the existing Vault-backed RPC
 * `get_payment_provider_credential`, scoped to the merchant found by
 * correlating `reference`). The key never leaves this function's scope
 * and is never part of the returned structure.
 *
 * `contexte_commande` is decoded for DISPLAY ONLY (it is the merchant's
 * own base64 JSON) and never trusted for any decision.
 */

export type InboundRejectionReason =
  | "malformed"
  | "unsupported_version"
  | "tpe_mismatch"
  | "societe_mismatch"
  | "invalid_montant"
  | "invalid_date"
  | "invalid_reference"
  | "missing_return_urls"
  | "mac_invalid";

export class SimulatorInboundError extends Error {
  readonly reason: InboundRejectionReason;
  constructor(reason: InboundRejectionReason) {
    super(`MONETICO_SIMULATOR_INBOUND_${reason.toUpperCase()}`);
    this.name = "SimulatorInboundError";
    this.reason = reason;
  }
}

export interface VerifiedInboundRequest {
  tpe: string;
  reference: string;
  /** Raw `montant` as received, e.g. "12.50EUR". */
  montant: string;
  amount: string;
  currency: string;
  date: string;
  language: string;
  urlRetourOk: string;
  urlRetourErr: string;
  /** Decoded `contexte_commande` (display only, may be null if undecodable). */
  orderContext: unknown;
}

const MONTANT_PATTERN = /^(\d+(?:\.\d{1,2})?)([A-Z]{3})$/;
const DATE_PATTERN = /^\d{2}\/\d{2}\/\d{4}:\d{2}:\d{2}:\d{2}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9]{1,12}$/;
const SUPPORTED_VERSION = "3.0";

function requireString(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) throw new SimulatorInboundError("malformed");
  return v;
}

export function verifyInboundMerchantForm(
  raw: Record<string, unknown>,
  credential: MoneticoCredentialPayload
): VerifiedInboundRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SimulatorInboundError("malformed");
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new SimulatorInboundError("malformed");
    fields[k] = v;
  }

  const mac = requireString(fields, "MAC");
  const version = requireString(fields, "version");
  const tpe = requireString(fields, "TPE");
  const societe = requireString(fields, "societe");
  const montant = requireString(fields, "montant");
  const date = requireString(fields, "date");
  const reference = requireString(fields, "reference");
  const language = requireString(fields, "lgue");
  requireString(fields, "contexte_commande");

  if (version !== SUPPORTED_VERSION) throw new SimulatorInboundError("unsupported_version");
  if (tpe !== credential.tpe) throw new SimulatorInboundError("tpe_mismatch");
  if (societe !== credential.societe) throw new SimulatorInboundError("societe_mismatch");
  const montantMatch = MONTANT_PATTERN.exec(montant);
  if (!montantMatch) throw new SimulatorInboundError("invalid_montant");
  if (!DATE_PATTERN.test(date)) throw new SimulatorInboundError("invalid_date");
  if (!REFERENCE_PATTERN.test(reference)) throw new SimulatorInboundError("invalid_reference");
  const urlRetourOk = fields["url_retour_ok"];
  const urlRetourErr = fields["url_retour_err"];
  if (!urlRetourOk || !urlRetourErr) throw new SimulatorInboundError("missing_return_urls");

  // MAC over ALL received fields except MAC itself -- exactly the
  // merchant-side canonicalization (mac.ts / canonicalization.ts).
  const { MAC: _ignored, ...unsigned } = fields;
  void _ignored;
  const keyBuffer = transformSecurityKey(credential.securityKey);
  if (!verifyMac(unsigned, keyBuffer, mac)) throw new SimulatorInboundError("mac_invalid");

  let orderContext: unknown = null;
  try {
    orderContext = JSON.parse(Buffer.from(fields["contexte_commande"], "base64").toString("utf8"));
  } catch {
    orderContext = null;
  }

  return {
    tpe,
    reference,
    montant,
    amount: montantMatch[1],
    currency: montantMatch[2],
    date,
    language,
    urlRetourOk,
    urlRetourErr,
    orderContext,
  };
}
