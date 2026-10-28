import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { settle } from "./dom-settle.ts";

/**
 * CSDJ-BO-1 — amorçage partagé des suites DOM de l'onglet
 * « Mise à disposition ».
 *
 * Monte la VRAIE page dans jsdom ; seuls les services sont doublés.
 * Les suites d'accessibilité et de mise en page mobile s'appuient
 * dessus pour ne pas recopier cinquante lignes d'amorçage -- et pour
 * que la page testée soit exactement la même dans les deux.
 *
 * Ce module vit sous tests/helpers/ : il n'est jamais collecté comme
 * suite (le glob du lanceur est tests/*.test.ts).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/availability?r=r1",
  pretendToBeVisual: true,
});
export const window = dom.window;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

export const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

// Le vrai useRouter() de Next rend un objet STABLE : un double qui en
// fabriquerait un à chaque rendu relancerait l'effet de montage.
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
export async function getRestaurantSettings() { return { staff_receipt_language: "fr" }; }
export async function getMerchantDeliveryFulfillmentPricing() { return (globalThis).__deliveryRules ?? []; }
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__isOperator === true; }
export async function getEstablishmentSummary() { return { name: "Contexte opérateur" }; }
`;

const MOCK_AVAILABILITY = `
export async function getMerchantFulfillmentSchedules() {
  if ((globalThis).__schedulesThrow) throw new Error((globalThis).__schedulesThrow);
  return (globalThis).__schedules;
}
export async function getMerchantFulfillmentSchedulesV12() { return (globalThis).__v12; }
// Lecture AUTORITAIRE (remédiation R1) : ces suites n'éprouvent pas la
// concurrence, donc le double rend __configuration -- null par
// défaut, ce qui est une réponse LÉGITIME du contrat (« portée sans
// configuration ») et laisse les jetons à null. (Aucun accent grave
// ici : ce texte vit DANS un gabarit littéral.)
export async function getFulfillmentConfiguration(id, modeCode, ruleId) {
  ((globalThis).__configurationReads ??= []).push({ id, modeCode, ruleId });
  const plan = (globalThis).__configuration;
  if (typeof plan === "function") return plan(id, modeCode, ruleId);
  return plan ?? null;
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
  ((globalThis).__saveCalls ??= []).push({ id, payload });
  const handler = (globalThis).__saveHandler;
  // Sans gestionnaire injecté, le double se comporte comme le service
  // réel aujourd'hui : il REFUSE, parce que le contrat d'écriture n'est
  // pas disponible.
  if (!handler) throw new AvailabilityWriteUnavailableError();
  return handler(id, payload);
}
export async function getCheckoutFulfillmentSchedulePreview(args) {
  (globalThis).__previewArgs = args;
  ((globalThis).__previewCalls ??= []).push(args);
  const byMode = (globalThis).__previewByMode;
  if (byMode && byMode[args.modeCode]) {
    const entry = byMode[args.modeCode];
    if (entry.defer) {
      return new Promise((resolve) => {
        (globalThis).__previewPending.push(() => resolve(entry.result));
      });
    }
    return entry.result;
  }
  return (globalThis).__previewResult;
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
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path],
      loader: "ts",
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-bo1-harness-"));
const tmpFile = path.join(tmpDir, "AvailabilityPage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const loaded = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });
export const AvailabilityPage = loaded.AvailabilityPage;

export const SCHEDULE_FIXED_SLOTS = {
  modeCode: "pickup",
  fulfillmentRuleId: null,
  timezone: "Europe/Paris",
  enabled: true,
  dateSelectionMode: "customer_selectable",
  slotSelectionMode: "fixed_slots",
  timeGranularityMinutes: null,
  leadTimeMinutes: 0,
  minLeadDays: 2,
  cutoffTime: "12:00:00",
  cutoffOffsetDays: 0,
  bookingHorizonDays: 14,
  windows: [],
  slots: [
    { weekday: 2, slotKey: "matin", startsAt: "09:00", endsAt: "12:00" },
    { weekday: 3, slotKey: "matin", startsAt: "09:00", endsAt: "12:00" },
  ],
  closures: [{ closedOn: "2026-12-25", label: "Noël" }],
};

/** Seconde portée (livraison, heure libre) : nécessaire pour tester un
 *  changement de PORTÉE à l'intérieur du même établissement. */
export const SCHEDULE_FREE_TIME = {
  ...SCHEDULE_FIXED_SLOTS,
  modeCode: "delivery",
  slotSelectionMode: "time_within_window",
  timeGranularityMinutes: 30,
  slots: [],
  windows: [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }],
};

export const V12_AVAILABLE = {
  status: "available",
  rows: [
    {
      modeCode: "pickup",
      fulfillmentRuleId: null,
      scheduleMethodVersion: "v1.2",
      holidayCalendarId: null,
      preparationOnHolidays: "open",
      availabilityOnHolidays: "open",
      capacityEnabled: true,
      capacityMaxOrders: 12,
      preparationWeekdays: [1, 2, 3, 4, 5],
      preparationClosures: [{ closedOn: "2026-10-14", label: "Entretien four" }],
    },
  ],
};

export function mount(options: {
  role?: string;
  isOperator?: boolean;
  schedules?: unknown[];
  v12?: unknown;
  schedulesThrow?: string | null;
  /** #170 : règles de livraison de l'établissement (lecture d'aide). */
  deliveryRules?: Array<{ ruleId: string; fulfillmentLabel: string }>;
  previewResult?: unknown;
  /** AUD-01 : aperçu scripté par mode de vente, éventuellement différé. */
  previewByMode?: Record<string, { result: unknown; defer?: boolean }>;
  /** e2e simulé : backend transactionnel injecté (issue #149). */
  saveHandler?:
    | ((id: string, payload: Record<string, unknown>) => unknown | Promise<unknown>)
    | null;
} = {}) {
  (globalThis as any).__mappings = [
    {
      restaurant_id: "r1",
      role: options.role ?? "owner",
      restaurants: { id: "r1", name: "Au lait cru", slug: "au-lait-cru" },
    },
  ];
  (globalThis as any).__isOperator = options.isOperator === true;
  (globalThis as any).__schedules = options.schedules ?? [SCHEDULE_FIXED_SLOTS];
  (globalThis as any).__v12 = options.v12 ?? { status: "absent" };
  (globalThis as any).__schedulesThrow = options.schedulesThrow ?? null;
  (globalThis as any).__deliveryRules = options.deliveryRules ?? [];
  (globalThis as any).__previewResult = options.previewResult ?? null;
  (globalThis as any).__previewByMode = options.previewByMode ?? null;
  (globalThis as any).__previewPending = [] as Array<() => void>;
  (globalThis as any).__saveCalls = [] as Array<{ id: string; payload: unknown }>;
  (globalThis as any).__saveHandler = options.saveHandler ?? null;
  (globalThis as any).__previewCalls = [] as Array<{ modeCode: string }>;

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

/**
 * Attente de QUIESCENCE, pas de durée (remédiation F-03) : voir
 * tests/helpers/dom-settle.ts. `ms` est accepté pour compatibilité et
 * ignoré.
 */
export const flush = settle;

export async function teardown() {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
}
