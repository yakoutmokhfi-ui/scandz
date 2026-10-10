import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECKOUT_DATE_SELECTION_MODES,
  CHECKOUT_SCHEDULE_STATUSES,
  CHECKOUT_SLOT_SELECTION_MODES,
  CHECKOUT_UNFULFILLABLE_REASONS,
  SCHEDULE_SLOT_KEY_MAX_LENGTH,
  formatScheduleTime,
  isCheckoutDateSelectionMode,
  isCheckoutScheduleStatus,
  isCheckoutSlotSelectionMode,
  isCheckoutUnfulfillableReason,
  isSchedulePolicyCoherent,
  isScheduleSlotKey,
  isScheduleTime,
  isScheduleWeekday,
  parseScheduleTime,
} from "../lib/scheduling/schedule-model.ts";

/**
 * Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)
 * Catalogues fermés et gardes de type.
 *
 * Ces tests ne décrivent pas un comportement métier : ils vérifient
 * qu'une valeur hors catalogue est RECONNUE comme hors catalogue. C'est
 * la condition pour que le reste du lot puisse refuser plutôt que
 * deviner.
 */

test("[MODEL-1] les quatre catalogues sont fermés, ordonnés et sans doublon", () => {
  for (const [name, list] of [
    ["date", CHECKOUT_DATE_SELECTION_MODES],
    ["slot", CHECKOUT_SLOT_SELECTION_MODES],
    ["status", CHECKOUT_SCHEDULE_STATUSES],
    ["reason", CHECKOUT_UNFULFILLABLE_REASONS],
  ] as const) {
    assert.equal(
      new Set(list).size,
      list.length,
      `${name} : doublon dans le catalogue`
    );
    for (const v of list) {
      assert.match(v, /^[a-z][a-z0-9_]*$/, `${name} : ${v} n'est pas une clé stable`);
    }
  }
  assert.deepEqual(CHECKOUT_DATE_SELECTION_MODES.length, 3);
  assert.deepEqual(CHECKOUT_SLOT_SELECTION_MODES.length, 3);
  assert.deepEqual(CHECKOUT_SCHEDULE_STATUSES.length, 5);
  // Cinq depuis la remédiation : `no_offer_in_horizon` distingue
  // « des dates ouvertes mais aucune offre réalisable » de
  // « la première date possible est au-delà de l'horizon ».
  assert.deepEqual(CHECKOUT_UNFULFILLABLE_REASONS.length, 5);
});

test("[MODEL-2] les statuts porteurs des deux invariants existent", () => {
  // `absent` porte CSDJ-V1-SCHEDULE-ABSENT-01, `unfulfillable` porte
  // CSDJ-V1-UNFULFILLABLE-EXPLICIT-01. Les renommer sans y penser
  // casserait les deux invariants en silence.
  assert.ok(CHECKOUT_SCHEDULE_STATUSES.includes("absent"));
  assert.ok(CHECKOUT_SCHEDULE_STATUSES.includes("unfulfillable"));
  assert.ok(CHECKOUT_SCHEDULE_STATUSES.includes("blocked_upstream"));
});

test("[MODEL-3] les gardes refusent tout ce qui n'est pas au catalogue", () => {
  assert.equal(isCheckoutDateSelectionMode("customer_selectable"), true);
  assert.equal(isCheckoutDateSelectionMode("CUSTOMER_SELECTABLE"), false);
  assert.equal(isCheckoutDateSelectionMode("asap"), false);
  assert.equal(isCheckoutDateSelectionMode(null), false);
  assert.equal(isCheckoutDateSelectionMode(undefined), false);
  assert.equal(isCheckoutDateSelectionMode(1), false);
  assert.equal(isCheckoutDateSelectionMode({}), false);

  assert.equal(isCheckoutSlotSelectionMode("fixed_slots"), true);
  assert.equal(isCheckoutSlotSelectionMode("slots"), false);

  assert.equal(isCheckoutScheduleStatus("dates_available"), true);
  assert.equal(isCheckoutScheduleStatus("ok"), false);

  assert.equal(isCheckoutUnfulfillableReason("all_dates_closed"), true);
  assert.equal(isCheckoutUnfulfillableReason("closed"), false);
});

test("[MODEL-4] une garde ne se laisse pas tromper par la chaîne de prototypes", () => {
  // `"constructor"` et `"toString"` sont des propriétés héritées de tout
  // objet : une garde écrite avec `in` ou `[]` les accepterait.
  assert.equal(isCheckoutDateSelectionMode("constructor"), false);
  assert.equal(isCheckoutSlotSelectionMode("toString"), false);
  assert.equal(isCheckoutScheduleStatus("__proto__"), false);
  assert.equal(isCheckoutUnfulfillableReason("hasOwnProperty"), false);
});

test("[MODEL-5] cohérence des deux politiques : pas d'heure sans date", () => {
  assert.equal(isSchedulePolicyCoherent("customer_selectable", "none"), true);
  assert.equal(isSchedulePolicyCoherent("customer_selectable", "fixed_slots"), true);
  assert.equal(
    isSchedulePolicyCoherent("customer_selectable", "time_within_window"),
    true
  );
  // Le client ne choisit pas la date : il ne peut pas choisir l'heure.
  assert.equal(isSchedulePolicyCoherent("derived_earliest", "fixed_slots"), false);
  assert.equal(
    isSchedulePolicyCoherent("derived_earliest", "time_within_window"),
    false
  );
  assert.equal(isSchedulePolicyCoherent("informational_only", "fixed_slots"), false);
  // Sans sélection d'heure, toutes les politiques de date sont valides.
  assert.equal(isSchedulePolicyCoherent("derived_earliest", "none"), true);
  assert.equal(isSchedulePolicyCoherent("informational_only", "none"), true);
});

test("[MODEL-6] jour de semaine : 0 à 6, entiers seulement", () => {
  for (const d of [0, 1, 2, 3, 4, 5, 6]) assert.equal(isScheduleWeekday(d), true);
  for (const d of [-1, 7, 1.5, NaN, Infinity, "3", null, undefined]) {
    assert.equal(isScheduleWeekday(d), false, `${String(d)} ne doit pas passer`);
  }
});

test("[MODEL-7] clé de créneau : forme étroite, pour n'avoir jamais à l'échapper", () => {
  for (const k of ["11-14", "matin", "slot_1", "a", "17-20"]) {
    assert.equal(isScheduleSlotKey(k), true, k);
  }
  for (const k of [
    "",
    "11 14",
    "Matin",
    "créneau",
    "11/14",
    "<script>",
    "a".repeat(SCHEDULE_SLOT_KEY_MAX_LENGTH + 1),
    null,
    42,
  ]) {
    assert.equal(isScheduleSlotKey(k), false, `${String(k)} ne doit pas passer`);
  }
  assert.equal(isScheduleSlotKey("a".repeat(SCHEDULE_SLOT_KEY_MAX_LENGTH)), true);
});

test("[MODEL-8] lecture d'heure : la MINUTE, et rien de plus fin", () => {
  // CSDJ-V1-MINUTE-PRECISION-01, ferme CSDJ1-AUD-04.
  assert.equal(parseScheduleTime("00:00"), 0);
  assert.equal(parseScheduleTime("16:00"), 960);
  assert.equal(parseScheduleTime("19:30"), 1170);
  assert.equal(parseScheduleTime("23:59"), 1439);
  // psql rend un `time` en HH:MM:SS : il faut savoir le lire, et des
  // secondes NULLES sont admissibles.
  assert.equal(parseScheduleTime("16:00:00"), 960);
  // Mais des secondes NON nulles sont REFUSÉES, jamais tronquées :
  // tronquer 09:00:30-09:00:59 produirait une offre de durée nulle
  // affichée comme disponible -- le défaut CSDJ1-AUD-04.
  assert.equal(parseScheduleTime("16:00:30"), null);
  assert.equal(parseScheduleTime("16:00:59"), null);
  assert.equal(parseScheduleTime("16:00:01"), null);
  // Une fraction de seconde non nulle est refusée aussi.
  assert.equal(parseScheduleTime("16:00:00.500"), null);
  assert.equal(parseScheduleTime("16:00:00.000"), 960);
  // 24:00 est refusé : une fenêtre qui finit « à minuit » se déclare
  // 23:59, sinon chaque comparaison devrait connaître ce cas
  // (CSDJ-V1-NO-24H-01).
  assert.equal(parseScheduleTime("24:00"), null);
  assert.equal(parseScheduleTime("24:00:00"), null);
  for (const v of ["", "6:00", "16h00", "16:60", "25:00", "abcd", null, 960, {}]) {
    assert.equal(parseScheduleTime(v), null, `${String(v)} ne doit pas passer`);
  }
});

test("[MODEL-10] isScheduleTime refuse exactement ce que parseScheduleTime refuse", () => {
  for (const v of ["09:00", "09:00:00", "23:59"]) {
    assert.equal(isScheduleTime(v), true, String(v));
  }
  for (const v of ["09:00:30", "24:00", "9:00", "", null]) {
    assert.equal(isScheduleTime(v), false, String(v));
  }
});

test("[MODEL-9] écriture d'heure : aller-retour stable", () => {
  for (const m of [0, 1, 659, 960, 1170, 1439]) {
    assert.equal(parseScheduleTime(formatScheduleTime(m)), m);
  }
  assert.equal(formatScheduleTime(0), "00:00");
  assert.equal(formatScheduleTime(960), "16:00");
  assert.equal(formatScheduleTime(1170), "19:30");
});
