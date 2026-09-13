import "server-only";
import {
  allocateStuartDeliveryJob,
  markStuartDeliveryJobSendStarted,
  markStuartDeliveryJobAmbiguous,
  markStuartDeliveryJobTerminalFailure,
  confirmStuartDeliveryJobCreated,
  StuartAllocationError,
} from "@/lib/server/delivery-providers/stuart/allocation";
import { deriveStuartClientReferenceCandidate } from "@/lib/server/delivery-providers/stuart/client-reference";
import { getStuartDeliveryEligibility, type StuartDeliveryIneligibilityReasonCode } from "@/lib/server/delivery-providers/stuart/eligibility";
import type { StuartCreateJobPayload, StuartContact, StuartPackageType, StuartPartnerData } from "@/lib/server/delivery-providers/stuart/types";
import { createHash } from "node:crypto";

/**
 * STUART LOT D1 §B — POST-PAYMENT ORCHESTRATION HOOK (MOCK/FIXTURE
 * ONLY).
 *
 * "NOT full Stuart Production activation" (mandat D1, littéral) : ce
 * module N'IMPORTE NI `auth.ts` NI `environment.ts` NI `create-job.ts`
 * (leur chemin credential/HTTP global/sandbox-diagnostic est
 * explicitement INTERDIT pour tout chemin marchand réel, mandat §I) --
 * et n'importe pas non plus `merchant-auth.ts`/`credential-resolver.ts`
 * : AUCUN appel HTTP réel n'étant autorisé par ce lot (mandat, "no real
 * Stuart HTTP call is authorized"), il n'existe structurellement AUCUN
 * besoin de résoudre un secret marchand réel ici -- la résolution
 * credential réelle reste explicitement différée à un futur lot D2 qui
 * câblera un transport HTTP réel (mandat §J, "real Stuart Production
 * call" hors périmètre D1).
 *
 * INVARIANT CENTRAL (mandat §B, littéral) : "NO payment confirmation →
 * NO Stuart job allocation/send path" -- `handleOrderPaymentConfirmed
 * ForStuartDelivery` RÉ-ÉVALUE TOUJOURS lui-même l'éligibilité (via
 * `getStuartDeliveryEligibility`, qui vérifie entre autres
 * `orders.payment_status = 'paid'`) AVANT toute allocation -- même si
 * un futur appelant D2 invoque ce hook directement depuis le chemin
 * `confirm_payment_attempt`, la vérification n'est JAMAIS présumée déjà
 * faite par l'appelant (défense en profondeur structurelle : ce hook
 * reste sûr même mal câblé). AUCUN chemin d'appel réel de ce hook
 * n'existe encore dans `payment-service.ts`/les routes applicatives à
 * l'issue de ce lot -- le câblage réel du point d'accroche (juste après
 * `confirm_payment_attempt`/`confirmPaymentAttempt`, mandat §B "wire to
 * the existing authoritative payment-confirmed transition only") reste
 * un futur D2, cette fonction étant la surface prête à être invoquée.
 *
 * REJEU DE CALLBACK PAIEMENT (mandat §B, "payment callback replay must
 * not create a second logical job") : garanti par
 * `allocateStuartDeliveryJob` lui-même (idempotent, `is_active`
 * unique par commande, INCHANGÉ) -- un second appel de ce hook pour la
 * même commande renvoie TOUJOURS la même ligne logique.
 *
 * TRANSPORT INJECTABLE UNIQUEMENT (mandat, "orchestration must support
 * injected/mock transport or equivalent test seam") : `transport` est
 * un paramètre REQUIS, sans valeur par défaut ni implémentation réelle
 * fournie par ce module -- AUCUN appel `fetch` n'est jamais effectué
 * ici. "Production/live transport remains disabled/unwired" est donc
 * garanti STRUCTURELLEMENT : aucun code de ce lot ne fournit ni
 * n'invoque un transport réel.
 */

export class StuartOrchestrationError extends Error {
  constructor(message: string = "STUART_ORCHESTRATION_ERROR") {
    super(message);
    this.name = "StuartOrchestrationError";
  }
}

export interface StuartOrchestrationTransportResult {
  raw: unknown;
  httpStatus: number;
  networkFailure: boolean;
}

/**
 * Frontière de transport INJECTABLE -- mandat "Mocked HTTP only". Une
 * implémentation réelle (D2) enverrait la requête `POST /v2/jobs` avec
 * un jeton résolu via `merchant-auth.ts`/`credential-resolver.ts` ;
 * AUCUNE implémentation de ce type n'est fournie par ce lot.
 */
export interface StuartOrchestrationTransport {
  createJob(payload: StuartCreateJobPayload): Promise<StuartOrchestrationTransportResult>;
}

const MAX_COLLISION_RETRIES = 5;

/** MÊME allowlist terminale, délibérément vide, que create-job.ts
 *  v2.2 (mandat item 11, "fixture 5xx → bounded retry classification
 *  according to CURRENT PROVEN DESIGN" -- préserver, ne pas
 *  reclassifier sans preuve documentaire, mandat §J). */
const DOCUMENTED_TERMINAL_HTTP_STATUSES: ReadonlySet<number> = new Set([]);

function classifyHttpOutcome(status: number): "terminal" | "ambiguous" {
  if (DOCUMENTED_TERMINAL_HTTP_STATUSES.has(status)) return "terminal";
  return "ambiguous";
}

/** MÊME contrat de validation que create-job.ts v2.2 (identifiant
 *  numérique Stuart documenté, canonicalisé en chaîne exacte). Dupliqué
 *  ici délibérément (create-job.ts ne l'exporte pas) -- convergence
 *  triviale prévue pour un futur D2 qui unifierait les deux chemins
 *  d'envoi derrière un seul transport réel. */
function validateCreateJobResponse(raw: unknown): { id: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>).id;
  if (typeof id !== "number") return null;
  if (!Number.isFinite(id) || !Number.isInteger(id) || !Number.isSafeInteger(id)) return null;
  if (id <= 0) return null;
  return { id: String(id) };
}

export interface StuartOrderPickup {
  address: string;
  contact: StuartContact;
  comment?: string;
}
export interface StuartOrderDropoff {
  address: string;
  contact: StuartContact;
  packageType: StuartPackageType;
  packageDescription?: string;
  comment?: string;
}

export interface HandleOrderPaymentConfirmedForStuartDeliveryInput {
  orderId: string;
  restaurantId: string;
  pickup: StuartOrderPickup;
  dropoff: StuartOrderDropoff;
  transport: StuartOrchestrationTransport;
  pickupAt?: string;
  partnerData?: StuartPartnerData;
}

export type StuartOrchestrationOutcome =
  | { status: "ineligible"; reasonCode: StuartDeliveryIneligibilityReasonCode }
  | { status: "already_created_confirmed"; jobRowId: string; stuartJobId: string }
  | { status: "blocked_by_prior_ambiguity"; jobRowId: string }
  | { status: "created_confirmed"; jobRowId: string; stuartJobId: string }
  | { status: "send_ambiguous"; jobRowId: string }
  | { status: "terminal_failure"; jobRowId: string; httpStatus: number }
  | { status: "allocation_collision_exhausted" };

/**
 * Point d'accroche post-paiement (mandat §B) : à invoquer (par un futur
 * D2) immédiatement après que `confirmPaymentAttempt`/
 * `confirm_payment_attempt` (PAYMENT P1, INCHANGÉE) ait confirmé le
 * paiement d'une commande. Ré-évalue TOUJOURS l'éligibilité lui-même
 * (invariant central, voir commentaire de fichier) -- si inéligible
 * (y compris "paiement non confirmé"), retourne `{status:
 * "ineligible", reasonCode}` SANS AUCUN appel transport, SANS AUCUNE
 * allocation.
 *
 * IDEMPOTENT (mandat §B/items 5/6) : un second appel pour la même
 * commande ne crée jamais un second job logique -- `already_created_
 * confirmed`/`blocked_by_prior_ambiguity` sont renvoyés sans jamais
 * ré-appeler le transport.
 */
export async function handleOrderPaymentConfirmedForStuartDelivery(
  input: HandleOrderPaymentConfirmedForStuartDeliveryInput
): Promise<StuartOrchestrationOutcome> {
  const eligibility = await getStuartDeliveryEligibility({ orderId: input.orderId, restaurantId: input.restaurantId });
  if (!eligibility.eligible) {
    return { status: "ineligible", reasonCode: eligibility.reasonCode };
  }

  let allocation: Awaited<ReturnType<typeof allocateStuartDeliveryJob>> | undefined;
  let candidate = deriveStuartClientReferenceCandidate(input.orderId);
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
    const result = await allocateStuartDeliveryJob({
      orderId: input.orderId,
      restaurantId: input.restaurantId,
      // STUART LOT D1 v1.2 (remédiation Cat Stevens, blocker 2 HIGH) --
      // AUTORITÉ D'ENVIRONNEMENT : plus jamais "sandbox" codé en dur.
      // `eligibility.merchantEnvironment` provient EXCLUSIVEMENT de
      // `delivery_provider_configs.mode` (LOT A-0), lu par la MÊME RPC
      // d'éligibilité ci-dessus -- jamais une variable d'environnement
      // globale, jamais un mode plateforme. TypeScript garantit que ce
      // champ n'existe QUE sur la branche `eligible: true` (le early
      // return ci-dessus l'a déjà établi) -- aucune valeur par défaut
      // n'est nécessaire ni fournie.
      environment: eligibility.merchantEnvironment,
      candidateReference: candidate,
    });
    if (!result.collision) {
      allocation = result;
      break;
    }
    candidate = createHash("sha256").update(`${input.orderId}:${attempt + 1}`, "utf8").digest("hex").slice(0, 10).toUpperCase();
  }
  if (!allocation) {
    return { status: "allocation_collision_exhausted" };
  }

  if (allocation.sendState === "created_confirmed") {
    return { status: "already_created_confirmed", jobRowId: allocation.id, stuartJobId: allocation.stuartJobId ?? "" };
  }
  if (allocation.sendState === "send_ambiguous") {
    return { status: "blocked_by_prior_ambiguity", jobRowId: allocation.id };
  }

  const payload: StuartCreateJobPayload = {
    job: {
      pickup_at: input.pickupAt,
      pickups: [{ address: input.pickup.address, contact: input.pickup.contact, comment: input.pickup.comment }],
      dropoffs: [
        {
          address: input.dropoff.address,
          contact: input.dropoff.contact,
          client_reference: allocation.clientReference,
          package_type: input.dropoff.packageType,
          package_description: input.dropoff.packageDescription,
          comment: input.dropoff.comment,
          partner_data: input.partnerData,
        },
      ],
    },
  };

  await markStuartDeliveryJobSendStarted({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });

  let transportResult: StuartOrchestrationTransportResult;
  try {
    transportResult = await input.transport.createJob(payload);
  } catch {
    // Échec de transport non anticipé (l'implémentation injectée a
    // elle-même levé) -- traité comme une issue distante INCONNUE,
    // JAMAIS un succès silencieux, jamais un échec terminal supposé.
    await markStuartDeliveryJobAmbiguous({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
    return { status: "send_ambiguous", jobRowId: allocation.id };
  }

  if (transportResult.networkFailure) {
    await markStuartDeliveryJobAmbiguous({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
    return { status: "send_ambiguous", jobRowId: allocation.id };
  }

  if (transportResult.httpStatus >= 200 && transportResult.httpStatus < 300) {
    const validated = validateCreateJobResponse(transportResult.raw);
    if (!validated) {
      await markStuartDeliveryJobAmbiguous({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
      return { status: "send_ambiguous", jobRowId: allocation.id };
    }
    await confirmStuartDeliveryJobCreated({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId, stuartJobId: validated.id });
    return { status: "created_confirmed", jobRowId: allocation.id, stuartJobId: validated.id };
  }

  const classification = classifyHttpOutcome(transportResult.httpStatus);
  if (classification === "terminal") {
    await markStuartDeliveryJobTerminalFailure({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
    return { status: "terminal_failure", jobRowId: allocation.id, httpStatus: transportResult.httpStatus };
  }
  await markStuartDeliveryJobAmbiguous({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
  return { status: "send_ambiguous", jobRowId: allocation.id };
}

export { StuartAllocationError };
