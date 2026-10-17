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
import { CSDJ_BO1_WRITE_CONTRACT } from "../lib/availability-editor.ts";
import {
  EDITOR_STATUS_KEY,
  customerSentenceKeyOf,
  editorStatusOf,
  modeLabelKeyOf,
  weeklyScheduleSummary,
} from "../lib/availability-ux.ts";

// ====================================================================
// CSDJ-BO-1 — REFONTE UX COMMERÇANT (issue #156) : rendu réel (jsdom).
//
// La page est rendue pour de vrai, le drapeau d'écriture est le VRAI
// (`available: true` depuis #154) -- aucun artifice sur le contrat,
// contrairement à csdj-bo1-editor-save. Seuls les services sont doublés,
// par le même backend d'écriture simulé que les suites voisines.
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-bo1-ux156-"));
const tmpFile = path.join(tmpDir, "AvailabilityPage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { AvailabilityPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --------------------------------------------------------------------
// Amorçage
// --------------------------------------------------------------------

type Io = {
  readSchedules(id: string): unknown[];
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
    readSchedules: schedulesOf,
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
  authoritativeReads.length = 0;
  writtenPayloads.length = 0;
  (globalThis as any).__io = io(options.backend, {
    beforeSave: options.beforeSave,
    refuseOnceWith: options.refuseOnceWith,
    afterListsRead: options.afterListsRead,
    holdAuthority: options.holdAuthority,
    failAuthorityAfter: options.failAuthorityAfter,
    authorityReturnsNull: options.authorityReturnsNull,
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


const en = (key: string) => (DICTS.en as Record<string, string>)[key];
const text = (root: Element) => root.textContent ?? "";

function previewOf(firstDate: string): Record<string, unknown> {
  return {
    deliveryApplicable: false,
    deliveryEligible: false,
    deliveryBlock: null,
    deliveryCustomerText: null,
    scheduleStatus: "schedulable",
    unfulfillableReason: null,
    scheduleTimezone: "Europe/Paris",
    dateSelectionMode: "customer_selectable",
    slotSelectionMode: "fixed_slots",
    timeGranularityMinutes: null,
    firstEligibleDate: firstDate,
    eligibleDates: [firstDate],
    offers: {
      [firstDate]: [
        { slot_key: "midi", starts_at: "11:00", ends_at: "14:00" },
        { slot_key: "soir", starts_at: "16:00", ends_at: "20:00" },
      ],
    },
  };
}

function pickupBackend(): FakeFulfillmentWriteBackend {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  return backend;
}

// --------------------------------------------------------------------
// Constat 1 — la bannière et la raison ne mentent plus
// --------------------------------------------------------------------

test("[UX156-1] contrat disponible + rôle d'écriture : ni bannière, ni raison « inactif », état « enregistré »", async () => {
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, true);
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();

  assert.equal(container.querySelector("[data-write-contract]"), null);
  assert.ok(!text(container).includes("n'est pas encore approuvé"));
  assert.ok(!text(container).includes("Inactif : l'enregistrement attend"));
  assert.equal(q(container, "[data-editor-status]").getAttribute("data-editor-status"), "clean");
  const activate = q<HTMLInputElement>(container, "#av-activate");
  assert.equal(activate.disabled, false, "l'activation est actionnable pour un propriétaire");
  assert.equal(q(container, "#" + activate.getAttribute("aria-describedby")).id, "av-activate-help");
  cleanup();
});

test("[UX156-1b] rôle sans droit d'écriture : l'état est « lecture seule », la raison est le RÔLE, rien d'actionnable", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend(), role: "staff" });
  await flush();

  assert.equal(q(container, "[data-editor-status]").getAttribute("data-editor-status"), "readonly");
  assert.equal(q<HTMLInputElement>(container, "#av-activate").disabled, true);
  assert.equal(
    q(container, "#av-write-disabled-reason").textContent,
    fr("avSaveDisabledWhyRole")
  );
  assert.equal(saveButton(container).disabled, true);
  assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "role");
  assert.equal(container.querySelector("[data-write-contract]"), null);
  cleanup();
});

test("[UX156-1c] l'opérateur Scanym n'a pas d'écriture : « lecture seule » aussi", async () => {
  const { container, cleanup } = setup({
    backend: pickupBackend(),
    role: "owner",
    isOperator: true,
    mappings: [],
  });
  await flush();
  assert.equal(saveButton(container).disabled, true);
  assert.equal(container.querySelector("[data-write-contract]"), null);
  cleanup();
});

// --------------------------------------------------------------------
// Constat 2 — le résumé, le brouillon et le serveur disent la même chose
// --------------------------------------------------------------------

test("[UX156-2] une modification non enregistrée est annoncée « modifiée, non enregistrée » ; la version enregistrée reste nommée à part ; enregistrer réconcilie", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();

  const summary = q(container, "[data-customer-summary]");
  assert.equal(summary.getAttribute("data-customer-summary"), "saved");
  assert.equal(
    q(container, "[data-summary-saved]").getAttribute("data-summary-saved"),
    "avCustomerDateAndSlot"
  );
  assert.equal(container.querySelector("[data-summary-unsaved]"), null);
  assert.equal(q<HTMLSelectElement>(container, "#av-date-mode").value, "customer_selectable");

  typeInto(q(container, "#av-date-mode"), "derived_earliest");
  await flush();

  assert.equal(q(container, "[data-customer-summary]").getAttribute("data-customer-summary"), "unsaved");
  assert.equal(
    q(container, "[data-summary-unsaved]").getAttribute("data-summary-unsaved"),
    "avCustomerFirstDate"
  );
  // La version enregistrée n'a pas bougé et la ligne du tableau non plus.
  assert.equal(
    q(container, "[data-summary-saved]").getAttribute("data-summary-saved"),
    "avCustomerDateAndSlot"
  );
  assert.ok(text(q(container, "table")).includes(fr("avCustomerDateAndSlot")));
  assert.equal(q(container, "[data-editor-status]").getAttribute("data-editor-status"), "dirty");
  // Aucune valeur métier n'a été changée en silence : seul le sélecteur
  // que le commerçant a touché a bougé.
  assert.equal(q<HTMLSelectElement>(container, "#av-slot-mode").value, "fixed_slots");

  // « Je choisis la date » + créneaux nommés est incohérent : la page le
  // dit au lieu de réécrire le créneau à la place du commerçant.
  assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "issues");
  assert.ok(text(q(container, "[data-section-issues]")).length > 10, "le motif est écrit");
  // Retour au réglage d'origine, puis un changement valide : désactiver.
  typeInto(q(container, "#av-date-mode"), "customer_selectable");
  await flush();
  assert.equal(q(container, "[data-customer-summary]").getAttribute("data-customer-summary"), "saved");
  q<HTMLInputElement>(container, "#av-activate").click();
  await flush();
  assert.equal(
    q(container, "[data-summary-unsaved]").getAttribute("data-summary-unsaved"),
    "avCustomerNoDate"
  );
  assert.equal(
    saveButton(container).getAttribute("data-write-disabled-reason"),
    "none"
  );
  saveButton(container).click();
  await flush();
  assert.equal(q(container, "[data-customer-summary]").getAttribute("data-customer-summary"), "saved");
  assert.equal(
    q(container, "[data-summary-saved]").getAttribute("data-summary-saved"),
    "avCustomerNoDate"
  );
  assert.equal(q<HTMLInputElement>(container, "#av-activate").checked, false);
  assert.equal(draftState(container), "saved");
  cleanup();
});

test("[UX156-2b] le sélecteur et le résumé enregistré proviennent de la MÊME lecture : rechargement = mêmes valeurs", async () => {
  const backend = pickupBackend();
  backend.tenant("r1").schedules[0].dateSelectionMode = "derived_earliest";
  const { container, cleanup } = setup({ backend });
  await flush();
  assert.equal(q<HTMLSelectElement>(container, "#av-date-mode").value, "derived_earliest");
  assert.equal(
    q(container, "[data-summary-saved]").getAttribute("data-summary-saved"),
    "avCustomerFirstDate"
  );
  assert.equal(container.querySelector("[data-reads-disagree]"), null);
  cleanup();
});

test("[UX156-2c] si la liste et la configuration du serveur se contredisent, la page le DIT, ne tranche pas en silence, et propose de relire", async () => {
  const backend = pickupBackend();
  // La liste est lue AVANT qu'un tiers ne modifie la portée ; la lecture
  // autoritaire, qui part ensuite, voit la version du tiers.
  const { container, cleanup } = setup({
    backend,
    afterListsRead: () => {
      backend.tenant("r1").schedules[0].dateSelectionMode = "derived_earliest";
    },
  });
  await flush();

  const alert = q(container, "[data-reads-disagree]");
  assert.equal(alert.getAttribute("role"), "alert");
  assert.ok(text(alert).includes(fr("avCustomerDateAndSlot")));
  assert.ok(text(alert).includes(fr("avCustomerFirstDate")));
  // Le formulaire montre la configuration autoritaire, jamais un mélange.
  assert.equal(q<HTMLSelectElement>(container, "#av-date-mode").value, "derived_earliest");

  q<HTMLButtonElement>(container, "#av-reload-server").click();
  await flush();
  assert.equal(container.querySelector("[data-reads-disagree]"), null, "après relecture les deux lectures concordent");
  assert.equal(
    q(container, "[data-summary-saved]").getAttribute("data-summary-saved"),
    "avCustomerFirstDate"
  );
  cleanup();
});

test("[UX156-2d] pas de valeur par défaut affichée tant que le serveur n'a pas répondu : chargement annoncé, aucun sélecteur", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { container, cleanup } = setup({ backend: pickupBackend(), holdAuthority: () => gate });
  await flush();

  assert.ok(container.querySelector("[data-draft-loading]"), "le chargement est annoncé");
  assert.equal(container.querySelector("#av-date-mode"), null, "aucun sélecteur ne montre une valeur inventée");
  assert.equal(container.querySelector("#av-slot-mode"), null);
  assert.equal(q(container, "[data-customer-summary]").getAttribute("data-customer-summary"), "loading");
  assert.equal(q(container, "[data-editor-status]").getAttribute("data-editor-status"), "loading");
  assert.equal(q<HTMLInputElement>(container, "#av-activate").disabled, true);

  release();
  await flush();
  assert.equal(container.querySelector("[data-draft-loading]"), null);
  assert.equal(q<HTMLSelectElement>(container, "#av-date-mode").value, "customer_selectable");
  cleanup();
});

test("[UX156-2e] lecture autoritaire absente : valeurs de la liste, enregistrement fermé, DIT en tête avec un moyen de relire", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend(), authorityReturnsNull: true });
  await flush();

  const note = q(container, "[data-unverified]");
  assert.equal(note.getAttribute("role"), "alert");
  assert.equal(q(container, "[data-editor-status]").getAttribute("data-editor-status"), "unverified");
  assert.equal(saveButton(container).disabled, true);
  assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "authority");
  assert.ok(container.querySelector("#av-unverified-retry"));
  cleanup();
});

test("[UX156-2f] relire est REFUSÉ quand des modifications ne sont pas enregistrées (rien ne s'efface en silence)", async () => {
  const backend = pickupBackend();
  const { container, cleanup } = setup({
    backend,
    afterListsRead: () => {
      backend.tenant("r1").schedules[0].dateSelectionMode = "derived_earliest";
    },
  });
  await flush();
  typeInto(q(container, "#av-lead-days"), "3");
  await flush();
  assert.equal(q<HTMLButtonElement>(container, "#av-reload-server").disabled, true);
  assert.equal(q<HTMLInputElement>(container, "#av-lead-days").value, "3");
  cleanup();
});

// --------------------------------------------------------------------
// Constat 3/4/8 — langage commerçant, méthode v1 sans options v1.2
// --------------------------------------------------------------------

test("[UX156-3] « Retrait en boutique » à la place de « pickup » ; le code brut n'est plus que dans les détails techniques", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  assert.equal(fr("avModePickup"), "Retrait en boutique");
  const firstCell = q(container, "table tbody tr td strong");
  assert.equal(firstCell.textContent, "Retrait en boutique");
  assert.ok(text(container).includes("Retrait en boutique"));

  const tech = q(container, "[data-tech-details]");
  const outside = [...container.querySelectorAll("strong, option, h2, h3, h4, span, td")].filter(
    (el) => !tech.contains(el) && (el.textContent ?? "").trim() === "pickup"
  );
  assert.deepEqual(outside.map((el) => el.outerHTML), [], "le code « pickup » n'apparaît que dans les détails techniques");
  assert.ok(tech.tagName === "DETAILS" && !tech.hasAttribute("open"), "les détails techniques sont repliés");
  assert.ok(text(tech).includes("pickup"));
  cleanup();
});

test("[UX156-3b] les noms de mode existent dans les quatre langues, sans doublon de terme anglais en FR", () => {
  assert.equal(modeLabelKeyOf("pickup"), "avModePickup");
  assert.equal(modeLabelKeyOf("delivery"), "avModeDelivery");
  assert.equal(modeLabelKeyOf("click_collect"), null, "un code inconnu n'est jamais inventé");
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const d = DICTS[lang] as Record<string, string>;
    assert.ok(d.avModePickup.length > 3 && d.avModeDelivery.length > 3, lang);
  }
  assert.equal(en("avModePickup"), "In-store pickup");
});

test("[UX156-4] méthode v1 : aucun champ v1.2 demandé, aucun manque affiché, une seule phrase d'explication", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();

  assert.equal(q(container, "[data-schedule-method]").getAttribute("data-schedule-method"), "v1");
  assert.ok(!text(container).includes("Aucun jour de préparation"));
  assert.equal(container.querySelector("[data-prep-weekday]"), null);
  assert.equal(container.querySelector("[data-add-row='prep-closure']"), null);
  assert.equal(container.querySelector("[data-holiday-calendar]"), null);
  assert.equal(container.querySelector("#av-capacity-max"), null);
  assert.ok(container.querySelector("[data-v12-only='true']"));
  assert.ok(container.querySelector("[data-v12-only-section='capacity']"));
  // L'option technique reste atteignable, mais rangée dans les options avancées.
  const offset = q(container, "#av-cutoff-offset");
  assert.ok(offset.closest("details"), "le décalage est dans les options avancées");
  cleanup();
});

test("[UX156-4b] méthode v1.2 : les options v1.2 existent bel et bien (non régression)", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  const state = auLaitCruPickupFixture();
  state.v12 = [
    {
      modeCode: "pickup",
      fulfillmentRuleId: null,
      scheduleMethodVersion: "v1.2",
      holidayCalendarId: null,
      preparationOnHolidays: "open",
      availabilityOnHolidays: "open",
      capacityEnabled: false,
      capacityMaxOrders: null,
      preparationWeekdays: [2, 3, 4, 5, 6],
      preparationClosures: [],
    },
  ];
  state.schedules[0].cutoffOffsetDays = 0;
  backend.setTenant("r1", state);
  const { container, cleanup } = setup({ backend });
  await flush();
  assert.equal(q(container, "[data-schedule-method]").getAttribute("data-schedule-method"), "v1.2");
  assert.ok(container.querySelector("[data-prep-weekday]"));
  assert.ok(container.querySelector("[data-add-row='prep-closure']"));
  assert.ok(container.querySelector("#av-capacity-max"));
  assert.ok(container.querySelector("[data-holiday-calendar]"));
  assert.equal(container.querySelector("[data-v12-only='true']"), null);
  assert.equal(container.querySelector("#av-cutoff-offset"), null);
  cleanup();
});

// --------------------------------------------------------------------
// Constat 5/9 — exemples concrets ; la date vient du serveur
// --------------------------------------------------------------------

test("[UX156-5] exemple en clair tiré des réglages saisis (J+1, 16:00, décalage 1, horizon 14) ; aucune date calculée dans le navigateur", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  const plain = q(container, "[data-plain-example]");
  const t = text(plain);
  assert.ok(t.includes("J + 1"));
  assert.ok(t.includes("16:00"));
  assert.ok(t.includes("14 jour(s)"));
  assert.ok(!/\b20\d{2}-\d{2}-\d{2}\b/.test(t), "aucune date n'est calculée côté navigateur");
  cleanup();
});

test("[UX156-5b] l'exemple daté vient du serveur : première date + créneaux de CE jour-là, et il dit qu'il reflète la version enregistrée", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  assert.equal(q(container, "[data-server-example]").getAttribute("data-server-example"), "idle");
  (globalThis as any).__previewResult = previewOf("2026-10-16");
  q<HTMLButtonElement>(container, "#av-server-example").click();
  await flush();
  const box = q(container, "[data-server-example]");
  assert.equal(box.getAttribute("data-server-example"), "ready");
  assert.equal(q(box, "[data-server-example-first]").textContent, "2026-10-16");
  assert.ok(text(box).includes("midi 11:00–14:00"));
  assert.ok(text(box).includes("soir 16:00–20:00"));
  assert.ok(text(box).includes(fr("avServerExampleSaved")));
  cleanup();
});

test("[UX156-9] l'aperçu serveur dit qu'il ne simule pas une commande et que le retrait n'est pas encore relié (CSDJ-2)", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  const note = q(container, "[data-preview-disclaimer]");
  assert.ok(text(note).includes("n'est pas une commande simulée"));
  assert.ok(text(note).includes("CSDJ-2"));
  cleanup();
});

// --------------------------------------------------------------------
// Constat 7 — jours et horaires évidents ; règles Au Lait Cru intactes
// --------------------------------------------------------------------

test("[UX156-7] résumé hebdomadaire : mardi–samedi 11–14 et 16–20, dimanche et lundi fermés ; le brouillon n'a pas été réécrit", async () => {
  const backend = pickupBackend();
  const before = backend.snapshot("r1");
  const { container, cleanup } = setup({ backend });
  await flush();
  const days = [...container.querySelectorAll("[data-summary-weekday]")];
  assert.equal(days.length, 7);
  const closed = days.filter((d) => d.getAttribute("data-summary-closed") === "true").map((d) => d.getAttribute("data-summary-weekday"));
  assert.deepEqual(closed.sort(), ["0", "1"], "dimanche (0) et lundi (1) fermés");
  for (const w of ["2", "3", "4", "5", "6"]) {
    const d = q(container, `[data-summary-weekday="${w}"]`);
    assert.ok(text(d).includes("midi 11:00–14:00 · soir 16:00–20:00"), `jour ${w} : ${text(d)}`);
  }
  assert.equal(backend.snapshot("r1"), before, "simple lecture : rien n'est écrit");
  cleanup();
});

test("[UX156-7b] weeklyScheduleSummary : un jour sans plage est fermé, en fenêtres comme en créneaux, trié par heure", () => {
  const draft = {
    slotSelectionMode: "time_within_window",
    windows: [
      { rowId: "a", weekday: 2, startsAt: "16:00:00", endsAt: "20:00:00" },
      { rowId: "b", weekday: 2, startsAt: "11:00", endsAt: "14:00" },
    ],
    slots: [],
  } as never;
  const out = weeklyScheduleSummary(draft);
  assert.deepEqual(out.map((d) => d.weekday), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(out.find((d) => d.weekday === 2)!.ranges, ["11:00–14:00", "16:00–20:00"]);
  assert.deepEqual(out.find((d) => d.weekday === 1)!.ranges, []);
});

// --------------------------------------------------------------------
// Constat 6/8 — modes et zones expliqués ; fermetures séparées
// --------------------------------------------------------------------

test("[UX156-6] la page explique quels modes sont modifiables et pourquoi les autres n'apparaissent pas", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  assert.ok(text(container).includes(fr("avScopeWhy")));
  assert.ok(text(container).includes("n'est pas modifiable ici"));
  cleanup();
});

test("[UX156-8] fermetures client et fermetures d'atelier sont des listes distinctes ; en v1 l'atelier et les fériés sont absents", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  assert.ok(text(container).includes(fr("avClosuresCustomerTitle")));
  assert.ok(!text(container).includes(fr("avClosuresPrepTitle")));
  assert.ok(!text(container).includes(fr("avHolidayTitle")));
  cleanup();
});

// --------------------------------------------------------------------
// Constat 10 — états visibles ; l'anti-concurrence n'a pas régressé
// --------------------------------------------------------------------

test("[UX156-10] editorStatusOf : ordre de gravité, jamais « enregistré » en lecture seule ni « propre » devant un conflit", () => {
  const base = {
    roleCanWrite: true, contractAvailable: true, hasDraft: true, conflict: false,
    authoritative: true, saving: false, saveFailed: false, saved: false, dirty: false,
  };
  assert.equal(editorStatusOf(base), "clean");
  assert.equal(editorStatusOf({ ...base, saved: true }), "saved");
  assert.equal(editorStatusOf({ ...base, dirty: true, saved: true }), "dirty");
  assert.equal(editorStatusOf({ ...base, saving: true, dirty: true }), "saving");
  assert.equal(editorStatusOf({ ...base, saveFailed: true, dirty: true }), "error");
  assert.equal(editorStatusOf({ ...base, conflict: true, dirty: true }), "conflict");
  assert.equal(editorStatusOf({ ...base, authoritative: false }), "unverified");
  assert.equal(editorStatusOf({ ...base, hasDraft: false }), "loading");
  assert.equal(editorStatusOf({ ...base, contractAvailable: false }), "contract");
  assert.equal(editorStatusOf({ ...base, roleCanWrite: false, saved: true }), "readonly");
  for (const status of Object.keys(EDITOR_STATUS_KEY)) {
    for (const lang of ["fr", "en", "ar", "nl"] as const) {
      const value = (DICTS[lang] as Record<string, string>)[(EDITOR_STATUS_KEY as Record<string, string>)[status]];
      assert.ok(value && value.length > 3, `${lang}/${status}`);
    }
  }
});

test("[UX156-10b] conflit de concurrence : l'état devient « conflit », rien n'est écrasé, F-01 intact", async () => {
  const backend = pickupBackend();
  const { container, cleanup } = setup({
    backend,
    beforeSave: () => {
      // Un tiers enregistre entre la lecture et notre écriture.
      const s = backend.tenant("r1").schedules[0];
      s.cutoffTime = "15:00:00";
      s.updatedAt = "2026-10-14T00:00:01.654321Z";
      s.revision = "ffffffffffffffffffffffffffffffff";
    },
  });
  await flush();
  typeInto(q(container, "#av-lead-days"), "2");
  await flush();
  saveButton(container).click();
  await flush();
  assert.ok(container.querySelector("[data-conflict='true']"));
  assert.equal(q(container, "[data-editor-status]").getAttribute("data-editor-status"), "conflict");
  assert.equal(saveButton(container).disabled, true);
  assert.equal(backend.tenant("r1").schedules[0].minLeadDays, 1, "la version du tiers n'est pas écrasée");
  cleanup();
});

test("[UX156-10c] changement RÉEL de portée pendant une lecture retardée : la réponse tardive de l'ancienne portée ne touche ni le brouillon, ni le résumé, ni l'état", async () => {
  // F-03 (PR #157) : l'ancienne version ne changeait pas de portée et ne
  // retardait aucune réponse -- elle ne prouvait rien. Ici : deux portées
  // (retrait / règle de livraison), la lecture autoritaire de la LIVRAISON
  // est retenue, on revient sur « Retrait » avant qu'elle n'arrive, puis on
  // la libère.
  const DELIVERY = "11111111-1111-1111-1111-111111111111";
  const backend = new FakeFulfillmentWriteBackend();
  const state = auLaitCruPickupFixture();
  state.schedules.push({
    ...JSON.parse(JSON.stringify(state.schedules[0])),
    modeCode: "delivery",
    fulfillmentRuleId: DELIVERY,
    minLeadDays: 4,
    cutoffTime: "09:00:00",
    slots: [],
    windows: [],
    slotSelectionMode: "none",
    updatedAt: "2026-10-14T00:00:02.222222Z",
    revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  backend.setTenant("r1", state);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: string[] = [];
  const { container, cleanup } = setup({
    backend,
    holdAuthority: (_id, _mode, ruleId) => {
      if (ruleId !== DELIVERY) return null;
      held.push(ruleId);
      return gate;
    },
  });
  await flush();
  const select = q<HTMLSelectElement>(container, "#av-scope-select");
  const pickupKey = select.value;
  const deliveryKey = [...select.options].find((o) => o.value.includes(DELIVERY))!.value;
  assert.notEqual(pickupKey, deliveryKey);
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "16:00", "précondition : brouillon du retrait");
  assert.equal(q<HTMLInputElement>(container, "#av-lead-days").value, "1");

  // 1. vers la livraison : sa lecture autoritaire est retenue.
  typeInto(select, deliveryKey);
  await flush();
  assert.deepEqual(held, [DELIVERY], "la lecture de la livraison est bien en vol");

  // 2. retour sur « Retrait » AVANT l'arrivée de la réponse de la livraison.
  typeInto(select, pickupKey);
  await flush();
  assert.equal(select.value, pickupKey);
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "16:00");
  assert.equal(q<HTMLInputElement>(container, "#av-lead-days").value, "1");
  const statusBefore = container.querySelector("[data-editor-status]")?.getAttribute("data-editor-status");

  // 3. la réponse retardée de la livraison arrive maintenant.
  release();
  await flush();
  await flush();

  assert.equal(select.value, pickupKey, "la portée affichée n'a pas bougé");
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "16:00", "le brouillon du retrait a reçu l'heure limite de la livraison");
  assert.equal(q<HTMLInputElement>(container, "#av-lead-days").value, "1", "le brouillon du retrait a reçu le délai de la livraison");
  assert.equal(draftState(container), "clean", "aucune modification fantôme");
  assert.equal(
    container.querySelector("[data-editor-status]")?.getAttribute("data-editor-status"),
    statusBefore,
    "l'état annoncé a changé sous l'effet d'une réponse périmée"
  );
  // Le résumé enregistré décrit toujours le retrait (J+1), jamais la livraison (J+4).
  const summary = text(q(container, "[data-summary-saved]"));
  assert.ok(!summary.includes("09:00"), "le résumé mélange deux portées");
  cleanup();
});

test("[UX156-11] FR/EN/AR/NL : toutes les clés de la refonte existent, sans valeur vide, avec les mêmes paramètres", () => {
  const keys = [
    "avModePickup","avModeDelivery","avStatusLabel","avStatusReadOnly","avStatusContract","avStatusLoading",
    "avStatusConflict","avStatusUnverified","avStatusError","avStatusDirty","avStatusClean","avActivateHelp",
    "avSummaryTitle","avSummarySaved","avSummaryUnsaved","avSummaryDaysTitle","avSummaryInactive","avSummaryMismatch",
    "avSummaryReload","avUnverifiedNote","avScopeWhy","avTechTitle","avV12OnlyTitle","avV12OnlyText","avHowSummary",
    "avExampleTitle","avExampleLeadZero","avExampleLeadN","avExampleCutoffNone","avExampleCutoffV1","avExampleCutoffV12",
    "avExampleHorizon","avExampleIndicative","avServerExampleTitle","avServerExampleButton","avServerExampleSaved",
    "avServerExampleFirst","avServerExampleSlots","avServerExampleNone","avPreviewNoOrder",
  ];
  const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const key of keys) {
    const ref = params((DICTS.fr as Record<string, string>)[key]);
    for (const lang of ["fr", "en", "ar", "nl"] as const) {
      const value = (DICTS[lang] as Record<string, string>)[key];
      assert.ok(typeof value === "string" && value.trim().length > 2, `${lang}.${key} manquant`);
      assert.equal(params(value), ref, `${lang}.${key} : paramètres différents`);
    }
  }
});

test("[UX156-11b] la page se rend en anglais, arabe et néerlandais avec les nouveaux libellés (jamais de clé brute)", async () => {
  for (const lang of ["en", "ar", "nl"] as const) {
    const { container, cleanup } = setup({ backend: pickupBackend(), uiLang: lang });
    await flush();
    const t = text(container);
    const d = DICTS[lang] as Record<string, string>;
    assert.ok(t.includes(d.avModePickup), `${lang} : nom du mode`);
    assert.ok(t.includes(d.avSummaryTitle), `${lang} : résumé`);
    assert.ok(t.includes(d.avPreviewNoOrder.slice(0, 30)), `${lang} : avertissement d'aperçu`);
    assert.ok(!/\bav[A-Z][A-Za-z0-9]+\b/.test(t), `${lang} : clé de traduction brute visible`);
    cleanup();
  }
});

test("[UX156-12] clavier : les nouveaux contrôles sont de vrais boutons/cases, accessibles (id, libellé, pas de tabindex négatif)", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  for (const id of ["#av-server-example", "#av-activate"]) {
    const el = q<HTMLElement>(container, id);
    assert.ok(el.tagName === "BUTTON" || el.tagName === "INPUT");
    assert.notEqual(el.getAttribute("tabindex"), "-1");
  }
  assert.ok(q(container, "label[for='av-activate']").textContent!.length > 5);
  // Le résumé en clair est une liste (lecteur d'écran), pas une image.
  assert.equal(q(container, "[data-weekly-summary]").tagName, "UL");
  // L'état est annoncé dans une région « status », pas « alert ».
  assert.equal(q(container, "[data-editor-status]").getAttribute("role"), "status");
  cleanup();
});

test("[UX156-12b] mobile : un sélecteur de portée, pas de tableau obligatoire ; les plages tiennent sur une colonne", async () => {
  const { container, cleanup } = setup({ backend: pickupBackend() });
  await flush();
  assert.ok(container.querySelector("#av-scope-select"), "sélecteur mobile présent");
  const optionText = q(container, "#av-scope-select option").textContent ?? "";
  assert.ok(optionText.startsWith("Retrait en boutique"), optionText);
  assert.ok(q(container, "[data-weekly-summary]").className.includes("grid-cols-1"));
  cleanup();
});

test("[UX156-13] customerSentenceKeyOf : même table de vérité pour la lecture enregistrée et le brouillon", () => {
  const e = (enabled: boolean, d: string, s: string) => customerSentenceKeyOf({ enabled, dateSelectionMode: d, slotSelectionMode: s });
  assert.equal(e(false, "customer_selectable", "fixed_slots"), "avCustomerNoDate");
  assert.equal(e(true, "derived_earliest", "fixed_slots"), "avCustomerFirstDate");
  assert.equal(e(true, "informational_only", "none"), "avCustomerNoDate");
  assert.equal(e(true, "customer_selectable", "fixed_slots"), "avCustomerDateAndSlot");
  assert.equal(e(true, "customer_selectable", "time_within_window"), "avCustomerDateAndTime");
  assert.equal(e(true, "customer_selectable", "none"), "avCustomerDateOnly");
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
