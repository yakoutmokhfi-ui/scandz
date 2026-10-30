import { test, after } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULE_FIXED_SLOTS, flush, mount, teardown, window } from "./helpers/csdj-bo1-availability-harness.ts";
import { waitFor } from "./helpers/dom-settle.ts";

// #170 — la page Disponibilités propose un planning aux règles de
// livraison qui n'en ont pas. Données synthétiques, aucun réseau.

const RULES = [
  { ruleId: "11111111-1111-4111-8111-111111111111", fulfillmentLabel: "Paris centre (Stuart)" },
  { ruleId: "22222222-2222-4222-8222-222222222222", fulfillmentLabel: "Expédition réfrigérée" },
];

after(teardown);

const rowFor = (c: Element, label: string) =>
  Array.from(c.querySelectorAll("tbody tr")).find((tr) => (tr.textContent ?? "").includes(label)) as HTMLElement | undefined;

test("[#170-D1] les règles de livraison sans planning sont listées « Non configurées », avec leur libellé", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES });
  await flush();
  const rows = container.querySelectorAll("tbody tr");
  assert.equal(rows.length, 3);
  for (const label of ["Paris centre (Stuart)", "Expédition réfrigérée"]) {
    const tr = rowFor(container, label);
    assert.ok(tr, label);
    assert.equal(tr!.querySelector("[data-scope-state]")?.getAttribute("data-scope-state"), "unconfigured");
  }
  cleanup();
});

test("[#170-D2] sans règle de livraison, la liste est inchangée (retrait seul)", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS] });
  await flush();
  assert.equal(container.querySelectorAll("tbody tr").length, 1);
  cleanup();
});

test("[#170-D3] ouvrir une règle : départ 16:00 la veille, créneaux nommés, désactivée ; créneaux standard d'un clic ; création sans jeton", async () => {
  const { container, cleanup } = mount({
    role: "owner",
    schedules: [SCHEDULE_FIXED_SLOTS],
    deliveryRules: RULES,
    saveHandler: () => {
      throw new Error("stop");
    },
  });
  await flush();
  (rowFor(container, "Paris centre (Stuart)")!.querySelector("button") as HTMLButtonElement).click();
  await waitFor(() => (container.querySelector("#av-cutoff") as HTMLInputElement | null)?.value === "16:00", "brouillon de la règle chargé");

  assert.equal((container.querySelector("#av-date-mode") as HTMLSelectElement).value, "customer_selectable");
  assert.equal((container.querySelector("#av-slot-mode") as HTMLSelectElement).value, "fixed_slots");
  assert.equal((container.querySelector("#av-cutoff") as HTMLInputElement).value, "16:00");
  assert.equal((container.querySelector("#av-cutoff-offset") as HTMLInputElement).value, "1");
  assert.equal((container.querySelector("#av-activate") as HTMLInputElement).checked, false);

  for (const day of [2, 3]) {
    (container.querySelector(`[data-add-standard-slots="${day}"]`) as HTMLButtonElement).click();
    await flush();
  }
  // Un second clic ne duplique rien.
  (container.querySelector('[data-add-standard-slots="2"]') as HTMLButtonElement).click();
  await flush();

  const save = container.querySelector("#av-save") as HTMLButtonElement;
  assert.equal(save.disabled, false, String(save.getAttribute("data-write-disabled-reason")));
  save.click();
  await waitFor(() => ((globalThis as any).__saveCalls ?? []).length === 1, "un enregistrement émis");

  const call = (globalThis as any).__saveCalls[0];
  assert.equal(call.payload.modeCode, "delivery");
  assert.equal(call.payload.fulfillmentRuleId, RULES[0].ruleId);
  assert.equal(call.payload.enabled, false);
  assert.equal(call.payload.expectedUpdatedAt, null);
  assert.equal(call.payload.policy.cutoffTime, "16:00");
  assert.equal(call.payload.slots.length, 6);
  assert.deepEqual(
    call.payload.slots.filter((s: any) => s.weekday === 2).map((s: any) => `${s.startsAt}-${s.endsAt}`),
    ["11:00-14:00", "14:00-17:00", "17:00-20:00"]
  );
  cleanup();
});

test("[#170-D4] le commerçant garde la main : heure limite et jours modifiables avant d'enregistrer", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES, saveHandler: () => { throw new Error("stop"); } });
  await flush();
  (rowFor(container, "Expédition réfrigérée")!.querySelector("button") as HTMLButtonElement).click();
  await waitFor(() => (container.querySelector("#av-cutoff") as HTMLInputElement | null)?.value === "16:00", "brouillon de la règle chargé");
  const cutoff = container.querySelector("#av-cutoff") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cutoff), "value")!.set!;
  setter.call(cutoff, "15:30");
  cutoff.dispatchEvent(new window.Event("input", { bubbles: true }));
  await flush();
  (container.querySelector('[data-add-standard-slots="5"]') as HTMLButtonElement).click();
  await flush();
  (container.querySelector("#av-save") as HTMLButtonElement).click();
  await waitFor(() => ((globalThis as any).__saveCalls ?? []).length === 1, "un enregistrement émis");
  const p = (globalThis as any).__saveCalls[0].payload;
  assert.equal(p.fulfillmentRuleId, RULES[1].ruleId);
  assert.equal(p.policy.cutoffTime, "15:30");
  assert.deepEqual([...new Set(p.slots.map((s: any) => s.weekday))], [5]);
  cleanup();
});

test("[#170-D5] rôle en lecture seule : aucune édition des créneaux", async () => {
  const { container, cleanup } = mount({ role: "staff", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES });
  await flush();
  (rowFor(container, "Paris centre (Stuart)")!.querySelector("button") as HTMLButtonElement).click();
  await waitFor(() => container.querySelector("[data-add-standard-slots]") !== null || container.querySelector("#av-cutoff") !== null, "portée affichée");
  const btn = container.querySelector("[data-add-standard-slots]") as HTMLButtonElement | null;
  if (btn) assert.equal(btn.disabled, true);
  assert.equal((container.querySelector("#av-save") as HTMLButtonElement).disabled, true);
  cleanup();
});
