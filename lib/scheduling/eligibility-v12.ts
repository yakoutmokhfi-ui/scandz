/**
 * Scanym — CHECKOUT SCHEDULING v1.2 (CSDJ v1.2)
 * CALCUL D'ÉLIGIBILITÉ v1.2 — IMPLÉMENTATION DE RÉFÉRENCE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * CSDJ-V12-REFERENCE-NOT-AUTHORITY-01
 *
 * CE MODULE N'EST PAS UNE AUTORITÉ. L'autorité est
 * `public.resolve_fulfillment_schedule_v12(...)` (via le répartiteur
 * `public.resolve_fulfillment_schedule`), en SQL, qui lit l'horloge du
 * SERVEUR. Ce module est la seconde implémentation d'un calcul prouvé
 * par FIXTURE PARTAGÉE : `tests/fixtures/checkout-scheduling-v12-cases.json`
 * est rejouée ici ET dans le harnais PostgreSQL, et ses attendus viennent
 * d'un ORACLE PYTHON indépendant. Même règle que CSDJ-1 : INTERDIT
 * d'importer depuis `app/` ou `components/`.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Règles (décisions du CIO, CSDJ v1.2) :
 *
 *  1. DEUX calendriers indépendants. PRÉPARATION : jours de la semaine +
 *     fermetures exceptionnelles + fériés si la politique est « closed ».
 *     DISPONIBILITÉ client : fenêtres/créneaux + fermetures
 *     exceptionnelles + fériés si la politique est « closed ».
 *  2. ORIGINE : aujourd'hui si c'est un jour de préparation ET que
 *     l'heure limite n'est pas atteinte ; sinon le prochain jour de
 *     préparation STRICTEMENT postérieur. Heure limite atteinte =
 *     `maintenant >= limite` (l'instant exact compte comme atteint). Un
 *     jour SANS préparation ne consulte pas l'heure limite.
 *  3. J+X : cible = origine + X jours CALENDAIRES. Si la cible n'est pas
 *     disponible, on avance jusqu'à la prochaine date éligible.
 *  4. CAPACITÉ (si activée) : une offre pleine est retirée, sans jamais
 *     exposer de compte.
 *
 * AUCUNE DATE INVENTÉE : ni calendrier férié, ni délai par défaut. Les
 * jours fériés viennent EXCLUSIVEMENT de `holidayDays`, c'est-à-dire du
 * calendrier que le commerçant a rattaché à sa planification.
 */

import {
  type CheckoutDateSelectionMode,
  type CheckoutScheduleStatus,
  type CheckoutSlotSelectionMode,
  type CheckoutUnfulfillableReason,
  CHECKOUT_UNFULFILLABLE_REASONS,
  formatScheduleTime,
  parseScheduleTime,
} from "@/lib/scheduling/schedule-model";
import {
  type ScheduleClosureRow,
  type ScheduleDateOffer,
  type ScheduleOffer,
  type ScheduleSlotRow,
  type ScheduleWindowRow,
  resolveWallTime,
} from "@/lib/scheduling/eligibility";

/**
 * Catalogue FERMÉ des motifs v1.2 : les cinq motifs CSDJ-1, DANS LE MÊME
 * ORDRE, puis les quatre nouveaux. Miroir caractère par caractère de
 * `public.checkout_unfulfillable_reasons_v12()`.
 */
export const CHECKOUT_UNFULFILLABLE_REASONS_V12 = [
  ...CHECKOUT_UNFULFILLABLE_REASONS,
  "preparation_calendar_missing",
  "no_preparation_day_in_horizon",
  "cutoff_unresolvable",
  "capacity_exhausted",
] as const;

export type CheckoutUnfulfillableReasonV12 =
  | CheckoutUnfulfillableReason
  | "preparation_calendar_missing"
  | "no_preparation_day_in_horizon"
  | "cutoff_unresolvable"
  | "capacity_exhausted";

export type HolidayPolicy = "open" | "closed";

export interface ScheduleConfigV12 {
  readonly timezone: string;
  readonly enabled: boolean;
  readonly dateSelectionMode: CheckoutDateSelectionMode;
  readonly slotSelectionMode: CheckoutSlotSelectionMode;
  readonly timeGranularityMinutes: number | null;
  readonly leadTimeMinutes: number;
  /** « X » de J+X, en jours CALENDAIRES depuis l'origine. */
  readonly minLeadDays: number;
  /** `HH:MM`, ou `null` = aucune heure limite. */
  readonly cutoffTime: string | null;
  readonly bookingHorizonDays: number;
  readonly preparationOnHolidays: HolidayPolicy;
  readonly availabilityOnHolidays: HolidayPolicy;
  readonly capacityEnabled: boolean;
  /** Strictement positif quand la capacité est activée. */
  readonly capacityMaxOrders: number | null;
}

/** Places TENUES (décompte autoritaire serveur) pour un seau. */
export interface ScheduleOccupancyRow {
  readonly date: string;
  /** `null` = seau de la date entière (pas de créneaux nommés). */
  readonly slotKey: string | null;
  readonly count: number;
}

export interface ScheduleInputV12 {
  readonly config: ScheduleConfigV12 | null;
  /** Calendrier de DISPONIBILITÉ client. */
  readonly windows: readonly ScheduleWindowRow[];
  readonly slots: readonly ScheduleSlotRow[];
  readonly closures: readonly ScheduleClosureRow[];
  /** Calendrier de PRÉPARATION : jours de la semaine (0 = dimanche). */
  readonly prepWeekdays: readonly number[];
  readonly prepClosures: readonly ScheduleClosureRow[];
  /** Fériés du calendrier RATTACHÉ par le commerçant (jamais un jeu livré). */
  readonly holidayDays: readonly string[];
  readonly occupied: readonly ScheduleOccupancyRow[];
  readonly nowIso: string;
  /** Défaut `true` ; `false` = mode interne de la réservation. */
  readonly applyCapacity?: boolean;
}

export interface ScheduleEligibilityV12 {
  readonly status: CheckoutScheduleStatus;
  readonly reason: CheckoutUnfulfillableReasonV12 | null;
  readonly timezone: string | null;
  readonly dateSelectionMode: CheckoutDateSelectionMode | null;
  readonly slotSelectionMode: CheckoutSlotSelectionMode | null;
  readonly timeGranularityMinutes: number | null;
  readonly firstEligibleDate: string | null;
  readonly dates: readonly ScheduleDateOffer[];
}

const ABSENT: ScheduleEligibilityV12 = {
  status: "absent",
  reason: null,
  timezone: null,
  dateSelectionMode: null,
  slotSelectionMode: null,
  timeGranularityMinutes: null,
  firstEligibleDate: null,
  dates: [],
};

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` + n jours, en arithmétique de dates civiles (jamais de fuseau). */
function addDays(date: string, n: number): string {
  const t = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
  return new Date(t + n * MS_PER_DAY).toISOString().slice(0, 10);
}

function weekdayOfDate(date: string): number {
  return new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10))
    )
  ).getUTCDay();
}

function splitDate(date: string): { y: number; m: number; d: number } {
  return {
    y: Number(date.slice(0, 4)),
    m: Number(date.slice(5, 7)),
    d: Number(date.slice(8, 10)),
  };
}

/** Date civile d'un instant LUE DANS `tz`. */
function localDate(epochMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function unfulfillable(
  base: ScheduleEligibilityV12,
  reason: CheckoutUnfulfillableReasonV12
): ScheduleEligibilityV12 {
  return {
    ...base,
    status: "unfulfillable",
    reason,
    firstEligibleDate: null,
    dates: [],
  };
}

export function resolveScheduleEligibilityV12(
  input: ScheduleInputV12
): ScheduleEligibilityV12 {
  const cfg = input.config;
  if (cfg === null || cfg.enabled !== true) return ABSENT;

  const base: ScheduleEligibilityV12 = {
    ...ABSENT,
    timezone: cfg.timezone,
    dateSelectionMode: cfg.dateSelectionMode,
    slotSelectionMode: cfg.slotSelectionMode,
    timeGranularityMinutes:
      cfg.slotSelectionMode === "time_within_window"
        ? cfg.timeGranularityMinutes
        : null,
  };

  if (cfg.dateSelectionMode === "informational_only") {
    return {
      ...base,
      status: "informational_only",
      timeGranularityMinutes: null,
    };
  }

  const granularity = cfg.timeGranularityMinutes;
  if (cfg.slotSelectionMode === "time_within_window" && granularity === null) {
    return unfulfillable({ ...base, timeGranularityMinutes: null }, "granularity_missing");
  }

  const usesSlots = cfg.slotSelectionMode === "fixed_slots";
  const rows: readonly (ScheduleWindowRow | ScheduleSlotRow)[] = usesSlots
    ? input.slots
    : input.windows;
  if (rows.length === 0) return unfulfillable(base, "no_offer_configured");
  if (input.prepWeekdays.length === 0) {
    return unfulfillable(base, "preparation_calendar_missing");
  }

  const offersByWeekday = new Map<
    number,
    { slotKey: string | null; startsAt: string; endsAt: string }[]
  >();
  for (const r of rows) {
    const list = offersByWeekday.get(r.weekday) ?? [];
    list.push({
      slotKey: usesSlots ? (r as ScheduleSlotRow).slotKey : null,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
    });
    offersByWeekday.set(r.weekday, list);
  }
  for (const list of offersByWeekday.values()) {
    list.sort((a, b) =>
      a.startsAt === b.startsAt
        ? (a.slotKey ?? "").localeCompare(b.slotKey ?? "")
        : a.startsAt < b.startsAt
          ? -1
          : 1
    );
  }

  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(nowMs)) {
    // Une horloge illisible n'est pas une date : refus fermé.
    return unfulfillable(base, "horizon_exhausted");
  }

  const holidays = new Set(input.holidayDays);
  const prepClosed = new Set(input.prepClosures.map((c) => c.closedOn));
  const availClosed = new Set(input.closures.map((c) => c.closedOn));
  const prepWeekdays = new Set(input.prepWeekdays);

  const prepOpen = (date: string): boolean =>
    prepWeekdays.has(weekdayOfDate(date)) &&
    !prepClosed.has(date) &&
    !(cfg.preparationOnHolidays === "closed" && holidays.has(date));
  const availabilityClosed = (date: string): boolean =>
    availClosed.has(date) ||
    (cfg.availabilityOnHolidays === "closed" && holidays.has(date));

  const today = localDate(nowMs, cfg.timezone);
  const lastDate = addDays(today, cfg.bookingHorizonDays);

  // ── 1. ORIGINE ──────────────────────────────────────────────────────
  const cutoffMinutes =
    cfg.cutoffTime === null ? null : parseScheduleTime(cfg.cutoffTime);
  let cutoffReached = false;
  const todayOpen = prepOpen(today);
  if (todayOpen && cutoffMinutes !== null) {
    const t = splitDate(today);
    const cutoff = resolveWallTime(t.y, t.m, t.d, cutoffMinutes, cfg.timezone);
    if (cutoff.epochMs === null) {
      // Heure murale inexistante/ambiguë : on ne devine pas sa position.
      return unfulfillable(base, "cutoff_unresolvable");
    }
    cutoffReached = nowMs >= cutoff.epochMs;
  }

  let origin: string | null = null;
  if (todayOpen && !cutoffReached) {
    origin = today;
  } else {
    for (let d = addDays(today, 1); d <= lastDate; d = addDays(d, 1)) {
      if (prepOpen(d)) {
        origin = d;
        break;
      }
    }
    if (origin === null) {
      return unfulfillable(base, "no_preparation_day_in_horizon");
    }
  }

  // ── 2. J+X en jours calendaires ─────────────────────────────────────
  const target = addDays(origin, cfg.minLeadDays);
  if (target > lastDate) return unfulfillable(base, "horizon_exhausted");

  // ── 3. instant minimal ──────────────────────────────────────────────
  const tt = splitDate(target);
  const floor = resolveWallTime(tt.y, tt.m, tt.d, 0, cfg.timezone);
  const fromLead = nowMs + cfg.leadTimeMinutes * 60_000;
  const minInstant =
    floor.epochMs !== null && floor.epochMs > fromLead ? floor.epochMs : fromLead;

  const applyCapacity = input.applyCapacity !== false;
  const occupancy = new Map<string, number>();
  for (const o of input.occupied) {
    occupancy.set(`${o.date}|${o.slotKey ?? ""}`, o.count);
  }
  const used = (date: string, slotKey: string | null): number =>
    occupancy.get(`${date}|${slotKey ?? ""}`) ?? 0;
  const capMax = cfg.capacityMaxOrders ?? 0;

  const eligible: ScheduleDateOffer[] = [];
  let sawClosure = false;
  let sawOpen = false;
  let sawFull = false;

  for (let date = target; date <= lastDate; date = addDays(date, 1)) {
    const offers = offersByWeekday.get(weekdayOfDate(date));
    if (!offers || offers.length === 0) continue;
    if (availabilityClosed(date)) {
      sawClosure = true;
      continue;
    }
    sawOpen = true;

    const { y, m, d } = splitDate(date);
    let usable: ScheduleOffer[] = [];
    for (const offer of offers) {
      const startMin = parseScheduleTime(offer.startsAt);
      const endMin = parseScheduleTime(offer.endsAt);
      if (startMin === null || endMin === null) continue;
      // CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01 (repris).
      if (resolveWallTime(y, m, d, endMin, cfg.timezone).status !== "valid_unique") {
        continue;
      }
      if (cfg.slotSelectionMode === "time_within_window" && granularity) {
        let sound = true;
        let chosen: number | null = null;
        for (let t = startMin; t < endMin; t += granularity) {
          const r = resolveWallTime(y, m, d, t, cfg.timezone);
          if (r.status !== "valid_unique") {
            sound = false;
            break;
          }
          if (chosen === null && r.epochMs !== null && r.epochMs >= minInstant) {
            chosen = t;
          }
        }
        if (!sound || chosen === null) continue;
        usable.push({
          slotKey: null,
          startsAt: formatScheduleTime(chosen),
          endsAt: formatScheduleTime(endMin),
        });
        continue;
      }
      const r = resolveWallTime(y, m, d, startMin, cfg.timezone);
      if (r.status !== "valid_unique" || r.epochMs === null) continue;
      if (r.epochMs < minInstant) continue;
      usable.push({
        slotKey: offer.slotKey,
        startsAt: formatScheduleTime(startMin),
        endsAt: formatScheduleTime(endMin),
      });
    }
    if (usable.length === 0) continue;

    // ── 4. capacité : filtrage, jamais de compte exposé ───────────────
    if (applyCapacity && cfg.capacityEnabled) {
      if (usesSlots) {
        usable = usable.filter((u) => used(date, u.slotKey) < capMax);
      } else if (used(date, null) >= capMax) {
        usable = [];
      }
      if (usable.length === 0) {
        sawFull = true;
        continue;
      }
    }

    eligible.push({ date, offers: usable });
    // Mode interne (sans capacité) : toutes les dates sont conservées pour
    // que la réservation puisse juger une date antérieure.
    if (cfg.dateSelectionMode === "derived_earliest" && applyCapacity) break;
  }

  if (eligible.length === 0) {
    return unfulfillable(
      base,
      sawFull
        ? "capacity_exhausted"
        : sawOpen
          ? "no_offer_in_horizon"
          : sawClosure
            ? "all_dates_closed"
            : "horizon_exhausted"
    );
  }

  return {
    ...base,
    status: "dates_available",
    reason: null,
    firstEligibleDate: eligible[0]!.date,
    dates: eligible,
  };
}
