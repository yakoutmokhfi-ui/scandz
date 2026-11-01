import "server-only";
import { SMTP_SESSION_TOTAL_TIMEOUT_MS } from "@/lib/server/ack-mailer";

/**
 * MERCHANT SMTP v1 R1 (A196-05) -- BUDGET TEMPS DU WORKER.
 *
 * Invariant : un message réclamé doit pouvoir être traité ET complété avant
 * l'expiration de son bail, sinon `complete_notification_attempt` refuse la
 * complétion (SCANYM_NOTIFICATION_CLAIM_INVALID) alors que le message est déjà
 * parti, et la reprise (reap) provoque un doublon chez le client.
 *
 *   dernier envoi démarré au plus tard à RUN_BUDGET_MS
 *   + durée maximale d'une session (SMTP_SESSION_TOTAL_TIMEOUT_MS)
 *   < bail < maxDuration de la fonction
 *
 * Au-delà du budget, les lignes déjà réclamées mais non démarrées sont laissées
 * telles quelles : le bail expire et `reap_stale_notification_claims` les remet
 * en attente SANS consommer de tentative.
 */
export const WORKER_BATCH_SIZE = 25;
export const WORKER_RUN_BUDGET_MS = 150_000;
export const WORKER_LEASE_SECONDS = 300;
export const WORKER_MAX_DURATION_SECONDS = 300;

export function workerTimingIsConsistent(): boolean {
  const worstCaseMs = WORKER_RUN_BUDGET_MS + SMTP_SESSION_TOTAL_TIMEOUT_MS;
  return worstCaseMs < WORKER_LEASE_SECONDS * 1000 && WORKER_LEASE_SECONDS <= WORKER_MAX_DURATION_SECONDS;
}
