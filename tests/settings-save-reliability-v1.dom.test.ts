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
// SETTINGS SAVE RELIABILITY v1.1 (remédiation du contre-audit
// indépendant sur la PR #128, pièce jointe "TO: BOULEZ / CLAUDE,
// STATUS: REMEDIATION REQUIRED -- DO NOT AUDIT YET, PR: #128", branche
// feature/settings-save-reliability-v1, rebasée sur main
// 73ca103fdb2045693abebc7738994b4e33fa803f).
//
// v1 (SETTINGS-SAVE-RELIABILITY-V1-ORDER-01, PR #128 initiale) avait
// seulement réordonné les RPC mutantes (légal/fiscal en PREMIER) en
// gardant "soumettre INCONDITIONNELLEMENT toutes les sections à
// chaque clic". Le contre-audit a REJETÉ la prétention "atomicity
// preserved, only call order changed" comme INCORRECTE
// (SETTINGS-SAVE-RELIABILITY-V1-PARTIAL-SAVE-01) : un échec sur une
// section SANS RAPPORT (ex. couleurs) après que légal/fiscal ait
// pourtant réussi produisait un message d'échec global AMBIGU, qui ne
// disait jamais que légal/fiscal avait été persisté.
//
// v1.1 sépare explicitement QUELLES sections sont réellement
// modifiées ("dirty", dérivé par comparaison snapshot/état courant --
// voir generalSnapshotRef/legalSnapshotRef et les comparateurs
// `*GroupDirty` en tête de app/dashboard/settings/page.tsx) de
// QUELLES sections sont soumises : SEULES les sections dirty sont
// candidates à une mutation, chacune tentée INDÉPENDAMMENT (jamais de
// transaction inventée entre RPC sans rapport), et l'issue est
// rapportée SANS AMBIGUÏTÉ (succès global / échec total direct / état
// MIXTE explicitement préfixé par stPartialSaveError).
//
// Couvre les tests S1-S10 mandatés par la remédiation (S11 --
// comparaison d'identité de l'échec en full-suite, base/candidat
// FRAIS contre main COURANT -- est, comme pour
// tests/cgv-publication-boundary-v1.dom.test.ts (W2-T-09/W2-T-10) et
// comme pour la version v1 de CE MÊME fichier, un contrôle de
// PROCESSUS vérifié HORS de ce fichier, au moment de l'assemblage du
// paquet de preuves, jamais à l'intérieur d'un test unitaire).
//
// Patron EXACTEMENT repris de tests/cgv-publication-boundary-v1.dom.test.ts
// (JSDOM + esbuild, `makeMockPlugin`, `flush`/`waitFor`, modules
// mockés EN BLOC pour tout import effectuant un appel réseau réel,
// modules PURS laissés réels -- @/lib/dashboard-nav,
// @/lib/restaurant-context-guard, @/lib/merchant-legal-tax-labels,
// @/lib/types, @/lib/whatsapp, @/lib/color-contrast, @/lib/maps-url,
// @/lib/social-links, @/lib/customer-contact, @/lib/tracking/status(-text),
// @/lib/i18n).
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

// SETTINGS SAVE RELIABILITY v1.1 -- instrumentation générique par
// "kind" de mutation (call-log + deferred + failure), même patron que
// MOCK_LEGAL_CGV's mutationCall() dans
// tests/cgv-publication-boundary-v1.dom.test.ts, étendu à toutes les
// RPC mutantes de submit() (11 sections + le texte de suivi) PLUS un
// journal d'ORDRE D'APPEL partagé (__callOrder) -- indispensable pour
// prouver, section par section, qu'une section NON dirty n'est JAMAIS
// appelée (le coeur du contrat v1.1), et que les sections dirty sont
// chacune tentées indépendamment dans l'ordre fixe du code.
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
  // SETTINGS SAVE RELIABILITY v1.2 (C3) -- capture la VALEUR exacte
  // soumise, pas seulement le restaurantId (comme __receiptCallLog
  // le fait déjà pour le légal/fiscal) : nécessaire pour prouver que
  // le DEUXIÈME Save envoie bien la saisie la plus récente (Y),
  // jamais la valeur périmée (X) déjà soumise par le premier Save.
  (globalThis).__mapsUrlCallLog.push({ restaurantId, mapsUrl });
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
 *  page n'en expose aucun pour ses champs légaux/fiscaux). Fonctionne
 *  pour les champs légaux/fiscaux (label suivi DIRECTEMENT de
 *  l'input/textarea), mais PAS pour ColorField (voir
 *  colorFieldByLabel ci-dessous, structure DOM différente). */
function fieldByLabel(container: HTMLElement, labelText: string): HTMLInputElement | HTMLTextAreaElement {
  const labels = Array.from(container.querySelectorAll("label"));
  const label = labels.find((l) => (l.textContent ?? "").trim() === labelText.trim());
  assert.ok(label, `expected a <label> with text "${labelText}"`);
  const field = label!.nextElementSibling as HTMLInputElement | HTMLTextAreaElement | null;
  assert.ok(field, `expected an input/textarea immediately after label "${labelText}"`);
  return field;
}

/** SETTINGS SAVE RELIABILITY v1.1 (nouveau helper) -- ColorField
 *  (app/dashboard/settings/page.tsx) rend <label>, puis
 *  optionnellement un <p> d'aide, puis un <div> englobant DEUX
 *  <input> (un sélecteur de couleur type="color", puis le champ texte
 *  "#RRGGBB" réel) -- fieldByLabel (frère DOM direct) ne s'applique
 *  donc pas ici. On remonte au wrapper <div className="mt-3"> de
 *  ColorField puis on sélectionne l'input texte (celui qui n'est PAS
 *  type="color"). Utilisé pour prouver, S3/S4/S7, qu'une section
 *  "colors" dirty indépendamment du légal/fiscal déclenche (ou non)
 *  updateRestaurantColors. */
function colorFieldByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll("label"));
  const label = labels.find((l) => (l.textContent ?? "").trim() === labelText.trim());
  assert.ok(label, `expected a <label> with text "${labelText}"`);
  const wrapper = label!.closest("div.mt-3") as HTMLElement | null;
  assert.ok(wrapper, `expected the ColorField wrapper <div> for label "${labelText}"`);
  const textInput = wrapper!.querySelector('input:not([type="color"])') as HTMLInputElement | null;
  assert.ok(textInput, `expected the color text input for label "${labelText}"`);
  return textInput!;
}

/** SETTINGS SAVE RELIABILITY v1.1 (nouveau helper) -- le champ
 *  maps_url (section V70-02, toujours rendue indépendamment de
 *  isOperatorOnlyMode) n'a pas de <label> propre, seulement un <h3>
 *  de section. On remonte à la <section> ancêtre du <h3> correspondant
 *  puis on prend son premier <input>. Utilisé en S7 pour prouver
 *  qu'une SECONDE section (mapsUrl, distincte de colors) autorisée en
 *  mode opérateur seul est elle aussi appelée quand (et seulement
 *  quand) elle est dirty. */
function fieldInSectionByHeading(container: HTMLElement, headingText: string): HTMLInputElement {
  const headings = Array.from(container.querySelectorAll("h3"));
  const heading = headings.find((h) => (h.textContent ?? "").trim() === headingText.trim());
  assert.ok(heading, `expected an <h3> with text "${headingText}"`);
  const section = heading!.closest("section") as HTMLElement | null;
  assert.ok(section, `expected a <section> ancestor for heading "${headingText}"`);
  const input = section!.querySelector("input") as HTMLInputElement | null;
  assert.ok(input, `expected an <input> inside the section for heading "${headingText}"`);
  return input!;
}

/** Soumet le formulaire en déclenchant directement l'évènement natif
 *  "submit" sur le <form> -- même technique, déjà établie dans ce
 *  dépôt, que tests/ux-audit-lot1-login-accessibility.dom.test.ts.
 *  Utilisée pour TOUS les tests SAUF S9 (double-save), qui doit au
 *  contraire prouver que le bouton RÉELLEMENT désactivé empêche la
 *  re-soumission (voir S9 ci-dessous, qui utilise `.click()` sur le
 *  bouton lui-même). */
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

/** SETTINGS SAVE RELIABILITY v1.2 (K-series, nouveau helper) -- le
 *  champ numéro WhatsApp n'a pas de <label> propre (seul le <h3> de
 *  section et la case "activé" en ont un) : dans la section
 *  stWhatsappTitle, le PREMIER <input> est la case à cocher
 *  d'activation (type="checkbox", data-settings-whatsapp-enabled),
 *  le SECOND (rendu seulement quand whatsappEnabled est vrai -- le
 *  cas par défaut de settingsRow()) est le champ texte du numéro
 *  lui-même. fieldInSectionByHeading (qui prend toujours le PREMIER
 *  <input>) ne convient donc pas ici.
 */
function whatsappNumberField(container: HTMLElement): HTMLInputElement {
  const headings = Array.from(container.querySelectorAll("h3"));
  const heading = headings.find((h) => (h.textContent ?? "").trim() === t("stWhatsappTitle").trim());
  assert.ok(heading, `expected an <h3> with text "${t("stWhatsappTitle")}"`);
  const section = heading!.closest("section") as HTMLElement | null;
  assert.ok(section, "expected a <section> ancestor for the WhatsApp heading");
  const inputs = section!.querySelectorAll("input");
  assert.ok(inputs.length >= 2, "expected the enabled checkbox AND the number text field (whatsappEnabled must be true)");
  return inputs[1] as HTMLInputElement;
}

/** SETTINGS SAVE RELIABILITY v1.2 (K3/K5, nouveau helper) -- les
 *  textarea de texte de suivi ont un id stable
 *  `tracking-status-text-${status}` (voir app/dashboard/settings/page.tsx) --
 *  plus simple et plus robuste que de recalculer la clé i18n du
 *  libellé (statusLabelKey) juste pour retrouver le <label>. */
function trackingTextField(container: HTMLElement, status: string): HTMLTextAreaElement {
  const field = container.querySelector(`#tracking-status-text-${status}`) as HTMLTextAreaElement | null;
  assert.ok(field, `expected a tracking-status-text textarea for status "${status}"`);
  return field!;
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

/** Tous les kinds SAUF "receipt" -- utilisé abondamment pour prouver
 *  qu'une édition légale/fiscale SEULE ne déclenche AUCUNE mutation
 *  non liée (le coeur du contrat v1.1, Blocker 1). */
const NON_RECEIPT_KINDS = ALL_KINDS.filter((k) => k !== "receipt");

function assertZeroCalls(kinds: readonly string[], context: string) {
  for (const kind of kinds) {
    assert.deepEqual(
      (globalThis as any).__mutationCallLog[kind],
      [],
      `${context}: ${kind} must never be called`
    );
  }
}

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
  // SETTINGS SAVE RELIABILITY v1.2 (C3) -- voir le commentaire sur
  // updateRestaurantMapsUrl ci-dessus.
  (globalThis as any).__mapsUrlCallLog = [];
}

function setupSingleRestaurant(id = "resto-a", marker = "A") {
  resetCommonFixtures();
  (globalThis as any).__mappings = [mappingRow(id, `Restaurant ${marker}`, "owner")];
  (globalThis as any).__settingsFallback[id] = settingsRow({ display_name: `Resto ${marker}` });
  (globalThis as any).__receiptFallback[id] = receiptRow(marker);
}

// ====================================================================
// Tests S1-S10 (S11 -- comparaison d'identité full-suite -- est un
// contrôle de PROCESSUS effectué HORS de ce fichier).
// ====================================================================

test("S1 — legal-only edit reaches updateReceiptSettings exactly once, with the correct (never stale) restaurantId, after a restaurant switch, and triggers ZERO unrelated mutating RPCs", async () => {
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
  await waitFor(() => hasText(container, t("stSaved")));

  const calls = (globalThis as any).__receiptCallLog as Array<{ restaurantId: string; input: Record<string, unknown> }>;
  assert.equal(calls.length, 1, "updateReceiptSettings doit être appelée EXACTEMENT une fois");
  assert.equal(calls[0].restaurantId, "resto-b", "jamais une valeur de restaurant périmée (A) -- doit être B, le restaurant courant");
  assert.equal(calls[0].input.footerText, "Nouveau pied de ticket B");

  // SETTINGS SAVE RELIABILITY v1.1 -- le coeur du contrat (Blocker 1) :
  // une édition légale/fiscale SEULE ne doit JAMAIS appeler une
  // section sans rapport, qu'elle soit owner/manager (contact bundle)
  // ou commune (couleurs/maps/identité/bg/réseaux sociaux/langues).
  assertZeroCalls(NON_RECEIPT_KINDS, "S1 (legal-only)");
  assert.deepEqual((globalThis as any).__callOrder, ["receipt"], "aucune autre RPC mutante ne doit avoir été tentée");

  assert.ok(hasText(container, t("stSaved")), "l'état de succès doit être affiché");

  root.unmount();
  container.remove();
});

test("S2 — tax-rate-only edit reaches updateReceiptSettings once, with the new numeric rate, no silent no-op, and triggers ZERO unrelated mutating RPCs", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  const taxRateField = fieldByLabel(container, t("stLegalDefaultTaxRate")) as HTMLInputElement;
  assert.equal(taxRateField.value, "20", "doit partir de la valeur chargée (receiptRow default_tax_rate: 20)");
  setFieldValue(taxRateField, "15.5");

  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  const calls = (globalThis as any).__receiptCallLog as Array<{ restaurantId: string; input: Record<string, unknown> }>;
  assert.equal(calls.length, 1, "updateReceiptSettings doit être appelée EXACTEMENT une fois -- jamais un no-op silencieux");
  assert.equal(calls[0].input.defaultTaxRate, 15.5, "le nouveau taux doit être transmis, jamais l'ancien");

  assertZeroCalls(NON_RECEIPT_KINDS, "S2 (tax-rate-only)");
  assert.deepEqual((globalThis as any).__callOrder, ["receipt"]);

  root.unmount();
  container.remove();
});

test("S3 — colors-only edit reaches updateRestaurantColors exactly once and triggers ZERO calls to updateReceiptSettings (inverse of S1/S2: the new explicit dirty-state contract, mandated correction of the old v1 S3)", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  const primaryColorField = colorFieldByLabel(container, t("stPrimaryColor"));
  assert.equal(primaryColorField.value, "#111111", "doit partir de la valeur chargée (settingsRow primary_color)");
  setFieldValue(primaryColorField, "#a1b2c3");

  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__mutationCallLog.colors.length, 1, "updateRestaurantColors doit être appelée EXACTEMENT une fois");
  assert.equal(
    (globalThis as any).__receiptCallLog.length,
    0,
    "updateReceiptSettings ne doit JAMAIS être appelée -- rien dans le légal/fiscal n'a changé"
  );
  assertZeroCalls(
    ALL_KINDS.filter((k) => k !== "colors"),
    "S3 (colors-only)"
  );
  assert.deepEqual((globalThis as any).__callOrder, ["colors"]);

  assert.ok(hasText(container, t("stSaved")), "succès affiché -- la seule section dirty (colors) a réussi");

  root.unmount();
  container.remove();
});

test("S4 (CRITIQUE) — legal+colors both dirty: each is attempted independently, and a colors failure after a legal success is reported as an EXPLICIT mixed/partial outcome, never a global failure that would hide the legal success, and never a bare global success either", async () => {
  setupSingleRestaurant();
  (globalThis as any).__mutationFailure.colors["resto-a"] = new Error(
    'duplicate key value violates unique constraint "some_pkey" (SQLSTATE 23505)'
  );

  const { container, root } = render();
  await waitSettled(container);

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Pied de ticket mixte");
  const primaryColorField = colorFieldByLabel(container, t("stPrimaryColor"));
  setFieldValue(primaryColorField, "#a1b2c3");

  submitForm(container);
  await waitFor(() => hasText(container, t("stColorsSaveError")));

  // Les DEUX sections dirty doivent avoir été TENTÉES -- légal/fiscal
  // réussit (ordre fixe du code : légal est toujours tenté en
  // premier), couleurs échoue ensuite.
  assert.equal((globalThis as any).__receiptCallLog.length, 1, "updateReceiptSettings doit avoir réussi (section dirty, tentée, et qui réussit)");
  assert.equal((globalThis as any).__mutationCallLog.colors.length, 1, "updateRestaurantColors doit avoir été tentée (section dirty) et avoir échoué");
  const order = (globalThis as any).__callOrder as string[];
  assert.deepEqual(order, ["receipt", "colors"], "seules les DEUX sections dirty sont candidates -- aucune autre RPC, dans aucun ordre");

  // Aucune section NON dirty ne doit jamais être tentée.
  assertZeroCalls(
    ALL_KINDS.filter((k) => k !== "receipt" && k !== "colors"),
    "S4 (legal+colors mixed)"
  );

  // L'issue doit être EXPLICITEMENT mixte : le préfixe
  // stPartialSaveError ET le message spécifique à colors, JAMAIS un
  // message d'échec générique qui masquerait la réussite du
  // légal/fiscal, et JAMAIS l'indicateur de succès global (qui, lui,
  // masquerait l'échec réel de colors).
  assert.ok(hasText(container, t("stPartialSaveError")), "le préfixe explicite d'état MIXTE doit être affiché");
  assert.ok(hasText(container, t("stColorsSaveError")), "le message spécifique à la section colors doit être affiché");
  assert.ok(!hasText(container, "constraint"), "aucun fragment SQL/PostgREST brut ne doit jamais atteindre le marchand");
  assert.ok(!hasText(container, "23505"), "aucun code SQLSTATE brut ne doit jamais atteindre le marchand");
  assert.ok(!hasText(container, t("stSaved")), "l'indicateur de succès GLOBAL ne doit JAMAIS être affiché quand une section dirty a échoué");

  root.unmount();
  container.remove();
});

const S5_CASES: Array<{ label: string; mutate: (container: HTMLElement) => void; errorKey: string }> = [
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

for (const { label, mutate, errorKey } of S5_CASES) {
  test(`S5 (${label}) — legal validation still blocks: ZERO mutating RPCs of any kind, clear validation error shown`, async () => {
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

test("S6 (CRITIQUE) — provenance guard preserved: legalProfileReady=false (échec de lecture) => ZÉRO appel RPC mutant, updateReceiptSettings non appelée, stLegalNotReady visible", async () => {
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
  assertZeroCalls(ALL_KINDS, "S6 (provenance guard)");
  assert.deepEqual((globalThis as any).__callOrder, [], "aucune mutation, dans aucun ordre, ne doit avoir été tentée");
  assert.ok(hasText(container, t("stLegalNotReady")), "stLegalNotReady doit être visible");

  root.unmount();
  container.remove();
});

test("S7 — operator-only mode: role policy AND dirty-gating both hold together -- a dirty legal edit plus two dirty operator-allowed sections (colors, mapsUrl) all reach their RPC, an UNCHANGED operator-allowed section (identity/bgColor/social/languages) is never called, and the owner/manager-only contact bundle is never called", async () => {
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

  // Trois sections rendues dirty : légal (footer), colors (couleur
  // primaire) et mapsUrl -- toutes trois autorisées en mode opérateur
  // seul (V70-02/F-01 Super Admin).
  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Pied opérateur");
  const primaryColorField = colorFieldByLabel(container, t("stPrimaryColor"));
  setFieldValue(primaryColorField, "#a1b2c3");
  const mapsUrlField = fieldInSectionByHeading(container, t("stMapsTitle"));
  setFieldValue(mapsUrlField, "https://maps.app.goo.gl/XYZ789");

  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  const calls = (globalThis as any).__receiptCallLog as Array<{ restaurantId: string; input: Record<string, unknown> }>;
  assert.equal(calls.length, 1, "updateReceiptSettings doit être appelée (section dirty)");
  assert.equal(calls[0].restaurantId, "resto-a");
  assert.equal(calls[0].input.footerText, "Pied opérateur");

  assert.equal((globalThis as any).__mutationCallLog.colors.length, 1, "colors est dirty et autorisée -- doit être appelée");
  assert.equal((globalThis as any).__mutationCallLog.mapsUrl.length, 1, "mapsUrl est dirty et autorisée -- doit être appelée");

  // Politique de rôle INCHANGÉE : les sections réservées owner/manager
  // (contact public/WhatsApp, réglages restaurant génériques, textes
  // de suivi) ne doivent JAMAIS être appelées en mode opérateur seul,
  // dirty ou non (contactDirty est forcé à false par
  // `!isOperatorOnlyMode` dans submit()).
  assert.deepEqual((globalThis as any).__mutationCallLog.publicContact, [], "publicContact est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.whatsapp, [], "whatsapp est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.whatsappEnabled, [], "whatsappEnabled est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.restaurantSettings, [], "restaurantSettings (adresse/horaires/langue) est owner/manager uniquement");
  assert.deepEqual((globalThis as any).__mutationCallLog.trackingText, [], "les textes de suivi sont owner/manager uniquement");

  // SETTINGS SAVE RELIABILITY v1.1 -- la preuve du dirty-gating :
  // identity/bgColor/social/languages restent AUTORISÉES pour un
  // opérateur (comportement préexistant, non touché), mais comme
  // AUCUN de leurs champs n'a été modifié ici, elles ne doivent PAS
  // être appelées -- contrairement au comportement v1 (soumission
  // inconditionnelle de toutes les sections à chaque clic).
  assert.deepEqual((globalThis as any).__mutationCallLog.identity, [], "identity est autorisée mais NON dirty ici -- ne doit pas être appelée");
  assert.deepEqual((globalThis as any).__mutationCallLog.bgColor, [], "bgColor est autorisée mais NON dirty ici -- ne doit pas être appelée");
  assert.deepEqual((globalThis as any).__mutationCallLog.social, [], "social est autorisée mais NON dirty ici -- ne doit pas être appelée");
  assert.deepEqual((globalThis as any).__mutationCallLog.languages, [], "languages est autorisée mais NON dirty ici -- ne doit pas être appelée");

  assert.ok(hasText(container, t("stSaved")), "toutes les sections dirty ont réussi -- succès affiché");

  root.unmount();
  container.remove();
});

test("S8 — exact payload preservation: updateReceiptSettings receives ALL current fields correctly, no field dropped/stale/unintended-normalized, when only one field changes, and no unrelated section is ever re-saved", async () => {
  setupSingleRestaurant("resto-a", "A");
  const { container, root } = render();
  await waitSettled(container);

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Nouveau texte de pied de ticket");

  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

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

  assertZeroCalls(NON_RECEIPT_KINDS, "S8 (exact payload, legal-only)");

  root.unmount();
  container.remove();
});

test("S9 — double-save / saving state: a second rapid click on the (now genuinely disabled) Save button never creates a duplicate updateReceiptSettings call", async () => {
  setupSingleRestaurant();
  const deferred = makeDeferred<void>();
  (globalThis as any).__mutationDeferred.receipt.set("resto-a", deferred);

  const { container, root } = render();
  await waitSettled(container);

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Pied en double-clic");

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

test("S10 (CRITIQUE) — unchanged form submitted triggers ZERO mutating RPCs of any kind: proves the snapshot-diff dirty-state mechanism itself (generalSnapshotRef/legalSnapshotRef) accurately reflects the loaded state, and a click on Save with nothing edited is never mistaken for an edit", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  // Aucun champ modifié -- soumission du formulaire TEL QUE chargé.
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assertZeroCalls(ALL_KINDS, "S10 (unchanged form)");
  assert.deepEqual((globalThis as any).__callOrder, [], "AUCUNE RPC mutante, de quelque section que ce soit, ne doit être tentée quand rien n'a changé");

  // Un formulaire inchangé n'est PAS une erreur -- failedKeys reste
  // vide (aucune section tentée, donc aucune ne peut échouer), donc
  // l'issue "succès" (soit toutes réussissent, soit aucune n'est
  // dirty) s'applique bien, jamais confondue avec un échec.
  assert.ok(hasText(container, t("stSaved")), "succès affiché -- formulaire inchangé n'est jamais un échec");

  root.unmount();
  container.remove();
});

// ====================================================================
// SETTINGS SAVE RELIABILITY v1.2 (remédiation du DEUXIÈME contre-audit
// indépendant sur la PR #128, pièce jointe "TO: BOULEZ / CLAUDE,
// STATUS: INDEPENDENT AUDIT FAIL -- NARROW REMEDIATION REQUIRED, PR:
// #128"). v1.1 (ci-dessus, S1-S10) a correctement séparé QUELLES
// sections sont dirty de QUELLES sections sont soumises, mais n'avait
// PROUVÉ ni (Blocker 1) qu'une sauvegarde laissée en vol après une
// bascule de restaurant ne peut jamais corrompre l'instantané/l'UI
// d'un NOUVEAU restaurant, ni qu'une saisie plus récente survit à une
// sauvegarde tardive, ni (Blocker 2) que le lot "contact" (5 RPC sous
// un seul try/catch) rapporte fidèlement une persistance PARTIELLE.
//
// C1-C6 couvrent Blocker 1 (lib/restaurant-context-guard.ts réutilisé
// par submit() -- `token.isCurrent()` après CHAQUE await, AVANT toute
// écriture de snapshot/état/compteur/issue). K1-K5 couvrent Blocker 2
// (le lot contact est désormais QUATRE sous-écritures indépendantes :
// publicContact, whatsapp [numéro+activation, UN SEUL sous-groupe],
// restaurantSettings, trackingText).
// ====================================================================

test("C1 — switch A -> B while a legal save(A) is in flight: late A completion cannot alter B's legal snapshot/UI, and B's own edit remains correctly dirty (still sent on B's own next Save)", async () => {
  resetCommonFixtures();
  (globalThis as any).__mappings = [mappingRow("resto-a", "Restaurant A", "owner"), mappingRow("resto-b", "Restaurant B", "owner")];
  (globalThis as any).__settingsFallback["resto-a"] = settingsRow({ display_name: "Resto A" });
  (globalThis as any).__settingsFallback["resto-b"] = settingsRow({ display_name: "Resto B" });
  (globalThis as any).__receiptFallback["resto-a"] = receiptRow("A");
  (globalThis as any).__receiptFallback["resto-b"] = receiptRow("B");

  const { container, root } = render();
  await waitSettled(container);

  // A : édite le légal/fiscal, puis Save -- la RPC est différée (reste
  // EN VOL tant que `deferredA` n'est pas résolu).
  const deferredA = makeDeferred<void>();
  (globalThis as any).__mutationDeferred.receipt.set("resto-a", deferredA);
  setFieldValue(fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement, "Pied A en vol");
  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length === 1);
  assert.equal((globalThis as any).__receiptCallLog[0].restaurantId, "resto-a");

  // Bascule vers B PENDANT que le save de A est toujours en vol --
  // invalide immédiatement le jeton de A (guard.enterContext, appelé
  // synchroniquement par handleSelectRestaurant).
  switchTo(container, "resto-b");
  await waitSettled(container);

  // B édite également son propre champ légal/fiscal -- dirty pour B.
  const footerB = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  assert.equal(footerB.value, "Pied de ticket B", "B doit afficher SES PROPRES données chargées, jamais celles de A");
  setFieldValue(footerB, "Pied B pendant que A finit en retard");

  // La complétion TARDIVE de A arrive maintenant -- DOIT être
  // silencieusement abandonnée (token.isCurrent() === false) : ni
  // écriture dans legalSnapshotRef (qui appartient maintenant à B), ni
  // setSaved(true)/setUiLang affiché alors que B est affiché avec un
  // enregistrement non sauvegardé.
  deferredA.resolve(undefined);
  await flush(50);

  assert.ok(
    !hasText(container, t("stSaved")),
    "la réussite TARDIVE du save de A ne doit JAMAIS être présentée comme un succès alors que B est affiché avec un edit non sauvegardé"
  );
  assert.equal((globalThis as any).__receiptCallLog.length, 1, "la résolution tardive de A ne doit déclencher AUCUN nouvel appel RPC");
  assert.equal(footerB.value, "Pied B pendant que A finit en retard", "l'édition de B ne doit jamais être écrasée par la complétion tardive de A");

  // B peut maintenant enregistrer normalement -- la preuve directe que
  // son édition est restée CORRECTEMENT dirty (pas faussement marquée
  // propre par la complétion périmée de A) : la RPC légale est
  // réellement appelée, pour B, avec SA valeur.
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__receiptCallLog.length, 2, "le save de B doit avoir déclenché un DEUXIÈME appel réel");
  assert.equal((globalThis as any).__receiptCallLog[1].restaurantId, "resto-b");
  assert.equal((globalThis as any).__receiptCallLog[1].input.footerText, "Pied B pendant que A finit en retard");
  assert.deepEqual((globalThis as any).__callOrder, ["receipt", "receipt"], "aucune section sans rapport ne doit jamais avoir été appelée");

  root.unmount();
  container.remove();
});

test("C2 — switch A -> B while a general-settings save(A) is in flight (colors): late A completion cannot corrupt B's general snapshot -- B's own UNCHANGED colors are never falsely re-saved", async () => {
  resetCommonFixtures();
  (globalThis as any).__mappings = [mappingRow("resto-a", "Restaurant A", "owner"), mappingRow("resto-b", "Restaurant B", "owner")];
  (globalThis as any).__settingsFallback["resto-a"] = settingsRow({ display_name: "Resto A" });
  (globalThis as any).__settingsFallback["resto-b"] = settingsRow({
    display_name: "Resto B",
    primary_color: "#444444",
    secondary_color: "#555555",
    accent_color: "#666666",
  });
  (globalThis as any).__receiptFallback["resto-a"] = receiptRow("A");
  (globalThis as any).__receiptFallback["resto-b"] = receiptRow("B");

  const { container, root } = render();
  await waitSettled(container);

  const deferredColorsA = makeDeferred<void>();
  (globalThis as any).__mutationDeferred.colors.set("resto-a", deferredColorsA);
  setFieldValue(colorFieldByLabel(container, t("stPrimaryColor")), "#aaaaaa");
  submitForm(container);
  await waitFor(() => (globalThis as any).__mutationCallLog.colors.length === 1);

  switchTo(container, "resto-b");
  await waitSettled(container);
  assert.equal(colorFieldByLabel(container, t("stPrimaryColor")).value, "#444444", "B doit afficher SES propres couleurs chargées");

  const callOrderBeforeLateResolve = [...(globalThis as any).__callOrder];
  deferredColorsA.resolve(undefined);
  await flush(50);

  assert.ok(!hasText(container, t("stSaved")), "la complétion tardive de A ne doit jamais être présentée comme un succès pendant que B est affiché");
  assert.deepEqual((globalThis as any).__callOrder, callOrderBeforeLateResolve, "la résolution tardive ne doit déclencher AUCUN nouvel appel");

  // B n'a JAMAIS touché ses couleurs -- si la complétion tardive de A
  // avait corrompu generalSnapshotRef (désormais celui de B) avec les
  // couleurs de A, un Save de B SANS AUCUNE édition deviendrait
  // faussement "dirty" sur colors et déclencherait une réécriture non
  // voulue.
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__mutationCallLog.colors.length, 1, "colors ne doit JAMAIS être rappelée pour B -- ses propres couleurs, non éditées, doivent rester reconnues comme propres");
  assertZeroCalls(
    ALL_KINDS.filter((k) => k !== "colors"),
    "C2 (unrelated sections must stay untouched throughout)"
  );

  root.unmount();
  container.remove();
});

test("C3 — Maps URL: submit X, type Y while the RPC is in flight, resolve X => UI still shows Y => snapshot represents the persisted X => the second Save sends Y", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  const mapsField = fieldInSectionByHeading(container, t("stMapsTitle"));
  const X = "https://maps.app.goo.gl/XVALUE1";
  const Y = "https://maps.app.goo.gl/YVALUE2";
  setFieldValue(mapsField, X);

  const deferredMaps = makeDeferred<void>();
  (globalThis as any).__mutationDeferred.mapsUrl.set("resto-a", deferredMaps);
  submitForm(container);
  await waitFor(() => (globalThis as any).__mutationCallLog.mapsUrl.length === 1);

  // L'utilisateur retape le champ PENDANT que X est encore en vol.
  setFieldValue(mapsField, Y);

  deferredMaps.resolve(undefined);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal(mapsField.value, Y, "DO NOT call setMapsUrl(X) unconditionally after the await -- l'UI doit rester Y, jamais revenir à X");
  assert.equal((globalThis as any).__mapsUrlCallLog.length, 1);
  assert.equal((globalThis as any).__mapsUrlCallLog[0].mapsUrl, X, "le premier appel doit bien avoir soumis X (la valeur au moment du clic)");

  // Le snapshot représente X (persisté) ; l'UI montre Y (non
  // persisté) -- donc Y doit rester dirty, et le DEUXIÈME Save doit
  // transmettre Y.
  submitForm(container);
  await waitFor(() => (globalThis as any).__mutationCallLog.mapsUrl.length === 2);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__mapsUrlCallLog.length, 2);
  assert.equal((globalThis as any).__mapsUrlCallLog[1].mapsUrl, Y, "le second Save doit envoyer Y, la saisie la plus récente, jamais X à nouveau");

  root.unmount();
  container.remove();
});

test("C4 — Legal field: submit X, type Y while the receipt RPC is in flight, resolve X => UI still shows Y (legal never writes back) => the second Save sends Y", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Pied X");

  const deferredReceipt = makeDeferred<void>();
  (globalThis as any).__mutationDeferred.receipt.set("resto-a", deferredReceipt);
  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length === 1);

  setFieldValue(footerField, "Pied Y");

  deferredReceipt.resolve(undefined);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal(footerField.value, "Pied Y", "le champ légal n'est jamais réécrit par submit() -- l'édition la plus récente reste affichée");
  assert.equal((globalThis as any).__receiptCallLog[0].input.footerText, "Pied X", "le premier appel doit avoir transmis X");

  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length === 2);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__receiptCallLog[1].input.footerText, "Pied Y", "le second Save doit transmettre Y -- la preuve que le snapshot a bien avancé à X, laissant Y dirty");

  root.unmount();
  container.remove();
});

test("C5 — successful save followed by an immediate second Save with no further edit => ZERO duplicate write", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  setFieldValue(fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement, "Pied unique");
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));
  assert.equal((globalThis as any).__receiptCallLog.length, 1);

  // Deuxième Save IMMÉDIAT, sans la moindre édition entre les deux.
  submitForm(container);
  await flush(50);

  assert.equal((globalThis as any).__receiptCallLog.length, 1, "aucune seconde écriture ne doit jamais être déclenchée par un second Save sans édition");
  assert.deepEqual((globalThis as any).__callOrder, ["receipt"], "aucune RPC mutante, de quelque section que ce soit, n'a dû être tentée lors du second Save");
  assert.ok(hasText(container, t("stSaved")), "le second Save, bien que n'ayant rien à faire, reste un SUCCÈS -- jamais confondu avec un échec");

  root.unmount();
  container.remove();
});

test("C6 — successful save followed by a NEW edit => the new edit remains dirty and is saved", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  const footerField = fieldByLabel(container, t("stLegalFooterText")) as HTMLTextAreaElement;
  setFieldValue(footerField, "Pied X");
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));
  assert.equal((globalThis as any).__receiptCallLog.length, 1);
  assert.equal((globalThis as any).__receiptCallLog[0].input.footerText, "Pied X");

  setFieldValue(footerField, "Pied Z (nouvelle édition après succès)");
  submitForm(container);
  await waitFor(() => (globalThis as any).__receiptCallLog.length === 2);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__receiptCallLog[1].input.footerText, "Pied Z (nouvelle édition après succès)");

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------------
// K1-K5 -- Blocker 2 : le lot contact (publicContact, whatsapp
// [numéro+activation], restaurantSettings, trackingText) est
// désormais QUATRE sous-écritures indépendantes.
// --------------------------------------------------------------------

test("K1 — public contact succeeds, WhatsApp fails => partial-save indication, public-contact snapshot updated, WhatsApp remains dirty, retry does NOT rewrite public contact", async () => {
  setupSingleRestaurant();
  (globalThis as any).__mutationFailure.whatsapp["resto-a"] = new Error('duplicate key value violates unique constraint "some_pkey" (SQLSTATE 23505)');

  const { container, root } = render();
  await waitSettled(container);

  setFieldValue(fieldByLabel(container, t("stPublicPhoneLabel")) as HTMLInputElement, "+33611111111");
  setFieldValue(whatsappNumberField(container), "+33622222222");

  submitForm(container);
  await waitFor(() => hasText(container, t("stPartialSaveError")));

  assert.ok(hasText(container, t("stContactSaveError")), "le message spécifique au contact doit être affiché");
  assert.ok(!hasText(container, t("stSaved")), "jamais l'indicateur de succès global quand une sous-écriture a échoué");
  assert.equal((globalThis as any).__mutationCallLog.publicContact.length, 1, "publicContact doit avoir réussi (tentée une fois)");
  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 1, "whatsapp doit avoir été tentée et avoir échoué");
  assert.equal((globalThis as any).__mutationCallLog.whatsappEnabled.length, 0, "whatsappEnabled ne doit jamais être atteinte si l'appel numéro échoue avant elle (même sous-groupe)");

  // Retry : la défaillance WhatsApp est levée, aucune autre édition.
  delete (globalThis as any).__mutationFailure.whatsapp["resto-a"];
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__mutationCallLog.publicContact.length, 1, "le contact public ne doit JAMAIS être réécrit par le retry -- son snapshot avait déjà avancé");
  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 2, "WhatsApp, resté dirty, doit avoir été retenté");
  assert.equal((globalThis as any).__mutationCallLog.whatsappEnabled.length, 1, "cette fois le sous-groupe WhatsApp va jusqu'au bout");

  root.unmount();
  container.remove();
});

test("K2 — WhatsApp succeeds, restaurant settings fails => persisted WhatsApp stays clean (never rewritten on retry), restaurant settings remains dirty", async () => {
  setupSingleRestaurant();
  (globalThis as any).__mutationFailure.restaurantSettings["resto-a"] = new Error("transport failure");

  const { container, root } = render();
  await waitSettled(container);

  setFieldValue(whatsappNumberField(container), "+33633333333");
  setFieldValue(fieldByLabel(container, t("stAddress")) as HTMLInputElement, "12 avenue Retry");

  submitForm(container);
  await waitFor(() => hasText(container, t("stPartialSaveError")));

  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 1, "whatsapp doit avoir réussi");
  assert.equal((globalThis as any).__mutationCallLog.whatsappEnabled.length, 1, "whatsappEnabled doit avoir réussi (même sous-groupe, jusqu'au bout)");
  assert.equal((globalThis as any).__mutationCallLog.restaurantSettings.length, 1, "restaurantSettings doit avoir été tentée et avoir échoué");

  delete (globalThis as any).__mutationFailure.restaurantSettings["resto-a"];
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 1, "WhatsApp, déjà propre, ne doit JAMAIS être réécrite par le retry");
  assert.equal((globalThis as any).__mutationCallLog.whatsappEnabled.length, 1, "idem pour whatsappEnabled");
  assert.equal((globalThis as any).__mutationCallLog.restaurantSettings.length, 2, "restaurantSettings, resté dirty, doit avoir été retenté et avoir réussi");

  root.unmount();
  container.remove();
});

test("K3 — tracking text fails after earlier contact writes succeed => partial-save indication, retry only attempts tracking text", async () => {
  setupSingleRestaurant();
  (globalThis as any).__mutationFailure.trackingText["resto-a"] = new Error("transport failure");

  const { container, root } = render();
  await waitSettled(container);

  setFieldValue(fieldByLabel(container, t("stPublicPhoneLabel")) as HTMLInputElement, "+33611111111");
  setFieldValue(whatsappNumberField(container), "+33622222222");
  setFieldValue(fieldByLabel(container, t("stAddress")) as HTMLInputElement, "12 avenue Retry");
  setFieldValue(trackingTextField(container, "accepted"), "Votre commande est acceptée !");

  submitForm(container);
  await waitFor(() => hasText(container, t("stPartialSaveError")));

  assert.equal((globalThis as any).__mutationCallLog.publicContact.length, 1);
  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 1);
  assert.equal((globalThis as any).__mutationCallLog.whatsappEnabled.length, 1);
  assert.equal((globalThis as any).__mutationCallLog.restaurantSettings.length, 1);
  assert.equal((globalThis as any).__mutationCallLog.trackingText.length, 1, "trackingText doit avoir été tentée et avoir échoué");

  delete (globalThis as any).__mutationFailure.trackingText["resto-a"];
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__mutationCallLog.publicContact.length, 1, "déjà propre -- jamais réécrit par le retry");
  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 1, "déjà propre -- jamais réécrit par le retry");
  assert.equal((globalThis as any).__mutationCallLog.whatsappEnabled.length, 1, "déjà propre -- jamais réécrit par le retry");
  assert.equal((globalThis as any).__mutationCallLog.restaurantSettings.length, 1, "déjà propre -- jamais réécrit par le retry");
  assert.equal((globalThis as any).__mutationCallLog.trackingText.length, 2, "seule trackingText, restée dirty, doit avoir été retentée");

  root.unmount();
  container.remove();
});

test("K4 — all contact sub-writes succeed => whole contact section clean afterward, second Save causes ZERO contact writes", async () => {
  setupSingleRestaurant();
  const { container, root } = render();
  await waitSettled(container);

  setFieldValue(fieldByLabel(container, t("stPublicPhoneLabel")) as HTMLInputElement, "+33611111111");
  setFieldValue(whatsappNumberField(container), "+33622222222");
  setFieldValue(fieldByLabel(container, t("stAddress")) as HTMLInputElement, "12 avenue Retry");
  setFieldValue(trackingTextField(container, "accepted"), "Votre commande est acceptée !");

  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  for (const kind of ["publicContact", "whatsapp", "whatsappEnabled", "restaurantSettings", "trackingText"] as const) {
    assert.equal((globalThis as any).__mutationCallLog[kind].length, 1, `${kind} doit avoir été appelée exactement une fois`);
  }

  submitForm(container);
  await flush(50);

  for (const kind of ["publicContact", "whatsapp", "whatsappEnabled", "restaurantSettings", "trackingText"] as const) {
    assert.equal((globalThis as any).__mutationCallLog[kind].length, 1, `${kind} ne doit JAMAIS être rappelée par un second Save sans édition`);
  }
  assert.ok(hasText(container, t("stSaved")), "le second Save doit rester un succès");

  root.unmount();
  container.remove();
});

test("K5 — first contact sub-write (public contact) fails => later contact sub-writes are STILL attempted (continue, never stop), and the reported outcome stays truthful", async () => {
  setupSingleRestaurant();
  (globalThis as any).__mutationFailure.publicContact["resto-a"] = new Error("transport failure");

  const { container, root } = render();
  await waitSettled(container);

  setFieldValue(fieldByLabel(container, t("stPublicPhoneLabel")) as HTMLInputElement, "+33611111111");
  setFieldValue(whatsappNumberField(container), "+33622222222");
  setFieldValue(fieldByLabel(container, t("stAddress")) as HTMLInputElement, "12 avenue Retry");
  setFieldValue(trackingTextField(container, "accepted"), "Votre commande est acceptée !");

  submitForm(container);
  await waitFor(() => hasText(container, t("stPartialSaveError")));

  // Les TROIS sous-écritures SUIVANTES doivent avoir été tentées quand
  // même -- jamais interrompues par l'échec de la première (K5 :
  // comportement "continue", explicitement choisi et testé ici).
  assert.equal((globalThis as any).__mutationCallLog.publicContact.length, 1, "publicContact doit avoir été tentée et avoir échoué");
  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 1, "whatsapp doit avoir été tentée MALGRÉ l'échec de publicContact");
  assert.equal((globalThis as any).__mutationCallLog.whatsappEnabled.length, 1);
  assert.equal((globalThis as any).__mutationCallLog.restaurantSettings.length, 1, "restaurantSettings doit avoir été tentée MALGRÉ l'échec de publicContact");
  assert.equal((globalThis as any).__mutationCallLog.trackingText.length, 1, "trackingText doit avoir été tentée MALGRÉ l'échec de publicContact");
  assert.deepEqual(
    (globalThis as any).__callOrder,
    ["publicContact", "whatsapp", "whatsappEnabled", "restaurantSettings", "trackingText"],
    "l'ordre fixe du code doit être respecté, et les 4 sous-écritures doivent TOUTES être tentées"
  );
  assert.ok(hasText(container, t("stContactSaveError")), "le rapport doit rester honnête : le message de contact doit être affiché");
  assert.ok(!hasText(container, t("stSaved")), "jamais un succès global alors qu'une sous-écriture a échoué");

  delete (globalThis as any).__mutationFailure.publicContact["resto-a"];
  submitForm(container);
  await waitFor(() => hasText(container, t("stSaved")));

  assert.equal((globalThis as any).__mutationCallLog.publicContact.length, 2, "seule publicContact, restée dirty, doit avoir été retentée");
  assert.equal((globalThis as any).__mutationCallLog.whatsapp.length, 1, "déjà propre -- jamais réécrite par le retry");
  assert.equal((globalThis as any).__mutationCallLog.restaurantSettings.length, 1, "déjà propre -- jamais réécrite par le retry");
  assert.equal((globalThis as any).__mutationCallLog.trackingText.length, 1, "déjà propre -- jamais réécrite par le retry");

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
  delete (globalThis as any).__mapsUrlCallLog;
});
