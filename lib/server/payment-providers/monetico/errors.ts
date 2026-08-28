import "server-only";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 *
 * Taxonomie d'erreurs SPÉCIFIQUE à l'adaptateur Monetico -- distincte
 * de la taxonomie générique `lib/server/payment-errors.ts` (PAYMENT
 * P3-A1), qui avait explicitement réservé les erreurs propres à un
 * prestataire aux lots d'adaptateur futurs ("provider-specific errors
 * belong to adapter lots"). Comme pour P3-A1, chaque message par
 * défaut reste STABLE et GÉNÉRIQUE -- jamais dérivé d'une valeur de
 * credential, de MAC, ou de champ de callback.
 */

export class MoneticoCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneticoCredentialError";
  }
}

/** Levée uniquement lorsqu'un MAC ne correspond pas -- ne porte
 *  jamais le MAC reçu, le MAC attendu, ni la chaîne canonique
 *  utilisée pour le calcul (mandat §28). */
export class MoneticoMacVerificationError extends Error {
  constructor(message: string = "MONETICO_MAC_INVALID") {
    super(message);
    this.name = "MoneticoMacVerificationError";
  }
}

export class MoneticoCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneticoCallbackError";
  }
}

/** Erreur de protocole générale (format de montant/devise/langue
 *  invalide, clé de sécurité mal formée, etc.). */
export class MoneticoProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneticoProtocolError";
  }
}
