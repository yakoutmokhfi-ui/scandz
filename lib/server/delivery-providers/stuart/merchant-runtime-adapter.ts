import "server-only";
import {
  getStuartCredentialForRestaurant,
  type ResolvedStuartMerchantCredential,
} from "@/lib/server/delivery-providers/stuart/credential-resolver";
import { resolveStuartBaseUrlForEnvironment } from "@/lib/server/delivery-providers/stuart/environment";
import {
  getStuartAccessTokenForMerchant,
  StuartMerchantAuthError,
} from "@/lib/server/delivery-providers/stuart/merchant-auth";
import { StuartMerchantCredentialMissingError } from "@/lib/server/delivery-provider-errors";
import { StuartCredentialError } from "@/lib/server/delivery-providers/stuart/credentials";
import {
  isStuartLiveActivationEnabled,
  describeStuartLiveActivationGateForObservability,
} from "@/lib/server/delivery-providers/stuart/live-activation-gate";
import type {
  StuartOrchestrationTransport,
  StuartOrchestrationTransportResult,
} from "@/lib/server/delivery-providers/stuart/orchestration";
import type { StuartCreateJobPayload } from "@/lib/server/delivery-providers/stuart/types";

/**
 * STUART LOT D2 — REAL MERCHANT RUNTIME ADAPTER (create delivery).
 *
 * ============================================================
 * CE QUE CE MODULE EST
 * ============================================================
 * L'implémentation RÉELLE (credential-paramétrée PAR MARCHAND,
 * multi-environnement) de `StuartOrchestrationTransport`
 * (`orchestration.ts`, LOT D1, INTERFACE INCHANGÉE — ce module ne
 * modifie NI `orchestration.ts` NI `post-payment-hook-wiring.ts`).
 * Destiné à REMPLACER, dans un FUTUR câblage hors périmètre de ce
 * mandat, `NON_LIVE_STUART_ORCHESTRATION_TRANSPORT`
 * (`post-payment-hook-wiring.ts`, D1 v1.1, INCHANGÉ par ce lot) — ce
 * remplacement lui-même N'EST PAS effectué ici (mandat, "Do not enable
 * the live activation gate" / "the wiring point remains D1's own" —
 * câbler ce module dans le point d'entrée réel post-paiement est un
 * FUTUR mandat CIO distinct, une fois la porte d'activation
 * explicitement autorisée).
 *
 * ============================================================
 * POURQUOI UN TROISIÈME MODULE PARALLÈLE (jamais réutiliser create-job.ts)
 * ============================================================
 * IDENTIQUE au raisonnement déjà établi par `quote-service.ts` (STUART
 * LOT A) pour `pricing.ts`/`auth.ts`/`environment.ts` (DELIVERY STREAM
 * C) : ces modules sont verrouillés SANDBOX UNIQUEMENT et authentifient
 * via une identité PLATEFORME UNIQUE globale
 * (`STUART_CLIENT_ID`/`STUART_CLIENT_SECRET`/`STUART_ENV`) — corrects
 * pour le diagnostic Sandbox propre à Scanym, INCOMPATIBLES avec le
 * modèle métier marchand (mandat D2, "NON-NEGOTIABLE BUSINESS MODEL").
 * Ce module réutilise EXACTEMENT la même chaîne d'autorité credential/
 * environnement déjà PROUVÉE par `quote-service.ts` (LOT A) :
 * `credential-resolver.ts` -> `environment.ts` (fonction PURE
 * `resolveStuartBaseUrlForEnvironment`, jamais `resolveStuartEnvironment`)
 * -> `merchant-auth.ts` (AUCUN cache partagé entre marchands).
 *
 * ============================================================
 * PREUVE STRUCTURELLE D'ABSENCE DE REPLI GLOBAL (mandat "NO GLOBAL
 * FALLBACK")
 * ============================================================
 * Ce fichier n'importe JAMAIS `auth.ts`, `create-job.ts`, ni
 * `resolveStuartEnvironment` (`environment.ts`) — les TROIS SEULS
 * modules du dépôt qui lisent `STUART_CLIENT_ID`/`STUART_CLIENT_SECRET`/
 * `STUART_ENV`. Aucune référence à `process.env.STUART_CLIENT_ID`,
 * `process.env.STUART_CLIENT_SECRET`, ni `process.env.STUART_ENV`
 * n'existe dans ce fichier — vérifiable par grep, couvert par un test
 * structurel dédié (`tests/v165-...test.ts`, item 5). La SEULE variable
 * d'environnement lue transitivement par ce module (via
 * `live-activation-gate.ts`) est `STUART_LIVE_ACTIVATION_ENABLED` — une
 * porte PLATEFORME-GLOBALE, jamais une identité credential.
 *
 * ============================================================
 * ORDRE D'ÉVALUATION (mandat, "Preferred semantics" -- littéral)
 * ============================================================
 *   merchant configured AND eligible AND valid credentials AND Stuart
 *   environment resolved AND Scanym live activation explicitly enabled
 *
 * "eligible" est déjà garanti EN AMONT par `orchestration.ts`
 * (`getStuartDeliveryEligibility`, INCHANGÉ) avant que
 * `transport.createJob(...)` ne soit jamais invoqué — ce module n'a
 * donc besoin de résoudre QUE les quatre autres conditions, DANS CET
 * ORDRE EXACT, à CHAQUE appel (aucun état mis en cache entre marchands
 * ni entre appels) :
 *   1. `getStuartCredentialForRestaurant(restaurantId)` — RPC Supabase
 *      SEULEMENT, JAMAIS un appel réseau Stuart. Peut échouer :
 *      configuration absente/invalide -> `configuration_failure` ;
 *      payload credential stocké corrompu -> `auth_credential_failure`.
 *   2. `resolveStuartBaseUrlForEnvironment(credential.mode)` — PURE,
 *      aucun échec possible (mode déjà validé à l'étape 1).
 *   3. `isStuartLiveActivationEnabled()` — LA DERNIÈRE vérification
 *      avant TOUTE tentative réseau Stuart, y COMPRIS l'acquisition
 *      OAuth elle-même (mandat : "NO OAuth request is authorized"
 *      pendant ce lot — la porte bloque donc AVANT `/oauth/token`, pas
 *      seulement avant `/v2/jobs`). Si `false` (TOUJOURS le cas pendant
 *      ce mandat D2) -> `configuration_failure`
 *      (`STUART_LIVE_ACTIVATION_DISABLED`), ZÉRO appel réseau d'aucune
 *      sorte.
 *   4. [jamais atteint pendant ce mandat] `getStuartAccessTokenForMerchant`
 *      (réseau #1) puis `POST /v2/jobs` (réseau #2, MÊME construction de
 *      requête que `create-job.ts`/`orchestration.ts`, MÊME contrat de
 *      réponse — `id` numérique canonicalisé en chaîne, MÊME allowlist
 *      terminale VOLONTAIREMENT VIDE, voir plus bas).
 *
 * ============================================================
 * MODÈLE DE RÉSULTAT NORMALISÉ (mandat, "adapter result model")
 * ============================================================
 * `StuartMerchantAdapterOutcome` distingue les SIX catégories exigées
 * par le mandat, utilisée pour l'OBSERVABILITÉ STRUCTURÉE
 * (`logStuartMerchantRuntimeEvent`) et testable EN ISOLATION PURE
 * (`classifyStuartMerchantCreateJobHttpResult`, AUCUN réseau, AUCUNE
 * porte, AUCUN restaurantId requis — voir tests/v167). Ce modèle riche
 * reste STRICTEMENT INTERNE à ce module du point de vue de la frontière
 * D1 : `createJob(payload)` continue de renvoyer EXACTEMENT
 * `StuartOrchestrationTransportResult` (`{raw, httpStatus,
 * networkFailure}`, INCHANGÉ) ou de LEVER une erreur typée — jamais un
 * type de retour étendu — pour que `orchestration.ts` (LOT D1,
 * INCHANGÉ) continue d'appliquer SA PROPRE classification (déjà
 * identique, déjà auditée) sans AUCUNE modification. "D1 blind-resend
 * protection must remain authoritative" (mandat) : ce module ne
 * COURT-CIRCUITE JAMAIS cette classification existante, il la nourrit
 * fidèlement.
 *
 * ============================================================
 * NE JAMAIS ACTIVER LA PORTE (mandat, absolu)
 * ============================================================
 * AUCUNE ligne de ce fichier, d'aucun test, d'aucun fixture de ce lot
 * ne positionne JAMAIS `STUART_LIVE_ACTIVATION_ENABLED=true`. La
 * fonction `classifyStuartMerchantCreateJobHttpResult` ci-dessous est
 * testée EN ISOLATION avec des entrées SYNTHÉTIQUES — elle ne passe
 * JAMAIS par la porte, ne fait JAMAIS un appel réseau, et n'exige
 * JAMAIS que la porte soit activée pour être exercée (c'est TOUTE la
 * raison de sa séparation en fonction pure).
 */

export class StuartMerchantRuntimeAdapterError extends Error {
  readonly category: StuartMerchantAdapterOutcome["kind"];
  constructor(category: StuartMerchantAdapterOutcome["kind"], message: string) {
    super(message);
    this.name = "StuartMerchantRuntimeAdapterError";
    this.category = category;
  }
}

export type StuartMerchantAdapterOutcome =
  | { kind: "success_confirmed"; stuartJobId: string; httpStatus: number }
  | { kind: "ambiguous_network_result"; httpStatus: number | null }
  | { kind: "retryable_provider_failure"; httpStatus: number }
  | { kind: "terminal_provider_failure"; httpStatus: number }
  | { kind: "auth_credential_failure"; reason: string }
  | { kind: "configuration_failure"; reason: string };

// ------------------------------------------------------------------
// Résolution credential/environnement (étapes 1-2) — RPC Supabase
// SEULEMENT, jamais un appel réseau Stuart. Traduit les erreurs
// LOT A-0/STUART LOT A existantes en `StuartMerchantRuntimeAdapterError`
// typée — MÊME répartition configuration/credential que
// `quote-errors.ts` (STUART LOT A), réutilisée à l'identique plutôt que
// réinventée (mandat, esprit "prefer the already-established model").
// ------------------------------------------------------------------

interface ResolvedRuntimeContext {
  credential: ResolvedStuartMerchantCredential;
  baseUrl: string;
}

async function resolveStuartMerchantRuntimeContext(restaurantId: string): Promise<ResolvedRuntimeContext> {
  let credential: ResolvedStuartMerchantCredential;
  try {
    credential = await getStuartCredentialForRestaurant(restaurantId);
  } catch (err) {
    if (err instanceof StuartMerchantCredentialMissingError) {
      throw new StuartMerchantRuntimeAdapterError(
        "configuration_failure",
        "STUART_MERCHANT_RUNTIME_CONFIGURATION_MISSING"
      );
    }
    if (err instanceof StuartCredentialError) {
      throw new StuartMerchantRuntimeAdapterError(
        "auth_credential_failure",
        "STUART_MERCHANT_RUNTIME_CREDENTIAL_INVALID"
      );
    }
    // Panne infrastructure/RPC inattendue -- propagée TELLE QUELLE,
    // jamais masquée (même discipline que credential-resolver.ts/
    // quote-service.ts) -- orchestration.ts (catch générique, INCHANGÉ)
    // la traduira en send_ambiguous, jamais en succès silencieux.
    throw err;
  }

  const baseUrl = resolveStuartBaseUrlForEnvironment(credential.mode);
  return { credential, baseUrl };
}

// ------------------------------------------------------------------
// Classification PURE, testable en isolation (mandat item 9 "adapter
// result model") -- AUCUN réseau, AUCUNE porte, AUCUN restaurantId.
// MÊME contrat de validation/classification que create-job.ts v2.2 /
// orchestration.ts (identifiant Create Job numérique documenté,
// allowlist terminale VOLONTAIREMENT VIDE -- aucune preuve documentaire
// actuelle d'un code HTTP terminal pour Create Job, voir CONTRACT-
// MAPPING.md). Dupliqué ICI délibérément (troisième copie, après
// create-job.ts et orchestration.ts) -- convergence des trois copies
// explicitement DIFFÉRÉE à un futur lot de consolidation dédié (hors
// périmètre D2, "Do NOT redesign D1 unnecessarily") plutôt que
// d'introduire un changement partagé sur des fichiers D1 existants.
// ------------------------------------------------------------------

const DOCUMENTED_TERMINAL_HTTP_STATUSES: ReadonlySet<number> = new Set([]);

function validateStuartCreateJobResponseId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>).id;
  if (typeof id !== "number") return null;
  if (!Number.isFinite(id) || !Number.isInteger(id) || !Number.isSafeInteger(id)) return null;
  if (id <= 0) return null;
  return String(id);
}

/**
 * Classifie un résultat HTTP Create Job DÉJÀ OBTENU (ou une absence de
 * réponse réseau) dans le modèle riche à six catégories. Fonction PURE
 * -- aucun effet de bord, aucune E/S. Utilisée UNIQUEMENT à des fins
 * d'observabilité structurée par `createStuartMerchantOrchestrationTransport`
 * ci-dessous -- ne remplace JAMAIS la classification propre
 * d'`orchestration.ts` (D1, INCHANGÉE), qui reste seule responsable des
 * transitions `stuart_delivery_jobs`.
 */
export function classifyStuartMerchantCreateJobHttpResult(
  result: StuartOrchestrationTransportResult
): StuartMerchantAdapterOutcome {
  if (result.networkFailure) {
    return { kind: "ambiguous_network_result", httpStatus: null };
  }
  if (result.httpStatus >= 200 && result.httpStatus < 300) {
    const id = validateStuartCreateJobResponseId(result.raw);
    if (!id) {
      return { kind: "ambiguous_network_result", httpStatus: result.httpStatus };
    }
    return { kind: "success_confirmed", stuartJobId: id, httpStatus: result.httpStatus };
  }
  if (DOCUMENTED_TERMINAL_HTTP_STATUSES.has(result.httpStatus)) {
    return { kind: "terminal_provider_failure", httpStatus: result.httpStatus };
  }
  // Aucune preuve documentaire actuelle qu'un code HTTP soit terminal
  // pour Create Job (MÊME position que create-job.ts v2.2/
  // orchestration.ts) -- classifié "retryable_provider_failure" plutôt
  // qu'"ambiguous_network_result" : une réponse HTTP RÉELLE a bien été
  // reçue (distinct d'un échec réseau), mais aucune preuve ne permet
  // d'affirmer qu'elle est terminale -- JAMAIS collapsée en "sûr à
  // renvoyer" (mandat, "Do not collapse ambiguous failures into
  // safe-to-resend failures") : au niveau frontière D1 (voir
  // `orchestration.ts`, INCHANGÉ), ce même statut HTTP reste de toute
  // façon traité comme `send_ambiguous` (verrouillage manuel requis,
  // JAMAIS un nouvel envoi automatique).
  return { kind: "retryable_provider_failure", httpStatus: result.httpStatus };
}

// ------------------------------------------------------------------
// Observabilité structurée (mandat "OBSERVABILITY") -- champs sûrs
// UNIQUEMENT. JAMAIS : jeton OAuth, client secret, credential complet,
// charge utile client au-delà du nécessaire opérationnel.
// ------------------------------------------------------------------

export interface StuartMerchantRuntimeObservabilityEvent {
  restaurantId: string;
  orderId?: string;
  environment?: "sandbox" | "production";
  category: StuartMerchantAdapterOutcome["kind"];
  reason?: string;
  httpStatus?: number | null;
  liveActivationEnabled: boolean;
  invocationSequence: number;
}

let invocationCounter = 0;

/**
 * Journalise UN évènement d'exécution du runtime marchand -- jamais le
 * secret/jeton, jamais la charge utile complète. `invocationSequence`
 * est un COMPTEUR LOCAL À CE PROCESSUS (jamais un numéro de tentative
 * prestataire Stuart authentique) -- documenté honnêtement comme tel,
 * utile uniquement pour corréler des lignes de log entre elles au sein
 * d'une même exécution.
 */
function logStuartMerchantRuntimeEvent(fields: Omit<StuartMerchantRuntimeObservabilityEvent, "liveActivationEnabled" | "invocationSequence">): void {
  invocationCounter += 1;
  const gate = describeStuartLiveActivationGateForObservability();
  const event: StuartMerchantRuntimeObservabilityEvent = {
    ...fields,
    liveActivationEnabled: gate.enabled,
    invocationSequence: invocationCounter,
  };
  // console.info structuré -- jamais console.log d'un objet potentiellement
  // enrichi par un appelant tiers non contrôlé ici.
  console.info("[stuart-merchant-runtime]", JSON.stringify(event));
}

// ------------------------------------------------------------------
// Transport StuartOrchestrationTransport RÉEL, compatible D1
// (`orchestration.ts`, INCHANGÉ) -- frontière EXPORTÉE de ce module.
// ------------------------------------------------------------------

export interface CreateStuartMerchantOrchestrationTransportInput {
  restaurantId: string;
  /** Facultatif -- UNIQUEMENT pour enrichir l'observabilité structurée
   *  (mandat "restaurant_id, order_id, ..."). N'INFLUENCE JAMAIS la
   *  résolution credential/environnement/porte -- ces trois autorités
   *  ne dépendent QUE de `restaurantId`. */
  orderId?: string;
}

/**
 * Construit un `StuartOrchestrationTransport` RÉEL, lié à UN marchand
 * (`restaurantId`) — jamais partagé/mis en cache entre marchands
 * (aucun état module-level clé par credential, contrairement à
 * `auth.ts`, DELIBÉRÉMENT — voir `merchant-auth.ts`). `fetchImpl` reste
 * injectable (mandat "Mocked HTTP only" pendant ce lot ; permet aussi un
 * futur remplacement de runtime HTTP sans changement de contrat).
 *
 * GARANTIE STRUCTURELLE CENTRALE DE CE LOT : tant que
 * `isStuartLiveActivationEnabled()` renvoie `false` (TOUJOURS le cas
 * pendant ce mandat D2, vérifié par `tests/v166-...test.ts`), `fetchImpl`
 * n'est JAMAIS invoqué — ni pour l'acquisition OAuth, ni pour
 * `POST /v2/jobs` — quel que soit l'état credential/environnement du
 * marchand (y compris un marchand `production`-configuré PARFAITEMENT
 * valide, mandat "IMPORTANT — PRODUCTION MODE IS NOT ACTIVATION").
 */
export function createStuartMerchantOrchestrationTransport(
  input: CreateStuartMerchantOrchestrationTransportInput,
  fetchImpl: typeof fetch = fetch
): StuartOrchestrationTransport {
  const CREATE_JOB_PATH = "/v2/jobs";
  const REQUEST_TIMEOUT_MS = 15_000;

  return {
    async createJob(payload: StuartCreateJobPayload): Promise<StuartOrchestrationTransportResult> {
      // Étapes 1-2 -- RPC Supabase seulement, jamais un appel réseau
      // Stuart. Toute erreur ici est journalisée puis PROPAGÉE (levée)
      // -- orchestration.ts (catch générique, INCHANGÉ) la traduira en
      // `send_ambiguous`, jamais un succès silencieux, jamais un échec
      // terminal supposé.
      let context: ResolvedRuntimeContext;
      try {
        context = await resolveStuartMerchantRuntimeContext(input.restaurantId);
      } catch (err) {
        if (err instanceof StuartMerchantRuntimeAdapterError) {
          logStuartMerchantRuntimeEvent({
            restaurantId: input.restaurantId,
            orderId: input.orderId,
            category: err.category,
            reason: err.message,
          });
        }
        throw err;
      }

      // Étape 3 -- LA DERNIÈRE condition avant TOUTE tentative réseau,
      // y compris OAuth. Voir commentaire de fichier.
      if (!isStuartLiveActivationEnabled()) {
        logStuartMerchantRuntimeEvent({
          restaurantId: input.restaurantId,
          orderId: input.orderId,
          environment: context.credential.mode,
          category: "configuration_failure",
          reason: "STUART_LIVE_ACTIVATION_DISABLED",
        });
        throw new StuartMerchantRuntimeAdapterError(
          "configuration_failure",
          "STUART_LIVE_ACTIVATION_DISABLED"
        );
      }

      // ============================================================
      // CODE MORT PENDANT CE MANDAT D2 (mandat "Do not enable the live
      // activation gate") -- jamais atteint tant que
      // `STUART_LIVE_ACTIVATION_ENABLED` n'est pas EXACTEMENT "true"
      // dans l'environnement serveur RÉEL, ce que ce lot ne fait NULLE
      // PART. Conservé ici (plutôt que dans un fichier séparé non
      // câblé) pour que le point d'extension futur soit un DIFF
      // minimal, jamais un nouveau design, une fois la porte autorisée
      // par le CIO.
      // ============================================================
      let accessToken: string;
      try {
        accessToken = await getStuartAccessTokenForMerchant(
          { clientId: context.credential.clientId, clientSecret: context.credential.clientSecret },
          context.baseUrl,
          fetchImpl
        );
      } catch (err) {
        if (err instanceof StuartMerchantAuthError) {
          logStuartMerchantRuntimeEvent({
            restaurantId: input.restaurantId,
            orderId: input.orderId,
            environment: context.credential.mode,
            category: "auth_credential_failure",
            reason: err.message,
          });
          throw new StuartMerchantRuntimeAdapterError("auth_credential_failure", err.message);
        }
        throw err;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let httpResult: StuartOrchestrationTransportResult;
      try {
        let response: Response;
        try {
          response = await fetchImpl(`${context.baseUrl}${CREATE_JOB_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch {
          httpResult = { raw: null, httpStatus: 0, networkFailure: true };
          const classification = classifyStuartMerchantCreateJobHttpResult(httpResult);
          logStuartMerchantRuntimeEvent({
            restaurantId: input.restaurantId,
            orderId: input.orderId,
            environment: context.credential.mode,
            category: classification.kind,
            httpStatus: httpResult.httpStatus,
          });
          return httpResult;
        }

        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          httpResult = { raw: null, httpStatus: response.status, networkFailure: false };
          const classification = classifyStuartMerchantCreateJobHttpResult(httpResult);
          logStuartMerchantRuntimeEvent({
            restaurantId: input.restaurantId,
            orderId: input.orderId,
            environment: context.credential.mode,
            category: classification.kind,
            httpStatus: httpResult.httpStatus,
          });
          return httpResult;
        }

        httpResult = { raw: parsed, httpStatus: response.status, networkFailure: false };
        const classification = classifyStuartMerchantCreateJobHttpResult(httpResult);
        logStuartMerchantRuntimeEvent({
          restaurantId: input.restaurantId,
          orderId: input.orderId,
          environment: context.credential.mode,
          category: classification.kind,
          httpStatus: httpResult.httpStatus,
        });
        return httpResult;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
