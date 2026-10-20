import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SCHEDULE_SELECTION,
  isIsoDate,
  isSelectionOffered,
  scheduleAllowsSubmit,
  scheduleRequirement,
  toSchedulePayload,
  type CheckoutScheduleView,
  type ScheduleRequirement,
} from "../lib/checkout-schedule/model.ts";
import { mapCheckoutScheduleResponse } from "../lib/checkout-schedule/map-row.ts";
import { DICTS, translate } from "../lib/i18n.ts";
import { unreadableMessageKey } from "../lib/checkout-schedule/messages.ts";

// ====================================================================
// CSDJ-2 / #158 -- remédiation après contre-audit (PR #160, f81bb60) :
// réponses calendrier INCOHÉRENTES. Aucune normalisation, aucune date
// inventée, aucun créneau « le premier qui correspond ».
// ====================================================================

const slot = (slotKey: string | null, startsAt: string, endsAt: string) => ({ slotKey, startsAt, endsAt });
const view = (patch: Partial<CheckoutScheduleView>): CheckoutScheduleView => ({
  status: "dates_available",
  unfulfillableReason: null,
  timezone: "Europe/Paris",
  dateSelectionMode: "customer_selectable",
  slotSelectionMode: "fixed_slots",
  timeGranularityMinutes: null,
  firstEligibleDate: "2026-10-20",
  eligibleDates: ["2026-10-20"],
  offers: { "2026-10-20": [slot("morning", "09:00", "12:00"), slot("afternoon", "14:00", "18:00")] },
  ...patch,
});
const unreadable = (reason: string): ScheduleRequirement => ({ kind: "unreadable", reason } as ScheduleRequirement);

function assertBlocked(v: CheckoutScheduleView, reason: string, label: string) {
  assert.deepEqual(scheduleRequirement(v), unreadable(reason), label);
  assert.equal(scheduleAllowsSubmit(v, EMPTY_SCHEDULE_SELECTION), false, `${label}: envoi fermé`);
  // Même avec une sélection « forgée », aucun payload.
  const forged = { date: v.eligibleDates[0] ?? "2026-10-20", slotKey: "morning", time: "09:00" };
  assert.equal(toSchedulePayload(v, scheduleRequirement(v), forged), null, `${label}: aucun payload`);
  assert.equal(scheduleAllowsSubmit(v, forged), false, `${label}: aucune sélection ne rouvre l'envoi`);
}

test("[158-R2-P1] créneaux de MÊME clé : réponse ambiguë, jamais le « premier » créneau", () => {
  const dup = view({ offers: { "2026-10-20": [slot("slot", "09:00", "12:00"), slot("slot", "14:00", "18:00")] } });
  assertBlocked(dup, "ambiguous", "clé dupliquée");
  // Défense en profondeur : même en forçant l'exigence « choose », une clé dupliquée ne produit AUCUN payload.
  const choose: ScheduleRequirement = { kind: "choose", slotMode: "fixed_slots" };
  const sel = { date: "2026-10-20", slotKey: "slot", time: null };
  assert.equal(isSelectionOffered(dup, choose, sel), false);
  assert.equal(toSchedulePayload(dup, choose, sel), null);
  // La MÊME clé sur DEUX dates différentes est normale (un créneau « matin » chaque jour).
  const ok = view({
    eligibleDates: ["2026-10-20", "2026-10-22"],
    offers: { "2026-10-20": [slot("morning", "09:00", "12:00")], "2026-10-22": [slot("morning", "09:00", "12:00")] },
  });
  assert.deepEqual(scheduleRequirement(ok), { kind: "choose", slotMode: "fixed_slots" });
  // Date dupliquée.
  assertBlocked(view({ eligibleDates: ["2026-10-20", "2026-10-20"] }), "ambiguous", "date dupliquée");
  // Fenêtres qui se chevauchent le même jour : une heure aurait deux fins possibles.
  const overlap = view({
    slotSelectionMode: "time_within_window", timeGranularityMinutes: 30,
    offers: { "2026-10-20": [slot(null, "09:00", "11:00"), slot(null, "10:00", "12:00")] },
  });
  assertBlocked(overlap, "ambiguous", "fenêtres chevauchantes");
  // Deux fenêtres DISJOINTES restent valides.
  const disjoint = view({
    slotSelectionMode: "time_within_window", timeGranularityMinutes: 30,
    offers: { "2026-10-20": [slot(null, "09:00", "11:00"), slot(null, "14:00", "16:00")] },
  });
  assert.deepEqual(scheduleRequirement(disjoint), { kind: "choose", slotMode: "time_within_window" });
  const p = toSchedulePayload(disjoint, scheduleRequirement(disjoint), { date: "2026-10-20", slotKey: null, time: "14:30" });
  assert.deepEqual(p, { date: "2026-10-20", slot_key: null, starts_at: "14:30", ends_at: "16:00" });
});

test("[158-R2-P2] dates IMPOSSIBLES refusées, jamais normalisées ; dates valides acceptées (années bissextiles comprises)", () => {
  for (const bad of ["2026-02-31", "2026-04-31", "2025-02-29", "1900-02-29", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "2026-6-01", "2026-10-1", "20261020", ""]) {
    assert.equal(isIsoDate(bad), false, bad);
  }
  for (const good of ["2026-10-20", "2028-02-29", "2000-02-29", "2026-12-31", "2026-01-01", "2026-04-30"]) {
    assert.equal(isIsoDate(good), true, good);
  }
  for (const bad of ["2026-02-31", "2026-04-31", "2025-02-29"]) {
    assertBlocked(view({ firstEligibleDate: bad, eligibleDates: [bad], offers: { [bad]: [slot("morning", "09:00", "12:00")] } }), "date", `éligible ${bad}`);
  }
  // Date impossible mêlée à des dates valides, ou seulement dans les offres / la première date.
  assertBlocked(view({ eligibleDates: ["2026-10-20", "2026-02-31"] }), "date", "mêlée");
  assertBlocked(view({ offers: { "2026-10-20": [slot("morning", "09:00", "12:00")], "2026-02-31": [slot("x", "09:00", "10:00")] } }), "date", "clé d'offre");
  assertBlocked(view({ firstEligibleDate: "2026-02-31" }), "date", "première date");
  // Le mapping ne normalise rien : la valeur reste telle que reçue.
  const mapped = mapCheckoutScheduleResponse([{
    schedule_status: "dates_available", date_selection_mode: "customer_selectable", slot_selection_mode: "none",
    first_eligible_date: "2026-02-31", eligible_dates: ["2026-02-31"],
    offers: { "2026-02-31": [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }] },
  }]);
  assert.deepEqual(mapped.eligibleDates, ["2026-02-31"]);
  assert.equal(scheduleRequirement(mapped).kind, "unreadable");
  // Dérivation : une date serveur impossible n'est jamais envoyée.
  assertBlocked(view({ dateSelectionMode: "derived_earliest", slotSelectionMode: "none", firstEligibleDate: "2026-02-31", eligibleDates: ["2026-02-31"], offers: {} }), "date", "dérivée impossible");
});

test("[158-R2-P3] intervalles dont la fin PRÉCÈDE (ou égale) le début : refusés, tous modes", () => {
  assertBlocked(view({ offers: { "2026-10-20": [slot("morning", "09:00", "12:00"), slot("afternoon", "14:00", "09:00")] } }), "interval", "créneau inversé");
  assertBlocked(view({ offers: { "2026-10-20": [slot("afternoon", "14:00", "14:00")] } }), "interval", "créneau de durée nulle");
  assertBlocked(view({ slotSelectionMode: "time_within_window", timeGranularityMinutes: 30, offers: { "2026-10-20": [slot(null, "18:00", "09:00")] } }), "interval", "fenêtre inversée");
  assertBlocked(view({ slotSelectionMode: "none", offers: { "2026-10-20": [slot(null, "18:00", "09:00")] } }), "interval", "date seule inversée");
  assertBlocked(view({ dateSelectionMode: "derived_earliest", slotSelectionMode: "none", offers: { "2026-10-20": [slot(null, "18:00", "09:00")] } }), "interval", "dérivée inversée");
  // Un intervalle d'une minute reste valide.
  assert.deepEqual(scheduleRequirement(view({ offers: { "2026-10-20": [slot("m", "09:00", "09:01")] } })), { kind: "choose", slotMode: "fixed_slots" });
});

test("[158-R2-P4] politique INCONNUE pour dériver la date ou le créneau : bloqué ; politiques connues inchangées", () => {
  const derived = (patch: Partial<CheckoutScheduleView>) =>
    view({ dateSelectionMode: "derived_earliest", slotSelectionMode: "none", offers: { "2026-10-20": [slot(null, "09:00", "18:00")] }, ...patch });
  assert.deepEqual(scheduleRequirement(derived({})), { kind: "derived", date: "2026-10-20" });
  assertBlocked(derived({ slotSelectionMode: "weird" }), "policy", "derived + créneau inconnu");
  assertBlocked(derived({ slotSelectionMode: null }), "policy", "derived + créneau absent");
  assertBlocked(derived({ slotSelectionMode: "fixed_slots" }), "policy", "derived + fixed_slots");
  assertBlocked(derived({ slotSelectionMode: "time_within_window", timeGranularityMinutes: 30 }), "policy", "derived + fenêtre");
  assertBlocked(view({ dateSelectionMode: "weird" }), "policy", "date inconnue");
  assertBlocked(view({ dateSelectionMode: null }), "policy", "date absente");
  assertBlocked(view({ dateSelectionMode: "informational_only" }), "policy", "informatif avec dates");
  assertBlocked(view({ slotSelectionMode: "weird" }), "policy", "créneau inconnu");
  assertBlocked(view({ slotSelectionMode: null }), "policy", "créneau absent");
  assertBlocked(view({ slotSelectionMode: "time_within_window", timeGranularityMinutes: null, offers: { "2026-10-20": [slot(null, "09:00", "10:30")] } }), "policy", "fenêtre sans granularité");
  assertBlocked(view({ slotSelectionMode: "time_within_window", timeGranularityMinutes: 0, offers: { "2026-10-20": [slot(null, "09:00", "10:30")] } }), "policy", "granularité nulle");
});

test("[158-R2-P5] chaque raison a une explication traduite FR/EN/NL/AR, distincte du message générique", () => {
  const reasons = ["response", "ambiguous", "date", "interval", "policy"] as const;
  const keys = reasons.map((r) => unreadableMessageKey(r));
  assert.equal(new Set(keys).size, reasons.length, "une clé par raison");
  for (const lang of ["fr", "en", "nl", "ar"] as const) {
    for (const k of keys) {
      const own = (DICTS[lang] as Record<string, string>)[k];
      assert.ok(typeof own === "string" && own.length > 20, `${lang}.${k}`);
      assert.notEqual(translate(lang, k), k);
    }
  }
});
