import { test } from "node:test";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  scheduleAllowsSubmit,
  scheduleRequirement,
  toSchedulePayload,
  isSelectionOffered,
  isValidSchedulePayload,
  EMPTY_SCHEDULE_SELECTION,
  type CheckoutScheduleView,
} from "../lib/checkout-schedule/model.ts";
import { mapCheckoutScheduleResponse, INVALID_SCHEDULE_STATUS } from "../lib/checkout-schedule/map-row.ts";
import { buildCreateOrderPayload } from "../lib/services/order-payload.ts";
import {
  BASES, STATUS_ROWS, VALUE_CLASSES, DELETE, allPaths, applyAt, clone, dataShapes, minutes, pathLabel, prng, refVerdict,
  type Json, type Mutation, type Path, type RefVerdict,
} from "./_csdj2-r4-oracle.ts";

// ====================================================================
// CSDJ2-R4-01 + REVUE SYSTÉMATIQUE (PR #160, HEAD audité c518dee).
//
// FRONTIÈRE TESTÉE : réponse BRUTE du RPC -> mapper -> modèle -> payload.
// Aucune `CheckoutScheduleView` fabriquée à la main : on part du JSON que
// `supabase.rpc` rendrait. L'ORACLE (tests/_csdj2-r4-oracle.ts) est écrit à
// part du code de production ; il est vérifié DANS LES DEUX SENS :
//   - SÛRETÉ  : si l'oracle dit « invalide », le code doit fermer l'envoi ;
//   - COMPLÉTUDE : si l'oracle dit « valide », le code doit rester disponible,
//     avec le même type d'exigence, et un payload égal aux valeurs BRUTES.
// ====================================================================

function implVerdict(data: unknown): { cls: string; slotMode?: string; date?: string; view: CheckoutScheduleView } {
  const view = mapCheckoutScheduleResponse(data);
  const req = scheduleRequirement(view);
  switch (req.kind) {
    case "unreadable": return { cls: "closed", view };
    case "choose": return { cls: "choose", slotMode: req.slotMode, view };
    case "derived": return { cls: "derived", date: req.date, view };
    default: return { cls: req.kind, view };
  }
}

function same(ref: RefVerdict, impl: ReturnType<typeof implVerdict>): boolean {
  if (ref.cls !== impl.cls) return false;
  if (ref.cls === "choose") return ref.slotMode === impl.slotMode;
  if (ref.cls === "derived") return ref.derivedDate === impl.date;
  return true;
}

// ---- Couverture : champ x classe x politique, émise en lignes TAP « # COVERAGE ».
const coverage = new Map<string, number>();
const bump = (k: string) => coverage.set(k, (coverage.get(k) ?? 0) + 1);

function fieldOf(p: Path): string {
  // 0 = data[0] ; ensuite le chemin dans la ligne.
  const q = p.slice(1);
  if (q.length === 0) return "ligne";
  if (q[0] === "eligible_dates") return q.length === 1 ? "eligible_dates" : "eligible_dates[i]";
  if (q[0] === "offers") {
    if (q.length === 1) return "offers";
    if (q.length === 2) return "offers[date]";
    if (q.length === 3) return "offers[date][j]";
    return `offers[date][j].${q[3]}`;
  }
  return String(q[0]);
}

function check(label: string, data: unknown, mismatches: string[], baseName: string, fieldKey?: string, cls?: string) {
  let impl: ReturnType<typeof implVerdict>;
  try {
    impl = implVerdict(data);
  } catch (e) {
    mismatches.push(`${label}: EXCEPTION ${(e as Error).message}`);
    return;
  }
  const ref = refVerdict(data);
  if (fieldKey && cls) bump(`${baseName}|${fieldKey}|${cls}|${ref.cls === "closed" ? "fermé" : "valide"}`);
  if (!same(ref, impl)) {
    mismatches.push(`${label}: oracle=${ref.cls}${ref.slotMode ? "/" + ref.slotMode : ""} code=${impl.cls}${impl.slotMode ? "/" + impl.slotMode : ""}`);
    return;
  }
  // SÛRETÉ de l'envoi : un état invalide ne laisse JAMAIS partir.
  if (ref.cls === "closed") {
    if (scheduleAllowsSubmit(impl.view, EMPTY_SCHEDULE_SELECTION)) mismatches.push(`${label}: envoi OUVERT sur réponse invalide`);
    if (toSchedulePayload(impl.view, scheduleRequirement(impl.view), { date: "2026-10-24", slotKey: "morning", time: "09:00" }) !== null) {
      mismatches.push(`${label}: payload produit sur réponse invalide`);
    }
  }
}

function report(title: string, mismatches: string[]) {
  if (process.env.R4_DUMP) appendFileSync(process.env.R4_DUMP, `## ${title}\n${mismatches.join("\n")}\n`);
  assert.deepEqual(
    mismatches.slice(0, 25),
    [],
    `${title} : ${mismatches.length} écart(s) entre l'oracle et le code (25 premiers)`
  );
}

test("[158-R4-B0] corpus VALIDE : l'oracle et le code concordent (contrôle de l'oracle lui-même)", () => {
  const mism: string[] = [];
  for (const [n, d] of Object.entries(BASES)) check(`base ${n}`, d, mism, n);
  for (const [n, d] of Object.entries(STATUS_ROWS)) check(`statut ${n}`, d, mism, n);
  report("corpus valide", mism);
  assert.equal(refVerdict(BASES.derived).cls, "derived");
  assert.equal(refVerdict(BASES.selNone).slotMode, "none");
  assert.equal(refVerdict(BASES.fixed).slotMode, "fixed_slots");
  assert.equal(refVerdict(BASES.window).slotMode, "time_within_window");
  assert.equal(refVerdict(STATUS_ROWS.absent).cls, "none");
  assert.equal(refVerdict(STATUS_ROWS.unfulfillable).cls, "blocked");
});

test("[158-R4-1] LES HUIT REPRODUCTIONS de CSDJ2-R4-01 (date dérivée) : réponse brute => illisible, jamais « derived »", () => {
  const withOffer = (o: Json) => { const d = clone(BASES.derived); (d[0] as any).offers = { "2026-10-24": [o] }; return d; };
  const goodOffer = { slot_key: null, starts_at: "09:00", ends_at: "18:00" };
  const withOther = (v: Json) => { const d = clone(BASES.derived); (d[0] as any).offers["2026-10-25"] = v; return d; };
  const cases: Array<[string, Json[]]> = [
    ["slot_key:42", withOffer({ ...goodOffer, slot_key: 42 })],
    ["slot_key:false", withOffer({ ...goodOffer, slot_key: false })],
    ["slot_key:{}", withOffer({ ...goodOffer, slot_key: {} })],
    ["slot_key:[]", withOffer({ ...goodOffer, slot_key: [] })],
    ["starts_at/ends_at:tableaux", withOffer({ slot_key: null, starts_at: ["09:00"], ends_at: ["18:00"] })],
    ["offers[25]=null", withOther(null)],
    ["offers[25]={}", withOther({})],
    ["offers[25]=\"bad\"", withOther("bad")],
  ];
  const mism: string[] = [];
  for (const [label, data] of cases) {
    const impl = implVerdict(data);
    if (impl.cls !== "closed") mism.push(`${label}: le code retourne « ${impl.cls} » au lieu d'illisible`);
    if (scheduleAllowsSubmit(impl.view, EMPTY_SCHEDULE_SELECTION)) mism.push(`${label}: envoi OUVERT`);
  }
  assert.deepEqual(mism, []);
});

test("[158-R4-2] FORME DE `data` : null, undefined, vide, 2 lignes, objet nu, imbriqué, scalaire => fermé (tous les corpus)", () => {
  const mism: string[] = [];
  for (const [n, base] of Object.entries({ ...BASES, ...STATUS_ROWS })) {
    for (const [label, data] of dataShapes(base)) check(`${n} ${label}`, data, mism, n, "data", label);
  }
  report("forme de data", mism);
});

test("[158-R4-3] MATRICE champ x classe de valeur x politique : chaque chemin de chaque réponse type reçoit chaque classe", () => {
  const mism: string[] = [];
  let cases = 0;
  const corpora = { ...BASES, ...STATUS_ROWS };
  for (const [n, base] of Object.entries(corpora)) {
    for (const path of allPaths(base)) {
      for (const [cls, m] of VALUE_CLASSES) {
        const data = applyAt(base, path, m);
        cases += 1;
        check(`${n} @ ${pathLabel(path)} <- ${cls}`, data, mism, n, fieldOf(path), cls);
      }
    }
  }
  assert.ok(cases > 4000, `couverture : ${cases} cas`);
  report(`matrice (${cases} cas)`, mism);
});

test("[158-R4-4] COMBINAISONS : 2 à 4 mutations simultanées tirées d'un PRNG déterministe (6000 cas)", () => {
  const rnd = prng(0xc5d12026);
  const mism: string[] = [];
  const names = Object.keys(BASES);
  let valid = 0, closed = 0;
  for (let i = 0; i < 6000; i += 1) {
    const n = names[Math.floor(rnd() * names.length)];
    let data: Json[] = clone(BASES[n]);
    const k = 2 + Math.floor(rnd() * 3);
    const applied: string[] = [];
    for (let j = 0; j < k; j += 1) {
      const paths = allPaths(data);
      const path = paths[Math.floor(rnd() * paths.length)];
      const [cls, m] = VALUE_CLASSES[Math.floor(rnd() * VALUE_CLASSES.length)];
      try { data = applyAt(data, path, m); applied.push(`${pathLabel(path)}<-${cls}`); } catch { /* chemin devenu invalide : on ignore */ }
    }
    if (refVerdict(data).cls === "closed") closed += 1; else valid += 1;
    check(`${n} [${applied.join(" ; ")}]`, data, mism, n, "combinaison", `${k}-mutations`);
  }
  assert.ok(closed > 1000 && valid > 50, `répartition des cas : ${closed} fermés / ${valid} valides`);
  report("combinaisons", mism);
});

test("[158-R4-5] FIDÉLITÉ DU PAYLOAD : toute réponse valide (corpus + mutants valides) produit des payloads égaux aux valeurs BRUTES, sans valeur par défaut", () => {
  const rnd = prng(0xfeed2026);
  const valids: Array<[string, Json[]]> = [];
  for (const [n, d] of Object.entries(BASES)) valids.push([n, d]);
  // Mutants que l'oracle juge valides (ex. fuseau nul, champs inutilisés) : le payload doit rester exact.
  for (const [n, base] of Object.entries(BASES)) {
    for (const path of allPaths(base)) {
      for (const [, m] of VALUE_CLASSES) {
        const data = applyAt(base, path, m);
        if (refVerdict(data).cls !== "closed") valids.push([n, data]);
      }
    }
  }
  void rnd;
  assert.ok(valids.length > 20);
  const mism: string[] = [];
  for (const [n, data] of valids) {
    const raw = (data[0] as any);
    const ref = refVerdict(data);
    const view = mapCheckoutScheduleResponse(data);
    const req = scheduleRequirement(view);
    if (ref.cls === "derived") {
      const p = toSchedulePayload(view, req, EMPTY_SCHEDULE_SELECTION);
      if (JSON.stringify(p) !== JSON.stringify({ date: raw.eligible_dates[0], slot_key: null, starts_at: null, ends_at: null })) mism.push(`${n}: payload dérivé ${JSON.stringify(p)}`);
      continue;
    }
    if (ref.cls !== "choose") continue;
    for (const d of raw.eligible_dates as string[]) {
      for (const o of raw.offers[d] as Array<{ slot_key: string | null; starts_at: string; ends_at: string }>) {
        if (ref.slotMode === "none") {
          const p = toSchedulePayload(view, req, { date: d, slotKey: null, time: null });
          if (JSON.stringify(p) !== JSON.stringify({ date: d, slot_key: null, starts_at: null, ends_at: null })) mism.push(`${n}/none ${d}: ${JSON.stringify(p)}`);
        } else if (ref.slotMode === "fixed_slots") {
          const p = toSchedulePayload(view, req, { date: d, slotKey: o.slot_key, time: null });
          if (JSON.stringify(p) !== JSON.stringify({ date: d, slot_key: o.slot_key, starts_at: o.starts_at, ends_at: o.ends_at })) mism.push(`${n}/fixed ${d} ${o.slot_key}: ${JSON.stringify(p)}`);
        } else {
          const g = raw.time_granularity_minutes as number;
          for (let t = minutes(o.starts_at); t < minutes(o.ends_at); t += g) {
            const hhmm = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
            const p = toSchedulePayload(view, req, { date: d, slotKey: null, time: hhmm });
            if (JSON.stringify(p) !== JSON.stringify({ date: d, slot_key: null, starts_at: hhmm, ends_at: o.ends_at })) mism.push(`${n}/window ${d} ${hhmm}: ${JSON.stringify(p)}`);
          }
          // une heure HORS grille ou HORS fenêtre n'est jamais une sélection offerte
          const outside = isSelectionOffered(view, req, { date: d, slotKey: null, time: "03:07" });
          if (outside) mism.push(`${n}/window ${d}: 03:07 offerte`);
        }
      }
    }
    // une sélection forgée (date / clé inconnues) ne donne jamais de payload
    if (toSchedulePayload(view, req, { date: "2099-01-01", slotKey: "zzz", time: "00:00" }) !== null) mism.push(`${n}: sélection forgée acceptée`);
  }
  assert.deepEqual(mism.slice(0, 25), [], `${mism.length} écart(s) de payload`);
});

test("[158-R4-6] COUVERTURE : chaque champ consommé reçoit chaque classe d'entrée sur chaque politique (relevé émis en TAP)", () => {
  const fields = ["data", "ligne", "schedule_status", "schedule_timezone", "unfulfillable_reason", "date_selection_mode", "slot_selection_mode",
    "time_granularity_minutes", "first_eligible_date", "eligible_dates", "eligible_dates[i]", "offers", "offers[date]", "offers[date][j]",
    "offers[date][j].slot_key", "offers[date][j].starts_at", "offers[date][j].ends_at"];
  const rows: string[] = [];
  const bases = Object.keys({ ...BASES, ...STATUS_ROWS });
  for (const f of fields) {
    const perBase = bases.map((b) => {
      let n = 0;
      for (const [k, v] of coverage) if (k.startsWith(`${b}|${f}|`)) n += v;
      return `${b}=${n}`;
    });
    rows.push(`${f}: ${perBase.join(" ")}`);
  }
  for (const r of rows) console.log(`# COVERAGE ${r}`);
  // Les champs absents d'une politique (ex. granularité hors fenêtre) existent quand même dans la ligne SQL : tous couverts.
  for (const f of fields) {
    for (const b of ["derived", "selNone", "fixed", "window"]) {
      let n = 0;
      for (const [k, v] of coverage) if (k.startsWith(`${b}|${f}|`)) n += v;
      assert.ok(n > 0, `champ « ${f} » non couvert pour ${b}`);
    }
  }
  const classes = new Set<string>();
  for (const k of coverage.keys()) classes.add(k.split("|")[2]);
  console.log(`# COVERAGE classes de valeurs distinctes : ${classes.size}`);
  console.log(`# COVERAGE cas (champ x classe x politique x verdict) distincts : ${coverage.size}`);
  assert.ok(classes.size >= VALUE_CLASSES.length);
});

test("[158-R4-7] statuts non disponibles : toute donnée de date/offre qui les accompagne est incohérente => fermé (absent, blocked_upstream, informational_only, unfulfillable)", () => {
  const withDates = (name: string, patch: Record<string, Json>) => {
    const d = clone(STATUS_ROWS[name]); Object.assign(d[0] as any, patch); return d;
  };
  const mism: string[] = [];
  for (const name of Object.keys(STATUS_ROWS)) {
    for (const [label, patch] of [
      ["dates", { eligible_dates: ["2026-10-24"] }],
      ["première date", { first_eligible_date: "2026-10-24" }],
      ["offres", { offers: { "2026-10-24": [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }] } }],
      ["dates de mauvais type", { eligible_dates: 42 }],
      ["offres de mauvais type", { offers: "x" }],
    ] as Array<[string, Record<string, Json>]>) {
      check(`${name} + ${label}`, withDates(name, patch), mism, name);
    }
  }
  report("statuts non disponibles + données", mism);
});

// ====================================================================
// DÉFENSE EN PROFONDEUR, DERNIER GARDE ET AUDIT DES CHEMINS D'ENVOI
// ====================================================================

test("[158-R4-8] LE MODÈLE SEUL refuse une vue mal typée (sans passer par le mapper) : aucune normalisation en aval", () => {
  const good = mapCheckoutScheduleResponse(BASES.fixed);
  assert.equal(scheduleRequirement(good).kind, "choose");
  const breakers: Array<[string, (v: any) => void]> = [
    ["fuseau numérique", (v) => { v.timezone = 42; }],
    ["fuseau vide", (v) => { v.timezone = ""; }],
    ["mode de date non chaîne", (v) => { v.dateSelectionMode = 1; }],
    ["mode de créneau objet", (v) => { v.slotSelectionMode = {}; }],
    ["première date nombre", (v) => { v.firstEligibleDate = 20261024; }],
    ["granularité chaîne", (v) => { v.timeGranularityMinutes = "30"; }],
    ["granularité NaN", (v) => { v.timeGranularityMinutes = Number.NaN; }],
    ["dates non tableau", (v) => { v.eligibleDates = "2026-10-24"; }],
    ["date non chaîne", (v) => { v.eligibleDates = [20261024, "2026-10-26"]; }],
    ["offres null", (v) => { v.offers = null; }],
    ["offres tableau", (v) => { v.offers = []; }],
    ["liste d'offres null (autre date)", (v) => { v.offers["2026-10-26"] = null; }],
    ["liste d'offres objet (autre date)", (v) => { v.offers["2026-10-26"] = {}; }],
    ["liste d'offres chaîne", (v) => { v.offers["2026-10-24"] = "bad"; }],
    ["offre null", (v) => { v.offers["2026-10-24"] = [null]; }],
    ["offre tableau", (v) => { v.offers["2026-10-24"] = [[]]; }],
    ["clé de créneau 42", (v) => { v.offers["2026-10-24"][0].slotKey = 42; }],
    ["clé de créneau indéfinie", (v) => { v.offers["2026-10-24"][0].slotKey = undefined; }],
    ["heure de début tableau", (v) => { v.offers["2026-10-24"][0].startsAt = ["09:00"]; }],
    ["heure de fin nombre", (v) => { v.offers["2026-10-24"][0].endsAt = 1800; }],
  ];
  for (const [label, brk] of breakers) {
    const v: any = JSON.parse(JSON.stringify(good));
    brk(v);
    assert.equal(scheduleRequirement(v).kind, "unreadable", label);
    assert.equal(scheduleAllowsSubmit(v, { date: "2026-10-24", slotKey: "morning", time: null }), false, `${label}: envoi fermé`);
  }
  // La vue dérivée mal typée aussi.
  const dv: any = JSON.parse(JSON.stringify(mapCheckoutScheduleResponse(BASES.derived)));
  dv.offers["2026-10-24"][0].slotKey = false;
  assert.equal(scheduleRequirement(dv).kind, "unreadable");
});

test("[158-R4-9] LE MAPPER refuse tout type inattendu (statut `invalid`) : aucune coercition, sur chaque champ x chaque mauvais type", () => {
  const leaf = (p: Path): string => fieldOf(p);
  const jsonType = (m: Mutation) => (m === DELETE ? "absent" : m === null ? "null" : Array.isArray(m) ? "array" : typeof m);
  const allowed: Record<string, string[]> = {
    schedule_timezone: ["string", "null", "absent"],
    unfulfillable_reason: ["string", "null", "absent"],
    date_selection_mode: ["string", "null", "absent"],
    slot_selection_mode: ["string", "null", "absent"],
    first_eligible_date: ["string", "null", "absent"],
    time_granularity_minutes: ["number", "null", "absent"],
    eligible_dates: ["array", "null", "absent"],
    "eligible_dates[i]": ["string", "absent"],
    offers: ["object", "null", "absent"],
    "offers[date]": ["array", "absent"],
    "offers[date][j]": ["object", "absent"],
    "offers[date][j].slot_key": ["string", "null"],
    "offers[date][j].starts_at": ["string"],
    "offers[date][j].ends_at": ["string"],
  };
  const mism: string[] = [];
  let n = 0;
  for (const [bn, base] of Object.entries(BASES)) {
    for (const path of allPaths(base)) {
      const f = leaf(path);
      if (!(f in allowed)) continue;
      for (const [cls, m] of VALUE_CLASSES) {
        const violates = !allowed[f].includes(jsonType(m)) || (f === "schedule_timezone" && m === "");
        if (!violates) continue;
        n += 1;
        const out = mapCheckoutScheduleResponse(applyAt(base, path, m));
        if (out.status !== INVALID_SCHEDULE_STATUS) mism.push(`${bn} @ ${pathLabel(path)} <- ${cls}: le mapper accepte (statut ${out.status})`);
      }
    }
  }
  assert.ok(n > 1500, `${n} violations de type testées`);
  report(`mapper (${n} violations de type)`, mism);
  // Une clé « __proto__ » reste visible (donnée), jamais un changement de prototype.
  const proto = JSON.parse('[{"schedule_status":"dates_available","schedule_timezone":"Europe/Paris","date_selection_mode":"derived_earliest","slot_selection_mode":"none","first_eligible_date":"2026-10-24","eligible_dates":["2026-10-24"],"offers":{"2026-10-24":[{"slot_key":null,"starts_at":"09:00","ends_at":"18:00"}],"__proto__":[{"slot_key":null,"starts_at":"09:00","ends_at":"18:00"}]}}]');
  const v = mapCheckoutScheduleResponse(proto);
  assert.ok(Object.prototype.hasOwnProperty.call(v.offers, "__proto__"), "clé __proto__ conservée comme donnée");
  assert.equal(Object.getPrototypeOf(v.offers), Object.prototype, "prototype intact");
  assert.equal(scheduleRequirement(v).kind, "unreadable", "clé non-date => illisible");
});

test("[158-R4-10] DERNIER GARDE : `buildCreateOrderPayload` refuse tout `schedule` mal formé (aucun réseau), laisse passer les valides et ignore la table", () => {
  const base = {
    slug: "sanaa", lines: [{ item: { id: "i1", name: "Cookie", price: 3.5 }, quantity: 1, option: null }] as any,
    lang: "fr" as const, note: "", cgvAccepted: false,
  };
  const ctx = { mode: "pickup", customer: { name: "Yakout", phone: "0612345678" } } as any;
  const ok = { date: "2026-10-24", slot_key: null, starts_at: null, ends_at: null };
  assert.deepEqual((buildCreateOrderPayload({ ...base, context: ctx, schedule: ok }).p_customer as any).schedule, ok);
  const valid = [
    ok,
    { date: "2028-02-29", slot_key: "am", starts_at: "09:00", ends_at: "12:00" },
    { date: "2026-10-24", slot_key: null, starts_at: "14:30", ends_at: "16:00" },
  ];
  for (const v of valid) assert.equal(isValidSchedulePayload(v), true, JSON.stringify(v));
  const invalid: unknown[] = [
    { ...ok, date: "2026-02-31" }, { ...ok, date: "2026-10-24T00:00" }, { ...ok, date: 20261024 }, { ...ok, date: null },
    { ...ok, slot_key: 42 }, { ...ok, slot_key: "" }, { ...ok, slot_key: "am" },
    { date: "2026-10-24", slot_key: "am", starts_at: "25:00", ends_at: "26:00" },
    { date: "2026-10-24", slot_key: null, starts_at: "18:00", ends_at: "09:00" },
    { date: "2026-10-24", slot_key: null, starts_at: "09:00", ends_at: "09:00" },
    { date: "2026-10-24", slot_key: null, starts_at: "09:00:00", ends_at: "18:00:00" },
    { date: "2026-10-24", slot_key: null, starts_at: "09:00", ends_at: null },
    { date: "2026-10-24", slot_key: null, starts_at: null, ends_at: "18:00" },
    { date: "2026-10-24", slot_key: null, starts_at: ["09:00"], ends_at: ["18:00"] },
    { date: "2026-10-24", slot_key: null, starts_at: null }, { ...ok, extra: 1 }, [], "2026-10-24", 42, true,
  ];
  for (const bad of invalid) {
    assert.equal(isValidSchedulePayload(bad), false, JSON.stringify(bad));
    assert.throws(() => buildCreateOrderPayload({ ...base, context: ctx, schedule: bad as any }), /SCHEDULE_PAYLOAD_INVALID/, JSON.stringify(bad));
  }
  // Table : jamais de schedule, même fourni ; absent / null : rien d'envoyé.
  const table = { mode: "table", tableNumber: 3, customer: {} } as any;
  assert.equal((buildCreateOrderPayload({ ...base, context: table, schedule: ok as any }).p_customer as any).schedule, undefined);
  assert.equal((buildCreateOrderPayload({ ...base, context: ctx, schedule: null }).p_customer as any).schedule, undefined);
  assert.equal((buildCreateOrderPayload({ ...base, context: ctx }).p_customer as any).schedule, undefined);
});

test("[158-R4-11] AUDIT DES CHEMINS D'ENVOI (invariant de sources) : un seul lecteur, un seul mapper, un seul constructeur de charge, un seul appelant, un seul producteur de schedule", () => {
  const root = path.resolve(process.cwd());
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(path.join(root, d))) {
      const rel = path.join(d, e);
      if (e === "node_modules" || e.startsWith(".")) continue;
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs|js)$/.test(e)) files.push(rel.split(path.sep).join("/"));
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  // Les commentaires ne sont pas des appels : on les retire avant de chercher.
  const code = (f: string) => readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const withMatch = (re: RegExp) => files.filter((f) => re.test(code(f))).sort();
  // Deux appelants du MÊME lecteur : le checkout client (mappé, fail-closed) et l'APERÇU marchand
  // (tableau de bord, affichage seul, antérieur à la PR). Le second ne doit JAMAIS atteindre le checkout.
  assert.deepEqual(withMatch(/\.rpc\(\s*["'`]get_checkout_fulfillment_schedule["'`]/), ["lib/services/availability.ts", "lib/services/checkout-schedule.ts"], "appelants du lecteur");
  assert.deepEqual(withMatch(/\bgetCheckoutFulfillmentSchedulePreview\s*\(/).filter((f) => f !== "lib/services/availability.ts"), ["app/dashboard/availability/page.tsx"], "aperçu marchand : un seul consommateur, hors checkout");
  assert.ok(!withMatch(/lib\/services\/availability/).some((f) => f.startsWith("components/MenuView") || f.startsWith("components/Cart") || f.startsWith("components/Checkout") || f.startsWith("lib/checkout-schedule/") || f === "lib/services/orders.ts" || f === "lib/services/order-payload.ts"), "le service marchand n'est importé par aucun fichier du checkout");
  assert.deepEqual(withMatch(/from\s+["']@\/lib\/checkout-schedule\/map-row["']/), ["lib/services/checkout-schedule.ts"], "mapper");
  assert.deepEqual(withMatch(/fetchCheckoutSchedule\s*\(/).filter((f) => f !== "lib/services/checkout-schedule.ts"), ["lib/checkout-schedule/use-checkout-schedule.ts"], "consommateur du service");
  assert.deepEqual(withMatch(/\.rpc\(\s*["'`]create_order["'`]/), ["lib/services/orders.ts"], "RPC create_order");
  assert.deepEqual(withMatch(/buildCreateOrderPayload\s*\(/).filter((f) => f !== "lib/services/order-payload.ts"), ["lib/services/orders.ts"], "constructeur de charge");
  assert.deepEqual(withMatch(/\bcreateOrder\s*\(/).filter((f) => f !== "lib/services/orders.ts"), ["components/MenuView.tsx"], "appelant de createOrder");
  assert.deepEqual(withMatch(/\btoSchedulePayload\s*\(/).filter((f) => f !== "lib/checkout-schedule/model.ts"), ["components/MenuView.tsx"], "producteur du schedule");
  assert.deepEqual(withMatch(/\bscheduleAllowsSubmit\s*\(/).filter((f) => f !== "lib/checkout-schedule/model.ts"), ["components/MenuView.tsx"], "garde d'envoi");
  assert.deepEqual(withMatch(/\bscheduleRequirement\s*\(/).filter((f) => f !== "lib/checkout-schedule/model.ts"), ["components/CheckoutSchedulePicker.tsx", "components/MenuView.tsx", "lib/checkout-schedule/messages.ts"], "lecteurs de l'exigence");
  // Le `schedule` de MenuView vient UNIQUEMENT de toSchedulePayload (pas d'objet forgé à la main).
  const menu = code("components/MenuView.tsx");
  assert.equal((menu.match(/schedule:\s*frozenSchedule/g) ?? []).length, 1);
  assert.match(menu, /const frozenSchedule =\s*scheduleState\.status === "ready"\s*\?\s*toSchedulePayload\(/);
  assert.ok(!/starts_at\s*:/.test(menu) && !/slot_key\s*:/.test(menu), "MenuView ne fabrique aucune valeur de schedule");
  // Le bouton d'envoi ET le gestionnaire passent par le même garde.
  assert.match(menu, /const scheduleOk =\s*scheduleState\.status === "ready"\s*\?\s*scheduleAllowsSubmit\(/);
  assert.match(menu, /if \(!scheduleOk\) return;/);
  assert.match(menu, /lines\.length > 0 && orderContext !== null && invoiceRequestValid && scheduleOk/);
});

test("[158-R4-12] `slot_key` ABSENT n'est jamais lu comme null, même si la chaîne de prototypes en fournit un (présence PROPRE exigée)", () => {
  const raw = () => JSON.parse(JSON.stringify(BASES.derived)) as any[];
  const withoutKey = raw();
  const firstDate = withoutKey[0].eligible_dates[0];
  delete withoutKey[0].offers[firstDate][0].slot_key;
  // Sans pollution : fermé.
  assert.equal(mapCheckoutScheduleResponse(withoutKey).status, INVALID_SCHEDULE_STATUS);
  // Avec pollution de Object.prototype : l'absence ne doit pas être « guérie » en null.
  const proto = Object.prototype as any;
  try {
    proto.slot_key = null;
    assert.equal(mapCheckoutScheduleResponse(withoutKey).status, INVALID_SCHEDULE_STATUS, "slot_key hérité != slot_key propre");
    const sound = raw();
    assert.notEqual(mapCheckoutScheduleResponse(sound).status, INVALID_SCHEDULE_STATUS, "réponse saine inchangée");
  } finally {
    delete proto.slot_key;
  }
});

test("[158-R4-13] SÉLECTION : un doublon de clé de créneau ou d'heure n'est jamais résolu en « première offre » (isSelectionOffered ET toSchedulePayload, chacun seul)", () => {
  const view = mapCheckoutScheduleResponse(BASES.fixed);
  const date = view.eligibleDates[0];
  const first = view.offers[date][0];
  const dup: CheckoutScheduleView = { ...view, offers: { ...view.offers, [date]: [first, { ...first }] } };
  const req = { kind: "choose", date: null, slotMode: "fixed_slots" } as any;
  const sel = { date, slotKey: first.slotKey, time: null };
  assert.equal(isSelectionOffered(dup, req, sel), false, "isSelectionOffered refuse le doublon");
  assert.equal(toSchedulePayload(dup, req, sel), null, "toSchedulePayload refuse le doublon");
  const win = mapCheckoutScheduleResponse(BASES.window);
  const wd = win.eligibleDates[0];
  const wo = win.offers[wd][0];
  const wdup: CheckoutScheduleView = { ...win, offers: { ...win.offers, [wd]: [wo, { ...wo }] } };
  const wreq = { kind: "choose", date: null, slotMode: "time_within_window" } as any;
  const wsel = { date: wd, slotKey: null, time: wo.startsAt };
  assert.equal(isSelectionOffered(wdup, wreq, wsel), false);
  assert.equal(toSchedulePayload(wdup, wreq, wsel), null);
});
