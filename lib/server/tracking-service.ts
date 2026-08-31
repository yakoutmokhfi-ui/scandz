import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  TrackingLinkInvalidError,
  TrackingServerUnavailableError,
} from "@/lib/server/tracking-errors";
import { isCanonicalOrderStatus, type OrderStatus } from "@/lib/tracking/status";
import { isPlausibleUuid } from "@/lib/tracking/uuid";

/**
 * CUSTOMER TRACKING EXPERIENCE v1 — enveloppe TYPÉE et SERVEUR autour
 * de la RPC `public.get_order_tracking(p_order_id uuid, p_public_token
 * uuid)`, déjà publiée et AUDITÉE par CUSTOMER ORDER TRACKING
 * FOUNDATION v3 (contrat PRÉSERVÉ à l'identique -- voir
 * TRACKING-V3-NONREGRESSION-REPORT.txt, aucune colonne ajoutée/
 * retirée/renommée ici).
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
 */

export interface OrderTrackingInput {
  orderId: string;
  publicToken: string;
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
}

interface OrderTrackingRow {
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
}

/**
 * Lit le suivi d'une commande par sa preuve de possession.
 *
 * Rejette IMMÉDIATEMENT, SANS appel réseau, une entrée dont la FORME
 * n'est même pas un UUID plausible (mandat §25/§34, "NULL/malformed
 * route input -> safe failure") -- avec EXACTEMENT la même erreur
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
  if (!isPlausibleUuid(input.orderId) || !isPlausibleUuid(input.publicToken)) {
    throw new TrackingLinkInvalidError();
  }

  let data: OrderTrackingRow[] | OrderTrackingRow | null;
  let error: PostgrestError | null;
  try {
    ({ data, error } = await supabase.rpc("get_order_tracking", {
      p_order_id: input.orderId,
      p_public_token: input.publicToken,
    }));
  } catch {
    throw new TrackingServerUnavailableError();
  }

  if (error) {
    logRpcFailure(error.code);
    throw new TrackingServerUnavailableError();
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // Résultat vide SANS erreur : couple possession incorrect --
    // jamais une panne serveur (mandat §25, catégorie séparée).
    throw new TrackingLinkInvalidError();
  }

  if (!isCanonicalOrderStatus(row.order_status)) {
    // Échec fermé : un statut hors de l'ensemble canonique connu ne
    // doit jamais atteindre la logique d'affichage (même posture que
    // getPaymentRuntimeProviderEnvironment pour `mode` -- voir
    // lib/server/payment-service.ts). Ne devrait jamais se produire
    // tant que le garde de dérive SQL du lot FOUNDATION reste en
    // place ; défensif, pas une hypothèse de schéma non vérifiée.
    logRpcFailure("UNEXPECTED_ORDER_STATUS");
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
  };
}

/** Jamais order_id/public_token -- uniquement un SQLSTATE ou un
 *  marqueur interne fixe, même discipline que
 *  lib/server/payment-service.ts::logRpcFailure. */
function logRpcFailure(sqlstate: string | null | undefined): void {
  console.error(`[tracking-service] get_order_tracking a échoué (SQLSTATE=${sqlstate ?? "?"})`);
}
