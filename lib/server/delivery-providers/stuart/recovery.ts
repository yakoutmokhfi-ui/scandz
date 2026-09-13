import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/**
 * STUART LOT D1 §C/§F/§G — CRASH RECOVERY, ORDERED STATUS APPLICATION,
 * LOCAL CANCELLATION.
 *
 * Enveloppes TYPÉES des RPC narrow ajoutées par
 * supabase/DRAFT-lot-stuart-provider-events-foundation-v1.sql, en
 * ADDITION STRICTE de `stuart_delivery_jobs` (v2.1, INCHANGÉE) :
 *   - `reap_stale_stuart_delivery_job_send_started` (§C) ;
 *   - `apply_stuart_delivery_job_status_if_newer` (§F) ;
 *   - `record_stuart_delivery_job_local_cancellation` (§G).
 * AUCUN appel HTTP réel Stuart n'est effectué par ce module — toutes
 * ces fonctions sont des primitives SQL pures (balayage/transition
 * d'état local).
 */

export class StuartRecoveryError extends Error {
  constructor(message: string = "STUART_RECOVERY_ERROR") {
    super(message);
    this.name = "StuartRecoveryError";
  }
}

export interface ReapedStuartDeliveryJob {
  id: string;
  orderId: string;
  restaurantId: string;
  previousSendState: string;
  newSendState: string;
}

/**
 * Balaie les lignes `stuart_delivery_jobs` bloquées à `send_started`
 * depuis plus de `staleAfterSeconds` (crash entre l'envoi HTTP et sa
 * confirmation/ambiguïté, mandat §C) et les fait transiter vers
 * `send_ambiguous` — EXACTEMENT la même transition que
 * `markStuartDeliveryJobAmbiguous` (allocation.ts, INCHANGÉE), jamais
 * un nouvel état. Concurrent-worker-safe (`FOR UPDATE SKIP LOCKED`
 * côté SQL) — deux appels concurrents ne traitent jamais la même
 * ligne deux fois. Ne renvoie et n'exécute JAMAIS d'appel HTTP Stuart.
 */
export async function reapStaleStuartDeliveryJobSendStarted(input: {
  staleAfterSeconds?: number;
  batchSize?: number;
} = {}): Promise<ReapedStuartDeliveryJob[]> {
  const client = getServiceRoleSupabaseClient();
  let data: Array<{ id: string; order_id: string; restaurant_id: string; previous_send_state: string; new_send_state: string }> | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("reap_stale_stuart_delivery_job_send_started", {
      p_stale_after_seconds: input.staleAfterSeconds ?? 120,
      p_batch_size: input.batchSize ?? 50,
    }));
  } catch {
    throw new StuartRecoveryError("STUART_REAP_UNAVAILABLE");
  }
  if (error) {
    throw new StuartRecoveryError(`STUART_REAP_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    restaurantId: row.restaurant_id,
    previousSendState: row.previous_send_state,
    newSendState: row.new_send_state,
  }));
}

interface PossessionInput {
  id: string;
  orderId: string;
  restaurantId: string;
}

/**
 * Enregistre LOCALEMENT qu'une commande a été annulée après
 * allocation/envoi/confirmation d'un job Stuart (mandat §G) — N'APPELLE
 * JAMAIS Stuart (aucune annulation prestataire réelle, non autorisée en
 * D1). N'altère JAMAIS `send_state`/`stuart_job_id`. Un second appel sur
 * une ligne déjà marquée échoue fermé (pas un no-op — voir la RPC SQL).
 */
export async function recordStuartDeliveryJobLocalCancellation(input: PossessionInput): Promise<void> {
  const client = getServiceRoleSupabaseClient();
  const { error } = await client.rpc("record_stuart_delivery_job_local_cancellation", {
    p_id: input.id,
    p_order_id: input.orderId,
    p_restaurant_id: input.restaurantId,
  });
  if (error) {
    throw new StuartRecoveryError(`STUART_LOCAL_CANCELLATION_FAILED_${error.code ?? "UNKNOWN"}`);
  }
}

/** Valeurs KNOWN reconnues côté job -- IDENTIQUES à la contrainte CHECK
 *  SQL de stuart_delivery_jobs.job_status_known (v2.1, INCHANGÉE). */
export type StuartJobStatusKnown = "new" | "scheduled" | "searching" | "in_progress" | "finished" | "canceled" | "expired";
/** Idem, delivery_status_known. */
export type StuartDeliveryStatusKnown =
  | "pending" | "picking" | "almost_picking" | "waiting_at_pickup" | "delivering"
  | "almost_delivering" | "waiting_at_dropoff" | "delivered" | "cancelled";
/** Idem, package_status_known. */
export type StuartPackageStatusKnown =
  | "package_created" | "courier_assigned" | "courier_arriving_at_pickup" | "courier_waiting_at_pickup"
  | "package_delivering" | "courier_arriving_at_dropoff" | "courier_waiting_at_dropoff"
  | "package_delivered" | "package_canceled";

export interface ApplyStuartDeliveryJobStatusIfNewerInput extends PossessionInput {
  /** Horodatage PRESTATAIRE de l'évènement (jamais l'horodatage de
   *  réception locale) -- ancre de l'ordonnancement (mandat §F). */
  providerEventAt: Date | string;
  jobStatusRaw?: string | null;
  deliveryStatusRaw?: string | null;
  packageStatusRaw?: string | null;
}

export interface ApplyStuartDeliveryJobStatusIfNewerResult {
  applied: boolean;
  jobStatusKnown: StuartJobStatusKnown | null;
  deliveryStatusKnown: StuartDeliveryStatusKnown | null;
  packageStatusKnown: StuartPackageStatusKnown | null;
}

/**
 * Applique une mise à jour de statut fixture/prestataire à une ligne
 * `stuart_delivery_jobs`, UNIQUEMENT si `providerEventAt` est
 * strictement postérieur au dernier évènement déjà appliqué (mandat
 * §F, "out-of-order older events must not regress newer authoritative
 * state") — un évènement plus ancien est silencieusement ignoré
 * (`applied: false`), JAMAIS une erreur. Les valeurs RAW sont TOUJOURS
 * stockées fidèlement (côté SQL) même si elles ne correspondent à
 * aucune valeur KNOWN reconnue — cette fonction ne crashe JAMAIS sur un
 * statut inconnu (mandat §F, "unknown statuses must not crash").
 */
export async function applyStuartDeliveryJobStatusIfNewer(
  input: ApplyStuartDeliveryJobStatusIfNewerInput
): Promise<ApplyStuartDeliveryJobStatusIfNewerResult> {
  const client = getServiceRoleSupabaseClient();
  const providerEventAt =
    input.providerEventAt instanceof Date ? input.providerEventAt.toISOString() : input.providerEventAt;

  let data:
    | Array<{ applied: boolean; job_status_known: string | null; delivery_status_known: string | null; package_status_known: string | null }>
    | { applied: boolean; job_status_known: string | null; delivery_status_known: string | null; package_status_known: string | null }
    | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("apply_stuart_delivery_job_status_if_newer", {
      p_id: input.id,
      p_order_id: input.orderId,
      p_restaurant_id: input.restaurantId,
      p_provider_event_at: providerEventAt,
      p_job_status_raw: input.jobStatusRaw ?? null,
      p_delivery_status_raw: input.deliveryStatusRaw ?? null,
      p_package_status_raw: input.packageStatusRaw ?? null,
    }));
  } catch {
    throw new StuartRecoveryError("STUART_STATUS_APPLY_UNAVAILABLE");
  }
  if (error) {
    throw new StuartRecoveryError(`STUART_STATUS_APPLY_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new StuartRecoveryError("STUART_STATUS_APPLY_EMPTY_ROW");
  }
  return {
    applied: Boolean(row.applied),
    jobStatusKnown: (row.job_status_known as StuartJobStatusKnown | null) ?? null,
    deliveryStatusKnown: (row.delivery_status_known as StuartDeliveryStatusKnown | null) ?? null,
    packageStatusKnown: (row.package_status_known as StuartPackageStatusKnown | null) ?? null,
  };
}
