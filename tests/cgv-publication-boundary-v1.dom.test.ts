import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CGV W2 — PUBLICATION BOUNDARY FIXES (Noether, scanym-orchestrator#23,
// BASE EXACTE 24dde51ac047100de7d23c6b28d78b54f013a72c).
//
// Covers all 10 mandated tests (W2-T-01..W2-T-08 here; W2-T-09/W2-T-10
// are process-level checks — full-suite identity delta and forbidden-
// file diff — verified outside this file when assembling the lot's
// evidence packet, never inside a unit test).
//
// Two independent tiers, same file, same convention as every other
// `.dom.test.ts` suite in this repo (esbuild + jsdom for the DOM tier,
// a SEPARATE esbuild bundle for the server tier — `next/cache`'s
// `revalidatePath` throws outside real Next.js request scope and is a
// plain named export, so it can be neither executed for real nor
// `t.mock.method`'d; it must be mocked at bundle time, exactly like
// `server-only`):
//
//   TIER 1 (DOM) — app/dashboard/legal-cgv/page.tsx, real component,
//   real @/lib/legal/render (never mocked — these fixtures are
//   deliberately built to hit its REAL MixedRegimeClauseMissingError /
//   ActualWeightPriceUnsupportedError throw paths), @/lib/services/
//   legal-cgv mocked wholesale (same technique as tests/restaurant-
//   context-critical-regression-gate-legal-cgv.dom.test.ts, extended
//   with per-restaurant/per-mutation deferred+failure control).
//
//   TIER 2 (server) — lib/server/legal-cgv-activate-service.ts, real
//   module, `next/cache`/`server-only`/`@/lib/server/supabase-as-user`/
//   `@/lib/server/supabase-admin` mocked at bundle time.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/legal-cgv?r=resto-a",
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

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMockPlugin(mocks: Record<string, string>): esbuild.Plugin {
  return {
    name: "scanym-mocks",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (mocks[args.path]) {
          return { path: args.path, namespace: "mock" };
        }
        if (args.path.startsWith("@/")) {
          const rel = args.path.slice(2);
          const base = path.join(REPO_ROOT, rel);
          const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
          return { path: candidate ?? base };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
        contents: mocks[args.path],
        loader: "ts",
      }));
    },
  };
}

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for condition");
    await flush(stepMs);
  }
  await flush(stepMs);
}

// --------------------------------------------------------------------
// TIER 1 — DOM fixtures.
// --------------------------------------------------------------------

function legalProfile(id: string, marker: string) {
  return {
    restaurant_id: id,
    legal_form: "SARL",
    address_line1: `1 rue ${marker}`,
    address_line2: null,
    postal_code: "75000",
    city: "Paris",
    governing_country: "FR",
    customer_service_email: `cs-${marker}@example.test`,
    customer_service_phone: null,
    consumer_mediator_name: `Mediateur ${marker}`,
    consumer_mediator_address: `Adresse mediateur ${marker}`,
    consumer_mediator_website: "https://mediateur.example.test",
    updated_at: null,
    legal_entity_name: `LEGAL-${marker}`,
    siren: null,
    siret: null,
    vat_number: null,
    consumer_mediator_phone: null,
    consumer_mediator_email: null,
  };
}

/** `status` defaults to CGV_READY so the Activate button (gated on
 *  `cgv.status === "CGV_READY"`) is exercisable without extra fixture
 *  plumbing in the tests that don't care about that specific gate. */
function cgvProfile(id: string, marker: string, overrides: Record<string, unknown> = {}) {
  return {
    restaurant_id: id,
    withdrawal_regime: "EXEMPT_PERISHABLE",
    preparation_time_min: 10,
    preparation_time_max: 20,
    preparation_time_unit: "MINUTES",
    cancellation_policy_text: `CANCEL-${marker}`,
    substitution_policy_text: `SUBST-${marker}`,
    presentation_variant: "FORMAL",
    status: "CGV_READY",
    profile_version: 1,
    updated_at: null,
    completeness_errors: [] as string[],
    cold_chain_applicable: false,
    weight_pricing_mode: null,
    ...overrides,
  };
}

/** Deliberately carries NO `mixed_order_withdrawal_clause` (W2-T-03)
 *  while still providing a non-null `withdrawal_clauses.MIXED` (so the
 *  EARLIER, generic "no controlled clause" throw in renderCgv is never
 *  hit first — see lib/legal/render.ts lines 418-425 vs. 608-610). */
function templateRpcResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: "tpl-1",
      controlled_sections: {
        header: "HEADER",
        identity_intro: "Intro",
        withdrawal_clauses: {
          EXEMPT_PERISHABLE: "Clause exempt",
          STANDARD_14_DAYS: "Clause standard",
          MIXED: "Clause mixed",
        },
        mediator_clause: "Mediator",
        preparation_clause: "Prep",
        cancellation_clause_label: "Annulation",
        substitution_clause_label: "Remplacement",
        jurisdiction_clause: "Jurisdiction",
        ...overrides,
      },
    },
    error: null,
  };
}

(globalThis as any).__mappings = [
  { restaurant_id: "resto-a", role: "owner", restaurants: { id: "resto-a", name: "Restaurant A", slug: "a" } },
  { restaurant_id: "resto-b", role: "owner", restaurants: { id: "resto-b", name: "Restaurant B", slug: "b" } },
];

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/legal-cgv"; }
`;

const MOCK_AUTH = `
export async function getUser() { return { id: "staff-1" }; }
export async function signOut() {}
`;

const MOCK_DASHBOARD = `
export async function getMerchantRestaurants() { return (globalThis).__mappings; }
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return false; }
export async function getEstablishmentSummary(id) { return { name: "Op " + id }; }
`;

const MOCK_SUPABASE = `
export const supabase = {
  rpc: async (fnName, args) => {
    const restaurantId = args && args.p_restaurant_id;
    (globalThis).__loadCallLog.push({ fn: "template", id: restaurantId });
    const fallback = (globalThis).__templateFallback?.[restaurantId];
    return fallback ?? { data: null, error: null };
  },
};
`;

// CGV W2 (Noether, scanym-orchestrator#23) -- extends the convention
// already established by tests/restaurant-context-critical-regression-
// gate-legal-cgv.dom.test.ts's own MOCK_LEGAL_CGV: restaurant-scoped,
// call-log-instrumented loads, PLUS per-(mutation,restaurant) deferred/
// failure control for the four W2-4 guarded continuations
// (saveLegal/saveCgvProfile/publish/activate) -- needed for W2-T-05
// (in-flight mutation survives a mid-flight context switch) and
// W2-T-06 (no raw error text leaks to the merchant on any of the four).
const MOCK_LEGAL_CGV = `
export class PublishCgvError extends Error {
  constructor(reason) {
    super("PublishCgvError: " + reason);
    this.name = "PublishCgvError";
    this.reason = reason;
  }
}
export class ActivateCgvError extends Error {
  constructor(reason) {
    super("ActivateCgvError: " + reason);
    this.name = "ActivateCgvError";
    this.reason = reason;
  }
}

export async function getMerchantLegalProfile(restaurantId) {
  (globalThis).__loadCallLog.push({ fn: "legal", id: restaurantId });
  const fallback = (globalThis).__legalFallback?.[restaurantId];
  return fallback ?? null;
}

export async function getMerchantCgvProfile(restaurantId) {
  (globalThis).__loadCallLog.push({ fn: "cgv", id: restaurantId });
  const fallback = (globalThis).__cgvFallback?.[restaurantId];
  return fallback ?? null;
}

function mutationCall(kind, restaurantId, successValue) {
  (globalThis).__mutationCallLog[kind].push(restaurantId);
  const deferred = (globalThis).__mutationDeferred[kind].get(restaurantId);
  if (deferred) return deferred.promise;
  const failure = (globalThis).__mutationFailure[kind] && (globalThis).__mutationFailure[kind][restaurantId];
  if (failure) return Promise.reject(failure);
  return Promise.resolve(successValue);
}

export async function updateMerchantLegalProfile(params) {
  return mutationCall("saveLegal", params.restaurantId, undefined);
}
export async function updateMerchantCgvProfile(params) {
  return mutationCall("saveCgvProfile", params.restaurantId, undefined);
}
export async function publishMerchantCgvVersion(params) {
  return mutationCall("publish", params.restaurantId, {});
}
export async function activateMerchantCgv(restaurantId) {
  return mutationCall("activate", restaurantId, undefined);
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/supabase": MOCK_SUPABASE,
  "@/lib/services/legal-cgv": MOCK_LEGAL_CGV,
};

const entrySource = `
export { default as LegalCgvPage } from "@/app/dashboard/legal-cgv/page";
export { translate } from "@/lib/i18n";
`;

const buildResult = await esbuild.build({
  stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [makeMockPlugin(mocks)],
  external: ["react", "react-dom", "react-dom/client"],
});
const domCode = buildResult.outputFiles[0].text;
const domTmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const domTmpFile = path.join(domTmpDir, "LegalCgvPage.mjs");
writeFileSync(domTmpFile, domCode);
const { LegalCgvPage, translate } = await import(pathToFileURL(domTmpFile).href);
rmSync(domTmpDir, { recursive: true, force: true });

function t(key: string): string {
  return translate("fr", key);
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(LegalCgvPage));
  return { container, root };
}

function switchTo(container: HTMLElement, restaurantId: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the restaurant <select> switcher must be present in DashboardNav");
  select!.value = restaurantId;
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function clickTestId(container: HTMLElement, testId: string) {
  const btn = container.querySelector(`[data-testid="${testId}"]`);
  assert.ok(btn, `expected an element with data-testid="${testId}"`);
  btn!.dispatchEvent(new window.Event("click", { bubbles: true }));
}

/**
 * DEFENSE-IN-DEPTH HELPER ONLY -- NOT the primary proof for W2-T-02.
 *
 * REMÉDIATION B1 (Chateaubriand, audit indépendant de d6ad249,
 * scanym-orchestrator#23) -- cette technique invoque directement la
 * closure `onClick` que React a attachée à l'élément, via la clé
 * interne `__reactProps$*` que React lui-même stocke sur le nœud DOM.
 * L'audit a jugé, à raison, qu'une version antérieure de ce fichier
 * utilisait CETTE technique comme preuve PRINCIPALE du comportement
 * attendu de W2-T-02 -- ce qui "ne prouve que la branche du handler,
 * jamais l'exigence visible par l'utilisateur" : aucun utilisateur réel
 * ne peut cliquer sur un `<button disabled>` (vérifié empiriquement,
 * deux scripts React+jsdom autonomes : `.click()`, un `Event` "click"
 * envoyé manuellement, et même forcer `.disabled = false` sur le nœud
 * DOM réel immédiatement avant l'envoi échouent tous à invoquer le
 * handler -- React consulte son propre instantané de props du Fiber,
 * jamais l'attribut DOM en direct ; c'est aussi le comportement exact
 * d'un vrai navigateur face à un `<button>` réellement désactivé).
 *
 * Ce helper reste disponible UNIQUEMENT pour un test SECONDAIRE,
 * clairement distinct, qui vérifie la défense en profondeur du garde
 * interne au handler (`publish()`, "un clic malgré tout -- un
 * double-clic pendant la désactivation, par exemple") -- jamais pour
 * prouver l'exigence utilisateur elle-même, qui doit être prouvée par
 * une assertion DOM/état-rendu réelle (voir W2-T-02 ci-dessous).
 */
function invokeOnClickDirectly(container: HTMLElement, testId: string) {
  const btn = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  assert.ok(btn, `expected an element with data-testid="${testId}"`);
  assert.equal(btn!.disabled, true, "this helper is only meaningful against a button the app actually disabled");
  const propsKey = Object.keys(btn as unknown as Record<string, unknown>).find((k) => k.startsWith("__reactProps$"));
  assert.ok(propsKey, "expected React to have stored its internal props key on the DOM node");
  const onClick = (btn as unknown as Record<string, { onClick?: (e: unknown) => void }>)[propsKey!].onClick;
  assert.ok(typeof onClick === "function", "expected an onClick handler on this element");
  onClick!({ preventDefault() {}, stopPropagation() {} });
}

function pageErrorText(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="legal-cgv-page-error"]')?.textContent ?? null;
}
function actionMessageText(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="legal-cgv-action-message"]')?.textContent ?? null;
}
/**
 * REMÉDIATION B1 (Chateaubriand, audit d6ad249) -- lecture du message
 * de la section 6 (aperçu), rendu de façon persistante à chaque rendu
 * dès que `cgv` existe (`previewResult`/`previewFailureMessage` dans
 * app/dashboard/legal-cgv/page.tsx), jamais conditionné par un clic.
 */
function previewMessageText(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="legal-cgv-preview-message"]')?.textContent ?? null;
}
async function waitSettled(container: HTMLElement): Promise<void> {
  // Two phases, deliberately in this order: `container` is still EMPTY
  // for a tick or two right after `root.render()` (React 18's commit is
  // scheduled, not synchronous), so waiting ONLY on the ABSENCE of
  // `[data-context-loading]` would pass trivially before the page has
  // mounted at all. Phase 1 waits for a POSITIVE signal (the page body
  // has actually mounted); only then does phase 2's absence check mean
  // what it says. The provenance gate (app/dashboard/legal-cgv/page.tsx
  // §5, `data-context-loading`) clears once `load()` has committed for
  // the CURRENTLY selected restaurant -- true whether that commit lands
  // on the full-data branch or the W2-7 `!cgvRow` branch (both set
  // `legalLoadedRestaurantId`), so phase 2 is a valid "settled" signal
  // for every fixture in this suite, including W2-T-08.
  await waitFor(() => container.querySelector("h1") !== null);
  await waitFor(() => container.querySelector("[data-context-loading]") === null);
}

function resetCommonFixtures() {
  (globalThis as any).__loadCallLog = [];
  (globalThis as any).__legalFallback = {};
  (globalThis as any).__cgvFallback = {};
  (globalThis as any).__templateFallback = {};
  (globalThis as any).__mutationDeferred = {
    saveLegal: new Map(),
    saveCgvProfile: new Map(),
    publish: new Map(),
    activate: new Map(),
  };
  (globalThis as any).__mutationCallLog = { saveLegal: [], saveCgvProfile: [], publish: [], activate: [] };
  (globalThis as any).__mutationFailure = { saveLegal: {}, saveCgvProfile: {}, publish: {}, activate: {} };
}

// ====================================================================
// TIER 1 — DOM tests.
// ====================================================================

test("W2-T-01 — get_applicable_cgv_template in error => distinct pageError (legalCgvTemplateLoadFailed) + Publier disabled", async () => {
  resetCommonFixtures();
  (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
  (globalThis as any).__cgvFallback["resto-a"] = cgvProfile("resto-a", "A");
  (globalThis as any).__templateFallback["resto-a"] = { data: null, error: { message: "RPC transport failure" } };

  const { container, root } = render();
  await waitSettled(container);

  assert.equal(
    pageErrorText(container),
    t("legalCgvTemplateLoadFailed"),
    "a templateRow.error must surface its OWN distinct pageError, never the generic legalCgvLoadFailed nor silence"
  );
  const publishBtn = container.querySelector('[data-testid="legal-cgv-publish"]') as HTMLButtonElement | null;
  assert.ok(publishBtn, "the Publish button must still render (cgv profile is present)");
  assert.equal(publishBtn!.disabled, true, "Publish must be disabled whenever no template could be resolved (W2-1/W2-2)");

  root.unmount();
  container.remove();
});

test("W2-T-02 — template === null => an explicit, persistent, user-visible 'no template' state is rendered with no click required, Publier stays disabled, never the generic 'profil incomplet', and no publish mutation is ever attempted", async () => {
  // REMÉDIATION B1 (Chateaubriand/Noether, scanym-orchestrator#23) --
  // cette version N'INVOQUE JAMAIS `invokeOnClickDirectly` : la preuve
  // porte sur l'ÉTAT RENDU de la page elle-même (section 6, calculé à
  // chaque rendu via `buildPreviewResult()`/`previewFailureMessage()`,
  // JAMAIS à l'intérieur d'un handler de clic), exactement ce que
  // l'audit exige -- "test the actual rendered DOM/user state, not
  // __reactProps$ internals".
  resetCommonFixtures();
  (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
  (globalThis as any).__cgvFallback["resto-a"] = cgvProfile("resto-a", "A"); // complete profile: completeness_errors === []
  (globalThis as any).__templateFallback["resto-a"] = { data: null, error: null }; // no template resolved for this country

  const { container, root } = render();
  await waitSettled(container);

  // No click of any kind has happened yet -- the message must already
  // be present, because "no template resolved" is a page STATE, not an
  // event outcome.
  assert.equal(
    previewMessageText(container),
    t("legalCgvNoTemplate"),
    "template === null must persistently render its OWN distinct explanation, with no click required"
  );
  assert.notEqual(
    previewMessageText(container),
    t("legalCgvIncomplete"),
    "template === null must NEVER be classified as the generic 'profil incomplet' state"
  );
  assert.ok(
    !(container.textContent ?? "").includes(t("legalCgvIncomplete")),
    "the generic 'profil incomplet' text must not appear anywhere on the page for this state"
  );

  const publishBtn = container.querySelector('[data-testid="legal-cgv-publish"]') as HTMLButtonElement | null;
  assert.ok(publishBtn, "the Publish button must still render");
  assert.equal(publishBtn!.disabled, true, "Publish must stay disabled while template === null (W2-2)");

  assert.deepEqual(
    (globalThis as any).__mutationCallLog.publish,
    [],
    "no publish mutation may ever be attempted for this state"
  );

  root.unmount();
  container.remove();
});

test("W2-T-02b (défense en profondeur, SECONDAIRE -- ne remplace pas W2-T-02 ci-dessus) — if the in-handler publish() guard is ever reached despite the button being disabled, it still short-circuits with the same explicit message and never calls the mutation", async () => {
  // Cf. le commentaire sur `invokeOnClickDirectly` : aucun utilisateur
  // réel ne peut déclencher ce chemin par un clic (le bouton est
  // désactivé, W2-2) -- ce test vérifie uniquement le garde interne au
  // handler lui-même, en défense en profondeur, jamais l'exigence
  // utilisateur (déjà prouvée ci-dessus sans aucun clic).
  resetCommonFixtures();
  (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
  (globalThis as any).__cgvFallback["resto-a"] = cgvProfile("resto-a", "A");
  (globalThis as any).__templateFallback["resto-a"] = { data: null, error: null };

  const { container, root } = render();
  await waitSettled(container);

  invokeOnClickDirectly(container, "legal-cgv-publish");
  await waitFor(() => actionMessageText(container) !== null);

  assert.equal(actionMessageText(container), t("legalCgvNoTemplate"));
  assert.deepEqual(
    (globalThis as any).__mutationCallLog.publish,
    [],
    "the !template guard must short-circuit BEFORE ever calling publishMerchantCgvVersion -- never a silent return, but never a wasted network call either"
  );

  root.unmount();
  container.remove();
});

test("W2-T-03 — MIXED regime without the template's mixed-order clause => message distinct from the generic 'profil incomplet'", async () => {
  resetCommonFixtures();
  (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
  (globalThis as any).__cgvFallback["resto-a"] = cgvProfile("resto-a", "A", { withdrawal_regime: "MIXED" });
  (globalThis as any).__templateFallback["resto-a"] = templateRpcResult(); // no mixed_order_withdrawal_clause

  const { container, root } = render();
  await waitSettled(container);

  assert.ok(
    container.textContent!.includes(t("legalCgvMixedRegimeClauseMissing")),
    "the preview section must show the MIXED-specific message"
  );
  assert.ok(
    !container.textContent!.includes(t("legalCgvIncomplete")),
    "it must NOT fall back to the generic 'incomplete profile' message (W2-3)"
  );

  root.unmount();
  container.remove();
});

test("W2-T-04 — ACTUAL_WEIGHT_PRICE weight pricing mode => message distinct from the generic 'profil incomplet'", async () => {
  resetCommonFixtures();
  (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
  (globalThis as any).__cgvFallback["resto-a"] = cgvProfile("resto-a", "A", { weight_pricing_mode: "ACTUAL_WEIGHT_PRICE" });
  (globalThis as any).__templateFallback["resto-a"] = templateRpcResult();

  const { container, root } = render();
  await waitSettled(container);

  assert.ok(
    container.textContent!.includes(t("legalCgvActualWeightPriceUnsupported")),
    "the preview section must show the ACTUAL_WEIGHT_PRICE-specific message"
  );
  assert.ok(
    !container.textContent!.includes(t("legalCgvIncomplete")),
    "it must NOT fall back to the generic 'incomplete profile' message (W2-3)"
  );

  root.unmount();
  container.remove();
});

test("W2-T-08 — missing CGV profile (getMerchantCgvProfile falsy) => explicit message, page never silently stuck/truncated (W2-7)", async () => {
  resetCommonFixtures();
  (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
  // __cgvFallback["resto-a"] deliberately absent -> mock resolves null.
  (globalThis as any).__templateFallback["resto-a"] = templateRpcResult();

  const { container, root } = render();
  await waitSettled(container);

  assert.equal(pageErrorText(container), t("legalCgvProfileMissing"));
  // Not truncated: the rest of the page (sections outside the `cgv &&`
  // gate, e.g. section 2's mandatory legal-info identity field) still
  // renders -- the merchant sees an explanation, not a blank/stuck page.
  const legalEntityInput = container.querySelector(
    `input[placeholder="${t("legalCgvLegalEntityName")}"]`
  ) as HTMLInputElement | null;
  assert.ok(legalEntityInput, "section 2 must still render -- an explicit error, never a silently truncated page");
  assert.equal(container.querySelector("textarea"), null, "cgv-gated sections (3-7) must stay absent, never a crash");

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------------
// W2-T-05 / W2-T-06 — parameterized over the four W2-4 continuations.
// --------------------------------------------------------------------

type MutationCase = {
  label: string;
  kind: "saveLegal" | "saveCgvProfile" | "publish" | "activate";
  testId: string;
  successMessageKey: string;
  failureMessageKey: string;
};

const MUTATION_CASES: MutationCase[] = [
  { label: "saveLegal", kind: "saveLegal", testId: "legal-cgv-save-legal", successMessageKey: "legalCgvSaved", failureMessageKey: "legalCgvSaveFailed" },
  { label: "saveCgvProfile", kind: "saveCgvProfile", testId: "legal-cgv-save-cgv", successMessageKey: "legalCgvSaved", failureMessageKey: "legalCgvSaveFailed" },
  { label: "publish", kind: "publish", testId: "legal-cgv-publish", successMessageKey: "legalCgvPublished", failureMessageKey: "legalCgvPublishFailed" },
  { label: "activate", kind: "activate", testId: "legal-cgv-activate", successMessageKey: "legalCgvActivated", failureMessageKey: "legalCgvActivateFailed" },
];

function setupTwoRestaurants() {
  resetCommonFixtures();
  (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
  (globalThis as any).__legalFallback["resto-b"] = legalProfile("resto-b", "B");
  (globalThis as any).__cgvFallback["resto-a"] = cgvProfile("resto-a", "A");
  (globalThis as any).__cgvFallback["resto-b"] = cgvProfile("resto-b", "B");
  (globalThis as any).__templateFallback["resto-a"] = templateRpcResult();
  (globalThis as any).__templateFallback["resto-b"] = templateRpcResult();
}

function legalEntityValue(container: HTMLElement): string {
  const input = container.querySelector(
    `input[placeholder="${t("legalCgvLegalEntityName")}"]`
  ) as HTMLInputElement | null;
  return input?.value ?? "";
}
function cancellationValue(container: HTMLElement): string {
  const textarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement | undefined;
  return textarea?.value ?? "";
}

for (const mutationCase of MUTATION_CASES) {
  test(`W2-T-05 (${mutationCase.label}) — scénario c3: publier sur A, basculer sur B pendant le vol, résoudre => B reste affiché, jamais bloqué`, async () => {
    setupTwoRestaurants();

    const { container, root } = render();
    await waitSettled(container);
    assert.equal(legalEntityValue(container), "LEGAL-A", "must start on A");

    const deferredA = makeDeferred<unknown>();
    (globalThis as any).__mutationDeferred[mutationCase.kind].set("resto-a", deferredA);

    clickTestId(container, mutationCase.testId);
    await waitFor(() => (globalThis as any).__mutationCallLog[mutationCase.kind].includes("resto-a"));
    // A's mutation is now in flight (deferred, not yet resolved).

    const loadCallCountBeforeSwitch = (globalThis as any).__loadCallLog.length;

    switchTo(container, "resto-b");
    await waitSettled(container);
    await waitFor(() => legalEntityValue(container) === "LEGAL-B");

    assert.equal(cancellationValue(container), "CANCEL-B", "B's own CGV profile must be fully displayed");
    assert.equal(
      actionMessageText(container),
      null,
      "nothing of A's still-pending operation may be visible under B's context"
    );
    const btnUnderB = container.querySelector(`[data-testid="${mutationCase.testId}"]`) as HTMLButtonElement | null;
    assert.ok(btnUnderB, "B's own mutation button must be present");
    assert.equal(
      btnUnderB!.disabled,
      false,
      "B must never be blocked by A's still-in-flight operation (enterLegalCgvContext resets `saving`, W2-4)"
    );

    const loadCallCountAfterSwitch = (globalThis as any).__loadCallLog.length;

    // A's mutation finally resolves, LATE, after B is already displayed.
    deferredA.resolve(undefined);
    await flush(80);

    assert.equal(legalEntityValue(container), "LEGAL-B", "B must STILL be displayed after A's stale continuation resolves");
    assert.equal(cancellationValue(container), "CANCEL-B", "B's CGV profile must not revert to A's");
    assert.equal(
      actionMessageText(container),
      null,
      "A's stale continuation must never surface ITS success message under B's context (isOperationCurrent() guard, W2-4)"
    );
    assert.equal(
      (globalThis as any).__loadCallLog.length,
      loadCallCountAfterSwitch,
      "A's stale continuation must be abandoned BEFORE it ever re-triggers load(A) -- guard 1, before any reread"
    );
    assert.ok(loadCallCountAfterSwitch > loadCallCountBeforeSwitch, "switching to B must itself have triggered B's own load");

    root.unmount();
    container.remove();
  });

  test(`W2-T-06 (${mutationCase.label}) — on failure, no raw SQL/PostgREST message is ever shown; only the stable translated key`, async () => {
    resetCommonFixtures();
    (globalThis as any).__legalFallback["resto-a"] = legalProfile("resto-a", "A");
    (globalThis as any).__cgvFallback["resto-a"] = cgvProfile("resto-a", "A");
    (globalThis as any).__templateFallback["resto-a"] = templateRpcResult();

    const rawMessage = 'duplicate key value violates unique constraint "merchant_cgv_profile_pkey" (SQLSTATE 23505)';
    (globalThis as any).__mutationFailure[mutationCase.kind]["resto-a"] = new Error(rawMessage);

    const { container, root } = render();
    await waitSettled(container);

    clickTestId(container, mutationCase.testId);
    await waitFor(() => actionMessageText(container) !== null);

    const shown = actionMessageText(container)!;
    assert.ok(!shown.includes("constraint"), "no raw PostgREST/SQL fragment may ever reach the merchant (W2-5)");
    assert.ok(!shown.includes("23505"), "no raw SQLSTATE code may ever reach the merchant (W2-5)");
    assert.ok(!shown.includes("pkey"), "no raw constraint name may ever reach the merchant (W2-5)");
    assert.equal(shown, t(mutationCase.failureMessageKey), "the stable, translated failure key must be shown instead");

    root.unmount();
    container.remove();
  });
}

// ====================================================================
// TIER 2 — server-side bundle (W2-T-07).
// ====================================================================

const MOCK_SERVER_ONLY = "export {};";

const MOCK_NEXT_CACHE = `
export function revalidatePath(pathArg) {
  (globalThis).__revalidateCalls.push(pathArg);
}
`;

const MOCK_SUPABASE_AS_USER = `
export const asUserSupabaseClientFactory = {
  create(accessToken) {
    (globalThis).__asUserTokens.push(accessToken);
    return {
      rpc: async (fnName, args) => {
        const restaurantId = args && args.p_restaurant_id;
        (globalThis).__rpcCalls.push({ fnName, args });
        const err = (globalThis).__rpcError && (globalThis).__rpcError[restaurantId];
        if (err) return { data: null, error: err };
        return { data: null, error: null };
      },
    };
  },
};
`;

const MOCK_SUPABASE_ADMIN = `
export function getServiceRoleSupabaseClient() {
  return {
    from(table) {
      return {
        select(cols) {
          return {
            eq(col, val) {
              return {
                single: async () => {
                  (globalThis).__adminLookups.push(val);
                  const row = (globalThis).__slugFallback && (globalThis).__slugFallback[val];
                  if (!row) return { data: null, error: { message: "not found" } };
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}
`;

const serverMocks: Record<string, string> = {
  "server-only": MOCK_SERVER_ONLY,
  "next/cache": MOCK_NEXT_CACHE,
  "@/lib/server/supabase-as-user": MOCK_SUPABASE_AS_USER,
  "@/lib/server/supabase-admin": MOCK_SUPABASE_ADMIN,
};

const serverEntrySource = `
export {
  activateMerchantCgvServerAuthoritative,
  invalidatePublicLegalPage,
} from "@/lib/server/legal-cgv-activate-service";
`;

const serverBuildResult = await esbuild.build({
  stdin: { contents: serverEntrySource, resolveDir: REPO_ROOT, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  plugins: [makeMockPlugin(serverMocks)],
});
const serverCode = serverBuildResult.outputFiles[0].text;
const serverTmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-server-"));
const serverTmpFile = path.join(serverTmpDir, "legal-cgv-activate-service.mjs");
writeFileSync(serverTmpFile, serverCode);
const { activateMerchantCgvServerAuthoritative, invalidatePublicLegalPage } = await import(
  pathToFileURL(serverTmpFile).href
);
rmSync(serverTmpDir, { recursive: true, force: true });

function resetServerFixtures() {
  (globalThis as any).__revalidateCalls = [];
  (globalThis as any).__asUserTokens = [];
  (globalThis as any).__rpcCalls = [];
  (globalThis as any).__rpcError = {};
  (globalThis as any).__adminLookups = [];
  (globalThis as any).__slugFallback = {};
}

test("W2-T-07 — invalidatePublicLegalPage(restaurantId) calls revalidatePath(/legal/<slug>) for a resolvable restaurant", async () => {
  resetServerFixtures();
  (globalThis as any).__slugFallback["resto-a"] = { slug: "resto-a-slug" };

  await invalidatePublicLegalPage("resto-a");

  assert.deepEqual((globalThis as any).__revalidateCalls, ["/legal/resto-a-slug"]);
});

test("W2-T-07 — invalidatePublicLegalPage(restaurantId) is a safe no-op (never throws) when the restaurant/slug cannot be resolved", async () => {
  resetServerFixtures();
  // __slugFallback left empty -> admin lookup returns no row.

  await assert.doesNotReject(() => invalidatePublicLegalPage("resto-ghost"));
  assert.deepEqual((globalThis as any).__revalidateCalls, [], "nothing to invalidate for an unresolved restaurant");
});

test("W2-T-07 — activateMerchantCgvServerAuthoritative: on RPC success, invalidates /legal/<slug> (W2-6)", async () => {
  resetServerFixtures();
  (globalThis as any).__slugFallback["resto-a"] = { slug: "a" };

  await activateMerchantCgvServerAuthoritative("caller-token", "resto-a");

  assert.equal((globalThis as any).__rpcCalls.length, 1);
  assert.equal((globalThis as any).__rpcCalls[0].fnName, "activate_merchant_cgv");
  assert.deepEqual((globalThis as any).__rpcCalls[0].args, { p_restaurant_id: "resto-a" });
  assert.deepEqual((globalThis as any).__asUserTokens, ["caller-token"], "must authenticate with the CALLER's own token, never a server secret");
  assert.deepEqual((globalThis as any).__revalidateCalls, ["/legal/a"]);
});

test("W2-T-07 — activateMerchantCgvServerAuthoritative: on RPC failure, never invalidates the cache, and classifies by code/message only (zero SQL change)", async () => {
  resetServerFixtures();
  (globalThis as any).__slugFallback["resto-a"] = { slug: "a" };

  const cases: Array<[{ code?: string; message?: string }, string]> = [
    [{ code: "28000", message: "no session" }, "auth"],
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ message: "CGV_INCOMPLETE: missing required fields" }, "incomplete"],
    [{ message: "CGV_NOT_PUBLISHED: nothing to activate" }, "not_published"],
    [{ message: "connection reset" }, "unavailable"],
  ];

  for (const [rpcError, expectedReason] of cases) {
    (globalThis as any).__revalidateCalls = [];
    (globalThis as any).__rpcError = { "resto-a": rpcError };

    await assert.rejects(
      () => activateMerchantCgvServerAuthoritative("token", "resto-a"),
      (err: any) => {
        assert.equal(err.reason, expectedReason, `rpc error ${JSON.stringify(rpcError)} must classify as "${expectedReason}"`);
        return true;
      }
    );
    assert.deepEqual(
      (globalThis as any).__revalidateCalls,
      [],
      `a FAILED activation (reason=${expectedReason}) must never invalidate the public legal page`
    );
  }
});

test("W2-T-07 — structural proof: publish/route.ts calls the SAME shared invalidatePublicLegalPage after a successful publish (never a second implementation)", () => {
  const publishRouteSource = readFileSync(path.join(REPO_ROOT, "app/api/dashboard/legal-cgv/publish/route.ts"), "utf8");
  assert.match(
    publishRouteSource,
    /import\s*\{\s*invalidatePublicLegalPage\s*\}\s*from\s*"@\/lib\/server\/legal-cgv-activate-service"/,
    "publish/route.ts must import the SHARED invalidatePublicLegalPage, never reimplement its own"
  );
  assert.match(
    publishRouteSource,
    /await\s+invalidatePublicLegalPage\(body\.restaurantId\)/,
    "publish/route.ts must call invalidatePublicLegalPage after a successful publish"
  );

  const activateRouteSource = readFileSync(path.join(REPO_ROOT, "app/api/dashboard/legal-cgv/activate/route.ts"), "utf8");
  assert.match(
    activateRouteSource,
    /activateMerchantCgvServerAuthoritative/,
    "activate/route.ts must delegate to the server-authoritative activation function (which itself invalidates on success)"
  );
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
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mappings;
  delete (globalThis as any).__loadCallLog;
  delete (globalThis as any).__legalFallback;
  delete (globalThis as any).__cgvFallback;
  delete (globalThis as any).__templateFallback;
  delete (globalThis as any).__mutationDeferred;
  delete (globalThis as any).__mutationCallLog;
  delete (globalThis as any).__mutationFailure;
  delete (globalThis as any).__revalidateCalls;
  delete (globalThis as any).__asUserTokens;
  delete (globalThis as any).__rpcCalls;
  delete (globalThis as any).__rpcError;
  delete (globalThis as any).__adminLookups;
  delete (globalThis as any).__slugFallback;
});
