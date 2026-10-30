import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { settle } from "./helpers/dom-settle.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import {
  FakeFulfillmentWriteBackend,
  FakeWriteRefusal,
  auLaitCruPickupFixture,
  type FakeTenantState,
} from "./helpers/fake-fulfillment-write-backend.ts";
import { DICTS } from "../lib/i18n.ts";


// ====================================================================
// CSDJ-BO-1 — REMÉDIATION R5 PR #157 (contre-audit Cat Turing R4 : R4-SCOPE-STALE) : rendu
// réel (jsdom), drapeau d'écriture RÉEL, promesses CONTRÔLÉES.
//
// Chaque test reproduit un défaut du contre-audit R3 : exécuté sur le HEAD R3
// 744a073 (rouge) puis sur le correctif R4 (vert).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/availability?r=r1",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

// Le vrai useRouter() de Next rend un objet STABLE entre deux rendus :
// un double qui en fabriquerait un à chaque rendu relancerait l'effet de
// montage et réimposerait le restaurant de l'URL.
const MOCK_NAV = `
const ROUTER = { replace: () => {}, push: () => {} };
export function usePathname() { return "/dashboard/availability"; }
export function useRouter() { return ROUTER; }
`;

const MOCK_AUTH = `
export async function getUser() { return { id: "u1" }; }
export async function signOut() {}
`;

const MOCK_DASHBOARD = `
export async function getMerchantRestaurants() { return (globalThis).__mappings; }
export async function getRestaurantSettings() { return { staff_receipt_language: (globalThis).__uiLang ?? "fr" }; }
export async function getMerchantDeliveryFulfillmentPricing() { return (globalThis).__deliveryRules ?? []; }
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__isOperator === true; }
export async function getEstablishmentSummary() { return { name: "Contexte opérateur" }; }
`;

// Les trois lectures et l'UNIQUE écriture passent par le backend simulé.
// `__io` est posé par `setup()` : le test n'appelle jamais ces fonctions
// lui-même, c'est la page qui les appelle.
const MOCK_AVAILABILITY = `
export async function getMerchantFulfillmentSchedules(id) {
  return (globalThis).__io.readSchedules(id);
}
export async function getMerchantFulfillmentSchedulesV12(id) {
  return (globalThis).__io.readV12(id);
}
// Lecture AUTORITAIRE (remédiation R1, §2) : elle rend les deux jetons,
// et le compteur d'appels permet de prouver qu'elle est bien consultée
// -- et relue après un refus de concurrence.
export async function getFulfillmentConfiguration(id, modeCode, ruleId) {
  return (globalThis).__io.readConfiguration(id, modeCode, ruleId);
}
export class FulfillmentConfigurationShapeError extends Error {}
export class AvailabilityWriteUnavailableError extends Error {
  constructor() {
    super("CSDJ_BO1_WRITE_CONTRACT_PENDING");
    this.name = "AvailabilityWriteUnavailableError";
    this.reason = "CSDJ_BO1_WRITE_CONTRACT_PENDING";
  }
}
export async function saveFulfillmentConfiguration(id, payload) {
  return (globalThis).__io.save(id, payload);
}
export async function getCheckoutFulfillmentSchedulePreview() {
  if ((globalThis).__previewImpl) return (globalThis).__previewImpl();
  return (globalThis).__previewResult ?? null;
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/availability": MOCK_AVAILABILITY,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    // `resolveDir` : le double de `@/lib/availability-editor` réimporte la
    // VRAIE source par son chemin, ce qui exige un répertoire de
    // résolution -- un module virtuel n'en a pas par défaut.
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path],
      loader: "ts",
      resolveDir: REPO_ROOT,
    }));
  },
};

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as AvailabilityPage } from "@/app/dashboard/availability/page";`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-bo1-ux157r5-"));
const tmpFile = path.join(tmpDir, "AvailabilityPage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { AvailabilityPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --------------------------------------------------------------------
// Amorçage
// --------------------------------------------------------------------

type Io = {
  readSchedules(id: string): unknown[] | Promise<unknown[]>;
  readV12(id: string): unknown;
  readConfiguration(id: string, modeCode: string, ruleId: string | null): unknown;
  save(id: string, payload: Record<string, unknown>): Promise<unknown>;
};

/** Journal des appels de la lecture autoritaire, et des charges écrites. */
const authoritativeReads: Array<{ id: string; modeCode: string; ruleId: string | null }> = [];
const writtenPayloads: Array<Record<string, unknown>> = [];

/**
 * Pont entre la page et le backend simulé. Il reproduit EXACTEMENT ce que
 * fait le service réel :
 *   - les lectures de listes projettent l'état du locataire ;
 *   - la lecture autoritaire rend la configuration et les DEUX jetons ;
 *   - l'écriture délègue à `save()`, prend les jetons DE SA RÉPONSE, puis
 *     relit les listes pour l'affichage.
 */
function io(
  backend: FakeFulfillmentWriteBackend,
  hooks: {
    beforeSave?: () => void;
    /**
     * Refus serveur joué UNE fois, pour les cas où l'autorité sait
     * quelque chose que la page ne peut pas savoir. C'est légitime et
     * c'est même le cas normal : la page reproduit les refus pour
     * épargner un aller-retour, elle ne prétend pas les connaître tous.
     */
    refuseOnceWith?: string;
    /**
     * ENTRELACEMENT DES LECTURES (F-01) : appelé UNE fois, juste APRÈS
     * que les lectures de listes ont rendu leur version (A). C'est là
     * qu'un tiers modifie la configuration (B) : la lecture autoritaire,
     * qui part ensuite, rend B avec les jetons de B.
     */
    afterListsRead?: () => void;
    /** Appelé après CHAQUE lecture de listes, avec le restaurant lu. */
    onListsRead?: (id: string) => void;
    /** Retient la RÉPONSE d'une sauvegarde (l'écriture, elle, a eu lieu). Rejet = réponse perdue. */
    holdSave?: (id: string) => Promise<void> | null;
    /** Retient la réponse autoritaire d'une portée jusqu'à ce que la promesse se résolve. */
    holdAuthority?: (id: string, modeCode: string, ruleId: string | null) => Promise<void> | null;
    /** L'autorité ne répond plus après N lectures (échec de relecture). */
    failAuthorityAfter?: number;
    /** L'autorité répond « aucune configuration » pour toute portée. */
    authorityReturnsNull?: boolean;
    /**
     * Retient la réponse des LECTURES DE LISTES (celle d'une relecture)
     * jusqu'à ce que la promesse rendue se résolve. Appelé à chaque
     * lecture ; rend `null` pour ne rien retenir. La réponse est figée
     * au moment où le serveur répond, pas au moment où elle est livrée.
     */
    holdLists?: () => Promise<void> | null;
  } = {}
): Io {
  let refusalsPlayed = 0;
  let listsReads = 0;
  const schedulesOf = (id: string) =>
    JSON.parse(JSON.stringify(backend.tenant(id).schedules)) as unknown[];
  const v12Of = (id: string) => {
    const rows = JSON.parse(JSON.stringify(backend.tenant(id).v12)) as unknown[];
    return rows.length > 0 ? { status: "available", rows } : { status: "absent", rows: [] };
  };
  const readTokens = (source: Record<string, unknown>) => {
    const updatedAt = source.updatedAt;
    const revision = source.revision;
    if (typeof updatedAt !== "string" || typeof revision !== "string") {
      throw new Error("CSDJBO1_UNEXPECTED_CONFIGURATION_SHAPE: jetons absents");
    }
    return { updatedAt, revision };
  };
  return {
    readSchedules(id) {
      const rows = schedulesOf(id);
      const gate = hooks.holdLists?.() ?? null;
      if (gate === null) return rows;
      return gate.then(() => rows);
    },
    readV12(id) {
      const rows = v12Of(id);
      listsReads += 1;
      if (listsReads === 1) hooks.afterListsRead?.();
      hooks.onListsRead?.(id);
      return rows;
    },
    readConfiguration(id, modeCode, ruleId) {
      authoritativeReads.push({ id, modeCode, ruleId });
      if (
        hooks.failAuthorityAfter !== undefined &&
        authoritativeReads.length > hooks.failAuthorityAfter
      ) {
        throw new Error("CSDJBO1_UNEXPECTED_CONFIGURATION_SHAPE: autorité muette");
      }
      const answer = () => {
        if (hooks.authorityReturnsNull) return null;
        // La configuration est figée AU MOMENT où le serveur répond,
        // pas au moment où la réponse est livrée : c'est ce qui rend
        // possible une réponse en retard portant une version plus ancienne.
        const configuration = backend.readConfiguration(id, modeCode, ruleId);
        if (configuration === null) return null;
        return { tokens: readTokens(configuration), configuration };
      };
      const gate = hooks.holdAuthority?.(id, modeCode, ruleId) ?? null;
      if (gate === null) return answer();
      const frozen = answer();
      return gate.then(() => frozen);
    },
    async save(id, payload) {
      hooks.beforeSave?.();
      writtenPayloads.push(JSON.parse(JSON.stringify(payload)));
      // R5 : le REFUS du serveur est lui aussi retenu par la porte -- c'est
      // la réponse (acceptation OU refus) qui arrive tard, pas l'écriture.
      let response: Record<string, unknown> = {};
      let refusal: unknown = null;
      try {
        if (hooks.refuseOnceWith !== undefined && refusalsPlayed === 0) {
          refusalsPlayed += 1;
          throw new FakeWriteRefusal(hooks.refuseOnceWith, "offer_missing");
        }
        response = backend.save(id, payload) as Record<string, unknown>;
      } catch (error) {
        refusal = error;
      }
      const saveGate = hooks.holdSave?.(id) ?? null;
      if (saveGate !== null) await saveGate;
      if (refusal !== null) throw refusal;
      // Même forme que le service réel : le snapshot ENTIER (configuration
      // + jetons) de la version écrite, d'où sortent brouillon, référence
      // et jetons -- jamais les jetons d'une réponse et la configuration
      // d'une autre.
      const tokens = readTokens(response);
      return {
        schedules: schedulesOf(id),
        v12: v12Of(id),
        tokens,
        authoritative: { tokens, configuration: response },
      };
    },
  };
}

function setup(options: {
  backend: FakeFulfillmentWriteBackend;
  role?: string;
  isOperator?: boolean;
  mappings?: unknown[];
  uiLang?: string;
  beforeSave?: () => void;
  refuseOnceWith?: string;
  afterListsRead?: () => void;
  onListsRead?: (id: string) => void;
  holdSave?: (id: string) => Promise<void> | null;
  holdAuthority?: (id: string, modeCode: string, ruleId: string | null) => Promise<void> | null;
  failAuthorityAfter?: number;
  authorityReturnsNull?: boolean;
  holdLists?: () => Promise<void> | null;
}) {
  (globalThis as any).__mappings =
    options.mappings ?? [
      {
        restaurant_id: "r1",
        role: options.role ?? "owner",
        restaurants: { id: "r1", name: "Au Lait Cru", slug: "au-lait-cru" },
      },
    ];
  (globalThis as any).__isOperator = options.isOperator === true;
  (globalThis as any).__uiLang = options.uiLang ?? "fr";
  (globalThis as any).__previewResult = null;
  (globalThis as any).__previewImpl = null;
  authoritativeReads.length = 0;
  writtenPayloads.length = 0;
  (globalThis as any).__io = io(options.backend, {
    beforeSave: options.beforeSave,
    refuseOnceWith: options.refuseOnceWith,
    afterListsRead: options.afterListsRead,
    onListsRead: options.onListsRead,
    holdSave: options.holdSave,
    holdAuthority: options.holdAuthority,
    failAuthorityAfter: options.failAuthorityAfter,
    authorityReturnsNull: options.authorityReturnsNull,
    holdLists: options.holdLists,
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(AvailabilityPage, {}));
  return {
    container,
    root,
    cleanup() {
      root.unmount();
      container.remove();
    },
  };
}

/** Attente de QUIESCENCE, pas de durée (remédiation F-03) : voir
 *  tests/helpers/dom-settle.ts. `ms` est accepté et ignoré. */
const flush = settle;

/** Un champ contrôlé par React n'enregistre une frappe que par le setter natif. */
function typeInto(input: Element, value: string): void {
  const proto =
    input instanceof window.HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLTextAreaElement && input instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

const q = <T extends Element>(root: Element, selector: string): T => {
  const found = root.querySelector<T>(selector);
  assert.ok(found, `élément introuvable : ${selector}`);
  return found!;
};

const byAria = (root: Element, label: string): HTMLInputElement[] =>
  [...root.querySelectorAll(`[aria-label="${label}"]`)] as HTMLInputElement[];

const draftState = (root: Element): string | null =>
  root.querySelector("[data-draft-state]")?.getAttribute("data-draft-state") ?? null;

const saveButton = (root: Element) => q<HTMLButtonElement>(root, "#av-save");

const fr = (key: string) => (DICTS.fr as Record<string, string>)[key];

/** Deux locataires, chacun avec SA fixture : rien n'est partagé. */
function twoTenants(): { backend: FakeFulfillmentWriteBackend; mappings: unknown[] } {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const other: FakeTenantState = auLaitCruPickupFixture();
  other.schedules[0].cutoffTime = "09:00:00";
  // Jetons PROPRES à r2 : un jeton de r1 qui y serait recyclé serait refusé.
  other.schedules[0].updatedAt = "2026-10-12T07:00:00.222222Z";
  other.schedules[0].revision = "22222222222222222222222222222222";
  other.schedules[0].slots = [
    { weekday: 1, slotKey: "unique_de_r2", startsAt: "08:00", endsAt: "09:00" },
  ];
  backend.setTenant("r2", other);
  return {
    backend,
    mappings: [
      { restaurant_id: "r1", role: "owner", restaurants: { id: "r1", name: "Au Lait Cru", slug: "a" } },
      { restaurant_id: "r2", role: "owner", restaurants: { id: "r2", name: "Sanaa", slug: "b" } },
    ],
  };
}



const text = (root: Element) => root.textContent ?? "";
function pickupBackend(): FakeFulfillmentWriteBackend {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  return backend;
}
const DELIVERY_RULE = "11111111-1111-1111-1111-111111111111";

/** Une promesse que le test résout à la main. */
function deferred(): {
  promise: Promise<void>;
  release: () => void;
  reject: (error: unknown) => void;
} {
  let release: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, rej) => {
    release = resolve;
    reject = rej;
  });
  return { promise, release, reject };
}

/** Pickup (J+1) + une règle de livraison (J+4), pour pouvoir changer de portée. */
function twoScopeBackend(): FakeFulfillmentWriteBackend {
  const backend = new FakeFulfillmentWriteBackend();
  const state = auLaitCruPickupFixture();
  state.schedules.push({
    ...JSON.parse(JSON.stringify(state.schedules[0])),
    modeCode: "delivery",
    fulfillmentRuleId: DELIVERY_RULE,
    minLeadDays: 4,
    cutoffTime: "09:00:00",
    slots: [],
    windows: [],
    slotSelectionMode: "none",
    updatedAt: "2026-10-14T00:00:02.222222Z",
    revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  backend.setTenant("r1", state);
  return backend;
}

/** La liste est lue AVANT qu'un tiers ne change le mode de date : la page
 *  voit deux lectures qui se contredisent, et propose de relire. */
function divergentSetup(backend: FakeFulfillmentWriteBackend, extra: Record<string, unknown> = {}) {
  return setup({
    backend,
    afterListsRead: () => {
      backend.tenant("r1").schedules[0].dateSelectionMode = "derived_earliest";
    },
    ...extra,
  } as never);
}

function previewOf(firstDate: string): Record<string, unknown> {
  return {
    deliveryApplicable: false, deliveryEligible: false, deliveryBlock: null, deliveryCustomerText: null,
    scheduleStatus: "schedulable", unfulfillableReason: null, scheduleTimezone: "Europe/Paris",
    dateSelectionMode: "customer_selectable", slotSelectionMode: "fixed_slots", timeGranularityMinutes: null,
    firstEligibleDate: firstDate, eligibleDates: [firstDate],
    offers: { [firstDate]: [{ slot_key: "midi", starts_at: "11:00", ends_at: "14:00" }] },
  };
}

const leadDays = (root: Element) => q<HTMLInputElement>(root, "#av-lead-days");


// --------------------------------------------------------------------
const restaurantSelector = (root: Element): HTMLSelectElement =>
  ([...root.querySelectorAll("select")] as HTMLSelectElement[]).find((s) =>
    [...s.options].some((o) => o.value === "r2")
  )!;
const statusOf = (root: Element) =>
  q(root, "[data-editor-status]").getAttribute("data-editor-status");

// --------------------------------------------------------------------
// Outils R5
// --------------------------------------------------------------------

const PICKUP = "pickup::mode";
const DELIVERY = `delivery::${DELIVERY_RULE}`;
const scopeSelect = (root: Element) => q<HTMLSelectElement>(root, "#av-scope-select");
const selectedScope = (root: Element) => scopeSelect(root).value;
const editorRoot = (root: Element) => root.querySelector("[data-editor-status]");
const leadValue = (root: Element): string | null =>
  root.querySelector<HTMLInputElement>("#av-lead-days")?.value ?? null;
const saveErrorShown = (root: Element) => root.querySelector("[data-save-error]") !== null || root.querySelector("#av-save-error") !== null;

/** Deux portées : pickup (délai 1) et delivery (délai 9 côté serveur). */
function pickupDeliveryBackend(): FakeFulfillmentWriteBackend {
  const backend = twoScopeBackend();
  const delivery = backend.tenant("r1").schedules.find((s) => s.modeCode === "delivery")!;
  delivery.minLeadDays = 9;
  // Une configuration de livraison VALIDE (créneaux fixes comme pickup) :
  // sans cela l'éditeur refuse localement toute sauvegarde de delivery.
  const pickupSrc = backend.tenant("r1").schedules.find((r) => r.modeCode === "pickup")!;
  delivery.slots = JSON.parse(JSON.stringify(pickupSrc.slots));
  delivery.windows = JSON.parse(JSON.stringify(pickupSrc.windows));
  delivery.slotSelectionMode = pickupSrc.slotSelectionMode;
  // Une lecture autoritaire complète (méthode v1.2) pour delivery, comme pickup.
  const state = backend.tenant("r1");
  const v12Pickup = state.v12.find((r) => r.modeCode === "pickup");
  if (v12Pickup && !state.v12.some((r) => r.modeCode === "delivery")) {
    state.v12.push({
      ...JSON.parse(JSON.stringify(v12Pickup)),
      modeCode: "delivery",
      fulfillmentRuleId: DELIVERY_RULE,
    });
  }
  return backend;
}
const pickupRow = (b: FakeFulfillmentWriteBackend) =>
  b.tenant("r1").schedules.find((s) => s.modeCode === "pickup")!;
const deliveryRow = (b: FakeFulfillmentWriteBackend) =>
  b.tenant("r1").schedules.find((s) => s.modeCode === "delivery")!;
/** Un tiers a modifié pickup : les jetons ne sont plus ceux que la page a lus. */
const staleOutPickup = (b: FakeFulfillmentWriteBackend) => {
  const s = pickupRow(b);
  s.minLeadDays = 7;
  s.updatedAt = "2026-10-14T00:00:09.999999Z";
  s.revision = "99999999999999999999999999999999";
};
const select = async (root: Element, key: string) => {
  typeInto(scopeSelect(root), key);
  await flush();
};
const drain = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

// --------------------------------------------------------------------
// R4-SCOPE-STALE — reproduction exacte de Cat Turing
// --------------------------------------------------------------------

test("[R5-SCOPE-STALE] pickup en cours de sauvegarde, passage à delivery (lecture retenue), STALE de pickup tardif, puis réponse delivery : delivery affiche son délai 9, état propre", async () => {
  const backend = pickupDeliveryBackend();
  const saveGate = deferred();
  const deliveryGate = deferred();
  const { container, cleanup } = setup({
    backend,
    holdSave: () => saveGate.promise,
    holdAuthority: (_id, mode) => (mode === "delivery" ? deliveryGate.promise : null),
  });
  try {
    await flush();
    assert.equal(selectedScope(container), PICKUP);
    assert.equal(leadValue(container), "1");
    typeInto(leadDays(container), "4");
    await flush();
    staleOutPickup(backend);
    saveButton(container).click();
    await flush();
    assert.equal(writtenPayloads.length, 1, "précondition : la sauvegarde pickup est partie");

    await select(container, DELIVERY);
    assert.equal(selectedScope(container), DELIVERY);
    // Précondition : la lecture autoritaire de delivery est lancée et retenue.
    assert.ok(authoritativeReads.some((r) => r.modeCode === "delivery"), "lecture delivery non lancée");

    // L'ancienne sauvegarde pickup se termine par STALE ; sa relecture finit.
    saveGate.release();
    await drain();
    // Puis la réponse VALIDE de delivery arrive.
    deliveryGate.release();
    await drain();

    assert.equal(selectedScope(container), DELIVERY);
    assert.equal(leadValue(container), "9", "la réponse valide de delivery a été ignorée");
    assert.equal(statusOf(container), "clean");
    assert.equal(writtenPayloads.length, 1, "une seule écriture (pickup)");
    assert.ok(container.querySelector("[data-conflict='true']") === null, "le conflit de pickup s'affiche sur delivery");
    assert.ok(!saveErrorShown(container), "l'erreur de pickup s'affiche sur delivery");
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------
// Scénarios R5
// --------------------------------------------------------------------

/** Pickup (1→4) en cours de sauvegarde ; delivery sélectionné, lecture retenue. */
async function pickupSavingThenDelivery(opts: { stale: boolean; refuse?: string } = { stale: true }) {
  const backend = pickupDeliveryBackend();
  const saveGate = deferred();
  const deliveryGate = deferred();
  const h = setup({
    backend,
    refuseOnceWith: opts.refuse,
    holdSave: () => saveGate.promise,
    holdAuthority: (_id, mode) => (mode === "delivery" ? deliveryGate.promise : null),
  });
  await flush();
  typeInto(leadDays(h.container), "4");
  await flush();
  if (opts.stale) staleOutPickup(backend);
  saveButton(h.container).click();
  await flush();
  await select(h.container, DELIVERY);
  return { ...h, backend, saveGate, deliveryGate };
}

for (const order of ["delivery-puis-STALE", "STALE-puis-delivery"] as const) {
  test(`[R5-ORDRE-${order}] les deux ordres d'arrivée donnent le même écran : delivery à 9, propre, sans conflit ni erreur de pickup`, async () => {
    const { container, cleanup, saveGate, deliveryGate, backend } = await pickupSavingThenDelivery();
    try {
      if (order === "delivery-puis-STALE") {
        deliveryGate.release();
        await drain();
        assert.equal(leadValue(container), "9");
        saveGate.release();
        await drain();
      } else {
        saveGate.release();
        await drain();
        deliveryGate.release();
        await drain();
      }
      assert.equal(selectedScope(container), DELIVERY);
      assert.equal(leadValue(container), "9");
      assert.equal(statusOf(container), "clean");
      assert.ok(container.querySelector("[data-conflict='true']") === null);
      assert.ok(!saveErrorShown(container));
      assert.equal(deliveryRow(backend).minLeadDays, 9, "delivery non modifié côté serveur");
      assert.equal(pickupRow(backend).minLeadDays, 7, "pickup non écrasé (refus STALE)");
    } finally {
      cleanup();
    }
  });
}

test("[R5-SYMETRIQUE] delivery→pickup : sauvegarde delivery STALE tardive, lecture pickup retenue : pickup affiche son délai 1, propre", async () => {
  const backend = pickupDeliveryBackend();
  const saveGate = deferred();
  const pickupGate = deferred();
  let armed = false;
  const { container, cleanup } = setup({
    backend,
    holdSave: () => saveGate.promise,
    holdAuthority: (_id, mode) => (armed && mode === "pickup" ? pickupGate.promise : null),
  });
  try {
    await flush();
    await select(container, DELIVERY);
    await drain();
    assert.equal(leadValue(container), "9");
    typeInto(leadDays(container), "5");
    await flush();
    const d = deliveryRow(backend);
    d.minLeadDays = 8;
    d.updatedAt = "2026-10-14T00:00:08.888888Z";
    d.revision = "88888888888888888888888888888888";
    armed = true;
    saveButton(container).click();
    await flush();
    await select(container, PICKUP);
    saveGate.release();
    await drain();
    pickupGate.release();
    await drain();
    assert.equal(selectedScope(container), PICKUP);
    assert.equal(leadValue(container), "1", "la réponse valide de pickup a été ignorée");
    assert.equal(statusOf(container), "clean");
    assert.ok(container.querySelector("[data-conflict='true']") === null);
    assert.ok(!saveErrorShown(container));
    assert.equal(writtenPayloads.length, 1);
  } finally {
    cleanup();
  }
});

test("[R5-STALE-PORTEE-ACTIVE] même scénario SANS changement de portée : le conflit reste visible, la relecture autoritaire aboutit, la sauvegarde reste fermée", async () => {
  const backend = pickupDeliveryBackend();
  const { container, cleanup } = setup({ backend });
  try {
    await flush();
    typeInto(leadDays(container), "4");
    await flush();
    staleOutPickup(backend);
    saveButton(container).click();
    await drain();
    assert.equal(selectedScope(container), PICKUP);
    const conflict = q(container, "[data-conflict='true']");
    assert.equal(conflict.getAttribute("data-conflict-reading"), "false", "la relecture du conflit doit avoir abouti");
    assert.ok(container.querySelector("[data-save-error]") !== null, "le refus doit rester visible");
    assert.equal(saveButton(container).disabled, true, "sauvegarde fermée pendant le conflit");
    assert.equal(authoritativeReads.filter((r) => r.modeCode === "pickup").length, 2, "relecture autoritaire de pickup effectuée");
    assert.ok(container.querySelector("[data-stale-reloaded='true']") !== null, "version du serveur relue et signalée");
    assert.equal(writtenPayloads.length, 1);
  } finally {
    cleanup();
  }
});

test("[R5-REPETE] pickup→delivery→pickup→delivery pendant la sauvegarde : le STALE tardif n'introduit ni conflit, ni erreur, ni relecture ; la dernière portée charge", async () => {
  const backend = pickupDeliveryBackend();
  const saveGate = deferred();
  const { container, cleanup } = setup({ backend, holdSave: () => saveGate.promise });
  try {
    await flush();
    typeInto(leadDays(container), "4");
    await flush();
    staleOutPickup(backend);
    saveButton(container).click();
    await flush();
    await select(container, DELIVERY);
    await select(container, PICKUP);
    await select(container, DELIVERY);
    await drain();
    const readsBefore = authoritativeReads.length;
    assert.equal(leadValue(container), "9");
    saveGate.release();
    await drain();
    assert.equal(authoritativeReads.length, readsBefore, "le STALE d'une portée abandonnée a déclenché une lecture");
    assert.equal(selectedScope(container), DELIVERY);
    assert.equal(leadValue(container), "9");
    assert.equal(statusOf(container), "clean");
    assert.ok(container.querySelector("[data-conflict='true']") === null);
    assert.ok(!saveErrorShown(container));
    // Retour sur pickup : lecture neuve, version du serveur (7), sans conflit.
    await select(container, PICKUP);
    await drain();
    assert.equal(leadValue(container), "7");
    assert.equal(statusOf(container), "clean");
    assert.ok(container.querySelector("[data-conflict='true']") === null);
  } finally {
    cleanup();
  }
});

test("[R5-ALLER-RETOUR] pickup→delivery→pickup, lecture pickup retenue, STALE tardif : la lecture pickup en vol n'est pas invalidée", async () => {
  const backend = pickupDeliveryBackend();
  const saveGate = deferred();
  const pickupGate = deferred();
  let armed = false;
  const { container, cleanup } = setup({
    backend,
    holdSave: () => saveGate.promise,
    holdAuthority: (_id, mode) => (armed && mode === "pickup" ? pickupGate.promise : null),
  });
  try {
    await flush();
    typeInto(leadDays(container), "4");
    await flush();
    staleOutPickup(backend);
    saveButton(container).click();
    await flush();
    await select(container, DELIVERY);
    await drain();
    armed = true;
    await select(container, PICKUP);
    saveGate.release();
    await drain();
    pickupGate.release();
    await drain();
    assert.equal(selectedScope(container), PICKUP);
    assert.equal(leadValue(container), "7", "la lecture neuve de pickup a été invalidée");
    assert.equal(statusOf(container), "clean");
    assert.ok(container.querySelector("[data-conflict='true']") === null);
  } finally {
    cleanup();
  }
});

test("[R5-ERREUR-AUTRE] refus non-STALE tardif d'une portée abandonnée : aucun message d'erreur, aucune offre de brouillon sur la portée courante", async () => {
  const { container, cleanup, saveGate, deliveryGate } = await pickupSavingThenDelivery({
    stale: false,
    refuse: "CSDJBO1_INCOMPLETE_CONFIGURATION",
  });
  try {
    saveGate.release();
    await drain();
    deliveryGate.release();
    await drain();
    assert.equal(selectedScope(container), DELIVERY);
    assert.equal(leadValue(container), "9");
    assert.equal(statusOf(container), "clean");
    assert.ok(!saveErrorShown(container), "message d'erreur de pickup sur delivery");
    assert.ok(container.querySelector("[data-draft-offer]") === null && !text(container).includes(fr("avSaveDraftOffer") ?? "\u0000"));
  } finally {
    cleanup();
  }
});

for (const order of ["succes-avant-lecture", "lecture-avant-succes"] as const) {
  test(`[R5-SUCCES-AUTRE-PORTEE-${order}] sauvegarde pickup RÉUSSIE tardive pendant que delivery est affiché : delivery n'est ni relu ni réinitialisé ; pickup relu de zéro au retour`, async () => {
    const { container, cleanup, saveGate, deliveryGate, backend } = await pickupSavingThenDelivery({ stale: false });
    try {
      if (order === "succes-avant-lecture") {
        saveGate.release();
        await drain();
        deliveryGate.release();
        await drain();
      } else {
        deliveryGate.release();
        await drain();
        saveGate.release();
        await drain();
      }
      const deliveryReads = authoritativeReads.filter((r) => r.modeCode === "delivery").length;
      assert.equal(deliveryReads, 1, "une réponse tardive d'une autre portée a relancé la lecture de delivery");
      assert.equal(selectedScope(container), DELIVERY);
      assert.equal(leadValue(container), "9");
      assert.equal(statusOf(container), "clean");
      assert.equal(pickupRow(backend).minLeadDays, 4, "pickup bien enregistré");
      // Le commerçant édite delivery après coup : rien ne l'écrase.
      typeInto(leadDays(container), "12");
      await drain();
      assert.equal(leadValue(container), "12");
      // Retour sur pickup : lecture neuve = version enregistrée, jetons neufs.
      await select(container, PICKUP);
      await drain();
      assert.equal(leadValue(container), "4");
      assert.equal(statusOf(container), "clean");
    } finally {
      cleanup();
    }
  });
}

test("[R5-ISOLATION] STALE tardif d'une portée abandonnée : aucune écriture, un autre commerçant et l'autre portée strictement intacts", async () => {
  const { backend: _b, mappings } = twoTenants();
  const backend = new FakeFulfillmentWriteBackend();
  const r1 = pickupDeliveryBackend().tenant("r1");
  backend.setTenant("r1", r1);
  const t = twoTenants();
  backend.setTenant("r2", t.backend.tenant("r2"));
  const saveGate = deferred();
  const { container, cleanup } = setup({ backend, mappings, holdSave: () => saveGate.promise });
  try {
    await flush();
    typeInto(leadDays(container), "4");
    await flush();
    staleOutPickup(backend);
    saveButton(container).click();
    await flush();
    await select(container, DELIVERY);
    await drain();
    const r2Before = backend.snapshot("r2");
    const deliveryBefore = JSON.stringify(deliveryRow(backend));
    saveGate.release();
    await drain();
    assert.equal(backend.snapshot("r2"), r2Before);
    assert.equal(JSON.stringify(deliveryRow(backend)), deliveryBefore);
    assert.equal(writtenPayloads.length, 1);
    assert.equal(leadValue(container), "9");
  } finally {
    cleanup();
  }
});

after(async () => {
  // Laisse finir toute activité React asynchrone avant de retirer `window`.
  await flush();
  await flush();
  await esbuild.stop();
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
});
