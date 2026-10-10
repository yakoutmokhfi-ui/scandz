/**
 * Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)
 * CALCUL D'ÉLIGIBILITÉ — IMPLÉMENTATION DE RÉFÉRENCE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * CSDJ-V1-REFERENCE-NOT-AUTHORITY-01
 *
 * CE MODULE N'EST PAS UNE AUTORITÉ. L'autorité est
 * `public.resolve_fulfillment_schedule(...)`, en SQL, qui lit l'horloge
 * du SERVEUR. Ce module existe pour UNE raison : être la seconde
 * implémentation d'un calcul que le dépôt prouve par FIXTURE PARTAGÉE --
 * `tests/fixtures/checkout-scheduling-cases.json` est compilée en
 * assertions TypeScript ici ET en assertions SQL dans le harnais, donc
 * les mêmes cas donnent les mêmes résultats des deux côtés. C'est le
 * mécanisme déjà employé par `fixtures/delivery-pricing-cases.json` et
 * `fixtures/fulfillment-routing-cases.json`.
 *
 * Il est donc INTERDIT de l'importer depuis `app/` ou `components/` : le
 * navigateur ne doit jamais décider d'une éligibilité, ni avec son
 * horloge, ni avec une copie de la configuration. Cette interdiction
 * n'est pas une consigne, c'est un test :
 * tests/csdj1-sql-structural.test.ts, garde [NO-CLIENT-AUTHORITY-1].
 * ══════════════════════════════════════════════════════════════════════
 *
 * AUCUNE DATE INVENTÉE. Aucun calendrier de jours fériés, aucun délai
 * par défaut, aucun « J+2 ». Toute valeur vient de la configuration.
 * Quand une politique exige une date et qu'aucune n'est éligible, ce
 * module renvoie `unfulfillable` AVEC son motif -- jamais une date de
 * repli (CSDJ-V1-UNFULFILLABLE-EXPLICIT-01).
 */

import {
  type CheckoutDateSelectionMode,
  type CheckoutScheduleStatus,
  type CheckoutSlotSelectionMode,
  type CheckoutUnfulfillableReason,
  isSchedulePolicyCoherent,
  parseScheduleTime,
} from "@/lib/scheduling/schedule-model";

/** Une ligne de la table des fenêtres hebdomadaires. */
export interface ScheduleWindowRow {
  readonly weekday: number;
  /** `HH:MM` ou `HH:MM:SS`. */
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Une ligne de la table des créneaux nommés. */
export interface ScheduleSlotRow {
  readonly weekday: number;
  readonly slotKey: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Une fermeture exceptionnelle : journée entière, `YYYY-MM-DD`. */
export interface ScheduleClosureRow {
  readonly closedOn: string;
}

export interface ScheduleConfig {
  readonly timezone: string;
  readonly enabled: boolean;
  readonly dateSelectionMode: CheckoutDateSelectionMode;
  readonly slotSelectionMode: CheckoutSlotSelectionMode;
  readonly timeGranularityMinutes: number | null;
  readonly leadTimeMinutes: number;
  readonly minLeadDays: number;
  /** `HH:MM`/`HH:MM:SS`, ou `null` = aucune heure limite. */
  readonly cutoffTime: string | null;
  readonly cutoffOffsetDays: number;
  readonly bookingHorizonDays: number;
}

export interface ScheduleInput {
  /** `null` = aucune ligne de planification pour cette portée. */
  readonly config: ScheduleConfig | null;
  readonly windows: readonly ScheduleWindowRow[];
  readonly slots: readonly ScheduleSlotRow[];
  readonly closures: readonly ScheduleClosureRow[];
  /** Instant de référence, ISO 8601 avec décalage. L'horloge du SERVEUR. */
  readonly nowIso: string;
}

/** Offre d'une date : un créneau nommé, ou une fenêtre horaire. */
export interface ScheduleOffer {
  /** Clé stable du créneau, ou `null` pour une fenêtre. */
  readonly slotKey: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface ScheduleDateOffer {
  readonly date: string;
  readonly offers: readonly ScheduleOffer[];
}

export interface ScheduleEligibility {
  readonly status: CheckoutScheduleStatus;
  readonly reason: CheckoutUnfulfillableReason | null;
  readonly timezone: string | null;
  readonly dateSelectionMode: CheckoutDateSelectionMode | null;
  readonly slotSelectionMode: CheckoutSlotSelectionMode | null;
  readonly timeGranularityMinutes: number | null;
  readonly firstEligibleDate: string | null;
  readonly dates: readonly ScheduleDateOffer[];
}

const ABSENT: ScheduleEligibility = {
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

/**
 * Décalage du fuseau `tz` à l'instant `epochMs`, en millisecondes.
 *
 * Obtenu en formatant l'instant DANS le fuseau, en relisant les parties
 * comme si elles étaient UTC, et en mesurant l'écart. C'est la seule
 * méthode fiable sans embarquer une base de fuseaux : `Intl` porte déjà
 * celle du système, et c'est la même que celle de PostgreSQL.
 */
function zoneOffsetMs(epochMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // `hour12: false` peut rendre 24 pour minuit selon la plateforme ; on
  // le ramène à 0 plutôt que de produire un jour décalé.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );
  return asUtc - epochMs;
}

/**
 * Instant UTC correspondant à une heure murale locale dans `tz`.
 *
 * Deux passes : on devine avec le décalage de l'instant approché, puis on
 * corrige si le décalage réel à l'instant trouvé diffère -- c'est ce qui
 * rend le résultat juste de part et d'autre d'un changement d'heure.
 *
 * Heures murales PARTICULIÈRES, comportement documenté et assumé :
 *   - heure INEXISTANTE (saut de printemps, 02:30 à Paris) : le résultat
 *     tombe après le saut ;
 *   - heure AMBIGUË (recul d'automne, 02:30 à Paris) : la PREMIÈRE
 *     occurrence est retenue (heure d'été).
 * PostgreSQL retient, lui, l'interprétation en heure NORMALE pour une
 * heure ambiguë : les deux côtés diffèrent donc d'une heure dans cette
 * seule heure de l'année. La fixture partagée n'emploie volontairement
 * aucune heure murale située dans une heure de transition, et cette
 * divergence est consignée comme observation non bloquante du lot.
 */
function zonedWallTimeToEpoch(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  tz: string
): number {
  const naive = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutesOfDay / 60),
    minutesOfDay % 60
  );
  const firstGuess = naive - zoneOffsetMs(naive, tz);
  const refined = naive - zoneOffsetMs(firstGuess, tz);
  return refined;
}

/** Date civile (`YYYY-MM-DD`) et minutes depuis minuit, dans `tz`. */
function zonedDateParts(
  epochMs: number,
  tz: string
): { date: string; minutesOfDay: number; weekday: number } {
  const offset = zoneOffsetMs(epochMs, tz);
  const local = new Date(epochMs + offset);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  const d = local.getUTCDate();
  return {
    date: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    minutesOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  };
}

/** `YYYY-MM-DD` → composantes, sans jamais passer par un fuseau. */
function splitDate(date: string): { y: number; m: number; d: number } {
  return {
    y: Number(date.slice(0, 4)),
    m: Number(date.slice(5, 7)),
    d: Number(date.slice(8, 10)),
  };
}

/**
 * Décale une date civile de `days` jours. L'arithmétique se fait en UTC
 * pur sur une date sans heure : un changement d'heure ne peut donc pas
 * faire perdre ou gagner un jour civil.
 */
function addDays(date: string, days: number): string {
  const { y, m, d } = splitDate(date);
  const next = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(
    next.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function weekdayOfDate(date: string): number {
  const { y, m, d } = splitDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeTime(value: string): string | null {
  const minutes = parseScheduleTime(value);
  if (minutes === null) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Calcule l'éligibilité. Fonction PURE : mêmes entrées, même sortie,
 * aucune lecture d'horloge (`nowIso` est fourni), aucune entrée/sortie.
 */
export function resolveScheduleEligibility(
  input: ScheduleInput
): ScheduleEligibility {
  const cfg = input.config;

  // ── Absence et désactivation : le MÊME état observable ──────────────
  // Une planification désactivée ne doit pas se distinguer d'une
  // planification absente, sinon activer puis désactiver laisserait une
  // trace de comportement. Dans les deux cas : le parcours d'avant ce
  // lot (CSDJ-V1-SCHEDULE-ABSENT-01).
  if (!cfg || cfg.enabled !== true) return ABSENT;

  // Une politique incohérente est un refus, jamais une interprétation.
  // La base l'interdit déjà par contrainte ; si une ligne y échappait,
  // ce module ne devinerait pas laquelle des deux politiques l'emporte.
  if (!isSchedulePolicyCoherent(cfg.dateSelectionMode, cfg.slotSelectionMode)) {
    return {
      ...ABSENT,
      status: "unfulfillable",
      reason: "no_offer_configured",
      timezone: cfg.timezone,
      dateSelectionMode: cfg.dateSelectionMode,
      slotSelectionMode: cfg.slotSelectionMode,
    };
  }

  const base = {
    timezone: cfg.timezone,
    dateSelectionMode: cfg.dateSelectionMode,
    slotSelectionMode: cfg.slotSelectionMode,
    timeGranularityMinutes:
      cfg.slotSelectionMode === "time_within_window"
        ? cfg.timeGranularityMinutes
        : null,
  };

  // ── Politique purement informative : aucune date, et c'est voulu ────
  if (cfg.dateSelectionMode === "informational_only") {
    return {
      ...base,
      status: "informational_only",
      reason: null,
      firstEligibleDate: null,
      dates: [],
    };
  }

  const nowMs = Date.parse(input.nowIso);
  if (Number.isNaN(nowMs)) {
    throw new Error("CSDJ1_INVALID_NOW: nowIso n'est pas un instant ISO 8601.");
  }

  // ── L'autorité des offres dépend de la politique d'horaire ──────────
  // CSDJ-V1-SINGLE-OFFER-AUTHORITY-01 : une seule table fait foi.
  const usesSlots = cfg.slotSelectionMode === "fixed_slots";
  if (cfg.slotSelectionMode === "time_within_window") {
    if (
      cfg.timeGranularityMinutes === null ||
      cfg.timeGranularityMinutes === undefined
    ) {
      return {
        ...base,
        status: "unfulfillable",
        reason: "granularity_missing",
        firstEligibleDate: null,
        dates: [],
      };
    }
  }

  const offersByWeekday = new Map<number, ScheduleOffer[]>();
  if (usesSlots) {
    for (const slot of input.slots) {
      const startsAt = normalizeTime(slot.startsAt);
      const endsAt = normalizeTime(slot.endsAt);
      if (startsAt === null || endsAt === null) continue;
      const list = offersByWeekday.get(slot.weekday) ?? [];
      list.push({ slotKey: slot.slotKey, startsAt, endsAt });
      offersByWeekday.set(slot.weekday, list);
    }
  } else {
    for (const win of input.windows) {
      const startsAt = normalizeTime(win.startsAt);
      const endsAt = normalizeTime(win.endsAt);
      if (startsAt === null || endsAt === null) continue;
      const list = offersByWeekday.get(win.weekday) ?? [];
      list.push({ slotKey: null, startsAt, endsAt });
      offersByWeekday.set(win.weekday, list);
    }
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

  if (offersByWeekday.size === 0) {
    return {
      ...base,
      status: "unfulfillable",
      reason: "no_offer_configured",
      firstEligibleDate: null,
      dates: [],
    };
  }

  const closed = new Set(input.closures.map((c) => c.closedOn));

  // ── Bornes de l'intervalle à examiner ───────────────────────────────
  // `today` est la date civile du commerçant, pas celle du client.
  const today = zonedDateParts(nowMs, cfg.timezone).date;

  // Délai de préparation : il repousse l'instant le plus tôt, donc
  // possiblement le JOUR le plus tôt.
  const earliestFromLead = zonedDateParts(
    nowMs + cfg.leadTimeMinutes * 60_000,
    cfg.timezone
  ).date;
  const earliestFromMinDays = addDays(today, cfg.minLeadDays);
  const startDate =
    compareDates(earliestFromLead, earliestFromMinDays) >= 0
      ? earliestFromLead
      : earliestFromMinDays;

  const lastDate = addDays(today, cfg.bookingHorizonDays);

  const cutoffMinutes =
    cfg.cutoffTime === null || cfg.cutoffTime === undefined
      ? null
      : parseScheduleTime(cfg.cutoffTime);

  const eligible: ScheduleDateOffer[] = [];
  let sawClosureOnly = false;

  for (
    let date = startDate;
    compareDates(date, lastDate) <= 0;
    date = addDays(date, 1)
  ) {
    const offers = offersByWeekday.get(weekdayOfDate(date));
    // CSDJ-V1-DAY-WITHOUT-OFFER-01 : un jour sans offre est un jour
    // FERMÉ. Il n'existe pas de table « jours fermés » : deux autorités
    // pourraient se contredire.
    if (!offers || offers.length === 0) continue;

    if (closed.has(date)) {
      sawClosureOnly = true;
      continue;
    }

    // Heure limite : la commande doit être passée AVANT
    // `(date - cutoffOffsetDays) à cutoffTime`, dans le fuseau du
    // commerçant. L'inégalité est STRICTE : à la seconde de l'heure
    // limite, il est trop tard -- une limite qu'on peut atteindre pile
    // n'est pas une limite.
    if (cutoffMinutes !== null) {
      const cutoffDate = addDays(date, -cfg.cutoffOffsetDays);
      const { y, m, d } = splitDate(cutoffDate);
      const cutoffEpoch = zonedWallTimeToEpoch(
        y,
        m,
        d,
        cutoffMinutes,
        cfg.timezone
      );
      if (nowMs >= cutoffEpoch) continue;
    }

    eligible.push({ date, offers });
    if (cfg.dateSelectionMode === "derived_earliest") break;
  }

  if (eligible.length === 0) {
    return {
      ...base,
      status: "unfulfillable",
      // Distinguer « tout est fermé » de « l'horizon est épuisé » :
      // le premier se corrige en retirant une fermeture, le second en
      // allongeant l'horizon ou en desserrant le délai. Confondre les
      // deux, c'est livrer au commerçant un refus qu'il ne sait pas
      // corriger.
      reason: sawClosureOnly ? "all_dates_closed" : "horizon_exhausted",
      firstEligibleDate: null,
      dates: [],
    };
  }

  return {
    ...base,
    status: "dates_available",
    reason: null,
    firstEligibleDate: eligible[0]!.date,
    dates: eligible,
  };
}
