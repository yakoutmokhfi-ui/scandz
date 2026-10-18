import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SCHEDULE_SELECTION,
  isSelectionOffered,
  reconcileSelection,
  scheduleAllowsSubmit,
  scheduleRequirement,
  toSchedulePayload,
  windowTimes,
  type CheckoutScheduleView,
} from "../lib/checkout-schedule/model.ts";
import { mapCheckoutScheduleRow } from "../lib/checkout-schedule/map-row.ts";
import { buildCreateOrderPayload } from "../lib/services/order-payload.ts";
import {
  SCHEDULE_ORDER_ERROR_CLASSES,
  ScheduleSelectionError,
  scheduleOrderErrorCode,
} from "../lib/services/order-error.ts";
import { DICTS, translate } from "../lib/i18n.ts";

// ====================================================================
// CSDJ-2 / issue #158 -- logique PURE du choix de date/créneau au
// checkout. Aucun DOM, aucun réseau, aucune base. Le format de
// `p_customer.schedule` est celui du contrat CSDJ v1.2 §5.1.
// ====================================================================

const base: CheckoutScheduleView = {
  status: "dates_available",
  unfulfillableReason: null,
  timezone: "Europe/Paris",
  dateSelectionMode: "customer_selectable",
  slotSelectionMode: "fixed_slots",
  timeGranularityMinutes: null,
  firstEligibleDate: "2026-10-20",
  eligibleDates: ["2026-10-20", "2026-10-22"],
  offers: {
    "2026-10-20": [
      { slotKey: "morning", startsAt: "09:00", endsAt: "12:00" },
      { slotKey: "afternoon", startsAt: "14:00", endsAt: "18:00" },
    ],
    "2026-10-22": [{ slotKey: "morning", startsAt: "09:00", endsAt: "12:00" }],
  },
};
const dateOnly: CheckoutScheduleView = {
  ...base,
  slotSelectionMode: "none",
  offers: {
    "2026-10-20": [{ slotKey: null, startsAt: "09:00", endsAt: "18:00" }],
    "2026-10-22": [{ slotKey: null, startsAt: "09:00", endsAt: "18:00" }],
  },
};
const windowed: CheckoutScheduleView = {
  ...base,
  slotSelectionMode: "time_within_window",
  timeGranularityMinutes: 30,
  offers: {
    "2026-10-20": [{ slotKey: null, startsAt: "09:00", endsAt: "10:30" }],
    "2026-10-22": [{ slotKey: null, startsAt: "09:00", endsAt: "10:30" }],
  },
};
const derived: CheckoutScheduleView = {
  ...base,
  dateSelectionMode: "derived_earliest",
  slotSelectionMode: "none",
  offers: { "2026-10-20": [{ slotKey: null, startsAt: "09:00", endsAt: "18:00" }], "2026-10-22": [] },
};
const none = (status: string): CheckoutScheduleView => ({
  ...base, status, dateSelectionMode: null, slotSelectionMode: null,
  firstEligibleDate: null, eligibleDates: [], offers: {},
});

test("[158-1] fixed_slots : exigence 'choose', payload EXACT du contrat (date, slot_key, starts_at, ends_at)", () => {
  const req = scheduleRequirement(base);
  assert.deepEqual(req, { kind: "choose", slotMode: "fixed_slots" });
  const sel = { date: "2026-10-20", slotKey: "afternoon", time: null };
  assert.deepEqual(toSchedulePayload(base, req, sel), {
    date: "2026-10-20", slot_key: "afternoon", starts_at: "14:00", ends_at: "18:00",
  });
});

test("[158-2] fixed_slots : sans sélection ou sélection incomplète => AUCUN payload, envoi fermé", () => {
  const req = scheduleRequirement(base);
  assert.equal(toSchedulePayload(base, req, EMPTY_SCHEDULE_SELECTION), null);
  assert.equal(toSchedulePayload(base, req, { date: "2026-10-20", slotKey: null, time: null }), null);
  assert.equal(scheduleAllowsSubmit(base, EMPTY_SCHEDULE_SELECTION), false);
  assert.equal(scheduleAllowsSubmit(base, { date: "2026-10-20", slotKey: "morning", time: null }), true);
});

test("[158-3] jamais de valeur forgée : date ou créneau hors offres du serveur refusés", () => {
  const req = scheduleRequirement(base);
  for (const sel of [
    { date: "2026-10-21", slotKey: "morning", time: null },        // date non proposée
    { date: "2026-10-22", slotKey: "afternoon", time: null },      // créneau non offert CE jour-là
    { date: "2026-10-20", slotKey: "night", time: null },          // créneau inconnu
    { date: "2026-10-20", slotKey: "morning", time: "09:30" },     // heure parasite en fixed_slots
  ]) {
    assert.equal(isSelectionOffered(base, req, sel), false, JSON.stringify(sel));
    assert.equal(toSchedulePayload(base, req, sel), null, JSON.stringify(sel));
  }
});

test("[158-4] date seule (slot none) : payload date + trois null", () => {
  const req = scheduleRequirement(dateOnly);
  assert.deepEqual(req, { kind: "choose", slotMode: "none" });
  assert.deepEqual(toSchedulePayload(dateOnly, req, { date: "2026-10-22", slotKey: null, time: null }), {
    date: "2026-10-22", slot_key: null, starts_at: null, ends_at: null,
  });
  assert.equal(toSchedulePayload(dateOnly, req, EMPTY_SCHEDULE_SELECTION), null);
});

test("[158-5] time_within_window : grille dérivée de l'offre serveur, pas de fin incluse, payload starts_at = heure choisie", () => {
  const offer = windowed.offers["2026-10-20"][0];
  assert.deepEqual(windowTimes(offer, 30), ["09:00", "09:30", "10:00"]);
  const req = scheduleRequirement(windowed);
  assert.deepEqual(toSchedulePayload(windowed, req, { date: "2026-10-20", slotKey: null, time: "09:30" }), {
    date: "2026-10-20", slot_key: null, starts_at: "09:30", ends_at: "10:30",
  });
  assert.equal(toSchedulePayload(windowed, req, { date: "2026-10-20", slotKey: null, time: "10:30" }), null);
  assert.equal(toSchedulePayload(windowed, req, { date: "2026-10-20", slotKey: null, time: "09:15" }), null);
});

test("[158-6] derived_earliest : le serveur dérive la date, le client n'a rien à choisir, payload = date serveur", () => {
  const req = scheduleRequirement(derived);
  assert.deepEqual(req, { kind: "derived", date: "2026-10-20" });
  assert.equal(scheduleAllowsSubmit(derived, EMPTY_SCHEDULE_SELECTION), true);
  assert.deepEqual(toSchedulePayload(derived, req, EMPTY_SCHEDULE_SELECTION), {
    date: "2026-10-20", slot_key: null, starts_at: null, ends_at: null,
  });
});

test("[158-7] sans calendrier / désactivé / information seule / livraison refusée en amont : RIEN à demander, RIEN à envoyer", () => {
  for (const status of ["absent", "informational_only", "blocked_upstream"]) {
    const v = none(status);
    const req = scheduleRequirement(v);
    assert.deepEqual(req, { kind: "none" }, status);
    assert.equal(toSchedulePayload(v, req, EMPTY_SCHEDULE_SELECTION), null, status);
    assert.equal(scheduleAllowsSubmit(v, EMPTY_SCHEDULE_SELECTION), true, status);
  }
});

test("[158-8] unfulfillable : échec CLAIR (bloqué), aucune date inventée", () => {
  const v = { ...none("unfulfillable"), unfulfillableReason: "no_eligible_date" };
  assert.deepEqual(scheduleRequirement(v), { kind: "blocked", reason: "no_eligible_date" });
  assert.equal(scheduleAllowsSubmit(v, EMPTY_SCHEDULE_SELECTION), false);
  assert.equal(toSchedulePayload(v, scheduleRequirement(v), EMPTY_SCHEDULE_SELECTION), null);
});

test("[158-9] statut/politique inconnus ou réponse incohérente : fail-closed 'unreadable'", () => {
  assert.equal(scheduleRequirement({ ...base, status: "future_status" }).kind, "unreadable");
  assert.equal(scheduleRequirement({ ...base, dateSelectionMode: "weird" }).kind, "unreadable");
  assert.equal(scheduleRequirement({ ...base, eligibleDates: [] }).kind, "unreadable");
  assert.equal(scheduleRequirement({ ...base, eligibleDates: ["20/10/2026"] }).kind, "unreadable");
  assert.equal(scheduleRequirement({ ...base, offers: { "2026-10-20": [], "2026-10-22": [] } }).kind, "unreadable");
  assert.equal(scheduleRequirement({ ...windowed, timeGranularityMinutes: 0 }).kind, "unreadable");
  assert.equal(scheduleAllowsSubmit({ ...base, status: "future_status" }, EMPTY_SCHEDULE_SELECTION), false);
});

test("[158-10] relecture : la sélection est gardée si le serveur la propose encore, sinon vidée (date expirée / créneau retiré)", () => {
  const sel = { date: "2026-10-20", slotKey: "afternoon", time: null };
  assert.deepEqual(reconcileSelection(base, sel), sel);
  // le créneau disparaît mais la date reste
  const slotGone = { ...base, offers: { ...base.offers, "2026-10-20": [base.offers["2026-10-20"][0]] } };
  assert.deepEqual(reconcileSelection(slotGone, sel), { date: "2026-10-20", slotKey: null, time: null });
  // la date expire
  const dateGone = { ...base, eligibleDates: ["2026-10-22"], offers: { "2026-10-22": base.offers["2026-10-22"] } };
  assert.deepEqual(reconcileSelection(dateGone, sel), EMPTY_SCHEDULE_SELECTION);
  // pas de vue / plus de choix
  assert.deepEqual(reconcileSelection(null, sel), EMPTY_SCHEDULE_SELECTION);
  assert.deepEqual(reconcileSelection(none("absent"), sel), EMPTY_SCHEDULE_SELECTION);
});

// -------------------- payload create_order --------------------
const LINES = [
  { item: { id: "11111111-1111-4111-8111-111111111111" }, quantity: 1, option: null },
] as unknown as Parameters<typeof buildCreateOrderPayload>[0]["lines"];
const CUSTOMER = {
  firstName: "", lastName: "", name: "Yakout", phone: "0612345678", email: "",
  street: "", postalCode: "", city: "", floor: "", door: "", notes: "",
} as unknown as Parameters<typeof buildCreateOrderPayload>[0]["context"] extends infer C
  ? C extends { customer: infer K } ? K : never : never;
const SCHEDULE = { date: "2026-10-20", slot_key: "afternoon", starts_at: "14:00", ends_at: "18:00" };

test("[158-11] retrait : `p_customer.schedule` transmis tel quel ; sans schedule la charge est celle d'AVANT (aucune clé schedule)", () => {
  const withSchedule = buildCreateOrderPayload({
    slug: "aulaitcru", context: { mode: "pickup", customer: CUSTOMER }, lines: LINES, lang: "fr", schedule: SCHEDULE,
  });
  assert.deepEqual((withSchedule.p_customer as any).schedule, SCHEDULE);
  const without = buildCreateOrderPayload({
    slug: "aulaitcru", context: { mode: "pickup", customer: CUSTOMER }, lines: LINES, lang: "fr",
  });
  assert.ok(!("schedule" in (without.p_customer as object)), "aucune clé schedule sans sélection");
  const nulled = buildCreateOrderPayload({
    slug: "aulaitcru", context: { mode: "pickup", customer: CUSTOMER }, lines: LINES, lang: "fr", schedule: null,
  });
  assert.deepEqual(nulled, without);
});

test("[158-12] mode TABLE : jamais de schedule, p_customer reste strictement vide (contrat §5.1)", () => {
  const p = buildCreateOrderPayload({
    slug: "aulaitcru", context: { mode: "table", tableNumber: 3 } as any, lines: LINES, lang: "fr", schedule: SCHEDULE,
  });
  assert.deepEqual(p.p_customer, {});
});

test("[158-13] livraison : schedule transmis en plus des champs de livraison existants", () => {
  const p = buildCreateOrderPayload({
    slug: "aulaitcru",
    context: { mode: "delivery", zoneLabel: "Paris", customer: { ...CUSTOMER, street: "10 rue de Rivoli", postalCode: "75001", city: "Paris" } } as any,
    lines: LINES, lang: "fr", schedule: SCHEDULE, deliveryCountryCode: "fr",
  });
  const c = p.p_customer as any;
  assert.deepEqual(c.schedule, SCHEDULE);
  assert.equal(c.postalCode, "75001");
  assert.equal(c.country, "FR");
});

// -------------------- erreurs typées --------------------
test("[158-14] erreurs SCANYM_SCHEDULE_* : exigées P0001 ET message exact ; classes du contrat", () => {
  for (const code of Object.keys(SCHEDULE_ORDER_ERROR_CLASSES)) {
    assert.equal(scheduleOrderErrorCode({ code: "P0001", message: code }), code);
    assert.equal(scheduleOrderErrorCode({ code: "23505", message: code }), null, "mauvais SQLSTATE");
    assert.equal(scheduleOrderErrorCode({ code: "P0001", message: `x ${code}` }), null, "message non exact");
  }
  assert.equal(scheduleOrderErrorCode({ code: "P0001", message: "SCANYM_SCHEDULE_UNKNOWN" }), null);
  assert.equal(scheduleOrderErrorCode(null), null);
  assert.equal(new ScheduleSelectionError("SCANYM_SCHEDULE_REQUIRED").kind, "choose");
  assert.equal(new ScheduleSelectionError("SCANYM_SCHEDULE_MALFORMED").kind, "reselect");
  for (const c of ["UNFULFILLABLE", "NOT_SELECTABLE", "NOT_OFFERED", "DATE_NOT_ELIGIBLE", "SLOT_INVALID", "TIME_INVALID", "SLOT_FULL"]) {
    assert.equal(new ScheduleSelectionError(`SCANYM_SCHEDULE_${c}` as any).kind, "refresh", c);
  }
});

// -------------------- lecture --------------------
test("[158-15] mapCheckoutScheduleRow : mapping snake_case -> modèle, statut absent => 'absent' (jamais une disponibilité)", () => {
  const v = mapCheckoutScheduleRow({
    schedule_status: "dates_available", schedule_timezone: "Europe/Paris",
    date_selection_mode: "customer_selectable", slot_selection_mode: "fixed_slots",
    first_eligible_date: "2026-10-20", eligible_dates: ["2026-10-20"],
    offers: { "2026-10-20": [{ slot_key: "morning", starts_at: "09:00", ends_at: "12:00" }] },
  });
  assert.equal(v.status, "dates_available");
  assert.deepEqual(v.offers["2026-10-20"], [{ slotKey: "morning", startsAt: "09:00", endsAt: "12:00" }]);
  assert.equal(scheduleRequirement(v).kind, "choose");
  assert.equal(mapCheckoutScheduleRow(null).status, "absent");
  assert.equal(mapCheckoutScheduleRow({}).status, "absent");
});

// -------------------- textes --------------------
test("[158-16] textes : toutes les clés chkSchedule* présentes en FR/EN/NL/AR, jamais la clé brute", () => {
  const keys = Object.keys(DICTS.fr).filter((k) => k.startsWith("chkSchedule"));
  assert.ok(keys.length >= 16);
  for (const lang of ["fr", "en", "nl", "ar"] as const) {
    for (const k of keys) {
      const own = (DICTS[lang] as Record<string, string>)[k];
      assert.ok(typeof own === "string" && own.length > 0, `${lang}.${k} manquante`);
      assert.notEqual(translate(lang, k), k);
    }
    assert.ok(translate(lang, "chkScheduleDerived", { date: "X" }).includes("X"), `${lang} param date`);
  }
  assert.notEqual(DICTS.en.chkScheduleChooseHint, DICTS.fr.chkScheduleChooseHint);
  assert.notEqual(DICTS.nl.chkScheduleChooseHint, DICTS.fr.chkScheduleChooseHint);
  assert.notEqual(DICTS.ar.chkScheduleChooseHint, DICTS.fr.chkScheduleChooseHint);
});
