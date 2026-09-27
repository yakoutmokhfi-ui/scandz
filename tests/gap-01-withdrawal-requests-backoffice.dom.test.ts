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
// GAP-01 — rendu RÉEL de app/dashboard/withdrawal-requests/page.tsx
// (esbuild + jsdom, même patron que tests/online-withdrawal-catalogue-
// v1-dom.test.ts). Seuls les services (auth/dashboard/establishments)
// et le client @/lib/supabase sont mockés -- l'écran, son état et son
// rendu conditionnel sont les VRAIS (DashboardNav, resolveRestaurantContext,
// useRestaurantContextGuard réels, non mockés).
//
// Ce test prouve le canal backoffice EXIGÉ par la CIO DECISION —
// GAP-01 ACKNOWLEDGEMENT RECIPIENTS ("Do not make email the only
// merchant notification channel") : la demande de rétractation
// apparaît, avec référence de commande, identité client, produits/
// quantités et statut d'accusé de réception -- SANS dépendre du tout
// de l'envoi de l'e-mail lui-même (que ce test ne déclenche jamais).
//
// L'isolation RLS (marchand ne voit que SES demandes, anon ne voit
// rien) est prouvée séparément, au niveau SQL réel, par
// supabase/tests/gap-01-ack-transport-v1-check.sh section [9] -- ce
// test-ci prouve uniquement le rendu ÉCRAN d'un jeu de lignes déjà
// filtré, jamais la garantie de sécurité elle-même.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/withdrawal-requests",
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

const RESTO_ID = "resto-le-gap-un";

(globalThis as any).__withdrawalRequestRows = [] as unknown[];

const MOCK_NAV = `
const _router = { replace: () => {}, push: () => {} };
export function useRouter() { return _router; }
export function usePathname() { return "/dashboard/withdrawal-requests"; }
export function useSearchParams() { return new URLSearchParams("r=${RESTO_ID}"); }
`;
const MOCK_AUTH = `
export async function getUser() { return { id: "u1" }; }
export async function signOut() {}
`;
const MOCK_DASHBOARD = `
export async function getMerchantRestaurants() {
  return [{ restaurant_id: "${RESTO_ID}", name: "Le Gap Un", role: "owner" }];
}
`;
const MOCK_ESTABLISHMENTS = `
export async function getEstablishmentSummary() { return { name: "Le Gap Un" }; }
export async function isScanymOperator() { return false; }
`;
// Simule uniquement la forme PostgREST utilisée par la page :
// .from("withdrawal_requests").select(...).eq(...).order(...).limit(...)
// -- renvoie {data, error} depuis globalThis.__withdrawalRequestRows,
// jamais un accès réseau réel.
const MOCK_SUPABASE = `
function builder() {
  const b = {
    select() { return b; },
    eq() { return b; },
    order() { return b; },
    limit() {
      return Promise.resolve({ data: (globalThis).__withdrawalRequestRows, error: null });
    },
  };
  return b;
}
export const supabase = {
  from(table) {
    if (table === "withdrawal_requests") return builder();
    return builder();
  },
};
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/supabase": MOCK_SUPABASE,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-gap01-mocks",
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
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "ts" }));
  },
};

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as WithdrawalRequestsPage } from "@/app/dashboard/withdrawal-requests/page.tsx";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-wr-"));
const tmpFile = path.join(tmpDir, "WithdrawalRequestsPage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { WithdrawalRequestsPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("écran backoffice : affiche référence de commande, client, produits/quantités et statut d'accusé (sent)", async () => {
  (globalThis as any).__withdrawalRequestRows = [
    {
      id: "wr-1",
      status: "recorded",
      requested_at: "2026-09-27T10:15:00Z",
      acknowledgement_status: "sent",
      acknowledgement_cc: "contact@le-gap-un.example",
      declaration_snapshot: {
        order_number: 42,
        customer_first_name: "Jean",
        customer_last_name: "Dupont",
        acknowledgement_address: "jean.dupont@example.com",
        lines: [{ item_name: "Plateau réutilisable", option_name: null, quantity: 2 }],
      },
    },
  ];

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(WithdrawalRequestsPage));
  await flush(20);
  await flush(20);

  const html = container.innerHTML;
  assert.match(html, /42/, "référence de commande visible");
  assert.match(html, /Jean/);
  assert.match(html, /Dupont/);
  assert.match(html, /Plateau réutilisable/);
  assert.match(html, /Accusé envoyé/, "statut d'accusé de réception lisible en clair");
  assert.match(html, /contact@le-gap-un\.example/, "copie marchand (CC) visible");

  root.unmount();
});

test("écran backoffice : sans e-mail (canal indisponible), la demande reste visible avec un statut honnête -- le backoffice n'est jamais silencieux sur l'e-mail", async () => {
  (globalThis as any).__withdrawalRequestRows = [
    {
      id: "wr-2",
      status: "recorded",
      requested_at: "2026-09-27T11:00:00Z",
      acknowledgement_status: "unavailable_no_channel",
      acknowledgement_cc: null,
      declaration_snapshot: {
        order_number: 43,
        customer_first_name: "Awa",
        customer_last_name: "Traoré",
        acknowledgement_address: "awa@example.com",
        lines: [{ item_name: "Bocal en verre", option_name: null, quantity: 1 }],
      },
    },
  ];

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(WithdrawalRequestsPage));
  await flush(20);
  await flush(20);

  const html = container.innerHTML;
  assert.match(html, /43/);
  assert.match(html, /Awa/);
  assert.match(html, /Canal d.accusé indisponible/);

  root.unmount();
});

test("écran backoffice : aucune demande -- message explicite, jamais un écran vide silencieux", async () => {
  (globalThis as any).__withdrawalRequestRows = [];

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(WithdrawalRequestsPage));
  await flush(20);
  await flush(20);

  assert.match(container.innerHTML, /Aucune demande de rétractation reçue/);

  root.unmount();
});
