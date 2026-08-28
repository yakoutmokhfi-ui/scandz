import "server-only";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 * ACQUITTEMENT DU CALLBACK.
 *
 * Octets exacts indépendamment confirmés (v2.0 §1.4.3.3, p.36, plage
 * atteinte par l'outil de récupération) : réponse `text/plain`, `<LF>`
 * = retour à la ligne simple (ASCII 10, PAS de retour chariot),
 * fenêtre de 30 secondes pour répondre côté Monetico.
 *
 * §22 : cet adaptateur expose UNIQUEMENT le générateur d'octets --
 * aucune route publique n'est ajoutée par ce lot (mandat §32, "no
 * public API route by default"). Le futur gestionnaire de route qui
 * appellera cette fonction, choisira le code HTTP, et enverra
 * réellement cette réponse au réseau Monetico est hors périmètre
 * (P3-B ou suivant).
 */

const SUCCESS_ACK = "version=2\ncdr=0\n";
const FAILURE_ACK = "version=2\ncdr=1\n";

export function buildMoneticoAcknowledgement(macValid: boolean): string {
  return macValid ? SUCCESS_ACK : FAILURE_ACK;
}
