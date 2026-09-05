import "server-only";
import { randomUUID } from "node:crypto";
import {
  getOrderPaymentContext,
  getOrderCurrencyPreflight,
  getPaymentRuntimeProviderEnvironment,
  getOrderActivePaymentAttempt,
  getOrderBillingContext,
  getOrderServiceMode,
  getPaymentProviderCredential,
  initiatePaymentAttempt,
  type PaymentProviderRuntimeMode,
} from "@/lib/server/payment-service";
import { parseMoneticoCredential } from "@/lib/server/payment-providers/monetico/credentials";
import {
  buildMoneticoPaymentRequest,
  canonicalizeMoneticoLanguage,
} from "@/lib/server/payment-providers/monetico/request";
import { deriveMoneticoReference } from "@/lib/server/payment-providers/monetico/reference";
import { resolveMoneticoSubmissionUrl } from "@/lib/server/payment-providers/monetico/endpoint";
import { resolveCanonicalPublicOrigin } from "@/lib/server/canonical-public-origin";
import { createReturnRelayToken } from "@/lib/server/payment-return-relay";
import type { MoneticoPaymentRequestFields } from "@/lib/server/payment-providers/monetico/types";
import {
  mapToMoneticoBilling,
  mapToMoneticoShipping,
} from "@/lib/server/payment-providers/monetico/billing-mapping";
import { MoneticoProtocolError } from "@/lib/server/payment-providers/monetico/errors";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — CHECKOUT INITIATION
 * ORCHESTRATION.
 *
 * REMPLACE ENTIÈREMENT l'ordonnancement v3 en réponse aux 6 blocages
 * HIGH nommés par l'audit de travail v3 indépendant. INVARIANT
 * STRUCTUREL NOUVEAU ET CENTRAL DE CE LOT (ferme
 * P3B-V3-PREFLIGHT-01) :
 *
 *   AUCUNE nouvelle tentative de paiement `pending` (mutation P1,
 *   `initiatePaymentAttempt`) n'est créée tant que TOUS les
 *   prérequis STATIQUES nécessaires à un formulaire Monetico
 *   utilisable n'ont pas positivement réussi -- kill-switch, autorité
 *   de possession, environnement prestataire (activé + configuration
 *   `verified` + mode valide), point de terminaison résolu, credential
 *   (existe + se lit + s'analyse), facturation (existe + champs
 *   obligatoires valides), mode de service autoritatif, applicabilité
 *   + données shipping, origine publique canonique, jeton de relais de
 *   retour mintable. Voir `initiateCheckout` ci-dessous pour
 *   l'ordonnancement exact -- la mutation P1 (`initiatePaymentAttempt`)
 *   n'apparaît QU'À LA TOUTE FIN de la fonction.
 *
 * PROVIDER FIXÉ SERVEUR ("monetico") -- jamais accepté d'un appelant.
 *
 * KILL SWITCH `PAYMENT_CHECKOUT_RUNTIME_ENABLED` -- INCHANGÉ (v3),
 * INACTIF PAR DÉFAUT, vérifié EN PREMIER.
 *
 * `isDeliveryOrder` (v3, booléen accepté depuis le JSON navigateur) EST
 * SUPPRIMÉ (ferme P3B-V3-SHIPPING-AUTHORITY-01) -- l'applicabilité
 * shipping est désormais dérivée EXCLUSIVEMENT de `orders.service_mode`
 * (lecture serveur autoritaire, `getOrderServiceMode`, PAYMENT P3-B
 * MONETICO CHECKOUT RUNTIME v4). Le navigateur ne peut plus jamais
 * décider si le contexte anti-fraude signé Monetico contient un objet
 * `shipping`.
 *
 * `urlRetourOk`/`urlRetourErr` (v3, construites par la ROUTE depuis
 * `request.nextUrl.origin`, `public_token` en clair dans le query
 * string) SONT SUPPRIMÉES DE L'ENTRÉE (ferme P3B-V3-RETURN-AUTHORITY-01
 * / P3B-V3-PUBLIC-TOKEN-URL-01) -- ce fichier les construit LUI-MÊME,
 * exclusivement depuis `resolveCanonicalPublicOrigin()` (jamais un
 * en-tête `Host` d'une requête entrante) et un jeton de relais opaque
 * (`payment-return-relay.ts`) qui ne transporte JAMAIS `public_token`
 * en clair.
 *
 * ENDPOINT MONETICO -- `resolveMoneticoSubmissionUrl(mode)` (PAYMENT
 * P3-B MONETICO CHECKOUT RUNTIME v4, endpoint.ts) rend désormais `mode`
 * (P3-B4, persisté, JAMAIS une variable d'environnement) AUTORITAIRE
 * et STRUCTURÉ pour la résolution du point de terminaison -- voir le
 * commentaire détaillé de endpoint.ts pour ce qui a pu, ou n'a pas pu,
 * être re-vérifié indépendamment dans cette session concernant une
 * éventuelle URL bac-à-sable distincte.
 */

const PROVIDER_CODE = "monetico";

/**
 * PAYMENT STREAM B — MONETICO FINALIZATION (ferme MONETICO-CURRENCY-01,
 * gap vérifié par comparaison contre le contrat Starter réel fourni
 * pour Emmanuel -- EUR uniquement). Scanym est multi-tenant et
 * d'AUTRES établissements de la plateforme utilisent réellement une
 * devise différente (ex. DZD) pour un mode de paiement DIFFÉRENT
 * (jamais Monetico) -- `initiate_payment_attempt` (PAYMENT P1) copie
 * fidèlement `orders.currency` SANS AUCUNE validation de compatibilité
 * avec le PRESTATAIRE choisi. AVANT ce correctif, un établissement mal
 * configuré (devise non-EUR + Monetico activé) aurait vu sa devise
 * envoyée telle quelle à Monetico, avec un comportement imprévisible
 * en aval. Valeur fixe pour ce marchand pilote à devise unique --
 * élargir à une configuration par marchand exige une décision
 * d'architecture dédiée, hors périmètre de ce stream.
 */
const MONETICO_SUPPORTED_CURRENCY = "EUR";

/** Durée de vie du jeton de relais de retour -- large marge au-delà du
 *  délai de saisie carte documenté (45 minutes, v2.0 §7.2 p.69) pour
 *  couvrir un client lent/distrait sans jamais s'approcher d'une classe
 *  de durée "permanente" (mandat §12 : "short-lived"). Valeur fixe,
 *  jamais configurable par l'appelant. */
const RETURN_RELAY_TOKEN_TTL_SECONDS = 60 * 60 * 2; // 2 heures.

export class PaymentCheckoutRuntimeDisabledError extends Error {
  constructor(message = "PAYMENT_CHECKOUT_RUNTIME_DISABLED") {
    super(message);
    this.name = "PaymentCheckoutRuntimeDisabledError";
  }
}

function isCheckoutRuntimeEnabled(): boolean {
  // Échec FERMÉ explicite -- seule la chaîne EXACTE "true" active le
  // runtime.
  return process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED === "true";
}

export interface InitiateCheckoutInput {
  orderId: string;
  publicToken: string;
  language?: string;
}

export type InitiateCheckoutResult =
  | { outcome: "checkout_not_needed"; reason: "already_paid" | "not_required" }
  | { outcome: "provider_unavailable" }
  | { outcome: "billing_required" }
  | {
      /**
       * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 — ferme
       * P3BV41-PREFLIGHT-01. Rejet STATIQUE et DÉTERMINISTE d'une
       * entrée navigateur invalide, toujours renvoyé AVANT toute
       * mutation P1 -- jamais après. Distinct de `provider_unavailable`
       * (panne/config prestataire, rien à voir avec l'entrée
       * navigateur) et de `billing_required` (donnée manquante côté
       * commande, pas côté requête HTTP elle-même).
       */
      outcome: "invalid_request";
      reason: "unsupported_language";
    }
  | {
      /**
       * PAYMENT STREAM B — CURRENCY PREFLIGHT FIX v1.1 (ferme
       * STREAM-B-CURRENCY-PREFLIGHT-01) : la devise de la commande
       * n'est PAS compatible avec la configuration Monetico du
       * marchand (EUR uniquement, pour le contrat Starter réel du
       * marchand pilote). AUCUNE conversion implicite -- échec fermé
       * explicite.
       *
       * DÉSORMAIS DÉTECTÉ STRICTEMENT AVANT TOUTE MUTATION, POUR LES
       * DEUX CHEMINS (FRAIS et REPRISE) -- voir la lecture précoce
       * `getOrderCurrencyPreflight` juste après la preuve de
       * possession, section 3bis ci-dessus. AVANT ce correctif (v1),
       * cette vérification n'intervenait qu'APRÈS
       * `initiatePaymentAttempt` sur le chemin FRAIS, laissant
       * subsister une tentative `pending` inutilisable -- fermé.
       *
       * Cette branche `reason` reste néanmoins ATTEIGNABLE ici même
       * (défense en profondeur, jamais un chemin mort) : `currency`
       * est relu ci-dessous depuis `active.currency`/
       * `initiated.currency` -- une valeur qui DEVRAIT toujours
       * correspondre exactement à la lecture précoce
       * (`orders.currency` est immuable pour une commande donnée),
       * mais cette seconde vérification protège contre toute
       * divergence future non anticipée entre les deux lectures, sans
       * jamais faire confiance implicitement à la cohérence entre
       * elles.
       */
      outcome: "invalid_request";
      reason: "unsupported_currency";
    }
  | {
      outcome: "ready";
      submissionUrl: string;
      fields: MoneticoPaymentRequestFields;
      mode: PaymentProviderRuntimeMode;
      /** `true` si cette réponse RECONSTRUIT une tentative `pending`
       *  déjà initiée précédemment (chemin de REPRISE, PAYMENT P3-B3)
       *  plutôt que d'en initier une nouvelle. Voir OPEN GAP --
       *  SUPERSESSION, toujours non résolu par ce lot (mandat v4,
       *  gardé explicitement non bloquant). */
      resumed: boolean;
    };

/**
 * Orchestration d'initiation de checkout. Idempotente par construction
 * pour une commande donnée : un appel répété alors qu'une tentative
 * `pending` existe déjà REPREND cette même tentative (même
 * `reference`/`amount`/`currency`) plutôt que d'échouer sur la
 * contrainte P1 `payment_transactions_one_active_per_order`.
 *
 * N'APPELLE JAMAIS `confirmPaymentAttempt` -- cette orchestration ne
 * concerne QUE l'ALLER, jamais une mutation de statut.
 */
export async function initiateCheckout(
  input: InitiateCheckoutInput
): Promise<InitiateCheckoutResult> {
  // ------------------------------------------------------------
  // 1. Kill-switch -- AUCUN appel RPC ne se produit jamais si le
  // runtime est désactivé.
  // ------------------------------------------------------------
  if (!isCheckoutRuntimeEnabled()) {
    throw new PaymentCheckoutRuntimeDisabledError();
  }

  // ------------------------------------------------------------
  // 1b. LANGUE -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2, ferme
  // P3BV41-PREFLIGHT-01 (audit de travail v4.1 indépendant, blocage
  // HIGH). DÉFAUT antérieur : `language` n'était validée qu'À
  // L'INTÉRIEUR de `buildMoneticoPaymentRequest`, APRÈS
  // `initiatePaymentAttempt` (P1) -- une valeur non supportée créait
  // donc une tentative `pending` PUIS échouait, sans jamais produire
  // de formulaire Monetico utilisable (chemin reproduit :
  // language="ZZ" -> initiate_payment_attempt appelée ->
  // MONETICO_UNSUPPORTED_LANGUAGE lève, non rattrapée). Fonction PURE
  // (aucun appel RPC), donc placée ICI, AVANT tout I/O -- échec le
  // plus rapide possible, jamais après une seule mutation.
  // ------------------------------------------------------------
  let canonicalLanguage: string;
  try {
    canonicalLanguage = canonicalizeMoneticoLanguage(input.language);
  } catch {
    return { outcome: "invalid_request", reason: "unsupported_language" };
  }

  // ------------------------------------------------------------
  // 2/3. Autorité de possession + commande déjà payée/non requise.
  // ------------------------------------------------------------
  const context = await getOrderPaymentContext({
    orderId: input.orderId,
    publicToken: input.publicToken,
  });

  if (context.paymentStatus === "paid") {
    return { outcome: "checkout_not_needed", reason: "already_paid" };
  }
  if (context.paymentStatus === "not_required") {
    return { outcome: "checkout_not_needed", reason: "not_required" };
  }

  // ------------------------------------------------------------
  // 3bis. DEVISE -- PAYMENT STREAM B -- CURRENCY PREFLIGHT FIX v1.1
  // (ferme STREAM-B-CURRENCY-PREFLIGHT-01, retour d'audit Work
  // indépendant). DÉFAUT ANTÉRIEUR : la devise n'était connue/validée
  // qu'APRÈS `initiatePaymentAttempt` sur le chemin FRAIS -- une
  // commande non-EUR pouvait donc déjà créer une tentative `pending`
  // (mutation P1, `orders.payment_status` inclus) AVANT le rejet.
  // CORRIGÉ : lecture possession-scoped DÉDIÉE
  // (`getOrderCurrencyPreflight`, MÊME preuve de possession déjà
  // vérifiée ci-dessus par `getOrderPaymentContext`) exécutée ICI,
  // AVANT tout branchement FRAIS/REPRISE et AVANT tout appel
  // mutant -- exactement le même ordonnancement déjà établi pour la
  // langue (§1b ci-dessus, fonction pure) : échec le plus rapide
  // possible, JAMAIS après une mutation. `orders.currency` est
  // IMMUABLE pour une commande donnée une fois créée (jamais modifiée
  // par ce runtime ni par `initiate_payment_attempt`, qui la COPIE
  // sans jamais l'altérer) -- cette lecture précoce est donc
  // EXACTEMENT équivalente, en valeur, à `active.currency`/
  // `initiated.currency` lus plus bas, mais intervient AVANT toute
  // possibilité de mutation, pour le chemin FRAIS comme pour le
  // chemin REPRISE.
  const currencyPreflight = await getOrderCurrencyPreflight({
    orderId: input.orderId,
    publicToken: input.publicToken,
  });
  if (currencyPreflight.currency !== MONETICO_SUPPORTED_CURRENCY) {
    return { outcome: "invalid_request", reason: "unsupported_currency" };
  }

  // ------------------------------------------------------------
  // 4/5/6/7. Environnement prestataire : activé, configuration
  // EXPLICITEMENT `verified` (jamais `not_configured`/`configured`
  // seul), mode valide (déjà garanti fail-closed par le wrapper
  // lui-même).
  // ------------------------------------------------------------
  const environment = await getPaymentRuntimeProviderEnvironment({
    restaurantId: context.restaurantId,
    providerCode: PROVIDER_CODE,
  });
  if (!environment.isEnabled || environment.configurationStatus !== "verified") {
    return { outcome: "provider_unavailable" };
  }

  // ------------------------------------------------------------
  // 8. Point de terminaison résolvable depuis `mode` -- fail-closed
  // sur tout mode non supporté (défense en profondeur, `environment.mode`
  // est déjà garanti "test"|"live" à ce stade).
  // ------------------------------------------------------------
  let submissionUrl: string;
  try {
    submissionUrl = resolveMoneticoSubmissionUrl(environment.mode);
  } catch {
    return { outcome: "provider_unavailable" };
  }

  // ------------------------------------------------------------
  // Lecture (jamais une mutation) de la tentative PENDING courante --
  // décide REPRISE vs FRAIS, mais NE crée rien. La mutation P1
  // (`initiatePaymentAttempt`) reste différée à la toute fin de cette
  // fonction (voir le commentaire de fichier).
  // ------------------------------------------------------------
  const active = await getOrderActivePaymentAttempt({
    orderId: input.orderId,
    publicToken: input.publicToken,
    providerCode: PROVIDER_CODE,
  });
  const resumed = active !== null;

  // ------------------------------------------------------------
  // 9/10/11. Credential : référence existe, se lit, s'analyse.
  // ------------------------------------------------------------
  let credential: ReturnType<typeof parseMoneticoCredential>;
  try {
    const credentialRaw = await getPaymentProviderCredential({
      restaurantId: context.restaurantId,
      providerCode: PROVIDER_CODE,
    });
    credential = parseMoneticoCredential(credentialRaw);
  } catch {
    return { outcome: "provider_unavailable" };
  }

  // ------------------------------------------------------------
  // 12/13. Facturation OBLIGATOIRE (ferme P3B-V3-BILLING-REQUIRED-01) :
  // absente -> échec propre et DISTINCT (jamais une tentative
  // construite sans elle). Présente mais champs obligatoires Monetico
  // invalides -> même échec propre (mapToMoneticoBilling valide,
  // fail-closed, PAYMENT P3-B6, INCHANGÉ).
  // ------------------------------------------------------------
  const billing = await getOrderBillingContext({
    orderId: input.orderId,
    publicToken: input.publicToken,
  });
  if (billing === null) {
    return { outcome: "billing_required" };
  }
  let mappedBilling: ReturnType<typeof mapToMoneticoBilling>;
  try {
    mappedBilling = mapToMoneticoBilling(billing);
  } catch (err) {
    if (err instanceof MoneticoProtocolError) {
      return { outcome: "billing_required" };
    }
    throw err;
  }

  // ------------------------------------------------------------
  // 14/15/16. Mode de service AUTORITAIRE (jamais le JSON navigateur,
  // ferme P3B-V3-SHIPPING-AUTHORITY-01) -> applicabilité shipping
  // dérivée serveur. Lorsqu'applicable, les données shipping DOIVENT
  // provenir de l'adresse de livraison STOCKÉE de la commande
  // (`billing.source === "delivery_reuse"`, PAYMENT P3-B6) -- une
  // facturation `"manual"` (adresse potentiellement SANS RAPPORT avec
  // la livraison réelle) n'est JAMAIS envoyée comme `shipping` : fail
  // closed plutôt que d'envoyer une donnée non autoritaire à Monetico
  // (mandat §10 : "fail closed if the Monetico-required shipping data
  // is missing").
  // ------------------------------------------------------------
  const serviceModeResult = await getOrderServiceMode({
    orderId: input.orderId,
    publicToken: input.publicToken,
  });
  const shippingApplicable = serviceModeResult.serviceMode === "delivery";
  if (shippingApplicable && billing.source !== "delivery_reuse") {
    return { outcome: "billing_required" };
  }
  // PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 -- durcissement trouvé
  // par l'audit statique complet du mandat §5 (pas le blocage nommé
  // lui-même, mais dans son périmètre : "audit every deterministic
  // operation currently occurring after P1 initiation" impliquait
  // aussi de vérifier que toute opération déterministe AVANT P1 est
  // elle-même correctement rattrapée). `mapToMoneticoShipping` peut
  // lever `MoneticoProtocolError` (champ de livraison stocké trop
  // long/invalide) -- non rattrapé auparavant, ce qui aurait fait
  // fuiter une exception non gérée jusqu'à la route (mappée en 502
  // générique "unavailable", masquant à tort un problème de données
  // de commande derrière un faux signal de panne serveur). Reste
  // AVANT P1 dans les deux versions -- aucune tentative `pending`
  // n'était donc jamais créée par erreur, mais le résultat renvoyé à
  // l'appelant était trompeur. Corrigé : même traitement que
  // `mapToMoneticoBilling` ci-dessus (billing_required, jamais un
  // outcome nouveau -- une adresse de livraison invalide EST un
  // problème de facturation/données de commande du point de vue de
  // l'appelant).
  let mappedShipping: ReturnType<typeof mapToMoneticoShipping> | undefined;
  if (shippingApplicable) {
    try {
      mappedShipping = mapToMoneticoShipping(billing);
    } catch (err) {
      if (err instanceof MoneticoProtocolError) {
        return { outcome: "billing_required" };
      }
      throw err;
    }
  }

  // ------------------------------------------------------------
  // 17. Origine publique canonique -- JAMAIS `request.nextUrl.origin`
  // (ferme P3B-V3-RETURN-AUTHORITY-01).
  // ------------------------------------------------------------
  let origin: string;
  try {
    origin = resolveCanonicalPublicOrigin();
  } catch {
    return { outcome: "provider_unavailable" };
  }

  // ------------------------------------------------------------
  // 18. Jeton de relais de retour mintable -- `public_token` JAMAIS
  // transmis en clair à Monetico (ferme P3B-V3-PUBLIC-TOKEN-URL-01).
  // ------------------------------------------------------------
  let urlRetourOk: string;
  let urlRetourErr: string;
  try {
    const tokenOk = createReturnRelayToken({
      orderId: input.orderId,
      publicToken: input.publicToken,
      ttlSeconds: RETURN_RELAY_TOKEN_TTL_SECONDS,
    });
    const tokenErr = createReturnRelayToken({
      orderId: input.orderId,
      publicToken: input.publicToken,
      ttlSeconds: RETURN_RELAY_TOKEN_TTL_SECONDS,
    });
    const urlOk = new URL("/checkout/return/ok", origin);
    urlOk.searchParams.set("orderId", input.orderId);
    urlOk.searchParams.set("token", tokenOk);
    urlRetourOk = urlOk.toString();

    const urlErr = new URL("/checkout/return/err", origin);
    urlErr.searchParams.set("orderId", input.orderId);
    urlErr.searchParams.set("token", tokenErr);
    urlRetourErr = urlErr.toString();
  } catch {
    return { outcome: "provider_unavailable" };
  }

  // ==============================================================
  // TOUS les prérequis statiques ont réussi. C'est le SEUL point de
  // cette fonction où une NOUVELLE tentative `pending` peut être créée
  // (mutation P1) -- ferme P3B-V3-PREFLIGHT-01.
  // ==============================================================
  let reference: string;
  let amount: number;
  let currency: string;

  if (active !== null) {
    // REPRISE -- réutilise TELLE QUELLE la référence déjà stockée.
    // N'appelle JAMAIS `initiatePaymentAttempt` ici.
    reference = active.providerReference;
    amount = Number(active.amount);
    currency = active.currency;
  } else {
    // FRAIS -- amorce ALÉATOIRE (jamais `orderId`).
    reference = deriveMoneticoReference(randomUUID());
    const initiated = await initiatePaymentAttempt({
      orderId: input.orderId,
      providerCode: PROVIDER_CODE,
      providerReference: reference,
    });
    amount = initiated.amount;
    currency = initiated.currency;
  }

  // PAYMENT STREAM B — CURRENCY PREFLIGHT FIX v1.1 (ferme
  // STREAM-B-CURRENCY-PREFLIGHT-01) : DÉFENSE EN PROFONDEUR
  // uniquement -- la garde PRINCIPALE, qui empêche désormais toute
  // mutation pour une devise non supportée, est la lecture précoce
  // `getOrderCurrencyPreflight` (section 3bis, avant tout
  // branchement FRAIS/REPRISE). Ce second contrôle protège contre
  // toute divergence future non anticipée entre cette lecture précoce
  // et `active.currency`/`initiated.currency` -- ne devrait
  // structurellement jamais se déclencher en pratique (orders.currency
  // est immuable), mais reste actif pour ne jamais faire confiance
  // implicitement à cette invariance.
  if (currency !== MONETICO_SUPPORTED_CURRENCY) {
    return { outcome: "invalid_request", reason: "unsupported_currency" };
  }

  const fields = buildMoneticoPaymentRequest({
    credential,
    amount,
    currency,
    reference,
    language: canonicalLanguage,
    orderCorrelationId: input.orderId,
    billingContext: mappedBilling,
    shippingContext: mappedShipping,
    urlRetourOk,
    urlRetourErr,
  });

  return {
    outcome: "ready",
    submissionUrl,
    fields,
    mode: environment.mode,
    resumed,
  };
}
