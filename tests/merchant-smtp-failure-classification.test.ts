import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// A196-04 -- classification des échecs SMTP dans la taxonomie FERMÉE.
// Contrat : jamais de classe hors taxonomie ; seul un échec d'authentification
// PERMANENT (5xx) suspend le fournisseur ; destinataire invalide = terminal.
// ====================================================================

const { classifySmtpFailure } = await import("../lib/server/notifications/smtp-failure-classification.ts");
const { NOTIFICATION_ERROR_TAXONOMY, normalizeNotificationErrorCode } = await import("../lib/server/notifications/notification-error-taxonomy.ts");

type Case = [label: string, failure: Record<string, unknown>, expected: { errorClass: string; retryable: boolean; disableProvider: boolean }];

const CASES: Case[] = [
  ["délai (dialogue)", { stage: "timeout" }, { errorClass: "PROVIDER_TIMEOUT", retryable: true, disableProvider: false }],
  ["en-tête invalide", { stage: "header" }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: false, disableProvider: false }],
  ["hôte non public", { stage: "host_not_public" }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: true, disableProvider: false }],
  ["DNS introuvable", { stage: "dns", nodeCode: "ENOTFOUND" }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: true, disableProvider: false }],
  ["DNS temporaire", { stage: "dns", nodeCode: "EAI_AGAIN" }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["AUTH 535 (identifiants refusés)", { stage: "auth", status: 535 }, { errorClass: "PROVIDER_AUTHENTICATION_FAILED", retryable: true, disableProvider: true }],
  ["AUTH 534", { stage: "auth", status: 534 }, { errorClass: "PROVIDER_AUTHENTICATION_FAILED", retryable: true, disableProvider: true }],
  ["AUTH 454 (temporaire)", { stage: "auth", status: 454 }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["AUTH sans statut", { stage: "auth", status: null }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["MAIL FROM 553", { stage: "mail_from", status: 553 }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: true, disableProvider: false }],
  ["MAIL FROM 451", { stage: "mail_from", status: 451 }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["bannière 554", { stage: "greeting", status: 554 }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: true, disableProvider: false }],
  ["EHLO 421", { stage: "ehlo", status: 421 }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["RCPT 550 (inconnu)", { stage: "rcpt_to", status: 550 }, { errorClass: "INVALID_RECIPIENT", retryable: false, disableProvider: false }],
  ["RCPT 452 (boîte pleine)", { stage: "rcpt_to", status: 452 }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["DATA 554", { stage: "data", status: 554 }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: false, disableProvider: false }],
  ["contenu rejeté 554", { stage: "data_end", status: 554 }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: false, disableProvider: false }],
  ["contenu différé 451", { stage: "data_end", status: 451 }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["connexion refusée", { stage: "connect", nodeCode: "ECONNREFUSED" }, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
  ["certificat TLS invalide", { stage: "connect", nodeCode: "ERR_TLS_CERT_ALTNAME_INVALID" }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: true, disableProvider: false }],
  ["certificat expiré", { stage: "connect", nodeCode: "CERT_HAS_EXPIRED" }, { errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable: true, disableProvider: false }],
  ["ETIMEDOUT", { stage: "connect", nodeCode: "ETIMEDOUT" }, { errorClass: "PROVIDER_TIMEOUT", retryable: true, disableProvider: false }],
  ["échec inconnu", {}, { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }],
];

for (const [label, failure, expected] of CASES) {
  test(`classification : ${label}`, () => {
    assert.deepEqual(classifySmtpFailure(failure as never), expected);
  });
}

test("toute classe produite appartient à la taxonomie fermée (aucun repli sur UNKNOWN_PROVIDER_ERROR)", () => {
  const stages = ["dns", "host_not_public", "connect", "greeting", "ehlo", "auth", "mail_from", "rcpt_to", "data", "data_end", "timeout", "header", undefined];
  const statuses = [undefined, null, 220, 354, 421, 454, 535, 550, 554];
  const nodeCodes = [undefined, null, "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "ECONNRESET"];
  for (const stage of stages) for (const status of statuses) for (const nodeCode of nodeCodes) {
    const v = classifySmtpFailure({ stage, status, nodeCode } as never);
    assert.ok((NOTIFICATION_ERROR_TAXONOMY as readonly string[]).includes(v.errorClass), `${stage}/${status}/${nodeCode}`);
    assert.equal(normalizeNotificationErrorCode(v.errorClass), v.errorClass, "doit survivre à la normalisation sans repli");
    assert.notEqual(v.errorClass, "UNKNOWN_PROVIDER_ERROR");
    // Suspension du fournisseur uniquement pour l'échec d'authentification PERMANENT.
    assert.equal(v.disableProvider, stage === "auth" && typeof status === "number" && status >= 500);
  }
});
