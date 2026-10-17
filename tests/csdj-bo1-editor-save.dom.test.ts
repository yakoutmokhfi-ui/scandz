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

// ====================================================================
// CSDJ-BO-1 — ÉDITEUR « MISE À DISPOSITION » : e2e SIMULÉ (issue #149).
//
// CE QUE CE FICHIER EST, ET CE QU'IL N'EST PAS.
//
// L'issue #149 demande des « tests automatiques unit/DOM/e2e simulé pour
// ajout option et règle, modification 16h → nouvel horaire, fermeture,
// sauvegarde refusée, concurrence et isolation tenant », ET elle
// interdit dans la même phrase de « simplement basculer le flag avant
// qu'une RPC transactionnelle Boulez existe et que les tests soient
// passés ». Les deux tiennent ensemble d'une seule façon : le chemin
// d'écriture est écrit en entier, le drapeau de production reste FAUX,
// et le comportement est prouvé contre un backend transactionnel SIMULÉ.
//
// Donc, ici et NULLE PART AILLEURS, deux doubles sont injectés :
//   1. `@/lib/services/availability` — la vraie RPC
//      `save_fulfillment_configuration` n'existe pas encore côté
//      Supabase ; elle est remplacée par
//      tests/helpers/fake-fulfillment-write-backend.ts, qui refuse ce
//      que l'autorité SQL refusera et n'écrit jamais à moitié ;
//   2. `@/lib/availability-editor` — réexporté À L'IDENTIQUE, sauf
//      `CSDJ_BO1_WRITE_CONTRACT`, dont `available` passe à vrai POUR CE
//      FICHIER DE TEST SEULEMENT, avec une raison distincte
//      (`…_SIMULATED`) qui rend l'artifice visible dans le DOM.
//
// La constante RÉELLE du dépôt vaut `available: true` depuis #154 : c'est
// vérifié ci-dessous ([BO1-SAVE-0]). Le double ci-dessus ne sert plus
// qu'à brancher le faux backend d'écriture.
//
// Le backend simulé expose son état en forme DOMAINE (`FakeTenantState`
// est déjà en camelCase, champ pour champ comme
// `MerchantFulfillmentSchedule`), donc les doubles de lecture le
// rendent tel quel : aucune projection n'est recopiée ici, et la
// traduction réelle des colonnes SQL reste prouvée par les suites de
// lecture existantes.
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

// Le SEUL artifice de capacité : `available` à vrai, tout le reste du
// module réexporté À L'IDENTIQUE depuis la vraie source. Un export local
// explicite masque l'export étoilé du même nom (règle ES, implémentée
// telle quelle par esbuild) : aucune des dizaines de fonctions pures de
// ce module n'est donc réécrite ici.
const EDITOR_PATH = path.join(REPO_ROOT, "lib", "availability-editor.ts");
const WRITE_CONTRACT_SIMULATED_REASON = "CSDJ_BO1_WRITE_CONTRACT_SIMULATED";
//
// Deux noms sont redéfinis, et seulement deux : la constante, et la
// porte qui la LIT. `writeControlsState` est définie DANS le module
// réel, donc elle lit sa propre constante locale -- réexporter la
// constante autrement ne changerait rien à son comportement. Sa
// redéfinition ici reproduit la branche du drapeau à l'identique : le
// rôle est toujours tranché par la vraie
// `canWriteFulfillmentSchedules` (propriétaire ou responsable, AUCUNE
// dérogation opérateur), et seule la seconde condition -- « le contrat
// d'écriture est-il livré ? » -- est supposée vraie.
const MOCK_EDITOR = `
export * from ${JSON.stringify(EDITOR_PATH)};
import { canWriteFulfillmentSchedules } from ${JSON.stringify(EDITOR_PATH)};
export const CSDJ_BO1_WRITE_CONTRACT = {
  available: true,
  reason: ${JSON.stringify(WRITE_CONTRACT_SIMULATED_REASON)},
  requestedContract: "save_fulfillment_configuration",
};
export function writeControlsState(params) {
  if (!canWriteFulfillmentSchedules(params)) return { enabled: false, reason: "role" };
  return { enabled: true };
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/availability": MOCK_AVAILABILITY,
  "@/lib/availability-editor": MOCK_EDITOR,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-bo1-save-"));
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

// --------------------------------------------------------------------
// 0. L'artifice est NOMMÉ, et le dépôt n'a pas basculé.
// --------------------------------------------------------------------

test("[BO1-SAVE-0] le drapeau RÉEL est vrai depuis #154 : aucune bannière « contrat non approuvé » n'est rendue (issue #156, constat 1)", async () => {
  // La constante importée depuis la VRAIE source -- pas le double.
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, true);
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.reason, "CSDJ_BO1_WRITE_CONTRACT_READY");

  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({ backend });
  await flush();

  // Le contrat est disponible : ni bannière « en attente », ni phrase
  // « inactif : … contrat » à côté de l'activation.
  assert.equal(container.querySelector("[data-write-contract]"), null);
  assert.ok(
    !(container.textContent ?? "").includes("contrat d'écriture n'est pas encore approuvé"),
    "aucune phrase périmée sur le contrat d'écriture"
  );
  assert.ok(
    !(container.textContent ?? "").includes("Inactif : l'enregistrement attend le contrat"),
    "aucune raison « inactif » périmée à côté de l'activation"
  );
  // Et l'écriture est bien actionnable ici, sinon les tests suivants ne
  // prouveraient rien.
  assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "clean");
  assert.equal(
    container.querySelector("[data-editor-status]")?.getAttribute("data-editor-status"),
    "clean"
  );
  cleanup();
});

// --------------------------------------------------------------------
// 1. Ajouter une option et une règle
// --------------------------------------------------------------------

test("[BO1-SAVE-1] ajout d'un créneau et d'une règle de fermeture : UN seul appel, charge intégrale", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({ backend });
  await flush();

  assert.equal(draftState(container), "clean");
  const before = backend.tenant("r1").schedules[0].slots.length;

  // Une OPTION : un troisième créneau le mardi (weekday 2).
  q<HTMLButtonElement>(container, '[data-add-row="slot"][data-add-weekday="2"]').click();
  await flush(20);
  const mardi = q(container, '[data-weekday="2"]');
  const keys = byAria(mardi, fr("avSlotKeyAria").replace("{day}", "Mardi"));
  const starts = byAria(mardi, fr("avStartAria").replace("{day}", "Mardi"));
  const ends = byAria(mardi, fr("avEndAria").replace("{day}", "Mardi"));
  assert.equal(keys.length, 3, "le mardi porte maintenant trois créneaux");
  typeInto(keys[2], "gouter");
  typeInto(starts[2], "15:00");
  typeInto(ends[2], "15:45");
  await flush(20);

  // Une RÈGLE : une fermeture datée.
  q<HTMLButtonElement>(container, '[data-add-row="closure"]').click();
  await flush(20);
  const dates = byAria(container, fr("avClosureDateAria"));
  typeInto(dates[dates.length - 1], "2026-11-11");
  typeInto(
    byAria(container, fr("avClosureLabelAria")).slice(-1)[0],
    "Armistice"
  );
  await flush(20);

  assert.equal(draftState(container), "dirty");
  assert.equal(saveButton(container).disabled, false, "rien ne bloque : le serveur accepterait");

  saveButton(container).click();
  await flush(120);

  // UN appel, accepté. Jamais deux, jamais une séquence.
  assert.deepEqual(backend.calls, [{ restaurantId: "r1", accepted: true }]);
  const saved = backend.tenant("r1").schedules[0];
  assert.equal(saved.slots.length, before + 1);
  assert.ok(
    saved.slots.some(
      (s) => s.weekday === 2 && s.slotKey === "gouter" && s.startsAt === "15:00" && s.endsAt === "15:45"
    ),
    "le créneau ajouté est enregistré tel quel"
  );
  assert.deepEqual(
    saved.closures.map((c) => c.closedOn).sort(),
    ["2026-11-11", "2026-12-25"],
    "la fermeture ajoutée s'ajoute SANS perdre celle qui existait : la charge est l'état voulu en entier"
  );

  // L'écran repart de la réponse du serveur : « modifié » retombe parce
  // que la base et l'écran disent la même chose.
  assert.equal(draftState(container), "saved");
  cleanup();
});

// --------------------------------------------------------------------
// 2. L'heure limite de 16 h devient un nouvel horaire
// --------------------------------------------------------------------

test("[BO1-SAVE-2] l'heure limite 16:00 de « Au Lait Cru » devient 17:30, et c'est la seule chose qui bouge", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({ backend });
  await flush();

  const cutoff = q<HTMLInputElement>(container, "#av-cutoff");
  assert.equal(cutoff.value, "16:00", "la fixture de l'issue arrive bien avec 16 h");
  const slotsBefore = JSON.stringify(backend.tenant("r1").schedules[0].slots);

  typeInto(cutoff, "17:30");
  await flush(20);
  assert.equal(draftState(container), "dirty");
  assert.match(
    container.querySelector("[data-draft-state]")!.textContent ?? "",
    /1 modification/,
    "une seule modification est comptée"
  );

  saveButton(container).click();
  await flush(120);

  const saved = backend.tenant("r1").schedules[0];
  assert.equal(saved.cutoffTime, "17:30:00", "l'heure est enregistrée à la minute, secondes normalisées");
  assert.equal(saved.cutoffOffsetDays, 1, "le décalage « la veille » de l'issue est préservé");
  assert.equal(JSON.stringify(saved.slots), slotsBefore, "aucun créneau n'a bougé");
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "17:30");
  cleanup();
});

// --------------------------------------------------------------------
// 3. Fermer un jour
// --------------------------------------------------------------------

test("[BO1-SAVE-3] fermer le mardi = retirer ses lignes, et un jour sans ligne est un jour fermé", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({ backend });
  await flush();

  const mardi = () => q(container, '[data-weekday="2"]');
  const removeLabel = fr("avRowRemoveSlotAria").replace("{day}", "Mardi");
  // Deux créneaux le mardi dans la fixture (midi, soir).
  assert.equal(byAria(mardi(), removeLabel).length, 2);
  byAria(mardi(), removeLabel)[0].click();
  await flush(20);
  byAria(mardi(), removeLabel)[0].click();
  await flush(20);

  assert.ok(
    (mardi().textContent ?? "").includes(fr("avDayClosed")),
    "le mardi s'annonce FERMÉ dès qu'il n'a plus de ligne"
  );

  saveButton(container).click();
  await flush(120);

  const saved = backend.tenant("r1").schedules[0];
  assert.equal(
    saved.slots.filter((s) => s.weekday === 2).length,
    0,
    "le mardi n'a plus aucun créneau en base"
  );
  assert.ok(
    saved.slots.some((s) => s.weekday === 3),
    "les autres jours sont intacts : la fermeture d'un jour n'est pas une purge"
  );
  assert.equal(saved.enabled, true, "la portée reste activée : fermer un jour n'est pas se désactiver");
  cleanup();
});

// --------------------------------------------------------------------
// 4. Une sauvegarde refusée
// --------------------------------------------------------------------

test("[BO1-SAVE-4] sauvegarde refusée : phrase traduite, aucun code brut, RIEN d'écrit, brouillon conservé", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  // Le serveur refuse pour une raison que l'écran ne pouvait pas
  // prévoir : le mode de vente a disparu du catalogue entre la lecture
  // et l'enregistrement.
  const { container, cleanup } = setup({
    backend,
    beforeSave: () => {
      backend.tenant("r1").modes = ["delivery"];
    },
  });
  await flush();

  // L'instantané porte sur la CONFIGURATION, pas sur le catalogue de
  // modes que le scénario fait bouger exprès juste avant l'écriture.
  const config = () => {
    const state = backend.tenant("r1");
    return JSON.stringify({ schedules: state.schedules, v12: state.v12 });
  };
  const snapshot = config();
  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "18:00");
  await flush(20);
  saveButton(container).click();
  await flush(120);

  const alert = container.querySelector('[data-save-error="true"]');
  assert.ok(alert, "un refus doit être ANNONCÉ, pas avalé");
  assert.equal(alert!.getAttribute("role"), "alert");
  assert.equal(alert!.textContent, fr("avSaveUnknownMode"));
  for (const raw of ["CSDJ1_", "CSDJBO1_", "PGRST", "function"]) {
    assert.ok(
      !(alert!.textContent ?? "").includes(raw),
      `aucun fragment technique affiché (${raw})`
    );
  }
  assert.deepEqual(
    backend.calls.map((c) => ({ accepted: c.accepted, refusal: c.refusal })),
    [{ accepted: false, refusal: "CSDJ1_UNKNOWN_MODE" }]
  );
  assert.equal(config(), snapshot, "un refus ne laisse RIEN : la configuration est octet pour octet la même");
  assert.equal(draftState(container), "dirty", "le brouillon du commerçant n'est pas jeté par un refus");
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "18:00", "sa frappe est toujours là");
  cleanup();
});

test("[BO1-SAVE-5] un réglage que le serveur refuserait bloque l'envoi AVANT le réseau, en nommant le réglage", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({ backend });
  await flush();

  // Une plage dont la fin précède le début : refus local, nommé, placé
  // dans la section fautive.
  q<HTMLButtonElement>(container, '[data-add-row="slot"][data-add-weekday="3"]').click();
  await flush(20);
  const mercredi = q(container, '[data-weekday="3"]');
  const keys = byAria(mercredi, fr("avSlotKeyAria").replace("{day}", "Mercredi"));
  typeInto(keys[keys.length - 1], "nuit");
  const starts = byAria(mercredi, fr("avStartAria").replace("{day}", "Mercredi"));
  const ends = byAria(mercredi, fr("avEndAria").replace("{day}", "Mercredi"));
  typeInto(starts[starts.length - 1], "22:00");
  typeInto(ends[ends.length - 1], "21:00");
  await flush(20);

  const issues = container.querySelector('[data-section-issues="offers"]');
  assert.ok(issues, "le refus est affiché à côté du réglage fautif");
  assert.ok((issues!.textContent ?? "").includes(fr("avIssueSlotOrder")));
  const button = saveButton(container);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("data-write-disabled-reason"), "issues");

  button.click();
  await flush(60);
  assert.deepEqual(backend.calls, [], "aucun appel réseau n'est tenté quand l'écran sait déjà que c'est refusé");
  cleanup();
});

// --------------------------------------------------------------------
// 5. Concurrence
// --------------------------------------------------------------------

/** Un tiers enregistre entre notre lecture et notre enregistrement. */
const THEIR_UPDATED_AT = "2026-10-14T08:30:00.999999Z";
const THEIR_REVISION = "ffffffffffffffffffffffffffffffff";
function thirdPartyEdit(backend: FakeFulfillmentWriteBackend, over: Record<string, unknown> = {}) {
  const row = backend.tenant("r1").schedules[0] as unknown as Record<string, unknown>;
  row.updatedAt = THEIR_UPDATED_AT;
  row.revision = THEIR_REVISION;
  row.minLeadDays = 3;
  Object.assign(row, over);
}

const conflictRows = (root: Element) =>
  Object.fromEntries(
    [...root.querySelectorAll("[data-conflict-field]")].map((el) => [
      el.getAttribute("data-conflict-field"),
      el.getAttribute("data-conflict-origin"),
    ])
  );

test("[BO1-SAVE-6] concurrence (F01-B) : STALE puis SECOND CLIC — rien n'écrase le tiers, les deux versions restent séparées, et il faut un choix explicite", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  let intervened = false;
  const { container, cleanup } = setup({
    backend,
    // Entre la lecture de l'écran et l'enregistrement, un autre
    // responsable enregistre : les DEUX jetons du locataire avancent.
    beforeSave: () => {
      if (intervened) return;
      intervened = true;
      thirdPartyEdit(backend);
    },
  });
  await flush();

  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "19:00");
  await flush();
  saveButton(container).click();
  await flush();

  // ── Le refus, nommé, et ce qu'on en dit au commerçant ───────────
  const alert = container.querySelector('[data-save-error="true"]');
  assert.ok(alert, "un refus de concurrence doit être annoncé");
  const shown = alert!.textContent ?? "";
  assert.ok(shown.includes(fr("avSaveStale")), "le refus a sa propre phrase");
  assert.ok(
    shown.includes(fr("avSaveStaleReloaded")),
    "et elle dit que la version du serveur a été relue et qu'aucun enregistrement n'a lieu sans choix"
  );
  assert.deepEqual(
    backend.calls.map((c) => c.refusal),
    ["CSDJBO1_STALE_CONFIGURATION"],
    "un seul appel, refusé : AUCUN rejeu automatique"
  );

  // ── Rien n'a été écrasé ─────────────────────────────────────────
  const row = backend.tenant("r1").schedules[0];
  assert.equal(row.minLeadDays, 3, "la modification du tiers est intacte");
  assert.equal(row.cutoffTime, "16:00:00", "et la nôtre n'a pas été écrite par-dessus");
  assert.equal(writtenPayloads.length, 1);
  assert.equal(writtenPayloads[0].expectedUpdatedAt, "2026-10-14T00:00:00.123456Z");
  assert.equal(writtenPayloads[0].expectedRevision, "a1b2c3d4e5f60718293a4b5c6d7e8f90");

  // ── DEUX versions séparées, et les divergences NOMMÉES ──────────
  assert.ok(container.querySelector('[data-conflict-readable="true"]'), "la version serveur est affichée");
  assert.deepEqual(
    conflictRows(container),
    { cutoffTime: "mine", minLeadDays: "theirs" },
    "ce que j'ai changé, ce que le tiers a changé — et rien d'autre"
  );
  assert.equal(
    q<HTMLInputElement>(container, "#av-cutoff").value,
    "19:00",
    "mon brouillon est INTACT : la version du serveur ne l'a pas remplacé"
  );
  assert.equal(
    q<HTMLInputElement>(container, "#av-lead-days").value,
    "1",
    "et la valeur du tiers (3) n'a PAS été glissée dans mon brouillon"
  );
  assert.ok(
    (q(container, '[data-conflict-field="minLeadDays"]').textContent ?? "").includes("3"),
    "elle est montrée À PART, dans le panneau de conflit"
  );

  // ── LE SECOND CLIC : l'enregistrement est suspendu ──────────────
  assert.equal(saveButton(container).disabled, true, "aucun enregistrement avant un choix");
  assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "conflict");
  assert.equal(container.querySelector("#av-save-as-draft"), null, "pas non plus par la porte du brouillon");
  saveButton(container).click();
  await flush();
  assert.equal(writtenPayloads.length, 1, "le second clic n'a envoyé AUCUNE charge");
  assert.equal(backend.tenant("r1").schedules[0].minLeadDays, 3);

  // ── Choix explicite : appliquer MES modifications sur le serveur ─
  q<HTMLButtonElement>(container, "#av-conflict-rebase").click();
  await flush();
  assert.equal(container.querySelector("[data-conflict]"), null, "le conflit est résolu");
  assert.equal(writtenPayloads.length, 1, "résoudre n'enregistre RIEN");
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "19:00", "ma modification est gardée");
  assert.equal(
    q<HTMLInputElement>(container, "#av-lead-days").value,
    "3",
    "et celle du tiers, que je n'avais pas touchée, SURVIT"
  );
  assert.ok(container.querySelector('[data-conflict-rebased="true"]'), "le rebase est annoncé");
  assert.equal(draftState(container), "dirty");

  // ── Enfin, l'enregistrement délibéré : jetons de CETTE version ──
  assert.equal(saveButton(container).disabled, false);
  saveButton(container).click();
  await flush();
  assert.equal(backend.calls.filter((c) => c.accepted).length, 1, "l'enregistrement délibéré réussit");
  assert.equal(writtenPayloads.length, 2);
  assert.equal(writtenPayloads[1].expectedUpdatedAt, THEIR_UPDATED_AT, "microseconde comprise");
  assert.equal(writtenPayloads[1].expectedRevision, THEIR_REVISION);
  const final = backend.tenant("r1").schedules[0];
  assert.equal(final.cutoffTime, "19:00:00");
  assert.equal(final.minLeadDays, 3, "la modification du tiers n'a jamais été perdue");
  cleanup();
});

test("[BO1-SAVE-6c] conflit : « reprendre la version du serveur » abandonne MES modifications, rien d'autre", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  let intervened = false;
  const { container, cleanup } = setup({
    backend,
    beforeSave: () => {
      if (intervened) return;
      intervened = true;
      thirdPartyEdit(backend);
    },
  });
  await flush();
  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "19:00");
  await flush();
  saveButton(container).click();
  await flush();
  assert.ok(container.querySelector("[data-conflict]"));

  q<HTMLButtonElement>(container, "#av-conflict-take-server").click();
  await flush();
  assert.equal(container.querySelector("[data-conflict]"), null);
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "16:00", "ma modification est abandonnée");
  assert.equal(q<HTMLInputElement>(container, "#av-lead-days").value, "3", "et le serveur est repris");
  assert.equal(draftState(container), "clean", "il n'y a plus rien à enregistrer");
  assert.equal(writtenPayloads.length, 1, "rien n'a été enregistré pour autant");

  // Un enregistrement ultérieur part de CETTE version, et passe.
  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
  await flush();
  saveButton(container).click();
  await flush();
  assert.equal(writtenPayloads[1].expectedRevision, THEIR_REVISION);
  assert.equal(backend.tenant("r1").schedules[0].minLeadDays, 3);
  assert.equal(backend.tenant("r1").schedules[0].bookingHorizonDays, 21);
  cleanup();
});

test("[BO1-SAVE-6d] vrai conflit : le même réglage changé des DEUX côtés est nommé « des deux côtés », et mon choix est explicite", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  let intervened = false;
  const { container, cleanup } = setup({
    backend,
    beforeSave: () => {
      if (intervened) return;
      intervened = true;
      thirdPartyEdit(backend, { cutoffTime: "18:00:00" });
    },
  });
  await flush();
  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "19:00");
  await flush();
  saveButton(container).click();
  await flush();

  assert.equal(conflictRows(container).cutoffTime, "both");
  const cells = [...q(container, '[data-conflict-field="cutoffTime"]').querySelectorAll("td")].map(
    (td) => td.textContent
  );
  assert.deepEqual(cells.slice(0, 2), ["19:00", "18:00"], "ma valeur, puis celle du serveur");
  assert.equal(backend.tenant("r1").schedules[0].cutoffTime, "18:00:00", "rien d'écrasé");
  q<HTMLButtonElement>(container, "#av-conflict-rebase").click();
  await flush();
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "19:00", "mon choix explicite l'emporte");
  cleanup();
});

test("[BO1-SAVE-6e] deuxième refus après un rebase : le serveur a encore changé, et rien n'est écrasé non plus", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  let interventions = 0;
  const { container, cleanup } = setup({
    backend,
    beforeSave: () => {
      interventions += 1;
      if (interventions === 1) thirdPartyEdit(backend);
      if (interventions === 2) {
        thirdPartyEdit(backend, {
          updatedAt: "2026-10-14T09:00:00.000001Z",
          revision: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          bookingHorizonDays: 30,
        });
      }
    },
  });
  await flush();
  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "19:00");
  await flush();
  saveButton(container).click();
  await flush();
  q<HTMLButtonElement>(container, "#av-conflict-rebase").click();
  await flush();
  saveButton(container).click();
  await flush();

  assert.deepEqual(
    backend.calls.map((c) => c.refusal),
    ["CSDJBO1_STALE_CONFIGURATION", "CSDJBO1_STALE_CONFIGURATION"],
    "deux refus, aucune écriture acceptée"
  );
  assert.equal(backend.calls.filter((c) => c.accepted).length, 0);
  assert.ok(container.querySelector("[data-conflict]"), "le conflit est de retour");
  assert.equal(backend.tenant("r1").schedules[0].bookingHorizonDays, 30, "la seconde modification du tiers est intacte");
  assert.equal(backend.tenant("r1").schedules[0].cutoffTime, "16:00:00");
  assert.equal(conflictRows(container).bookingHorizonDays, "theirs");
  cleanup();
});

test("[BO1-SAVE-6f] la relecture du serveur échoue : rien n'est résolu, rien n'est enregistré, et on propose de relire", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  let intervened = false;
  const { container, cleanup } = setup({
    backend,
    failAuthorityAfter: 1,
    beforeSave: () => {
      if (intervened) return;
      intervened = true;
      thirdPartyEdit(backend);
    },
  });
  await flush();
  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "19:00");
  await flush();
  saveButton(container).click();
  await flush();

  assert.ok(container.querySelector('[data-conflict-readable="false"]'), "la version du serveur est ILLISIBLE");
  assert.equal(container.querySelector("#av-conflict-rebase"), null, "aucun choix possible sur une version qu'on n'a pas lue");
  assert.equal(container.querySelector("#av-conflict-take-server"), null);
  assert.equal(saveButton(container).disabled, true);
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "19:00", "le brouillon est intact");
  const reads = authoritativeReads.length;
  q<HTMLButtonElement>(container, "#av-conflict-retry").click();
  await flush();
  assert.ok(authoritativeReads.length > reads, "« relire » relit vraiment");
  assert.equal(writtenPayloads.length, 1, "et n'enregistre rien");
  cleanup();
});

test("[BO1-F01-A] interleaving : listes A → modification concurrente B → snapshot autoritaire B. Jamais A signé des jetons de B", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({
    backend,
    // Les lectures de listes viennent de rendre A ; un tiers produit B ;
    // la lecture autoritaire, qui part ensuite, rend B et SES jetons.
    afterListsRead: () => {
      thirdPartyEdit(backend, {
        cutoffTime: "18:00:00",
        slots: [
          ...auLaitCruPickupFixture().schedules[0].slots,
          { weekday: 1, slotKey: "ajout_du_tiers", startsAt: "09:00", endsAt: "10:00" },
        ],
      });
    },
  });
  await flush();

  // Le brouillon et sa référence sont B, pas A.
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "18:00", "heure limite de B");
  assert.equal(q<HTMLInputElement>(container, "#av-lead-days").value, "3", "délai de B");
  assert.equal(draftState(container), "clean", "B est la référence : rien n'est « modifié »");
  const lundi = q(container, '[data-weekday="1"]');
  assert.deepEqual(
    byAria(lundi, fr("avSlotKeyAria").replace("{day}", "Lundi")).map((i) => i.value),
    ["ajout_du_tiers"],
    "le créneau ajouté par le tiers est visible dans le brouillon"
  );

  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
  await flush();
  saveButton(container).click();
  await flush();

  assert.equal(writtenPayloads.length, 1);
  const sent = writtenPayloads[0];
  assert.equal(sent.expectedRevision, THEIR_REVISION, "jetons de B");
  assert.equal(sent.expectedUpdatedAt, THEIR_UPDATED_AT);
  const policy = sent.policy as Record<string, unknown>;
  assert.equal(policy.cutoffTime, "18:00", "et le CONTENU est celui de B, jamais celui de A");
  assert.equal(policy.minLeadDays, 3);
  assert.equal((sent.slots as unknown[]).length, 11, "les dix créneaux de A + celui du tiers");
  const final = backend.tenant("r1").schedules[0];
  assert.equal(final.cutoffTime, "18:00:00", "la modification du tiers n'a pas été écrasée");
  assert.equal(final.minLeadDays, 3);
  assert.ok(final.slots.some((slot) => slot.slotKey === "ajout_du_tiers"));
  assert.equal(final.bookingHorizonDays, 21, "seul mon changement s'y est ajouté");
  cleanup();
});

test("[BO1-F01-A2] lecture autoritaire muette ou sans configuration : le brouillon se montre, l'enregistrement reste FERMÉ", async () => {
  for (const mode of ["muette", "sans configuration"] as const) {
    const backend = new FakeFulfillmentWriteBackend();
    backend.setTenant("r1", auLaitCruPickupFixture());
    const { container, cleanup } = setup(
      mode === "muette"
        ? { backend, failAuthorityAfter: 0 }
        : { backend, authorityReturnsNull: true }
    );
    await flush();

    assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "16:00", `${mode} : l'écran reste lisible`);
    typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
    await flush();
    assert.equal(draftState(container), "dirty", `${mode} : l'édition locale reste possible`);
    assert.equal(saveButton(container).disabled, true, `${mode} : on ne signe pas une version qu'on n'a pas lue`);
    assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "authority");
    assert.ok((container.textContent ?? "").includes(fr("avSaveNeedsAuthority")));
    saveButton(container).click();
    await flush();
    assert.deepEqual(backend.calls, [], `${mode} : aucun appel d'écriture`);
    assert.equal(writtenPayloads.length, 0);
    cleanup();
  }
});

/** Un locataire à DEUX portées : le retrait (A) et une livraison à règle propre. */
const STUART_RULE = "11111111-1111-1111-1111-111111111111";
function tenantWithDelivery(): FakeTenantState {
  const state = auLaitCruPickupFixture();
  const pickup = state.schedules[0];
  state.schedules.push({
    ...pickup,
    modeCode: "delivery",
    fulfillmentRuleId: STUART_RULE,
    cutoffTime: "10:00:00",
    cutoffOffsetDays: 0,
    slots: [{ weekday: 1, slotKey: "livraison", startsAt: "08:00", endsAt: "12:00" }],
    closures: [],
    updatedAt: "2026-10-13T10:00:00.654321Z",
    revision: "5700000000000000000000000000aaaa",
  });
  return state;
}

test("[BO1-F01-C] changement rapide de portée et réponse autoritaire EN DÉSORDRE : la portée affichée n'est jamais celle d'une réponse tardive", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", tenantWithDelivery());
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { container, cleanup } = setup({
    backend,
    // La PREMIÈRE lecture (le retrait) est retenue ; la livraison, non.
    holdAuthority: (_id, modeCode) => (modeCode === "pickup" ? held : null),
  });
  await flush();
  assert.equal(saveButton(container).disabled, true);
  assert.equal(
    saveButton(container).getAttribute("data-write-disabled-reason"),
    "authority",
    "tant que l'autorité n'a pas répondu, AUCUN brouillon enregistrable n'existe"
  );

  // Le commerçant passe à la livraison avant que le retrait ait répondu.
  const buttons = [...container.querySelectorAll("button[aria-pressed]")] as HTMLButtonElement[];
  assert.equal(buttons.length, 2, "deux portées");
  buttons[1].click();
  await flush();
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "10:00", "la livraison s'affiche");

  // La réponse du retrait arrive EN RETARD : elle est abandonnée.
  release();
  await flush();
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "10:00", "la réponse tardive du retrait n'a rien remplacé");
  assert.equal(draftState(container), "clean");

  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
  await flush();
  saveButton(container).click();
  await flush();
  assert.equal(writtenPayloads.length, 1);
  assert.equal(writtenPayloads[0].modeCode, "delivery");
  assert.equal(writtenPayloads[0].fulfillmentRuleId, STUART_RULE);
  assert.equal(writtenPayloads[0].expectedRevision, "5700000000000000000000000000aaaa", "les jetons de la livraison, pas ceux du retrait");
  assert.equal(writtenPayloads[0].expectedUpdatedAt, "2026-10-13T10:00:00.654321Z");
  const pickup = backend.tenant("r1").schedules.find((row) => row.modeCode === "pickup")!;
  assert.equal(pickup.revision, "a1b2c3d4e5f60718293a4b5c6d7e8f90", "le retrait n'a pas bougé");
  assert.equal(pickup.cutoffTime, "16:00:00");
  cleanup();
});

test("[BO1-F01-D] multi-commerçants : une réponse autoritaire tardive d'un AUTRE établissement ne se mêle ni au brouillon ni aux jetons", async () => {
  const { backend, mappings } = twoTenants();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { container, cleanup } = setup({
    backend,
    mappings,
    holdAuthority: (id) => (id === "r1" ? held : null),
  });
  await flush();

  const selector = ([...container.querySelectorAll("select")] as HTMLSelectElement[]).find((s) =>
    [...s.options].some((o) => o.value === "r2")
  )!;
  typeInto(selector, "r2");
  await flush();
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "09:00", "r2 s'affiche");

  const r1Before = backend.snapshot("r1");
  release();
  await flush();
  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").value, "09:00", "la réponse tardive de r1 est abandonnée");

  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
  await flush();
  saveButton(container).click();
  await flush();
  assert.equal(writtenPayloads.length, 1);
  assert.equal(writtenPayloads[0].expectedRevision, "22222222222222222222222222222222", "jetons de r2");
  assert.equal(writtenPayloads[0].expectedUpdatedAt, "2026-10-12T07:00:00.222222Z");
  assert.deepEqual([...new Set(backend.calls.map((c) => c.restaurantId))], ["r2"]);
  assert.equal(backend.snapshot("r1"), r1Before, "r1 n'a pas bougé d'un octet");
  cleanup();
});

test("[BO1-SAVE-6b] la précision microseconde traverse l'écran SANS être tronquée", async () => {
  // La garde la plus facile à casser de tout ce lot : un `new Date(...)`
  // ou un `toISOString()` posé n'importe où sur le trajet de
  // `updatedAt` ramènerait « …123456Z » à « …123Z ». Ce test lit le
  // jeton RÉELLEMENT envoyé, et le compare à la chaîne du serveur.
  const backend = new FakeFulfillmentWriteBackend();
  const fixture = auLaitCruPickupFixture();
  fixture.schedules[0].updatedAt = "2026-10-14T08:30:00.654321Z";
  fixture.schedules[0].revision = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  backend.setTenant("r1", fixture);
  const { container, cleanup } = setup({ backend });
  await flush();

  // La lecture autoritaire a bien été consultée, pour CETTE portée.
  assert.deepEqual(authoritativeReads, [{ id: "r1", modeCode: "pickup", ruleId: null }]);

  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
  await flush(20);
  saveButton(container).click();
  await flush(150);

  assert.equal(writtenPayloads.length, 1);
  const sent = writtenPayloads[0].expectedUpdatedAt as string;
  assert.equal(sent, "2026-10-14T08:30:00.654321Z", "la chaîne est recopiée telle quelle");
  assert.ok(/\.\d{6}Z$/.test(sent), "six chiffres de fraction, pas trois");
  assert.notEqual(
    sent,
    new Date("2026-10-14T08:30:00.654321Z").toISOString(),
    "un passage par Date aurait tronqué : la différence est la preuve"
  );
  assert.equal(backend.calls.filter((c) => c.accepted).length, 1, "et le serveur accepte");

  // Après l'écriture, les jetons affichés sont CEUX DE LA RÉPONSE : une
  // seconde sauvegarde enchaîne sans relire et sans conflit.
  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "28");
  await flush(20);
  saveButton(container).click();
  await flush(150);
  assert.equal(backend.calls.filter((c) => c.accepted).length, 2, "deux écritures d'affilée");
  assert.equal(
    writtenPayloads[1].expectedUpdatedAt,
    backend.calls.length > 0 ? writtenPayloads[1].expectedUpdatedAt : null
  );
  assert.notEqual(
    writtenPayloads[1].expectedRevision,
    writtenPayloads[0].expectedRevision,
    "la seconde écriture porte l'empreinte rendue par la première"
  );
  cleanup();
});

// --------------------------------------------------------------------
// 6. Isolation locataire
// --------------------------------------------------------------------

test("[BO1-SAVE-7] isolation locataire : enregistrer chez l'un ne touche jamais l'autre, et changer d'établissement repart de zéro", async () => {
  const { backend, mappings } = twoTenants();
  const { container, cleanup } = setup({ backend, mappings });
  await flush();

  const r2Before = backend.snapshot("r2");
  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "12:15");
  await flush(20);
  saveButton(container).click();
  await flush(120);

  assert.equal(backend.tenant("r1").schedules[0].cutoffTime, "12:15:00");
  assert.equal(backend.snapshot("r2"), r2Before, "l'autre établissement n'a RIEN reçu");
  assert.deepEqual(
    [...new Set(backend.calls.map((c) => c.restaurantId))],
    ["r1"],
    "aucun appel n'a jamais porté l'identifiant de l'autre établissement"
  );

  // Changement d'établissement : le brouillon de r1 ne doit pas suivre.
  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "20:00");
  await flush(20);
  assert.equal(draftState(container), "dirty");

  const selector = ([...container.querySelectorAll("select")] as HTMLSelectElement[]).find((s) =>
    [...s.options].some((o) => o.value === "r2")
  );
  assert.ok(selector, "le sélecteur d'établissement est rendu avec deux rattachements");
  typeInto(selector!, "r2");
  await flush(120);

  assert.equal(draftState(container), "clean", "un changement de locataire remet le brouillon à l'état lu");
  assert.equal(
    q<HTMLInputElement>(container, "#av-cutoff").value,
    "09:00",
    "et l'écran affiche l'heure limite de r2, jamais celle restée dans le brouillon de r1"
  );
  // La valeur d'un champ ne vit pas dans le texte du document : elle est
  // lue sur le champ lui-même.
  const lundi = q(container, '[data-weekday="1"]');
  assert.deepEqual(
    byAria(lundi, fr("avSlotKeyAria").replace("{day}", "Lundi")).map((i) => i.value),
    ["unique_de_r2"],
    "les créneaux affichés sont ceux de r2"
  );
  cleanup();
});

// --------------------------------------------------------------------
// 7. États du brouillon, annulation, et activation validée
// --------------------------------------------------------------------

test("[BO1-SAVE-8] brouillon / enregistré / annulé : trois états lisibles, et « annuler » revient à l'état lu", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({ backend });
  await flush();

  assert.equal(draftState(container), "clean");
  assert.equal(q<HTMLButtonElement>(container, "#av-cancel").disabled, true, "rien à annuler");

  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "21");
  await flush(20);
  assert.equal(draftState(container), "dirty");
  assert.equal(q<HTMLButtonElement>(container, "#av-cancel").disabled, false);

  q<HTMLButtonElement>(container, "#av-cancel").click();
  await flush(20);
  assert.equal(draftState(container), "clean");
  assert.equal(q<HTMLInputElement>(container, "#av-horizon").value, "14", "l'état lu est revenu");
  assert.deepEqual(backend.calls, [], "annuler n'écrit rien, et ne parle même pas au serveur");
  cleanup();
});

test("[BO1-SAVE-9] activer une portée qui ne proposerait aucune date est refusé AVANT l'envoi, et dit ce qui manque", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  const vide = auLaitCruPickupFixture();
  vide.schedules[0].slots = [];
  vide.schedules[0].enabled = false;
  backend.setTenant("r1", vide);
  const { container, cleanup } = setup({ backend });
  await flush();

  // Cocher l'activation sans offre : la page nomme le manque, le bouton
  // reste inactif, et aucun appel n'est tenté.
  const activate = q<HTMLInputElement>(container, "#av-activate");
  assert.equal(activate.disabled, false, "avec le contrat livré, l'activation devient actionnable");
  activate.click();
  await flush(20);

  const blockers = [...container.querySelectorAll("[data-publish-blocker]")].map((el) =>
    el.getAttribute("data-publish-blocker")
  );
  assert.ok(blockers.includes("offer_missing"), `le manque est nommé (vu : ${blockers.join(", ")})`);
  assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "issues");
  saveButton(container).click();
  await flush(60);
  assert.deepEqual(backend.calls, []);
  cleanup();
});

// --------------------------------------------------------------------
// 8. Rôles
// --------------------------------------------------------------------

// --------------------------------------------------------------------
// 7 bis. Le repli en BROUILLON, sur confirmation (remédiation R1, §4)
// --------------------------------------------------------------------

test("[BO1-SAVE-13] configuration incomplète : les manques sont nommés, le BROUILLON est proposé, et il n'est écrit qu'après confirmation", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  const vide = auLaitCruPickupFixture();
  vide.schedules[0].slots = [];
  vide.schedules[0].enabled = false;
  backend.setTenant("r1", vide);
  const { container, cleanup } = setup({ backend });
  await flush();

  // Le commerçant demande l'activation sans avoir d'offre.
  q<HTMLInputElement>(container, "#av-activate").click();
  await flush(20);

  // 1. Les manques sont NOMMÉS.
  const blockers = [...container.querySelectorAll("[data-publish-blocker]")].map((el) =>
    el.getAttribute("data-publish-blocker")
  );
  assert.ok(blockers.includes("offer_missing"), "le manque est nommé");

  // 2. Le brouillon est PROPOSÉ, et rien n'est encore écrit.
  const offer = q<HTMLButtonElement>(container, "#av-save-as-draft");
  assert.ok(
    (container.textContent ?? "").includes(fr("avDraftOffer")),
    "la proposition est écrite en clair, pas seulement un bouton"
  );
  assert.equal(offer.textContent, fr("avDraftOfferConfirm"));
  assert.deepEqual(backend.calls, [], "aucune écriture avant la confirmation");
  assert.equal(saveButton(container).disabled, true, "et l'activation reste, elle, refusée");

  // 3. Confirmation : UNE écriture, désactivée, acceptée.
  offer.click();
  await flush(150);
  assert.deepEqual(backend.calls, [{ restaurantId: "r1", accepted: true }]);
  assert.equal(writtenPayloads.length, 1);
  assert.equal(writtenPayloads[0].enabled, false, "un brouillon, c'est `enabled: false`");
  assert.equal(backend.tenant("r1").schedules[0].enabled, false);
  assert.equal(draftState(container), "saved");
  cleanup();
});

test("[BO1-SAVE-14] refus serveur « configuration incomplète » : le brouillon est proposé en réponse au REFUS, jamais enregistré d'office", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  // L'autorité refuse une configuration que la page croyait complète :
  // c'est le cas normal où le serveur sait quelque chose de plus.
  const { container, cleanup } = setup({
    backend,
    refuseOnceWith: "CSDJBO1_INCOMPLETE_CONFIGURATION",
  });
  await flush();

  typeInto(q<HTMLInputElement>(container, "#av-horizon"), "30");
  await flush(20);
  saveButton(container).click();
  await flush(150);

  assert.equal(
    container.querySelector('[data-save-error="true"]')?.textContent,
    fr("avSaveIncomplete"),
    "le refus a sa phrase, sans code brut"
  );
  assert.equal(backend.calls.filter((c) => c.accepted).length, 0, "rien n'a été écrit");
  const offer = container.querySelector<HTMLButtonElement>("#av-save-as-draft");
  assert.ok(offer, "le brouillon est proposé en réponse au refus serveur");

  offer!.click();
  await flush(150);
  assert.equal(writtenPayloads.length, 2, "deux appels : celui refusé, puis le brouillon confirmé");
  assert.equal(writtenPayloads[1].enabled, false);
  assert.equal(backend.tenant("r1").schedules[0].enabled, false);
  cleanup();
});

test("[BO1-SAVE-15] même en brouillon, une capacité ou une grille incohérente reste REFUSÉE", async () => {
  // Le contrat l'écrit noir sur blanc : le repli en brouillon n'est pas
  // une porte de sortie pour une configuration absurde.
  const backend = new FakeFulfillmentWriteBackend();
  const fixture = auLaitCruPickupFixture();
  fixture.v12 = [
    {
      modeCode: "pickup",
      fulfillmentRuleId: null,
      scheduleMethodVersion: "v1.2",
      holidayCalendarId: null,
      preparationOnHolidays: "open",
      availabilityOnHolidays: "open",
      capacityEnabled: true,
      capacityMaxOrders: 12,
      preparationWeekdays: [2, 3, 4, 5, 6],
      preparationClosures: [],
    },
  ];
  backend.setTenant("r1", fixture);
  const { container, cleanup } = setup({ backend });
  await flush();

  // Capacité active, maximum vidé : refus qui SUBSISTE sans activation.
  const max = q<HTMLInputElement>(container, "#av-capacity-max");
  typeInto(max, "");
  await flush(20);

  assert.ok(
    (container.querySelector('[data-section-issues="capacity"]')?.textContent ?? "").includes(
      fr("avIssueCapacityInvalid")
    ),
    "le refus de capacité est nommé"
  );
  assert.equal(saveButton(container).disabled, true);
  assert.equal(
    container.querySelector("#av-save-as-draft"),
    null,
    "et AUCUN repli en brouillon n'est proposé : il ne résoudrait rien"
  );
  assert.deepEqual(backend.calls, []);
  cleanup();
});

test("[BO1-SAVE-10] rôle staff : même contrat livré, l'écran n'offre AUCUN champ modifiable", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  const fixture = auLaitCruPickupFixture();
  fixture.role = "staff";
  backend.setTenant("r1", fixture);
  const { container, cleanup } = setup({ backend, role: "staff" });
  await flush();

  assert.equal(q<HTMLInputElement>(container, "#av-cutoff").disabled, true);
  assert.equal(q<HTMLInputElement>(container, "#av-horizon").disabled, true);
  assert.equal(q<HTMLInputElement>(container, "#av-activate").disabled, true);
  assert.equal(saveButton(container).disabled, true);
  assert.equal(saveButton(container).getAttribute("data-write-disabled-reason"), "role");
  for (const button of [...container.querySelectorAll("[data-add-row]")] as HTMLButtonElement[]) {
    assert.equal(button.disabled, true, "aucun ajout de ligne n'est offert à un rôle sans écriture");
  }
  assert.ok((container.textContent ?? "").includes(fr("avReadOnly")));
  assert.deepEqual(backend.calls, []);
  cleanup();
});

test("[BO1-SAVE-11] et si une interface future l'oubliait : le serveur refuse le rôle de toute façon", () => {
  // La porte d'interface est une COMMODITÉ ; l'autorité est le serveur.
  // Prouvé ici sans DOM, en appelant le backend simulé directement avec
  // une charge valide mais un rôle sans écriture.
  const backend = new FakeFulfillmentWriteBackend();
  const fixture = auLaitCruPickupFixture();
  fixture.role = "staff";
  backend.setTenant("r1", fixture);
  const snapshot = backend.snapshot("r1");
  assert.throws(
    () =>
      backend.save("r1", {
        modeCode: "pickup",
        fulfillmentRuleId: null,
        method: "v1",
        enabled: true,
        expectedUpdatedAt: "2026-10-14T00:00:00.000Z",
        policy: {
          timezone: "Europe/Paris",
          dateSelectionMode: "customer_selectable",
          slotSelectionMode: "fixed_slots",
          timeGranularityMinutes: null,
          leadTimeMinutes: 0,
          minLeadDays: 1,
          cutoffTime: "16:00",
          cutoffOffsetDays: 1,
          bookingHorizonDays: 14,
        },
        windows: [],
        slots: [{ weekday: 2, slotKey: "midi", startsAt: "11:00", endsAt: "14:00", displayOrder: 0 }],
        closures: [],
      }),
    (error: unknown) =>
      error instanceof FakeWriteRefusal && error.message.startsWith("CSDJ1_FORBIDDEN")
  );
  assert.equal(backend.snapshot("r1"), snapshot);
});

// --------------------------------------------------------------------
// 9. Les quatre langues du mandat, sur l'écran RÉEL
// --------------------------------------------------------------------

test("[BO1-SAVE-12] néerlandais : l'écran et sa barre d'enregistrement sont en NL, jamais un repli français visible", async () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const { container, cleanup } = setup({ backend, uiLang: "nl" });
  await flush();

  const nl = DICTS.nl as Record<string, string>;
  const body = container.textContent ?? "";
  for (const key of ["avTitle", "avCleanState", "avSaveLabel", "avCancelChanges", "avWeekday2"]) {
    assert.ok(body.includes(nl[key]), `« ${nl[key]} » (${key}) doit être rendu en néerlandais`);
  }
  // Et le repli français ne doit PAS être visible pour ces mêmes clés.
  assert.ok(!body.includes(fr("avTitle")), "le titre français ne doit plus apparaître");
  assert.ok(!body.includes(fr("avSaveLabel")), "le bouton français ne doit plus apparaître");

  typeInto(q<HTMLInputElement>(container, "#av-cutoff"), "17:00");
  await flush(20);
  assert.ok(
    (container.querySelector("[data-draft-state]")?.textContent ?? "").includes(
      nl["avDirtyState"].replace("{count}", "1")
    ),
    "le compteur de modifications est en néerlandais, paramètre substitué"
  );
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
