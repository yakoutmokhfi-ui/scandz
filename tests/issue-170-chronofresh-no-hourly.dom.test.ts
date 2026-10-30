import { test, after } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULE_FIXED_SLOTS, flush, mount, teardown } from "./helpers/csdj-bo1-availability-harness.ts";
import { waitFor } from "./helpers/dom-settle.ts";

// #170 -- l'écran Disponibilités ne propose ni n'enregistre AUCUN créneau
// horaire pour une règle Chronofresh (le commerçant expédie lorsque la
// commande est prête). Règles SYNTHÉTIQUES, aucun réseau. Le fournisseur
// DOIT figurer sur les règles : c'est sa perte entre la lecture et la portée
// qui laissait passer le défaut.

const STU = "55555555-5555-4555-8555-555555555555";
const CHR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RULES = [
  { ruleId: STU, fulfillmentLabel: "Paris centre (Stuart)", provider: "stuart" },
  { ruleId: CHR, fulfillmentLabel: "Expédition réfrigérée", provider: "chronofresh" },
];

after(teardown);

const rowFor = (c: Element, label: string) =>
  Array.from(c.querySelectorAll("tbody tr")).find((tr) => (tr.textContent ?? "").includes(label)) as HTMLElement | undefined;

async function openRule(container: Element, label: string) {
  (rowFor(container, label)!.querySelector("button") as HTMLButtonElement).click();
  await waitFor(() => container.querySelector("#av-activate") !== null, "brouillon de la règle chargé");
  await flush();
}

test("[CHR-D1] OUVERTURE d'une règle Chronofresh : informatif seul, aucun choix de créneau, aucune grille, aucun bouton « ajouter », note explicite", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES });
  await flush();
  assert.equal(rowFor(container, "Expédition réfrigérée")!.querySelector("[data-scope-state]")?.getAttribute("data-scope-state"), "unconfigured");
  await openRule(container, "Expédition réfrigérée");

  const dateMode = container.querySelector("#av-date-mode") as HTMLSelectElement;
  assert.equal(dateMode.value, "informational_only");
  assert.equal(dateMode.disabled, true, "le mode de date n'est pas modifiable");
  assert.deepEqual(Array.from(dateMode.options).map((o) => o.value), ["informational_only"], "seul le mode sans horaire est proposé");
  assert.equal(container.querySelector("#av-slot-mode"), null, "aucun choix de mode de créneau");
  assert.equal(container.querySelector("#av-granularity"), null, "aucun pas de grille horaire");
  assert.equal(container.querySelectorAll('[data-add-row="slot"], [data-add-row="window"]').length, 0, "aucun bouton « ajouter un créneau / une plage »");
  assert.ok(container.querySelector('[data-add-row="closure"]'), "les fermetures (jours, sans horaire) restent disponibles");
  assert.equal(container.querySelectorAll("[data-add-standard-slots]").length, 0, "aucun bouton « créneaux standard »");
  assert.equal(container.querySelectorAll("[data-weekday]").length, 0, "aucune grille de jours et d'horaires");
  assert.ok(container.querySelector("[data-chronofresh-no-hourly]"), "la règle produit est écrite sur l'écran");
  assert.equal((container.querySelector("#av-activate") as HTMLInputElement).checked, false, "désactivée au départ");
  cleanup();
});

test("[CHR-D2] PAYLOAD enregistré d'une règle Chronofresh : informatif, aucun créneau, aucune fenêtre, création sans jeton", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES, saveHandler: () => { throw new Error("stop"); } });
  await flush();
  await openRule(container, "Expédition réfrigérée");
  (container.querySelector("#av-activate") as HTMLInputElement).click();
  await flush();
  const save = container.querySelector("#av-save") as HTMLButtonElement;
  assert.equal(save.disabled, false, String(save.getAttribute("data-write-disabled-reason")));
  save.click();
  await waitFor(() => ((globalThis as any).__saveCalls ?? []).length === 1, "un enregistrement émis");

  const p = (globalThis as any).__saveCalls[0].payload;
  assert.equal(p.modeCode, "delivery");
  assert.equal(p.fulfillmentRuleId, CHR);
  assert.equal(p.enabled, true);
  assert.equal(p.expectedUpdatedAt, null);
  assert.equal(p.policy.dateSelectionMode, "informational_only");
  assert.equal(p.policy.slotSelectionMode, "none");
  assert.deepEqual(p.slots, []);
  assert.deepEqual(p.windows, []);
  cleanup();
});

test("[CHR-D3] STUART non régressé : créneaux nommés, bouton « créneaux standard », départ 16:00 la veille", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES });
  await flush();
  await openRule(container, "Paris centre (Stuart)");
  await waitFor(() => (container.querySelector("#av-cutoff") as HTMLInputElement | null)?.value === "16:00", "départ Stuart chargé");
  const dateMode = container.querySelector("#av-date-mode") as HTMLSelectElement;
  assert.equal(dateMode.value, "customer_selectable");
  assert.equal(dateMode.disabled, false);
  assert.equal(dateMode.options.length, 3);
  assert.equal((container.querySelector("#av-slot-mode") as HTMLSelectElement).value, "fixed_slots");
  assert.ok(container.querySelector("[data-add-standard-slots]"), "bouton créneaux standard présent");
  assert.equal(container.querySelector("[data-chronofresh-no-hourly]"), null);
  cleanup();
});

test("[CHR-D4] aller-retour Stuart → Chronofresh : rien de Stuart ne fuit dans le brouillon Chronofresh", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES, saveHandler: () => { throw new Error("stop"); } });
  await flush();
  await openRule(container, "Paris centre (Stuart)");
  (container.querySelector('[data-add-standard-slots="2"]') as HTMLButtonElement).click();
  await flush();
  assert.ok(container.querySelectorAll("[data-weekday] input[type=time]").length > 0, "des créneaux Stuart ont été saisis");
  // Ouverture de la règle Chronofresh depuis la liste des portées.
  (rowFor(container, "Expédition réfrigérée")!.querySelector("button") as HTMLButtonElement).click();
  await waitFor(() => container.querySelector("[data-chronofresh-no-hourly]") !== null, "règle Chronofresh affichée");
  await flush();
  assert.equal(container.querySelectorAll("[data-weekday] input[type=time]").length, 0, "aucune heure Stuart dans le brouillon Chronofresh");
  (container.querySelector("#av-activate") as HTMLInputElement).click();
  await flush();
  (container.querySelector("#av-save") as HTMLButtonElement).click();
  await waitFor(() => ((globalThis as any).__saveCalls ?? []).length === 1, "un enregistrement émis");
  const p = (globalThis as any).__saveCalls[0].payload;
  assert.equal(p.fulfillmentRuleId, CHR);
  assert.deepEqual(p.slots, []);
  assert.equal(p.policy.slotSelectionMode, "none");
  cleanup();
});

test("[CHR-D5] lecture des règles en ÉCHEC : aucune règle de livraison proposée, retrait inchangé, aucune écriture", async () => {
  const { container, cleanup } = mount({ role: "owner", schedules: [SCHEDULE_FIXED_SLOTS], deliveryRules: RULES, deliveryRulesThrow: true });
  await flush();
  assert.equal(container.querySelectorAll("tbody tr").length, 1, "seule la portée existante (retrait) est listée");
  assert.equal(rowFor(container, "Expédition réfrigérée"), undefined);
  assert.equal(((globalThis as any).__saveCalls ?? []).length, 0);
  cleanup();
});
