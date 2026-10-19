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

/**
 * Ligne BRUTE telle que le lecteur la rend. Tous les champs sont `unknown` :
 * le mapper ne FAIT CONFIANCE à aucun type (remédiation CSDJ2-R4-01).
 */
export interface CheckoutScheduleRow {
  schedule_status?: unknown;
  unfulfillable_reason?: unknown;
  schedule_timezone?: unknown;
  date_selection_mode?: unknown;
  slot_selection_mode?: unknown;
  time_granularity_minutes?: unknown;
  first_eligible_date?: unknown;
  eligible_dates?: unknown;
  offers?: unknown;
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

/**
 * La réponse BRUTE du RPC (`data`) : exactement UNE ligne (tableau d'un seul
 * objet), sinon invalide. Un objet nu, `null`, un tableau vide, plusieurs lignes,
 * une ligne imbriquée ou un scalaire ne sont PAS « une ligne ».
 */
export function mapCheckoutScheduleResponse(data: unknown): CheckoutScheduleView {
  if (!Array.isArray(data) || data.length !== 1) return INVALID_VIEW;
  return mapCheckoutScheduleRow(data[0]);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isNullish = (v: unknown): v is null | undefined => v === null || v === undefined;

/**
 * REMÉDIATION CSDJ2-R4-01 -- AUCUNE COERCITION. Le mapper ne transforme JAMAIS
 * une valeur de mauvais type en valeur valide (clé de créneau non textuelle ->
 * null, heure -> `String(...)`, liste non tableau -> `[]`, granularité ->
 * `Number(...)`) : ces coercitions effaçaient l'invalidité avant que le modèle
 * ne puisse la voir. Une valeur d'un type inattendu rend la réponse INVALIDE
 * (statut `invalid`), que le modèle classe `unreadable` -> envoi fermé.
 *
 * Types acceptés (`null`/absent = « pas de valeur », que le modèle refuse là où
 * la valeur est nécessaire) :
 *  - chaînes : fuseau (non vide), motif, modes de date et de créneau, première date ;
 *  - nombre fini : granularité ;
 *  - `eligible_dates` : tableau de chaînes ;
 *  - `offers` : objet simple dont CHAQUE valeur est un tableau (pour toutes les
 *    dates, pas seulement la date retenue) d'objets simples portant `slot_key`
 *    (présent : `null` ou chaîne), `starts_at` et `ends_at` (chaînes).
 * Les champs inconnus sont ignorés (compatibilité ascendante).
 */
function rawAvailableTypesValid(r: CheckoutScheduleRow): boolean {
  const strOrNullish = (v: unknown) => isNullish(v) || typeof v === "string";
  if (!(isNullish(r.schedule_timezone) || (typeof r.schedule_timezone === "string" && r.schedule_timezone.length > 0))) return false;
  if (!strOrNullish(r.unfulfillable_reason)) return false;
  if (!strOrNullish(r.date_selection_mode) || !strOrNullish(r.slot_selection_mode) || !strOrNullish(r.first_eligible_date)) return false;
  const g = r.time_granularity_minutes;
  if (!(isNullish(g) || (typeof g === "number" && Number.isFinite(g)))) return false;
  const dates = r.eligible_dates;
  if (!(isNullish(dates) || (Array.isArray(dates) && dates.every((d) => typeof d === "string")))) return false;
  const offers = r.offers;
  if (isNullish(offers)) return true;
  if (!isPlainObject(offers)) return false;
  for (const list of Object.values(offers)) {
    if (!Array.isArray(list)) return false;
    for (const o of list) {
      if (!isPlainObject(o)) return false;
      if (!Object.prototype.hasOwnProperty.call(o, "slot_key")) return false;
      if (!(o.slot_key === null || typeof o.slot_key === "string")) return false;
      if (typeof o.starts_at !== "string" || typeof o.ends_at !== "string") return false;
    }
  }
  return true;
}

export function mapCheckoutScheduleRow(row: unknown): CheckoutScheduleView {
  if (!isPlainObject(row)) return INVALID_VIEW;
  const r = row as CheckoutScheduleRow;
  if (!isCheckoutScheduleStatus(r.schedule_status)) return INVALID_VIEW;

  // Statuts SANS dates (absent, blocked_upstream, informational_only,
  // unfulfillable) : le lecteur rend alors NULL pour les dates et les offres.
  // Toute date ou offre qui les accompagne est une contradiction -> invalide.
  if (r.schedule_status !== "dates_available") {
    const noList = isNullish(r.eligible_dates) || (Array.isArray(r.eligible_dates) && r.eligible_dates.length === 0);
    const noOffers = isNullish(r.offers) || (isPlainObject(r.offers) && Object.keys(r.offers).length === 0);
    if (!isNullish(r.first_eligible_date) || !noList || !noOffers) return INVALID_VIEW;
    return {
      ...INVALID_VIEW,
      eligibleDates: [],
      offers: {},
      status: r.schedule_status,
      unfulfillableReason: typeof r.unfulfillable_reason === "string" ? r.unfulfillable_reason : null,
      timezone: typeof r.schedule_timezone === "string" ? r.schedule_timezone : null,
      dateSelectionMode: typeof r.date_selection_mode === "string" ? r.date_selection_mode : null,
      slotSelectionMode: typeof r.slot_selection_mode === "string" ? r.slot_selection_mode : null,
    };
  }

  if (!rawAvailableTypesValid(r)) return INVALID_VIEW;

  // `defineProperty` : une clé « __proto__ » reste une clé de données visible
  // du modèle (qui la refuse comme date), elle ne modifie jamais le prototype.
  const offers: Record<string, CheckoutScheduleOffer[]> = {};
  if (isPlainObject(r.offers)) {
    for (const [date, list] of Object.entries(r.offers)) {
      const mapped = (list as Array<Record<string, unknown>>).map((o) => ({
        slotKey: o.slot_key as string | null,
        startsAt: o.starts_at as string,
        endsAt: o.ends_at as string,
      }));
      Object.defineProperty(offers, date, { value: mapped, enumerable: true, writable: true, configurable: true });
    }
  }
  return {
    status: r.schedule_status,
    unfulfillableReason: typeof r.unfulfillable_reason === "string" ? r.unfulfillable_reason : null,
    timezone: typeof r.schedule_timezone === "string" ? r.schedule_timezone : null,
    dateSelectionMode: typeof r.date_selection_mode === "string" ? r.date_selection_mode : null,
    slotSelectionMode: typeof r.slot_selection_mode === "string" ? r.slot_selection_mode : null,
    timeGranularityMinutes: typeof r.time_granularity_minutes === "number" ? r.time_granularity_minutes : null,
    firstEligibleDate: typeof r.first_eligible_date === "string" ? r.first_eligible_date : null,
    eligibleDates: Array.isArray(r.eligible_dates) ? (r.eligible_dates as string[]) : [],
    offers,
  };
}
