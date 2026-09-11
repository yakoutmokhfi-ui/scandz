import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// DELIVERY PRICING OPERATOR AUTHORIZATION v1.2 — TARGETED FRONTEND
// AUTHORIZATION REMEDIATION (audit Cat Woman).
//
// Rendu RÉEL en DOM (jsdom) de app/dashboard/delivery-pricing/page.tsx
// -- jamais une réimplémentation. Seuls next/navigation,
// @/lib/services/auth, @/lib/services/establishments et
// @/lib/services/dashboard sont remplacés par des modules virtuels
// (même patron que tests/v149-operator-dashboard-context-v1.dom.test.ts,
// fichier DISTINCT et NON modifié par ce lot -- ce fichier est
// autonome et ne dépend d'aucun autre fichier de test).
//
// Preuve visée (mandat v1.2, finding Cat Woman) : `canEdit` doit
// désormais refléter EXACTEMENT le contrat SQL déjà en place depuis
// v1.1 (is_scanym_operator() INDÉPENDANT de toute adhésion
// restaurant_users) :
//
//   1. Opérateur SANS mapping                -> éditable
//   2. Opérateur + mapping staff              -> éditable (le bug v1.1)
//   3. Opérateur + mapping manager            -> éditable
//   4. Opérateur + mapping owner              -> éditable
//   5. Non-opérateur + mapping staff          -> NON éditable
//   6. Non-opérateur + mapping manager        -> éditable
//   7. Non-opérateur + mapping owner          -> éditable
//   8. Comportement marchand par ailleurs inchangé (lecture des
//      valeurs serveur, aucune donnée d'un autre restaurant)
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/delivery-pricing?r=r-target",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

// Établissement CIBLÉ par ?r= -- distinct de tout rattachement propre
// éventuel de l'utilisateur de test, pour isoler strictement le
// comportement canEdit du chemin de résolution d'affichage (déjà
// prouvé correct et non modifié par ce lot, voir v149).
const TARGET_ID = "r-target";
const TARGET_NAME = "Fixture Cible (v1.2)";

(globalThis as any).__mockUser = { id: "test-user-1" };
(globalThis as any).__mockIsOperator = false;
(globalThis as any).__mockMappings = [] as { restaurant_id: string; role: string; restaurants: { id: string; name: string; slug: string } }[];
(globalThis as any).__mockGetSummary = async (id: string) => {
  if (id !== TARGET_ID) throw new Error("not found");
  return { restaurantId: TARGET_ID, name: TARGET_NAME, slug: "fixture-cible", status: "active", ownerEmail: null, ownerStatus: null };
};
(globalThis as any).__mockRule = {
  ruleId: "rule-target-1",
  fulfillmentLabel: "Livraison standard",
  pricingMode: "fixed",
  fixedFee: 4.5,
  freeThreshold: null,
  customerText: null,
};
(globalThis as any).__mockUpdateCalls = [] as any[];

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/delivery-pricing"; }
`;

const MOCK_AUTH = `
export async function getUser() { return (globalThis).__mockUser; }
export async function signOut() {}
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__mockIsOperator; }
export async function getEstablishmentSummary(id) { return (globalThis).__mockGetSummary(id); }
`;

const MOCK_DASHBOARD = `
export async function getMerchantRestaurants() {
  return (globalThis).__mockMappings;
}
export async function getMerchantDeliveryFulfillmentPricing(id) {
  // Le mapping cible étant TOUJOURS présent (owner/manager/staff) ou
  // l'opérateur bypassant déjà en SQL (v1.1, non modifié par ce lot),
  // la lecture réussit systématiquement ici -- ce fichier isole
  // strictement l'assertion canEdit (frontend), pas la lecture SQL
  // (déjà couverte par supabase/tests/delivery-pricing-operator-
  // authorization-v1-check.sh).
  if (id !== "${TARGET_ID}") throw new Error("Not authorized for this restaurant");
  return [(globalThis).__mockRule];
}
export async function updateMerchantDeliveryFulfillmentPricing(args) {
  (globalThis).__mockUpdateCalls.push(args);
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks-dp-v1-2",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path in mocks) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
  },
};

async function buildPage(entryRelPath: string, exportName: string) {
  const entrySource = `export { default as ${exportName} } from "@/${entryRelPath}";`;
  const buildResult = await esbuild.build({
    stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    plugins: [mockPlugin],
    external: ["react", "react-dom", "react-dom/client"],
  });
  const code = buildResult.outputFiles[0].text;
  const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
  const tmpFile = path.join(tmpDir, `${exportName}.mjs`);
  writeFileSync(tmpFile, code);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpDir, { recursive: true, force: true });
  return mod[exportName];
}

const DeliveryPricingPage = await buildPage("app/dashboard/delivery-pricing/page.tsx", "DeliveryPricingPage");

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition jamais satisfaite avant le délai");
    await flush(intervalMs);
  }
}

function render(Component: any) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Component));
  return { container, root };
}

function resetGlobalMockState(opts: { isOperator: boolean; role: "owner" | "manager" | "staff" | null }) {
  (globalThis as any).__mockIsOperator = opts.isOperator;
  (globalThis as any).__mockMappings = opts.role
    ? [{ restaurant_id: TARGET_ID, role: opts.role, restaurants: { id: TARGET_ID, name: TARGET_NAME, slug: "fixture-cible" } }]
    : [];
  (globalThis as any).__mockUpdateCalls = [];
}

async function renderAndGetInputs() {
  window.history.pushState({}, "", `/dashboard/delivery-pricing?r=${TARGET_ID}`);
  const { container, root } = render(DeliveryPricingPage);
  await waitFor(() => container.textContent!.includes("Livraison standard"));
  const inputs = [...container.querySelectorAll("input")] as HTMLInputElement[];
  assert.ok(inputs.length > 0, "les règles doivent être rendues");
  return { container, root, inputs };
}

// ====================================================================
// 1-4. Opérateur : éditable dans TOUS les cas (mapping absent, staff,
// manager, owner) -- l'autorisation opérateur est INDÉPENDANTE de
// toute adhésion marchande, exactement comme le contrat SQL
// (is_member_of/has_role_in OR is_scanym_operator()).
// ====================================================================

test("1. Opérateur SANS mapping restaurant_users -> éditable", async () => {
  resetGlobalMockState({ isOperator: true, role: null });
  const { container, root, inputs } = await renderAndGetInputs();
  for (const input of inputs) assert.equal(input.disabled, false, "un opérateur doit pouvoir éditer même sans adhésion");
  root.unmount();
  container.remove();
});

test("2. Opérateur + mapping staff -> éditable (correction du bug v1.1 signalé par l'audit)", async () => {
  resetGlobalMockState({ isOperator: true, role: "staff" });
  const { container, root, inputs } = await renderAndGetInputs();
  for (const input of inputs) assert.equal(input.disabled, false, "un opérateur avec mapping staff doit pouvoir éditer -- l'autorité opérateur est indépendante du rôle marchand");
  root.unmount();
  container.remove();
});

test("3. Opérateur + mapping manager -> éditable", async () => {
  resetGlobalMockState({ isOperator: true, role: "manager" });
  const { container, root, inputs } = await renderAndGetInputs();
  for (const input of inputs) assert.equal(input.disabled, false);
  root.unmount();
  container.remove();
});

test("4. Opérateur + mapping owner -> éditable", async () => {
  resetGlobalMockState({ isOperator: true, role: "owner" });
  const { container, root, inputs } = await renderAndGetInputs();
  for (const input of inputs) assert.equal(input.disabled, false);
  root.unmount();
  container.remove();
});

// ====================================================================
// 5-7. Non-opérateur : comportement marchand STRICTEMENT inchangé
// (staff refusé, manager/owner autorisés) -- non-régression explicite
// du contrat marchand pré-existant, v1.1 et v1.2 confondus.
// ====================================================================

test("5. Non-opérateur + mapping staff -> NON éditable (contrat marchand inchangé)", async () => {
  resetGlobalMockState({ isOperator: false, role: "staff" });
  const { container, root, inputs } = await renderAndGetInputs();
  for (const input of inputs) assert.equal(input.disabled, true, "staff non-opérateur ne doit jamais éditer");
  root.unmount();
  container.remove();
});

test("6. Non-opérateur + mapping manager -> éditable (contrat marchand inchangé)", async () => {
  resetGlobalMockState({ isOperator: false, role: "manager" });
  const { container, root, inputs } = await renderAndGetInputs();
  for (const input of inputs) assert.equal(input.disabled, false);
  root.unmount();
  container.remove();
});

test("7. Non-opérateur + mapping owner -> éditable (contrat marchand inchangé)", async () => {
  resetGlobalMockState({ isOperator: false, role: "owner" });
  const { container, root, inputs } = await renderAndGetInputs();
  for (const input of inputs) assert.equal(input.disabled, false);
  root.unmount();
  container.remove();
});

// ====================================================================
// 8. Comportement marchand par ailleurs inchangé : les valeurs
// affichées proviennent bien du serveur (jamais d'état fabriqué côté
// client), et une sauvegarde par un utilisateur autorisé (owner)
// atteint bien la RPC avec l'identifiant de règle attendu -- preuve
// que ce lot n'a modifié AUCUNE logique de chargement/sauvegarde,
// seulement le booléen canEdit.
// ====================================================================

test("8. Comportement marchand par ailleurs inchangé -- valeurs serveur affichées, sauvegarde owner atteint bien la RPC avec les bons paramètres", async () => {
  resetGlobalMockState({ isOperator: false, role: "owner" });
  window.history.pushState({}, "", `/dashboard/delivery-pricing?r=${TARGET_ID}`);
  const { container, root } = render(DeliveryPricingPage);
  await waitFor(() => container.textContent!.includes("Livraison standard"));
  // La valeur serveur (4.5) doit apparaître dans un champ, jamais une
  // valeur fabriquée côté client.
  const feeInput = [...container.querySelectorAll("input")].find(
    (el) => (el as HTMLInputElement).value === "4.5"
  ) as HTMLInputElement | undefined;
  assert.ok(feeInput, "le champ fixed_fee doit refléter la valeur serveur (4.5), jamais une valeur cliente fabriquée");

  const saveButtons = [...container.querySelectorAll("button")].filter((b) => /enregistrer|save/i.test(b.textContent ?? ""));
  assert.ok(saveButtons.length > 0, "le bouton Enregistrer doit être présent pour un owner (canEdit=true)");
  saveButtons[0].dispatchEvent(new window.Event("click", { bubbles: true }));
  await waitFor(() => (globalThis as any).__mockUpdateCalls.length > 0);
  const call = (globalThis as any).__mockUpdateCalls[0];
  assert.equal(call.ruleId, "rule-target-1", "la sauvegarde doit cibler exactement la règle affichée, jamais un identifiant fabriqué");
  root.unmount();
  container.remove();
});
