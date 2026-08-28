import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Couvre lib/server/payment-providers/monetico/credentials.ts (mandat
// §8/§36) : le format JSON {tpe, societe, securityKey} est une
// CONVENTION DE CETTE APPLICATION (voir types.ts) puisque
// `set_payment_provider_credentials(p_secret text, ...)` (PAYMENT P2A,
// déjà publié) n'impose aucune structure au contenu de `p_secret`.
// ====================================================================

const { parseMoneticoCredential } = await import(
  "../lib/server/payment-providers/monetico/credentials.ts"
);
const { MoneticoCredentialError } = await import(
  "../lib/server/payment-providers/monetico/errors.ts"
);

const VALID_TPE = "1234567";
const VALID_SOCIETE = "p3a2synthsociete";
const VALID_KEY = "0123456789abcdef0123456789ABCDEF01234567"; // 40 hex chars, mixed case on purpose

test("credential: charge JSON valide analysée correctement, clé normalisée en minuscules", () => {
  const raw = JSON.stringify({ tpe: VALID_TPE, societe: VALID_SOCIETE, securityKey: VALID_KEY });
  const parsed = parseMoneticoCredential(raw);
  assert.equal(parsed.tpe, VALID_TPE);
  assert.equal(parsed.societe, VALID_SOCIETE);
  assert.equal(parsed.securityKey, VALID_KEY.toLowerCase());
});

test("credential: TPE manquant rejeté", () => {
  const raw = JSON.stringify({ societe: VALID_SOCIETE, securityKey: VALID_KEY });
  assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError);
});

test("credential: societe manquante rejetée", () => {
  const raw = JSON.stringify({ tpe: VALID_TPE, securityKey: VALID_KEY });
  assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError);
});

test("credential: clé manquante rejetée", () => {
  const raw = JSON.stringify({ tpe: VALID_TPE, societe: VALID_SOCIETE });
  assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError);
});

test("credential: clé mal formée (longueur incorrecte) rejetée", () => {
  const raw = JSON.stringify({ tpe: VALID_TPE, societe: VALID_SOCIETE, securityKey: "abc123" });
  assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError);
});

test("credential: clé mal formée (caractères non hexadécimaux) rejetée", () => {
  const raw = JSON.stringify({
    tpe: VALID_TPE,
    societe: VALID_SOCIETE,
    securityKey: "ZZZZ56789abcdef0123456789ABCDEF01234567",
  });
  assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError);
});

test("credential: TPE de mauvaise longueur/caractères rejeté", () => {
  for (const badTpe of ["123456", "12345678", "ABC-123", ""]) {
    const raw = JSON.stringify({ tpe: badTpe, societe: VALID_SOCIETE, securityKey: VALID_KEY });
    assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError, `TPE="${badTpe}" aurait dû être rejeté`);
  }
});

test("credential: JSON invalide rejeté", () => {
  assert.throws(() => parseMoneticoCredential("{not valid json"), MoneticoCredentialError);
});

test("credential: chaîne vide rejetée", () => {
  assert.throws(() => parseMoneticoCredential(""), MoneticoCredentialError);
});

test("credential: type inattendu (tableau JSON) rejeté", () => {
  assert.throws(() => parseMoneticoCredential("[1,2,3]"), MoneticoCredentialError);
});

test("credential: type inattendu (nombre JSON brut) rejeté", () => {
  assert.throws(() => parseMoneticoCredential("42"), MoneticoCredentialError);
});

test("credential: type inattendu (null JSON) rejeté", () => {
  assert.throws(() => parseMoneticoCredential("null"), MoneticoCredentialError);
});

test("credential: type de champ inattendu (nombre au lieu de chaîne) rejeté", () => {
  const raw = JSON.stringify({ tpe: 1234567, societe: VALID_SOCIETE, securityKey: VALID_KEY });
  assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError);
});

test("credential: propriété supplémentaire inattendue REJETÉE (politique stricte, mandat §36)", () => {
  const raw = JSON.stringify({
    tpe: VALID_TPE,
    societe: VALID_SOCIETE,
    securityKey: VALID_KEY,
    extraUnexpectedField: "smuggled-value",
  });
  assert.throws(() => parseMoneticoCredential(raw), MoneticoCredentialError);
});

test("credential: aucun secret n'apparaît jamais dans un message d'erreur", () => {
  const secretMarker = "p3a2-synthetic-key-marker-DO-NOT-USE-XYZ789";
  const raw = JSON.stringify({ tpe: "bad", societe: VALID_SOCIETE, securityKey: secretMarker });
  try {
    parseMoneticoCredential(raw);
    assert.fail("aurait dû lever");
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    assert.ok(!message.includes(secretMarker));
    assert.ok(!stack.includes(secretMarker));
  }
});
