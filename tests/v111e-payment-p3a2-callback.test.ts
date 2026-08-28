import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Tests de callback (mandat §20/§21/§23/§24/§25/§38).
// ====================================================================

const { verifyMoneticoCallback, parseMoneticoCallback } = await import(
  "../lib/server/payment-providers/monetico/callback.ts"
);
const { transformSecurityKey, computeMac } = await import(
  "../lib/server/payment-providers/monetico/mac.ts"
);
const { parseMoneticoCredential } = await import(
  "../lib/server/payment-providers/monetico/credentials.ts"
);
const { MoneticoCallbackError, MoneticoMacVerificationError } = await import(
  "../lib/server/payment-providers/monetico/errors.ts"
);

const CREDENTIAL = parseMoneticoCredential(
  JSON.stringify({
    tpe: "1234567",
    societe: "p3a2synthsociete",
    securityKey: "0123456789abcdef0123456789abcdef01234567",
  })
);
const KEY_BUFFER = transformSecurityKey(CREDENTIAL.securityKey);

/** Construit un callback synthétique VALIDE (MAC correctement calculé
 *  sur les champs fournis) pour servir de point de départ à chaque
 *  test -- jamais un vrai callback Monetico, jamais une donnée réelle. */
function buildValidCallback(overrideFields: Record<string, string>): Record<string, string> {
  const fields = {
    TPE: "1234567",
    date: "24/05/2019_a_10:00:25",
    montant: "95.25EUR",
    reference: "abc123def456",
    "code-retour": "paiement",
    cvx: "oui",
    vld: "1225",
    brand: "VI",
    numauto: "123456",
    ...overrideFields,
  };
  const mac = computeMac(fields, KEY_BUFFER);
  return { ...fields, MAC: mac };
}

test("callback: paiement accepté valide -> status paid, providerReference/authorizationReference mappés", () => {
  const raw = buildValidCallback({});
  const result = verifyMoneticoCallback(raw, CREDENTIAL);
  assert.equal(result.status, "paid");
  assert.equal(result.codeRetour, "paiement");
  assert.equal(result.providerReference, "abc123def456");
  assert.equal(result.authorizationReference, "123456");
});

test("callback: paiement sandbox (payetest) -> status paid", () => {
  const raw = buildValidCallback({ "code-retour": "payetest" });
  const result = verifyMoneticoCallback(raw, CREDENTIAL);
  assert.equal(result.status, "paid");
});

test("callback: paiement refusé (annulation) -> status failed", () => {
  const raw = buildValidCallback({ "code-retour": "annulation", numauto: "" });
  const result = verifyMoneticoCallback(raw, CREDENTIAL);
  assert.equal(result.status, "failed");
  assert.equal(result.authorizationReference, null);
});

test("callback: paiement fractionné accepté (paiement_pf2) -> status paid", () => {
  const raw = buildValidCallback({ "code-retour": "paiement_pf2" });
  assert.equal(verifyMoneticoCallback(raw, CREDENTIAL).status, "paid");
});

test("callback: paiement fractionné refusé (Annulation_pf3) -> status failed", () => {
  const raw = buildValidCallback({ "code-retour": "Annulation_pf3" });
  assert.equal(verifyMoneticoCallback(raw, CREDENTIAL).status, "failed");
});

test("callback: attente_partenaire -> status pending", () => {
  const raw = buildValidCallback({ "code-retour": "attente_partenaire" });
  assert.equal(verifyMoneticoCallback(raw, CREDENTIAL).status, "pending");
});

test("callback: code-retour inconnu -> repli sûr status pending, jamais 'paid' par défaut", () => {
  const raw = buildValidCallback({ "code-retour": "une_valeur_jamais_documentee_xyz" });
  const result = verifyMoneticoCallback(raw, CREDENTIAL);
  assert.equal(result.status, "pending");
  assert.notEqual(result.status, "paid");
});

test("callback: traitement RÉPÉTÉ du même callback donne EXACTEMENT le même résultat (idempotence, mandat §23)", () => {
  const raw = buildValidCallback({});
  const first = verifyMoneticoCallback(raw, CREDENTIAL);
  const second = verifyMoneticoCallback(raw, CREDENTIAL);
  assert.deepEqual(first, second);
});

test("callback: MAC invalide rejeté (MoneticoMacVerificationError)", () => {
  const raw = buildValidCallback({});
  raw.MAC = "0".repeat(40);
  assert.throws(() => verifyMoneticoCallback(raw, CREDENTIAL), MoneticoMacVerificationError);
});

test("callback: MAC manquant rejeté avant toute vérification", () => {
  const raw = buildValidCallback({});
  delete (raw as Record<string, unknown>).MAC;
  assert.throws(() => verifyMoneticoCallback(raw, CREDENTIAL), MoneticoCallbackError);
});

test("callback: champ altéré (un seul caractère de reference modifié) invalide le MAC", () => {
  const raw = buildValidCallback({});
  raw.reference = raw.reference.slice(0, -1) + (raw.reference.endsWith("6") ? "7" : "6");
  assert.throws(() => verifyMoneticoCallback(raw, CREDENTIAL), MoneticoMacVerificationError);
});

test("callback: malformé (pas un objet) rejeté", () => {
  assert.throws(() => parseMoneticoCallback(null as never), MoneticoCallbackError);
  assert.throws(() => parseMoneticoCallback("not-an-object" as never), MoneticoCallbackError);
  assert.throws(() => parseMoneticoCallback([1, 2, 3] as never), MoneticoCallbackError);
});

test("callback: code-retour manquant rejeté", () => {
  const raw = buildValidCallback({});
  delete (raw as Record<string, unknown>)["code-retour"];
  assert.throws(() => verifyMoneticoCallback(raw, CREDENTIAL), MoneticoCallbackError);
});

test("callback: reference manquante rejetée", () => {
  const raw = buildValidCallback({});
  delete (raw as Record<string, unknown>).reference;
  assert.throws(() => verifyMoneticoCallback(raw, CREDENTIAL), MoneticoCallbackError);
});

test("callback: champ optionnel absent (numauto) traité proprement, jamais exigé (mandat §20, 'Do not require optional fields')", () => {
  const fields = {
    TPE: "1234567",
    date: "24/05/2019_a_10:00:25",
    montant: "95.25EUR",
    reference: "abc123def456",
    "code-retour": "annulation",
  };
  const mac = computeMac(fields, KEY_BUFFER);
  const raw = { ...fields, MAC: mac };
  const result = verifyMoneticoCallback(raw, CREDENTIAL);
  assert.equal(result.authorizationReference, null);
});

test("callback: type de champ inattendu (nombre au lieu de chaîne) rejeté", () => {
  const raw = buildValidCallback({});
  (raw as Record<string, unknown>).montant = 95.25;
  assert.throws(() => verifyMoneticoCallback(raw, CREDENTIAL), MoneticoCallbackError);
});

test("callback: jamais de mutation d'état -- verifyMoneticoCallback ne renvoie qu'un résultat typé, aucune fonction de ce module n'appelle confirmPaymentAttempt/orders/payment_transactions", () => {
  // Preuve structurelle légère au niveau du test : le module importé
  // n'expose que parseMoneticoCallback/verifyMoneticoCallback -- voir
  // aussi le test structurel dédié (v111h) qui scanne le SOURCE pour
  // confirmer l'absence de toute mention de confirmPaymentAttempt/
  // "orders"/"payment_transactions" dans callback.ts.
  const raw = buildValidCallback({});
  const result = verifyMoneticoCallback(raw, CREDENTIAL);
  assert.deepEqual(Object.keys(result).sort(), [
    "authorizationReference",
    "codeRetour",
    "providerReference",
    "rawMontant",
    "status",
  ]);
});
