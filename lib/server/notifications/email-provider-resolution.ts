import "server-only";
import type { EmailProvider } from "@/lib/server/notifications/email-provider";
import { isRealEmailSendActivated } from "@/lib/server/notifications/real-email-activation-gate";

/**
 * LOT 04 — TRANSACTIONAL EMAIL GOLDEN PATH — résolution du provider
 * RÉEL, FAIL-CLOSED.
 *
 * Seule autorité qui décide si un envoi e-mail réel peut avoir lieu.
 * Aujourd'hui, AUCUN provider réel n'est implémenté ni autorisé :
 * l'activation d'un envoi réel exige une autorisation CIO distincte.
 * Cette fonction renvoie donc TOUJOURS `null` -- porte plateforme
 * désactivée (défaut) comme porte activée par erreur. `null` signifie
 * "provider désactivé" : l'appelant ne réclame alors AUCUNE
 * notification et n'effectue AUCUN appel réseau (voir
 * `runTransactionalEmailWorker`, notification-worker.ts).
 *
 * Un futur lot autorisé branchera ici une implémentation réelle
 * derrière la même interface `EmailProvider`, uniquement dans la
 * branche où la porte est activée.
 */
export function resolveTransactionalEmailProvider(): EmailProvider | null {
  if (!isRealEmailSendActivated()) return null;
  // Porte activée mais aucun provider réel autorisé dans ce lot :
  // fail-closed, jamais un repli implicite vers un provider quelconque.
  return null;
}
