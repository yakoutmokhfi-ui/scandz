import type {
  CheckoutScheduleOffer,
  CheckoutScheduleView,
} from "@/lib/checkout-schedule/model";
import { isCheckoutScheduleStatus } from "@/lib/scheduling/schedule-model";

/**
 * CSDJ-2 / #158 -- mapping PUR (aucun réseau, aucune dépendance Supabase)
 * de la réponse de `get_checkout_fulfillment_schedule` vers le modèle du
 * checkout.
 *
 * FAIL-CLOSED (remédiation de l'audit de la PR #160). Le lecteur public
 * rend TOUJOURS exactement UNE ligne dont `schedule_status` appartient au
 * catalogue fermé `CHECKOUT_SCHEDULE_STATUSES` ; `absent` y est un statut
 * EXPLICITE (« pas de calendrier, ou calendrier désactivé »), jamais une
 * absence de réponse. Par conséquent :
 *
 *   - réponse vide, nulle, non conforme, à plusieurs lignes ;
 *   - ligne sans `schedule_status`, ou au statut hors catalogue
 *
 * ne signifient PAS « aucun calendrier » : c'est un état INCONNU. Il est
 * rendu avec le statut `INVALID_SCHEDULE_STATUS`, que le modèle classe
 * `unreadable` -> envoi fermé, message, « Réessayer ». Un état inconnu ne
 * doit jamais devenir `absent`, donc jamais une commande sans `schedule`.
 */
export const INVALID_SCHEDULE_STATUS = "invalid";

export interface CheckoutScheduleRow {
  schedule_status?: unknown;
  unfulfillable_reason?: string | null;
  schedule_timezone?: string | null;
  date_selection_mode?: string | null;
  slot_selection_mode?: string | null;
  time_granularity_minutes?: number | null;
  first_eligible_date?: string | null;
  eligible_dates?: string[] | null;
  offers?: Record<
    string,
    { slot_key?: string | null; starts_at?: string; ends_at?: string }[]
  > | null;
}

const INVALID_VIEW: CheckoutScheduleView = {
  status: INVALID_SCHEDULE_STATUS,
  unfulfillableReason: null,
  timezone: null,
  dateSelectionMode: null,
  slotSelectionMode: null,
  timeGranularityMinutes: null,
  firstEligibleDate: null,
  eligibleDates: [],
  offers: {},
};

/** La réponse BRUTE du RPC (`data`) : exactement une ligne, sinon invalide. */
export function mapCheckoutScheduleResponse(data: unknown): CheckoutScheduleView {
  if (Array.isArray(data)) {
    if (data.length !== 1) return INVALID_VIEW;
    return mapCheckoutScheduleRow(data[0]);
  }
  return mapCheckoutScheduleRow(data);
}

export function mapCheckoutScheduleRow(row: unknown): CheckoutScheduleView {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return INVALID_VIEW;
  }
  const r = row as CheckoutScheduleRow;
  if (!isCheckoutScheduleStatus(r.schedule_status)) return INVALID_VIEW;

  const offers: Record<string, CheckoutScheduleOffer[]> = {};
  if (r.offers && typeof r.offers === "object" && !Array.isArray(r.offers)) {
    for (const [date, list] of Object.entries(r.offers)) {
      offers[date] = Array.isArray(list)
        ? list.map((o) => ({
            slotKey: typeof o?.slot_key === "string" ? o.slot_key : null,
            startsAt: String(o?.starts_at ?? ""),
            endsAt: String(o?.ends_at ?? ""),
          }))
        : [];
    }
  }
  const granularity = r.time_granularity_minutes;
  return {
    status: r.schedule_status,
    unfulfillableReason: r.unfulfillable_reason ?? null,
    timezone: r.schedule_timezone ?? null,
    dateSelectionMode: r.date_selection_mode ?? null,
    slotSelectionMode: r.slot_selection_mode ?? null,
    timeGranularityMinutes:
      granularity === null || granularity === undefined ? null : Number(granularity),
    firstEligibleDate: r.first_eligible_date ?? null,
    eligibleDates: Array.isArray(r.eligible_dates) ? r.eligible_dates : [],
    offers,
  };
}
