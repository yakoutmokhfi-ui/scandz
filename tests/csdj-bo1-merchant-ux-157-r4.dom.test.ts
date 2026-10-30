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
// CSDJ-BO-1 — REMÉDIATION R4 PR #157 (contre-audit Cat Turing R3 : R4-F02a, R4-F02b, R4-F01-SAVE) : rendu
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-bo1-ux157-"));
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
      if (hooks.refuseOnceWith !== undefined && refusalsPlayed === 0) {
        refusalsPlayed += 1;
        throw new FakeWriteRefusal(hooks.refuseOnceWith, "offer_missing");
      }
      const response = backend.save(id, payload) as Record<string, unknown>;
      const saveGate = hooks.holdSave?.(id) ?? null;
      if (saveGate !== null) await saveGate;
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
// Outils R4
// --------------------------------------------------------------------

const exampleState = (root: Element) =>
  q(root, "[data-server-example]").getAttribute("data-server-example");
const hasNothing = (root: Element, selector: string, message: string) =>
  assert.ok(root.querySelector(selector) === null, message);

function staleBackend() {
  const backend = pickupBackend();
  return {
    backend,
    beforeSave: () => {
      // Un tiers a désactivé la configuration : autre révision côté serveur.
      const s = backend.tenant("r1").schedules[0];
      s.enabled = false;
      s.updatedAt = "2026-10-14T00:00:03.333333Z";
      s.revision = "33333333333333333333333333333333";
    },
  };
}

/** Compte les RPC d'exemple réellement parties. */
function countingPreview(firstDate: string, gate?: Promise<void>) {
  const counter = { calls: 0 };
  (globalThis as any).__previewImpl = async () => {
    counter.calls += 1;
    if (gate) await gate;
    return previewOf(firstDate);
  };
  return counter;
}

/**
 * Exemple calculé (2026-10-20) ; le délai passe à 4 ; la sauvegarde est
 * refusée STALE ; la relecture du conflit (get_fulfillment_configuration)
 * est RETENUE (puis libérée en succès ou rejetée en erreur).
 */
async function staleWithHeldConflictRead(uiLang?: "fr" | "en" | "ar" | "nl") {
  const { backend, beforeSave } = staleBackend();
  const gate = deferred();
  let armed = false;
  const { container, cleanup } = setup({
    backend,
    beforeSave,
    holdAuthority: () => (armed ? gate.promise : null),
    uiLang,
  });
  await flush();
  const preview = countingPreview("2026-10-20");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await flush();
  assert.equal(exampleState(container), "ready");
  assert.equal(preview.calls, 1);

  typeInto(leadDays(container), "4");
  await flush();
  armed = true;
  saveButton(container).click();
  await flush();
  return { container, cleanup, gate, preview, backend, disarm: () => { armed = false; } };
}

// --------------------------------------------------------------------
// R4-F02a — conflit connu AVANT le premier await : aucun calcul, aucune date courante
// --------------------------------------------------------------------

for (const outcome of ["success", "error"] as const) {
  test(`[R4-F02a-${outcome}] STALE reçu, relecture du conflit RETENUE : conflit déjà posé, calcul impossible, aucune RPC d'exemple, aucune date courante ; puis relecture ${outcome === "success" ? "réussie" : "en erreur"}`, async () => {
    const { container, cleanup, gate, preview } = await staleWithHeldConflictRead();
    try {
      // Pendant que la relecture est en vol.
      assert.ok(container.querySelector("[data-conflict='true']"), "le conflit connu n'est pas posé avant la fin de la relecture");
      assert.equal(q(container, "[data-conflict]").getAttribute("data-conflict-reading"), "true");
      assert.equal(exampleState(container), "stale");
      hasNothing(container, "[data-server-example-first]", "date courante pendant le conflit");
      assert.ok(!text(container).includes("2026-10-20"));
      assert.equal(q<HTMLButtonElement>(container, "#av-server-example").disabled, true);
      q<HTMLButtonElement>(container, "#av-server-example").click();
      await flush();
      assert.equal(preview.calls, 1, "une RPC d'exemple est partie pendant le conflit");
      assert.equal(saveButton(container).disabled, true, "la sauvegarde doit être fermée dès le STALE");
      assert.equal(writtenPayloads.length, 1);

      if (outcome === "success") gate.release();
      else gate.reject(new Error("réseau coupé (relecture du conflit)"));
      await flush();
      await flush();

      assert.ok(container.querySelector("[data-conflict='true']"));
      assert.equal(
        q(container, "[data-conflict]").getAttribute("data-conflict-readable"),
        outcome === "success" ? "true" : "false"
      );
      assert.equal(exampleState(container), "stale");
      hasNothing(container, "[data-server-example-first]", "date courante après la relecture");
      assert.equal(q<HTMLButtonElement>(container, "#av-server-example").disabled, true);
      assert.equal(preview.calls, 1);
      assert.equal(writtenPayloads.length, 1, "aucune écriture implicite");
    } finally {
      cleanup();
    }
  });
}

test("[R4-F02a-retry] relecture du conflit en erreur puis « Réessayer » retenu : retour à l'état « lecture en cours », calcul toujours impossible", async () => {
  const { container, cleanup, gate, preview, disarm } = await staleWithHeldConflictRead();
  try {
    gate.reject(new Error("réseau coupé"));
    await flush();
    await flush();
    assert.equal(q(container, "[data-conflict]").getAttribute("data-conflict-readable"), "false");
    // Seconde relecture : non retenue, elle aboutit.
    disarm();
    q<HTMLButtonElement>(container, "#av-conflict-retry").click();
    await flush();
    await flush();
    assert.equal(q(container, "[data-conflict]").getAttribute("data-conflict-readable"), "true");
    assert.equal(exampleState(container), "stale");
    assert.equal(preview.calls, 1);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------
// R4-F02b — exemple en vol quand le STALE arrive : « périmé » tout de suite
// --------------------------------------------------------------------

test("[R4-F02b] exemple EN VOL au moment du STALE : l'écran annonce « périmé » IMMÉDIATEMENT (pas « loading »), avant la fin de la relecture et avant l'ancienne réponse", async () => {
  const { backend, beforeSave } = staleBackend();
  const previewGate = deferred();
  const readGate = deferred();
  let armed = false;
  const { container, cleanup } = setup({
    backend,
    beforeSave,
    holdAuthority: () => (armed ? readGate.promise : null),
  });
  try {
    await flush();
    const preview = countingPreview("2026-10-20", previewGate.promise);
    q<HTMLButtonElement>(container, "#av-server-example").click();
    await flush();
    assert.equal(exampleState(container), "loading", "précondition : l'exemple est en vol");

    typeInto(leadDays(container), "4");
    await flush();
    armed = true;
    saveButton(container).click();
    await flush();

    // STALE connu, relecture retenue, ancienne réponse pas arrivée.
    assert.equal(exampleState(container), "stale", "l'exemple en vol reste « loading » après le STALE");
    assert.ok(text(q(container, "[data-server-example]")).includes(fr("avServerExampleStale")));
    hasNothing(container, "[data-server-example-first]", "date visible");

    readGate.release();
    await flush();
    assert.equal(exampleState(container), "stale", "relecture terminée, ancienne réponse absente");

    previewGate.release();
    await flush();
    assert.equal(exampleState(container), "stale");
    hasNothing(container, "[data-server-example-first]", "date visible après l'ancienne réponse");
    assert.ok(!text(container).includes("2026-10-20"));
    assert.equal(preview.calls, 1);
  } finally {
    cleanup();
  }
});

test("[R4-F02b-late] ancienne réponse encore en vol APRÈS la résolution : une nouvelle demande reste possible et l'ancienne réponse tardive ne l'écrase pas", async () => {
  const { backend, beforeSave } = staleBackend();
  const previewGate = deferred();
  const { container, cleanup } = setup({ backend, beforeSave });
  try {
    await flush();
    countingPreview("2026-10-20", previewGate.promise);
    q<HTMLButtonElement>(container, "#av-server-example").click();
    await flush();
    typeInto(leadDays(container), "4");
    await flush();
    saveButton(container).click();
    await flush();
    q<HTMLButtonElement>(container, "#av-conflict-take-server").click();
    await flush();
    assert.equal(exampleState(container), "stale");
    assert.equal(q<HTMLButtonElement>(container, "#av-server-example").disabled, false, "bloqué par une réponse périmée qui n'arrive pas");

    countingPreview("2026-10-27");
    q<HTMLButtonElement>(container, "#av-server-example").click();
    await flush();
    assert.equal(exampleState(container), "ready");
    assert.equal(q(container, "[data-server-example-first]").textContent, "2026-10-27");

    previewGate.release();
    await flush();
    assert.equal(exampleState(container), "ready");
    assert.equal(q(container, "[data-server-example-first]").textContent, "2026-10-27", "l'ancienne réponse tardive a écrasé la nouvelle");
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------
// R4-F01-SAVE — la sauvegarde de A n'appartient jamais à B
// --------------------------------------------------------------------

function twoTenants2() {
  const t = twoTenants();
  return t;
}
const restaurantSelector = (root: Element): HTMLSelectElement =>
  ([...root.querySelectorAll("select")] as HTMLSelectElement[]).find((s) =>
    [...s.options].some((o) => o.value === "r2")
  )!;
const statusOf = (root: Element) =>
  q(root, "[data-editor-status]").getAttribute("data-editor-status");

async function aSavePendingThenB() {
  const { backend, mappings } = twoTenants2();
  const gates: Record<string, ReturnType<typeof deferred> | undefined> = {};
  const held: string[] = [];
  const { container, cleanup } = setup({
    backend,
    mappings,
    holdSave: (id) => {
      const g = gates[id];
      if (g) held.push(id);
      return g ? g.promise : null;
    },
  });
  await flush();
  gates["r1"] = deferred();
  typeInto(leadDays(container), "3");
  await flush();
  saveButton(container).click();
  await flush();
  assert.equal(statusOf(container), "saving", "précondition : la sauvegarde de A est en vol");
  assert.equal(held.length, 1);

  typeInto(restaurantSelector(container), "r2");
  await flush();
  await flush();
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "09:00", "précondition : B est chargé");
  return { container, cleanup, gates, backend, held };
}

for (const outcome of ["success", "error"] as const) {
  test(`[R4-F01-SAVE-${outcome}] sauvegarde de A en vol, passage à B chargé : B est modifiable AVANT et APRÈS l'arrivée de la réponse de A (${outcome === "success" ? "succès" : "erreur"}) ; rien de A n'entre dans B`, async () => {
    const { container, cleanup, gates, backend } = await aSavePendingThenB();
    try {
      const r2Before = backend.snapshot("r2");
      assert.notEqual(statusOf(container), "saving", "B hérite de l'état « saving » de A");
      assert.equal(leadDays(container).disabled, false, "l'éditeur de B est verrouillé par la sauvegarde de A");
      const leadBefore = leadDays(container).value;

      if (outcome === "success") gates["r1"]!.release();
      else gates["r1"]!.reject(new Error("réponse perdue"));
      await flush();
      await flush();

      assert.notEqual(statusOf(container), "saving");
      assert.equal(leadDays(container).disabled, false);
      assert.equal(leadDays(container).value, leadBefore, "le brouillon de B a changé");
      assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "09:00");
      assert.equal(backend.snapshot("r2"), r2Before, "r2 modifié");
      // Les seules écritures sont celles de A.
      assert.deepEqual(writtenPayloads.length, 1);

      // B édite et enregistre : jetons de B, adressés à B uniquement.
      typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
      await flush();
      saveButton(container).click();
      await flush();
      await flush();
      assert.equal(writtenPayloads.length, 2);
      assert.equal(writtenPayloads[1].expectedRevision, "22222222222222222222222222222222", "jetons de B");
      assert.equal(writtenPayloads[1].expectedUpdatedAt, "2026-10-12T07:00:00.222222Z");
      assert.equal(statusOf(container), "saved");
    } finally {
      cleanup();
    }
  });
}

test("[R4-F01-SAVE-race] réponses DÉSORDONNÉES : B sauvegarde pendant que A est encore en vol ; la réponse de A (avant OU après celle de B) ne libère ni ne verrouille B", async () => {
  const { container, cleanup, gates, held } = await aSavePendingThenB();
  try {
    gates["r2"] = deferred();
    typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
    await flush();
    saveButton(container).click();
    await flush();
    assert.equal(statusOf(container), "saving", "la sauvegarde de B est en vol");
    assert.equal(held.length, 2);

    // La réponse de A arrive PENDANT la sauvegarde de B : B reste « saving ».
    gates["r1"]!.release();
    await flush();
    await flush();
    assert.equal(statusOf(container), "saving", "la réponse de A a libéré la sauvegarde de B (garde retirée)");
    assert.equal(leadDays(container).disabled, true);

    gates["r2"]!.release();
    await flush();
    await flush();
    assert.equal(statusOf(container), "saved");
    assert.equal(leadDays(container).disabled, false);
  } finally {
    cleanup();
  }
});

test("[R4-I18N] FR/EN/AR/NL : la note « lecture du conflit en cours » existe, se rend pendant la relecture retenue (AR en RTL), sans clé brute ni date", async () => {
  const key = "avConflictReading";
  const params = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const value = (DICTS[lang] as Record<string, string>)[key];
    assert.ok(typeof value === "string" && value.trim().length > 2, `${lang}.${key} manquant`);
    assert.equal(params(value), params((DICTS.fr as Record<string, string>)[key]));
  }
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const { container, cleanup, gate } = await staleWithHeldConflictRead(lang);
    try {
      const d = DICTS[lang] as Record<string, string>;
      const t = text(container);
      assert.ok(t.includes(d.avConflictReading), `${lang} : note de lecture absente`);
      assert.ok(t.includes(d.avServerExampleConflict), `${lang} : note de conflit absente`);
      assert.ok(t.includes(d.avServerExampleStale), `${lang} : note « périmé » absente`);
      assert.ok(!/\bav[A-Z][A-Za-z0-9]+\b/.test(t), `${lang} : clé de traduction brute visible`);
      assert.ok(!t.includes("2026-10-20"), `${lang} : ancienne date visible`);
      if (lang === "ar") {
        assert.equal(q(container, "[data-availability-page]").getAttribute("dir"), "rtl");
      }
      gate.release();
      await flush();
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
