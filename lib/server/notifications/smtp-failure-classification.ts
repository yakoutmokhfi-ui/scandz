import "server-only";
import type { SmtpFailureDetail } from "@/lib/server/ack-mailer";
import type { NotificationErrorCode } from "@/lib/server/notifications/notification-error-taxonomy";

/**
 * MERCHANT SMTP v1 R1 (audit PR #196, A196-04) -- CLASSIFICATION DES ÉCHECS SMTP.
 *
 * Avant : tout échec SMTP devenait `SMTP_DELIVERY_FAILED`, réessayable, puis
 * `UNKNOWN_PROVIDER_ERROR`. Un mauvais mot de passe provoquait donc une
 * nouvelle connexion + AUTH échoué pour CHAQUE notification et à chaque reprise
 * (risque de verrouillage de la boîte du commerçant).
 *
 * Cette fonction pure range un échec du transport dans la taxonomie FERMÉE
 * existante (notification-error-taxonomy.ts) et décide :
 *   - `retryable`      : la notification peut être retentée (barème SQL 5 tentatives) ;
 *   - `disableProvider`: l'identifiant SMTP doit être suspendu (échec d'authentification
 *                        PERMANENT, 5xx) pour ne plus réclamer ni re-tenter d'AUTH tant que
 *                        le commerçant n'a pas corrigé son mot de passe. Les notifications
 *                        restent en file (le claim exige un coffre activé).
 * Aucun texte brut du serveur n'est conservé : uniquement la classe normalisée.
 */
export interface SmtpFailureClassification {
  errorClass: NotificationErrorCode;
  retryable: boolean;
  disableProvider: boolean;
}

const TLS_CONFIG_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

function isPermanent(status: number | null | undefined): boolean {
  return typeof status === "number" && status >= 500 && status <= 599;
}

const temporary = (): SmtpFailureClassification => ({ errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false });
const configuration = (retryable: boolean): SmtpFailureClassification => ({ errorClass: "PROVIDER_CONFIGURATION_ERROR", retryable, disableProvider: false });

export function classifySmtpFailure(failure: SmtpFailureDetail): SmtpFailureClassification {
  const { stage, status, nodeCode } = failure;

  switch (stage) {
    case "timeout":
      return { errorClass: "PROVIDER_TIMEOUT", retryable: true, disableProvider: false };
    case "header":
      // Identité d'expéditeur invalide : un renvoi ne la corrigera pas.
      return configuration(false);
    case "host_not_public":
      return configuration(true);
    case "dns":
      return nodeCode === "EAI_AGAIN" ? temporary() : configuration(true);
    case "auth":
      // 535/534/530/504... = identifiants ou méthode refusés : suspendre le fournisseur.
      // 4xx (454 « temporary authentication failure ») = temporaire : pas de suspension.
      return isPermanent(status)
        ? { errorClass: "PROVIDER_AUTHENTICATION_FAILED", retryable: true, disableProvider: true }
        : temporary();
    case "mail_from":
    case "greeting":
    case "ehlo":
      return isPermanent(status) ? configuration(true) : temporary();
    case "rcpt_to":
      return isPermanent(status)
        ? { errorClass: "INVALID_RECIPIENT", retryable: false, disableProvider: false }
        : temporary();
    case "data":
    case "data_end":
      // Rejet définitif du contenu : inutile de réessayer ; refus temporaire : reprise.
      return isPermanent(status) ? configuration(false) : temporary();
    case "connect":
    default:
      break;
  }

  if (nodeCode && (nodeCode.startsWith("ERR_TLS_") || nodeCode.startsWith("ERR_SSL_") || TLS_CONFIG_CODES.has(nodeCode))) {
    return configuration(true);
  }
  if (nodeCode && TIMEOUT_CODES.has(nodeCode)) {
    return { errorClass: "PROVIDER_TIMEOUT", retryable: true, disableProvider: false };
  }
  if (nodeCode === "ENOTFOUND") return configuration(true);
  return temporary();
}
