import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  PaymentServerRpcError,
  PaymentServerUnavailableError,
} from "@/lib/server/payment-errors";
import {
  canonicalizePaymentProviderEventFields,
  computePaymentProviderEventFingerprint,
  type RawPaymentProviderEventFields,
} from "@/lib/server/payment-provider-event-fingerprint";

/**
 * PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
 * MISE À JOUR PAYMENT P3-B0 : ajoute `getPaymentTransactionCorrelation`
 * (voir sa propre section plus bas pour le détail et pour l'explication
 * de pourquoi elle est la SEULE addition de ce lot).
 * MISE À JOUR PAYMENT P3-B0 v2 (corrige PAY-P3-B0-01) : son contrat de
 * retour passe de 4 à 6 champs (`amount`/`currency` autoritatifs
 * ajoutés) -- v1 n'a jamais été publié, il n'existe donc aucune version
 * intermédiaire à préserver.
 * MISE À JOUR PAYMENT P3-B1 : ajoute `getPaymentRuntimeProviderConfig`,
 * réponse au STOP — PAYMENT P3-B RUNTIME PROVIDER CONFIG CAPABILITY
 * REQUIRED soulevé par PAYMENT P3-B (voir sa propre section plus bas).
 * MISE À JOUR PAYMENT P3-B2 : ajoute `getOrderPaymentContext`, réponse
 * au STOP — PAYMENT P3-B CUSTOMER ORDER AUTHORITY GAP soulevé par
 * PAYMENT P3-B (voir sa propre section plus bas).
 * MISE À JOUR PAYMENT P3-B3 : ajoute `getOrderActivePaymentAttempt`,
 * réponse au STOP — PAYMENT P3-B v2 PENDING ATTEMPT DATABASE CAPABILITY
 * REQUIRED soulevé par PAYMENT P3-B v2 (voir sa propre section plus
 * bas). Mini-lot de capacité SQL/serveur SEUL -- n'implémente AUCUN
 * checkout, AUCUNE route, AUCUNE reconstruction de formulaire hébergé
 * Monetico (hors périmètre, réservé à une future orchestration P3-B).
 * MISE À JOUR PAYMENT P3-B4 : ajoute `getPaymentRuntimeProviderEnvironment`,
 * ferme PAY-P3B-V2-06 ("deux autorités d'environnement non corrélées")
 * en exposant pour la première fois `payment_provider_configs.mode`
 * (déjà persisté par PAYMENT P2A) comme SEULE autorité d'environnement
 * tenant-scopée -- voir sa propre section plus bas. Capacité SŒUR de
 * `getPaymentRuntimeProviderConfig` (PAYMENT P3-B1) : n'en modifie ni
 * n'en remplace le contrat à 3 champs. Mini-lot de capacité SQL/
 * serveur SEUL, même périmètre que PAYMENT P3-B3 ci-dessus.
 * MISE À JOUR PAYMENT P3-B5 v1 : ajoute `recordPaymentProviderEvent` et
 * `updatePaymentProviderEventProcessingStatus`, ferme PAY-P3B-V2-03
 * (preuve durable locale AVANT tout ACK prestataire) et fournit la
 * surface requise par PAY-P3B-V2-02 (évènement enregistrable
 * indépendamment d'une mutation de payment_transactions/orders) -- voir
 * leurs propres sections plus bas. AUCUNE vérification MAC/signature
 * ici (fait confiance à l'appelant serveur, hors périmètre de ce lot).
 * N'appelle et ne modifie JAMAIS initiatePaymentAttempt/
 * confirmPaymentAttempt -- fournit UNIQUEMENT la surface de réception/
 * reprise durable de l'inbox lui-même.
 * MISE À JOUR PAYMENT P3-B5 v2 (corrige le re-audit Work de la
 * candidate v1, ferme P3B5-RETRY-01 et P3B5-FINGERPRINT-01) : ajoute
 * `claimPaymentProviderEvents` (primitif de revendication/bail
 * atomique, `FOR UPDATE SKIP LOCKED` côté SQL -- permet la reprise
 * après crash d'un évènement `received`/`failed_retryable` sans
 * accorder de SELECT direct sur la table). `recordPaymentProviderEvent`
 * N'ACCEPTE PLUS de fingerprint fourni par l'appelant : il canonicalise
 * D'ABORD les champs bruts reçus
 * (`canonicalizePaymentProviderEventFields`,
 * lib/server/payment-provider-event-fingerprint.ts), calcule le
 * fingerprint à partir de CES MÊMES valeurs canoniques, puis envoie CES
 * MÊMES valeurs canoniques à la RPC -- aucun écart n'est plus possible
 * entre ce qui est haché et ce qui est stocké, et aucune injection de
 * fingerprint arbitraire n'est plus possible via l'API publique de ce
 * wrapper. `updatePaymentProviderEventProcessingStatus` exige désormais
 * un `claimToken` obtenu exclusivement via
 * `claimPaymentProviderEvents` pour toute transition réelle (un jeton
 * périmé ou incorrect est rejeté fail-closed par la RPC elle-même).
 *
 * Enveloppe TYPÉE et GÉNÉRIQUE autour des RPC `service_role` déjà
 * publiées (P1, P3-A0, P3-B0, P3-B1, P3-B2, P3-B3, P3-B4, P3-B5) : `initiate_payment_attempt`,
 * `confirm_payment_attempt`, `get_payment_provider_credential`,
 * `get_payment_transaction_correlation`,
 * `get_payment_runtime_provider_config`, `get_order_payment_context`,
 * `get_order_active_payment_attempt`,
 * `get_payment_runtime_provider_environment`,
 * `record_payment_provider_event`,
 * `update_payment_provider_event_processing_status`,
 * `claim_payment_provider_events`.
 * Ce fichier ne connaît AUCUN prestataire (mission §2/§33/§34 de
 * P3-A1) : aucune mention de MAC/HMAC/TPE/société/Mercanet/point de
 * terminaison spécifique -- uniquement les contrats déjà publiés et
 * audités.
 *
 * Chaque wrapper appelle la RPC avec EXACTEMENT les arguments de sa
 * signature SQL (inspectée directement dans
 * supabase/DRAFT-lot-payment-p1-foundation.sql,
 * supabase/DRAFT-lot-payment-p3a0-secure-credential-read.sql,
 * supabase/DRAFT-lot-payment-p3b0-correlation-status-read.sql,
 * supabase/DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql
 * et supabase/DRAFT-lot-payment-p3b2-order-payment-context-read.sql
 * avant d'écrire ce fichier -- jamais devinée, mission §12) : aucun
 * montant, aucune devise, aucun identifiant de restaurant n'est fourni
 * de façon indépendante là où la RPC ne les accepte pas (mission
 * §11/§25) ; aucune charge brute spécifique à un prestataire n'est
 * transmise (mission §26).
 *
 * Aucune erreur Postgrest/Supabase brute ne traverse jamais la
 * frontière de ce module (mission §14/§16/§28) : `error.message`,
 * `error.details`, `error.hint` ne sont JAMAIS lus ni inclus dans le
 * message levé -- seul `error.code` (SQLSTATE) est éventuellement
 * consigné côté serveur (jamais renvoyé à l'appelant) à des fins de
 * diagnostic. Le secret renvoyé par `getPaymentProviderCredential` (la
 * seule des six RPC dont le résultat est sensible) n'est JAMAIS
 * journalisé, sous aucune forme -- pas même sa longueur. `public_token`
 * (entrée de `getOrderPaymentContext`) n'est lui non plus JAMAIS
 * journalisé (mission P3-B2 §14, "no token logging").
 */

// ------------------------------------------------------------------
// initiate_payment_attempt(p_order_id uuid, p_provider_code text,
//   p_provider_reference text)
//   returns table (transaction_id uuid, amount numeric, currency text)
// ------------------------------------------------------------------

export interface InitiatePaymentAttemptInput {
  orderId: string;
  providerCode: string;
  providerReference: string;
}

export interface InitiatePaymentAttemptResult {
  transactionId: string;
  amount: number;
  currency: string;
}

interface InitiatePaymentAttemptRow {
  transaction_id: string;
  amount: number | string;
  currency: string;
}

/**
 * Initie une tentative de paiement pour une commande déjà existante.
 * Le montant et la devise renvoyés sont RECALCULÉS et RENVOYÉS par
 * `initiate_payment_attempt` elle-même à partir de la commande -- ce
 * wrapper ne les calcule jamais et ne les accepte jamais en entrée
 * (P1 reste seule autorité, mission §11).
 */
export async function initiatePaymentAttempt(
  input: InitiatePaymentAttemptInput
): Promise<InitiatePaymentAttemptResult> {
  const client = getServiceRoleSupabaseClient();

  let data: InitiatePaymentAttemptRow[] | InitiatePaymentAttemptRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("initiate_payment_attempt", {
      p_order_id: input.orderId,
      p_provider_code: input.providerCode,
      p_provider_reference: input.providerReference,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("initiate_payment_attempt", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("initiate_payment_attempt", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  return {
    transactionId: String(row.transaction_id),
    amount: Number(row.amount),
    currency: String(row.currency),
  };
}

// ------------------------------------------------------------------
// confirm_payment_attempt(p_provider_code text, p_provider_reference
//   text, p_status text, p_authorization_reference text default null)
//   returns table (transaction_id uuid, order_id uuid, status text)
// ------------------------------------------------------------------

/** Valeurs acceptées par la contrainte CHECK de la RPC (SQL inspecté
 *  directement -- mission §12) : `'paid' | 'failed' | 'cancelled'`. */
export type PaymentAttemptStatus = "paid" | "failed" | "cancelled";

export interface ConfirmPaymentAttemptInput {
  providerCode: string;
  providerReference: string;
  status: PaymentAttemptStatus;
  /** Optionnelle -- correspond exactement à
   *  `p_authorization_reference text default null` côté SQL. Ne
   *  transporte JAMAIS de charge brute spécifique à un prestataire
   *  (mission §26) : une seule référence textuelle générique. */
  authorizationReference?: string | null;
}

export interface ConfirmPaymentAttemptResult {
  transactionId: string;
  orderId: string;
  status: string;
}

interface ConfirmPaymentAttemptRow {
  transaction_id: string;
  order_id: string;
  status: string;
}

/**
 * Confirme (ou rejette/annule) une tentative de paiement déjà initiée.
 * Ne met JAMAIS à jour `orders`/`payment_transactions` directement
 * (mission §12) -- `confirm_payment_attempt` reste seule responsable
 * de toute mutation, exactement comme `initiate_payment_attempt`.
 */
export async function confirmPaymentAttempt(
  input: ConfirmPaymentAttemptInput
): Promise<ConfirmPaymentAttemptResult> {
  const client = getServiceRoleSupabaseClient();

  let data: ConfirmPaymentAttemptRow[] | ConfirmPaymentAttemptRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("confirm_payment_attempt", {
      p_provider_code: input.providerCode,
      p_provider_reference: input.providerReference,
      p_status: input.status,
      p_authorization_reference: input.authorizationReference ?? null,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("confirm_payment_attempt", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("confirm_payment_attempt", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  return {
    transactionId: String(row.transaction_id),
    orderId: String(row.order_id),
    status: String(row.status),
  };
}

// ------------------------------------------------------------------
// get_payment_provider_credential(p_restaurant_id uuid, p_provider_code
//   text) returns text
// ------------------------------------------------------------------

export interface GetPaymentProviderCredentialInput {
  restaurantId: string;
  providerCode: string;
}

/**
 * Lit le credential déchiffré d'un prestataire de paiement pour un
 * restaurant donné, via la RPC P3-A0. La valeur renvoyée (une chaîne
 * NUE, jamais enveloppée dans un objet -- mission §13, "never
 * serialize it automatically") DOIT rester en mémoire de confiance
 * côté serveur : ce module ne la journalise jamais, ne la renvoie
 * jamais dans un message d'erreur, et son appelant est responsable de
 * ne jamais la faire traverser une frontière non fiable.
 */
export async function getPaymentProviderCredential(
  input: GetPaymentProviderCredentialInput
): Promise<string> {
  const client = getServiceRoleSupabaseClient();

  let data: string | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_payment_provider_credential", {
      p_restaurant_id: input.restaurantId,
      p_provider_code: input.providerCode,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    // JAMAIS `data` ici, même en cas d'erreur -- voir logRpcFailure,
    // qui ne reçoit jamais que error.code (SQLSTATE), jamais une
    // valeur pouvant provenir du credential lui-même.
    logRpcFailure("get_payment_provider_credential", error.code);
    throw new PaymentServerRpcError();
  }

  if (typeof data !== "string" || data.length === 0) {
    logRpcFailure("get_payment_provider_credential", "EMPTY_RESULT");
    throw new PaymentServerRpcError();
  }

  return data;
}

// ------------------------------------------------------------------
// get_payment_transaction_correlation(p_provider_code text,
//   p_provider_reference text)
//   returns table (restaurant_id uuid, order_id uuid, transaction_id
//     uuid, status text, amount numeric, currency text)
// PAYMENT P3-B0 v2 — CALLBACK CORRELATION + AUTHORITATIVE AMOUNT/
// CURRENCY + CUSTOMER PAYMENT STATUS READ (corrects PAY-P3-B0-01).
// ------------------------------------------------------------------

export interface GetPaymentTransactionCorrelationInput {
  providerCode: string;
  providerReference: string;
}

export interface PaymentTransactionCorrelation {
  restaurantId: string;
  orderId: string;
  transactionId: string;
  status: string;
  /**
   * Montant AUTORITATIF de la tentative de paiement, tel que stocké
   * par `initiate_payment_attempt` (P1) -- JAMAIS dérivé d'un callback
   * ou d'un navigateur. Type délibérément `string`, PAS `number`
   * (voir AMOUNT-CURRENCY-REPORT.txt pour l'analyse complète) :
   * PostgREST sérialise aujourd'hui `numeric` comme un NOMBRE JSON brut
   * (documenté, non garanti sans perte au-delà de la précision d'un
   * flottant double), et ce wrapper ne fait JAMAIS lui-même de
   * conversion `Number(...)` qui figerait une éventuelle imprécision
   * supplémentaire ou empêcherait de bénéficier d'une future
   * sérialisation en chaîne. `String(row.amount)` préserve fidèlement
   * quelle que soit la représentation reçue -- la comparaison
   * montant-pour-montant avec un `montant` Monetico analysé reste
   * explicitement la responsabilité d'une future orchestration P3-B,
   * jamais de ce wrapper.
   */
  amount: string;
  /**
   * Devise AUTORITATIVE, telle que stockée (aucune normalisation
   * ajoutée ici -- voir le commentaire SQL de la RPC : P1 n'impose
   * aucune contrainte de format sur cette colonne).
   */
  currency: string;
}

interface PaymentTransactionCorrelationRow {
  restaurant_id: string;
  order_id: string;
  transaction_id: string;
  status: string;
  amount: string | number;
  currency: string;
}

/**
 * Corrèle un callback prestataire (provider_code/provider_reference,
 * SEULS champs qu'un callback Monetico porte réellement -- jamais un
 * identifiant de tenant fourni par l'appelant) vers son restaurant_id/
 * order_id/transaction_id/status/amount/currency server-owned, via la
 * RPC `get_payment_transaction_correlation` (PAYMENT P3-B0 v2).
 * N'accepte JAMAIS de restaurant_id/tenant/amount/currency en entrée --
 * ce serait exactement l'identifiant non fiable que cette fonction
 * existe pour éviter de devoir faire confiance (mission §4/§14 de
 * PAYMENT P3-B ; mission §5/§18 de PAYMENT P3-B0-V2 pour amount/
 * currency spécifiquement).
 *
 * Ce wrapper est délibérément le SEUL ajouté par ce lot (PAYMENT
 * P3-B0 reste un lot de capacité SQL) : contrairement aux trois
 * wrappers ci-dessus, `get_order_payment_status` (RPC #2, la lecture
 * de statut CLIENT ANONYME) n'a PAS de wrapper ici -- son point d'appel
 * naturel est un futur code CLIENT (navigateur, clé anon), pas ce
 * module server-only/service_role ; lui donner un wrapper ici
 * présumerait une décision d'architecture (où vit ce code, quelle page
 * l'appelle) qui appartient à PAYMENT P3-B lui-même, hors périmètre de
 * ce lot.
 */
export async function getPaymentTransactionCorrelation(
  input: GetPaymentTransactionCorrelationInput
): Promise<PaymentTransactionCorrelation> {
  const client = getServiceRoleSupabaseClient();

  let data: PaymentTransactionCorrelationRow[] | PaymentTransactionCorrelationRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_payment_transaction_correlation", {
      p_provider_code: input.providerCode,
      p_provider_reference: input.providerReference,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("get_payment_transaction_correlation", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("get_payment_transaction_correlation", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  return {
    restaurantId: String(row.restaurant_id),
    orderId: String(row.order_id),
    transactionId: String(row.transaction_id),
    status: String(row.status),
    amount: String(row.amount),
    currency: String(row.currency),
  };
}

// ------------------------------------------------------------------
// get_payment_runtime_provider_config(p_restaurant_id uuid,
//   p_provider_code text)
//   returns table (provider_code text, is_enabled boolean,
//     configuration_status text)
// PAYMENT P3-B1 — RUNTIME PROVIDER ENABLEMENT READ.
// ------------------------------------------------------------------

export interface GetPaymentRuntimeProviderConfigInput {
  restaurantId: string;
  providerCode: string;
}

export interface PaymentRuntimeProviderConfig {
  providerCode: string;
  /**
   * Bascule d'activation runtime AUTORITATIVE (PAYMENT P1). Un futur
   * PAYMENT P3-B DOIT vérifier `isEnabled === true` avant tout appel à
   * `initiatePaymentAttempt` -- l'existence d'un credential
   * (`getPaymentProviderCredential`) ne suffit PAS et ne doit JAMAIS
   * s'y substituer (voir RUNTIME-ENABLEMENT-REPORT.txt).
   */
  isEnabled: boolean;
  /**
   * Cycle de vie du credential (PAYMENT P2A) -- valeurs possibles
   * EXACTEMENT `not_configured` | `configured` | `verified` (contrainte
   * CHECK SQL, non dupliquée ici : ce wrapper ne valide ni ne restreint
   * cette valeur, il la renvoie fidèlement telle que stockée). Ce
   * module NE décide PAS quelles valeurs sont "utilisables" pour
   * initier un paiement -- cette décision d'orchestration appartient
   * explicitement à un futur PAYMENT P3-B (voir RPC-CONTRACT-REPORT.txt
   * pour la discussion complète).
   */
  configurationStatus: string;
}

interface PaymentRuntimeProviderConfigRow {
  provider_code: string;
  is_enabled: boolean;
  configuration_status: string;
}

/**
 * Lit l'état d'activation runtime et le cycle de vie du credential
 * d'une configuration prestataire, pour un couple (restaurant_id,
 * provider_code) exact, via la RPC `get_payment_runtime_provider_config`
 * (PAYMENT P3-B1). Répond au STOP — PAYMENT P3-B RUNTIME PROVIDER
 * CONFIG CAPABILITY REQUIRED de PAYMENT P3-B : ni
 * `get_merchant_payment_provider_config` (modèle de confiance
 * marchand-authentifié, jamais appelable par ce module server-only/
 * service_role) ni `getPaymentProviderCredential` (ne lit
 * délibérément pas `is_enabled`) ne remplissent ce rôle.
 *
 * N'ACCEPTE JAMAIS restaurant_id comme une valeur d'AUTORITÉ fournie
 * par le navigateur -- l'appelant de ce wrapper (un futur PAYMENT P3-B)
 * doit dériver restaurant_id depuis un état de commande de confiance
 * (jamais depuis une entrée client directe), exactement comme pour
 * `getPaymentProviderCredential`. Ce module lui-même ne fait aucune
 * hypothèse sur la provenance de cette valeur -- il transmet
 * uniquement ce qu'on lui fournit à la RPC, qui reste elle-même
 * service_role UNIQUEMENT (EXECUTE refusé à anon/authenticated/PUBLIC).
 */
export async function getPaymentRuntimeProviderConfig(
  input: GetPaymentRuntimeProviderConfigInput
): Promise<PaymentRuntimeProviderConfig> {
  const client = getServiceRoleSupabaseClient();

  let data: PaymentRuntimeProviderConfigRow[] | PaymentRuntimeProviderConfigRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_payment_runtime_provider_config", {
      p_restaurant_id: input.restaurantId,
      p_provider_code: input.providerCode,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("get_payment_runtime_provider_config", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("get_payment_runtime_provider_config", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  return {
    providerCode: String(row.provider_code),
    isEnabled: Boolean(row.is_enabled),
    configurationStatus: String(row.configuration_status),
  };
}

// ------------------------------------------------------------------
// get_order_payment_context(p_order_id uuid, p_public_token uuid)
//   returns table (restaurant_id uuid, payment_status text)
// PAYMENT P3-B2 — ORDER PAYMENT CONTEXT READ.
// ------------------------------------------------------------------

export interface GetOrderPaymentContextInput {
  orderId: string;
  /**
   * Preuve de possession du client anonyme (`orders.public_token`,
   * même modèle que `mark_whatsapp_opened`/`get_order_payment_status`).
   * JAMAIS journalisée par ce wrapper (mission §14, "no token
   * logging") -- y compris en cas d'échec.
   */
  publicToken: string;
}

export interface OrderPaymentContext {
  restaurantId: string;
  /**
   * Valeur EXACTE stockée par `orders.payment_status` (contrainte
   * CHECK PAYMENT P1 : `not_required` | `pending` | `paid` | `failed` |
   * `cancelled`). Ce wrapper ne décide d'AUCUNE politique
   * d'éligibilité sur cette valeur -- cette décision reste
   * explicitement celle d'un futur PAYMENT P3-B (mission §15, "Future
   * P3-B will decide eligibility").
   */
  paymentStatus: string;
}

interface OrderPaymentContextRow {
  restaurant_id: string;
  payment_status: string;
}

/**
 * Vérifie la possession client anonyme (`order_id` + `public_token`,
 * modèle EXACT déjà établi par `mark_whatsapp_opened`/
 * `get_order_payment_status`) et renvoie le couple minimal
 * restaurant_id/payment_status nécessaire à un futur runtime de
 * paiement pour établir l'autorité tenant AVANT tout appel à
 * `getPaymentRuntimeProviderConfig` puis `initiatePaymentAttempt`, via
 * la RPC `get_order_payment_context` (PAYMENT P3-B2). Répond au
 * STOP — PAYMENT P3-B CUSTOMER ORDER AUTHORITY GAP de PAYMENT P3-B :
 * ni `get_order_payment_status` (contrat CLIENT public, exclut
 * délibérément restaurant_id) ni `mark_whatsapp_opened` (`returns
 * void`, et mute la commande) ni `initiate_payment_attempt` (ne
 * vérifie aucun `public_token`) ne remplissaient ce rôle.
 *
 * N'ACCEPTE JAMAIS restaurant_id/provider_code en entrée -- seuls
 * `orderId`/`publicToken`, exactement la preuve de possession que le
 * navigateur peut légitimement transmettre (mission §6/§9 de
 * PAYMENT P3-B ; mission §6 de PAYMENT P3-B2, "No tenant ID from
 * caller"). Une paire invalide (mauvais jeton, commande inexistante,
 * ou les deux) est structurellement indiscernable côté RPC (aucune
 * ligne renvoyée dans tous les cas, mission §7/§17 "possession
 * confidentiality") -- ce wrapper la traite comme n'importe quel
 * résultat vide inattendu (`PaymentServerRpcError`, générique,
 * SANS distinction observable d'une autre panne RPC), à charge pour
 * un futur PAYMENT P3-B de la traduire en message client générique
 * (mission §14 de PAYMENT P3-B2, "no order existence leak beyond
 * generic failure").
 */
export async function getOrderPaymentContext(
  input: GetOrderPaymentContextInput
): Promise<OrderPaymentContext> {
  const client = getServiceRoleSupabaseClient();

  let data: OrderPaymentContextRow[] | OrderPaymentContextRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_order_payment_context", {
      p_order_id: input.orderId,
      p_public_token: input.publicToken,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("get_order_payment_context", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("get_order_payment_context", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  return {
    restaurantId: String(row.restaurant_id),
    paymentStatus: String(row.payment_status),
  };
}

// ------------------------------------------------------------------
// get_order_active_payment_attempt(p_order_id uuid, p_public_token
//   uuid, p_provider_code text)
//   returns table (provider_reference text, amount numeric, currency
//     text)
// PAYMENT P3-B3 — ACTIVE PAYMENT ATTEMPT RESUME READ.
// ------------------------------------------------------------------

export interface GetOrderActivePaymentAttemptInput {
  orderId: string;
  /**
   * Preuve de possession du client anonyme (`orders.public_token`,
   * même modèle que `getOrderPaymentContext`/`mark_whatsapp_opened`).
   * JAMAIS journalisée par ce wrapper (mission P3-B2 §14, "no token
   * logging", reprise à l'identique ici) -- y compris en cas d'échec.
   */
  publicToken: string;
  providerCode: string;
}

export interface OrderActivePaymentAttempt {
  /**
   * Référence EXACTE, déjà stockée par `initiate_payment_attempt`
   * (P1) au moment de l'initiation d'origine -- ce wrapper n'en génère
   * jamais et n'en dérive jamais une nouvelle. Reconstruire un
   * formulaire hébergé prestataire avec CETTE MÊME référence reste la
   * responsabilité d'une future orchestration P3-B v2 (mission P3-B3
   * §10, "one pending payment_transaction = one provider_reference =
   * every retry/resume" ; ce module ne décide et ne fait rien de plus
   * que la restituer fidèlement).
   */
  providerReference: string;
  /**
   * Montant AUTORITATIF de la tentative PENDING courante, tel que
   * stocké par `initiate_payment_attempt` -- jamais recalculé depuis
   * `orders`/le panier/le navigateur (mission P3-B3 §9). Type
   * délibérément `string`, PAS `number`, pour la même raison de
   * précision PostgREST déjà documentée sur
   * `PaymentTransactionCorrelation.amount` ci-dessus -- ce wrapper ne
   * fait jamais lui-même de conversion `Number(...)`.
   */
  amount: string;
  /** Devise AUTORITATIVE, telle que stockée (aucune normalisation
   *  ajoutée ici, même convention que `PaymentTransactionCorrelation.
   *  currency` ci-dessus). */
  currency: string;
}

interface OrderActivePaymentAttemptRow {
  provider_reference: string;
  amount: string | number;
  currency: string;
}

/**
 * Vérifie la possession client anonyme (`order_id` + `public_token`,
 * modèle EXACT déjà établi par `getOrderPaymentContext`/
 * `get_order_payment_status`/`mark_whatsapp_opened`) et renvoie
 * l'identité minimale (provider_reference/amount/currency) de la
 * tentative de paiement PENDING COURANTE d'une commande, via la RPC
 * `get_order_active_payment_attempt` (PAYMENT P3-B3). Répond au
 * STOP — PAYMENT P3-B v2 PENDING ATTEMPT DATABASE CAPABILITY REQUIRED :
 * ni `getOrderPaymentContext` (contrat P3-B2 volontairement minimal,
 * exclut delibérément provider_reference/amount/currency/
 * transaction_id) ni `getPaymentTransactionCorrelation` (keyed par la
 * référence en ENTRÉE, inutilisable pour une reprise qui a précisément
 * perdu cette référence) ne remplissaient ce rôle.
 *
 * REPRISE SEULE (mission P3-B3 §2/§11) : cette fonction ne fait QUE
 * lire -- elle n'expire, n'annule, ni ne remplace jamais une tentative.
 * Une absence de résultat (aucune ligne) signifie simplement "aucune
 * tentative pending courante à reprendre pour cette commande/ce
 * provider" -- ce wrapper ne la traduit PAS automatiquement en erreur
 * (contrairement aux autres wrappers de ce module) : l'absence est un
 * résultat métier légitime et attendu (par exemple "aucune tentative
 * n'a encore jamais été initiée", ou "la tentative précédente est déjà
 * dans un état terminal") -- à charge de l'appelant (une future
 * orchestration P3-B v2) de décider s'il doit alors appeler
 * `initiatePaymentAttempt` pour une NOUVELLE tentative. Un échec RPC
 * (erreur Postgrest) reste, lui, traité comme toute autre panne
 * serveur ci-dessous.
 *
 * N'ACCEPTE JAMAIS restaurant_id en entrée -- seuls `orderId`/
 * `publicToken`/`providerCode`, exactement la preuve de possession que
 * le navigateur peut légitimement transmettre plus le provider
 * server-controlled (mission P3-B3 §6, "Runtime P3-B v2 will pass
 * server-controlled: monetico"). Ce wrapper ne décide lui-même
 * d'aucune politique de reconstruction de formulaire -- il restitue
 * fidèlement le contrat de la RPC, rien de plus.
 */
export async function getOrderActivePaymentAttempt(
  input: GetOrderActivePaymentAttemptInput
): Promise<OrderActivePaymentAttempt | null> {
  const client = getServiceRoleSupabaseClient();

  let data: OrderActivePaymentAttemptRow[] | OrderActivePaymentAttemptRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_order_active_payment_attempt", {
      p_order_id: input.orderId,
      p_public_token: input.publicToken,
      p_provider_code: input.providerCode,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("get_order_active_payment_attempt", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // Absence légitime -- voir le commentaire de la fonction : PAS une
    // erreur, jamais journalisée comme une panne RPC.
    return null;
  }

  return {
    providerReference: String(row.provider_reference),
    amount: String(row.amount),
    currency: String(row.currency),
  };
}

// ------------------------------------------------------------------
// get_payment_runtime_provider_environment(p_restaurant_id uuid,
//   p_provider_code text)
//   returns table (provider_code text, is_enabled boolean,
//                  configuration_status text, mode text)
// PAYMENT P3-B4 — PROVIDER RUNTIME MODE READ.
// ------------------------------------------------------------------

export interface GetPaymentRuntimeProviderEnvironmentInput {
  restaurantId: string;
  providerCode: string;
}

/**
 * Valeurs EXACTES de `payment_provider_configs.mode` (contrainte CHECK
 * SQL `payment_provider_configs_mode_check`, PAYMENT P1, non modifiée
 * par ce lot). Jamais `sandbox`/`production` -- ces libellés
 * n'existent nulle part au niveau base ou wrapper (mission §12).
 */
export type PaymentProviderRuntimeMode = "test" | "live";

export interface PaymentRuntimeProviderEnvironment {
  providerCode: string;
  /** Identique à `PaymentRuntimeProviderConfig.isEnabled` (PAYMENT
   *  P3-B1) -- dupliqué ici (pas réexporté) pour que ce wrapper reste
   *  un instantané cohérent d'un SEUL appel RPC (voir le commentaire
   *  de conception de la RPC elle-même sur le risque d'incohérence de
   *  snapshot entre deux lectures séparées). */
  isEnabled: boolean;
  /** Identique à `PaymentRuntimeProviderConfig.configurationStatus`
   *  (PAYMENT P3-B1) -- même remarque que `isEnabled` ci-dessus. */
  configurationStatus: string;
  /**
   * AUTORITÉ UNIQUE d'environnement runtime pour ce couple
   * (restaurant_id, provider_code) -- ferme PAY-P3B-V2-06 ("deux
   * autorités d'environnement non corrélées"). Un futur PAYMENT P3-B
   * v3 DOIT dériver son choix de point de terminaison (bac à sable vs
   * production) EXCLUSIVEMENT de cette valeur, et ne DOIT JAMAIS
   * introduire ni consulter une variable d'environnement globale de
   * type `PAYMENT_MONETICO_MODE` (ou équivalente) pour ce choix -- le
   * seul autre interrupteur global valide et sans rapport reste le
   * kill switch `PAYMENT_CHECKOUT_RUNTIME_ENABLED`, qui n'exprime
   * aucun mode et ne doit jamais être confondu avec cette valeur.
   */
  mode: PaymentProviderRuntimeMode;
}

interface PaymentRuntimeProviderEnvironmentRow {
  provider_code: string;
  is_enabled: boolean;
  configuration_status: string;
  mode: string;
}

/**
 * Lit l'activation runtime, le cycle de vie du credential ET le mode
 * d'environnement tenant-scopé (PAYMENT P1, écrit UNIQUEMENT par
 * `set_payment_provider_credentials`/PAYMENT P2A) d'une configuration
 * prestataire, pour un couple (restaurant_id, provider_code) exact,
 * via la RPC `get_payment_runtime_provider_environment` (PAYMENT
 * P3-B4). Capacité SŒUR de `getPaymentRuntimeProviderConfig`
 * (PAYMENT P3-B1) -- n'en modifie ni n'en remplace le contrat à 3
 * champs, qui reste inchangé et continue d'exister pour tout appelant
 * qui n'a pas besoin de `mode` (mission §5/§7, choix RPC sœur plutôt
 * que réouverture du contrat P3-B1).
 *
 * DÉVIATION DÉLIBÉRÉE par rapport à `configurationStatus`
 * (renvoyé fidèlement, sans validation stricte, par
 * `getPaymentRuntimeProviderConfig`) : `mode` EST validé ici comme
 * l'union stricte `"test" | "live"` avant d'être renvoyé. Justification
 * : `configurationStatus` ne pilote aujourd'hui que des décisions de
 * cycle de vie/affichage, alors que `mode` pilotera directement, dans
 * un futur PAYMENT P3-B v3, le CHOIX DU POINT DE TERMINAISON financier
 * (bac à sable vs production réelle chez le prestataire) -- une valeur
 * ambiguë ou inattendue à cet endroit précis a des conséquences de
 * sécurité (risque d'appel réel en environnement de production) bien
 * plus graves qu'un `configurationStatus` inattendu. Ce wrapper échoue
 * donc fermé (throw) si jamais la base renvoyait une valeur hors de
 * cette union -- y compris si une dérive de schéma future retirait ou
 * modifiait la contrainte CHECK SQL correspondante -- plutôt que de
 * laisser une valeur non fiable atteindre une logique de sélection de
 * point de terminaison.
 *
 * N'ACCEPTE JAMAIS restaurant_id comme une valeur d'AUTORITÉ fournie
 * par le navigateur -- même règle que `getPaymentRuntimeProviderConfig`
 * (PAYMENT P3-B1) : l'appelant (un futur PAYMENT P3-B v3) doit dériver
 * restaurant_id depuis un état de commande de confiance, jamais depuis
 * une entrée client directe. La RPC sous-jacente reste elle-même
 * service_role UNIQUEMENT (EXECUTE refusé à anon/authenticated/
 * PUBLIC), lecture pure, sans verrou, sans SQL dynamique.
 *
 * NE FAIT PARTIE D'AUCUNE orchestration de paiement -- ce module ne
 * sélectionne, n'initie, ni n'implémente aucun composant de checkout,
 * de callback, ou de sélection de point de terminaison prestataire
 * (mission §1/§17) : il se limite strictement à la lecture typée,
 * sans fuite d'erreur Postgrest brute, de cette configuration.
 */
export async function getPaymentRuntimeProviderEnvironment(
  input: GetPaymentRuntimeProviderEnvironmentInput
): Promise<PaymentRuntimeProviderEnvironment> {
  const client = getServiceRoleSupabaseClient();

  let data:
    | PaymentRuntimeProviderEnvironmentRow[]
    | PaymentRuntimeProviderEnvironmentRow
    | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("get_payment_runtime_provider_environment", {
      p_restaurant_id: input.restaurantId,
      p_provider_code: input.providerCode,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("get_payment_runtime_provider_environment", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("get_payment_runtime_provider_environment", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  const rawMode = String(row.mode);
  if (rawMode !== "test" && rawMode !== "live") {
    // Échec fermé : jamais renvoyer un mode ambigu à un futur appelant
    // qui en déduirait un point de terminaison financier (voir le
    // commentaire de conception ci-dessus).
    logRpcFailure("get_payment_runtime_provider_environment", "INVALID_MODE");
    throw new PaymentServerRpcError();
  }

  return {
    providerCode: String(row.provider_code),
    isEnabled: Boolean(row.is_enabled),
    configurationStatus: String(row.configuration_status),
    mode: rawMode,
  };
}

// ------------------------------------------------------------------
// record_payment_provider_event(p_provider_code text,
//   p_provider_reference text, p_event_fingerprint text,
//   p_provider_event_type text, p_provider_event_code text default
//   null, p_amount numeric default null, p_currency text default
//   null, p_authorization_reference text default null)
//   returns table (id uuid, restaurant_id uuid, order_id uuid,
//                  payment_transaction_id uuid, provider_event_type
//                  text, processing_status text, created_at
//                  timestamptz, is_new_event boolean)
// PAYMENT P3-B5 — DURABLE PROVIDER CALLBACK INBOX.
// ------------------------------------------------------------------

/**
 * AJOUT v2 (ferme P3B5-FINGERPRINT-01) : ce type n'a PLUS de champ
 * `eventFingerprint` -- l'API publique de ce wrapper n'accepte PLUS
 * AUCUN fingerprint fourni par l'appelant. Il est désormais un ALIAS
 * direct de `RawPaymentProviderEventFields`
 * (lib/server/payment-provider-event-fingerprint.ts) : les champs
 * BRUTS d'un évènement déjà authentifié, PAS ENCORE canonicalisés --
 * `recordPaymentProviderEvent` se charge lui-même de la
 * canonicalisation ET du calcul du fingerprint, de sorte qu'aucun
 * appelant ne puisse jamais fournir un fingerprint sans lien prouvé
 * avec les champs réellement envoyés.
 */
export type RecordPaymentProviderEventInput = RawPaymentProviderEventFields;

export interface PaymentProviderEventRecord {
  id: string;
  restaurantId: string;
  orderId: string;
  paymentTransactionId: string;
  providerEventType: string;
  processingStatus: string;
  createdAt: string;
  /** `false` signifie que CET appel a rencontré un évènement déjà
   *  enregistré (même provider_code/provider_reference/
   *  event_fingerprint) -- l'appelant reçoit alors la MÊME ligne
   *  logique préexistante, jamais un doublon. Un futur orchestrateur
   *  ne doit déclencher un traitement métier QUE lorsque cette valeur
   *  est `true` (mission §19, "one logical event"). */
  isNewEvent: boolean;
}

interface PaymentProviderEventRecordRow {
  id: string;
  restaurant_id: string;
  order_id: string;
  payment_transaction_id: string;
  provider_event_type: string;
  processing_status: string;
  created_at: string;
  is_new_event: boolean;
}

/**
 * Enregistre durablement UN évènement prestataire DÉJÀ AUTHENTIFIÉ
 * (MAC/signature vérifiée par l'appelant AVANT cet appel -- ce wrapper
 * et la RPC qu'il enveloppe ne vérifient eux-mêmes AUCUNE
 * authenticité) via `record_payment_provider_event` (PAYMENT P3-B5).
 * Ferme PAY-P3B-V2-03 (preuve durable locale AVANT tout ACK prestataire
 * -- ce wrapper doit être appelé et sa promesse RÉSOLUE avec succès
 * AVANT qu'un futur adaptateur ne renvoie un ACK de succès au
 * prestataire) et fournit la surface requise par PAY-P3B-V2-02
 * (évènement enregistrable indépendamment de toute mutation de
 * `payment_transactions`/`orders.payment_status`).
 *
 * `restaurantId`/`orderId`/`paymentTransactionId` ne sont JAMAIS
 * acceptés en entrée -- la RPC sous-jacente les DÉRIVE elle-même,
 * exclusivement depuis `payment_transactions`, via
 * (`providerCode`, `providerReference`) (même clé de corrélation déjà
 * établie par `getPaymentTransactionCorrelation`, PAYMENT P3-B0 v2).
 * Un couple sans correspondance ou ambigu échoue fermé (voir gestion
 * d'erreur ci-dessous) -- jamais une valeur fournie par l'appelant ne
 * peut forcer une corrélation incohérente (mission §14/§15).
 *
 * IDEMPOTENT sous rejeu ET sous concurrence réelle (mission §11/§19) :
 * un rejeu exact du même évènement (mêmes champs canoniques -> même
 * fingerprint calculé) renvoie la MÊME ligne logique (`isNewEvent:
 * false`), jamais un doublon ni une erreur. Un `providerReference`
 * identique avec des champs canoniques DIFFÉRENTS (ex. un refus PUIS un
 * paiement accepté pour la même tentative) crée un NOUVEL évènement
 * distinct -- jamais une contrainte "un seul évènement par référence"
 * (mission §20, "must support same provider_reference + different
 * event fingerprint").
 *
 * AJOUT v2 (ferme P3B5-FINGERPRINT-01) : ce wrapper CANONICALISE
 * D'ABORD les champs bruts reçus
 * (`canonicalizePaymentProviderEventFields`), calcule
 * `event_fingerprint` EXCLUSIVEMENT à partir de CES valeurs canoniques
 * (`computePaymentProviderEventFingerprint`), PUIS envoie CES MÊMES
 * valeurs canoniques (jamais les brutes) à la RPC -- il n'existe donc
 * plus AUCUN chemin par lequel la valeur hachée et la valeur stockée
 * pourraient diverger, et AUCUNE façon pour un appelant de fournir un
 * fingerprint qui ne correspond pas aux champs envoyés (l'API publique
 * de ce wrapper n'a plus de paramètre de fingerprint du tout). Une
 * valeur `amount` malformée (non numérique, ou nécessitant un arrondi
 * au-delà de 2 décimales) fait échouer la canonicalisation
 * SYNCHRONEMENT, AVANT tout appel réseau, avec
 * `PaymentProviderEventCanonicalizationError`
 * (lib/server/payment-provider-event-fingerprint.ts) -- une erreur de
 * validation locale, jamais une erreur RPC/Postgrest.
 *
 * N'APPELLE ET NE MODIFIE JAMAIS `initiatePaymentAttempt`/
 * `confirmPaymentAttempt`, ni aucun champ de `payment_transactions`/
 * `orders` -- ce wrapper, comme la RPC qu'il enveloppe, se limite
 * STRICTEMENT à la réception durable de l'évènement (mission §34,
 * "durable receipt and payment-state mutation must remain
 * separable").
 */
export async function recordPaymentProviderEvent(
  input: RecordPaymentProviderEventInput
): Promise<PaymentProviderEventRecord> {
  const canonical = canonicalizePaymentProviderEventFields(input);
  const eventFingerprint = computePaymentProviderEventFingerprint(canonical);

  const client = getServiceRoleSupabaseClient();

  let data: PaymentProviderEventRecordRow[] | PaymentProviderEventRecordRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("record_payment_provider_event", {
      p_provider_code: canonical.providerCode,
      p_provider_reference: canonical.providerReference,
      p_event_fingerprint: eventFingerprint,
      p_provider_event_type: canonical.providerEventType,
      p_provider_event_code: canonical.providerEventCode,
      p_amount: canonical.amount,
      p_currency: canonical.currency,
      p_authorization_reference: canonical.authorizationReference,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("record_payment_provider_event", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("record_payment_provider_event", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  return {
    id: String(row.id),
    restaurantId: String(row.restaurant_id),
    orderId: String(row.order_id),
    paymentTransactionId: String(row.payment_transaction_id),
    providerEventType: String(row.provider_event_type),
    processingStatus: String(row.processing_status),
    createdAt: String(row.created_at),
    isNewEvent: Boolean(row.is_new_event),
  };
}

// ------------------------------------------------------------------
// update_payment_provider_event_processing_status(p_event_id uuid,
//   p_claim_token uuid, p_new_status text, p_error_class text default
//   null)
//   returns table (id uuid, processing_status text, retry_count
//                  integer, processed_at timestamptz)
// PAYMENT P3-B5 v2 — DURABLE PROVIDER CALLBACK INBOX (surface de
// reprise). AJOUT v2 (ferme P3B5-RETRY-01) : `p_claim_token` est
// désormais REQUIS -- voir `claimPaymentProviderEvents` ci-dessous.
// ------------------------------------------------------------------

/** Valeurs EXACTES acceptées par `p_new_status` -- `'received'` n'en
 *  fait JAMAIS partie (c'est l'état INITIAL posé par
 *  `record_payment_provider_event`, jamais une cible de transition). */
export type PaymentProviderEventProcessingTargetStatus =
  | "applied"
  | "ignored"
  | "failed_retryable"
  | "failed_terminal";

export interface UpdatePaymentProviderEventProcessingStatusInput {
  eventId: string;
  /** AJOUT v2 (ferme P3B5-RETRY-01) : jeton de bail obtenu
   *  EXCLUSIVEMENT via `claimPaymentProviderEvents` -- REQUIS pour
   *  toute transition RÉELLE (le replay idempotent d'un état DÉJÀ
   *  terminal reste exempté côté RPC, mais ce wrapper exige toujours
   *  la valeur pour rester un contrat simple et prévisible). Un jeton
   *  incorrect ou un bail expiré est rejeté fail-closed par la RPC --
   *  c'est précisément ce qui empêche un worker périmé (ayant perdu
   *  son bail après un crash/redémarrage) d'écraser une revendication
   *  plus récente d'un autre worker. */
  claimToken: string;
  newStatus: PaymentProviderEventProcessingTargetStatus;
  /** Classification COURTE et assainie -- JAMAIS une pile d'appel brute
   *  (mission §18). La RPC sous-jacente rejette toute valeur de plus de
   *  200 caractères. */
  errorClass?: string;
}

export interface PaymentProviderEventProcessingState {
  id: string;
  processingStatus: string;
  retryCount: number;
  processedAt: string;
}

interface PaymentProviderEventProcessingStateRow {
  id: string;
  processing_status: string;
  retry_count: number;
  processed_at: string;
}

/**
 * Fait transitionner `processing_status` d'UN évènement déjà enregistré
 * via `update_payment_provider_event_processing_status` (PAYMENT
 * P3-B5). Machine à états à VERROUILLAGE TERMINAL, EXACTEMENT comme la
 * RPC sous-jacente l'impose (transitions autorisées listées dans son
 * propre commentaire SQL) -- ce wrapper n'ajoute ni n'assouplit aucune
 * règle de transition, il se contente de relayer fidèlement le succès
 * ou le rejet de la RPC.
 *
 * NE MODIFIE JAMAIS `payment_transactions.status`/
 * `orders.payment_status`/`orders.current_payment_transaction_id` --
 * ce wrapper, comme la RPC qu'il enveloppe, fournit UNIQUEMENT la
 * surface de reprise/traitement DURABLE de l'inbox lui-même (mission
 * §18, "acceptable to provide the durable retry surface only"). Une
 * décision de mutation métier (appeler `confirmPaymentAttempt`) reste
 * la responsabilité d'une future orchestration SÉPARÉE, invoquée
 * indépendamment de cet appel.
 *
 * AJOUT v2 (ferme P3B5-RETRY-01) : exige `input.claimToken`, obtenu
 * exclusivement via `claimPaymentProviderEvents`. La RPC sous-jacente
 * rejette fail-closed tout jeton incorrect ou tout bail expiré --
 * ce wrapper ne relâche ni n'assouplit cette vérification.
 */
export async function updatePaymentProviderEventProcessingStatus(
  input: UpdatePaymentProviderEventProcessingStatusInput
): Promise<PaymentProviderEventProcessingState> {
  const client = getServiceRoleSupabaseClient();

  let data:
    | PaymentProviderEventProcessingStateRow[]
    | PaymentProviderEventProcessingStateRow
    | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("update_payment_provider_event_processing_status", {
      p_event_id: input.eventId,
      p_claim_token: input.claimToken,
      p_new_status: input.newStatus,
      p_error_class: input.errorClass ?? null,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("update_payment_provider_event_processing_status", error.code);
    throw new PaymentServerRpcError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logRpcFailure("update_payment_provider_event_processing_status", "EMPTY_ROW");
    throw new PaymentServerRpcError();
  }

  return {
    id: String(row.id),
    processingStatus: String(row.processing_status),
    retryCount: Number(row.retry_count),
    processedAt: String(row.processed_at),
  };
}

// ------------------------------------------------------------------
// claim_payment_provider_events(p_batch_size integer default 20,
//   p_lease_seconds integer default 60)
//   returns table (id uuid, restaurant_id uuid, order_id uuid,
//                  payment_transaction_id uuid, provider_code text,
//                  provider_reference text, event_fingerprint text,
//                  provider_event_type text, provider_event_code text,
//                  amount numeric, currency text,
//                  authorization_reference text, processing_status
//                  text, retry_count integer, claim_token uuid,
//                  claim_expires_at timestamptz)
// PAYMENT P3-B5 v2 — DURABLE PROVIDER CALLBACK INBOX. AJOUT v2, ferme
// P3B5-RETRY-01.
// ------------------------------------------------------------------

export interface ClaimPaymentProviderEventsInput {
  /** Nombre maximal d'évènements à revendiquer en un appel -- la RPC
   *  sous-jacente échoue fermé hors de [1, 100]. Défaut RPC : 20. */
  batchSize?: number;
  /** Durée du bail en secondes -- la RPC sous-jacente échoue fermé hors
   *  de [5, 3600]. Défaut RPC : 60. */
  leaseSeconds?: number;
}

export interface ClaimedPaymentProviderEvent {
  id: string;
  restaurantId: string;
  orderId: string;
  paymentTransactionId: string;
  providerCode: string;
  providerReference: string;
  eventFingerprint: string;
  providerEventType: string;
  providerEventCode: string | null;
  amount: string | null;
  currency: string | null;
  authorizationReference: string | null;
  processingStatus: string;
  retryCount: number;
  /** À fournir tel quel à `updatePaymentProviderEventProcessingStatus`
   *  pour finaliser CET évènement précis -- un jeton périmé ou
   *  incorrect est rejeté fail-closed par la RPC de transition. */
  claimToken: string;
  claimExpiresAt: string;
}

interface ClaimedPaymentProviderEventRow {
  id: string;
  restaurant_id: string;
  order_id: string;
  payment_transaction_id: string;
  provider_code: string;
  provider_reference: string;
  event_fingerprint: string;
  provider_event_type: string;
  provider_event_code: string | null;
  amount: string | null;
  currency: string | null;
  authorization_reference: string | null;
  processing_status: string;
  retry_count: number;
  claim_token: string;
  claim_expires_at: string;
}

/**
 * Revendique ATOMIQUEMENT un lot borné d'évènements ÉLIGIBLES
 * (`received` ou `failed_retryable`, jamais revendiqués ou dont le
 * bail précédent a expiré) via `claim_payment_provider_events`
 * (PAYMENT P3-B5 v2). Ferme P3B5-RETRY-01 : c'est le SEUL moyen
 * supporté, pour un processus serveur ayant perdu sa mémoire (crash,
 * redémarrage, nouveau worker), de retrouver et reprendre un évènement
 * durablement enregistré -- sans jamais accorder de SELECT direct sur
 * `payment_provider_events` (la table reste RPC-only, mission §22).
 *
 * SÛR SOUS CONCURRENCE RÉELLE (mission §7) : la RPC sous-jacente
 * utilise `FOR UPDATE SKIP LOCKED` -- deux appels concurrents de cette
 * fonction (même par des processus/serveurs distincts) ne peuvent
 * JAMAIS revendiquer la même ligne ; chacun ne reçoit que les
 * évènements réellement disponibles. AUCUN verrou global restaurant/
 * table n'est jamais posé.
 *
 * REPRISE APRÈS CRASH (mission §8) : chaque évènement revendiqué porte
 * un bail temporel (`claimExpiresAt`). Si CE processus disparaît avant
 * d'appeler `updatePaymentProviderEventProcessingStatus`, AUCUNE action
 * manuelle n'est nécessaire -- dès expiration du bail, un futur appel
 * de cette même fonction (par ce processus ou un autre) revendiquera à
 * nouveau l'évènement avec un NOUVEAU `claimToken`. L'ancien jeton
 * devient alors inutilisable (voir
 * `updatePaymentProviderEventProcessingStatus`).
 *
 * Retourne un tableau VIDE (jamais une erreur) lorsqu'aucun évènement
 * n'est actuellement éligible -- c'est l'issue NORMALE d'un worker qui
 * n'a rien à traiter, pas une condition d'échec.
 *
 * AUCUNE charge utile brute, AUCUN secret, AUCUN public_token dans le
 * contrat de retour (mission §6).
 */
export async function claimPaymentProviderEvents(
  input: ClaimPaymentProviderEventsInput = {}
): Promise<ClaimedPaymentProviderEvent[]> {
  const client = getServiceRoleSupabaseClient();

  let data: ClaimedPaymentProviderEventRow[] | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await client.rpc("claim_payment_provider_events", {
      p_batch_size: input.batchSize ?? null,
      p_lease_seconds: input.leaseSeconds ?? null,
    }));
  } catch {
    throw new PaymentServerUnavailableError();
  }

  if (error) {
    logRpcFailure("claim_payment_provider_events", error.code);
    throw new PaymentServerRpcError();
  }

  const rows = Array.isArray(data) ? data : [];
  return rows.map((row) => ({
    id: String(row.id),
    restaurantId: String(row.restaurant_id),
    orderId: String(row.order_id),
    paymentTransactionId: String(row.payment_transaction_id),
    providerCode: String(row.provider_code),
    providerReference: String(row.provider_reference),
    eventFingerprint: String(row.event_fingerprint),
    providerEventType: String(row.provider_event_type),
    providerEventCode: row.provider_event_code === null ? null : String(row.provider_event_code),
    amount: row.amount === null ? null : String(row.amount),
    currency: row.currency === null ? null : String(row.currency),
    authorizationReference:
      row.authorization_reference === null ? null : String(row.authorization_reference),
    processingStatus: String(row.processing_status),
    retryCount: Number(row.retry_count),
    claimToken: String(row.claim_token),
    claimExpiresAt: String(row.claim_expires_at),
  }));
}

// ------------------------------------------------------------------
// Diagnostic interne, jamais renvoyé à l'appelant.
// ------------------------------------------------------------------

/**
 * Consigne UNIQUEMENT le nom de la RPC et son SQLSTATE (ou un
 * marqueur interne fixe comme "EMPTY_ROW"/"EMPTY_RESULT") -- jamais
 * `error.message`, `error.details`, `error.hint`, ni aucune valeur de
 * donnée (y compris `public_token`). Volontairement conservateur :
 * même si aucune des six RPC enveloppées ici n'interpole aujourd'hui
 * de matière sensible dans ses messages d'erreur (vérifié dans leur
 * SQL), ce module ne suppose jamais qu'un futur changement de ces RPC
 * le restera (mission §16).
 */
function logRpcFailure(rpcName: string, sqlstate: string | null | undefined): void {
  console.error(`[payment-service] RPC "${rpcName}" a échoué (SQLSTATE=${sqlstate ?? "?"})`);
}
