// ====================================================================
// CSDJ2-R4-01 / revue systématique (PR #160) -- OUTILS PARTAGÉS des tests
// de la frontière RPC (réponse BRUTE de `get_checkout_fulfillment_schedule`).
//
// Ce module n'importe RIEN du code de production : l'ORACLE ci-dessous est
// écrit à part, depuis le contrat CSDJ v1.2 (§5.1) et le SQL source du lecteur
// (supabase/DRAFT-lot-checkout-scheduling-foundation-v1.sql), pour que le test
// ne reprenne pas les hypothèses du code qu'il vérifie.
//
// RÈGLES DE L'ORACLE (décisions assumées, voir le rapport §13) :
//  - `data` = exactement UNE ligne, objet simple ;
//  - statut dans le catalogue fermé de 5 valeurs ;
//  - absent / blocked_upstream / informational_only / unfulfillable : aucun
//    champ date ni offre ne les accompagne (le SQL rend NULL) ; sinon fermé ;
//  - dates_available : TOUS les champs consommés sont du bon TYPE (jamais de
//    coercition), politiques connues et cohérentes, dates réelles et uniques,
//    `first_eligible_date` = première date, offres exactement pour les dates
//    éligibles, heures HH:MM strictes avec fin > début, clés cohérentes avec la
//    politique, pas de doublon de clé, pas de fenêtres qui se chevauchent.
// ====================================================================

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export const STATUSES = ["absent", "blocked_upstream", "informational_only", "dates_available", "unfulfillable"] as const;

export type RefClass = "closed" | "none" | "blocked" | "derived" | "choose";
export interface RefVerdict {
  cls: RefClass;
  slotMode?: "none" | "fixed_slots" | "time_within_window";
  /** Payload attendu pour une sélection donnée, calculé UNIQUEMENT depuis la réponse brute. */
  derivedDate?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const nullish = (v: unknown) => v === null || v === undefined;

export function realDate(v: unknown): v is string {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
export const strictTime = (v: unknown): v is string => isStr(v) && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const CLOSED: RefVerdict = { cls: "closed" };

export function refVerdict(data: unknown): RefVerdict {
  if (!Array.isArray(data) || data.length !== 1) return CLOSED;
  const r = data[0];
  if (!isObj(r)) return CLOSED;
  const st = r.schedule_status;
  if (!isStr(st) || !(STATUSES as readonly string[]).includes(st)) return CLOSED;

  const emptyList = (v: unknown) => nullish(v) || (Array.isArray(v) && v.length === 0);
  const emptyObj = (v: unknown) => nullish(v) || (isObj(v) && Object.keys(v).length === 0);
  if (st !== "dates_available") {
    if (!nullish(r.first_eligible_date) || !emptyList(r.eligible_dates) || !emptyObj(r.offers)) return CLOSED;
    return { cls: st === "unfulfillable" ? "blocked" : "none" };
  }

  // ----- dates_available : types exacts, aucune coercition -----
  if (!(nullish(r.schedule_timezone) || (isStr(r.schedule_timezone) && r.schedule_timezone.length > 0))) return CLOSED;
  if (!(nullish(r.unfulfillable_reason) || isStr(r.unfulfillable_reason))) return CLOSED;
  if (!(nullish(r.date_selection_mode) || isStr(r.date_selection_mode))) return CLOSED;
  if (!(nullish(r.slot_selection_mode) || isStr(r.slot_selection_mode))) return CLOSED;
  const g = r.time_granularity_minutes;
  if (!(nullish(g) || (typeof g === "number" && Number.isFinite(g)))) return CLOSED;
  if (!(nullish(r.first_eligible_date) || isStr(r.first_eligible_date))) return CLOSED;

  const dateMode = r.date_selection_mode, slotMode = r.slot_selection_mode;
  if (dateMode !== "customer_selectable" && dateMode !== "derived_earliest") return CLOSED;
  if (slotMode !== "none" && slotMode !== "fixed_slots" && slotMode !== "time_within_window") return CLOSED;
  if (dateMode === "derived_earliest" && slotMode !== "none") return CLOSED;
  if (slotMode === "time_within_window" && !(typeof g === "number" && Number.isInteger(g) && g > 0)) return CLOSED;

  const dates = r.eligible_dates;
  if (!Array.isArray(dates) || dates.length === 0 || !dates.every(realDate)) return CLOSED;
  if (new Set(dates).size !== dates.length) return CLOSED;
  if (r.first_eligible_date !== dates[0]) return CLOSED;

  const offers = r.offers;
  if (!isObj(offers)) return CLOSED;
  const keys = Object.keys(offers);
  if (keys.length !== dates.length || !keys.every((k) => (dates as string[]).includes(k))) return CLOSED;
  for (const d of dates as string[]) {
    const list = offers[d];
    if (!Array.isArray(list) || list.length === 0) return CLOSED;
    const seenKeys = new Set<string>();
    const windows: Array<[number, number]> = [];
    for (const o of list) {
      if (!isObj(o)) return CLOSED;
      if (!Object.prototype.hasOwnProperty.call(o, "slot_key")) return CLOSED;
      if (!(o.slot_key === null || isStr(o.slot_key))) return CLOSED;
      if (!strictTime(o.starts_at) || !strictTime(o.ends_at)) return CLOSED;
      if (!(minutes(o.starts_at) < minutes(o.ends_at))) return CLOSED;
      if (slotMode === "fixed_slots") {
        if (!isStr(o.slot_key) || o.slot_key.length === 0 || seenKeys.has(o.slot_key)) return CLOSED;
        seenKeys.add(o.slot_key);
      } else if (o.slot_key !== null) {
        return CLOSED;
      }
      windows.push([minutes(o.starts_at), minutes(o.ends_at)]);
    }
    if (slotMode === "time_within_window") {
      windows.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < windows.length; i += 1) if (windows[i][0] < windows[i - 1][1]) return CLOSED;
    }
  }
  if (dateMode === "derived_earliest") return { cls: "derived", derivedDate: dates[0] as string };
  return { cls: "choose", slotMode };
}

// -------------------------------------------------------------------
// Réponses VALIDES, telles que le lecteur SQL les émet (une ligne).
// -------------------------------------------------------------------
const DELIVERY_COLS = {
  delivery_applicable: false, delivery_eligible: false, delivery_block: null, delivery_customer_text: null,
};
const row = (patch: Record<string, Json>): Json => ({
  ...DELIVERY_COLS,
  schedule_status: "absent", unfulfillable_reason: null, schedule_timezone: null,
  date_selection_mode: null, slot_selection_mode: null, time_granularity_minutes: null,
  first_eligible_date: null, eligible_dates: null, offers: null,
  ...patch,
} as Json);
const DAY = (s: string, e: string) => ({ slot_key: null, starts_at: s, ends_at: e });

export const BASES: Record<string, Json[]> = {
  derived: [row({
    schedule_status: "dates_available", schedule_timezone: "Europe/Paris",
    date_selection_mode: "derived_earliest", slot_selection_mode: "none",
    first_eligible_date: "2026-10-24", eligible_dates: ["2026-10-24"],
    offers: { "2026-10-24": [DAY("09:00", "18:00")] },
  })],
  selNone: [row({
    schedule_status: "dates_available", schedule_timezone: "Europe/Paris",
    date_selection_mode: "customer_selectable", slot_selection_mode: "none",
    first_eligible_date: "2026-10-24", eligible_dates: ["2026-10-24", "2026-10-26"],
    offers: { "2026-10-24": [DAY("09:00", "18:00")], "2026-10-26": [DAY("09:00", "18:00")] },
  })],
  fixed: [row({
    schedule_status: "dates_available", schedule_timezone: "Europe/Paris",
    date_selection_mode: "customer_selectable", slot_selection_mode: "fixed_slots",
    first_eligible_date: "2026-10-24", eligible_dates: ["2026-10-24", "2026-10-26"],
    offers: {
      "2026-10-24": [
        { slot_key: "morning", starts_at: "09:00", ends_at: "12:00" },
        { slot_key: "afternoon", starts_at: "14:00", ends_at: "18:00" },
      ],
      "2026-10-26": [{ slot_key: "morning", starts_at: "09:00", ends_at: "12:00" }],
    },
  })],
  window: [row({
    schedule_status: "dates_available", schedule_timezone: "Europe/Paris",
    date_selection_mode: "customer_selectable", slot_selection_mode: "time_within_window",
    time_granularity_minutes: 30,
    first_eligible_date: "2026-10-24", eligible_dates: ["2026-10-24", "2026-10-26"],
    offers: {
      "2026-10-24": [DAY("09:00", "11:00"), DAY("14:00", "16:00")],
      "2026-10-26": [DAY("09:00", "10:30")],
    },
  })],
};

/** Réponses valides des autres statuts (une ligne, comme le SQL). */
export const STATUS_ROWS: Record<string, Json[]> = {
  absent: [row({})],
  blocked_upstream: [row({ schedule_status: "blocked_upstream", delivery_applicable: true, delivery_block: "out_of_zone" })],
  informational_only: [row({
    schedule_status: "informational_only", schedule_timezone: "Europe/Paris",
    date_selection_mode: "informational_only", slot_selection_mode: "none",
  })],
  unfulfillable: [row({
    schedule_status: "unfulfillable", unfulfillable_reason: "no_offer_in_horizon", schedule_timezone: "Europe/Paris",
    date_selection_mode: "customer_selectable", slot_selection_mode: "fixed_slots",
  })],
};

// -------------------------------------------------------------------
// Mutations : chemins x classes de valeurs (JSON représentable).
// -------------------------------------------------------------------
export const DELETE = Symbol("delete");
export type Mutation = Json | typeof DELETE;

/** Classes de valeurs : absent, null, mauvais types, formats voisins, structures inattendues. */
export const VALUE_CLASSES: Array<[string, Mutation]> = [
  ["absent", DELETE], ["null", null],
  ["0", 0], ["1", 1], ["42", 42], ["-1", -1], ["1.5", 1.5], ["30-nombre", 30],
  ["true", true], ["false", false],
  ["chaine-vide", ""], ["espace", " "], ["texte", "x"], ["minuit-texte", "00:00"],
  ["heure-9:00", "9:00"], ["heure-09:00:00", "09:00:00"], ["heure-24:00", "24:00"], ["heure-25:00", "25:00"], ["heure-09:60", "09:60"],
  ["date-iso", "2026-10-24"], ["date-impossible", "2026-02-31"], ["date-horodatée", "2026-10-24T00:00:00Z"], ["date-non-bissextile", "2025-02-29"],
  ["30-chaine", "30"], ["cle-valide", "morning"],
  ["liste-vide", []], ["liste-chaine-vide", [""]], ["liste-heure", ["09:00"]], ["liste-null", [null]], ["liste-objet-vide", [{}]],
  ["liste-de-listes", [[]]], ["objet-vide", {}], ["objet-a1", { a: 1 }],
  ["offre-valide-jour", [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }]],
  ["offre-sans-cle", [{ starts_at: "09:00", ends_at: "18:00" }]],
  ["offre-cle-42", [{ slot_key: 42, starts_at: "09:00", ends_at: "18:00" }]],
  ["offre-inversee", [{ slot_key: null, starts_at: "18:00", ends_at: "09:00" }]],
];

export function clone<T extends Json>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export type Path = Array<string | number>;

/** Tous les chemins (conteneurs ET feuilles) d'une ligne, ligne = data[0]. */
export function allPaths(data: Json[]): Path[] {
  const out: Path[] = [];
  const walk = (v: Json, p: Path) => {
    out.push(p);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i]));
    else if (v !== null && typeof v === "object") for (const k of Object.keys(v)) walk((v as { [k: string]: Json })[k], [...p, k]);
  };
  walk(data[0], [0]);
  return out;
}

export function applyAt(data: Json[], path: Path, m: Mutation): Json[] {
  const copy = clone(data);
  let cur: any = copy;
  for (let i = 0; i < path.length - 1; i += 1) cur = cur[path[i] as any];
  const last = path[path.length - 1];
  if (m === DELETE) {
    if (Array.isArray(cur)) cur.splice(last as number, 1);
    else delete cur[last as string];
  } else {
    cur[last as any] = clone(m as Json);
  }
  return copy;
}

/** Sérialise pour une identité de cas stable. */
export const pathLabel = (p: Path) => p.slice(1).join(".") || "(ligne)";

/** Transformations de structure de plus haut niveau (forme de `data`). */
export function dataShapes(base: Json[]): Array<[string, unknown]> {
  const r = base[0];
  return [
    ["data=null", null], ["data=undefined", undefined], ["data=[]", []], ["data=2-lignes", [clone(r), clone(r)]],
    ["data=objet-nu", clone(r)], ["data=[null]", [null]], ["data=[[ligne]]", [[clone(r)]]],
    ["data=chaine", "x"], ["data=42", 42], ["data=true", true], ["data=[chaine]", ["x"]], ["data=[42]", [42]],
    ["data={}", {}], ["data=[{}]", [{}]], ["data=[ligne,null]", [clone(r), null]],
  ];
}

/** PRNG déterministe (mulberry32) : les cas générés sont reproductibles. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
