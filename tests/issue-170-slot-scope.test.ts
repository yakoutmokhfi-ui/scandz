import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SCHEDULE_SELECTION,
  EMPTY_SCOPED_SCHEDULE_SELECTION,
  checkoutScheduleScope,
  reconcileScopedSelection,
  reconcileSelection,
  scheduleAllowsSubmit,
  selectionInScope,
  type CheckoutScheduleView,
} from "../lib/checkout-schedule/model.ts";

// Issue #170 (défaut P2) -- logique PURE de la portée d'une sélection.
const view = (offers: Array<{ slotKey: string; startsAt: string; endsAt: string }>): CheckoutScheduleView => ({
  status: "dates_available", unfulfillableReason: null, timezone: "Europe/Paris",
  dateSelectionMode: "customer_selectable", slotSelectionMode: "fixed_slots", timeGranularityMinutes: null,
  firstEligibleDate: "2026-10-30", eligibleDates: ["2026-10-30"], offers: { "2026-10-30": offers },
});
const RULE_A = view([{ slotKey: "s-a", startsAt: "11:00", endsAt: "14:00" }, { slotKey: "s-b", startsAt: "14:00", endsAt: "17:00" }]);
const RULE_B = view([{ slotKey: "s-a", startsAt: "18:00", endsAt: "20:00" }]); // même date, MÊME clé
const CHOICE = { date: "2026-10-30", slotKey: "s-a", time: null };
const scopeOf = (postal: string | null, count = 1, subtotal: number | null = 3.5) =>
  checkoutScheduleScope({ restaurantId: "r1", modeCode: "delivery", postalCode: postal, totalCount: count, subtotal });

test("[170-P2-U1] POURQUOI la portée est nécessaire : la réconciliation seule garde 'même date + même clé' d'une règle à l'autre", () => {
  // Comportement de reconcileSelection (inchangé, même portée) : A -> B conserve la clé.
  assert.deepEqual(reconcileSelection(RULE_B, CHOICE), CHOICE);
  assert.equal(scheduleAllowsSubmit(RULE_B, CHOICE), true, "sans portée, l'envoi serait ouvert avec 18h–20h non choisi");
});

test("[170-P2-U2] portée différente => sélection vidée (date comprise), jamais de créneau présélectionné", () => {
  const owned = { scope: scopeOf("75001"), selection: CHOICE };
  const next = reconcileScopedSelection(RULE_B, owned, scopeOf("75008"));
  assert.deepEqual(next.selection, EMPTY_SCHEDULE_SELECTION);
  assert.equal(next.scope, scopeOf("75008"));
  assert.equal(scheduleAllowsSubmit(RULE_B, selectionInScope(next, scopeOf("75008"))), false);
  assert.deepEqual(selectionInScope(owned, scopeOf("75008")), EMPTY_SCHEDULE_SELECTION, "dérivation: vide à la portée courante");
});

test("[170-P2-U3] portée strictement identique => choix conservé tant que le serveur le propose ; sinon seule la date peut rester, jamais un autre créneau", () => {
  const sc = scopeOf("75001");
  const owned = { scope: sc, selection: CHOICE };
  assert.equal(reconcileScopedSelection(RULE_A, owned, sc), owned, "même objet (aucun changement)");
  assert.deepEqual(selectionInScope(owned, sc), CHOICE);
  const slotGone = view([{ slotKey: "s-b", startsAt: "14:00", endsAt: "17:00" }]);
  assert.deepEqual(reconcileScopedSelection(slotGone, owned, sc).selection, { date: "2026-10-30", slotKey: null, time: null });
});

test("[170-P2-U4] la portée change avec le code postal, le mode, le restaurant, le panier de livraison ; pas avec rue/ville/nom (le serveur ne les reçoit pas)", () => {
  const base = scopeOf("75001");
  assert.notEqual(base, scopeOf("75008"));
  assert.notEqual(base, scopeOf("75001", 2));
  assert.notEqual(base, scopeOf("75001", 1, 7));
  assert.notEqual(base, checkoutScheduleScope({ restaurantId: "r2", modeCode: "delivery", postalCode: "75001", totalCount: 1, subtotal: 3.5 }));
  assert.notEqual(base, checkoutScheduleScope({ restaurantId: "r1", modeCode: "pickup" }));
  assert.equal(base, scopeOf("75001"), "mêmes paramètres => même portée");
  // retrait : le panier ne fait pas partie de la portée
  assert.equal(
    checkoutScheduleScope({ restaurantId: "r1", modeCode: "pickup", totalCount: 1, subtotal: 3 }),
    checkoutScheduleScope({ restaurantId: "r1", modeCode: "pickup", totalCount: 9, subtotal: 99 })
  );
});

test("[170-P2-U5] rien à lire (table, aucun mode, pas de restaurant) => portée nulle, aucune sélection valable", () => {
  assert.equal(checkoutScheduleScope({ restaurantId: null, modeCode: "delivery", postalCode: "75001" }), null);
  assert.equal(checkoutScheduleScope({ restaurantId: "r1", modeCode: null }), null);
  assert.deepEqual(selectionInScope({ scope: null, selection: CHOICE }, null), EMPTY_SCHEDULE_SELECTION);
  assert.deepEqual(reconcileScopedSelection(RULE_A, { scope: scopeOf("75001"), selection: CHOICE }, null), EMPTY_SCOPED_SCHEDULE_SELECTION);
});
