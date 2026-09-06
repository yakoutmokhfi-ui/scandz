import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import type { StuartEnvironment } from "@/lib/server/delivery-providers/stuart/environment";

/**
 * DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.1.
 *
 * CORRECTIF v2.1 : `allocate_stuart_delivery_job` retourne désormais
 * aussi `send_state`/`stuart_job_id` (évite un aller-retour
 * supplémentaire pour l'orchestration, voir create-job.ts) et une
 * colonne `collision` explicite (jamais résolue en SQL -- voir
 * STUART-V2-PGCRYPTO-QUALIFICATION-01, la dérivation d'une nouvelle
 * candidate en cas de collision est désormais À LA CHARGE DE
 * L'APPELANT Node, jamais de `digest()`/pgcrypto côté SQL).
 *
 * Ajout des wrappers du cycle de vie d'envoi durable
 * (STUART-V2-CREATE-JOB-DURABLE-AMBIGUITY-01) : chaque RPC est bornée
 * à la possession (order_id/restaurant_id), jamais une mutation par
 * UUID seul (STUART-V2-CORRELATION-INTEGRITY-01).
 */

export class StuartAllocationError extends Error {
  constructor(message: string = "STUART_ALLOCATION_ERROR") {
    super(message);
    this.name = "StuartAllocationError";
  }
}
export class StuartTenantIsolationError extends StuartAllocationError {
  constructor(message: string = "STUART_TENANT_ISOLATION_ERROR") {
    super(message);
    this.name = "StuartTenantIsolationError";
  }
}

export interface AllocateStuartDeliveryJobInput {
  orderId: string;
  restaurantId: string;
  environment: StuartEnvironment;
  candidateReference: string;
}

export type StuartSendState = "allocated" | "send_started" | "send_ambiguous" | "created_confirmed" | "terminal_failure";

export interface AllocatedStuartDeliveryJob {
  id: string;
  clientReference: string;
  isNewAllocation: boolean;
  collision: boolean;
  sendState: StuartSendState | null;
  stuartJobId: string | null;
}

function mapRpcError(error: { code?: string; message: string } | null): void {
  if (!error) return;
  if (error.code === "42501") throw new StuartTenantIsolationError();
  throw new StuartAllocationError(`STUART_ALLOCATION_FAILED_${error.code ?? "UNKNOWN"}`);
}

/**
 * Alloue (ou récupère -- idempotence) une ligne de corrélation
 * Stuart. Si `collision: true` est retourné, AUCUNE ligne n'a été
 * créée -- l'appelant DOIT recalculer une nouvelle
 * `candidateReference` et rappeler cette fonction (voir create-job.ts
 * pour la boucle de retry bornée établie).
 */
export async function allocateStuartDeliveryJob(input: AllocateStuartDeliveryJobInput): Promise<AllocatedStuartDeliveryJob> {
  const client = getServiceRoleSupabaseClient();
  let data: Array<{ id: string | null; client_reference: string | null; is_new_allocation: boolean; collision: boolean; send_state: string | null; stuart_job_id: string | null }> | null;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await client.rpc("allocate_stuart_delivery_job", {
      p_order_id: input.orderId,
      p_restaurant_id: input.restaurantId,
      p_environment: input.environment,
      p_candidate_reference: input.candidateReference,
    }));
  } catch {
    throw new StuartAllocationError("STUART_ALLOCATION_UNAVAILABLE");
  }
  mapRpcError(error);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new StuartAllocationError("STUART_ALLOCATION_EMPTY_ROW");

  if (row.collision) {
    return { id: "", clientReference: "", isNewAllocation: false, collision: true, sendState: null, stuartJobId: null };
  }

  return {
    id: row.id ?? "",
    clientReference: row.client_reference ?? "",
    isNewAllocation: row.is_new_allocation,
    collision: false,
    sendState: (row.send_state as StuartSendState) ?? null,
    stuartJobId: row.stuart_job_id,
  };
}

interface PossessionInput {
  id: string;
  orderId: string;
  restaurantId: string;
}

async function callPossessionRpc(name: string, input: PossessionInput, extra: Record<string, unknown> = {}): Promise<void> {
  const client = getServiceRoleSupabaseClient();
  const { error } = await client.rpc(name, {
    p_id: input.id,
    p_order_id: input.orderId,
    p_restaurant_id: input.restaurantId,
    ...extra,
  });
  if (error) throw new StuartAllocationError(`STUART_${name.toUpperCase()}_FAILED_${error.code ?? "UNKNOWN"}`);
}

export async function markStuartDeliveryJobSendStarted(input: PossessionInput): Promise<void> {
  await callPossessionRpc("mark_stuart_delivery_job_send_started", input);
}
export async function markStuartDeliveryJobAmbiguous(input: PossessionInput): Promise<void> {
  await callPossessionRpc("mark_stuart_delivery_job_ambiguous", input);
}
export async function markStuartDeliveryJobTerminalFailure(input: PossessionInput): Promise<void> {
  await callPossessionRpc("mark_stuart_delivery_job_terminal_failure", input);
}
export async function confirmStuartDeliveryJobCreated(input: PossessionInput & { stuartJobId: string }): Promise<void> {
  await callPossessionRpc("confirm_stuart_delivery_job_created", input, { p_stuart_job_id: input.stuartJobId });
}
