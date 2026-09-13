import "server-only";
import {
  handleOrderPaymentConfirmedForStuartDelivery,
  type StuartOrchestrationOutcome,
  type StuartOrchestrationTransport,
  type StuartOrchestrationTransportResult,
  type StuartOrderPickup,
  type StuartOrderDropoff,
} from "@/lib/server/delivery-providers/stuart/orchestration";
import type { StuartContact } from "@/lib/server/delivery-providers/stuart/types";

/**
 * STUART LOT D1 v1.1 — REMEDIATION CIBLÉE (blocage scope-compliance CTO,
 * mandat "TARGETED SCOPE-COMPLIANCE REMEDIATION — POST-PAYMENT HOOK
 * WIRING ONLY").
 *
 * ============================================================
 * CE QUE CE FICHIER FAIT (et RIEN de plus)
 * ============================================================
 *
 * Fournit le SEUL point d'entrée que `payment-provider-event-processor.ts`
 * (le traitement PARTAGÉ, unique, de `confirm_payment_attempt`) doit
 * appeler pour satisfaire le mandat D1 §B ("wire to the existing
 * authoritative payment-confirmed transition only") : `triggerStuartPost
 * PaymentOrchestration({orderId, restaurantId})`.
 *
 * Cette fonction délègue INTÉGRALEMENT à `handleOrderPaymentConfirmed
 * ForStuartDelivery` (D1 v1, INCHANGÉE, aucune ligne modifiée) -- qui
 * RÉ-ÉVALUE TOUJOURS l'éligibilité lui-même en premier (invariant "NO
 * payment confirmation → NO Stuart job allocation/send path", vérifié
 * par la matrice D1 v1). Si inéligible : zéro allocation, zéro appel
 * transport (mandat v1.1, item 5).
 *
 * ============================================================
 * POURQUOI UN TRANSPORT NON-LIVE ET UN PAYLOAD PLACEHOLDER
 * ============================================================
 *
 * `handleOrderPaymentConfirmedForStuartDelivery` exige, au niveau
 * TYPE (mandat D1 v1, INCHANGÉ) : un `transport` réel injectable, ET un
 * `pickup`/`dropoff` structurés (adresse + contact + `package_type`).
 * Or, à ce jour :
 *   - AUCUN transport HTTP réel n'existe (D1/D2, mandat §J : "real
 *     Stuart Production call" reste hors périmètre) ;
 *   - `STUART-PACKAGE-SIZE-MAPPING` reste explicitement `OPEN`
 *     (`types.ts`, ligne documentée : "AUCUNE valeur par défaut...
 *     jamais une valeur générique arbitraire" comme mapping business
 *     réel) -- aucune dérivation honnête de `pickup`/`dropoff`/
 *     `package_type` à partir d'une commande réelle n'existe encore
 *     nulle part dans ce dépôt.
 *
 * Fabriquer un `pickup`/`dropoff` qui SEMBLERAIT dérivé de la commande
 * réelle serait donc un mensonge structurel. La résolution retenue ICI
 * (mandat v1.1, littéral : "implement an explicit fail-closed/no-live
 * adapter at the wiring point") est la suivante, et est SANS AUCUNE
 * conséquence côté prestataire ou côté base :
 *
 *   1. `NON_LIVE_STUART_ORCHESTRATION_TRANSPORT` : un `StuartOrchestration
 *      Transport` qui n'effectue JAMAIS d'appel réseau -- il renvoie
 *      TOUJOURS `{networkFailure: true}`, INCONDITIONNELLEMENT, quel que
 *      soit le payload reçu. "Real Stuart transport remains impossible"
 *      est donc garanti STRUCTURELLEMENT, pas seulement documenté --
 *      exactement le même principe que `NON_LIVE_STUART_WEBHOOK_AUTH_
 *      ADAPTER` (mandat D1 v1 §E).
 *   2. Les constantes `NON_LIVE_PLACEHOLDER_PICKUP`/`_DROPOFF` : leurs
 *      valeurs sont des CHAÎNES-SENTINELLES EXPLICITEMENT non-réelles
 *      (`STUART_D1_NON_LIVE_PLACEHOLDER_*`), JAMAIS dérivées d'une
 *      commande réelle, JAMAIS persistées en base (`allocate_stuart_
 *      delivery_job`/les RPC de possession ne prennent QUE `id`/
 *      `order_id`/`restaurant_id` -- confirmé en lisant `allocation.ts` :
 *      AUCUNE colonne pickup/dropoff/package_type n'existe sur
 *      `stuart_delivery_jobs`), et JAMAIS transmises à quiconque
 *      (le SEUL consommateur de ce payload est `transport.createJob`,
 *      qui est le transport non-live ci-dessus -- il n'inspecte, ne
 *      journalise, ni ne transmet jamais son argument).
 *
 * Effet observable en production pour une commande ÉLIGIBLE une fois
 * ce lot câblé : une ligne `stuart_delivery_jobs` est allouée (RÉEL --
 * c'est le comportement VOULU, "payment-confirmed event wiring exists
 * now"), passe par `send_started`, puis -- puisque le transport est
 * TOUJOURS non-live -- est marquée `send_ambiguous` (mandat, "real
 * Stuart transport remains impossible"). Elle reste dans cet état
 * jusqu'à ce qu'un futur D2 fournisse un transport RÉEL (à ce
 * moment-là, `reap_stale_stuart_delivery_job_send_started`/un futur
 * mécanisme de reprise D2 la retraitera). Aucune commande n'est
 * bloquée, aucun paiement n'est affecté (voir le point d'appel dans
 * `payment-provider-event-processor.ts`, strictement best-effort).
 *
 * ============================================================
 * NON-NÉGOCIABLE (mandat v1.1)
 * ============================================================
 * Ce fichier n'importe, ne modifie et n'invoque JAMAIS : un transport
 * HTTP réel, `merchant-auth.ts`/`credential-resolver.ts`/`environment.ts`/
 * `create-job.ts`, un credential Stuart quelconque, ou le moindre champ
 * `payment_status`/sémantique de paiement. Il ne modifie NI LOT A-0/A/
 * B/C NI le suivi client NI CGV.
 */

/**
 * Transport garanti SANS AUCUN appel réseau -- voir le commentaire de
 * fichier. Retourne TOUJOURS `networkFailure: true`, jamais un succès,
 * jamais un statut HTTP fabriqué -- ce résultat fait transiter
 * l'allocation vers `send_ambiguous` (chemin EXISTANT, INCHANGÉ, D1 v1,
 * `orchestration.ts`), jamais un succès silencieux, jamais un échec
 * terminal supposé.
 */
export const NON_LIVE_STUART_ORCHESTRATION_TRANSPORT: StuartOrchestrationTransport = {
  async createJob(): Promise<StuartOrchestrationTransportResult> {
    return { raw: null, httpStatus: 0, networkFailure: true };
  },
};

/** Sentinelle NON-réelle -- voir le commentaire de fichier, point 2.
 *  JAMAIS dérivée d'une commande réelle, JAMAIS persistée, JAMAIS
 *  transmise (le seul consommateur est le transport non-live
 *  ci-dessus). */
const NON_LIVE_PLACEHOLDER_CONTACT: StuartContact = {
  phone: "0000000000",
  company: "STUART_D1_NON_LIVE_PLACEHOLDER_NOT_REAL_CUSTOMER_DATA",
};

const NON_LIVE_PLACEHOLDER_PICKUP: StuartOrderPickup = {
  address: "STUART_D1_NON_LIVE_PLACEHOLDER_PICKUP_ADDRESS",
  contact: NON_LIVE_PLACEHOLDER_CONTACT,
};

/** `package_type` : `STUART-PACKAGE-SIZE-MAPPING` reste `OPEN` (voir
 *  commentaire de fichier) -- cette valeur n'est PAS un mapping
 *  business, elle n'est JAMAIS transmise nulle part (transport
 *  non-live). Un futur D2, une fois un transport RÉEL câblé, DEVRA
 *  remplacer ce module entier par une dérivation réelle avant qu'une
 *  quelconque valeur ici n'atteigne un appel réseau réel. */
const NON_LIVE_PLACEHOLDER_DROPOFF: StuartOrderDropoff = {
  address: "STUART_D1_NON_LIVE_PLACEHOLDER_DROPOFF_ADDRESS",
  contact: NON_LIVE_PLACEHOLDER_CONTACT,
  packageType: "small",
};

export interface TriggerStuartPostPaymentOrchestrationInput {
  orderId: string;
  restaurantId: string;
}

/**
 * Point d'entrée UNIQUE à appeler depuis le traitement authoritatif de
 * paiement (mandat v1.1). Délègue intégralement à
 * `handleOrderPaymentConfirmedForStuartDelivery` (D1 v1, INCHANGÉE) avec
 * le transport non-live et le payload sentinelle ci-dessus -- ne fait
 * RIEN d'autre, ne contient AUCUNE logique métier propre.
 */
export async function triggerStuartPostPaymentOrchestration(
  input: TriggerStuartPostPaymentOrchestrationInput
): Promise<StuartOrchestrationOutcome> {
  return handleOrderPaymentConfirmedForStuartDelivery({
    orderId: input.orderId,
    restaurantId: input.restaurantId,
    pickup: NON_LIVE_PLACEHOLDER_PICKUP,
    dropoff: NON_LIVE_PLACEHOLDER_DROPOFF,
    transport: NON_LIVE_STUART_ORCHESTRATION_TRANSPORT,
  });
}
