import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Tests d'acquittement (mandat §22/§39) : octets EXACTS, y compris le
// comportement du retour à la ligne final.
// ====================================================================

const { buildMoneticoAcknowledgement } = await import(
  "../lib/server/payment-providers/monetico/ack.ts"
);

test("ack: succès -- octets exacts 'version=2\\ncdr=0\\n'", () => {
  const ack = buildMoneticoAcknowledgement(true);
  assert.equal(ack, "version=2\ncdr=0\n");
  assert.equal(Buffer.from(ack, "utf8").toString("hex"), Buffer.from("version=2\ncdr=0\n", "utf8").toString("hex"));
});

test("ack: échec -- octets exacts 'version=2\\ncdr=1\\n'", () => {
  const ack = buildMoneticoAcknowledgement(false);
  assert.equal(ack, "version=2\ncdr=1\n");
});

test("ack: retour à la ligne final présent (LF, pas CRLF) sur les deux variantes", () => {
  assert.ok(buildMoneticoAcknowledgement(true).endsWith("\n"));
  assert.ok(buildMoneticoAcknowledgement(false).endsWith("\n"));
  assert.ok(!buildMoneticoAcknowledgement(true).includes("\r"));
  assert.ok(!buildMoneticoAcknowledgement(false).includes("\r"));
});

test("ack: longueur exacte en octets (16 caractères ASCII : 'version=2' + LF + 'cdr=N' + LF, aucun caractère multi-octet)", () => {
  assert.equal(Buffer.byteLength(buildMoneticoAcknowledgement(true), "utf8"), 16);
  assert.equal(Buffer.byteLength(buildMoneticoAcknowledgement(false), "utf8"), 16);
});

test("ack: succès et échec ne diffèrent QUE par le chiffre cdr", () => {
  const ok = buildMoneticoAcknowledgement(true);
  const ko = buildMoneticoAcknowledgement(false);
  assert.equal(ok.replace("cdr=0", "cdr=X"), ko.replace("cdr=1", "cdr=X"));
});
