import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_SCHEDULE_STARTER,
  isChronofreshRule,
  providerScheduleIssues,
  scheduleStarterFor,
  unconfiguredDeliveryRules,
  type DeliveryRuleRef,
} from "../lib/availability-editor.ts";
import {
  buildSaveFulfillmentConfigurationPayload,
  draftFromServer,
  issueKey,
} from "../lib/availability-payload.ts";
import { scheduleRequirement } from "../lib/checkout-schedule/model.ts";
import { DICTS } from "../lib/i18n.ts";

// #170 -- AUCUN créneau horaire Chronofresh : le commerçant expédie lorsque
// la commande est prête. Règles SYNTHÉTIQUES, aucun réseau, aucune donnée.

const CHR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STU = "55555555-5555-4555-8555-555555555555";
const RULES: DeliveryRuleRef[] = [
  { ruleId: STU, label: "Paris centre (Stuart)", provider: "stuart" },
  { ruleId: CHR, label: "Expédition réfrigérée", provider: "chronofresh" },
];

function draftOf(ruleId: string | null, patch: Record<string, unknown> = {}) {
  return {
    ...draftFromServer({ modeCode: "delivery", fulfillmentRuleId: ruleId, updatedAt: null, revision: null }),
    ...patch,
  };
}
const slot = { rowId: "s1", weekday: 2, slotKey: "11h-14h", startsAt: "11:00", endsAt: "14:00" };
const win = { rowId: "w1", weekday: 2, startsAt: "11:00", endsAt: "14:00" };
const codes = (d: any, rules = RULES, failed = false) => providerScheduleIssues(d, rules, failed).map((i) => i.code);

test("[CHR-M1] le fournisseur reste attaché à la règle jusqu'au brouillon (aucune perte entre lecture et portée)", () => {
  const unconfigured = unconfiguredDeliveryRules(RULES, []);
  assert.deepEqual(unconfigured.map((r) => r.provider), ["stuart", "chronofresh"]);
  assert.equal(isChronofreshRule(unconfigured[1]), true);
  assert.equal(isChronofreshRule(unconfigured[0]), false);
  assert.equal(isChronofreshRule(undefined), false);
  assert.equal(isChronofreshRule({ provider: null }), false);
});

test("[CHR-M2] départ d'une règle sans planning : Chronofresh = informatif sans créneau ; Stuart = départ inchangé", () => {
  assert.deepEqual(scheduleStarterFor(RULES[1]), {
    dateSelectionMode: "informational_only",
    slotSelectionMode: "none",
  });
  assert.deepEqual(scheduleStarterFor(RULES[0]), { ...DELIVERY_SCHEDULE_STARTER });
  const chr = { ...draftOf(CHR), ...scheduleStarterFor(RULES[1]) };
  assert.deepEqual(codes(chr), []);
});

test("[CHR-M3] Chronofresh : tout planning horaire est refusé (créneaux, heure libre, fenêtres, date choisie par le client)", () => {
  assert.deepEqual(codes(draftOf(CHR, { dateSelectionMode: "customer_selectable", slotSelectionMode: "fixed_slots", slots: [slot] })), ["provider_no_hourly"]);
  assert.deepEqual(codes(draftOf(CHR, { dateSelectionMode: "customer_selectable", slotSelectionMode: "time_within_window", windows: [win], timeGranularityMinutes: "30" })), ["provider_no_hourly"]);
  assert.deepEqual(codes(draftOf(CHR, { dateSelectionMode: "customer_selectable", slotSelectionMode: "none" })), ["provider_no_hourly"]);
  assert.deepEqual(codes(draftOf(CHR, { slots: [slot] })), ["provider_no_hourly"], "une ligne horaire seule suffit");
  // Le refus vaut aussi pour la MÊME configuration désactivée (repli « brouillon »).
  assert.deepEqual(codes(draftOf(CHR, { enabled: false, slotSelectionMode: "fixed_slots", slots: [slot], dateSelectionMode: "customer_selectable" })), ["provider_no_hourly"]);
});

test("[CHR-M4] Chronofresh sans horaire : aucun refus (informatif, désactivé ou activé)", () => {
  assert.deepEqual(codes(draftOf(CHR)), []);
  assert.deepEqual(codes(draftOf(CHR, { enabled: true })), []);
});

test("[CHR-M5] Stuart garde ses créneaux configurables ; une portée sans règle (retrait) n'est jamais concernée", () => {
  assert.deepEqual(codes(draftOf(STU, { dateSelectionMode: "customer_selectable", slotSelectionMode: "fixed_slots", slots: [slot] })), []);
  assert.deepEqual(codes(draftOf(null, { dateSelectionMode: "customer_selectable", slotSelectionMode: "fixed_slots", slots: [slot] })), []);
});

test("[CHR-M6] fournisseur INCONNU : refus seulement si la lecture des règles a ÉCHOUÉ (pas d'horaire enregistré à l'aveugle)", () => {
  const hourly = draftOf("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { dateSelectionMode: "customer_selectable", slotSelectionMode: "fixed_slots", slots: [slot] });
  assert.deepEqual(codes(hourly, [], true), ["provider_unverified"]);
  assert.deepEqual(codes(hourly, [], false), [], "lecture réussie sans cette règle : comportement d'avant");
  assert.deepEqual(codes(draftOf("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), [], true), [], "sans horaire : rien à refuser");
});

test("[CHR-M7] payload enregistré d'une règle Chronofresh créée depuis l'écran : informatif, aucun créneau, aucune fenêtre", () => {
  const draft = { ...draftOf(CHR, { enabled: true }), ...scheduleStarterFor(RULES[1]) };
  const payload = buildSaveFulfillmentConfigurationPayload(draft) as any;
  assert.equal(payload.modeCode, "delivery");
  assert.equal(payload.fulfillmentRuleId, CHR);
  assert.equal(payload.policy.dateSelectionMode, "informational_only");
  assert.equal(payload.policy.slotSelectionMode, "none");
  assert.deepEqual(payload.slots, []);
  assert.deepEqual(payload.windows, []);
  assert.equal(payload.expectedUpdatedAt, null);
});

test("[CHR-M8] parcours checkout : ce que le serveur rend pour cette configuration (informational_only) ne demande RIEN au client", () => {
  const view = {
    status: "informational_only", unfulfillableReason: null, timezone: "Europe/Paris",
    dateSelectionMode: "informational_only", slotSelectionMode: "none", timeGranularityMinutes: null,
    firstEligibleDate: null, eligibleDates: [], offers: {},
  };
  assert.deepEqual(scheduleRequirement(view as any), { kind: "none" });
});

test("[CHR-M9] les deux refus de fournisseur ont leur phrase dans les quatre langues", () => {
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const dict = DICTS[lang] as Record<string, string>;
    for (const key of [issueKey("provider_no_hourly"), issueKey("provider_unverified"), "avChronofreshNoHourlyNote"]) {
      assert.ok(dict[key] && dict[key].trim().length > 20, `${lang} : ${key} manque`);
    }
  }
});
