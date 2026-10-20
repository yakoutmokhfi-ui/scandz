import { test } from "node:test";
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  scheduleAllowsSubmit,
  scheduleRequirement,
  toSchedulePayload,
  EMPTY_SCHEDULE_SELECTION,
  type CheckoutScheduleView,
} from "../lib/checkout-schedule/model.ts";
import { mapCheckoutScheduleResponse } from "../lib/checkout-schedule/map-row.ts";
import {
  BASES, VALUE_CLASSES, allPaths, applyAt, clone, pathLabel, prng, refVerdict,
  type Json, type RefVerdict,
} from "./_csdj2-r4-oracle.ts";
import {
  ALL_BASES, MISSING, MULTI_BASES, assertMultiBasesValid, offersClasses, policyOf, structuralVariants,
} from "./_csdj2-r5-oracle.ts";

// ====================================================================
// CSDJ2-R5 (PR #160, HEAD audité d28bea9) -- une date éligible AUTRE que la
// date dérivée, avec une liste d'offres vide, laissait l'envoi possible.
//
// Frontière : réponse BRUTE du RPC -> mapper -> modèle -> payload. Deux
// juges indépendants du code : (1) l'ORACLE R4 (contrat v1.2 + SQL source),
// (2) des PROPRIÉTÉS MÉTAMORPHIQUES qui n'utilisent pas l'oracle.
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
const coverage = new Map<string, number>();
const bump = (k: string) => coverage.set(k, (coverage.get(k) ?? 0) + 1);

function check(label: string, data: unknown, mism: string[], cov?: string) {
  let impl: ReturnType<typeof implVerdict>;
  try { impl = implVerdict(data); } catch (e) { mism.push(`${label}: EXCEPTION ${(e as Error).message}`); return; }
  const ref = refVerdict(data);
  if (cov) bump(`${cov}|${ref.cls === "closed" ? "fermé" : "valide"}`);
  if (!same(ref, impl)) {
    mism.push(`${label}: oracle=${ref.cls}${ref.slotMode ? "/" + ref.slotMode : ""} code=${impl.cls}${impl.slotMode ? "/" + impl.slotMode : ""}`);
    return;
  }
  if (ref.cls === "closed") {
    if (scheduleAllowsSubmit(impl.view, EMPTY_SCHEDULE_SELECTION)) mism.push(`${label}: envoi OUVERT sur réponse invalide`);
    if (toSchedulePayload(impl.view, scheduleRequirement(impl.view), { date: "2026-10-24", slotKey: "morning", time: "09:00" }) !== null) {
      mism.push(`${label}: payload produit sur réponse invalide`);
    }
  }
}
function report(title: string, mism: string[]) {
  if (process.env.R5_DUMP) appendFileSync(process.env.R5_DUMP, `## ${title}\n${mism.join("\n")}\n`);
  assert.deepEqual(mism.slice(0, 25), [], `${title} : ${mism.length} écart(s) entre l'oracle et le code (25 premiers)`);
}

const DAYO = { slot_key: null, starts_at: "09:00", ends_at: "18:00" };

test("[158-R5-B0] bases multi-dates VALIDES : l'oracle et le code concordent (contrôle de l'oracle étendu)", () => {
  assertMultiBasesValid();
  const mism: string[] = [];
  for (const [n, d] of Object.entries(ALL_BASES)) check(`base ${n}`, d, mism);
  report("bases valides", mism);
  assert.equal(refVerdict(MULTI_BASES.derived2).cls, "derived");
  assert.equal(refVerdict(MULTI_BASES.derived3).cls, "derived");
  assert.equal(refVerdict(MULTI_BASES.fixed3).slotMode, "fixed_slots");
});

test("[158-R5-1] LE FINDING R5 : date dérivée valide + AUTRE date éligible à liste d'offres vide => illisible (2 et 3 dates, toutes positions)", () => {
  const mk = (dates: string[], offers: Record<string, Json>): Json[] => {
    const d = clone(BASES.derived);
    (d[0] as any).eligible_dates = dates;
    (d[0] as any).first_eligible_date = dates[0];
    (d[0] as any).offers = offers;
    return d;
  };
  const cases: Array<[string, Json[]]> = [
    ["2 dates, 2e vide", mk(["2026-10-24", "2026-10-25"], { "2026-10-24": [DAYO], "2026-10-25": [] })],
    ["3 dates, 2e vide", mk(["2026-10-24", "2026-10-25", "2026-10-26"], { "2026-10-24": [DAYO], "2026-10-25": [], "2026-10-26": [DAYO] })],
    ["3 dates, 3e vide", mk(["2026-10-24", "2026-10-25", "2026-10-26"], { "2026-10-24": [DAYO], "2026-10-25": [DAYO], "2026-10-26": [] })],
    ["3 dates, 2e et 3e vides", mk(["2026-10-24", "2026-10-25", "2026-10-26"], { "2026-10-24": [DAYO], "2026-10-25": [], "2026-10-26": [] })],
    ["2 dates, 1re vide (dérivée)", mk(["2026-10-24", "2026-10-25"], { "2026-10-24": [], "2026-10-25": [DAYO] })],
    ["2 dates, toutes vides", mk(["2026-10-24", "2026-10-25"], { "2026-10-24": [], "2026-10-25": [] })],
  ];
  const mism: string[] = [];
  for (const [label, data] of cases) {
    const impl = implVerdict(data);
    if (impl.cls !== "closed") mism.push(`${label}: le code retourne « ${impl.cls} » au lieu d'illisible`);
    if (scheduleAllowsSubmit(impl.view, EMPTY_SCHEDULE_SELECTION)) mism.push(`${label}: envoi OUVERT`);
    assert.equal(refVerdict(data).cls, "closed", `${label}: l'oracle doit juger invalide`);
  }
  assert.deepEqual(mism, []);
});

test("[158-R5-2] OPÉRATEURS STRUCTURELS sur toutes les bases (1 à 3 dates, 4 politiques) : oracle = code, envoi fermé si invalide", () => {
  const mism: string[] = [];
  let n = 0;
  for (const [bn, base] of Object.entries(ALL_BASES)) {
    for (const [label, data] of structuralVariants(bn, base)) {
      n += 1;
      check(`${bn} :: ${label}`, data, mism, `struct|${policyOf(bn)}`);
    }
  }
  assert.ok(n > 1500, `couverture : ${n} variantes structurelles`);
  report(`structurel (${n} cas)`, mism);
});

test("[158-R5-3] MÉTAMORPHIQUE (sans oracle) : retirer, vider ou invalider les offres de N'IMPORTE QUELLE date d'une réponse valide la ferme ; ajouter une date valide ne la ferme pas", () => {
  const mism: string[] = [];
  for (const [bn, base] of Object.entries(ALL_BASES)) {
    const cls0 = implVerdict(base).cls;
    if (cls0 === "closed") { mism.push(`${bn}: la base valide est fermée`); continue; }
    const dates: string[] = (base[0] as any).eligible_dates;
    for (const d of dates) {
      for (const [lab, mut] of [
        ["liste vide", (r: any) => { r.offers[d] = []; }],
        ["clé retirée", (r: any) => { delete r.offers[d]; }],
        ["null", (r: any) => { r.offers[d] = null; }],
        ["[null]", (r: any) => { r.offers[d] = [null]; }],
        ["offre inversée", (r: any) => { r.offers[d] = [{ slot_key: null, starts_at: "18:00", ends_at: "09:00" }]; }],
      ] as Array<[string, (r: any) => void]>) {
        const x = clone(base); mut(x[0]);
        const v = implVerdict(x);
        if (v.cls !== "closed") mism.push(`${bn} / ${d} / ${lab}: « ${v.cls} » au lieu de fermé`);
        if (scheduleAllowsSubmit(v.view, EMPTY_SCHEDULE_SELECTION)) mism.push(`${bn} / ${d} / ${lab}: envoi ouvert`);
      }
    }
    // Ajouter une date AVEC une bonne liste d'offres (même forme que la première) : même classe, dates en plus.
    const first = (base[0] as any).offers[dates[0]];
    const x = clone(base);
    (x[0] as any).eligible_dates.push("2026-11-02");
    (x[0] as any).offers["2026-11-02"] = clone(first);
    const v = implVerdict(x);
    if (v.cls !== cls0) mism.push(`${bn}: ajouter une date valide change la classe ${cls0} -> ${v.cls}`);
  }
  assert.deepEqual(mism, []);
});

test("[158-R5-4] MATRICE champ x classe de valeur sur les bases MULTI-DATES (chaque chemin de chaque date)", () => {
  const mism: string[] = [];
  let cases = 0;
  for (const [n, base] of Object.entries(MULTI_BASES)) {
    for (const path of allPaths(base)) {
      for (const [cls, m] of VALUE_CLASSES) {
        cases += 1;
        const label = path.slice(1).join(".").replace(/\d{4}-\d{2}-\d{2}/, (d) => `date#${(base[0] as any).eligible_dates.indexOf(d)}`);
        check(`${n} @ ${label || "(ligne)"} <- ${cls}`, applyAt(base, path, m), mism, `matrice|${policyOf(n)}`);
      }
    }
  }
  assert.ok(cases > 3000, `couverture : ${cases} cas`);
  report(`matrice multi-dates (${cases} cas)`, mism);
});

test("[158-R5-5] COMBINAISONS STRUCTURE + VALEUR : 1 à 3 opérations tirées d'un PRNG déterministe (5000 cas, bases multi-dates)", () => {
  const rnd = prng(0x5eed2026);
  const names = Object.keys(ALL_BASES);
  const mism: string[] = [];
  let valid = 0, closed = 0;
  for (let i = 0; i < 5000; i += 1) {
    const n = names[Math.floor(rnd() * names.length)];
    let data: Json[] = clone(ALL_BASES[n]);
    const k = 1 + Math.floor(rnd() * 3);
    const applied: string[] = [];
    for (let j = 0; j < k; j += 1) {
      const variants = rnd() < 0.5 ? structuralVariants(n, data) : [];
      if (variants.length > 0) {
        const [lab, v] = variants[Math.floor(rnd() * variants.length)];
        data = v; applied.push(`S(${lab})`);
      } else {
        const paths = allPaths(data);
        const path = paths[Math.floor(rnd() * paths.length)];
        const [cls, m] = VALUE_CLASSES[Math.floor(rnd() * VALUE_CLASSES.length)];
        try { data = applyAt(data, path, m); applied.push(`V(${pathLabel(path)}<-${cls})`); } catch { /* chemin devenu invalide */ }
      }
    }
    if (refVerdict(data).cls === "closed") closed += 1; else valid += 1;
    check(`${n} [${applied.join(" ; ")}]`, data, mism, `combinaison|${policyOf(n)}`);
  }
  assert.ok(closed > 1000 && valid > 100, `répartition : ${closed} fermés / ${valid} valides`);
  report("combinaisons structure+valeur", mism);
});

test("[158-R5-6] FIDÉLITÉ : une réponse valide à 2 ou 3 dates garde ses dates, sa première date, et un payload dérivé = première date SEULE (jamais une autre)", () => {
  for (const n of ["derived2", "derived3"]) {
    const data = MULTI_BASES[n];
    const v = implVerdict(data);
    assert.equal(v.cls, "derived", n);
    assert.equal(v.date, (data[0] as any).eligible_dates[0], `${n}: date dérivée = première date`);
    assert.deepEqual(v.view.eligibleDates, (data[0] as any).eligible_dates, `${n}: dates conservées`);
    const req = scheduleRequirement(v.view);
    assert.deepEqual(
      toSchedulePayload(v.view, req, EMPTY_SCHEDULE_SELECTION),
      { date: (data[0] as any).eligible_dates[0], slot_key: null, starts_at: null, ends_at: null },
      `${n}: payload date seule`
    );
  }
  for (const n of ["selNone3", "fixed3", "window3"]) {
    const v = implVerdict(MULTI_BASES[n]);
    assert.equal(v.cls, "choose", n);
    assert.deepEqual(v.view.eligibleDates, (MULTI_BASES[n][0] as any).eligible_dates, `${n}: dates proposées`);
  }
});

test("[158-R5-7] COUVERTURE : position de la date x forme d'offres x politique (relevé TAP)", () => {
  assert.ok(coverage.size > 0, "les tests précédents doivent avoir alimenté le relevé");
  const byKind = new Map<string, number>();
  for (const [k, v] of coverage) { const kind = k.split("|").slice(0, 2).join("|") + "|" + k.split("|").pop(); byKind.set(kind, (byKind.get(kind) ?? 0) + v); }
  for (const [k, v] of [...byKind].sort()) console.log(`# COVERAGE-R5 ${k}: ${v}`);
  const classes = offersClasses("derived").length;
  console.log(`# COVERAGE-R5 formes d'offres par date : ${classes} ; positions testées : 0..n par base ; bases : ${Object.keys(ALL_BASES).join(",")}`);
  for (const pol of ["derived", "selNone", "fixed", "window"]) {
    assert.ok([...coverage.keys()].some((k) => k.startsWith(`struct|${pol}|`) && k.endsWith("|fermé")), `${pol}: cas fermés couverts`);
    assert.ok([...coverage.keys()].some((k) => k.startsWith(`struct|${pol}|`) && k.endsWith("|valide")), `${pol}: cas valides couverts`);
  }
  assert.ok(MISSING !== undefined);
});

test("[158-R5-8] ÉPINGLE : l'ancienne donnée de [158-6] (dérivée + 2e date à offres vides []) est désormais ILLISIBLE ; la donnée cohérente reste « derived »", () => {
  const offer = { slotKey: null, startsAt: "09:00", endsAt: "18:00" };
  const old: CheckoutScheduleView = {
    status: "dates_available", unfulfillableReason: null, timezone: "Europe/Paris",
    dateSelectionMode: "derived_earliest", slotSelectionMode: "none", timeGranularityMinutes: null,
    firstEligibleDate: "2026-10-20", eligibleDates: ["2026-10-20", "2026-10-22"],
    offers: { "2026-10-20": [offer], "2026-10-22": [] },
  };
  assert.deepEqual(scheduleRequirement(old), { kind: "unreadable", reason: "response" });
  assert.equal(scheduleAllowsSubmit(old, EMPTY_SCHEDULE_SELECTION), false);
  const coherent = { ...old, offers: { "2026-10-20": [offer], "2026-10-22": [offer] } };
  assert.deepEqual(scheduleRequirement(coherent), { kind: "derived", date: "2026-10-20" });
  assert.equal(scheduleAllowsSubmit(coherent, EMPTY_SCHEDULE_SELECTION), true);
});
