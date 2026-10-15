/**
 * SCANYM — CSDJ-BO-1 — BACKEND TRANSACTIONNEL SIMULÉ.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * L'issue #149 demande des tests « e2e simulé » et interdit de
 * basculer `CSDJ_BO1_WRITE_CONTRACT.available` avant qu'une RPC
 * transactionnelle de Boulez existe. Les deux tiennent ensemble à une
 * condition : disposer d'une IMPLÉMENTATION DE RÉFÉRENCE du contrat
 * `save_fulfillment_configuration`, en mémoire, qui se comporte comme
 * le serveur devra se comporter.
 *
 * Ce module est cette référence. Il sert trois usages :
 *   1. les tests e2e simulés de l'éditeur ;
 *   2. la spécification exécutable remise à Boulez — chaque refus
 *      ci-dessous est un refus que le SQL devra produire ;
 *   3. la preuve que l'interface sait réagir à chacun de ces refus.
 *
 * CE QU'IL N'EST PAS : une autorité. Il ne tourne QUE dans les tests
 * (il vit sous tests/helpers/, jamais importé par app/ ni par lib/), il
 * ne touche aucune base, et il ne dispense pas le serveur de revalider.
 *
 * PROPRIÉTÉS TENUES, dans l'ordre du contrat
 * (docs/scheduling/csdj-bo1-write-contract-request.md) :
 *   - UNE transaction : la configuration est écrite entièrement ou pas
 *     du tout. Tout refus laisse l'état d'AVANT, octet pour octet.
 *   - L'activation est VALIDÉE, pas déclarée : `enabled: true` sur une
 *     configuration incomplète est refusé par son nom.
 *   - Remplacement intégral : les listes absentes sont traitées comme
 *     vides, jamais comme « inchangées ».
 *   - Édition concurrente REFUSÉE, jamais écrasée (`expectedUpdatedAt`).
 *   - Aucun compte de capacité en sortie.
 *   - La réponse est la configuration relue.
 */

export interface FakeScheduleRow {
  modeCode: string;
  fulfillmentRuleId: string | null;
  timezone: string;
  enabled: boolean;
  dateSelectionMode: string;
  slotSelectionMode: string;
  timeGranularityMinutes: number | null;
  leadTimeMinutes: number;
  minLeadDays: number;
  cutoffTime: string | null;
  cutoffOffsetDays: number;
  bookingHorizonDays: number;
  windows: Array<{ weekday: number; startsAt: string; endsAt: string }>;
  slots: Array<{ weekday: number; slotKey: string; startsAt: string; endsAt: string }>;
  closures: Array<{ closedOn: string; label: string | null }>;
  /** Jeton 1 : horodatage UTC à la microseconde, tel que PostgreSQL le rend. */
  updatedAt: string;
  /** Jeton 2 : empreinte de contenu, 32 caractères hexadécimaux. */
  revision: string;
}

export interface FakeV12Row {
  modeCode: string;
  fulfillmentRuleId: string | null;
  scheduleMethodVersion: string;
  holidayCalendarId: string | null;
  preparationOnHolidays: string;
  availabilityOnHolidays: string;
  capacityEnabled: boolean;
  capacityMaxOrders: number | null;
  preparationWeekdays: number[];
  preparationClosures: Array<{ closedOn: string; label: string | null }>;
}

export interface FakeTenantState {
  /** Rôle du compte sur cet établissement, tel que le serveur le verrait. */
  role: "owner" | "manager" | "staff";
  schedules: FakeScheduleRow[];
  v12: FakeV12Row[];
  /** Modes de vente du catalogue : un mode hors catalogue est refusé. */
  modes: string[];
  /** Règles de livraison appartenant à cet établissement. */
  rules: string[];
}

export interface FakeBackendOptions {
  /** Horodatage rendu aux écritures acceptées ; incrémenté à chaque écriture. */
  clock?: () => string;
  /** Empreinte de contenu rendue aux écritures acceptées (32 hex). */
  revisionClock?: () => string;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export class FakeWriteRefusal extends Error {
  constructor(code: string, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "FakeWriteRefusal";
  }
}

function scopeKey(modeCode: string, fulfillmentRuleId: string | null): string {
  return `${modeCode}::${fulfillmentRuleId ?? "mode"}`;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Backend en mémoire, multi-locataire. Chaque appel reçoit
 * l'établissement visé : c'est ce qui permet de tester l'isolation sans
 * jamais partager un état entre deux établissements.
 */
export class FakeFulfillmentWriteBackend {
  private tenants = new Map<string, FakeTenantState>();
  private writes = 0;
  private clock: () => string;
  /** Journal des appels, pour prouver qu'un refus n'a RIEN écrit. */
  readonly calls: Array<{ restaurantId: string; accepted: boolean; refusal?: string }> = [];

  constructor(options: FakeBackendOptions = {}) {
    // Horloge à la MICROSECONDE, comme PostgreSQL : six chiffres de
    // fraction, et deux écritures consécutives ne diffèrent QUE par les
    // trois derniers. Un appelant qui tronquerait à la milliseconde
    // rendrait donc deux versions indistinguables — c'est précisément ce
    // que les tests de précision exploitent.
    this.clock =
      options.clock ??
      (() => {
        this.writes += 1;
        return `2026-10-14T08:30:00.${String(123000 + this.writes).padStart(6, "0")}Z`;
      });
    this.revisionClock =
      options.revisionClock ??
      (() => {
        this.revisions += 1;
        return `${String(this.revisions).padStart(8, "0")}c0ffee1deadbeef0cafe1234`;
      });
  }

  private revisions = 0;
  private revisionClock: () => string;

  setTenant(restaurantId: string, state: FakeTenantState): void {
    this.tenants.set(restaurantId, deepCopy(state));
  }

  tenant(restaurantId: string): FakeTenantState {
    const state = this.tenants.get(restaurantId);
    if (!state) throw new FakeWriteRefusal("CSDJBO1_UNKNOWN_TENANT");
    return state;
  }

  /** Lecture marchande v1 — projection identique à la RPC publiée. */
  readSchedules(restaurantId: string): unknown[] {
    const state = this.tenant(restaurantId);
    return state.schedules.map((row) => ({
      mode_code: row.modeCode,
      fulfillment_rule_id: row.fulfillmentRuleId,
      timezone: row.timezone,
      enabled: row.enabled,
      date_selection_mode: row.dateSelectionMode,
      slot_selection_mode: row.slotSelectionMode,
      time_granularity_minutes: row.timeGranularityMinutes,
      lead_time_minutes: row.leadTimeMinutes,
      min_lead_days: row.minLeadDays,
      cutoff_time: row.cutoffTime,
      cutoff_offset_days: row.cutoffOffsetDays,
      booking_horizon_days: row.bookingHorizonDays,
      windows: row.windows,
      slots: row.slots,
      closures: row.closures,
      updated_at: row.updatedAt,
    }));
  }

  /** Lecture marchande v1.2 — même forme que la RPC de la PR #146. */
  readV12(restaurantId: string): unknown[] {
    const state = this.tenant(restaurantId);
    return state.v12.map((row) => ({
      mode_code: row.modeCode,
      fulfillment_rule_id: row.fulfillmentRuleId,
      schedule_method_version: row.scheduleMethodVersion,
      holiday_calendar_id: row.holidayCalendarId,
      preparation_on_holidays: row.preparationOnHolidays,
      availability_on_holidays: row.availabilityOnHolidays,
      capacity_enabled: row.capacityEnabled,
      capacity_max_orders: row.capacityMaxOrders,
      preparation_weekdays: row.preparationWeekdays,
      preparation_closures: row.preparationClosures,
    }));
  }

  /**
   * `save_fulfillment_configuration` — l'écriture, en une transaction.
   *
   * Tout refus est levé AVANT la moindre modification : l'état du
   * locataire n'est remplacé qu'à la toute fin, en un seul passage.
   */
  save(restaurantId: string, payload: Record<string, unknown>): Record<string, unknown> {
    const state = this.tenant(restaurantId);

    const refuse = (code: string, detail = ""): never => {
      this.calls.push({ restaurantId, accepted: false, refusal: code });
      throw new FakeWriteRefusal(code, detail);
    };

    // ── Rôle : propriétaire ou responsable UNIQUEMENT (aucune
    //    dérogation opérateur, comme l'autorité SQL existante).
    if (state.role !== "owner" && state.role !== "manager") {
      refuse("CSDJ1_FORBIDDEN", "rôle owner ou manager requis");
    }

    const modeCode = String(payload.modeCode ?? "");
    if (!state.modes.includes(modeCode)) {
      refuse("CSDJ1_UNKNOWN_MODE", "mode de vente hors catalogue");
    }
    const ruleId = (payload.fulfillmentRuleId ?? null) as string | null;
    if (ruleId === ZERO_UUID) {
      refuse("CSDJ1_RESERVED_RULE_ID", "le zéro UUID est une sentinelle interne");
    }
    if (ruleId !== null && !state.rules.includes(ruleId)) {
      refuse("CSDJ1_FOREIGN_RULE", "règle inconnue pour cet établissement et ce mode");
    }

    const method = String(payload.method ?? "v1");
    if (method !== "v1" && method !== "v1.2") {
      refuse("CSDJBO1_METHOD_MISMATCH", "méthode inconnue");
    }

    // ── MÉTHODE : les deux sens sont refusés (remédiation R1, §3) ──
    //    v1 interdit les trois sections v1.2 ; v1.2 les EXIGE toutes
    //    les trois. Une charge v1.2 amputée d'une section n'est pas une
    //    charge partielle acceptable : dans un remplacement intégral,
    //    une section absente ne veut rien dire.
    const hasV12Sections =
      payload.preparation !== undefined ||
      payload.holidays !== undefined ||
      payload.capacity !== undefined;
    if (method === "v1" && hasV12Sections) {
      refuse("CSDJBO1_METHOD_MISMATCH", "sections v1.2 sur une charge v1");
    }
    if (
      method === "v1.2" &&
      (payload.preparation === undefined ||
        payload.holidays === undefined ||
        payload.capacity === undefined)
    ) {
      refuse("CSDJBO1_METHOD_MISMATCH", "une charge v1.2 exige preparation, holidays et capacity");
    }

    // ── LISTES TOUJOURS FOURNIES, MÊME VIDES ──────────────────────
    for (const list of ["windows", "slots", "closures"] as const) {
      if (!Array.isArray(payload[list])) {
        refuse("CSDJBO1_METHOD_MISMATCH", `liste ${list} absente d'un remplacement intégral`);
      }
    }

    const policy = (payload.policy ?? {}) as Record<string, unknown>;
    if (!policy.timezone || String(policy.timezone).trim() === "") {
      refuse("CSDJ1_INVALID_TIMEZONE", "fuseau requis");
    }
    // Champs de politique OBLIGATOIRES du contrat : une clé absente est
    // refusée au lieu d'être comblée par un défaut inventé ici.
    for (const field of [
      "dateSelectionMode",
      "slotSelectionMode",
      "leadTimeMinutes",
      "minLeadDays",
      "bookingHorizonDays",
    ] as const) {
      if (policy[field] === undefined) {
        refuse("CSDJ1_INVALID_POLICY", `policy.${field} est obligatoire`);
      }
    }
    for (const field of ["timeGranularityMinutes", "cutoffTime"] as const) {
      if (!(field in policy)) {
        refuse("CSDJ1_INVALID_POLICY", `policy.${field} est obligatoire (null accepté)`);
      }
    }
    const cutoffTime = (policy.cutoffTime ?? null) as string | null;
    if (cutoffTime !== null && !/^\d{2}:\d{2}$/.test(cutoffTime)) {
      refuse("CSDJ1_SUBMINUTE_TIME", "les heures sont à la minute");
    }
    // ── DÉCALAGE D'HEURE LIMITE : v1 le veut borné, v1.2 l'interdit ─
    if (method === "v1.2") {
      if (policy.cutoffOffsetDays !== undefined && Number(policy.cutoffOffsetDays) !== 0) {
        refuse("CSDJ12_CUTOFF_OFFSET_REMOVED", "le décalage n'existe pas en v1.2");
      }
    } else {
      const offset = policy.cutoffOffsetDays;
      if (offset === undefined) {
        refuse("CSDJ1_INVALID_POLICY", "policy.cutoffOffsetDays est obligatoire en v1");
      }
      const value = Number(offset);
      if (!Number.isInteger(value) || value < 0 || value > 30) {
        refuse("CSDJ1_INVALID_POLICY", "le décalage v1 va de 0 à 30 jours");
      }
    }

    const slotMode = String(policy.slotSelectionMode ?? "none");
    const dateMode = String(policy.dateSelectionMode ?? "informational_only");
    if (slotMode !== "none" && dateMode !== "customer_selectable") {
      refuse("CSDJ1_INVALID_POLICY", "choisir une heure exige de choisir la date");
    }

    const windows = (payload.windows ?? []) as Array<Record<string, unknown>>;
    const slots = (payload.slots ?? []) as Array<Record<string, unknown>>;
    const closures = (payload.closures ?? []) as Array<Record<string, unknown>>;

    // Bornes de liste du contrat : 100 fenêtres, 200 créneaux.
    if (windows.length > 100) refuse("CSDJ1_TOO_MANY_WINDOWS", "100 au plus");
    if (slots.length > 200) refuse("CSDJ1_TOO_MANY_SLOTS", "200 au plus");
    if (closures.length > 731) refuse("CSDJ1_TOO_MANY_CLOSURES", "731 au plus");

    // Non-superposition des plages, par jour — refus nommé existant.
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const day = windows
        .filter((w) => Number(w.weekday) === weekday)
        .map((w) => ({ start: String(w.startsAt), end: String(w.endsAt) }))
        .sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < day.length; i += 1) {
        if (day[i].start < day[i - 1].end) {
          refuse("CSDJ1_WINDOW_OVERLAP", `jour ${weekday}`);
        }
      }
    }

    if (slotMode === "time_within_window" && policy.timeGranularityMinutes == null) {
      refuse("CSDJBO1_INCOMPLETE_CONFIGURATION", "granularity_missing");
    }

    const capacity = (payload.capacity ?? {}) as Record<string, unknown>;
    if (capacity.enabled === true) {
      const max = capacity.maxOrders;
      if (max === null || max === undefined || Number(max) < 1) {
        refuse("CSDJ12_INVALID_CAPACITY", "maximum strictement positif requis");
      }
      if (dateMode === "informational_only") {
        refuse("CSDJ12_CAPACITY_NEEDS_DATE", "la capacité exige une date choisie");
      }
    }

    const holidays = (payload.holidays ?? {}) as Record<string, unknown>;
    if (
      (holidays.preparationOnHolidays === "closed" ||
        holidays.availabilityOnHolidays === "closed") &&
      (holidays.calendarId ?? null) === null
    ) {
      refuse("CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR", "calendrier requis");
    }

    const preparation = (payload.preparation ?? {}) as Record<string, unknown>;
    const prepWeekdays = ((preparation.weekdays ?? []) as number[]).map((d) => Number(d));
    for (const weekday of prepWeekdays) {
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        refuse("CSDJ12_INVALID_WEEKDAY", "0 (dimanche) à 6 (samedi)");
      }
    }
    const prepClosures = (preparation.closures ?? []) as Array<Record<string, unknown>>;
    if (prepClosures.length > 731) {
      refuse("CSDJ12_TOO_MANY_CLOSURES", "731 au plus");
    }

    // ── L'ACTIVATION EST VALIDÉE, PAS DÉCLARÉE ────────────────────
    if (payload.enabled === true) {
      const blockers: string[] = [];
      if (dateMode !== "informational_only") {
        const authoritative = slotMode === "fixed_slots" ? slots : windows;
        if (authoritative.length === 0) blockers.push("offer_missing");
      }
      if (slotMode === "time_within_window" && policy.timeGranularityMinutes == null) {
        blockers.push("granularity_missing");
      }
      if (method === "v1.2" && prepWeekdays.length === 0) {
        blockers.push("preparation_missing");
      }
      if (capacity.enabled === true && (capacity.maxOrders ?? null) === null) {
        blockers.push("capacity_incomplete");
      }
      if (capacity.enabled === true && dateMode === "informational_only") {
        blockers.push("capacity_needs_date");
      }
      if (blockers.length > 0) {
        refuse("CSDJBO1_INCOMPLETE_CONFIGURATION", blockers.join(","));
      }
    }

    // ── Édition concurrente : REFUSÉE, jamais écrasée ─────────────
    //
    // LES DEUX jetons sont exigés, et comparés par ÉGALITÉ EXACTE DE
    // CHAÎNE (remédiation R1, §3). C'est ce qui attrape une troncature :
    // un appelant qui aurait fait passer `updatedAt` par un `Date`
    // renverrait « …T08:30:00.123Z » au lieu de « …T08:30:00.123456Z »,
    // et serait refusé ici — exactement comme le serveur le refuserait,
    // au lieu de l'accepter par tolérance et de masquer le défaut.
    const key = scopeKey(modeCode, ruleId);
    const existing = state.schedules.find(
      (row) => scopeKey(row.modeCode, row.fulfillmentRuleId) === key
    );
    const expectedUpdatedAt = (payload.expectedUpdatedAt ?? null) as string | null;
    const expectedRevision = (payload.expectedRevision ?? null) as string | null;
    if (existing) {
      if (expectedUpdatedAt !== existing.updatedAt || expectedRevision !== existing.revision) {
        refuse("CSDJBO1_STALE_CONFIGURATION", "la portée a changé depuis votre lecture");
      }
    } else if (expectedUpdatedAt !== null || expectedRevision !== null) {
      refuse("CSDJBO1_STALE_CONFIGURATION", "la portée n'existe plus");
    }

    // ── COMMIT : un seul passage, remplacement intégral ───────────
    const now = this.clock();
    const nextRevision = this.revisionClock();
    const nextSchedule: FakeScheduleRow = {
      modeCode,
      fulfillmentRuleId: ruleId,
      timezone: String(policy.timezone),
      enabled: payload.enabled === true,
      dateSelectionMode: dateMode,
      slotSelectionMode: slotMode,
      timeGranularityMinutes:
        policy.timeGranularityMinutes == null ? null : Number(policy.timeGranularityMinutes),
      leadTimeMinutes: Number(policy.leadTimeMinutes ?? 0),
      minLeadDays: Number(policy.minLeadDays ?? 0),
      cutoffTime: cutoffTime === null ? null : `${cutoffTime}:00`,
      cutoffOffsetDays: method === "v1.2" ? 0 : Number(policy.cutoffOffsetDays ?? 0),
      bookingHorizonDays: Number(policy.bookingHorizonDays ?? 0),
      windows: windows.map((w) => ({
        weekday: Number(w.weekday),
        startsAt: String(w.startsAt),
        endsAt: String(w.endsAt),
      })),
      slots: slots.map((s) => ({
        weekday: Number(s.weekday),
        slotKey: String(s.slotKey),
        startsAt: String(s.startsAt),
        endsAt: String(s.endsAt),
      })),
      closures: closures.map((c) => ({
        closedOn: String(c.closedOn),
        label: (c.label ?? null) as string | null,
      })),
      updatedAt: now,
      revision: nextRevision,
    };
    state.schedules = [
      ...state.schedules.filter(
        (row) => scopeKey(row.modeCode, row.fulfillmentRuleId) !== key
      ),
      nextSchedule,
    ].sort((a, b) => a.modeCode.localeCompare(b.modeCode));

    if (method === "v1.2") {
      const nextV12: FakeV12Row = {
        modeCode,
        fulfillmentRuleId: ruleId,
        scheduleMethodVersion: "v1.2",
        holidayCalendarId: (holidays.calendarId ?? null) as string | null,
        preparationOnHolidays: String(holidays.preparationOnHolidays ?? "open"),
        availabilityOnHolidays: String(holidays.availabilityOnHolidays ?? "open"),
        capacityEnabled: capacity.enabled === true,
        capacityMaxOrders:
          capacity.maxOrders == null ? null : Number(capacity.maxOrders),
        preparationWeekdays: [...prepWeekdays].sort((a, b) => a - b),
        preparationClosures: prepClosures.map((c) => ({
          closedOn: String(c.closedOn),
          label: (c.label ?? null) as string | null,
        })),
      };
      state.v12 = [
        ...state.v12.filter((row) => scopeKey(row.modeCode, row.fulfillmentRuleId) !== key),
        nextV12,
      ];
    } else {
      state.v12 = state.v12.filter(
        (row) => scopeKey(row.modeCode, row.fulfillmentRuleId) !== key
      );
    }

    this.calls.push({ restaurantId, accepted: true });
    // La RÉPONSE de l'écriture : la configuration écrite et ses deux
    // nouveaux jetons, dans la même forme que la lecture autoritaire.
    // C'est elle qui permet à l'appelant d'enchaîner une seconde
    // sauvegarde sans relire (contrat §3).
    return this.readConfiguration(restaurantId, modeCode, ruleId)!;
  }

  /**
   * `get_fulfillment_configuration` — lecture AUTORITAIRE d'une portée.
   * Rend `null` quand la portée n'a pas de configuration : c'est une
   * réponse légitime, jamais une erreur.
   */
  readConfiguration(
    restaurantId: string,
    modeCode: string,
    fulfillmentRuleId: string | null
  ): Record<string, unknown> | null {
    const state = this.tenant(restaurantId);
    const key = scopeKey(modeCode, fulfillmentRuleId);
    const row = state.schedules.find(
      (r) => scopeKey(r.modeCode, r.fulfillmentRuleId) === key
    );
    if (!row) return null;
    const v12 = state.v12.find((r) => scopeKey(r.modeCode, r.fulfillmentRuleId) === key);
    const configuration: Record<string, unknown> = {
      // Les deux jetons d'abord : ils sont la raison d'être de cette lecture.
      updatedAt: row.updatedAt,
      revision: row.revision,
      modeCode: row.modeCode,
      fulfillmentRuleId: row.fulfillmentRuleId,
      method: v12 ? v12.scheduleMethodVersion : "v1",
      enabled: row.enabled,
      policy: {
        timezone: row.timezone,
        dateSelectionMode: row.dateSelectionMode,
        slotSelectionMode: row.slotSelectionMode,
        timeGranularityMinutes: row.timeGranularityMinutes,
        leadTimeMinutes: row.leadTimeMinutes,
        minLeadDays: row.minLeadDays,
        cutoffTime: row.cutoffTime,
        bookingHorizonDays: row.bookingHorizonDays,
        ...(v12 ? {} : { cutoffOffsetDays: row.cutoffOffsetDays }),
      },
      windows: deepCopy(row.windows),
      slots: deepCopy(row.slots),
      closures: deepCopy(row.closures),
    };
    if (v12) {
      configuration.preparation = {
        weekdays: [...v12.preparationWeekdays],
        closures: deepCopy(v12.preparationClosures),
      };
      configuration.holidays = {
        calendarId: v12.holidayCalendarId,
        preparationOnHolidays: v12.preparationOnHolidays,
        availabilityOnHolidays: v12.availabilityOnHolidays,
      };
      configuration.capacity = {
        enabled: v12.capacityEnabled,
        maxOrders: v12.capacityMaxOrders,
      };
    }
    return configuration;
  }

  /** Instantané comparable, pour prouver qu'un refus n'a rien changé. */
  snapshot(restaurantId: string): string {
    return JSON.stringify(this.tenant(restaurantId));
  }
}

/**
 * Fixture « Au Lait Cru » de l'issue #149 — NON GLOBALE, propre à cet
 * établissement : retrait du mardi au samedi, 11–14 et 16–20, dimanche
 * et lundi fermés, heure limite 16:00 la veille, et créneau SEULEMENT
 * (jamais d'heure précise). Les autres modes restent indépendants.
 */
export function auLaitCruPickupFixture(): FakeTenantState {
  const slots = [2, 3, 4, 5, 6].flatMap((weekday) => [
    { weekday, slotKey: "midi", startsAt: "11:00", endsAt: "14:00" },
    { weekday, slotKey: "soir", startsAt: "16:00", endsAt: "20:00" },
  ]);
  return {
    role: "owner",
    modes: ["pickup", "click_collect", "delivery"],
    rules: ["11111111-1111-1111-1111-111111111111"],
    schedules: [
      {
        modeCode: "pickup",
        fulfillmentRuleId: null,
        timezone: "Europe/Paris",
        enabled: true,
        dateSelectionMode: "customer_selectable",
        slotSelectionMode: "fixed_slots",
        timeGranularityMinutes: null,
        leadTimeMinutes: 0,
        minLeadDays: 1,
        cutoffTime: "16:00:00",
        cutoffOffsetDays: 1,
        bookingHorizonDays: 14,
        windows: [],
        slots,
        closures: [{ closedOn: "2026-12-25", label: "Noël" }],
        // Précision MICROSECONDE : six chiffres de fraction, dont les
        // trois derniers sont ceux qu'un passage par `Date` perdrait.
        updatedAt: "2026-10-14T00:00:00.123456Z",
        revision: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      },
    ],
    v12: [],
  };
}
