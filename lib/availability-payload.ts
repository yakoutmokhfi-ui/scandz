import type {
  MerchantFulfillmentSchedule,
  MerchantFulfillmentV12Extension,
} from "@/lib/dashboard-types";
import {
  DATE_MODE_CUSTOMER,
  DATE_MODE_INFORMATIONAL,
  SLOT_MODE_FIXED_SLOTS,
  SLOT_MODE_FREE_TIME,
  SLOT_MODE_NONE,
  scheduleMethodOf,
} from "@/lib/availability-editor";
import {
  CHECKOUT_DATE_SELECTION_MODES,
  CHECKOUT_SLOT_SELECTION_MODES,
  SCHEDULE_BOOKING_HORIZON_DAYS_MAX,
  SCHEDULE_CLOSURE_LABEL_MAX_LENGTH,
  SCHEDULE_CUTOFF_OFFSET_DAYS_MAX,
  SCHEDULE_LEAD_TIME_MINUTES_MAX,
  SCHEDULE_MIN_LEAD_DAYS_MAX,
  SCHEDULE_SLOT_KEY_MAX_LENGTH,
  SCHEDULE_TIME_GRANULARITY_MINUTES_MAX,
  SCHEDULE_TIME_GRANULARITY_MINUTES_MIN,
  isSchedulePolicyCoherent,
  isScheduleSlotKey,
  isScheduleWeekday,
  parseScheduleTime,
} from "@/lib/scheduling/schedule-model";

/**
 * SCANYM — CSDJ-BO-1 — BROUILLON D'ÉDITION ET CHARGE D'ÉCRITURE.
 *
 * CE MODULE EST UN MIROIR, JAMAIS UNE AUTORITÉ
 * -------------------------------------------
 * Il tient le BROUILLON que le commerçant manipule, et il sait en
 * construire la charge de l'unique écriture prévue par l'issue #149 :
 *
 *     save_fulfillment_configuration(p_restaurant_id, p_payload)
 *
 * « Sauvegarde atomique via save_fulfillment_configuration seulement,
 * no multi-RPC save » (issue #149). Les six actions existantes ne sont
 * donc appelées nulle part.
 *
 * La validation écrite ici REPRODUIT les refus du serveur pour les
 * rendre lisibles AVANT l'envoi — elle ne les remplace pas. Le serveur
 * revalide tout, et c'est lui qui fait foi : si les deux divergent, le
 * serveur a raison et son refus nommé s'affiche. Aucune éligibilité
 * n'est calculée ici, aucune horloge n'est lue.
 *
 * Les bornes et les grammaires viennent de lib/scheduling/schedule-model
 * (miroirs du SQL), jamais de littéraux retapés.
 */

export interface AvailabilityDraftWindow {
  /** Identité locale stable, pour les clés React et le retrait de ligne. */
  rowId: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityDraftSlot {
  rowId: string;
  weekday: number;
  slotKey: string;
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityDraftClosure {
  rowId: string;
  closedOn: string;
  label: string;
}

export interface AvailabilityDraft {
  /** Portée — jamais éditable : elle identifie la ligne, elle ne la décrit pas. */
  modeCode: string;
  fulfillmentRuleId: string | null;
  method: "v1" | "v1.2";
  /**
   * ═══ LES DEUX JETONS DE CONCURRENCE ═══
   *
   * Rendus par la lecture autoritaire
   * `get_fulfillment_configuration` et renvoyés TELS QUELS à
   * l'écriture, pour que le serveur REFUSE une écriture concurrente au
   * lieu de l'écraser (`CSDJBO1_STALE_CONFIGURATION`).
   *
   * `expectedUpdatedAt` : horodatage UTC à la MICROSECONDE. C'est une
   * chaîne, et elle reste une chaîne de bout en bout — jamais un `Date`,
   * jamais `toISOString()`. Le détour par `Date` tronque à la
   * milliseconde : `…T08:30:00.123456Z` deviendrait `…T08:30:00.123Z`,
   * le serveur ne reconnaîtrait plus la version lue, et toute
   * sauvegarde serait refusée pour un conflit qui n'existe pas.
   * (Remédiation contractuelle R1, §2.)
   *
   * `expectedRevision` : empreinte de contenu, 32 caractères
   * hexadécimaux. Les deux sont exigés ensemble : l'horodatage seul ne
   * distingue pas deux écritures dans la même microseconde, l'empreinte
   * seule ne dit pas laquelle est la plus récente.
   *
   * `null` pour les deux = portée encore absente en base (création).
   */
  expectedUpdatedAt: string | null;
  expectedRevision: string | null;

  /** Politique. Les champs numériques et horaires gardent la SAISIE
   *  (chaîne), convertie seulement à la construction de la charge :
   *  un champ vidé reste vide au lieu de devenir 0. */
  enabled: boolean;
  timezone: string;
  dateSelectionMode: string;
  slotSelectionMode: string;
  timeGranularityMinutes: string;
  leadTimeMinutes: string;
  minLeadDays: string;
  cutoffTime: string;
  cutoffOffsetDays: string;
  bookingHorizonDays: string;

  /** Calendrier client. */
  windows: AvailabilityDraftWindow[];
  slots: AvailabilityDraftSlot[];
  closures: AvailabilityDraftClosure[];

  /** Calendrier de préparation (méthode v1.2). */
  preparationWeekdays: number[];
  preparationClosures: AvailabilityDraftClosure[];

  /** Fériés : le calendrier n'est pas éditable d'ici (aucun catalogue). */
  holidayCalendarId: string | null;
  preparationOnHolidays: "open" | "closed";
  availabilityOnHolidays: "open" | "closed";

  /** Capacité. */
  capacityEnabled: boolean;
  capacityMaxOrders: string;
}

let rowCounter = 0;
/** Identité locale de ligne : ni envoyée, ni persistée. */
export function newRowId(prefix = "row"): string {
  rowCounter += 1;
  return `${prefix}-${rowCounter}`;
}

function hhmm(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 5);
}

/**
 * Brouillon issu de ce que le serveur a rendu. Pour une portée sans
 * ligne en base, les valeurs de départ sont celles que le SQL applique
 * par défaut — jamais des valeurs inventées : politique informative,
 * désactivée, horizon 14, aucun délai.
 */
export function draftFromServer(params: {
  modeCode: string;
  fulfillmentRuleId: string | null;
  schedule?: MerchantFulfillmentSchedule;
  extension?: MerchantFulfillmentV12Extension;
  timezone?: string;
  /** Chaîne verbatim de la lecture autoritaire — jamais reconstruite. */
  updatedAt?: string | null;
  /** Empreinte de contenu verbatim de la lecture autoritaire. */
  revision?: string | null;
}): AvailabilityDraft {
  const { schedule, extension } = params;
  return {
    modeCode: params.modeCode,
    fulfillmentRuleId: params.fulfillmentRuleId,
    method: scheduleMethodOf(extension),
    expectedUpdatedAt: params.updatedAt ?? null,
    expectedRevision: params.revision ?? null,
    enabled: schedule?.enabled ?? false,
    timezone: schedule?.timezone ?? params.timezone ?? "Europe/Paris",
    dateSelectionMode: schedule?.dateSelectionMode ?? DATE_MODE_INFORMATIONAL,
    slotSelectionMode: schedule?.slotSelectionMode ?? SLOT_MODE_NONE,
    timeGranularityMinutes:
      schedule?.timeGranularityMinutes === null ||
      schedule?.timeGranularityMinutes === undefined
        ? ""
        : String(schedule.timeGranularityMinutes),
    leadTimeMinutes: String(schedule?.leadTimeMinutes ?? 0),
    minLeadDays: String(schedule?.minLeadDays ?? 0),
    cutoffTime: hhmm(schedule?.cutoffTime),
    cutoffOffsetDays: String(schedule?.cutoffOffsetDays ?? 0),
    bookingHorizonDays: String(schedule?.bookingHorizonDays ?? 14),
    windows: (schedule?.windows ?? []).map((w) => ({
      rowId: newRowId("win"),
      weekday: w.weekday,
      startsAt: hhmm(w.startsAt),
      endsAt: hhmm(w.endsAt),
    })),
    slots: (schedule?.slots ?? []).map((s) => ({
      rowId: newRowId("slot"),
      weekday: s.weekday,
      slotKey: s.slotKey,
      startsAt: hhmm(s.startsAt),
      endsAt: hhmm(s.endsAt),
    })),
    closures: (schedule?.closures ?? []).map((c) => ({
      rowId: newRowId("clo"),
      closedOn: c.closedOn,
      label: c.label ?? "",
    })),
    preparationWeekdays: [...(extension?.preparationWeekdays ?? [])].sort((a, b) => a - b),
    preparationClosures: (extension?.preparationClosures ?? []).map((c) => ({
      rowId: newRowId("pclo"),
      closedOn: c.closedOn,
      label: c.label ?? "",
    })),
    holidayCalendarId: extension?.holidayCalendarId ?? null,
    preparationOnHolidays:
      extension?.preparationOnHolidays === "closed" ? "closed" : "open",
    availabilityOnHolidays:
      extension?.availabilityOnHolidays === "closed" ? "closed" : "open",
    capacityEnabled: extension?.capacityEnabled ?? false,
    capacityMaxOrders:
      extension?.capacityMaxOrders === null || extension?.capacityMaxOrders === undefined
        ? ""
        : String(extension.capacityMaxOrders),
  };
}

/**
 * ═══ LE SNAPSHOT AUTORITAIRE INDIVISIBLE ═══ (remédiation F-01)
 *
 *     { configuration, updatedAt, revision }
 *
 * Ces trois éléments décrivent UNE seule version du serveur, lue en UN
 * seul appel (`get_fulfillment_configuration`). Le brouillon, sa
 * référence (`baseline`) et les deux jetons de concurrence sont tous
 * construits ICI, à partir de cette seule réponse -- jamais une
 * configuration issue des lectures de listes à laquelle on collerait les
 * jetons d'une autre lecture.
 *
 * Pourquoi c'est la règle : si la lecture de listes rend A, qu'un tiers
 * produit B, puis que la lecture autoritaire rend B (jetons B), un
 * brouillon construit sur A mais signé des jetons de B passerait le
 * contrôle de concurrence du serveur et écraserait B sans bruit. Les
 * jetons ne valent que pour la configuration qui les a produits.
 *
 * Les jetons sont des CHAÎNES, recopiées telles qu'elles ont été reçues
 * (précision microseconde préservée).
 */
export class AuthoritativeSnapshotShapeError extends Error {
  constructor(detail: string) {
    super(`CSDJBO1_UNEXPECTED_CONFIGURATION_SHAPE: ${detail}`);
    this.name = "AuthoritativeSnapshotShapeError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function draftFromAuthoritativeSnapshot(snapshot: {
  tokens: { updatedAt: string; revision: string };
  configuration: Record<string, unknown>;
}): AvailabilityDraft {
  const { tokens, configuration: c } = snapshot;
  if (typeof tokens?.updatedAt !== "string" || typeof tokens?.revision !== "string") {
    throw new AuthoritativeSnapshotShapeError("jetons absents");
  }
  const policy = c.policy;
  if (!isRecord(policy)) throw new AuthoritativeSnapshotShapeError("policy absente");
  for (const list of ["windows", "slots", "closures"] as const) {
    if (!Array.isArray(c[list])) {
      throw new AuthoritativeSnapshotShapeError(`liste ${list} absente`);
    }
  }
  const method = c.method === "v1.2" ? "v1.2" : c.method === "v1" ? "v1" : null;
  if (method === null) throw new AuthoritativeSnapshotShapeError("méthode inconnue");
  if (typeof c.modeCode !== "string") throw new AuthoritativeSnapshotShapeError("mode absent");
  const text = (value: unknown, fallback = ""): string =>
    value === null || value === undefined ? fallback : String(value);

  const preparation = isRecord(c.preparation) ? c.preparation : null;
  const holidays = isRecord(c.holidays) ? c.holidays : null;
  const capacity = isRecord(c.capacity) ? c.capacity : null;
  if (method === "v1.2" && (!preparation || !holidays || !capacity)) {
    throw new AuthoritativeSnapshotShapeError("sections v1.2 absentes");
  }

  const rows = (value: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(value) ? value : []).filter(isRecord);

  return {
    modeCode: c.modeCode,
    fulfillmentRuleId: (c.fulfillmentRuleId ?? null) as string | null,
    method,
    expectedUpdatedAt: tokens.updatedAt,
    expectedRevision: tokens.revision,
    enabled: c.enabled === true,
    timezone: text(policy.timezone, "Europe/Paris"),
    dateSelectionMode: text(policy.dateSelectionMode, DATE_MODE_INFORMATIONAL),
    slotSelectionMode: text(policy.slotSelectionMode, SLOT_MODE_NONE),
    timeGranularityMinutes: text(policy.timeGranularityMinutes),
    leadTimeMinutes: text(policy.leadTimeMinutes, "0"),
    minLeadDays: text(policy.minLeadDays, "0"),
    cutoffTime: hhmm(policy.cutoffTime == null ? null : String(policy.cutoffTime)),
    cutoffOffsetDays: text(policy.cutoffOffsetDays, "0"),
    bookingHorizonDays: text(policy.bookingHorizonDays, "14"),
    windows: rows(c.windows).map((w) => ({
      rowId: newRowId("win"),
      weekday: Number(w.weekday),
      startsAt: hhmm(text(w.startsAt)),
      endsAt: hhmm(text(w.endsAt)),
    })),
    slots: rows(c.slots).map((slot) => ({
      rowId: newRowId("slot"),
      weekday: Number(slot.weekday),
      slotKey: text(slot.slotKey),
      startsAt: hhmm(text(slot.startsAt)),
      endsAt: hhmm(text(slot.endsAt)),
    })),
    closures: rows(c.closures).map((cl) => ({
      rowId: newRowId("clo"),
      closedOn: text(cl.closedOn),
      label: text(cl.label),
    })),
    preparationWeekdays: (Array.isArray(preparation?.weekdays) ? preparation.weekdays : [])
      .map((d: unknown) => Number(d))
      .sort((a: number, b: number) => a - b),
    preparationClosures: rows(preparation?.closures).map((cl) => ({
      rowId: newRowId("pclo"),
      closedOn: text(cl.closedOn),
      label: text(cl.label),
    })),
    holidayCalendarId: (holidays?.calendarId ?? null) as string | null,
    preparationOnHolidays: holidays?.preparationOnHolidays === "closed" ? "closed" : "open",
    availabilityOnHolidays: holidays?.availabilityOnHolidays === "closed" ? "closed" : "open",
    capacityEnabled: capacity?.enabled === true,
    capacityMaxOrders: text(capacity?.maxOrders),
  };
}

/** Comparable : identités de ligne retirées, listes ordonnées. */
function comparable(draft: AvailabilityDraft): string {
  const sortRows = <T extends { rowId: string }>(rows: T[]) =>
    rows
      .map(({ rowId, ...rest }) => {
        void rowId;
        return rest;
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    ...draft,
    // Les jetons de concurrence ne sont pas des réglages : leur
    // rafraîchissement ne doit JAMAIS compter comme une modification du
    // commerçant, ni rendre un brouillon « modifié » tout seul.
    expectedUpdatedAt: null,
    expectedRevision: null,
    windows: sortRows(draft.windows),
    slots: sortRows(draft.slots),
    closures: sortRows(draft.closures),
    preparationClosures: sortRows(draft.preparationClosures),
    preparationWeekdays: [...draft.preparationWeekdays].sort((a, b) => a - b),
  });
}

export function isDraftDirty(draft: AvailabilityDraft, baseline: AvailabilityDraft): boolean {
  return comparable(draft) !== comparable(baseline);
}

/** Nombre de différences lisible pour la barre d'enregistrement. */
export function draftChangeCount(
  draft: AvailabilityDraft,
  baseline: AvailabilityDraft
): number {
  let count = 0;
  const scalarKeys: Array<keyof AvailabilityDraft> = [
    "enabled",
    "timezone",
    "dateSelectionMode",
    "slotSelectionMode",
    "timeGranularityMinutes",
    "leadTimeMinutes",
    "minLeadDays",
    "cutoffTime",
    "cutoffOffsetDays",
    "bookingHorizonDays",
    "preparationOnHolidays",
    "availabilityOnHolidays",
    "capacityEnabled",
    "capacityMaxOrders",
  ];
  for (const key of scalarKeys) {
    if (draft[key] !== baseline[key]) count += 1;
  }
  const listKeys: Array<"windows" | "slots" | "closures" | "preparationClosures"> = [
    "windows",
    "slots",
    "closures",
    "preparationClosures",
  ];
  for (const key of listKeys) {
    const a = comparable({ ...baseline, [key]: draft[key] } as AvailabilityDraft);
    const b = comparable(baseline);
    if (a !== b) count += 1;
  }
  if (
    [...draft.preparationWeekdays].sort().join(",") !==
    [...baseline.preparationWeekdays].sort().join(",")
  ) {
    count += 1;
  }
  return count;
}

// ====================================================================
// CONFLIT DE CONCURRENCE (remédiation F-01) — deux versions SÉPARÉES
// ====================================================================

/**
 * Les réglages qu'un conflit peut opposer. Un « champ » est l'unité que
 * le commerçant comprend et que le serveur remplace : un réglage, ou une
 * liste entière (le contrat remplace les listes en bloc).
 */
export const DIVERGENCE_FIELDS = [
  "enabled",
  "timezone",
  "dateSelectionMode",
  "slotSelectionMode",
  "timeGranularityMinutes",
  "leadTimeMinutes",
  "minLeadDays",
  "cutoffTime",
  "cutoffOffsetDays",
  "bookingHorizonDays",
  "windows",
  "slots",
  "closures",
  "preparationWeekdays",
  "preparationClosures",
  "holidayCalendarId",
  "preparationOnHolidays",
  "availabilityOnHolidays",
  "capacityEnabled",
  "capacityMaxOrders",
] as const;

export type DivergenceField = (typeof DIVERGENCE_FIELDS)[number];

/** Valeur comparable d'un champ : sans identité de ligne, listes ordonnées. */
function fieldSignature(draft: AvailabilityDraft, field: DivergenceField): string {
  const stripRows = <T extends { rowId: string }>(rows: T[]) =>
    rows
      .map(({ rowId, ...rest }) => {
        void rowId;
        return JSON.stringify(rest);
      })
      .sort();
  switch (field) {
    case "windows":
    case "slots":
    case "closures":
    case "preparationClosures":
      return JSON.stringify(stripRows(draft[field] as Array<{ rowId: string }>));
    case "preparationWeekdays":
      return JSON.stringify([...draft.preparationWeekdays].sort((a, b) => a - b));
    default:
      return JSON.stringify(draft[field] ?? null);
  }
}

export type DivergenceOrigin =
  /** Vous seul l'avez changé depuis votre lecture. */
  | "mine"
  /** Seul le serveur l'a changé depuis votre lecture. */
  | "theirs"
  /** Les deux l'ont changé, différemment : un VRAI conflit. */
  | "both";

export interface DraftDivergence {
  field: DivergenceField;
  origin: DivergenceOrigin;
}

/**
 * Compare, champ par champ, vos modifications locales (`mine`, comparées
 * à la version que vous aviez lue, `base`) et la version du serveur
 * (`theirs`). Ne rend que les champs sur lesquels `mine` et `theirs`
 * DIFFÈRENT -- ce que le commerçant doit voir avant de choisir.
 */
export function diffDrafts(
  base: AvailabilityDraft,
  mine: AvailabilityDraft,
  theirs: AvailabilityDraft
): DraftDivergence[] {
  const out: DraftDivergence[] = [];
  for (const field of DIVERGENCE_FIELDS) {
    const m = fieldSignature(mine, field);
    const t = fieldSignature(theirs, field);
    if (m === t) continue;
    const b = fieldSignature(base, field);
    const mineChanged = m !== b;
    const theirsChanged = t !== b;
    out.push({
      field,
      origin: mineChanged && theirsChanged ? "both" : mineChanged ? "mine" : "theirs",
    });
  }
  return out;
}

/**
 * REBASE CONFIRMÉ : vos modifications, appliquées sur la version du
 * serveur. Champ par champ : ce que VOUS avez changé depuis votre lecture
 * est conservé (y compris dans un vrai conflit -- c'est le geste
 * explicite du commerçant, qui l'a vu nommé) ; tout le reste vient du
 * serveur, donc les modifications du tiers sur des champs que vous
 * n'avez pas touchés SURVIVENT. Les jetons, la méthode et la portée sont
 * ceux du serveur : ils décrivent la version sur laquelle on se rebase.
 *
 * Cette fonction ne s'appelle QUE sur un geste de confirmation. Elle ne
 * déclenche aucun enregistrement : le brouillon rebasé reste à
 * enregistrer, par un second geste.
 */
export function rebaseDraft(
  base: AvailabilityDraft,
  mine: AvailabilityDraft,
  theirs: AvailabilityDraft
): AvailabilityDraft {
  const next: AvailabilityDraft = {
    ...theirs,
    // Copies de ligne neuves : les identités locales restent uniques.
    windows: theirs.windows.map((r) => ({ ...r })),
    slots: theirs.slots.map((r) => ({ ...r })),
    closures: theirs.closures.map((r) => ({ ...r })),
    preparationWeekdays: [...theirs.preparationWeekdays],
    preparationClosures: theirs.preparationClosures.map((r) => ({ ...r })),
  };
  const target = next as unknown as Record<string, unknown>;
  const source = mine as unknown as Record<string, unknown>;
  for (const field of DIVERGENCE_FIELDS) {
    if (fieldSignature(mine, field) === fieldSignature(base, field)) continue;
    const value = source[field];
    target[field] = Array.isArray(value)
      ? value.map((item) => (item !== null && typeof item === "object" ? { ...item } : item))
      : value;
  }
  return next;
}

/**
 * Refus NOMMÉS, reproduits du serveur. Chaque code correspond à un refus
 * réel du contrat (voir docs/scheduling/csdj-bo1-write-contract-request.md
 * et les refus CSDJ1_/CSDJ12_ déjà publiés) : l'interface les affiche
 * avant l'envoi pour éviter un aller-retour, jamais pour se substituer
 * au serveur.
 */
export type AvailabilityIssueCode =
  | "timezone_missing"
  | "policy_incoherent"
  | "policy_unknown"
  | "granularity_missing"
  | "granularity_range"
  | "lead_days_range"
  | "lead_minutes_range"
  | "horizon_range"
  | "cutoff_invalid"
  | "cutoff_offset_removed"
  | "window_order"
  | "window_overlap"
  | "window_weekday"
  | "slot_order"
  | "slot_key_invalid"
  | "slot_duplicate"
  | "closure_date_invalid"
  | "closure_duplicate"
  | "closure_label_too_long"
  | "too_many_closures"
  | "too_many_windows"
  | "too_many_slots"
  | "preparation_missing"
  | "preparation_weekday_invalid"
  | "holiday_policy_needs_calendar"
  | "capacity_invalid"
  | "capacity_needs_date"
  | "offer_missing";

export interface AvailabilityIssue {
  code: AvailabilityIssueCode;
  /** Section concernée, pour afficher le refus au bon endroit. */
  section: "policy" | "offers" | "closures" | "preparation" | "holidays" | "capacity";
  /** Ligne concernée, quand le refus porte sur une ligne. */
  rowId?: string;
  weekday?: number;
}

/**
 * Bornes de LISTE du contrat Boulez (remédiation R1, §3) : 100 fenêtres,
 * 200 créneaux, 731 fermetures. Elles sont vérifiées ici pour que le
 * commerçant lise la borne au lieu de recevoir un refus serveur après
 * coup — le serveur reste l'autorité.
 */
const MAX_WINDOWS = 100;
const MAX_SLOTS = 200;
const MAX_CLOSURES = 731;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Empreinte de contenu du contrat : 32 caractères hexadécimaux. */
export const REVISION_PATTERN = /^[0-9a-f]{32}$/;

function intOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^-?\d+$/.test(trimmed)) return Number.NaN;
  return Number.parseInt(trimmed, 10);
}

function validateClosures(
  rows: AvailabilityDraftClosure[],
  section: "closures" | "preparation"
): AvailabilityIssue[] {
  const issues: AvailabilityIssue[] = [];
  if (rows.length > MAX_CLOSURES) issues.push({ code: "too_many_closures", section });
  const seen = new Set<string>();
  for (const row of rows) {
    if (!ISO_DATE.test(row.closedOn) || Number.isNaN(Date.parse(row.closedOn))) {
      issues.push({ code: "closure_date_invalid", section, rowId: row.rowId });
      continue;
    }
    if (seen.has(row.closedOn)) {
      issues.push({ code: "closure_duplicate", section, rowId: row.rowId });
    }
    seen.add(row.closedOn);
    if (row.label.trim().length > SCHEDULE_CLOSURE_LABEL_MAX_LENGTH) {
      issues.push({ code: "closure_label_too_long", section, rowId: row.rowId });
    }
  }
  return issues;
}

/**
 * Valide le brouillon et rend la LISTE des refus, jamais un simple
 * booléen : le commerçant doit savoir lequel de ses réglages bloque, et
 * où. Un brouillon sans refus n'est pas pour autant accepté d'avance —
 * le serveur reste l'autorité.
 */
export function validateDraft(draft: AvailabilityDraft): AvailabilityIssue[] {
  const issues: AvailabilityIssue[] = [];

  if (draft.timezone.trim() === "") {
    issues.push({ code: "timezone_missing", section: "policy" });
  }
  if (
    !CHECKOUT_DATE_SELECTION_MODES.includes(draft.dateSelectionMode as never) ||
    !CHECKOUT_SLOT_SELECTION_MODES.includes(draft.slotSelectionMode as never)
  ) {
    issues.push({ code: "policy_unknown", section: "policy" });
  } else if (
    !isSchedulePolicyCoherent(draft.dateSelectionMode as never, draft.slotSelectionMode as never)
  ) {
    // Le serveur l'interdit par contrainte : choisir une heure exige que
    // le client choisisse déjà sa date.
    issues.push({ code: "policy_incoherent", section: "policy" });
  }

  const minLeadDays = intOrNull(draft.minLeadDays);
  if (
    minLeadDays === null ||
    Number.isNaN(minLeadDays) ||
    minLeadDays < 0 ||
    minLeadDays > SCHEDULE_MIN_LEAD_DAYS_MAX
  ) {
    issues.push({ code: "lead_days_range", section: "policy" });
  }
  const leadMinutes = intOrNull(draft.leadTimeMinutes);
  if (
    leadMinutes === null ||
    Number.isNaN(leadMinutes) ||
    leadMinutes < 0 ||
    leadMinutes > SCHEDULE_LEAD_TIME_MINUTES_MAX
  ) {
    issues.push({ code: "lead_minutes_range", section: "policy" });
  }
  const horizon = intOrNull(draft.bookingHorizonDays);
  if (
    horizon === null ||
    Number.isNaN(horizon) ||
    horizon < 0 ||
    horizon > SCHEDULE_BOOKING_HORIZON_DAYS_MAX
  ) {
    issues.push({ code: "horizon_range", section: "policy" });
  }

  if (draft.cutoffTime.trim() !== "" && parseScheduleTime(draft.cutoffTime) === null) {
    // Couvre les secondes, 24:00 et toute heure illisible.
    issues.push({ code: "cutoff_invalid", section: "policy" });
  }

  const offset = intOrNull(draft.cutoffOffsetDays);
  if (draft.method === "v1.2") {
    if (offset !== 0) issues.push({ code: "cutoff_offset_removed", section: "policy" });
  } else if (
    offset === null ||
    Number.isNaN(offset) ||
    offset < 0 ||
    offset > SCHEDULE_CUTOFF_OFFSET_DAYS_MAX
  ) {
    issues.push({ code: "lead_days_range", section: "policy" });
  }

  if (draft.slotSelectionMode === SLOT_MODE_FREE_TIME) {
    const granularity = intOrNull(draft.timeGranularityMinutes);
    if (granularity === null) {
      issues.push({ code: "granularity_missing", section: "policy" });
    } else if (
      Number.isNaN(granularity) ||
      granularity < SCHEDULE_TIME_GRANULARITY_MINUTES_MIN ||
      granularity > SCHEDULE_TIME_GRANULARITY_MINUTES_MAX
    ) {
      issues.push({ code: "granularity_range", section: "policy" });
    }
  }

  // ── Calendrier client ────────────────────────────────────────────
  if (draft.windows.length > MAX_WINDOWS) {
    issues.push({ code: "too_many_windows", section: "offers" });
  }
  if (draft.slots.length > MAX_SLOTS) {
    issues.push({ code: "too_many_slots", section: "offers" });
  }
  for (const row of draft.windows) {
    if (!isScheduleWeekday(row.weekday)) {
      issues.push({ code: "window_weekday", section: "offers", rowId: row.rowId });
      continue;
    }
    const start = parseScheduleTime(row.startsAt);
    const end = parseScheduleTime(row.endsAt);
    if (start === null || end === null || end <= start) {
      issues.push({ code: "window_order", section: "offers", rowId: row.rowId });
    }
  }
  // Non-superposition, par jour — même règle que le serveur, vérifiée
  // APRÈS le reste pour ne pas masquer une plage mal bornée.
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const dayRows = draft.windows
      .filter((w) => w.weekday === weekday)
      .map((w) => ({
        rowId: w.rowId,
        start: parseScheduleTime(w.startsAt),
        end: parseScheduleTime(w.endsAt),
      }))
      .filter((w) => w.start !== null && w.end !== null && (w.end as number) > (w.start as number))
      .sort((a, b) => (a.start as number) - (b.start as number));
    for (let i = 1; i < dayRows.length; i += 1) {
      if ((dayRows[i].start as number) < (dayRows[i - 1].end as number)) {
        issues.push({
          code: "window_overlap",
          section: "offers",
          rowId: dayRows[i].rowId,
          weekday,
        });
      }
    }
  }

  const slotSeen = new Set<string>();
  for (const row of draft.slots) {
    if (!isScheduleWeekday(row.weekday)) {
      issues.push({ code: "window_weekday", section: "offers", rowId: row.rowId });
      continue;
    }
    if (!isScheduleSlotKey(row.slotKey) || row.slotKey.length > SCHEDULE_SLOT_KEY_MAX_LENGTH) {
      issues.push({ code: "slot_key_invalid", section: "offers", rowId: row.rowId });
    }
    const start = parseScheduleTime(row.startsAt);
    const end = parseScheduleTime(row.endsAt);
    if (start === null || end === null || end <= start) {
      issues.push({ code: "slot_order", section: "offers", rowId: row.rowId });
    }
    const identity = `${row.weekday}:${row.slotKey}`;
    if (slotSeen.has(identity)) {
      issues.push({ code: "slot_duplicate", section: "offers", rowId: row.rowId });
    }
    slotSeen.add(identity);
  }

  issues.push(...validateClosures(draft.closures, "closures"));
  issues.push(...validateClosures(draft.preparationClosures, "preparation"));

  // ── Méthode v1.2 ────────────────────────────────────────────────
  if (draft.method === "v1.2") {
    for (const weekday of draft.preparationWeekdays) {
      if (!isScheduleWeekday(weekday)) {
        issues.push({ code: "preparation_weekday_invalid", section: "preparation" });
      }
    }
    if (draft.preparationWeekdays.length === 0) {
      // Un calendrier de préparation vide n'est pas « tous les jours ».
      issues.push({ code: "preparation_missing", section: "preparation" });
    }
  }

  if (
    draft.holidayCalendarId === null &&
    (draft.preparationOnHolidays === "closed" || draft.availabilityOnHolidays === "closed")
  ) {
    issues.push({ code: "holiday_policy_needs_calendar", section: "holidays" });
  }

  if (draft.capacityEnabled) {
    const max = intOrNull(draft.capacityMaxOrders);
    if (max === null || Number.isNaN(max) || max < 1) {
      issues.push({ code: "capacity_invalid", section: "capacity" });
    }
    if (draft.dateSelectionMode === DATE_MODE_INFORMATIONAL) {
      issues.push({ code: "capacity_needs_date", section: "capacity" });
    }
  }

  // ── Publication : l'activation est VALIDÉE, pas déclarée ────────
  if (draft.enabled && draft.dateSelectionMode !== DATE_MODE_INFORMATIONAL) {
    const usesSlots = draft.slotSelectionMode === SLOT_MODE_FIXED_SLOTS;
    if (usesSlots ? draft.slots.length === 0 : draft.windows.length === 0) {
      issues.push({ code: "offer_missing", section: "offers" });
    }
  }

  return issues;
}

/**
 * ═══ LE REPLI EN BROUILLON ═══ (remédiation R1, §4)
 *
 * Le contrat demande, sur `CSDJBO1_INCOMPLETE_CONFIGURATION`, d'afficher
 * les éléments manquants et de **proposer d'enregistrer en brouillon,
 * après confirmation de l'utilisateur**. Un brouillon est exactement la
 * même configuration avec `enabled: false` : elle est conservée, elle ne
 * propose simplement aucune date au client — ce qui, pour lui, est
 * l'état d'avant, jamais une erreur.
 *
 * Et le contrat insiste : « même en brouillon, une capacité activée sans
 * maximum valide, une capacité sans date ou une grille horaire
 * incohérente doivent rester refusées ». C'est ce que rend
 * `issuesBlockingDraft` : les refus qui SUBSISTENT quand on retire
 * l'activation. Aucun catalogue parallèle n'est écrit pour cela — on
 * revalide la configuration désactivée avec la MÊME fonction, ce qui
 * garantit qu'un refus futur sera pris en compte ici sans y penser.
 */
export function draftAsInactive(draft: AvailabilityDraft): AvailabilityDraft {
  return { ...draft, enabled: false };
}

export function issuesBlockingDraft(draft: AvailabilityDraft): AvailabilityIssue[] {
  return validateDraft(draftAsInactive(draft));
}

/**
 * Le repli est-il proposable ? Oui si, et seulement si : l'activation est
 * demandée, la configuration activée est refusée, et la MÊME
 * configuration désactivée ne l'est plus. Jamais automatique : la page
 * ne fait que proposer, le commerçant confirme.
 */
export function canFallBackToDraft(draft: AvailabilityDraft): boolean {
  return (
    draft.enabled &&
    validateDraft(draft).length > 0 &&
    issuesBlockingDraft(draft).length === 0
  );
}

const ISSUE_KEYS: Record<AvailabilityIssueCode, string> = {
  timezone_missing: "avIssueTimezoneMissing",
  policy_incoherent: "avIssuePolicyIncoherent",
  policy_unknown: "avIssuePolicyUnknown",
  granularity_missing: "avIssueGranularityMissing",
  granularity_range: "avIssueGranularityRange",
  lead_days_range: "avIssueLeadDaysRange",
  lead_minutes_range: "avIssueLeadMinutesRange",
  horizon_range: "avIssueHorizonRange",
  cutoff_invalid: "avIssueCutoffInvalid",
  cutoff_offset_removed: "avIssueCutoffOffsetRemoved",
  window_order: "avIssueWindowOrder",
  window_overlap: "avIssueWindowOverlap",
  window_weekday: "avIssueWindowWeekday",
  slot_order: "avIssueSlotOrder",
  slot_key_invalid: "avIssueSlotKeyInvalid",
  slot_duplicate: "avIssueSlotDuplicate",
  closure_date_invalid: "avIssueClosureDateInvalid",
  closure_duplicate: "avIssueClosureDuplicate",
  closure_label_too_long: "avIssueClosureLabelTooLong",
  too_many_closures: "avIssueTooManyClosures",
  too_many_windows: "avIssueTooManyWindows",
  too_many_slots: "avIssueTooManySlots",
  preparation_missing: "avIssuePreparationMissing",
  preparation_weekday_invalid: "avIssuePreparationWeekdayInvalid",
  holiday_policy_needs_calendar: "avIssueHolidayPolicyNeedsCalendar",
  capacity_invalid: "avIssueCapacityInvalid",
  capacity_needs_date: "avIssueCapacityNeedsDate",
  offer_missing: "avIssueOfferMissing",
};

export function issueKey(code: AvailabilityIssueCode): string {
  return ISSUE_KEYS[code];
}

/**
 * LA charge de l'unique écriture. Sa forme suit le contrat de Boulez
 * (`docs/scheduling/csdj-bo1-save-fulfillment-configuration-contract.md`,
 * PR #151, commit `de460056…`), relayé par la remédiation R1 : si le
 * schéma final diffère encore, c'est CETTE fonction qui change, et elle
 * seule.
 *
 * Règles tenues ici :
 *   - l'état VOULU en entier, jamais un delta ;
 *   - les TROIS listes sont toujours fournies, **même vides** — une
 *     liste absente ne veut pas dire « inchangée », elle n'a pas de
 *     sens dans un remplacement intégral ;
 *   - les deux jetons de concurrence sont toujours fournis, `null`
 *     compris : `null` dit « cette portée n'existait pas », ce qu'une
 *     clé absente ne dirait pas ;
 *   - un champ vide devient `null`, jamais 0 ni "" ;
 *   - méthode `v1` : `preparation`, `holidays` et `capacity` sont
 *     ABSENTES, et `policy.cutoffOffsetDays` est fourni (0 à 30) ;
 *   - méthode `v1.2` : les trois sections sont EXIGÉES, et
 *     `policy.cutoffOffsetDays` est ABSENT — la v1.2 déplace l'origine
 *     au prochain jour de préparation au lieu de décaler en jours, donc
 *     le champ n'a pas de valeur neutre à envoyer. Le serveur refuse
 *     l'inverse dans les deux sens (`CSDJBO1_METHOD_MISMATCH`) ;
 *   - les identités de ligne locales ne sont pas envoyées ;
 *   - aucun compte de capacité, aucune donnée dérivée.
 */
export function buildSaveFulfillmentConfigurationPayload(
  draft: AvailabilityDraft
): Record<string, unknown> {
  const numberOrNull = (value: string): number | null => {
    const parsed = intOrNull(value);
    return parsed === null || Number.isNaN(parsed) ? null : parsed;
  };

  const policy: Record<string, unknown> = {
    timezone: draft.timezone,
    dateSelectionMode: draft.dateSelectionMode,
    slotSelectionMode: draft.slotSelectionMode,
    timeGranularityMinutes:
      draft.slotSelectionMode === SLOT_MODE_FREE_TIME
        ? numberOrNull(draft.timeGranularityMinutes)
        : null,
    leadTimeMinutes: numberOrNull(draft.leadTimeMinutes) ?? 0,
    minLeadDays: numberOrNull(draft.minLeadDays) ?? 0,
    cutoffTime: draft.cutoffTime.trim() === "" ? null : draft.cutoffTime.trim(),
    bookingHorizonDays: numberOrNull(draft.bookingHorizonDays) ?? 0,
  };
  if (draft.method !== "v1.2") {
    policy.cutoffOffsetDays = numberOrNull(draft.cutoffOffsetDays) ?? 0;
  }

  const payload: Record<string, unknown> = {
    modeCode: draft.modeCode,
    fulfillmentRuleId: draft.fulfillmentRuleId,
    method: draft.method,
    enabled: draft.enabled,
    // Les deux jetons, toujours présents — voir le commentaire de
    // `expectedUpdatedAt` sur `AvailabilityDraft` : des CHAÎNES, rendues
    // telles qu'elles ont été reçues, jamais reconstruites.
    expectedUpdatedAt: draft.expectedUpdatedAt,
    expectedRevision: draft.expectedRevision,
    policy,
    windows: draft.windows
      .slice()
      .sort((a, b) => a.weekday - b.weekday || a.startsAt.localeCompare(b.startsAt))
      .map((w, index) => ({
        weekday: w.weekday,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        displayOrder: index,
      })),
    slots: draft.slots
      .slice()
      .sort(
        (a, b) =>
          a.weekday - b.weekday ||
          a.startsAt.localeCompare(b.startsAt) ||
          a.slotKey.localeCompare(b.slotKey)
      )
      .map((s, index) => ({
        weekday: s.weekday,
        slotKey: s.slotKey,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        displayOrder: index,
      })),
    closures: draft.closures
      .slice()
      .sort((a, b) => a.closedOn.localeCompare(b.closedOn))
      .map((c) => ({
        closedOn: c.closedOn,
        label: c.label.trim() === "" ? null : c.label.trim(),
      })),
  };

  if (draft.method === "v1.2") {
    payload.preparation = {
      weekdays: [...draft.preparationWeekdays].sort((a, b) => a - b),
      closures: draft.preparationClosures
        .slice()
        .sort((a, b) => a.closedOn.localeCompare(b.closedOn))
        .map((c) => ({
          closedOn: c.closedOn,
          label: c.label.trim() === "" ? null : c.label.trim(),
        })),
    };
    payload.holidays = {
      calendarId: draft.holidayCalendarId,
      preparationOnHolidays: draft.preparationOnHolidays,
      availabilityOnHolidays: draft.availabilityOnHolidays,
    };
    payload.capacity = {
      enabled: draft.capacityEnabled,
      maxOrders: draft.capacityEnabled ? numberOrNull(draft.capacityMaxOrders) : null,
    };
  }

  return payload;
}

/**
 * ═══ REFUS SERVEUR → PHRASE ═══ (remédiation R1, §4)
 *
 * Le contrat impose la façon de lire un refus : « extraire les codes
 * métiers du préfixe du message serveur, AVANT le premier `:` ». Un
 * message de refus a donc la forme `CODE: détail libre`, et seul le
 * préfixe est une donnée ; le détail est du texte de serveur, qui peut
 * contenir un nom de table, un `SQLSTATE`, un `DETAIL`, un `HINT` — et
 * qui ne doit JAMAIS atteindre le commerçant.
 *
 * C'est pourquoi ce module ne rend jamais un message : il rend une CLÉ
 * i18n. Le détail n'est pas nettoyé, il n'est pas lu du tout.
 *
 * Catalogue FERMÉ, par égalité exacte du code — pas par sous-chaîne : un
 * code inconnu obtient la phrase de repli générique, jamais une phrase
 * voisine choisie par une coïncidence de préfixe.
 */
const SERVER_REFUSAL_KEYS: Record<string, string> = {
  // Refus propres au contrat CSDJ-BO-1.
  CSDJBO1_INCOMPLETE_CONFIGURATION: "avSaveIncomplete",
  CSDJBO1_STALE_CONFIGURATION: "avSaveStale",
  CSDJBO1_METHOD_MISMATCH: "avSaveMethodMismatch",
  // Panne interne du post-contrôle serveur : message GÉNÉRIQUE, aucun
  // détail technique, et surtout aucune accusation d'un réglage du
  // commerçant — ce n'est pas lui qui a tort.
  SCANYM_CSDJBO1_POSTCHECK: "avSavePostcheck",
  // Autorité et portée (CSDJ-1).
  CSDJ1_AUTH_REQUIRED: "avAuthRequired",
  CSDJ12_AUTH_REQUIRED: "avAuthRequired",
  CSDJ1_FORBIDDEN: "avSaveForbidden",
  CSDJ12_FORBIDDEN: "avSaveForbidden",
  CSDJ1_UNKNOWN_MODE: "avSaveUnknownMode",
  CSDJ12_UNKNOWN_MODE: "avSaveUnknownMode",
  CSDJ1_FOREIGN_RULE: "avSaveForeignRule",
  CSDJ12_FOREIGN_RULE: "avSaveForeignRule",
  CSDJ1_RESERVED_RULE_ID: "avSaveForeignRule",
  CSDJ12_RESERVED_RULE_ID: "avSaveForeignRule",
  // Réglages.
  CSDJ1_INVALID_TIMEZONE: "avIssueTimezoneMissing",
  CSDJ12_INVALID_TIMEZONE: "avIssueTimezoneMissing",
  CSDJ1_INVALID_POLICY: "avIssuePolicyUnknown",
  CSDJ12_INVALID_POLICY: "avIssuePolicyUnknown",
  CSDJ1_SUBMINUTE_TIME: "avIssueCutoffInvalid",
  CSDJ12_SUBMINUTE_TIME: "avIssueCutoffInvalid",
  CSDJ1_WINDOW_OVERLAP: "avIssueWindowOverlap",
  CSDJ1_TOO_MANY_WINDOWS: "avIssueTooManyWindows",
  CSDJ1_TOO_MANY_SLOTS: "avIssueTooManySlots",
  CSDJ1_TOO_MANY_CLOSURES: "avIssueTooManyClosures",
  CSDJ12_CUTOFF_OFFSET_REMOVED: "avIssueCutoffOffsetRemoved",
  CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR: "avIssueHolidayPolicyNeedsCalendar",
  CSDJ12_INVALID_HOLIDAY_POLICY: "avIssueHolidayPolicyNeedsCalendar",
  CSDJ12_INVALID_CAPACITY: "avIssueCapacityInvalid",
  CSDJ12_CAPACITY_NEEDS_DATE: "avIssueCapacityNeedsDate",
  CSDJ12_TOO_MANY_CLOSURES: "avIssueTooManyClosures",
  CSDJ12_INVALID_WEEKDAY: "avIssuePreparationWeekdayInvalid",
};

/** Forme d'un code métier : majuscules, chiffres et soulignements. */
const REFUSAL_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Le code métier d'un refus, ou `null`. Lit le PRÉFIXE avant le premier
 * `:`, comme le contrat l'exige, et n'accepte que ce qui a la forme d'un
 * code — un message serveur qui commencerait par de la prose n'en
 * produit aucun, plutôt qu'un faux code.
 *
 * Exporté pour que l'appelant puisse DÉCIDER selon le refus (relire la
 * version serveur sur `CSDJBO1_STALE_CONFIGURATION`, proposer le
 * brouillon sur `CSDJBO1_INCOMPLETE_CONFIGURATION`) sans jamais
 * manipuler le texte du message.
 */
export function serverRefusalCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const prefix = message.split(":", 1)[0]?.trim() ?? "";
  return REFUSAL_CODE_PATTERN.test(prefix) ? prefix : null;
}

export function saveErrorKey(error: unknown): string {
  const code = serverRefusalCode(error);
  if (code !== null && Object.prototype.hasOwnProperty.call(SERVER_REFUSAL_KEYS, code)) {
    return SERVER_REFUSAL_KEYS[code];
  }
  return "avSaveFailed";
}
