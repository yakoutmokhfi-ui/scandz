import "server-only";
import { createHash } from "node:crypto";
import type { MoneticoCredentialPayload } from "@/lib/server/payment-providers/monetico/types";
import { transformSecurityKey, computeMac } from "@/lib/server/payment-providers/monetico/mac";
import type { SimulatedNotificationStep } from "@/lib/server/payment-providers/monetico/simulator/scenarios";

/**
 * MONETICO PAYMENT SIMULATOR v1 — SIMULATED SERVER-TO-SERVER NOTIFICATION.
 *
 * Builds the `application/x-www-form-urlencoded` field set Monetico
 * would POST to the merchant callback URL for one scenario step, signed
 * with the merchant's security key exactly as the real TPE signs it
 * (HMAC-SHA1 over the sorted canonical string of ALL fields, mac.ts).
 * The REAL application route (`/api/payments/monetico/callback`) then
 * verifies it with the REAL `verifyMoneticoCallback` -- nothing in the
 * application is bypassed or mocked.
 *
 * DETERMINISM: for identical inputs (step, reference, amount, currency,
 * TPE, `now`) the output is byte-identical. `numauto` and `hpancb` are
 * derived from SHA-256 of the reference -- never random.
 *
 * `amount`/`currency` MUST be the AUTHORITATIVE values of the payment
 * attempt (read server-side from `get_payment_transaction_correlation`),
 * never values echoed by a browser: tampering is a deliberate scenario
 * modifier applied HERE, never an input a client can inject.
 */

export interface BuildSimulatedCallbackInput {
  step: SimulatedNotificationStep;
  reference: string;
  tpe: string;
  amount: string | number;
  currency: string;
  credential: MoneticoCredentialPayload;
  now: Date;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatCallbackDate(d: Date): string {
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}_a_${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function deterministicDigits(seed: string, length: number): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  let out = "";
  for (let i = 0; out.length < length && i < hex.length; i++) {
    out += String(parseInt(hex[i], 16) % 10);
  }
  return out.padEnd(length, "0");
}

function applyAmountTamper(amount: string | number, cents: number | undefined): string {
  const base = Math.round(Number(amount) * 100);
  const tampered = base + (cents ?? 0);
  return (tampered / 100).toFixed(2);
}

export function buildSimulatedCallback(input: BuildSimulatedCallbackInput): Record<string, string> {
  const { step, reference, tpe, credential, now } = input;
  const amount = applyAmountTamper(input.amount, step.amountTamperCents);
  const currency = step.currencyOverride ?? input.currency;

  const fields: Record<string, string> = {
    TPE: tpe,
    date: formatCallbackDate(now),
    montant: `${amount}${currency}`,
    reference,
    "texte-retour": `simulator:${step.codeRetour}`,
    "code-retour": step.codeRetour,
    cvx: "oui",
    vld: "1229",
    brand: "VI",
    modepaiement: "CB",
    originecb: "FR",
    bincb: "000000",
    hpancb: createHash("sha256").update(`hpancb:${reference}`, "utf8").digest("hex").slice(0, 40).toUpperCase(),
    ipclient: "127.0.0.1",
    originetr: "FR",
    // Marks the message as synthetic for any human reader of the inbox;
    // included in the MAC like every other field, so it cannot be
    // stripped without invalidating the signature.
    "scanym-simulator": "1",
  };

  if (step.codeRetour === "payetest" || step.codeRetour === "paiement" || /^paiement_pf[2-4]$/.test(step.codeRetour)) {
    fields.numauto = deterministicDigits(`numauto:${reference}`, 6);
  }
  if (step.codeRetour === "Annulation" || /^Annulation_pf[2-4]$/.test(step.codeRetour)) {
    fields.motifrefus = "refus";
  }

  const keyBuffer = transformSecurityKey(credential.securityKey);
  let mac = computeMac(fields, keyBuffer);
  if (step.corruptMac) {
    // Flip the first hex digit deterministically -- still 40 lowercase hex
    // chars, so the application's FORMAT check passes and its REAL HMAC
    // comparison is what rejects it.
    mac = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
  }
  return { ...fields, MAC: mac };
}
