import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.TRACKING_SESSION_SECRET ??=
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ====================================================================
// Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 — remédiation
// CCTF-V1-TRACKING-FISCAL-SUMMARY-01 (Cat Woman, audit indépendant,
// HIGH, release-blocking).
//
// Complément DÉDIÉ à tests/v165-tracking-final-page-languages.dom.
// test.ts (qui prouve désormais le rendu FR/EN/AR du résumé fiscal
// avec les DEUX champs présents) : ce fichier couvre spécifiquement
// les cas d'ABSENCE -- `order_total`/`order_currency` null (ne
// devrait structurellement jamais se produire, colonne `orders.total`
// NOT NULL, mais reste défensif -- voir lib/server/tracking-
// service.ts) et `invoice_requested` false -- sur la page RÉELLE, même
// technique de montage que v123a/v165 (RPC réellement interceptée à la
// frontière réseau, session de suivi réellement signée).
//
// Mandat items directement couverts ici : "authoritative historical
// total returned" (au niveau de la page, complète la preuve SQL du
// harnais et la preuve unitaire de tests/v122d) et "invoice-request
// false" (au niveau de la page).
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_ID = "55555555-5555-4555-8555-555555555555";
// CUSTOMER TRACKING v3.1 : la session porte la capacité de suivi.
const CAP_ID = "66666666-6666-4666-8666-666666666666";
const SECRET = "12".repeat(32);
const SESSION_TOKEN = createTrackingSessionToken(ORDER_ID, CAP_ID, SECRET);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: `http://localhost/track/${ORDER_ID}`,
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", {
  value: window.navigator,
  configurable: true,
});
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

(globalThis as any).__mockCookieStore = {
  [TRACKING_SESSION_COOKIE_NAME]: SESSION_TOKEN,
};

const MOCK_HEADERS = `
export async function cookies() {
  const store = (globalThis).__mockCookieStore || {};
  return {
    get(name) {
      return name in store ? { name, value: store[name] } : undefined;
    },
  };
}
`;

const MOCK_NAV = `
export function useRouter() {
  return { refresh: () => {}, replace: () => {}, push: () => {} };
}
`;

const MOCK_LINK = `
import { createElement } from "react";
export default function Link(props) {
  const { href, children, ...rest } = props;
  return createElement("a", { href, ...rest }, children);
}
`;

const mocks: Record<string, string> = {
  "next/headers": MOCK_HEADERS,
  "next/navigation": MOCK_NAV,
  "next/link": MOCK_LINK,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) {
        return { path: args.path, namespace: "mock" };
      }
      if (args.path === "server-only") {
        return { path: "server-only", namespace: "mock" };
      }
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        if (base.endsWith(path.join("lib", "supabase"))) {
          return { path: pathToFileURL(base + ".ts").href, external: true };
        }
        const candidate = ["", ".tsx", ".ts"]
          .map((ext) => base + ext)
          .find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path] ?? "export {};",
      loader: "ts",
    }));
  },
};

const entrySource = `
export { default as TrackingPage } from "@/app/track/[orderId]/page";
`;

const buildResult = await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  platform: "node",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v166-"));
const tmpFile = path.join(tmpDir, "TrackingPage.mjs");
writeFileSync(tmpFile, code);
const { TrackingPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const BASE_ROW = {
  bound_order_id: ORDER_ID,
  order_status: "new",
  service_mode: "pickup",
  order_number: 88,
  created_at: "2026-01-01T10:00:00Z",
  accepted_at: null,
  preparing_at: null,
  ready_at: null,
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
};

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderTrackingPage() {
  const element = await TrackingPage({
    params: Promise.resolve({ orderId: ORDER_ID }),
    searchParams: Promise.resolve({}),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await flush();
  return { container, root };
}

test("mandat « invoice-request false » (page réelle) : invoice_requested=false -- AUCUN indicateur de facture rendu, jamais un état « en cours » par défaut", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking_by_capability") {
      return {
        data: [{ ...BASE_ROW, order_total: 10, order_currency: "EUR", invoice_requested: false }],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderTrackingPage();

  assert.ok(container.textContent?.includes("Montant total"), "le montant reste affiché indépendamment de l'état facture");
  assert.equal(container.textContent?.includes("Facture demandée"), false, "aucun indicateur de facture si invoice_requested=false");

  root.unmount();
  container.remove();
});

test("mandat « authoritative historical total returned » (page réelle) : order_total/order_currency null (défensif -- ne devrait structurellement jamais se produire) -- AUCUNE ligne de montant rendue, jamais un montant inventé", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking_by_capability") {
      return {
        data: [{ ...BASE_ROW, order_total: null, order_currency: null, invoice_requested: false }],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderTrackingPage();

  assert.equal(container.textContent?.includes("Montant total"), false, "aucune ligne de montant si order_total est null -- jamais un 0 inventé");

  root.unmount();
  container.remove();
});

test("mandat « authoritative historical total returned » (page réelle) : order_total=0 -- la ligne EST rendue (0 est une valeur légitime, jamais confondue avec « absent », même convention que components/OrderConfirmation.tsx)", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking_by_capability") {
      return {
        data: [{ ...BASE_ROW, order_total: 0, order_currency: "EUR", invoice_requested: false }],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderTrackingPage();

  assert.ok(container.textContent?.includes("Montant total"), "0 est une valeur légitime -- la ligne doit être rendue");

  root.unmount();
  container.remove();
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") {
      h.unref();
    }
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
