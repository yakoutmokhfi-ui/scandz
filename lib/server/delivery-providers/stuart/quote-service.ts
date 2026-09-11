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
  StuartQuoteConfigurationError,
  StuartQuoteCredentialError,
  StuartValidateContractUnverifiedError,
} from "@/lib/server/delivery-providers/stuart/quote-errors";
import type { StuartCreateJobPayload } from "@/lib/server/delivery-providers/stuart/types";
import type {
  StuartQuoteRequestInput,
  NormalizedStuartQuoteResult,
} from "@/lib/server/delivery-providers/stuart/quote-types";

/**
 * STUART LOT A — QUOTE / VALIDATE / ETA / SCHEDULING FOUNDATION v1.1.
 *
 * CORRECTIF v1.1 (CTO PRE-CONTROL, LOT-A-CONTRACT-01, BLOCKER) : v1
 * POSTait vers `/v2/jobs/validate` en réutilisant la charge utile
 * Create Job/Pricing, alors qu'AUCUNE preuve documentaire du dépôt ne
 * prouve le schéma de requête NI de réponse de cet endpoint -- une
 * violation directe du mandat ("Do NOT assume undocumented fields...
 * STOP and report it instead of inventing it"), qu'un test à réponse
 * HTTP mockée ne pouvait pas dissimuler (un mock prouve le
 * comportement du CODE, jamais le contrat EXTERNE réel). REMÉDIÉ :
 * `validateDelivery(...)` n'émet désormais PLUS AUCUNE requête HTTP,
 * ni vers `/v2/jobs/validate` ni vers aucun autre endpoint -- voir
 * `StuartValidateContractUnverifiedError` (`quote-errors.ts`) et
 * l'implémentation de `validateDelivery` plus bas dans ce fichier.
 * AUCUN alias silencieux vers Pricing. Seul `quoteDelivery(...)`
 * (`POST /v2/jobs/pricing`, endpoint PROUVÉ) émet encore une requête
 * HTTP réelle dans ce lot.
 *
 * Frontière de service SERVEUR SEULEMENT pour `validateDelivery(...)`/
 * `quoteDelivery(...)` (mandat, "QUOTE / VALIDATE SERVICE BOUNDARY") --
 * seules fonctions exportées de ce fichier. Ne renvoie JAMAIS l'objet
 * brut de réponse Stuart à l'appelant -- uniquement
 * `NormalizedStuartQuoteResult` (`quote-types.ts`) pour `quoteDelivery`,
 * ou lève `StuartValidateContractUnverifiedError` pour `validateDelivery`.
 *
 * POURQUOI PAS `pricing.ts`/`create-job.ts`/`auth.ts` (DELIVERY STREAM
 * C) : ces trois modules sont verrouillés SANDBOX UNIQUEMENT
 * (`StuartPricingProductionForbiddenError`/`StuartProductionForbiddenError`)
 * et authentifient via une identité PLATEFORME UNIQUE globale
 * (variables d'environnement serveur STUART_CLIENT_ID/STUART_CLIENT_SECRET/
 * STUART_ENV, lues UNIQUEMENT par `auth.ts`/`environment.ts`)
 * -- corrects pour le diagnostic Sandbox propre à Scanym (AUCUN
 * contrat Production Scanym), mais INCOMPATIBLES avec le modèle
 * métier de ce lot : un marchand possède SON PROPRE compte Stuart,
 * peut légitimement être en Production, et ne doit JAMAIS être bloqué
 * par un verrou Sandbox-only conçu pour un usage diagnostic distinct.
 * Ce fichier construit donc un chemin PARALLÈLE, credential-paramétré
 * par marchand, jamais un remplacement des modules existants (qui
 * restent INCHANGÉS, structure et comportement identiques, voir le
 * livrable final).
 *
 * SÉQUENCE (mandat, "CREDENTIAL RESOLUTION", étapes 1-6) -- s'applique
 * UNIQUEMENT à `quoteDelivery` depuis v1.1 (`validateDelivery` ne
 * l'exécute plus du tout, voir plus bas) :
 *   1-5. `getStuartCredentialForRestaurant(restaurantId)`
 *        (`credential-resolver.ts`, LOT A-0/STUART LOT A INCHANGÉ par
 *        ce fichier) -- résout restaurant_id -> config -> mode
 *        AUTORITATIF -> credential Vault déchiffré, fail-closed à
 *        chaque étape, AUCUN repli global.
 *   6. Authentifier contre le BON environnement Stuart -- `baseUrl`
 *      dérivé du `mode` retourné à l'étape précédente via
 *      `resolveStuartBaseUrlForEnvironment()` (PURE, jamais
 *      `process.env`), puis `getStuartAccessTokenForMerchant()`
 *      (`merchant-auth.ts`, STUART LOT A, AUCUN cache partagé).
 *
 * MODÈLE D'ERREUR -- voir `quote-errors.ts` pour la justification
 * complète de la répartition exception (configuration/credential)
 * vs. champ `errorClassification` du résultat normalisé (tout le
 * reste). En bref : tout ce qui empêche même de TENTER un appel HTTP
 * (pas de config, pas de credential lisible, credential corrompu,
 * échec d'authentification OAuth marchand) est une EXCEPTION typée ;
 * tout ce qui découle d'une tentative HTTP réelle (réponse Stuart
 * reçue ou non) est porté par le résultat normalisé lui-même.
 *
 * AUCUN APPEL RÉSEAU RÉEL PENDANT CE LOT (mandat, "NO REAL EXTERNAL
 * CALL") : `fetchImpl` est TOUJOURS injectable, jamais appelé
 * directement dans les tests de ce lot -- voir
 * `tests/v159-stuart-quote-validate-foundation.test.ts`.
 */

// PAS de VALIDATE_PATH -- STUART LOT A v1.1 (CTO PRE-CONTROL,
// LOT-A-CONTRACT-01) : `/v2/jobs/validate` n'est JAMAIS appelé par ce
// module (contrat non prouvé, voir commentaire de fichier
// ci-dessus). Retirer la constante elle-même (plutôt que de la
// laisser inutilisée) rend structurellement impossible toute
// réintroduction accidentelle d'un appel HTTP vers ce chemin dans ce
// fichier sans la redéfinir explicitement -- un futur diff qui la
// réintroduirait serait immédiatement visible en revue.
const PRICING_PATH = "/v2/jobs/pricing";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Construit la charge utile Stuart PROUVÉE (`StuartCreateJobPayload`,
 * `types.ts`) à partir de l'entrée Scanym-owned. Réutilise EXACTEMENT
 * la même forme que Create Job -- confirmé par le commentaire de
 * fichier de `pricing.ts` ("Même structure de charge utile que Create
 * Job"), jamais un second schéma inventé pour validate/pricing.
 */
function buildStuartQuoteRequestPayload(input: StuartQuoteRequestInput): StuartCreateJobPayload {
  return {
    job: {
      pickup_at: input.scheduling?.pickupAt,
      pickups: [
        {
          address: input.pickup.address,
          contact: input.pickup.contact,
          comment: input.pickup.comment,
        },
      ],
      dropoffs: [
        {
          address: input.dropoff.address,
          contact: input.dropoff.contact,
          client_reference: input.dropoff.clientReference,
          package_type: input.dropoff.packageType,
          package_description: input.dropoff.packageDescription,
          comment: input.dropoff.comment,
          partner_data: input.partnerData,
        },
      ],
    },
  };
}

/**
 * Extraction des champs commerciaux (référence de devis, montant,
 * devise, ETA) depuis une réponse Stuart brute -- VOLONTAIREMENT
 * TOUJOURS VIDE dans ce lot. AUCUNE preuve documentaire actuelle des
 * noms de champs exacts de la réponse `/v2/jobs/pricing` (ni de
 * `/v2/jobs/validate`, dont le schéma de réponse entier est
 * également non prouvé) n'a été trouvée dans ce dépôt -- seul un
 * fixture de test synthétique (`tests/v144-stuart-pricing.test.ts`,
 * `{amount: 5.5, currency: "EUR"}`) existe, explicitement NON traité
 * comme preuve (les fixtures de test sont des valeurs arbitraires,
 * pas un contrat). Mandat, littéral : "Do NOT fabricate ETA or quote
 * reference if API does not provide them." Isolée dans sa propre
 * fonction, nommée explicitement, pour que ce point d'extension futur
 * soit trivial à localiser une fois la documentation Stuart actuelle
 * consultée -- voir le livrable final, "unresolved Stuart contract
 * questions".
 */
function extractStuartCommercialFields(_raw: unknown): {
  providerQuoteReference?: string;
  providerCostAmount?: number;
  currency?: string;
  eta?: string;
} {
  return {};
}

interface ResolvedMerchantAuthContext {
  credential: ResolvedStuartMerchantCredential;
  baseUrl: string;
  accessToken: string;
}

/**
 * Étapes 1-6 du mandat (voir commentaire de fichier). Traduit les
 * erreurs LOT A-0/STUART LOT A existantes en la taxonomie QUOTE de ce
 * lot (`quote-errors.ts`) -- toute AUTRE erreur (panne infrastructure
 * Supabase, RPC inattendue) est propagée TELLE QUELLE, jamais masquée
 * (même discipline que `credential-resolver.ts`).
 */
async function resolveMerchantAuthContext(
  restaurantId: string,
  fetchImpl: typeof fetch
): Promise<ResolvedMerchantAuthContext> {
  let credential: ResolvedStuartMerchantCredential;
  try {
    credential = await getStuartCredentialForRestaurant(restaurantId);
  } catch (err) {
    if (err instanceof StuartMerchantCredentialMissingError) {
      throw new StuartQuoteConfigurationError();
    }
    if (err instanceof StuartCredentialError) {
      throw new StuartQuoteCredentialError();
    }
    throw err;
  }

  const baseUrl = resolveStuartBaseUrlForEnvironment(credential.mode);

  let accessToken: string;
  try {
    accessToken = await getStuartAccessTokenForMerchant(
      { clientId: credential.clientId, clientSecret: credential.clientSecret },
      baseUrl,
      fetchImpl
    );
  } catch (err) {
    if (err instanceof StuartMerchantAuthError) {
      throw new StuartQuoteCredentialError();
    }
    throw err;
  }

  return { credential, baseUrl, accessToken };
}

/**
 * Envoie la requête POST vers `/v2/jobs/pricing` (SEUL endpoint HTTP
 * réel de ce fichier depuis v1.1 -- voir commentaire de fichier) et
 * normalise le résultat. Ne lève JAMAIS pour un aller-retour HTTP RÉEL
 * (réussi ou non) -- voir `quote-errors.ts` pour la justification.
 * Peut lever `StuartQuoteConfigurationError`/`StuartQuoteCredentialError`
 * (avant tout appel HTTP) ou toute erreur infrastructure propagée
 * depuis `resolveMerchantAuthContext`.
 */
async function performStuartPricingRequest(
  input: StuartQuoteRequestInput,
  fetchImpl: typeof fetch
): Promise<NormalizedStuartQuoteResult> {
  const { credential, baseUrl, accessToken } = await resolveMerchantAuthContext(input.restaurantId, fetchImpl);
  const payload = buildStuartQuoteRequestPayload(input);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${PRICING_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Échec réseau/timeout AVANT réception d'une réponse -- sémantique
    // HTTP générique, aucune supposition Stuart-spécifique (voir
    // quote-errors.ts).
    clearTimeout(timeoutId);
    return {
      eligible: false,
      providerCode: "stuart",
      mode: credential.mode,
      httpStatus: 0,
      scheduling: input.scheduling,
      errorClassification: "transient_failure",
    };
  }
  clearTimeout(timeoutId);

  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = await response.json();
  } catch {
    parseFailed = true;
  }

  if (response.ok && !parseFailed) {
    const commercial = extractStuartCommercialFields(parsed);
    return {
      eligible: true,
      providerCode: "stuart",
      mode: credential.mode,
      httpStatus: response.status,
      scheduling: input.scheduling,
      ...commercial,
    };
  }

  if (response.ok && parseFailed) {
    return {
      eligible: false,
      providerCode: "stuart",
      mode: credential.mode,
      httpStatus: response.status,
      scheduling: input.scheduling,
      errorClassification: "malformed_response",
    };
  }

  if (response.status >= 500) {
    return {
      eligible: false,
      providerCode: "stuart",
      mode: credential.mode,
      httpStatus: response.status,
      scheduling: input.scheduling,
      errorClassification: "transient_failure",
    };
  }

  // Tout 4xx restant -- classification GÉNÉRIQUE "provider_rejection",
  // jamais affinée en "invalid_request"/"unsupported_delivery" faute
  // de preuve documentaire actuelle (voir quote-errors.ts).
  return {
    eligible: false,
    providerCode: "stuart",
    mode: credential.mode,
    httpStatus: response.status,
    scheduling: input.scheduling,
    errorClassification: "provider_rejection",
  };
}

/**
 * `POST /v2/jobs/validate` -- STUART LOT A v1.1 (CTO PRE-CONTROL,
 * LOT-A-CONTRACT-01, BLOCKER) : cet endpoint N'EST PLUS APPELÉ. Ni son
 * EXISTENCE ni son SCHÉMA (requête ou réponse) ne sont prouvés par
 * AUCUNE preuve documentaire trouvée dans ce dépôt (recherche
 * exhaustive effectuée -- voir le livrable final, "unresolved Stuart
 * contract questions") -- v1 POSTait malgré tout la charge utile
 * Create Job/Pricing vers cet endpoint, ce qu'un audit CTO a
 * correctement signalé comme une violation du mandat ("Do NOT assume
 * undocumented fields... STOP and report it instead of inventing it").
 *
 * Cette fonction lève DONC IMMÉDIATEMENT, de façon déterministe,
 * `StuartValidateContractUnverifiedError` (`quote-errors.ts`) --
 * AVANT toute résolution de credential (`getStuartCredentialForRestaurant`
 * n'est JAMAIS appelée), AVANT toute authentification OAuth marchande
 * (`getStuartAccessTokenForMerchant` n'est JAMAIS appelée), et SANS
 * ÉMETTRE AUCUNE requête HTTP -- la condition "contrat Validate non
 * prouvé" ne dépend d'AUCUNE donnée marchande, elle est donc
 * établissable AVANT MÊME de savoir QUEL marchand appelle (mandat
 * v1.1 : "no OAuth request is made merely to discover that Validate
 * is unsupported, if this can be established before authentication").
 * `fetchImpl` reste accepté dans la signature (parité avec
 * `quoteDelivery`, aucun framework générique supplémentaire construit
 * pour autant -- mandat : "Do not over-engineer a new general
 * framework") mais n'est JAMAIS invoqué par cette fonction.
 *
 * AUCUN alias silencieux vers `quoteDelivery`/Pricing -- Validate
 * reste une fonctionnalité NON IMPLÉMENTÉE, jamais simulée par
 * substitution d'un autre endpoint.
 */
export async function validateDelivery(
  input: StuartQuoteRequestInput,
  fetchImpl: typeof fetch = fetch
): Promise<never> {
  void input;
  void fetchImpl;
  throw new StuartValidateContractUnverifiedError();
}

/**
 * `POST /v2/jobs/pricing` -- endpoint CONFIRMÉ (voir `pricing.ts`),
 * MÊME charge utile que Create Job. Version MARCHAND-SCOPÉE,
 * credential-paramétrée, multi-environnement (Sandbox ET Production
 * selon le `mode` marchand résolu) de `getStuartSandboxPricing`
 * (`pricing.ts`, DELIVERY STREAM C, INCHANGÉE, reste Sandbox-only pour
 * son propre usage diagnostic plateforme). SEUL chemin HTTP réel de ce
 * fichier depuis v1.1 -- comportement INCHANGÉ par le correctif
 * LOT-A-CONTRACT-01 (mandat v1.1, "Pricing may remain implemented
 * ONLY to the extent already supported by repository contract
 * evidence" -- c'était déjà le cas en v1, aucune modification requise
 * ici).
 */
export async function quoteDelivery(
  input: StuartQuoteRequestInput,
  fetchImpl: typeof fetch = fetch
): Promise<NormalizedStuartQuoteResult> {
  return performStuartPricingRequest(input, fetchImpl);
}
