/**
 * Scanym — CUSTOMER TRACKING EXPERIENCE v1.
 *
 * Logique PURE (aucun accès réseau, aucune dépendance Supabase/React)
 * de mise en forme du cycle `order_status` déjà exposé par
 * `public.get_order_tracking` (CUSTOMER ORDER TRACKING FOUNDATION v3,
 * contrat inchangé, préservé à l'identique par ce lot -- voir
 * TRACKING-V3-NONREGRESSION-REPORT.txt).
 *
 * Ce module ne connaît NI Supabase NI React : il ne fait que
 * transformer les 7 valeurs canoniques déjà publiées
 * (`new`/`accepted`/`preparing`/`ready`/`completed`/`rejected`/
 * `cancelled`, vérifiées par introspection directe dans
 * supabase/DRAFT-lot-customer-order-tracking-foundation.sql) en
 * structures d'affichage : position dans la frise normale, clé de
 * libellé i18n, et adaptation de texte par `service_mode`. Extrait à
 * dessein de app/track/.../page.tsx (Server Component) pour rester
 * testable par `npm test` sans DOM ni réseau -- même discipline que
 * lib/services/order-payload.ts pour create_order.
 *
 * N'INVENTE PAS `delivery_status` (mandat §7 : « Delivery/driver
 * tracking is a separate future capability ») -- `service_mode` sert
 * UNIQUEMENT à adapter le TEXTE d'un statut déjà existant, jamais à
 * ajouter un état.
 */

/** Les 7 valeurs canoniques EXACTES de `orders.status`, dans le MÊME
 *  ordre que le tableau `v_expected_values` du garde de dérive SQL
 *  (supabase/DRAFT-lot-customer-order-tracking-foundation.sql) --
 *  reproduit ici, jamais réinventé, pour un contrôle croisé simple. */
export const CANONICAL_ORDER_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "rejected",
  "cancelled",
] as const;

export type OrderStatus = (typeof CANONICAL_ORDER_STATUSES)[number];

export function isCanonicalOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === "string" &&
    (CANONICAL_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

/** Progression NORMALE (mandat §7). `rejected`/`cancelled` sont des
 *  ISSUES D'EXCEPTION, jamais une étape de cette frise-là. */
export const NORMAL_PROGRESSION = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "completed",
] as const;

export const EXCEPTION_STATUSES = ["rejected", "cancelled"] as const;

export function isExceptionStatus(
  status: OrderStatus
): status is (typeof EXCEPTION_STATUSES)[number] {
  return (EXCEPTION_STATUSES as readonly string[]).includes(status);
}

/** Index (0-based) dans la progression normale, ou -1 pour une issue
 *  d'exception (rejected/cancelled) -- utile pour déterminer quelles
 *  étapes de la frise sont "atteintes" par un statut normal. */
export function normalProgressionIndex(status: OrderStatus): number {
  return (NORMAL_PROGRESSION as readonly string[]).indexOf(status);
}

/** Clé i18n du libellé customer-facing pour un statut (mandat §8).
 *  Le TEXTE lui-même vit dans lib/i18n.ts (fr/en) -- ce module ne
 *  fait que nommer la clé, jamais le texte, pour rester indépendant
 *  de l'architecture i18n concrète. */
export function statusLabelKey(status: OrderStatus): string {
  return `trackingStatus_${status}`;
}

/**
 * Clé i18n ADAPTÉE par `service_mode` pour le statut `ready` (mandat
 * §17 : "pickup/click_collect: ready means ready for customer
 * collection." / "table: ready means prepared / service progression
 * appropriate to table service." / "room_service: ready means
 * prepared for room service / delivery to room." / "delivery: ready
 * must NOT imply driver location or exact ETA").
 *
 * MISE À JOUR CUSTOMER TRACKING EXPERIENCE v2 (ferme CTE-V1-SERVICE-
 * MODE-01, blocage de publication v1) : v1 ne gérait explicitement que
 * pickup/table/delivery et classait `click_collect`/`room_service`
 * dans le repli générique `default`, comme s'il s'agissait de modes
 * futurs inconnus -- alors que les CINQ modes (`table`, `pickup`,
 * `click_collect`, `room_service`, `delivery`) sont RÉELLEMENT publiés
 * et actifs dans le schéma depuis migration-v82-lot2a-sale-modes.sql
 * (contrainte `orders_service_mode_fkey` vers
 * `public.sale_mode_catalog`, vérifiée par introspection directe,
 * jamais supposée). Ce lot ferme cet écart en ajoutant les DEUX
 * branches manquantes -- mandat §16, "Do NOT classify click_collect/
 * room_service as unknown/future."
 *
 * Pour toute AUTRE étape que `ready`, le libellé générique
 * (`statusLabelKey`) suffit -- aucune adaptation supplémentaire n'est
 * inventée ici.
 */
export function statusLabelKeyForServiceMode(
  status: OrderStatus,
  serviceMode: string
): string {
  if (status !== "ready") return statusLabelKey(status);
  switch (serviceMode) {
    case "pickup":
    case "click_collect":
      // Mandat §17 : "pickup / click_collect: ready means ready for
      // customer collection." -- même sémantique de retrait client,
      // donc la MÊME clé i18n (jamais une divergence de texte pour
      // deux modes qui signifient la même chose côté client) ; voir
      // SERVICE-MODE-MATRIX.txt pour la justification complète de ce
      // choix (une clé partagée plutôt que deux clés dupliquées).
      return "trackingStatus_ready_pickup";
    case "delivery":
      // Mandat §17 : "delivery: ready must NOT imply driver location
      // or exact ETA unless actual delivery tracking exists." On
      // adapte uniquement le TEXTE du statut `ready` déjà existant
      // (préparation terminée, prête à partir) -- jamais un statut de
      // livraison/coursier qui n'existe nulle part dans le schéma réel.
      return "trackingStatus_ready_delivery";
    case "table":
      // Mandat §17 : "table: ready means prepared / service
      // progression appropriate to table service."
      return "trackingStatus_ready_table";
    case "room_service":
      // Mandat §17 : "room_service: ready means prepared for room
      // service / delivery to room." Mode réel depuis LOT 2A (colonne
      // dédiée orders.room_number, migration-v82-lot2a-sale-modes.sql)
      // -- jamais classé comme futur/inconnu.
      return "trackingStatus_ready_room_service";
    default:
      // Repli GÉNÉRIQUE réservé aux modes VRAIMENT futurs/inconnus
      // (mandat §17, "Keep generic defensive fallback only for
      // genuinely unknown future modes") -- plus aucun des 5 modes
      // actuellement publiés n'atteint cette branche.
      return statusLabelKey(status);
  }
}

/** Statuts TERMINAUX (mandat §10, "stop/reduce polling in terminal
 *  statuses" ; mandat §26, le lien reste néanmoins lisible -- ce n'est
 *  PAS une révocation de token, seulement l'arrêt du rafraîchissement
 *  automatique côté page). `completed` (fin normale) et les deux
 *  issues d'exception (`rejected`/`cancelled`) : aucun de ces trois
 *  statuts ne peut plus transitionner (vérifié dans la machine à
 *  états de `update_order_status`, migration-v29-merchant-dashboard.sql
 *  -- `completed`/`rejected`/`cancelled` n'apparaissent jamais comme
 *  statut DE DÉPART d'une transition autorisée). */
export function isTerminalStatus(status: OrderStatus): boolean {
  return status === "completed" || isExceptionStatus(status);
}

export interface TimelineStep {
  status: (typeof NORMAL_PROGRESSION)[number];
  /** Horodatage ISO si atteint, sinon null. */
  timestamp: string | null;
  reached: boolean;
  /** L'étape correspond au statut ACTUEL de la commande (mise en
   *  évidence visuelle -- jamais la seule information, mandat §29
   *  "not by color alone"). */
  isCurrent: boolean;
}

export interface TrackingTimestamps {
  created_at: string;
  accepted_at: string | null;
  preparing_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
}

const TIMESTAMP_FIELD_BY_STATUS: Record<
  (typeof NORMAL_PROGRESSION)[number],
  keyof TrackingTimestamps
> = {
  new: "created_at",
  accepted: "accepted_at",
  preparing: "preparing_at",
  ready: "ready_at",
  completed: "completed_at",
};

/**
 * Construit la frise NORMALE (mandat §7/§35). Une commande dont le
 * statut ACTUEL est une issue d'exception (rejected/cancelled) obtient
 * quand même une frise partielle -- les étapes normales réellement
 * atteintes AVANT l'exception restent affichées (ex. new -> accepted
 * -> cancelled : "reçue"/"acceptée" restent cochées, "en
 * préparation"/"prête"/"terminée" restent non atteintes) -- aucune
 * étape normale n'est jamais marquée `isCurrent` dans ce cas
 * (l'exception elle-même est affichée séparément par l'appelant, pas
 * comme une étape de CETTE frise).
 */
export function buildTimeline(
  currentStatus: OrderStatus,
  timestamps: TrackingTimestamps
): TimelineStep[] {
  const currentIsException = isExceptionStatus(currentStatus);
  return NORMAL_PROGRESSION.map((status) => {
    const field = TIMESTAMP_FIELD_BY_STATUS[status];
    const timestamp = timestamps[field];
    return {
      status,
      timestamp,
      reached: timestamp !== null,
      isCurrent: !currentIsException && status === currentStatus,
    };
  });
}
