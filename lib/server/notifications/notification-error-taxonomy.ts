import "server-only";

/**
 * N1-A v1.2 — N1A-DIAGNOSTIC-SECRET-CONTAINMENT-01 remediation.
 *
 * Taxonomie FERMÉE des classifications d'erreur de notification.
 * AUCUNE chaîne arbitraire fournie par un prestataire (brute, verbeuse,
 * multi-lignes, ou ressemblant à un secret/jeton) ne doit JAMAIS
 * traverser la frontière de normalisation vers un champ persistant
 * (`notification_delivery_attempt.error_class` /
 * `notification_outbox.last_error_code`) -- mandat, littéral :
 * "Arbitrary provider-supplied error strings must NEVER cross the
 * trusted normalization boundary into persisted diagnostic fields."
 *
 * Contrôle primaire : appartenance STRICTE à cet ensemble fermé
 * (égalité exacte, jamais une extraction par motif/sous-chaîne sur le
 * texte brut -- une tentative d'extraction par motif pourrait
 * elle-même réintroduire une fuite partielle). Toute valeur absente de
 * cet ensemble -- qu'il s'agisse d'un jeton de suivi, d'un secret
 * d'API, d'un diagnostic verbeux, ou d'une chaîne complètement
 * inattendue -- est rabattue sur `UNKNOWN_PROVIDER_ERROR`, SANS jamais
 * conserver la chaîne d'origine nulle part dans le résultat.
 *
 * La contrainte CHECK côté SQL sur ces deux colonnes utilise EXACTEMENT
 * le même ensemble fermé, en défense en profondeur (mandat §"SQL /
 * DATABASE DEFENCE" : "the database must reject arbitrary diagnostic
 * classifications if an unexpected caller attempts to persist them")
 * -- voir supabase/DRAFT-lot-n1a-customer-email-notification-
 * foundation-v1.sql. Le contrôle applicatif ci-dessous reste
 * l'AUTORITÉ PRINCIPALE ; la contrainte SQL est un filet, pas le
 * mécanisme premier (mandat, littéral : "DO NOT rely on regex secret
 * detection as the primary control").
 */
export const NOTIFICATION_ERROR_TAXONOMY = [
  // Classifications provider (mandat, exemples littéraux).
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TEMPORARY_UNAVAILABLE",
  "PROVIDER_AUTHENTICATION_FAILED",
  "PROVIDER_CONFIGURATION_ERROR",
  "INVALID_RECIPIENT",
  "TEMPLATE_RENDER_ERROR",
  // Classifications défensives déjà émises par notification-worker.ts
  // AVANT tout appel provider (identité d'expéditeur non résolue,
  // destinataire manquant en garde défensive, payload_snapshot
  // corrompu) -- incluses dans le MÊME ensemble fermé pour qu'une
  // seule autorité de validation existe, jamais deux.
  "SENDER_IDENTITY_UNRESOLVED",
  "RECIPIENT_EMAIL_MISSING",
  "PAYLOAD_SNAPSHOT_MALFORMED",
  // Repli fermé -- JAMAIS la chaîne brute d'origine.
  "UNKNOWN_PROVIDER_ERROR",
] as const;

export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_TAXONOMY)[number];

const TAXONOMY_SET: ReadonlySet<string> = new Set(NOTIFICATION_ERROR_TAXONOMY);

/**
 * Normalise une classification d'erreur AVANT toute persistance ou
 * transmission à `complete_notification_attempt`. Égalité STRICTE
 * contre l'ensemble fermé uniquement (`Set.has`, jamais un test de
 * sous-chaîne/motif). Toute valeur non membre -- y compris
 * `null`/`undefined`/chaîne vide/un jeton de suivi/un secret
 * d'API/un diagnostic verbeux/multi-lignes -- devient
 * `UNKNOWN_PROVIDER_ERROR`. La chaîne d'origine n'est JAMAIS renvoyée,
 * ni concaténée, ni journalée par cette fonction.
 */
export function normalizeNotificationErrorCode(
  raw: string | null | undefined
): NotificationErrorCode {
  if (typeof raw === "string" && TAXONOMY_SET.has(raw)) {
    return raw as NotificationErrorCode;
  }
  return "UNKNOWN_PROVIDER_ERROR";
}
