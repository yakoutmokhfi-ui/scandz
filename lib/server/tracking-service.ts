import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  TrackingLinkInvalidError,
  TrackingServerUnavailableError,
} from "@/lib/server/tracking-errors";
import { isCanonicalOrderStatus, type OrderStatus } from "@/lib/tracking/status";
import { isPlausibleUuid } from "@/lib/tracking/uuid";
import { isPlausibleCapabilitySecret } from "@/lib/tracking/capability";

/**
 * CUSTOMER TRACKING EXPERIENCE v1 — enveloppe TYPÉE et SERVEUR autour
 * de la RPC `public.get_order_tracking(p_order_id uuid, p_public_token
 * uuid)`, déjà publiée et AUDITÉE par CUSTOMER ORDER TRACKING
 * FOUNDATION v3 (contrat alors PRÉSERVÉ à l'identique -- voir
 * TRACKING-V3-NONREGRESSION-REPORT.txt).
 *
 * ÉTENDU par CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 (remédiation
 * CCTF-V1-TRACKING-FISCAL-SUMMARY-01, audit Cat Woman) : la RPC passe
 * de 10 à 13 colonnes de sortie (voir supabase/DRAFT-lot-tracking-
 * final-fiscal-summary-v1-1.sql pour la migration SQL réelle et son
 * garde-fou anti-double-application) -- `orderTotal`/`orderCurrency`
 * (`orders.total`/`orders.currency`, valeurs PERSISTÉES HISTORIQUES,
 * jamais recalculées) et `invoiceRequested` (existence, et existence
 * SEULE, d'une ligne `order_invoice_request` persistée -- jamais son
 * contenu). Les 10 colonnes v1 restent inchangées, à la même position
 * logique.
 *
 * DÉLIBÉRÉMENT appelée avec le client `anon` PARTAGÉ (lib/supabase.ts,
 * le même que le reste du code navigateur/serveur) et NON le client
 * `service_role` (lib/server/supabase-admin.ts) : la RPC est déjà
 * GRANT à `anon`/`authenticated`, exactement pour ce cas d'usage (un
 * client SANS compte lisant sa propre commande par preuve de
 * possession) -- utiliser service_role ici serait une élévation de
 * privilège inutile et incohérente avec le modèle de sécurité déjà
 * publié et audité de cette RPC.
 *
 * CE MODULE RESTE `server-only` MALGRÉ CELA (mandat §5/§19/§23/§40,
 * "no public_token in client logs/analytics/... no token logging") :
 * cet appel est fait depuis un Server Component (app/track/.../
 * page.tsx), JAMAIS depuis un composant "use client" -- ainsi
 * `public_token` ne traverse jamais le réseau du navigateur vers
 * Supabase directement (aucun appel `fetch`/XHR visible dans l'onglet
 * réseau du navigateur, aucun risque qu'un script d'analytics tiers
 * l'intercepte), et ne transite que dans l'URL elle-même (le mécanisme
 * de possession voulu par construction, mandat §4/§5) -- voir
 * TRACKING-LINK-SECURITY-REPORT.txt.
 *
 * `public_token`/`order_id` ne sont JAMAIS journalisés par ce module,
 * y compris en cas d'échec (même discipline que
 * lib/server/payment-service.ts::getOrderPaymentContext) : seul un
 * indicateur de succès/échec GÉNÉRIQUE (booléen "empty result" ou
 * SQLSTATE) est éventuellement consigné.
 *
 * CUSTOMER TRACKING v3.1 (supabase/DRAFT-lot-customer-tracking-
 * capability-v3-1.sql) : la LECTURE passe désormais EXCLUSIVEMENT par
 * `get_order_tracking_by_capability(p_order_id, p_capability_id,
 * p_secret)` -- capacité liée à la commande côté SQL, ET re-vérifiée
 * ici (`bound_order_id` doit être la commande demandée). Le
 * `public_token` legacy n'est plus utilisé qu'une fois, par
 * `upgradeLegacyTrackingCapability` (échange one-shot appelé depuis le
 * corps POST de app/api/track/exchange/route.ts). Le secret de
 * capacité n'est jamais journalisé non plus.
 */

export interface OrderTrackingInput {
  orderId: string;
  capabilityId: string;
  secret: string;
}

export interface LegacyUpgradeInput {
  orderId: string;
  publicToken: string;
}

export interface TrackingCapability {
  capabilityId: string;
  secret: string;
}

export interface OrderTracking {
  orderStatus: OrderStatus;
  serviceMode: string;
  orderNumber: number;
  createdAt: string;
  acceptedAt: string | null;
  preparingAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  /**
   * CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 (remédiation
   * CCTF-V1-TRACKING-FISCAL-SUMMARY-01) — montant total AUTORITAIRE
   * ET HISTORIQUE de la commande (`orders.total`, jamais recalculé
   * ici ni côté serveur RPC -- voir le commentaire de la migration
   * SQL, supabase/DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql,
   * pour la garantie complète). `null`/`undefined` ne devrait
   * structurellement jamais se produire (colonne `not null` sur
   * `orders`), mais le type reste défensif plutôt que de supposer.
   */
  orderTotal: number | null;
  /** Voir `orderTotal` -- devise associée (`orders.currency`), même
   *  paire immuable que celle utilisée à la création de la commande. */
  orderCurrency: string | null;
  /**
   * CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 (remédiation
   * CCTF-V1-TRACKING-FISCAL-SUMMARY-01) — `true` UNIQUEMENT si une
   * demande de facture a été EFFECTIVEMENT PERSISTÉE
   * (`set_order_invoice_request`, upsert déterministe) -- jamais un
   * état déduit d'une simple intention client non confirmée. Absence
   * de ligne (RPC : `exists(...)` = false) -- jamais une erreur.
   */
  invoiceRequested: boolean;
}

interface OrderTrackingRow {
  bound_order_id: string | null;
  order_status: string;
  service_mode: string;
  order_number: number | string;
  created_at: string;
  accepted_at: string | null;
  preparing_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  order_total: number | string | null;
  order_currency: string | null;
  invoice_requested: boolean | null;
}

interface TrackingCapabilityRow {
  capability_id: string | null;
  capability_secret: string | null;
}

/**
 * Lit le suivi d'une commande par sa capacité de suivi v3.1.
 *
 * Rejette IMMÉDIATEMENT, SANS appel réseau, une entrée dont la FORME
 * n'est même pas plausible (UUID pour order_id/capability_id, 64 hex
 * pour le secret -- mandat §25/§34, "NULL/malformed route input -> safe
 * failure") -- avec EXACTEMENT la même erreur
 * (`TrackingLinkInvalidError`, message générique) qu'un couple bien
 * formé mais incorrect, pour ne jamais introduire de distinction
 * observable entre "malformé" et "bien formé mais faux" (mandat §25,
 * "no enumeration-friendly distinction").
 *
 * Toute autre issue (aucune ligne renvoyée -- mauvais jeton, mauvaise
 * commande, ou les deux) produit la MÊME `TrackingLinkInvalidError` --
 * la RPC elle-même garantit déjà cette indistinguabilité côté SQL
 * (ensemble vide dans tous les cas, jamais de branche), ce wrapper ne
 * fait qu'y ajouter la validation de forme en amont, avec la même
 * issue.
 *
 * Une panne D'INFRASTRUCTURE (réseau, erreur Postgrest inattendue)
 * produit `TrackingServerUnavailableError` -- catégorie séparée et
 * volontairement DIFFÉRENTE (voir lib/server/tracking-errors.ts).
 */
export async function getOrderTracking(
  input: OrderTrackingInput
): Promise<OrderTracking> {
  if (
    !isPlausibleUuid(input.orderId) ||
    !isPlausibleUuid(input.capabilityId) ||
    !isPlausibleCapabilitySecret(input.secret)
  ) {
    throw new TrackingLinkInvalidError();
  }

  let data: OrderTrackingRow[] | OrderTrackingRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await supabase.rpc("get_order_tracking_by_capability", {
      p_order_id: input.orderId,
      p_capability_id: input.capabilityId,
      p_secret: input.secret,
    }));
  } catch {
    throw new TrackingServerUnavailableError();
  }

  if (error) {
    logRpcFailure("get_order_tracking_by_capability", error.code);
    throw new TrackingServerUnavailableError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // Résultat vide SANS erreur : capacité incorrecte --
    // jamais une panne serveur (mandat §25, catégorie séparée).
    throw new TrackingLinkInvalidError();
  }

  // v3.1 : vérification INDÉPENDANTE de la liaison capacité/commande,
  // en plus du prédicat SQL -- une ligne liée à une autre commande
  // n'est jamais rendue.
  if (
    typeof row.bound_order_id !== "string" ||
    row.bound_order_id.toLowerCase() !== input.orderId.toLowerCase()
  ) {
    throw new TrackingLinkInvalidError();
  }

  if (!isCanonicalOrderStatus(row.order_status)) {
    // Échec fermé : un statut hors de l'ensemble canonique connu ne
    // doit jamais atteindre la logique d'affichage (même posture que
    // getPaymentRuntimeProviderEnvironment pour `mode` -- voir
    // lib/server/payment-service.ts). Ne devrait jamais se produire
    // tant que le garde de dérive SQL du lot FOUNDATION reste en
    // place ; défensif, pas une hypothèse de schéma non vérifiée.
    logRpcFailure("get_order_tracking_by_capability", "UNEXPECTED_ORDER_STATUS");
    throw new TrackingServerUnavailableError();
  }

  return {
    orderStatus: row.order_status,
    serviceMode: row.service_mode,
    orderNumber: Number(row.order_number),
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    preparingAt: row.preparing_at,
    readyAt: row.ready_at,
    completedAt: row.completed_at,
    rejectedAt: row.rejected_at,
    cancelledAt: row.cancelled_at,
    // CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 -- `row.order_total`
    // peut revenir en `string` depuis postgrest pour un `numeric`
    // Postgres ; converti explicitement, jamais laissé tel quel
    // (même discipline que `orderNumber` ci-dessus). `null`/`undefined`
    // préservés tels quels plutôt que coercés en `0` (jamais un
    // montant inventé -- voir OrderConfirmation.tsx, même convention).
    orderTotal:
      row.order_total === null || row.order_total === undefined
        ? null
        : Number(row.order_total),
    orderCurrency: row.order_currency ?? null,
    invoiceRequested: row.invoice_requested === true,
  };
}

/**
 * CUSTOMER TRACKING v3.1 — échange ONE-SHOT de la preuve legacy
 * (`order_id` + `public_token`) contre une capacité de suivi liée à la
 * commande (`upgrade_legacy_tracking_capability`).
 *
 * Le secret n'est renvoyé par la RPC qu'au PREMIER appel réussi ; tout
 * rejeu (capacité déjà réclamée), toute paire incorrecte et toute
 * entrée malformée produisent la MÊME `TrackingLinkInvalidError` --
 * jamais de distinction observable, jamais de réémission.
 */
export async function upgradeLegacyTrackingCapability(
  input: LegacyUpgradeInput
): Promise<TrackingCapability> {
  if (!isPlausibleUuid(input.orderId) || !isPlausibleUuid(input.publicToken)) {
    throw new TrackingLinkInvalidError();
  }

  let data: TrackingCapabilityRow[] | TrackingCapabilityRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await supabase.rpc("upgrade_legacy_tracking_capability", {
      p_order_id: input.orderId,
      p_public_token: input.publicToken,
    }));
  } catch {
    throw new TrackingServerUnavailableError();
  }

  if (error) {
    logRpcFailure("upgrade_legacy_tracking_capability", error.code);
    throw new TrackingServerUnavailableError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new TrackingLinkInvalidError();
  }

  if (!isPlausibleUuid(row.capability_id) || !isPlausibleCapabilitySecret(row.capability_secret)) {
    logRpcFailure("upgrade_legacy_tracking_capability", "UNEXPECTED_CAPABILITY_SHAPE");
    throw new TrackingServerUnavailableError();
  }

  return { capabilityId: row.capability_id, secret: row.capability_secret };
}

/** Jamais order_id/public_token/secret -- uniquement le nom fixe de la
 *  RPC et un SQLSTATE ou un marqueur interne fixe, même discipline que
 *  lib/server/payment-service.ts::logRpcFailure. */
function logRpcFailure(rpcName: string, sqlstate: string | null | undefined): void {
  console.error(`[tracking-service] ${rpcName} a échoué (SQLSTATE=${sqlstate ?? "?"})`);
}
