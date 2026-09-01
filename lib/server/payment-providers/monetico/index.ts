import "server-only";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 * Point d'entrée unique du module Monetico -- capacités FONCTIONNELLES
 * uniquement, jamais un objet de configuration/credential brut exposé
 * en dehors des types explicitement destinés à transporter un
 * credential DÉJÀ analysé et validé (mandat §9, même principe que
 * PAYMENT P3-A1).
 */

export { parseMoneticoCredential } from "@/lib/server/payment-providers/monetico/credentials";
export { buildCanonicalString } from "@/lib/server/payment-providers/monetico/canonicalization";
export {
  transformSecurityKey,
  computeMac,
  verifyMac,
} from "@/lib/server/payment-providers/monetico/mac";
export { deriveMoneticoReference } from "@/lib/server/payment-providers/monetico/reference";
export { buildMoneticoPaymentRequest } from "@/lib/server/payment-providers/monetico/request";
export {
  parseMoneticoCallback,
  verifyMoneticoCallback,
} from "@/lib/server/payment-providers/monetico/callback";
export { buildMoneticoAcknowledgement } from "@/lib/server/payment-providers/monetico/ack";
export {
  MONETICO_PAYMENT_SUBMISSION_URL,
  MONETICO_TEST_PAYMENT_SUBMISSION_URL,
  MONETICO_LIVE_PAYMENT_SUBMISSION_URL,
  resolveMoneticoSubmissionUrl,
  MoneticoUnsupportedModeError,
} from "@/lib/server/payment-providers/monetico/endpoint";
export {
  classifyMoneticoCodeRetour,
  moneticoClassificationToProviderEventType,
  type MoneticoCodeRetourClassification,
  type ClassifiedMoneticoCodeRetour,
} from "@/lib/server/payment-providers/monetico/code-retour";

export type {
  MoneticoCredentialPayload,
  BuildMoneticoRequestInput,
  MoneticoPaymentRequestFields,
  MoneticoCallbackRawFields,
  MoneticoResultStatus,
  MoneticoVerifiedCallbackResult,
} from "@/lib/server/payment-providers/monetico/types";

export {
  MoneticoCredentialError,
  MoneticoMacVerificationError,
  MoneticoCallbackError,
  MoneticoProtocolError,
} from "@/lib/server/payment-providers/monetico/errors";
