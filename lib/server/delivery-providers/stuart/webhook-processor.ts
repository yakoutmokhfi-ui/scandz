import "server-only";
import { claimStuartProviderEvents, updateStuartProviderEventProcessingStatus, type ClaimedStuartProviderEvent } from "@/lib/server/delivery-providers/stuart/provider-events";
import { applyStuartDeliveryJobStatusIfNewer } from "@/lib/server/delivery-providers/stuart/recovery";

/**
 * STUART LOT D1 §E/§F — WEBHOOK ROUTE FOUNDATION (3/3 : PROCESSEUR) +
 * FIXTURE-BASED NORMALIZED STATUS PROCESSING.
 *
 * Revendique un lot d'évènements (`claim_stuart_provider_events`) et
 * applique, pour chacun, la mise à jour de statut normalisée
 * correspondante -- SÉPARÉ de l'ingestion (`webhook-ingestion.ts`),
 * mandat §E. AUCUN appel HTTP Stuart -- ce processeur ne fait que lire/
 * écrire l'état local déjà persisté.
 *
 * CORRÉLATION INCONNUE (mandat §D, "must not 500 merely because job id
 * is unknown") : un évènement dont `stuartDeliveryJobId` est encore
 * `null` est transitionné vers `failed_retryable` (jamais une erreur
 * non gérée, jamais `ignored` définitivement -- une résolution
 * ultérieure reste possible si le job apparaît plus tard) avec
 * `errorClass: "STUART_UNKNOWN_JOB_AWAITING_CORRELATION"`.
 *
 * RÉSOLUTION order_id (mandat "never a mutation by UUID alone") : les
 * RPC possession-scopées de `stuart_delivery_jobs` exigent (id,
 * order_id, restaurant_id) ensemble -- ce processeur ne devine JAMAIS
 * `order_id`, il exige un `resolver` explicite fourni par l'appelant
 * (fixture de test ou futur worker D2).
 *
 * ORDONNANCEMENT (mandat §F) : utilise
 * `ClaimedStuartProviderEvent.createdAt` (horodatage de RÉCEPTION
 * LOCALE) comme approximation d'ordonnancement en l'absence d'un
 * horodatage prestataire prouvé (aucun contrat d'évènement Stuart réel
 * n'existe encore, mandat §J) -- documenté explicitement comme tel.
 * `applyStuartDeliveryJobStatusIfNewer` garantit qu'un évènement plus
 * ancien qu'un déjà appliqué ne régresse JAMAIS l'état connu.
 */

export interface StuartProviderEventOrderIdResolver {
  /** Résout `order_id` pour un `stuart_delivery_job_id` donné --
   *  possession déjà garantie par la FK composite
   *  (stuart_delivery_job_id, restaurant_id) posée à la persistance de
   *  l'évènement (mandat §D) ; ce résolveur n'a JAMAIS besoin de
   *  vérifier l'isolation tenant lui-même. Renvoie `null` si
   *  irrésolvable (traité comme une reprise différée, jamais une
   *  erreur non gérée). */
  resolveOrderId(input: { stuartDeliveryJobId: string; restaurantId: string }): Promise<string | null>;
}

export interface ProcessedStuartProviderEventOutcome {
  eventId: string;
  outcome: "applied" | "unknown_job_retry" | "processing_error";
}

async function processOne(
  event: ClaimedStuartProviderEvent,
  resolver: StuartProviderEventOrderIdResolver
): Promise<ProcessedStuartProviderEventOutcome> {
  if (!event.stuartDeliveryJobId || !event.restaurantId) {
    await updateStuartProviderEventProcessingStatus({
      eventId: event.id,
      claimToken: event.claimToken,
      newStatus: "failed_retryable",
      errorClass: "STUART_UNKNOWN_JOB_AWAITING_CORRELATION",
    });
    return { eventId: event.id, outcome: "unknown_job_retry" };
  }

  try {
    const orderId = await resolver.resolveOrderId({
      stuartDeliveryJobId: event.stuartDeliveryJobId,
      restaurantId: event.restaurantId,
    });
    if (!orderId) {
      await updateStuartProviderEventProcessingStatus({
        eventId: event.id,
        claimToken: event.claimToken,
        newStatus: "failed_retryable",
        errorClass: "STUART_ORDER_ID_RESOLUTION_FAILED",
      });
      return { eventId: event.id, outcome: "unknown_job_retry" };
    }

    await applyStuartDeliveryJobStatusIfNewer({
      id: event.stuartDeliveryJobId,
      orderId,
      restaurantId: event.restaurantId,
      providerEventAt: event.createdAt,
      jobStatusRaw: event.providerStatusRaw,
    });

    await updateStuartProviderEventProcessingStatus({
      eventId: event.id,
      claimToken: event.claimToken,
      newStatus: "applied",
    });
    return { eventId: event.id, outcome: "applied" };
  } catch (err) {
    await updateStuartProviderEventProcessingStatus({
      eventId: event.id,
      claimToken: event.claimToken,
      newStatus: "failed_retryable",
      errorClass: err instanceof Error ? err.name : "STUART_WEBHOOK_PROCESSING_ERROR",
    });
    return { eventId: event.id, outcome: "processing_error" };
  }
}

/**
 * Revendique et traite un lot borné d'évènements `stuart_provider_events`
 * éligibles. `resolver` fournit `order_id` pour un job résolu -- fourni
 * par l'appelant, jamais deviné par ce module.
 */
export async function processClaimedStuartProviderEvents(
  resolver: StuartProviderEventOrderIdResolver,
  options: { batchSize?: number; leaseSeconds?: number } = {}
): Promise<ProcessedStuartProviderEventOutcome[]> {
  const claimed = await claimStuartProviderEvents(options);
  const results: ProcessedStuartProviderEventOutcome[] = [];
  for (const event of claimed) {
    results.push(await processOne(event, resolver));
  }
  return results;
}
