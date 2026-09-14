import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// N1-A — REAL EMAIL ACTIVATION GATE.
// Calqué sur tests/v166-stuart-lot-d2-live-activation-gate.test.ts.
// AUCUN test de ce fichier ne positionne JAMAIS
// NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED="true" pour un ENVOI --
// la porte reste OFF dans tous les scénarios, y compris ceux qui
// prouvent son comportement fail-closed sur des valeurs invalides.
// ====================================================================

const { isRealEmailSendActivated, describeRealEmailActivationGateForObservability } = await import(
  "../lib/server/notifications/real-email-activation-gate.ts"
);

const GATE_VAR = "NOTIFICATION_EMAIL_LIVE_ACTIVATION_ENABLED";
const ORIGINAL = process.env[GATE_VAR];

test("porte absente de l'environnement -- isRealEmailSendActivated() === false (défaut = OFF)", () => {
  delete process.env[GATE_VAR];
  assert.equal(isRealEmailSendActivated(), false);
  const obs = describeRealEmailActivationGateForObservability();
  assert.equal(obs.enabled, false);
  assert.equal(obs.wasUnset, true);
  assert.equal(obs.envVarName, GATE_VAR);
});

test("valeurs proches mais invalides -- toutes rejetées, aucun alias accepté", () => {
  const invalidValues = ["1", "yes", "TRUE", "True", " true", "true ", "on", "enabled"];
  for (const v of invalidValues) {
    process.env[GATE_VAR] = v;
    assert.equal(isRealEmailSendActivated(), false, `valeur "${v}" ne doit jamais activer la porte`);
  }
});

test("seule la chaîne exacte \"true\" active la porte", () => {
  process.env[GATE_VAR] = "true";
  assert.equal(isRealEmailSendActivated(), true);
  const obs = describeRealEmailActivationGateForObservability();
  assert.equal(obs.enabled, true);
  assert.equal(obs.wasUnset, false);
});

test("observabilité ne renvoie jamais la valeur brute de la variable", () => {
  process.env[GATE_VAR] = "true";
  const obs = describeRealEmailActivationGateForObservability();
  const keys = Object.keys(obs);
  assert.deepEqual(keys.sort(), ["enabled", "envVarName", "wasUnset"]);
});

test("structurel : le fichier de la porte n'importe jamais NEXT_PUBLIC_*, ne lit jamais NODE_ENV/VERCEL_ENV, importe server-only", () => {
  const source = readFileSync(
    new URL("../lib/server/notifications/real-email-activation-gate.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /^import "server-only";/m);
  // Retire les commentaires AVANT la recherche -- ce fichier documente
  // délibérément, en prose, les variables qu'il ne doit jamais lire ;
  // seule une référence en CODE RÉEL constituerait une violation
  // (même technique que tests/v166-stuart-lot-d2-live-activation-
  // gate.test.ts, item 11).
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /NEXT_PUBLIC_/);
  assert.doesNotMatch(codeOnly, /NODE_ENV/);
  assert.doesNotMatch(codeOnly, /VERCEL_ENV/);
});

test("structurel : le worker n'active jamais un provider réel implicitement -- aucun import d'un module 'real'/'resend'/'postmark'/'sendgrid' dans ce lot", () => {
  const worker = readFileSync(new URL("../lib/server/notifications/notification-worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /resend|postmark|sendgrid/i);
});

if (typeof ORIGINAL === "undefined") {
  delete process.env[GATE_VAR];
} else {
  process.env[GATE_VAR] = ORIGINAL;
}
