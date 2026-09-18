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
// Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, required
// test items "tracking FR" / "tracking EN" / "tracking AR").
//
// Mounts the REAL app/track/[orderId]/page.tsx Server Component (same
// technique as tests/v123a-tracking-page-existing-session-fragment.
// dom.test.ts, copied and adapted here rather than duplicated logic:
// a real signed session token via lib/server/tracking-session.ts, a
// real supabase.rpc("get_order_tracking") interception at the lowest
// network boundary, next/headers|navigation|link mocked). This file
// adds language coverage across ?lang=fr/en/ar that v123a does not
// exercise -- proving the resolveLangFromParam fix (this lot) actually
// reaches the rendered page, not just the pure helper (already proven
// in isolation by tests/v162-...).
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_ID = "33333333-3333-4333-8333-333333333333";
// CUSTOMER TRACKING v3.1 : the session carries the tracking capability.
const CAP_ID = "44444444-4444-4444-8444-444444444444";
const SECRET = "34".repeat(32);
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v165-"));
const tmpFile = path.join(tmpDir, "TrackingPage.mjs");
writeFileSync(tmpFile, code);
const { TrackingPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const VALID_ROW = {
  bound_order_id: ORDER_ID,
  order_status: "preparing",
  service_mode: "table",
  order_number: 77,
  created_at: "2026-01-01T10:00:00Z",
  accepted_at: "2026-01-01T10:05:00Z",
  preparing_at: "2026-01-01T10:10:00Z",
  ready_at: null,
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
  // CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 (remédiation
  // CCTF-V1-TRACKING-FISCAL-SUMMARY-01) -- voir
  // tests/v166-tracking-final-fiscal-summary.dom.test.ts pour la
  // couverture DÉDIÉE (absent/présent, i18n complet des 3 champs) ;
  // présents ici aussi pour prouver que les items mandatés "tracking
  // FR/EN/AR" couvrent désormais la page RÉELLE dans son intégralité
  // post-v1.1, pas seulement le statut.
  order_total: 24.9,
  order_currency: "EUR",
  invoice_requested: true,
};

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderTrackingPage(lang?: string) {
  const element = await TrackingPage({
    params: Promise.resolve({ orderId: ORDER_ID }),
    searchParams: Promise.resolve(lang ? { lang } : {}),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  // Même discipline que tests/v123a-... : laisse les effets (dont
  // TrackingFragmentScrubber) se commettre avant toute assertion.
  await flush();
  return { container, root };
}

test("mandat « tracking FR » : sans ?lang= (repli par défaut), la page de suivi affiche le statut en français", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking_by_capability") return { data: [VALID_ROW], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderTrackingPage();

  assert.ok(container.textContent?.includes("En préparation"), "statut en français par défaut");
  assert.ok(container.textContent?.includes("77"), "numéro de commande réel affiché");
  // CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 -- items "tracking FR"
  // couvre désormais aussi le résumé fiscal, en français.
  assert.ok(container.textContent?.includes("Montant total"), "libellé de montant total en français");
  assert.ok(container.textContent?.includes("24,90"), "montant formaté (EUR) affiché");
  assert.ok(container.textContent?.includes("Facture demandée"), "indicateur de facture en français");

  root.unmount();
  container.remove();
});

test("mandat « tracking EN » : ?lang=en -- la page de suivi affiche le statut en anglais", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking_by_capability") return { data: [VALID_ROW], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderTrackingPage("en");

  assert.ok(container.textContent?.includes("Preparing"), "statut en anglais");
  assert.equal(container.textContent?.includes("En préparation"), false);
  // CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 -- item "tracking EN".
  assert.ok(container.textContent?.includes("Total amount"), "libellé de montant total en anglais");
  assert.ok(container.textContent?.includes("24,90"), "montant formaté affiché (Intl reste fr-FR, INCHANGÉ -- voir lib/whatsapp.ts::formatPrice)");
  assert.ok(container.textContent?.includes("Invoice requested"), "indicateur de facture en anglais");

  root.unmount();
  container.remove();
});

test("mandat « tracking AR » : ?lang=ar -- CORRECTIF de ce lot -- la page de suivi affiche RÉELLEMENT le statut en arabe (auparavant repliée silencieusement sur le français, voir resolveLang avant correctif)", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking_by_capability") return { data: [VALID_ROW], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderTrackingPage("ar");

  assert.ok(container.textContent?.includes("قيد التحضير"), "statut en arabe RÉELLEMENT rendu -- la preuve du correctif §5");
  assert.equal(container.textContent?.includes("En préparation"), false, "jamais un repli silencieux vers le français");
  assert.equal(container.textContent?.includes("Preparing"), false);
  // CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 -- item "tracking AR".
  assert.ok(container.textContent?.includes("المبلغ الإجمالي"), "libellé de montant total en arabe");
  assert.ok(container.textContent?.includes("تم طلب الفاتورة"), "indicateur de facture en arabe");

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
