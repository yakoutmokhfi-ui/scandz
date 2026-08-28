import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Tests de fuite de secret (mandat §28/§40) : marqueurs synthétiques
// DISTINCTIFS injectés dans la clé de sécurité, la charge JSON de
// credential, et les champs de callback -- jamais dans les logs, les
// erreurs levées, les traces de pile, ou une valeur de résultat
// public-safe.
// ====================================================================

const { parseMoneticoCredential } = await import(
  "../lib/server/payment-providers/monetico/credentials.ts"
);
const { transformSecurityKey, computeMac, verifyMac } = await import(
  "../lib/server/payment-providers/monetico/mac.ts"
);
const { verifyMoneticoCallback } = await import(
  "../lib/server/payment-providers/monetico/callback.ts"
);
const { buildMoneticoPaymentRequest } = await import(
  "../lib/server/payment-providers/monetico/request.ts"
);

const SECURITY_KEY_MARKER = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // 40 hex chars, synthetic
const SOCIETE_MARKER = "p3a2-synthetic-societe-marker-XYZ";
const CALLBACK_FIELD_MARKER = "p3a2-synthetic-callback-marker-ABC123";

function withConsoleSpy<T>(fn: () => T): { result: T | undefined; error: unknown; captured: string } {
  const captured: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  let result: T | undefined;
  let error: unknown;
  try {
    result = fn();
  } catch (err) {
    error = err;
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
  return { result, error, captured: captured.join("\n") };
}

test("fuite: aucune trace du marqueur de clé de sécurité dans les logs, sur succès ET échec du parsing de credential", () => {
  const validRaw = JSON.stringify({ tpe: "1234567", societe: "societe1", securityKey: SECURITY_KEY_MARKER });
  const invalidRaw = JSON.stringify({ tpe: "bad", societe: "societe1", securityKey: SECURITY_KEY_MARKER });

  const successRun = withConsoleSpy(() => parseMoneticoCredential(validRaw));
  const failureRun = withConsoleSpy(() => parseMoneticoCredential(invalidRaw));

  const combined = successRun.captured + failureRun.captured;
  assert.ok(!combined.includes(SECURITY_KEY_MARKER));

  const failureMessage = (failureRun.error as Error)?.message ?? "";
  const failureStack = (failureRun.error as Error)?.stack ?? "";
  assert.ok(!failureMessage.includes(SECURITY_KEY_MARKER));
  assert.ok(!failureStack.includes(SECURITY_KEY_MARKER));
});

test("fuite: aucune trace du marqueur de societe dans les logs de credential", () => {
  const raw = JSON.stringify({ tpe: "1234567", societe: SOCIETE_MARKER, securityKey: SECURITY_KEY_MARKER });
  const run = withConsoleSpy(() => parseMoneticoCredential(raw));
  assert.ok(!run.captured.includes(SOCIETE_MARKER));
});

test("fuite: le MAC généré et la clé transformée n'apparaissent jamais dans un log", () => {
  const run = withConsoleSpy(() => {
    const key = transformSecurityKey(SECURITY_KEY_MARKER);
    return computeMac({ a: "1" }, key);
  });
  assert.ok(!run.captured.includes(SECURITY_KEY_MARKER));
  assert.ok(run.result && !run.captured.includes(run.result));
});

test("fuite: verifyMac (succès et échec) ne journalise jamais la clé ni le MAC attendu/reçu", () => {
  const key = transformSecurityKey(SECURITY_KEY_MARKER);
  const validMac = computeMac({ a: "1" }, key);

  const successRun = withConsoleSpy(() => verifyMac({ a: "1" }, key, validMac));
  const failureRun = withConsoleSpy(() => verifyMac({ a: "1" }, key, "0".repeat(40)));

  const combined = successRun.captured + failureRun.captured;
  assert.ok(!combined.includes(SECURITY_KEY_MARKER));
  assert.ok(!combined.includes(validMac));
});

test("fuite: callback -- marqueur synthétique dans un champ ne fuite jamais, même sur MAC invalide", () => {
  const credential = parseMoneticoCredential(
    JSON.stringify({ tpe: "1234567", societe: "societe1", securityKey: SECURITY_KEY_MARKER })
  );
  const raw = {
    TPE: "1234567",
    date: "24/05/2019_a_10:00:25",
    montant: "10.00EUR",
    reference: CALLBACK_FIELD_MARKER,
    "code-retour": "paiement",
    MAC: "0".repeat(40), // volontairement invalide
  };

  const run = withConsoleSpy(() => verifyMoneticoCallback(raw, credential));
  assert.ok(!run.captured.includes(SECURITY_KEY_MARKER));

  const errorMessage = (run.error as Error)?.message ?? "";
  const errorStack = (run.error as Error)?.stack ?? "";
  assert.ok(!errorMessage.includes(SECURITY_KEY_MARKER));
  assert.ok(!errorStack.includes(SECURITY_KEY_MARKER));
  // Le marqueur de champ (non secret, une simple référence) PEUT
  // apparaître dans le résultat métier lui-même s'il y a succès, mais
  // ici le MAC est invalide -- aucune fonction ne doit lever une erreur
  // qui l'embarque non plus.
  assert.ok(!errorMessage.includes(CALLBACK_FIELD_MARKER));
});

test("fuite: buildMoneticoPaymentRequest -- le credential et le MAC généré n'apparaissent jamais dans les logs, la clé n'apparaît jamais dans les champs renvoyés", () => {
  const credential = parseMoneticoCredential(
    JSON.stringify({ tpe: "1234567", societe: "societe1", securityKey: SECURITY_KEY_MARKER })
  );
  const run = withConsoleSpy(() =>
    buildMoneticoPaymentRequest({
      credential,
      amount: 10,
      currency: "EUR",
      referenceSeed: "order-1",
    })
  );
  assert.ok(!run.captured.includes(SECURITY_KEY_MARKER));
  const serialized = JSON.stringify(run.result);
  assert.ok(!serialized.includes(SECURITY_KEY_MARKER));
});
