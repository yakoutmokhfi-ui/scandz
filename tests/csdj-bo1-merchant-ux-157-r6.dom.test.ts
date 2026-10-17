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
    /** Retient la sauvegarde AVANT son traitement par le serveur (l'écriture n'a pas encore eu lieu). */
    holdWrite?: (id: string) => Promise<void> | null;
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
      const writeGate = hooks.holdWrite?.(id) ?? null;
      if (writeGate !== null) await writeGate;
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
  holdWrite?: (id: string) => Promise<void> | null;
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
    holdWrite: options.holdWrite,
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
// R5-PREVIEW-ROUNDTRIP (contre-audit Cat Turing R5) — aller-retour pendant une sauvegarde
// --------------------------------------------------------------------

const exampleState = (root: Element) =>
  q(root, "[data-server-example]").getAttribute("data-server-example");
const nothing = (root: Element, selector: string, message: string) =>
  assert.ok(root.querySelector(selector) === null, message);
const activate = (root: Element) => q<HTMLInputElement>(root, "#av-activate");

/**
 * Pickup activé, exemple (2026-10-20) calculé, désactivation puis
 * sauvegarde dont le TRAITEMENT SERVEUR est retenu ; delivery puis retour
 * sur pickup (la lecture autoritaire précède donc le commit : elle rend
 * légitimement l'ancien snapshot activé) ; nouvel exemple calculé.
 */
async function roundTripBeforeCommit() {
  const backend = pickupDeliveryBackend();
  const writeGate = deferred();
  const { container, cleanup } = setup({
    backend,
    holdWrite: () => writeGate.promise,
  });
  await flush();
  assert.equal(selectedScope(container), PICKUP);
  assert.equal(activate(container).checked, true, "précondition : pickup est activé");
  (globalThis as any).__previewImpl = async () => previewOf("2026-10-20");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await drain();
  assert.equal(exampleState(container), "ready");

  activate(container).click();
  await flush();
  saveButton(container).click();
  await flush();
  assert.equal(writtenPayloads.length, 1, "précondition : la sauvegarde est partie");

  await select(container, DELIVERY);
  await drain();
  await select(container, PICKUP);
  await drain();
  // La lecture précède le commit : l'ancien snapshot (activé) est rendu.
  assert.equal(activate(container).checked, true, "précondition : snapshot lu avant le commit");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await drain();
  assert.equal(exampleState(container), "ready", "précondition : exemple calculé sur le snapshot ancien");
  assert.equal(q(container, "[data-server-example-first]").textContent, "2026-10-20");
  return { container, cleanup, writeGate, backend };
}

test("[R6-ROUNDTRIP] sauvegarde réussie tardive APRÈS un aller-retour : l'ancien exemple n'est plus « ready », l'écran rejoint la version enregistrée (désactivée), sans écriture supplémentaire", async () => {
  const { container, cleanup, writeGate, backend } = await roundTripBeforeCommit();
  try {
    writeGate.release();
    await drain();
    assert.equal(pickupRow(backend).enabled, false, "précondition : le serveur a désactivé pickup");
    assert.equal(exampleState(container), "stale", "l'ancien exemple est resté « ready » après un succès confirmé");
    nothing(container, "[data-server-example-first]", "date périmée visible");
    assert.ok(!text(container).includes("2026-10-20"));
    assert.equal(activate(container).checked, false, "l'écran affiche encore l'activation d'avant la sauvegarde");
    assert.equal(statusOf(container), "clean");
    assert.equal(writtenPayloads.length, 1, "aucune écriture supplémentaire");
    // Recalculer est possible et cohérent avec la version enregistrée.
    (globalThis as any).__previewImpl = async () => previewOf("2026-11-03");
    q<HTMLButtonElement>(container, "#av-server-example").click();
    await drain();
    assert.equal(exampleState(container), "ready");
    assert.equal(q(container, "[data-server-example-first]").textContent, "2026-11-03");
  } finally {
    cleanup();
  }
});

test("[R6-ROUNDTRIP-DIRTY] même aller-retour mais le commerçant a SAISI entre-temps : sa saisie n'est pas écrasée, l'exemple est périmé, la page dit qu'une sauvegarde est intervenue, et son enregistrement passe par le refus STALE (jamais en silence)", async () => {
  const { container, cleanup, writeGate } = await roundTripBeforeCommit();
  try {
    typeInto(leadDays(container), "6");
    await flush();
    writeGate.release();
    await drain();
    assert.equal(leadValue(container), "6", "la saisie du commerçant a été écrasée");
    assert.equal(draftState(container), "dirty");
    assert.equal(exampleState(container), "stale");
    nothing(container, "[data-server-example-first]", "date périmée visible");
    assert.ok(container.querySelector("[data-saved-meanwhile='true']") !== null, "aucune mention qu'une sauvegarde est intervenue");
    assert.ok(text(q(container, "[data-saved-meanwhile]")).includes(fr("avSavedMeanwhile")));
    assert.equal(writtenPayloads.length, 1, "aucune écriture implicite");
    // Son enregistrement part avec les jetons anciens : le serveur le refuse (STALE).
    saveButton(container).click();
    await drain();
    assert.equal(writtenPayloads.length, 2);
    assert.ok(container.querySelector("[data-conflict='true']") !== null, "le conflit n'est pas affiché");
    assert.equal(leadValue(container), "6");
  } finally {
    cleanup();
  }
});

test("[R6-ORDRE] lecture APRÈS le commit (écriture libérée avant le retour) : l'écran est cohérent d'emblée et la correction n'ajoute pas de relecture inutile", async () => {
  const backend = pickupDeliveryBackend();
  const writeGate = deferred();
  const { container, cleanup } = setup({ backend, holdWrite: () => writeGate.promise });
  try {
    await flush();
    activate(container).click();
    await flush();
    saveButton(container).click();
    await flush();
    await select(container, DELIVERY);
    await drain();
    writeGate.release();
    await drain();
    const pickupReadsBefore = authoritativeReads.filter((r) => r.modeCode === "pickup").length;
    await select(container, PICKUP);
    await drain();
    const pickupReads = authoritativeReads.filter((r) => r.modeCode === "pickup").length;
    assert.equal(pickupReads, pickupReadsBefore + 1, "retour sur pickup = une seule lecture neuve");
    assert.equal(activate(container).checked, false);
    assert.equal(statusOf(container), "clean");
  } finally {
    cleanup();
  }
});

test("[R6-AUTRE-PORTEE] succès tardif de pickup pendant que delivery est affiché : l'exemple de delivery reste « ready », son brouillon et ses lectures ne bougent pas (pas de péremption inutile)", async () => {
  const backend = pickupDeliveryBackend();
  const writeGate = deferred();
  const { container, cleanup } = setup({ backend, holdWrite: () => writeGate.promise });
  try {
    await flush();
    activate(container).click();
    await flush();
    saveButton(container).click();
    await flush();
    await select(container, DELIVERY);
    await drain();
    (globalThis as any).__previewImpl = async () => previewOf("2026-10-22");
    q<HTMLButtonElement>(container, "#av-server-example").click();
    await drain();
    assert.equal(exampleState(container), "ready");
    const deliveryReads = authoritativeReads.filter((r) => r.modeCode === "delivery").length;

    writeGate.release();
    await drain();
    assert.equal(selectedScope(container), DELIVERY);
    assert.equal(exampleState(container), "ready", "péremption inutile de l'exemple de delivery");
    assert.equal(q(container, "[data-server-example-first]").textContent, "2026-10-22");
    assert.equal(leadValue(container), "9");
    assert.equal(statusOf(container), "clean");
    assert.equal(authoritativeReads.filter((r) => r.modeCode === "delivery").length, deliveryReads);
  } finally {
    cleanup();
  }
});

test("[R6-I18N] FR/EN/AR/NL : la mention « sauvegarde intervenue entre-temps » existe, se rend (AR en RTL), sans clé brute", async () => {
  const key = "avSavedMeanwhile";
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const value = (DICTS[lang] as Record<string, string>)[key];
    assert.ok(typeof value === "string" && value.trim().length > 2, `${lang}.${key} manquant`);
  }
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const backend = pickupDeliveryBackend();
    const writeGate = deferred();
    const { container, cleanup } = setup({ backend, holdWrite: () => writeGate.promise, uiLang: lang });
    try {
      await flush();
      (globalThis as any).__previewImpl = async () => previewOf("2026-10-20");
      activate(container).click();
      await flush();
      saveButton(container).click();
      await flush();
      await select(container, DELIVERY);
      await drain();
      await select(container, PICKUP);
      await drain();
      typeInto(leadDays(container), "6");
      await flush();
      writeGate.release();
      await drain();
      const d = DICTS[lang] as Record<string, string>;
      const t = text(container);
      assert.ok(t.includes(d.avSavedMeanwhile), `${lang} : mention absente`);
      assert.ok(!/\bav[A-Z][A-Za-z0-9]+\b/.test(t), `${lang} : clé brute visible`);
      if (lang === "ar") assert.equal(q(container, "[data-availability-page]").getAttribute("dir"), "rtl");
    } finally {
      cleanup();
    }
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
