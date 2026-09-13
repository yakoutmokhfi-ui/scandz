import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/**
 * STUART LOT D1 §D — PROVIDER EVENT INBOX FOUNDATION.
 *
 * Enveloppe TYPÉE de `stuart_provider_events` (table RPC-only, RLS +
 * REVOKE ALL y compris service_role) et de ses trois RPC
 * (`record_stuart_provider_event`, `claim_stuart_provider_events`,
 * `update_stuart_provider_event_processing_status`) — modelée sur
 * `payment-service.ts`'s `recordPaymentProviderEvent`/
 * `claimPaymentProviderEvents`/`updatePaymentProviderEventProcessingStatus`
 * (PAYMENT P3-B5 v2), MÊME discipline : AUCUNE erreur Postgrest brute ne
 * traverse ce module, AUCUN secret/MAC/signature n'est vérifié ici
 * (adaptateur d'authentification distinct, voir webhook-auth-adapter.ts).
 *
 * DIFFÉRENCE délibérée (mandat §D, "unknown job / early webhook") :
 * `stuartDeliveryJobId`/`restaurantId` sont TOUJOURS `string | null` en
 * sortie — un évènement peut légitimement n'avoir aucune corrélation
 * résolue, jamais une erreur pour ce seul motif.
 */

export class StuartProviderEventError extends Error {
  constructor(message: string = "STUART_PROVIDER_EVENT_ERROR") {
    super(message);
    this.name = "StuartProviderEventError";
  }
}

export interface RecordStuartProviderEventInput {
  /** SHA-256 complet (64 hex minuscules), calculé par l'appelant à
   *  partir de la charge canonicalisée du fixture/adaptateur — JAMAIS
   *  calculé par ce module (même discipline que
   *  `recordPaymentProviderEvent`, qui délègue la canonicalisation à un
   *  module dédié séparé). */
  eventFingerprint: string;
  providerEventType: string;
  providerJobIdRaw?: string | null;
  providerStatusRaw?: string | null;
}

export interface StuartProviderEventRecord {
  id: string;
  stuartDeliveryJobId: string | null;
  restaurantId: string | null;
  processingStatus: string;
  createdAt: string;
  isNewEvent: boolean;
}

/**
 * Enregistre durablement UN évènement prestataire Stuart via
 * `record_stuart_provider_event`. Corrélation MEILLEURE-EFFORT
 * (jamais requise) — un `providerJobIdRaw` sans correspondance locale
 * laisse `stuartDeliveryJobId`/`restaurantId` à `null`, JAMAIS une
 * erreur (mandat §D). Idempotent sous rejeu exact du même
 * `eventFingerprint` (`isNewEvent: false`).
 */
export async function recordStuartProviderEvent(
  input: RecordStuartProviderEventInput
): Promise<StuartProviderEventRecord> {
  const client = getServiceRoleSupabaseClient();
  let data:
    | Array<{ id: string; stuart_delivery_job_id: string | null; restaurant_id: string | null; processing_status: string; created_at: string; is_new_event: boolean }>
    | { id: string; stuart_delivery_job_id: string | null; restaurant_id: string | null; processing_status: string; created_at: string; is_new_event: boolean }
    | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("record_stuart_provider_event", {
      p_event_fingerprint: input.eventFingerprint,
      p_provider_event_type: input.providerEventType,
      p_provider_job_id_raw: input.providerJobIdRaw ?? null,
      p_provider_status_raw: input.providerStatusRaw ?? null,
    }));
  } catch {
    throw new StuartProviderEventError("STUART_PROVIDER_EVENT_RECORD_UNAVAILABLE");
  }
  if (error) {
    throw new StuartProviderEventError(`STUART_PROVIDER_EVENT_RECORD_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new StuartProviderEventError("STUART_PROVIDER_EVENT_RECORD_EMPTY_ROW");
  }
  return {
    id: row.id,
    stuartDeliveryJobId: row.stuart_delivery_job_id,
    restaurantId: row.restaurant_id,
    processingStatus: row.processing_status,
    createdAt: row.created_at,
    isNewEvent: Boolean(row.is_new_event),
  };
}

export interface ClaimedStuartProviderEvent {
  id: string;
  stuartDeliveryJobId: string | null;
  restaurantId: string | null;
  providerJobIdRaw: string | null;
  eventFingerprint: string;
  providerEventType: string;
  providerStatusRaw: string | null;
  processingStatus: string;
  retryCount: number;
  claimToken: string;
  claimExpiresAt: string;
  /** Horodatage de RÉCEPTION DURABLE locale (jamais un horodatage
   *  prestataire prouvé -- aucun contrat d'évènement Stuart réel n'est
   *  encore établi, mandat §J). Utilisé par `webhook-processor.ts`
   *  comme approximation d'ordonnancement en l'ABSENCE d'un horodatage
   *  prestataire fourni par le fixture -- documenté explicitement comme
   *  tel, jamais présenté comme une preuve d'ordre prestataire réelle. */
  createdAt: string;
}

/**
 * Revendique un lot BORNÉ d'évènements éligibles
 * (`received`/`failed_retryable`, bail expiré ou jamais posé) via
 * `claim_stuart_provider_events` — primitif de file de travail sûr
 * sous concurrence (`FOR UPDATE SKIP LOCKED` côté SQL). Le
 * `claimToken` retourné DOIT être fourni tel quel à
 * `updateStuartProviderEventProcessingStatus` pour finaliser chaque
 * évènement.
 */
export async function claimStuartProviderEvents(input: {
  batchSize?: number;
  leaseSeconds?: number;
} = {}): Promise<ClaimedStuartProviderEvent[]> {
  const client = getServiceRoleSupabaseClient();
  let data:
    | Array<{
        id: string; stuart_delivery_job_id: string | null; restaurant_id: string | null; provider_job_id_raw: string | null;
        event_fingerprint: string; provider_event_type: string; provider_status_raw: string | null;
        processing_status: string; retry_count: number; claim_token: string; claim_expires_at: string; created_at: string;
      }>
    | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("claim_stuart_provider_events", {
      p_batch_size: input.batchSize ?? 20,
      p_lease_seconds: input.leaseSeconds ?? 60,
    }));
  } catch {
    throw new StuartProviderEventError("STUART_PROVIDER_EVENT_CLAIM_UNAVAILABLE");
  }
  if (error) {
    throw new StuartProviderEventError(`STUART_PROVIDER_EVENT_CLAIM_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    stuartDeliveryJobId: row.stuart_delivery_job_id,
    restaurantId: row.restaurant_id,
    providerJobIdRaw: row.provider_job_id_raw,
    eventFingerprint: row.event_fingerprint,
    providerEventType: row.provider_event_type,
    providerStatusRaw: row.provider_status_raw,
    processingStatus: row.processing_status,
    retryCount: row.retry_count,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
  }));
}

/** Valeurs EXACTES acceptées par `p_new_status` — `'received'` n'en
 *  fait jamais partie (état initial, jamais une cible de transition). */
export type StuartProviderEventProcessingTargetStatus = "applied" | "ignored" | "failed_retryable" | "failed_terminal";

export interface UpdateStuartProviderEventProcessingStatusInput {
  eventId: string;
  claimToken: string;
  newStatus: StuartProviderEventProcessingTargetStatus;
  errorClass?: string | null;
  /** Corrélation tardive (mandat §D) — UNIQUEMENT si l'évènement n'a
   *  encore AUCUNE corrélation résolue ; ignoré silencieusement (côté
   *  SQL) si une corrélation existe déjà (jamais réécrite). */
  resolvedStuartDeliveryJobId?: string | null;
}

export interface StuartProviderEventProcessingStatusResult {
  id: string;
  processingStatus: string;
  retryCount: number;
  processedAt: string;
  stuartDeliveryJobId: string | null;
}

/**
 * Transitionne le `processingStatus` d'un évènement précédemment
 * revendiqué, via `update_stuart_provider_event_processing_status` —
 * machine à états à verrouillage terminal identique à
 * `updatePaymentProviderEventProcessingStatus` (PAYMENT P3-B5 v2) :
 * un jeton de bail périmé ou incorrect est rejeté fail-closed ; le
 * replay idempotent d'un état déjà terminal reste exempté de cette
 * vérification.
 */
export async function updateStuartProviderEventProcessingStatus(
  input: UpdateStuartProviderEventProcessingStatusInput
): Promise<StuartProviderEventProcessingStatusResult> {
  const client = getServiceRoleSupabaseClient();
  let data:
    | Array<{ id: string; processing_status: string; retry_count: number; processed_at: string; stuart_delivery_job_id: string | null }>
    | { id: string; processing_status: string; retry_count: number; processed_at: string; stuart_delivery_job_id: string | null }
    | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("update_stuart_provider_event_processing_status", {
      p_event_id: input.eventId,
      p_claim_token: input.claimToken,
      p_new_status: input.newStatus,
      p_error_class: input.errorClass ?? null,
      p_resolved_stuart_delivery_job_id: input.resolvedStuartDeliveryJobId ?? null,
    }));
  } catch {
    throw new StuartProviderEventError("STUART_PROVIDER_EVENT_UPDATE_UNAVAILABLE");
  }
  if (error) {
    throw new StuartProviderEventError(`STUART_PROVIDER_EVENT_UPDATE_FAILED_${error.code ?? "UNKNOWN"}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new StuartProviderEventError("STUART_PROVIDER_EVENT_UPDATE_EMPTY_ROW");
  }
  return {
    id: row.id,
    processingStatus: row.processing_status,
    retryCount: row.retry_count,
    processedAt: row.processed_at,
    stuartDeliveryJobId: row.stuart_delivery_job_id,
  };
}
