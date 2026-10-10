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
  type CheckoutWallTimeStatus,
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
 * ══════════════════════════════════════════════════════════════════════
 * CSDJ-V1-WALL-TIME-FAIL-CLOSED-01 — POLITIQUE DE CHANGEMENT D'HEURE
 *
 * Une heure murale locale ne désigne pas toujours un instant unique :
 *   - INEXISTANTE au saut de printemps (à Paris, le 29 mars 2026 entre
 *     02:00 et 03:00 : ces minutes n'ont jamais eu lieu) ;
 *   - AMBIGUË au recul d'automne (le 25 octobre 2026 entre 02:00 et
 *     03:00 : ces minutes ont eu lieu DEUX fois).
 *
 * La politique de la v1 est le REFUS FERMÉ des deux cas. La
 * normalisation de PostgreSQL est un comportement de MOTEUR, pas une
 * décision commerciale : pour une heure ambiguë, la promesse « nous
 * vous livrons à 02:30 » désignerait deux instants distants d'une
 * heure, et aucun des deux n'aurait été choisi par quiconque.
 *
 * Le refus porte sur l'OCCURRENCE d'une date, pas sur la configuration :
 * une fenêtre 02:00-03:00 reste valide les 364 autres jours de l'année,
 * et c'est pourquoi il ne peut pas être prononcé à l'écriture.
 *
 * ══════════════════════════════════════════════════════════════════════
 * CSDJ-V1-TRANSITION-SAFE-CLASSIFY-01 — remédiation du re-audit delta
 *
 * La première remédiation détectait l'ambiguïté en regardant si
 * l'instant trouvé PLUS OU MOINS UNE HEURE rendait la même heure
 * murale. C'était faux : UNE TRANSITION NE FAIT PAS TOUJOURS UNE HEURE.
 * Australia/Lord_Howe recule de TRENTE minutes, et le 5 avril 2026 à
 * 01:45 l'heure locale est vécue deux fois -- que ce test manquait
 * entièrement, puisque ni 00:45 ni 02:45 ne rendent 01:45.
 *
 * L'algorithme ci-dessous ne suppose RIEN de la taille du décalage. Il
 * ÉNUMÈRE les instants candidats :
 *
 *   1. on échantillonne les décalages UTC réellement en vigueur autour
 *      de l'heure demandée (un jour avant, quatre heures avant, le
 *      point lui-même, quatre heures après, un jour après) -- assez
 *      large pour encadrer n'importe quelle transition, assez serré
 *      pour n'en manquer aucune ;
 *   2. pour CHAQUE décalage distinct, on construit l'instant candidat
 *      `heure murale - décalage` ;
 *   3. on ne garde que les candidats qui, relus dans le fuseau, rendent
 *      EXACTEMENT l'heure murale demandée.
 *
 * Le NOMBRE de survivants est la réponse, et il n'y en a pas d'autre :
 *   0 -> l'heure n'existe pas ;
 *   1 -> elle désigne un instant unique ;
 *   2 -> elle en désigne deux.
 *
 * Aucune constante de durée n'apparaît dans la décision. La seule
 * source de vérité est la base de fuseaux du système, la même que celle
 * de PostgreSQL.
 * ══════════════════════════════════════════════════════════════════════
 */
/** Alias du catalogue fermé : une seule liste, deux noms d'usage. */
export type WallTimeStatus = CheckoutWallTimeStatus;

export interface WallTimeResolution {
  readonly status: WallTimeStatus;
  /** Instant UTC, ou `null` dès que le statut n'est pas `valid_unique`. */
  readonly epochMs: number | null;
}

/**
 * Décalages d'échantillonnage, en millisecondes, relatifs à l'heure
 * murale lue comme si elle était UTC. Un jour de part et d'autre
 * encadre toute transition réelle, quelle que soit sa taille et quel
 * que soit le décalage du fuseau (jusqu'à ±14 h).
 */
const OFFSET_PROBES_MS = [-86_400_000, -14_400_000, 0, 14_400_000, 86_400_000];

export function resolveWallTime(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  tz: string
): WallTimeResolution {
  const naiveAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutesOfDay / 60),
    minutesOfDay % 60
  );

  // 1. Décalages réellement en vigueur autour de ce point.
  const offsets: number[] = [];
  for (const probe of OFFSET_PROBES_MS) {
    const off = zoneOffsetMs(naiveAsUtc + probe, tz);
    if (!offsets.includes(off)) offsets.push(off);
  }

  // 2./3. Candidats, puis survivants de l'aller-retour.
  const survivors: number[] = [];
  for (const off of offsets) {
    const candidate = naiveAsUtc - off;
    const back = zonedDateParts(candidate, tz);
    const wanted = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (back.date === wanted && back.minutesOfDay === minutesOfDay) {
      if (!survivors.includes(candidate)) survivors.push(candidate);
    }
  }

  if (survivors.length === 0) return { status: "nonexistent", epochMs: null };
  if (survivors.length === 1) {
    return { status: "valid_unique", epochMs: survivors[0]! };
  }
  // Deux instants ou plus pour la même heure murale : elle est ambiguë,
  // et la politique la refuse. Le cas « plus de deux » n'existe pas
  // dans la base de fuseaux, mais le traiter comme ambigu est le même
  // refus -- jamais un choix silencieux.
  return { status: "ambiguous", epochMs: null };
}

/** Date civile (`YYYY-MM-DD`), minutes depuis minuit et jour de semaine
 *  d'un instant, LUS DANS `tz`. */
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

/** Jour de semaine d'une date civile. 0 = dimanche, comme extract(dow). */
function weekdayOfDate(date: string): number {
  const { y, m, d } = splitDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `HH:MM` depuis des minutes depuis minuit. Seule forme publique
 *  (CSDJ-V1-MINUTE-PRECISION-01). */
function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Normalise une heure de configuration, ou `null` si elle n'est pas
 * admissible -- secondes non nulles comprises
 * (CSDJ-V1-MINUTE-PRECISION-01). Une heure refusée ici n'est jamais
 * tronquée : l'offre correspondante est simplement écartée, et la base
 * la refuse déjà à l'écriture.
 */
function normalizeTime(value: string): string | null {
  const minutes = parseScheduleTime(value);
  if (minutes === null) return null;
  return formatMinutes(minutes);
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

  // `min_lead_days` est une contrainte de JOUR : la date demandée doit
  // être au moins N jours après aujourd'hui. Elle borne donc l'intervalle
  // examiné.
  const startDate = addDays(today, cfg.minLeadDays);
  const lastDate = addDays(today, cfg.bookingHorizonDays);

  // ════════════════════════════════════════════════════════════════════
  // CSDJ-V1-OFFER-START-INSTANT-01 — INSTANT MINIMAL DE RÉALISATION
  //
  // Le délai de préparation est une contrainte d'INSTANT, pas de jour.
  // La version précédente ne l'appliquait qu'à la date de départ, ce qui
  // laissait proposer un créneau 09:00–11:00 avec 120 minutes de délai
  // alors qu'il était 15:00 : la date passait le filtre, l'offre non --
  // et personne ne regardait l'offre (CSDJ1-AUD-01).
  //
  // Désormais CHAQUE offre est comparée, en INSTANT, à
  //     minInstant = max( now + lead_time_minutes,
  //                       début de (today + min_lead_days) dans le fuseau )
  // et une offre dont le DÉBUT tombe avant est écartée. Règle unique
  // pour les trois politiques d'horaire, choisie parce qu'elle est
  // conservatrice : un créneau déjà commencé n'est pas honorable en
  // entier, donc il n'est pas proposé. Aucun « créneau suivant » n'est
  // inventé -- les offres sont filtrées, jamais fabriquées.
  //
  // Seule nuance, pour `time_within_window` : le client y choisit une
  // HEURE dans la fenêtre, donc le début est AVANCÉ le long de la grille
  // de granularité du commerçant jusqu'au premier point utilisable. Ce
  // n'est pas une offre nouvelle, c'est la part encore utilisable d'une
  // fenêtre existante ; si la grille sort de la fenêtre, la fenêtre
  // disparaît.
  // ════════════════════════════════════════════════════════════════════
  const startDateParts = splitDate(startDate);
  const startDateFloor = resolveWallTime(
    startDateParts.y,
    startDateParts.m,
    startDateParts.d,
    0,
    cfg.timezone
  );
  const fromLead = nowMs + cfg.leadTimeMinutes * 60_000;
  const minInstant =
    startDateFloor.epochMs !== null && startDateFloor.epochMs > fromLead
      ? startDateFloor.epochMs
      : fromLead;

  const cutoffMinutes =
    cfg.cutoffTime === null || cfg.cutoffTime === undefined
      ? null
      : parseScheduleTime(cfg.cutoffTime);

  const granularity = cfg.timeGranularityMinutes;
  const eligible: ScheduleDateOffer[] = [];
  let sawClosure = false;
  let sawOpenDate = false;

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
      sawClosure = true;
      continue;
    }

    // Heure limite : la commande doit être passée AVANT
    // `(date - cutoffOffsetDays) à cutoffTime`, dans le fuseau du
    // commerçant. L'inégalité est STRICTE : à la seconde de l'heure
    // limite, il est trop tard -- une limite qu'on peut atteindre pile
    // n'est pas une limite.
    //
    // Si cette heure limite tombe elle-même sur une heure murale
    // inexistante ou ambiguë, la date est écartée : on ne devine pas
    // l'instant d'une limite (CSDJ-V1-WALL-TIME-FAIL-CLOSED-01).
    if (cutoffMinutes !== null) {
      const cutoffDate = addDays(date, -cfg.cutoffOffsetDays);
      const c = splitDate(cutoffDate);
      const cutoff = resolveWallTime(c.y, c.m, c.d, cutoffMinutes, cfg.timezone);
      if (cutoff.epochMs === null) continue;
      if (nowMs >= cutoff.epochMs) continue;
    }

    sawOpenDate = true;
    const { y, m, d } = splitDate(date);
    const usable: ScheduleOffer[] = [];

    for (const offer of offers) {
      const startMin = parseScheduleTime(offer.startsAt);
      const endMin = parseScheduleTime(offer.endsAt);
      if (startMin === null || endMin === null) continue;

      // ════════════════════════════════════════════════════════════════
      // CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01
      //
      // Remédiation du re-audit delta. Il ne suffit pas de valider le
      // DÉBUT : une fenêtre 01:30-02:30 le 29 mars 2026 à Paris avait un
      // début parfaitement valide et une FIN qui n'existe pas -- elle
      // était pourtant proposée, fin comprise. Et une fenêtre
      // 01:30-03:30 pouvait exposer un intervalle contenant des heures
      // murales inexistantes, que le client aurait pu choisir.
      //
      // Règle : si UNE SEULE des heures murales nécessaires pour
      // construire l'offre -- début, fin, ou n'importe quel point de la
      // grille sélectionnable -- est inexistante ou ambiguë, l'offre
      // N'EST PAS EXPOSÉE pour cette date. Tout ou rien, et fermé.
      //
      // Aucune heure de remplacement n'est inventée. L'occurrence
      // disparaît ce jour-là ; la configuration reste intacte et valide
      // les autres jours.
      // ════════════════════════════════════════════════════════════════
      const endStatus = resolveWallTime(y, m, d, endMin, cfg.timezone).status;
      if (endStatus !== "valid_unique") continue;

      if (cfg.slotSelectionMode === "time_within_window" && granularity) {
        // Toute la grille est validée, pas seulement la part encore
        // utilisable : sur une date ordinaire, le client pourrait
        // choisir n'importe lequel de ces points.
        let gridIsSound = true;
        let chosen: { minute: number; epochMs: number } | null = null;
        for (let t = startMin; t < endMin; t += granularity) {
          const r = resolveWallTime(y, m, d, t, cfg.timezone);
          if (r.status !== "valid_unique") {
            gridIsSound = false;
            break;
          }
          // Premier point réalisable : il devient le début exposé
          // (CSDJ-V1-OFFER-START-INSTANT-01).
          if (chosen === null && r.epochMs !== null && r.epochMs >= minInstant) {
            chosen = { minute: t, epochMs: r.epochMs };
          }
        }
        if (!gridIsSound) continue;
        if (chosen === null) continue;
        usable.push({
          slotKey: null,
          startsAt: formatMinutes(chosen.minute),
          endsAt: formatMinutes(endMin),
        });
        continue;
      }

      // `fixed_slots` et `none` : l'offre est atomique. Début ET fin
      // doivent exister, et le DÉBUT décide de sa réalisabilité.
      const r = resolveWallTime(y, m, d, startMin, cfg.timezone);
      if (r.status !== "valid_unique" || r.epochMs === null) continue;
      if (r.epochMs < minInstant) continue;
      usable.push({
        slotKey: offer.slotKey,
        startsAt: formatMinutes(startMin),
        endsAt: formatMinutes(endMin),
      });
    }

    // Une date dont toutes les offres ont été écartées n'est PAS une date
    // éligible : la proposer afficherait un jour sans aucune heure.
    if (usable.length === 0) continue;

    eligible.push({ date, offers: usable });
    if (cfg.dateSelectionMode === "derived_earliest") break;
  }

  if (eligible.length === 0) {
    return {
      ...base,
      status: "unfulfillable",
      // Trois causes distinctes, trois corrections distinctes :
      //   - tout est fermé            -> retirer une fermeture ;
      //   - des dates sont ouvertes mais aucune offre ne tient encore
      //     -> desserrer le délai, ou attendre demain ;
      //   - la première date possible est au-delà de l'horizon
      //     -> allonger l'horizon ou réduire le minimum de jours.
      // Les confondre livrerait au commerçant un refus qu'il ne sait pas
      // corriger.
      reason: sawOpenDate
        ? "no_offer_in_horizon"
        : sawClosure
          ? "all_dates_closed"
          : "horizon_exhausted",
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
