import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  PaymentServerRpcError,
  PaymentServerUnavailableError,
} from "@/lib/server/payment-errors";

/**
 * PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
 * MISE À JOUR PAYMENT P3-B0 : ajoute `getPaymentTransactionCorrelation`
 * (voir sa propre section plus bas pour le détail et pour l'explication
 * de pourquoi elle est la SEULE addition de ce lot).
 * MISE À JOUR PAYMENT P3-B0 v2 (corrige PAY-P3-B0-01) : son contrat de
 * retour passe de 4 à 6 champs (`amount`/`currency` autoritatifs
 * ajoutés) -- v1 n'a jamais été publié, il n'existe donc aucune version
 * intermédiaire à préserver.
 *
 * Enveloppe TYPÉE et GÉNÉRIQUE autour des RPC `service_role` déjà
 * publiées (P1, P3-A0, P3-B0) : `initiate_payment_attempt`,
 * `confirm_payment_attempt`, `get_payment_provider_credential`,
 * `get_payment_transaction_correlation`. Ce fichier ne connaît AUCUN
 * prestataire (mission §2/§33/§34 de P3-A1) : aucune mention de MAC/
 * HMAC/TPE/société/Mercanet/point de terminaison spécifique --
 * uniquement les contrats déjà publiés et audités.
 *
 * Chaque wrapper appelle la RPC avec EXACTEMENT les arguments de sa
 * signature SQL (inspectée directement dans
 * supabase/DRAFT-lot-payment-p1-foundation.sql,
 * supabase/DRAFT-lot-payment-p3a0-secure-credential-read.sql et
 * supabase/DRAFT-lot-payment-p3b0-correlation-status-read.sql avant
 * d'écrire ce fichier -- jamais devinée, mission §12) : aucun montant,
 * aucune devise, aucun identifiant de restaurant n'est fourni de façon
 * indépendante là où la RPC ne les accepte pas (mission §11/§25) ;
 * aucune charge brute spécifique à un prestataire n'est transmise
 * (mission §26).
 *
 * Aucune erreur Postgrest/Supabase brute ne traverse jamais la
 * frontière de ce module (mission §14/§16/§28) : `error.message`,
 * `error.details`, `error.hint` ne sont JAMAIS lus ni inclus dans le
 * message levé -- seul `error.code` (SQLSTATE) est éventuellement
 * consigné côté serveur (jamais renvoyé à l'appelant) à des fins de
 * diagnostic. Le secret renvoyé par `getPaymentProviderCredential` (la
 * seule des quatre RPC dont le résultat est sensible) n'est JAMAIS
 * journalisé, sous aucune forme -- pas même sa longueur.
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
// Diagnostic interne, jamais renvoyé à l'appelant.
// ------------------------------------------------------------------

/**
 * Consigne UNIQUEMENT le nom de la RPC et son SQLSTATE (ou un
 * marqueur interne fixe comme "EMPTY_ROW"/"EMPTY_RESULT") -- jamais
 * `error.message`, `error.details`, `error.hint`, ni aucune valeur de
 * donnée. Volontairement conservateur : même si aucune des trois RPC
 * enveloppées ici n'interpole aujourd'hui de matière sensible dans ses
 * messages d'erreur (vérifié dans leur SQL), ce module ne suppose
 * jamais qu'un futur changement de ces RPC le restera (mission §16).
 */
function logRpcFailure(rpcName: string, sqlstate: string | null | undefined): void {
  console.error(`[payment-service] RPC "${rpcName}" a échoué (SQLSTATE=${sqlstate ?? "?"})`);
}
