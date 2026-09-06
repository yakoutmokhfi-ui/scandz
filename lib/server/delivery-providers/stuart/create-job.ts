import "server-only";
import { resolveStuartEnvironment } from "@/lib/server/delivery-providers/stuart/environment";
import { getStuartAccessToken } from "@/lib/server/delivery-providers/stuart/auth";
import { deriveStuartClientReferenceCandidate } from "@/lib/server/delivery-providers/stuart/client-reference";
import {
  allocateStuartDeliveryJob,
  markStuartDeliveryJobSendStarted,
  markStuartDeliveryJobAmbiguous,
  confirmStuartDeliveryJobCreated,
  markStuartDeliveryJobTerminalFailure,
} from "@/lib/server/delivery-providers/stuart/allocation";
import type { StuartCreateJobPayload, StuartContact, StuartPackageType, StuartPartnerData } from "@/lib/server/delivery-providers/stuart/types";
import { createHash } from "node:crypto";

/**
 * DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.2
 * (ferme STUART-V21-CREATE-JOB-ID-CONTRACT-01 (BLOCKER),
 * STUART-V21-HTTP-TERMINAL-CLASSIFICATION-01 (HIGH)).
 *
 * CORRECTIF v2.1 (préservé) : la primitive HTTP brute
 * (`sendStuartCreateJobHttp`) n'est PAS exportée -- seule
 * `createStuartSandboxJobForOrder()` l'est.
 *
 * CORRECTIF v2.2 -- deux défauts corrigés :
 *
 * 1. ID CONTRACT (BLOCKER) : la documentation Stuart actuelle montre
 *    un identifiant de job NUMÉRIQUE (ex. `{ "id": 100202968 }`),
 *    jamais une chaîne. `validateCreateJobResponse` n'acceptait QUE
 *    `typeof id === "string"` -- rejetait donc TOUTE réponse Create
 *    Job légitime, la classant systématiquement ambiguë. Corrigé :
 *    accepte un nombre, valide fini/entier/positif/dans l'intervalle
 *    sûr JavaScript, puis canonicalise en chaîne EXACTE (`String(id)`,
 *    jamais de notation scientifique ni de troncature) pour la
 *    colonne `stuart_job_id` (texte, INCHANGÉE -- mandat §14,
 *    "Text storage is acceptable and preferable for provider
 *    abstraction"). Une chaîne n'est PAS acceptée en entrée -- aucune
 *    preuve documentaire actuelle que Stuart retourne jamais une
 *    chaîne pour ce champ.
 *
 * 2. CLASSIFICATION HTTP (HIGH) : TOUT statut non-2xx était
 *    auparavant classé `terminal_failure` -- dangereusement incorrect
 *    (408/429/5xx ne prouvent PAS l'absence de création côté
 *    prestataire). Corrigé par `classifyCreateJobHttpOutcome()` :
 *    liste d'autorisation TERMINALE volontairement VIDE dans ce lot
 *    (aucune preuve documentaire actuelle d'un code de rejet
 *    pré-création spécifique n'a été trouvée) -- TOUT statut non-2xx
 *    ou 2xx malformé est classé AMBIGU par défaut, y compris tout
 *    code non répertorié (fail-safe explicite, mandat §5 : "Unknown
 *    status code: AMBIGUOUS").
 */

export class StuartCreateJobError extends Error {
  constructor(message: string = "STUART_CREATE_JOB_ERROR") {
    super(message);
    this.name = "StuartCreateJobError";
  }
}
export class StuartProductionForbiddenError extends StuartCreateJobError {
  constructor() {
    super("STUART_V2_PRODUCTION_FORBIDDEN");
    this.name = "StuartProductionForbiddenError";
  }
}
export class StuartCreateJobAmbiguousError extends StuartCreateJobError {
  constructor() {
    super("STUART_CREATE_JOB_AMBIGUOUS_TIMEOUT");
    this.name = "StuartCreateJobAmbiguousError";
  }
}
export class StuartCreateJobBlockedByAmbiguityError extends StuartCreateJobError {
  constructor() {
    super("STUART_CREATE_JOB_BLOCKED_BY_PRIOR_AMBIGUITY");
    this.name = "StuartCreateJobBlockedByAmbiguityError";
  }
}
export class StuartCreateJobTerminalFailureError extends StuartCreateJobError {
  constructor(detail: string) {
    super(`STUART_CREATE_JOB_TERMINAL_FAILURE_${detail}`);
    this.name = "StuartCreateJobTerminalFailureError";
  }
}
export class StuartAllocationCollisionExhaustedError extends StuartCreateJobError {
  constructor() {
    super("STUART_ALLOCATION_COLLISION_EXHAUSTED");
    this.name = "StuartAllocationCollisionExhaustedError";
  }
}

const CREATE_JOB_PATH = "/v2/jobs";
const CREATE_JOB_TIMEOUT_MS = 15_000;
const MAX_COLLISION_RETRIES = 5;

interface ValidatedStuartCreateJobResponse {
  /** TOUJOURS une chaîne canonique (`String(id)`) -- l'identifiant
   *  brut REÇU de Stuart est numérique, jamais persisté tel quel. */
  id: string;
}

/**
 * CORRECTIF v2.2 (BLOCKER) : accepte l'identifiant NUMÉRIQUE
 * documenté (ex. `100202968`), REJETTE explicitement :
 * - toute chaîne (aucune preuve documentaire que Stuart en retourne) ;
 * - NaN, Infinity, -Infinity ;
 * - valeur non entière (ex. 1.5) ;
 * - valeur négative ou nulle (aucune preuve d'ID <= 0 documentée) ;
 * - valeur hors de `Number.isSafeInteger` (précision JS garantie).
 * Canonicalise en chaîne DÉCIMALE EXACTE via `String()` -- jamais de
 * notation scientifique (`Number.isSafeInteger` élimine déjà les
 * valeurs assez grandes pour en produire une).
 */
function validateCreateJobResponse(raw: unknown): ValidatedStuartCreateJobResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>).id;
  if (typeof id !== "number") return null;
  if (!Number.isFinite(id)) return null;
  if (!Number.isInteger(id)) return null;
  if (!Number.isSafeInteger(id)) return null;
  if (id <= 0) return null;
  return { id: String(id) };
}

/**
 * CORRECTIF v2.2 (HIGH) : classification EXPLICITE et CONSERVATRICE.
 * Liste d'autorisation terminale VOLONTAIREMENT VIDE -- aucun code
 * HTTP n'est classé "terminal" dans ce lot faute de preuve
 * documentaire actuelle suffisante d'un rejet PROUVÉ pré-création
 * (mandat §5, "Otherwise: AMBIGUOUS is safer"). Toute évolution de
 * cette liste DOIT être justifiée par une preuve documentaire
 * explicite, jamais par déduction depuis la classe HTTP seule.
 */
const DOCUMENTED_TERMINAL_HTTP_STATUSES: ReadonlySet<number> = new Set([]);

function classifyCreateJobHttpOutcome(status: number): "terminal" | "ambiguous" {
  if (DOCUMENTED_TERMINAL_HTTP_STATUSES.has(status)) return "terminal";
  return "ambiguous";
}

async function sendStuartCreateJobHttp(payload: StuartCreateJobPayload): Promise<{ raw: unknown; httpStatus: number; networkFailure: boolean }> {
  const { environment, baseUrl } = resolveStuartEnvironment();
  if (environment !== "sandbox") {
    throw new StuartProductionForbiddenError();
  }

  const accessToken = await getStuartAccessToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CREATE_JOB_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${CREATE_JOB_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    void err;
    return { raw: null, httpStatus: 0, networkFailure: true };
  } finally {
    clearTimeout(timeoutId);
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    return { raw: null, httpStatus: response.status, networkFailure: false };
  }
  return { raw: parsed, httpStatus: response.status, networkFailure: false };
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
export interface CreateStuartSandboxJobForOrderInput {
  orderId: string;
  restaurantId: string;
  pickup: StuartOrderPickup;
  dropoff: StuartOrderDropoff;
  pickupAt?: string;
  partnerData?: StuartPartnerData;
}

export interface StuartOrderCorrelationResult {
  id: string;
  clientReference: string;
  sendState: "created_confirmed" | "send_ambiguous";
  stuartJobId: string | null;
}

/**
 * FRONTIÈRE D'ORCHESTRATION DE CONFIANCE -- seule fonction exportée
 * pour la création réelle d'un job Stuart. Séquence INCHANGÉE depuis
 * v2.1 (mandat §12, aucune régression) -- seules la validation de
 * réponse et la classification d'échec sont corrigées (v2.2).
 */
export async function createStuartSandboxJobForOrder(
  input: CreateStuartSandboxJobForOrderInput
): Promise<StuartOrderCorrelationResult> {
  const { environment } = resolveStuartEnvironment();
  if (environment !== "sandbox") {
    throw new StuartProductionForbiddenError();
  }

  let allocation: Awaited<ReturnType<typeof allocateStuartDeliveryJob>> | undefined;
  let candidate = deriveStuartClientReferenceCandidate(input.orderId);
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
    const result = await allocateStuartDeliveryJob({ orderId: input.orderId, restaurantId: input.restaurantId, environment: "sandbox", candidateReference: candidate });
    if (!result.collision) {
      allocation = result;
      break;
    }
    candidate = createHash("sha256").update(`${input.orderId}:${attempt + 1}`, "utf8").digest("hex").slice(0, 10).toUpperCase();
  }
  if (!allocation) {
    throw new StuartAllocationCollisionExhaustedError();
  }

  const existingState = allocation.sendState;
  if (existingState === "created_confirmed") {
    return {
      id: allocation.id,
      clientReference: allocation.clientReference,
      sendState: "created_confirmed",
      stuartJobId: allocation.stuartJobId,
    };
  }
  if (existingState === "send_ambiguous") {
    throw new StuartCreateJobBlockedByAmbiguityError();
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

  const httpResult = await sendStuartCreateJobHttp(payload);

  if (httpResult.networkFailure) {
    await markStuartDeliveryJobAmbiguous({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
    throw new StuartCreateJobAmbiguousError();
  }

  if (httpResult.httpStatus >= 200 && httpResult.httpStatus < 300) {
    const validated = validateCreateJobResponse(httpResult.raw);
    if (!validated) {
      await markStuartDeliveryJobAmbiguous({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
      throw new StuartCreateJobAmbiguousError();
    }
    await confirmStuartDeliveryJobCreated({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId, stuartJobId: validated.id });
    return { id: allocation.id, clientReference: allocation.clientReference, sendState: "created_confirmed", stuartJobId: validated.id };
  }

  // CORRECTIF v2.2 : classification EXPLICITE, jamais "tout non-2xx
  // est terminal" -- voir classifyCreateJobHttpOutcome() ci-dessus.
  const classification = classifyCreateJobHttpOutcome(httpResult.httpStatus);
  if (classification === "terminal") {
    await markStuartDeliveryJobTerminalFailure({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
    throw new StuartCreateJobTerminalFailureError(String(httpResult.httpStatus));
  }
  await markStuartDeliveryJobAmbiguous({ id: allocation.id, orderId: input.orderId, restaurantId: input.restaurantId });
  throw new StuartCreateJobAmbiguousError();
}
