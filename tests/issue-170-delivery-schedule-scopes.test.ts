import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_MODE_CODE,
  DELIVERY_SCHEDULE_STARTER,
  STANDARD_DELIVERY_SLOTS,
  missingStandardSlots,
  unconfiguredDeliveryRules,
} from "../lib/availability-editor.ts";
import { validateDraft, buildSaveFulfillmentConfigurationPayload, draftFromServer } from "../lib/availability-payload.ts";

// #170 — planning d'une règle de livraison : helpers purs (données synthétiques).

const RULES = [
  { ruleId: "11111111-1111-4111-8111-111111111111", label: "Paris centre" },
  { ruleId: "22222222-2222-4222-8222-222222222222", label: "Banlieue" },
  { ruleId: "33333333-3333-4333-8333-333333333333", label: "Expédition réfrigérée" },
];

test("[#170-S1] seules les règles de livraison SANS portée sont proposées, dans l'ordre", () => {
  const out = unconfiguredDeliveryRules(RULES, [
    { modeCode: "pickup", fulfillmentRuleId: null },
    { modeCode: DELIVERY_MODE_CODE, fulfillmentRuleId: RULES[1].ruleId },
  ]);
  assert.deepEqual(out.map((r) => r.label), ["Paris centre", "Expédition réfrigérée"]);
});

test("[#170-S2] une portée de retrait (sans règle) ne masque aucune règle ; un doublon n'est listé qu'une fois", () => {
  const out = unconfiguredDeliveryRules([...RULES, RULES[0]], [{ modeCode: "pickup", fulfillmentRuleId: null }]);
  assert.equal(out.length, 3);
});

test("[#170-S3] valeurs de départ : le client choisit, créneaux nommés, 16:00 la veille", () => {
  assert.equal(DELIVERY_SCHEDULE_STARTER.dateSelectionMode, "customer_selectable");
  assert.equal(DELIVERY_SCHEDULE_STARTER.slotSelectionMode, "fixed_slots");
  assert.equal(DELIVERY_SCHEDULE_STARTER.cutoffTime, "16:00");
  assert.equal(DELIVERY_SCHEDULE_STARTER.cutoffOffsetDays, "1");
  assert.deepEqual(
    STANDARD_DELIVERY_SLOTS.map((s) => `${s.startsAt}-${s.endsAt}`),
    ["11:00-14:00", "14:00-17:00", "17:00-20:00"]
  );
  for (const s of STANDARD_DELIVERY_SLOTS) assert.match(s.slotKey, /^[a-z0-9_-]{1,40}$/);
});

test("[#170-S4] créneaux standard : jamais de doublon ni d'écrasement, par jour", () => {
  assert.equal(missingStandardSlots([], 2).length, 3);
  const have = [{ weekday: 2, slotKey: "14h-17h" }, { weekday: 3, slotKey: "11h-14h" }];
  assert.deepEqual(missingStandardSlots(have, 2).map((s) => s.slotKey), ["11h-14h", "17h-20h"]);
  assert.equal(missingStandardSlots(STANDARD_DELIVERY_SLOTS.map((s) => ({ weekday: 5, slotKey: s.slotKey })), 5).length, 0);
});

test("[#170-S5] charge d'écriture d'une CRÉATION : règle ciblée, sans jeton, désactivée, valide", () => {
  const base = draftFromServer({ modeCode: DELIVERY_MODE_CODE, fulfillmentRuleId: RULES[0].ruleId, updatedAt: null, revision: null });
  const draft = {
    ...base,
    ...DELIVERY_SCHEDULE_STARTER,
    slots: [2, 3].flatMap((weekday) =>
      STANDARD_DELIVERY_SLOTS.map((s, i) => ({ rowId: `r${weekday}${i}`, weekday, ...s }))
    ),
  };
  assert.deepEqual(validateDraft(draft), []);
  const payload = buildSaveFulfillmentConfigurationPayload(draft) as any;
  assert.equal(payload.modeCode, "delivery");
  assert.equal(payload.fulfillmentRuleId, RULES[0].ruleId);
  assert.equal(payload.enabled, false);
  assert.equal(payload.expectedUpdatedAt, null);
  assert.equal(payload.policy.cutoffTime, "16:00");
  assert.equal(payload.policy.cutoffOffsetDays, 1);
  assert.equal(payload.slots.length, 6);
});
