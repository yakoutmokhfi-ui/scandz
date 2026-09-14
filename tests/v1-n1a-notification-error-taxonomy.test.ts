import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// N1-A v1.2 — N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01 (remediation).
//
// Mandat §"MANDATORY ADVERSARIAL TESTS" -- 6 diagnostics injectés,
// couverts ci-dessous dans le même ordre, plus la preuve que la
// taxonomie FERMÉE reste un ensemble borné et que les valeurs
// légitimes traversent inchangées (pass-through). Ce fichier teste
// `normalizeNotificationErrorCode` isolément ; v1-n1a-notification-
// worker.test.ts prouve en plus que le pipeline complet (provider ->
// worker -> p_error_class transmis à complete_notification_attempt)
// applique bien cette même frontière.
// ====================================================================

const {
  NOTIFICATION_ERROR_TAXONOMY,
  normalizeNotificationErrorCode,
} = await import("../lib/server/notifications/notification-error-taxonomy.ts");

// --------------------------------------------------------------
// Taxonomie : ensemble fermé, non vide, chaque valeur normalisable
// vers elle-même (pass-through déterministe pour les valeurs membres).
// --------------------------------------------------------------
test("NOTIFICATION_ERROR_TAXONOMY est un ensemble fermé non vide, et UNKNOWN_PROVIDER_ERROR en fait partie", () => {
  assert.ok(NOTIFICATION_ERROR_TAXONOMY.length > 0);
  assert.ok(NOTIFICATION_ERROR_TAXONOMY.includes("UNKNOWN_PROVIDER_ERROR" as any));
});

test("toute valeur membre de la taxonomie se normalise vers ELLE-MÊME (pass-through)", () => {
  for (const code of NOTIFICATION_ERROR_TAXONOMY) {
    assert.equal(normalizeNotificationErrorCode(code), code);
  }
});

test("null/undefined/chaîne vide se normalisent vers UNKNOWN_PROVIDER_ERROR", () => {
  assert.equal(normalizeNotificationErrorCode(null), "UNKNOWN_PROVIDER_ERROR");
  assert.equal(normalizeNotificationErrorCode(undefined), "UNKNOWN_PROVIDER_ERROR");
  assert.equal(normalizeNotificationErrorCode(""), "UNKNOWN_PROVIDER_ERROR");
});

// --------------------------------------------------------------
// Adversarial #1 : jeton public_token de suivi EXACT injecté comme
// errorClass.
// --------------------------------------------------------------
test("adversarial #1 : le jeton public_token de suivi exact ne traverse JAMAIS -- normalisé en UNKNOWN_PROVIDER_ERROR", () => {
  const trackingToken = "dddddddd-0000-4000-8000-000000000001";
  const result = normalizeNotificationErrorCode(trackingToken);
  assert.equal(result, "UNKNOWN_PROVIDER_ERROR");
  assert.notEqual(result, trackingToken);
  assert.doesNotMatch(result, /dddddddd/);
});

// --------------------------------------------------------------
// Adversarial #2 : secret en FORME UUID (structure identique à un
// jeton, valeur différente) -- prouve que ce n'est PAS un filtre
// spécifique au tracking mais une taxonomie fermée générale.
// --------------------------------------------------------------
test("adversarial #2 : un secret en forme UUID ne traverse JAMAIS -- normalisé en UNKNOWN_PROVIDER_ERROR", () => {
  const uuidSecret = "dddddddd-0000-4000-8000-000000000001";
  const result = normalizeNotificationErrorCode(uuidSecret);
  assert.equal(result, "UNKNOWN_PROVIDER_ERROR");
  assert.notEqual(result, uuidSecret);
});

// --------------------------------------------------------------
// Adversarial #3 : long secret NON hexadécimal -- prouve que la
// remédiation ne dépend PAS d'une détection hexadécimale (l'ancienne
// garde SQL, désormais remplacée, aurait laissé passer celui-ci).
// --------------------------------------------------------------
test("adversarial #3 : un long secret non-hexadécimal ne traverse JAMAIS -- normalisé en UNKNOWN_PROVIDER_ERROR", () => {
  const longNonHexSecret = "super-secret-provider-key-ABCDEFGHIJKLMN-123456789";
  const result = normalizeNotificationErrorCode(longNonHexSecret);
  assert.equal(result, "UNKNOWN_PROVIDER_ERROR");
  assert.notEqual(result, longNonHexSecret);
  assert.doesNotMatch(result, /ABCDEFGHIJKLMN/);
});

// --------------------------------------------------------------
// Adversarial #4 : diagnostic prestataire verbeux contenant une clé
// API en clair.
// --------------------------------------------------------------
test("adversarial #4 : un diagnostic verbeux contenant une clé API ne traverse JAMAIS -- normalisé en UNKNOWN_PROVIDER_ERROR", () => {
  const verboseError = "Authentication failed using key sk_test_example_secret_value";
  const result = normalizeNotificationErrorCode(verboseError);
  assert.equal(result, "UNKNOWN_PROVIDER_ERROR");
  assert.doesNotMatch(result, /sk_test_example_secret_value/);
});

// --------------------------------------------------------------
// Adversarial #5 : chaîne arbitraire inattendue, sans rapport avec
// quelque motif que ce soit.
// --------------------------------------------------------------
test("adversarial #5 : une chaîne arbitraire inattendue ne traverse JAMAIS -- normalisée en UNKNOWN_PROVIDER_ERROR", () => {
  const arbitrary = "flibbertigibbet-status-code-42-zzz";
  const result = normalizeNotificationErrorCode(arbitrary);
  assert.equal(result, "UNKNOWN_PROVIDER_ERROR");
});

// --------------------------------------------------------------
// Adversarial #6 : diagnostic multi-lignes (pourrait sinon être
// utilisé pour injecter du contenu structuré/des sauts de ligne dans
// un champ persistant).
// --------------------------------------------------------------
test("adversarial #6 : un diagnostic multi-lignes ne traverse JAMAIS -- normalisé en UNKNOWN_PROVIDER_ERROR", () => {
  const multiline = "Provider error occurred:\nRequest-Id: abc123\nSecret: super-secret-value\nRetrying...";
  const result = normalizeNotificationErrorCode(multiline);
  assert.equal(result, "UNKNOWN_PROVIDER_ERROR");
  assert.doesNotMatch(result, /\n/);
  assert.doesNotMatch(result, /super-secret-value/);
});

// --------------------------------------------------------------
// Preuve globale : pour les 6 payloads adversariaux + les valeurs
// null/vides, le résultat normalisé est TOUJOURS un membre exact de
// la taxonomie fermée -- jamais une valeur "presque" correcte, jamais
// une concaténation partielle.
// --------------------------------------------------------------
test("preuve globale : tout résultat normalisé (légitime ou adversarial) est TOUJOURS membre exact de la taxonomie fermée", () => {
  const inputs = [
    "dddddddd-0000-4000-8000-000000000001",
    "ffffffff-1111-4111-8111-111111111111",
    "super-secret-provider-key-ABCDEFGHIJKLMN-123456789",
    "Authentication failed using key sk_test_example_secret_value",
    "flibbertigibbet-status-code-42-zzz",
    "Provider error occurred:\nRequest-Id: abc123\nSecret: super-secret-value\nRetrying...",
    null,
    undefined,
    "",
    "PROVIDER_TIMEOUT",
    "UNKNOWN_PROVIDER_ERROR",
  ];
  for (const input of inputs) {
    const result = normalizeNotificationErrorCode(input as any);
    assert.ok(
      (NOTIFICATION_ERROR_TAXONOMY as readonly string[]).includes(result),
      `résultat "${result}" pour l'entrée ${JSON.stringify(input)} doit être membre exact de la taxonomie`
    );
  }
});
