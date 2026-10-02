import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// SETTINGS SAVE RELIABILITY v1 (mandat "TO: CLAUDE DEVELOPER", branche
// feature/settings-save-reliability-v1, base main
// 0826f5f36d56876fe68cba3a091e6b279a095cb0).
//
// Couvre les tests S1-S8 mandatés (S9 -- comparaison d'identité de
// l'échec en full-suite, base/candidat frais -- est, comme pour
// tests/cgv-publication-boundary-v1.dom.test.ts (W2-T-09/W2-T-10), un
// contrôle de PROCESSUS vérifié HORS de ce fichier, au moment de
// l'assemblage du paquet de preuves, jamais à l'intérieur d'un test
// unitaire).
//
// Patron EXACTEMENT repris de tests/cgv-publication-boundary-v1.dom.test.ts
// (JSDOM + esbuild, `makeMockPlugin`, `flush`/`waitFor`, modules
// mockés EN BLOC pour tout import effectuant un appel réseau réel,
// modules PURS laissés réels -- @/lib/dashboard-nav,
// @/lib/restaurant-context-guard, @/lib/merchant-legal-tax-labels,
// @/lib/types, @/lib/whatsapp, @/lib/color-contrast, @/lib/maps-url,
// @/lib/social-links, @/lib/customer-contact, @/lib/tracking/status(-text),
// @/lib/i18n).
//
// Root cause couvert par ces tests (voir le commentaire
// SETTINGS-SAVE-RELIABILITY-V1-ORDER-01 dans
// app/dashboard/settings/page.tsx) : submit() ré-enregistre
// INCONDITIONNELLEMENT ~11 sections à chaque clic sur Enregistrer, et
// update_receipt_settings (légal/fiscal) était appelée EN DERNIER --
// l'échec de N'IMPORTE QUELLE section précédente, même sans aucun
// rapport avec ce que le marchand a modifié, empêchait silencieusement
// update_receipt_settings d'être jamais atteinte. Remédiation : ordre
// de MUTATION seul, update_receipt_settings est désormais la TOUTE
// PREMIÈRE RPC mutante, dans les deux modes (formulaire complet ET
// opérateur seul) -- aucune validation déplacée, aucune garde
// affaiblie.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/settings?r=resto-a",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).HTMLInputElement = window.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = window.HTMLTextAreaElement;
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
// Fixtures.
// --------------------------------------------------------------------

function mappingRow(id: string, name: string, role: "owner" | "manager" | "staff" = "owner") {
  return { restaurant_id: id, role, restaurants: { id, name, slug: id } };
}

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    staff_receipt_language: "fr",
    address: "1 rue Example",
    opening_hours: "9h-18h",
    currency: "DZD",
    whatsapp_number: "+33600000000",
    logo_url: null,
    cover_url: null,
    primary_color: "#111111",
    secondary_color: "#222222",
    accent_color: "#333333",
    maps_url: "",
    display_name: "Resto",
    intro_text: "",
    announcement_text: "",
    announcement_active: false,
    bg_color: "",
    instagram_url: "",
    tiktok_url: "",
    facebook_url: "",
    source_language: "fr",
    whatsapp_enabled: true,
    public_phone: "+33600000001",
    public_email: "contact@example.test",
    ...overrides,
  };
}

function receiptRow(marker: string, overrides: Record<string, unknown> = {}) {
  return {
    business_name: `Business ${marker}`,
    legal_name: `Legal ${marker}`,
    legal_address: `1 rue Legal ${marker}`,
    phone: `+3360000000${marker}`,
    email: `legal-${marker.toLowerCase()}@example.test`,
    tax_identifier: `TAXID-${marker}`,
    registration_number: `REG-${marker}`,
    tax_label: "TVA",
    default_tax_rate: 20,
    prices_include_tax: true,
    footer_text: `Pied de ticket ${marker}`,
    show_tax_summary: false,
    paper_width_mm: 80,
    restaurant_country: "FR",
    ...overrides,
  };
}

// --------------------------------------------------------------------
// Modules mockés en bloc -- uniquement ceux qui effectuent un appel
// réseau réel (Supabase/RPC) que ces tests exercent.
// --------------------------------------------------------------------

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/settings"; }
`;

const MOCK_AUTH = `
export async function getUser() { return { id: "staff-1" }; }
export async function signOut() {}
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__isOperator ?? false; }
export async function getEstablishmentSummary(id) { return { name: "Op " + id, id, slug: id, country: "FR", currency: "DZD" }; }
`;

const MOCK_ASSETS = `
export class AssetUploadError extends Error {}
export class AssetRemoveError extends Error {}
export class InvalidFileTypeError extends Error {}
export class FileTooLargeError extends Error {}
export async function addOrReplaceEstablishmentAsset() { throw new Error("SCANYM_TEST_NOT_EXERCISED"); }
export async function removeEstablishmentAsset() { throw new Error("SCANYM_TEST_NOT_EXERCISED"); }
export function validateEstablishmentAssetFile() { return { ok: true }; }
`;

// SETTINGS SAVE RELIABILITY v1 -- instrumentation générique par
// "kind" de mutation (call-log + deferred + failure), même patron que
// MOCK_LEGAL_CGV's mutationCall() dans
// tests/cgv-publication-boundary-v1.dom.test.ts, étendu à toutes les
// RPC mutantes de submit() (11 sections + le texte de suivi) PLUS un
// journal d'ORDRE D'APPEL partagé (__callOrder) -- indispensable pour
// S3 (prouver que le légal/fiscal est désormais appelé AVANT toute
// autre section, jamais après).
const MOCK_DASHBOARD = `
function mutationCall(kind, restaurantId, successValue) {
  (globalThis).__callOrder.push(kind);
  (globalThis).__mutationCallLog[kind].push(restaurantId);
  const deferred = (globalThis).__mutationDeferred[kind] && (globalThis).__mutationDeferred[kind].get(restaurantId);
  if (deferred) return deferred.promise;
  const failure = (globalThis).__mutationFailure[kind] && (globalThis).__mutationFailure[kind][restaurantId];
  if (failure) return Promise.reject(failure);
  return Promise.resolve(successValue);
}

export async function getMerchantRestaurants() { return (globalThis).__mappings; }

export async function getRestaurantSettings(restaurantId) {
  const fallback = (globalThis).__settingsFallback && (globalThis).__settingsFallback[restaurantId];
  if (fallback) return fallback;
  return {
    staff_receipt_language: "fr", address: null, opening_hours: null, currency: "DZD",
    whatsapp_number: "", logo_url: null, cover_url: null, primary_color: null,
    secondary_color: null, accent_color: null, maps_url: null, display_name: null,
    intro_text: null, announcement_text: null, announcement_active: false, bg_color: null,
    instagram_url: null, tiktok_url: null, facebook_url: null, source_language: "fr",
    whatsapp_enabled: true, public_phone: null, public_email: null,
  };
}

export async function getReceiptSettings(restaurantId) {
  (globalThis).__receiptLoadCallLog.push(restaurantId);
  const failure = (globalThis).__receiptLoadFailure && (globalThis).__receiptLoadFailure[restaurantId];
  if (failure) return Promise.reject(failure);
  const fallback = (globalThis).__receiptFallback && (globalThis).__receiptFallback[restaurantId];
  return fallback === undefined ? null : fallback;
}

export async function updateReceiptSettings(restaurantId, input) {
  (globalThis).__receiptCallLog.push({ restaurantId, input });
  return mutationCall("receipt", restaurantId, undefined);
}
export async function updateRestaurantPublicContact(restaurantId, publicPhone, publicEmail) {
  return mutationCall("publicContact", restaurantId, undefined);
}
export async function updateRestaurantWhatsapp(restaurantId, whatsappNumber) {
  return mutationCall("whatsapp", restaurantId, undefined);
}
export async function updateRestaurantWhatsappEnabled(restaurantId, enabled) {
  return mutationCall("whatsappEnabled", restaurantId, undefined);
}
export async function updateRestaurantSettings(restaurantId, staffLanguage, address, openingHours) {
  return mutationCall("restaurantSettings", restaurantId, undefined);
}
export async function updateRestaurantColors(restaurantId, primaryColor, secondaryColor, accentColor) {
  return mutationCall("colors", restaurantId, undefined);
}
export async function updateRestaurantMapsUrl(restaurantId, mapsUrl) {
  return mutationCall("mapsUrl", restaurantId, undefined);
}
export async function updateRestaurantIdentity(restaurantId, displayName, introText, announcementText, announcementActive) {
  return mutationCall("identity", restaurantId, undefined);
}
export async function updateRestaurantBgColor(restaurantId, bgColor) {
  return mutationCall("bgColor", restaurantId, undefined);
}
export async function updateRestaurantSocialLinks(restaurantId, instagramUrl, tiktokUrl, facebookUrl) {
  return mutationCall("social", restaurantId, undefined);
}
export async function updateRestaurantLanguages(restaurantId, languageCodes) {
  return mutationCall("languages", restaurantId, undefined);
}
export async function getSupportedLanguages() {
  return (globalThis).__supportedLanguages ?? [
    { code: "fr", label: "Français", dir: "ltr" },
    { code: "en", label: "English", dir: "ltr" },
  ];
}
export async function getRestaurantActiveLanguages(restaurantId) {
  const fallback = (globalThis).__activeLanguagesFallback && (globalThis).__activeLanguagesFallback[restaurantId];
  return fallback ?? [{ code: "fr", label: "Français", dir: "ltr", display_order: 0 }];
}
`;

const MOCK_TRACKING_STATUS_TEXT = `
export async function getMerchantTrackingStatusText(restaurantId) {
  const fallback = (globalThis).__statusTextFallback && (globalThis).__statusTextFallback[restaurantId];
  return fallback ?? {};
}
export async function setAllMerchantTrackingStatusText(restaurantId, bodies) {
  (globalThis).__callOrder.push("trackingText");
  (globalThis).__mutationCallLog.trackingText.push(restaurantId);
  const deferred = (globalThis).__mutationDeferred.trackingText && (globalThis).__mutationDeferred.trackingText.get(restaurantId);
  if (deferred) return deferred.promise;
  const failure = (globalThis).__mutationFailure.trackingText && (globalThis).__mutationFailure.trackingText[restaurantId];
  if (failure) return Promise.reject(failure);
  return Promise.resolve(undefined);
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/tracking-status-text": MOCK_TRACKING_STATUS_TEXT,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/establishment-assets": MOCK_ASSETS,
};

const entrySource = `
export { default as SettingsPage } from "@/app/dashboard/settings/page";
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
const domTmpFile = path.join(domTmpDir, "SettingsPage.mjs");
writeFileSync(domTmpFile, domCode);
const { SettingsPage, translate } = await import(pathToFileURL(domTmpFile).href);
rmSync(domTmpDir, { recursive: true, force: true });

function t(key: string): string {
  return translate("fr", key);
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(SettingsPage));
  return { container, root };
}

function switchTo(container: HTMLElement, restaurantId: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "the restaurant <select> switcher must be present in DashboardNav");
  select!.value = restaurantId;
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

/** Même technique que tests/ux-audit-lot1-login-accessibility.dom.test.ts
 *  (setValue "A") -- passe par le setter NATIF du prototype pour
 *  contourner le patch de React sur `value`, puis un évènement
 *  "input" natif pour que le onChange contrôlé de la page le voie. */
function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const isTextarea = el.tagName === "TEXTAREA";
  const proto = isTextarea ? (window as any).HTMLTextAreaElement.prototype : (window as any).HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** Localise un champ (input/textarea) par le texte EXACT de son
 *  <label>, qui lui est toujours un frère DOM immédiatement suivant
 *  (directement, ou à l'intérieur de la même <div> encapsulante) dans
 *  app/dashboard/settings/page.tsx -- jamais par data-testid (cette
 *  page n'en expose aucun pour ses champs légaux/fiscaux). */
function fieldByLabel(container: HTMLElement, labelText: string): HTMLInputElement | HTMLTextAreaElement {
  const labels = Array.from(container.querySelectorAll("label"));
  const label = labels.find((l) => (l.textContent ?? "").trim() === labelText.trim());
  assert.ok(label, `expected a <label> with text "${labelText}"`);
  const field = label!.nextElementSibling as HTMLInputElement | HTMLTextAreaElement | null;
  assert.ok(field, `expected an input/textarea immediately after label "${labelText}"`);
  return field;
}

/** Soumet le formulaire en déclenchant directement l'évènement natif
 *  "submit" sur le <form> -- même technique, déjà établie dans ce
 *  dépôt, que tests/ux-audit-lot1-login-accessibility.dom.test.ts.
 *  Utilisée pour TOUS les tests SAUF S8, qui doit au contraire prouver
 *  que le bouton RÉELLEMENT désactivé empêche la re-soumission (voir
 *  S8 ci-dessous, qui utilise `.click()` sur le bouton lui-même). */
function submitForm(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement | null;
  assert.ok(form, "expected a <form> to be rendered");
  form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector('form button[type="submit"]') as HTMLButtonElement | null;
  assert.ok(btn, "expected the submit (Save) button to be rendered");
  return btn!;
}

function hasText(container: HTMLElement, text: string): boolean {
  return (container.textContent ?? "").includes(text);
}

/** Même structure à deux phases que CGV W2's waitSettled : `container`
 *  reste VIDE un ou deux ticks après `root.render()` (le commit React
 *  18 est planifié, jamais synchrone), donc attendre UNIQUEMENT
 *  l'absence de `[data-context-loading]` serait trivialement vrai
 *  avant même le premier montage. La phase 1 attend un signal POSITIF
 *  (le <h2> du titre est monté) ; seule la phase 2 (absence de la
 *  porte de provenance générale, §5) signifie alors réellement "prêt". */
async function waitSettled(container: HTMLElement): Promise<void> {
  await waitFor(() => container.querySelector("h2") !== null);
  await waitFor(() => container.querySelector("[data-context-loading]") === null);
}

const ALL_KINDS = [
  "receipt",
  "publicContact",
  "whatsapp",
  "whatsappEnabled",
  "restaurantSettings",
  "colors",
  "mapsUrl",
  "identity",
  "bgColor",
  "social",
  "languages",
  "trackingText",
] as const;

function resetCommonFixtures() {
  (globalThis as any).__mappings = [];
  (globalThis as any).__isOperator = false;
  (globalThis as any).__settingsFallback = {};
  (globalThis as any).__receiptFallback = {};
  (globalThis as any).__receiptLoadFailure = {};
  (globalThis as any).__receiptLoadCallLog = [];
  (globalThis as any).__receiptCallLog = [];
  (globalThis as any).__statusTextFallback = {};
  (globalThis as any).__supportedLanguages = undefined;
  (globalThis as any).__activeLanguagesFallback = {};
  (globalThis as any).__callOrder = [];
  (globalThis as any).__mutationCallLog = Object.fromEntries(ALL_KINDS.map((k) => [k, [] as string[]]));
  (globalThis as any).__mutationDeferred = Object.fromEntries(ALL_KINDS.map((k) => [k, new Map()]));
  (globalThis as any).__mutationFailure = Object.fromEntries(ALL_KINDS.map((k) => [k, {} as Record<string, unknown>]));
}

function setupSingleRestaurant(id = "resto-a", marker = "A") {
  resetCommonFixtures();
  (globalThis as any).__mappings = [mappingRow(id, `Restaurant ${marker}`, "owner")];
  (globalThis as any).__settingsFallback[id] = settingsRow({ display_name: `Resto ${marker}` });
  (globalThis as any).__receiptFallback[id] = receiptRow(marker);
}

// ====================================================================
// Tests S1-S8.
// ====================================================================

test("S1 — legal-only edit reaches updateReceiptSettings exactly once, with the correct (never stale) restaurantId, after a restaurant switch", async () => {
  resetCommonFixtures();
  (globalThis as any).__mappings = [mappingRow("resto-a", "Restaurant A", "owner"), mappingRow("resto-b", "Restaurant B", "owner")];
  (globalThis as any).__settingsFallback["resto-a"] = settingsRow({ display_name: "Resto A" });
  (globalThis as any).__settingsFallback["resto-b"] = settingsRow({ display_name: "Resto B" });
  (globalThis as any).__receiptFallback["resto-a"] = receiptRow("A");
  (globalThis as any).__receiptFallback["resto-b"] = receiptRow("B");

  const { container, root } = render();
  await waitSettled(container);

  // Bascule explicite vers B avant d'enregistrer -- preuve que la RPC
  // reçoit bien le restaurant COURAMMENT affiché, jamais un restaurant
  // périmé (A).
  switchTo(container, "resto-b");
  await waitSettled(container);

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  assert.equal(footerField.value, "Pied de ticket B", "le champ doit afficher la valeur du restaurant COURAMMENT sélectionné (B)");
  setFieldValue(footerField, "Nouveau pied de ticket B");

  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length > 0);

  const calls = (globalThis as any).__receiptCallLog as Array<{ restaurantId: string; input: Record<string, unknown> }>;
  assert.equal(calls.length, 1, "updateReceiptSettings doit être appelée EXACTEMENT une fois");
  assert.equal(calls[0].restaurantId, "resto-b", "jamais une valeur de restaurant périmée (A) -- doit être B, le restaurant courant");
  assert.equal(calls[0].input.footerText, "Nouveau pied de ticket B");

  await waitFor(() => hasText(container, t("stSaved")));
  assert.ok(hasText(container, t("stSaved")), "l'état de succès doit être affiché");

  root.unmount();
  container.remove();
});

test("S2 — tax-rate edit reaches updateReceiptSettings once, with the new numeric rate, no silent no-op", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  const taxRateField = fieldByLabel(container, t("stLegalDefaultTaxRate")) as HTMLInputElement;
  assert.equal(taxRateField.value, "20", "doit partir de la valeur chargée (receiptRow default_tax_rate: 20)");
  setFieldValue(taxRateField, "15.5");

  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length > 0);

  const calls = (globalThis as any).__receiptCallLog as Array<{ restaurantId: string; input: Record<string, unknown> }>;
  assert.equal(calls.length, 1, "updateReceiptSettings doit être appelée EXACTEMENT une fois -- jamais un no-op silencieux");
  assert.equal(calls[0].input.defaultTaxRate, 15.5, "le nouveau taux doit être transmis, jamais l'ancien");

  root.unmount();
  container.remove();
});

test("S3 — a later (colors) mutation failure is never silent: under the NEW ordering, updateReceiptSettings succeeds FIRST, then a clear, section-specific error is shown for colors, and saved is never shown", async () => {
  setupSingleRestaurant();
  (globalThis as any).__mutationFailure.colors["resto-a"] = new Error(
    'duplicate key value violates unique constraint "some_pkey" (SQLSTATE 23505)'
  );

  const { container, root } = render();
  await waitSettled(container);

  submitForm(container);
  await waitFor(() => hasText(container, t("stColorsSaveError")));

  // La RPC légale/fiscale a RÉUSSI, et en PREMIER -- c'est exactement
  // le contrat explicite choisi par la remédiation (SETTINGS-SAVE-
  // RELIABILITY-V1-ORDER-01) : plus jamais bloquée par une section
  // sans rapport, même quand CETTE section échoue ensuite.
  assert.equal((globalThis as any).__receiptCallLog.length, 1, "updateReceiptSettings doit avoir réussi AVANT l'échec des couleurs");
  const order = (globalThis as any).__callOrder as string[];
  assert.ok(order.includes("receipt"), "receipt doit avoir été appelée");
  assert.ok(order.includes("colors"), "colors doit avoir été tentée");
  assert.ok(order.indexOf("receipt") < order.indexOf("colors"), "receipt doit être appelée AVANT colors, jamais après");

  // L'échec de colors doit rester NON AMBIGU : message dédié à CETTE
  // section, jamais le message brut du serveur.
  assert.ok(hasText(container, t("stColorsSaveError")), "un message clair, dédié à la section colors, doit être affiché");
  assert.ok(!hasText(container, "constraint"), "aucun fragment SQL/PostgREST brut ne doit jamais atteindre le marchand");
  assert.ok(!hasText(container, "23505"), "aucun code SQLSTATE brut ne doit jamais atteindre le marchand");

  // Le reste de la soumission (sections APRÈS colors dans le nouvel
  // ordre) ne doit jamais avoir été tenté -- même garantie d'atomicité
  // qu'avant la remédiation, seul l'ORDRE a changé.
  assert.deepEqual((globalThis as any).__mutationCallLog.mapsUrl, [], "mapsUrl ne doit jamais être tentée après l'échec de colors");
  assert.deepEqual((globalThis as any).__mutationCallLog.identity, [], "identity ne doit jamais être tentée après l'échec de colors");
  assert.deepEqual((globalThis as any).__mutationCallLog.languages, [], "languages ne doit jamais être tentée après l'échec de colors");

  assert.ok(!hasText(container, t("stSaved")), "l'indicateur de succès ne doit JAMAIS être affiché -- la soumission globale a échoué");

  root.unmount();
  container.remove();
});

const S4_CASES: Array<{ label: string; mutate: (container: HTMLElement) => void; errorKey: string }> = [
  {
    label: "invalid email",
    mutate: (c) => setFieldValue(fieldByLabel(c, t("stLegalEmail")), "not-an-email"),
    errorKey: "stLegalEmailInvalid",
  },
  {
    label: "invalid tax rate (>100)",
    mutate: (c) => setFieldValue(fieldByLabel(c, t("stLegalDefaultTaxRate")), "150"),
    errorKey: "stLegalTaxRateInvalid",
  },
  {
    label: "missing required tax label",
    mutate: (c) => setFieldValue(fieldByLabel(c, t("stLegalTaxLabel")), ""),
    errorKey: "stLegalTaxLabelRequired",
  },
];

for (const { label, mutate, errorKey } of S4_CASES) {
  test(`S4 (${label}) — legal validation still blocks: updateReceiptSettings NOT called, clear validation error shown`, async () => {
    setupSingleRestaurant();
    const { container, root } = render();
    await waitSettled(container);

    mutate(container);
    submitForm(container);
    await waitFor(() => hasText(container, t(errorKey)));

    assert.equal((globalThis as any).__receiptCallLog.length, 0, "updateReceiptSettings ne doit JAMAIS être appelée sur une donnée légale/fiscale invalide");
    assert.deepEqual((globalThis as any).__callOrder, [], "aucune RPC mutante, quelle qu'elle soit, ne doit être tentée -- la validation bloque AVANT setSaving(true)");
    assert.ok(hasText(container, t(errorKey)), `le message de validation "${errorKey}" doit être affiché`);

    root.unmount();
    container.remove();
  });
}

test("S5 (CRITIQUE) — provenance guard preserved: legalProfileReady=false (échec de lecture) => ZÉRO appel RPC mutant, updateReceiptSettings non appelée, stLegalNotReady visible", async () => {
  setupSingleRestaurant();
  (globalThis as any).__receiptLoadFailure["resto-a"] = new Error("transport failure");

  const { container, root } = render();
  await waitSettled(container);

  // Le formulaire général se rend normalement (getRestaurantSettings a
  // réussi) ; seule la section légale/fiscale est en échec -- le
  // bouton Enregistrer existe mais doit être désactivé par la garde.
  const btn = submitButton(container);
  assert.equal(btn.disabled, true, "le bouton doit déjà refléter la garde (legalProfileReady=false), avant même tout clic");

  // Défense en profondeur : même un évènement "submit" direct sur le
  // <form> (qui contourne l'attribut disabled du bouton) doit être
  // refusé PAR LE GESTIONNAIRE LUI-MÊME -- la garde est la TOUTE
  // PREMIÈRE instruction de submit() (MLTP-V11-DASHBOARD-GUARD-ORDER-01).
  submitForm(container);
  await flush(50);

  assert.equal((globalThis as any).__receiptCallLog.length, 0, "updateReceiptSettings ne doit jamais être appelée");
  for (const kind of ALL_KINDS) {
    assert.deepEqual((globalThis as any).__mutationCallLog[kind], [], `${kind} ne doit jamais être appelée -- ZÉRO RPC mutante de quelque nature que ce soit`);
  }
  assert.deepEqual((globalThis as any).__callOrder, [], "aucune mutation, dans aucun ordre, ne doit avoir été tentée");
  assert.ok(hasText(container, t("stLegalNotReady")), "stLegalNotReady doit être visible");

  root.unmount();
  container.remove();
});

test("S6 — operator-only mode: a valid legal/tax change still reaches updateReceiptSettings first, without requiring any merchant-only (owner/manager) mutation, and role policy is unchanged", async () => {
  resetCommonFixtures();
  (globalThis as any).__isOperator = true;
  // rôle réel "staff" (jamais owner/manager) -- canEditFull=false,
  // isOperatorOnlyMode=true, EXACTEMENT comme un opérateur Scanym sans
  // aucun rattachement (voir le commentaire V71-06 dans page.tsx).
  (globalThis as any).__mappings = [mappingRow("resto-a", "Restaurant A", "staff")];
  (globalThis as any).__settingsFallback["resto-a"] = settingsRow();
  (globalThis as any).__receiptFallback["resto-a"] = receiptRow("A");

  const { container, root } = render();
  await waitSettled(container);

  assert.ok(hasText(container, t("stOperatorOnlyMode")), "le bandeau 'mode opérateur seul' doit être affiché");

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Pied opérateur");

  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length > 0);

  const calls = (globalThis as any).__receiptCallLog as Array<{ restaurantId: string; input: Record<string, unknown> }>;
  assert.equal(calls.length, 1, "updateReceiptSettings doit être appelée");
  assert.equal(calls[0].restaurantId, "resto-a");
  assert.equal(calls[0].input.footerText, "Pied opérateur");

  // Politique de rôle INCHANGÉE : les sections réservées owner/manager
  // (contact public/WhatsApp, réglages restaurant génériques, textes
  // de suivi) ne doivent JAMAIS être appelées en mode opérateur seul.
  assert.deepEqual((globalThis as any).__mutationCallLog.publicContact, [], "publicContact est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.whatsapp, [], "whatsapp est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.whatsappEnabled, [], "whatsappEnabled est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.restaurantSettings, [], "restaurantSettings (adresse/horaires/langue) est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.trackingText, [], "les textes de suivi sont owner/manager uniquement");

  // En revanche, colors/mapsUrl/identity/bgColor/social/languages
  // restent accessibles à un opérateur (assert_restaurant_asset_role,
  // F-01 Super Admin) -- comportement PRÉEXISTANT, non touché par
  // cette remédiation, qui doit rester exactement identique.
  assert.equal((globalThis as any).__mutationCallLog.colors.length, 1, "colors reste accessible en mode opérateur seul");
  assert.equal((globalThis as any).__mutationCallLog.mapsUrl.length, 1, "mapsUrl reste accessible en mode opérateur seul");
  assert.equal((globalThis as any).__mutationCallLog.identity.length, 1, "identity reste accessible en mode opérateur seul");
  assert.equal((globalThis as any).__mutationCallLog.bgColor.length, 1, "bgColor reste accessible en mode opérateur seul");
  assert.equal((globalThis as any).__mutationCallLog.social.length, 1, "social reste accessible en mode opérateur seul");
  assert.equal((globalThis as any).__mutationCallLog.languages.length, 1, "languages reste accessible en mode opérateur seul");

  await waitFor(() => hasText(container, t("stSaved")));

  root.unmount();
  container.remove();
});

test("S7 — exact payload preservation: updateReceiptSettings receives ALL current fields correctly, no field dropped/stale/unintended-normalized, when only one field changes", async () => {
  setupSingleRestaurant("resto-a", "A");
  const { container, root } = render();
  await waitSettled(container);

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Nouveau texte de pied de ticket");

  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length > 0);

  const calls = (globalThis as any).__receiptCallLog as Array<{ restaurantId: string; input: Record<string, unknown> }>;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    businessName: "Business A",
    legalName: "Legal A",
    legalAddress: "1 rue Legal A",
    phone: "+3360000000A",
    email: "legal-a@example.test",
    taxIdentifier: "TAXID-A",
    registrationNumber: "REG-A",
    taxLabel: "TVA",
    defaultTaxRate: 20,
    pricesIncludeTax: true,
    footerText: "Nouveau texte de pied de ticket",
    showTaxSummary: false,
  }, "tous les champs chargés doivent être retransmis EXACTEMENT tels quels, à l'exception du seul champ modifié -- aucun champ perdu, périmé, ou normalisé de façon inattendue");

  root.unmount();
  container.remove();
});

test("S8 — double-save / saving state: a second rapid click on the (now genuinely disabled) Save button never creates a duplicate updateReceiptSettings call", async () => {
  setupSingleRestaurant();
  const deferred = makeDeferred<void>();
  (globalThis as any).__mutationDeferred.receipt.set("resto-a", deferred);

  const { container, root } = render();
  await waitSettled(container);

  const btn = submitButton(container);
  assert.equal(btn.disabled, false, "le bouton doit être activé avant le premier clic");

  // Premier clic RÉEL (méthode native .click(), jamais un évènement
  // "submit" envoyé directement sur le <form> -- c'est précisément le
  // bouton, désactivé par `saving`, qui est le mécanisme de protection
  // réel en Production : voir l'empirique jsdom confirmé pour ce
  // dépôt, cf. tests/ux-audit-lot1-login-accessibility.dom.test.ts et
  // la note de tests/cgv-publication-boundary-v1.dom.test.ts sur
  // `invokeOnClickDirectly`).
  btn.click();
  await waitFor(() => (globalThis as any).__receiptCallLog.length === 1);
  await waitFor(() => btn.disabled === true);

  // Deuxième clic RÉEL pendant que la première soumission est encore
  // en vol (receipt différée) -- le bouton est désormais réellement
  // désactivé, jsdom respecte cet état (confirmé empiriquement : un
  // `.click()` sur un élément `disabled` ne déclenche aucune action
  // d'activation, donc aucune soumission du formulaire).
  btn.click();
  await flush(30);

  assert.equal((globalThis as any).__receiptCallLog.length, 1, "aucun second appel à updateReceiptSettings ne doit avoir été créé par le second clic");

  deferred.resolve(undefined);
  await waitFor(() => hasText(container, t("stSaved")));

  // Après résolution, le bouton redevient actif -- mais le nombre
  // total d'appels reste strictement 1.
  assert.equal(btn.disabled, false, "le bouton doit redevenir actif une fois l'enregistrement terminé");
  assert.equal((globalThis as any).__receiptCallLog.length, 1, "toujours un seul appel au total, même après résolution");

  root.unmount();
  container.remove();
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
  delete (globalThis as any).HTMLInputElement;
  delete (globalThis as any).HTMLTextAreaElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mappings;
  delete (globalThis as any).__isOperator;
  delete (globalThis as any).__settingsFallback;
  delete (globalThis as any).__receiptFallback;
  delete (globalThis as any).__receiptLoadFailure;
  delete (globalThis as any).__receiptLoadCallLog;
  delete (globalThis as any).__receiptCallLog;
  delete (globalThis as any).__statusTextFallback;
  delete (globalThis as any).__supportedLanguages;
  delete (globalThis as any).__activeLanguagesFallback;
  delete (globalThis as any).__callOrder;
  delete (globalThis as any).__mutationCallLog;
  delete (globalThis as any).__mutationDeferred;
  delete (globalThis as any).__mutationFailure;
});
