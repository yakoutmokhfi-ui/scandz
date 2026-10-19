import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SCHEDULE_SELECTION,
  scheduleAllowsSubmit,
  scheduleRequirement,
  toSchedulePayload,
  type CheckoutScheduleView,
  type ScheduleRequirement,
} from "../lib/checkout-schedule/model.ts";
import { mapCheckoutScheduleResponse } from "../lib/checkout-schedule/map-row.ts";

// ====================================================================
// CSDJ2-R3-01 (P2) -- contre-audit Turing, HEAD 427c395 : la branche
// `derived_earliest` (créneau « none ») retournait « derived » AVANT de
// valider les offres. Une date dérivée n'est une disponibilité que si le
// serveur a rendu, pour CETTE date, au moins une offre bien formée
// (heures strictes HH:MM, fin strictement après le début).
// ====================================================================

const slot = (slotKey: string | null, startsAt: string, endsAt: string) => ({ slotKey, startsAt, endsAt });
const derivedView = (patch: Partial<CheckoutScheduleView> = {}): CheckoutScheduleView => ({
  status: "dates_available",
  unfulfillableReason: null,
  timezone: "Europe/Paris",
  dateSelectionMode: "derived_earliest",
  slotSelectionMode: "none",
  timeGranularityMinutes: null,
  firstEligibleDate: "2026-10-24",
  eligibleDates: ["2026-10-24"],
  offers: { "2026-10-24": [slot(null, "09:00", "18:00")] },
  ...patch,
});
const unreadable = (reason: string): ScheduleRequirement => ({ kind: "unreadable", reason } as ScheduleRequirement);

function assertClosed(v: CheckoutScheduleView, reason: string, label: string) {
  assert.deepEqual(scheduleRequirement(v), unreadable(reason), label);
  assert.equal(scheduleAllowsSubmit(v, EMPTY_SCHEDULE_SELECTION), false, `${label}: envoi fermé`);
  assert.equal(toSchedulePayload(v, scheduleRequirement(v), EMPTY_SCHEDULE_SELECTION), null, `${label}: aucun payload`);
}

test("[158-R3-P1] dérivée valide : exigence « derived », payload DATE SEULE conforme au contrat", () => {
  const v = derivedView();
  assert.deepEqual(scheduleRequirement(v), { kind: "derived", date: "2026-10-24" });
  assert.equal(scheduleAllowsSubmit(v, EMPTY_SCHEDULE_SELECTION), true);
  assert.deepEqual(toSchedulePayload(v, scheduleRequirement(v), EMPTY_SCHEDULE_SELECTION), {
    date: "2026-10-24", slot_key: null, starts_at: null, ends_at: null,
  });
  // Plusieurs offres bien formées, bornes adjacentes, minute unique, 00:00–23:59 : toujours valides.
  for (const offers of [
    { "2026-10-24": [slot(null, "09:00", "12:00"), slot(null, "12:00", "18:00")] },
    { "2026-10-24": [slot(null, "09:00", "09:01")] },
    { "2026-10-24": [slot(null, "00:00", "23:59")] },
  ]) {
    assert.deepEqual(scheduleRequirement(derivedView({ offers })), { kind: "derived", date: "2026-10-24" });
  }
});

test("[158-R3-P2] cas Turing : offres absentes (null / {} / liste vide / autre date) => date dérivée NON disponible", () => {
  // Le mapper transforme `offers:null` en objet vide : on teste aussi la réponse BRUTE.
  const raw = (offers: unknown) => mapCheckoutScheduleResponse([{
    schedule_status: "dates_available", schedule_timezone: "Europe/Paris",
    date_selection_mode: "derived_earliest", slot_selection_mode: "none",
    first_eligible_date: "2026-10-24", eligible_dates: ["2026-10-24"], offers,
  }]);
  assertClosed(raw(null), "response", "offers:null");
  assertClosed(raw(undefined), "response", "offers absent");
  assertClosed(raw({}), "response", "offers:{}");
  assertClosed(raw({ "2026-10-24": [] }), "response", "liste vide");
  assertClosed(raw({ "2026-10-24": "x" }), "response", "liste non tableau");
  assertClosed(raw({ "2026-10-26": [{ slot_key: null, starts_at: "09:00", ends_at: "18:00" }] }), "response", "offres d'une autre date seulement");
});

test("[158-R3-P3] offres mal formées : heures hors format, secondes, vides, 24:00, clé de créneau => fermé", () => {
  const bad: Array<[string, ReturnType<typeof slot>[]]> = [
    ["25:00 -> 09:00 (cas Turing)", [slot(null, "25:00", "09:00")]],
    ["24:00", [slot(null, "09:00", "24:00")]],
    ["60 minutes", [slot(null, "09:60", "18:00")]],
    ["secondes ordonnées", [slot(null, "09:00:00", "18:00:00")]],
    ["secondes inversées (18:00:00 -> 09:00:00)", [slot(null, "18:00:00", "09:00:00")]],
    ["vide", [slot(null, "", "")]],
    ["un seul chiffre", [slot(null, "9:00", "18:00")]],
    ["bonne + mal formée", [slot(null, "09:00", "12:00"), slot(null, "25:00", "26:00")]],
    ["clé de créneau alors que la politique est « none »", [slot("morning", "09:00", "12:00")]],
  ];
  for (const [label, list] of bad) {
    assertClosed(derivedView({ offers: { "2026-10-24": list } }), "response", label);
  }
});

test("[158-R3-P4] bornes strictes inversées ou égales => raison « interval » (déjà fermé, conservé)", () => {
  assertClosed(derivedView({ offers: { "2026-10-24": [slot(null, "18:00", "09:00")] } }), "interval", "inversé");
  assertClosed(derivedView({ offers: { "2026-10-24": [slot(null, "09:00", "09:00")] } }), "interval", "durée nulle");
});

test("[158-R3-P5] l'exigence « derived » est atteinte APRÈS validation : aucune autre branche ne la précède", () => {
  // date dérivée absente des dates éligibles, politique de créneau != none, date impossible : toujours fermé.
  assertClosed(derivedView({ eligibleDates: ["2026-10-26"], offers: { "2026-10-26": [slot(null, "09:00", "18:00")] } }), "response", "date dérivée hors liste");
  assertClosed(derivedView({ slotSelectionMode: "fixed_slots" }), "policy", "créneau != none");
  assertClosed(derivedView({ firstEligibleDate: "2026-02-31", eligibleDates: ["2026-02-31"], offers: { "2026-02-31": [slot(null, "09:00", "18:00")] } }), "date", "date impossible");
  // Dates bissextiles réelles toujours acceptées.
  for (const d of ["2000-02-29", "2028-02-29", "2400-02-29"]) {
    assert.deepEqual(scheduleRequirement(derivedView({ firstEligibleDate: d, eligibleDates: [d], offers: { [d]: [slot(null, "09:00", "18:00")] } })), { kind: "derived", date: d }, d);
  }
});
