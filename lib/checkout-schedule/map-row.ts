import type {
  CheckoutScheduleOffer,
  CheckoutScheduleView,
} from "@/lib/checkout-schedule/model";

/**
 * CSDJ-2 / #158 -- mapping PUR (aucun réseau, aucune dépendance Supabase)
 * d'une ligne de `get_checkout_fulfillment_schedule` vers le modèle du
 * checkout. Un statut absent est traité comme `absent` (aucune
 * planification), jamais comme une disponibilité.
 */
export function mapCheckoutScheduleRow(
  row:
    | {
        schedule_status?: string | null;
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
    | null
    | undefined
): CheckoutScheduleView {
  const offers: Record<string, CheckoutScheduleOffer[]> = {};
  if (row?.offers && typeof row.offers === "object") {
    for (const [date, list] of Object.entries(row.offers)) {
      offers[date] = Array.isArray(list)
        ? list.map((o) => ({
            slotKey: typeof o.slot_key === "string" ? o.slot_key : null,
            startsAt: String(o.starts_at ?? ""),
            endsAt: String(o.ends_at ?? ""),
          }))
        : [];
    }
  }
  const granularity = row?.time_granularity_minutes;
  return {
    // Repli sûr : statut absent => « absent » (aucune planification).
    status: row?.schedule_status ?? "absent",
    unfulfillableReason: row?.unfulfillable_reason ?? null,
    timezone: row?.schedule_timezone ?? null,
    dateSelectionMode: row?.date_selection_mode ?? null,
    slotSelectionMode: row?.slot_selection_mode ?? null,
    timeGranularityMinutes:
      granularity === null || granularity === undefined ? null : Number(granularity),
    firstEligibleDate: row?.first_eligible_date ?? null,
    eligibleDates: Array.isArray(row?.eligible_dates) ? row!.eligible_dates! : [],
    offers,
  };
}
