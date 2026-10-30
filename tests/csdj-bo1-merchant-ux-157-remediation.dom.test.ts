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
// CSDJ-BO-1 — REMÉDIATION PR #157 (audit Cat Turing, F-01/F-02) : rendu
// réel (jsdom), drapeau d'écriture RÉEL, promesses CONTRÔLÉES.
//
// Chaque test est une reproduction de l'audit (R1, R2, R3) : il a été
// exécuté sur le HEAD audité b060eba (rouge) puis sur le correctif (vert).
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
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
// F-01 — une relecture n'efface JAMAIS une saisie
// --------------------------------------------------------------------

test("[R1] relecture retenue, saisie J+5 pendant l'attente, réponse tardive : la saisie SURVIT, rien n'est enregistré", async () => {
  const backend = pickupBackend();
  const gate = deferred();
  let armed = false;
  const { container, cleanup } = divergentSetup(backend, {
    holdLists: () => (armed ? gate.promise : null),
  });
  await flush();
  assert.ok(container.querySelector("[data-reads-disagree]"), "précondition : divergence signalée");
  assert.equal(leadDays(container).value, "1");

  armed = true;
  q<HTMLButtonElement>(container, "#av-reload-server").click();
  await flush();
  typeInto(leadDays(container), "5");
  await flush();
  assert.equal(leadDays(container).value, "5");

  gate.promise.then(() => {});
  gate.release();
  await flush();

  assert.equal(leadDays(container).value, "5", "la réponse tardive a effacé la saisie");
  assert.equal(draftState(container), "dirty");
  assert.equal(writtenPayloads.length, 0, "aucun enregistrement implicite");
  assert.equal(backend.tenant("r1").schedules[0].minLeadDays, 1, "le serveur n'a pas été touché");
  assert.ok(container.querySelector("[data-reload-abandoned]"), "la relecture abandonnée est dite");
  cleanup();
});

test("[R2] pendant la relecture de « Retrait », bascule vers la règle de livraison et saisie J+7 : la réponse tardive de « Retrait » ne touche PAS le brouillon de la livraison", async () => {
  const backend = twoScopeBackend();
  const gate = deferred();
  let armed = false;
  const { container, cleanup } = divergentSetup(backend, {
    holdLists: () => (armed ? gate.promise : null),
  });
  await flush();
  assert.ok(container.querySelector("[data-reads-disagree]"));

  armed = true;
  q<HTMLButtonElement>(container, "#av-reload-server").click();
  await flush();

  const select = q<HTMLSelectElement>(container, "#av-scope-select");
  const deliveryKey = [...select.options].find((o) => o.value.includes(DELIVERY_RULE))!.value;
  typeInto(select, deliveryKey);
  await flush();
  assert.equal(leadDays(container).value, "4", "précondition : brouillon de la livraison");
  typeInto(leadDays(container), "7");
  await flush();
  assert.equal(leadDays(container).value, "7");

  gate.release();
  await flush();

  assert.equal(select.value, deliveryKey, "la portée affichée n'a pas bougé");
  assert.equal(leadDays(container).value, "7", "la réponse tardive de « Retrait » a écrasé la saisie de la livraison");
  assert.equal(draftState(container), "dirty");
  assert.equal(writtenPayloads.length, 0);
  cleanup();
});

test("[R1b] sans aucune saisie, la relecture s'applique : les deux lectures concordent ensuite (contrôle positif)", async () => {
  const backend = pickupBackend();
  const { container, cleanup } = divergentSetup(backend);
  await flush();
  q<HTMLButtonElement>(container, "#av-reload-server").click();
  await flush();
  assert.equal(container.querySelector("[data-reads-disagree]"), null);
  assert.equal(container.querySelector("[data-reload-abandoned]"), null);
  assert.equal(q<HTMLSelectElement>(container, "#av-date-mode").value, "derived_earliest");
  cleanup();
});

test("[R1c] relecture en cours : le bouton est inactif et dit « Relecture… » ; un second clic ne lance pas une seconde relecture", async () => {
  const backend = pickupBackend();
  const gate = deferred();
  let armed = false;
  let listReads = 0;
  const { container, cleanup } = divergentSetup(backend, {
    holdLists: () => {
      if (armed) listReads += 1;
      return armed ? gate.promise : null;
    },
  });
  await flush();
  armed = true;
  const button = q<HTMLButtonElement>(container, "#av-reload-server");
  button.click();
  await flush();
  assert.equal(q<HTMLButtonElement>(container, "#av-reload-server").disabled, true);
  q<HTMLButtonElement>(container, "#av-reload-server").click();
  await flush();
  assert.equal(listReads, 1, "une seule relecture en vol");
  gate.release();
  await flush();
  assert.equal(container.querySelector("[data-reads-disagree]"), null);
  cleanup();
});

// --------------------------------------------------------------------
// F-02 — l'exemple du serveur est lié à la VERSION enregistrée
// --------------------------------------------------------------------

test("[R3] exemple calculé (2026-10-20), désactivation puis enregistrement réussi : l'ancien exemple n'est plus présenté comme actuel", async () => {
  const backend = pickupBackend();
  const { container, cleanup } = setup({ backend });
  await flush();
  (globalThis as any).__previewImpl = async () => previewOf("2026-10-20");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await flush();
  assert.equal(q(container, "[data-server-example]").getAttribute("data-server-example"), "ready");
  assert.equal(q(container, "[data-server-example-first]").textContent, "2026-10-20");

  q<HTMLInputElement>(container, "#av-activate").click();
  await flush();
  saveButton(container).click();
  await flush();
  assert.equal(draftState(container), "saved", "précondition : l'enregistrement a réussi");

  const box = q(container, "[data-server-example]");
  assert.equal(box.getAttribute("data-server-example"), "stale", "l'exemple ancien est resté présenté comme actuel");
  assert.equal(container.querySelector("[data-server-example-first]"), null, "la date périmée n'est plus affichée");
  assert.ok(text(box).includes(fr("avServerExampleStale")));
  assert.ok(!text(container).includes("2026-10-20"));

  // Recalculer redonne un exemple valable pour la NOUVELLE version.
  (globalThis as any).__previewImpl = async () => previewOf("2026-10-22");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await flush();
  assert.equal(q(container, "[data-server-example]").getAttribute("data-server-example"), "ready");
  assert.equal(q(container, "[data-server-example-first]").textContent, "2026-10-22");
  cleanup();
});

test("[R3b] calcul EN VOL pendant un changement de version : la réponse tardive n'est jamais présentée comme actuelle", async () => {
  const backend = pickupBackend();
  const gate = deferred();
  const { container, cleanup } = setup({ backend });
  await flush();
  (globalThis as any).__previewImpl = async () => {
    await gate.promise;
    return previewOf("2026-10-20");
  };
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await flush();
  assert.equal(q(container, "[data-server-example]").getAttribute("data-server-example"), "loading");

  q<HTMLInputElement>(container, "#av-activate").click();
  await flush();
  saveButton(container).click();
  await flush();
  assert.equal(draftState(container), "saved");

  gate.release();
  await flush();
  const box = q(container, "[data-server-example]");
  assert.notEqual(box.getAttribute("data-server-example"), "ready", "une réponse d'une version ancienne est présentée comme actuelle");
  assert.equal(container.querySelector("[data-server-example-first]"), null);
  assert.ok(!text(container).includes("2026-10-20"));
  cleanup();
});

test("[R3c] résolution d'un conflit STALE : l'exemple calculé avant n'est plus présenté comme actuel", async () => {
  const backend = pickupBackend();
  const { container, cleanup } = setup({
    backend,
    beforeSave: () => {
      const s = backend.tenant("r1").schedules[0];
      s.cutoffTime = "15:00:00";
      s.updatedAt = "2026-10-14T00:00:01.654321Z";
      s.revision = "ffffffffffffffffffffffffffffffff";
    },
  });
  await flush();
  (globalThis as any).__previewImpl = async () => previewOf("2026-10-20");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await flush();
  assert.equal(q(container, "[data-server-example]").getAttribute("data-server-example"), "ready");

  typeInto(leadDays(container), "2");
  await flush();
  saveButton(container).click();
  await flush();
  assert.ok(container.querySelector("[data-conflict='true']"));
  q<HTMLButtonElement>(container, "#av-conflict-take-server").click();
  await flush();
  assert.equal(q(container, "[data-server-example]").getAttribute("data-server-example"), "stale");
  assert.equal(container.querySelector("[data-server-example-first]"), null);
  cleanup();
});

test("[R3d] des modifications non enregistrées sont dites ABSENTES de l'exemple, sans jamais être calculées dans le navigateur", async () => {
  const backend = pickupBackend();
  const { container, cleanup } = setup({ backend });
  await flush();
  (globalThis as any).__previewImpl = async () => previewOf("2026-10-20");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await flush();
  assert.equal(container.querySelector("[data-server-example-dirty]"), null);
  typeInto(leadDays(container), "3");
  await flush();
  const note = q(container, "[data-server-example-dirty]");
  assert.ok(text(note).includes(fr("avServerExampleDirty")));
  // La date affichée reste celle du serveur : aucune recomposition locale.
  assert.equal(q(container, "[data-server-example-first]").textContent, "2026-10-20");
  cleanup();
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
});
