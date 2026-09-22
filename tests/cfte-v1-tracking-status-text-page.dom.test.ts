import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.TRACKING_SESSION_SECRET =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

// ====================================================================
// CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — TEXTE EXPLICATIF sur la page
// de suivi RÉELLE (app/track/[orderId]/page.tsx), même harnais que
// tests/cclt-v1-tracking-page.dom.test.ts : RPC interceptées à la
// frontière réseau, session de suivi réellement signée.
//
// Ce que ce fichier prouve, dans un vrai DOM et jamais par lecture de
// source :
//   - un texte explicatif est affiché pour CHACUN des 7 statuts, SANS
//     aucune configuration commerçant ;
//   - une surcharge marchande remplace ce texte, et RIEN d'autre : le
//     statut affiché (badge) et la frise restent identiques ;
//   - une surcharge vide retombe sur le texte de base ;
//   - une surcharge portant un statut NON canonique (« en route »,
//     « livré ») est ignorée -- aucun 8e statut n'est affichable ;
//   - une réponse liée à une AUTRE commande est intégralement rejetée
//     (isolation tenant) ;
//   - une panne de lecture des surcharges ne dégrade jamais la page.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);
const { translate } = await import("../lib/i18n.ts");
const { statusExplanationKey } = await import("../lib/tracking/status-text.ts");
const { CANONICAL_ORDER_STATUSES, statusLabelKeyForServiceMode } = await import(
  "../lib/tracking/status.ts"
);

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "7f".repeat(32);
const SESSION_TOKEN = createTrackingSessionToken(ORDER_ID, CAP_ID, SECRET);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: `http://localhost/track/${ORDER_ID}`,
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

(globalThis as any).__mockCookieStore = { [TRACKING_SESSION_COOKIE_NAME]: SESSION_TOKEN };

const mocks: Record<string, string> = {
  "next/headers": `
export async function cookies() {
  const store = (globalThis).__mockCookieStore || {};
  return { get(name) { return name in store ? { name, value: store[name] } : undefined; } };
}`,
  "next/navigation": `
export function useRouter() { return { refresh: () => {}, replace: () => {}, push: () => {} }; }
export function notFound() { throw new Error("notFound"); }`,
  "next/link": `
import { createElement } from "react";
export default function Link(props) { const { href, children, ...rest } = props; return createElement("a", { href, ...rest }, children); }`,
};

const mockPlugin: esbuild.Plugin = {
  name: "cfte-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path === "server-only") return { path: "server-only", namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        if (base.endsWith(path.join("lib", "supabase"))) {
          return { path: pathToFileURL(base + ".ts").href, external: true };
        }
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
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

const built = await esbuild.build({
  stdin: {
    contents: `export { default as TrackingPage } from "@/app/track/[orderId]/page";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-cfte-track-"));
const tmpFile = path.join(tmpDir, "TrackingPage.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { TrackingPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// --------------------------------------------------------------------
// Harnais
// --------------------------------------------------------------------

function trackingRow(overrides: Record<string, unknown> = {}) {
  return {
    bound_order_id: ORDER_ID,
    order_status: "new",
    service_mode: "pickup",
    order_number: 42,
    created_at: "2026-09-22T08:00:00Z",
    accepted_at: null,
    preparing_at: null,
    ready_at: null,
    completed_at: null,
    rejected_at: null,
    cancelled_at: null,
    order_total: 31.5,
    order_currency: "EUR",
    invoice_requested: false,
    ...overrides,
  };
}

type StatusTextPlan =
  | Array<Record<string, unknown>>
  | "error"
  | "throw"
  | "unavailable";

function installRpc(
  t: any,
  plan: { tracking?: Record<string, unknown>; statusText?: StatusTextPlan }
) {
  const calls: string[] = [];
  t.mock.method(supabase, "rpc", async (name: string) => {
    calls.push(name);
    if (name === "get_order_tracking_by_capability") {
      return { data: [trackingRow(plan.tracking)], error: null };
    }
    if (name === "get_order_tracking_customer_context_by_capability") {
      return { data: [], error: null };
    }
    if (name === "get_order_tracking_status_text_by_capability") {
      const s = plan.statusText;
      if (s === "throw") throw new Error("network down");
      if (s === "error") return { data: null, error: { code: "42883", message: "absent" } };
      if (s === "unavailable" || s === undefined) return { data: [], error: null };
      return { data: s, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return calls;
}

function flush(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function renderPage(lang?: string) {
  const element = await TrackingPage({
    params: Promise.resolve({ orderId: ORDER_ID }),
    searchParams: Promise.resolve(lang ? { lang } : {}),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await flush();
  return { container, root };
}

const explanation = (c: Element) =>
  c.querySelector("[data-tracking-status-text]")?.textContent ?? null;
const explanationSource = (c: Element) =>
  c.querySelector("[data-tracking-status-text]")?.getAttribute("data-tracking-status-source") ??
  null;
const badge = (c: Element) => c.querySelector('[aria-live="polite"]')?.textContent ?? "";
const steps = (c: Element) =>
  [...c.querySelectorAll("ol li")].map((li) => li.textContent?.replace(/^[✓○]/, "").trim() ?? "");

function override(status: string, body: string | null) {
  return { bound_order_id: ORDER_ID, status, body };
}

// --------------------------------------------------------------------
// 1. Texte de base, sans AUCUNE configuration commerçant.
// --------------------------------------------------------------------

test("1. les 7 statuts affichent un texte explicatif de base, sans aucune configuration", async (t) => {
  for (const status of CANONICAL_ORDER_STATUSES) {
    installRpc(t, { tracking: { order_status: status } });
    const { container, root } = await renderPage();
    try {
      const expected = translate("fr", statusExplanationKey(status));
      assert.equal(explanation(container), expected, `statut ${status}`);
      assert.equal(explanationSource(container), "base");
      assert.notEqual(expected.trim(), "", "le texte de base n'est jamais vide");
    } finally {
      root.unmount();
      container.remove();
    }
    t.mock.restoreAll();
  }
});

test("1b. le texte de base est traduit dans les 3 langues", async (t) => {
  for (const lang of ["fr", "en", "ar"] as const) {
    installRpc(t, { tracking: { order_status: "preparing" } });
    const { container, root } = await renderPage(lang);
    try {
      assert.equal(explanation(container), translate(lang, statusExplanationKey("preparing")));
    } finally {
      root.unmount();
      container.remove();
    }
    t.mock.restoreAll();
  }
});

// --------------------------------------------------------------------
// 2. Surcharge marchande : le TEXTE change, l'ÉTAT jamais.
// --------------------------------------------------------------------

test("2a. une surcharge remplace le texte, sans toucher au badge de statut ni à la frise", async (t) => {
  const OVERRIDE = "Nos fromagers préparent votre plateau avec soin.";

  installRpc(t, { tracking: { order_status: "preparing" } });
  const before = await renderPage();
  const baseBadge = badge(before.container);
  const baseSteps = steps(before.container);
  before.root.unmount();
  before.container.remove();
  t.mock.restoreAll();

  installRpc(t, {
    tracking: { order_status: "preparing" },
    statusText: [override("preparing", OVERRIDE)],
  });
  const { container, root } = await renderPage();
  try {
    assert.equal(explanation(container), OVERRIDE);
    assert.equal(explanationSource(container), "merchant_override");
    // SEUL le texte a changé.
    assert.equal(badge(container), baseBadge, "le badge de statut ne doit jamais changer");
    assert.deepEqual(steps(container), baseSteps, "la frise ne doit jamais changer");
    assert.equal(
      badge(container),
      translate("fr", statusLabelKeyForServiceMode("preparing", "pickup")),
      "le badge reste le libellé canonique du statut réel"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("2b. surcharger un statut n'affecte AUCUN autre statut", async (t) => {
  for (const status of CANONICAL_ORDER_STATUSES) {
    installRpc(t, {
      tracking: { order_status: status },
      statusText: [override("ready", "Votre commande vous attend au comptoir.")],
    });
    const { container, root } = await renderPage();
    try {
      if (status === "ready") {
        assert.equal(explanationSource(container), "merchant_override");
        assert.equal(explanation(container), "Votre commande vous attend au comptoir.");
      } else {
        assert.equal(explanationSource(container), "base", `${status} ne doit pas être affecté`);
        assert.equal(explanation(container), translate("fr", statusExplanationKey(status)));
      }
    } finally {
      root.unmount();
      container.remove();
    }
    t.mock.restoreAll();
  }
});

test("2c. une surcharge vide / blanche / nulle retombe sur le texte de base", async (t) => {
  for (const empty of ["", "   ", null]) {
    installRpc(t, {
      tracking: { order_status: "accepted" },
      statusText: [override("accepted", empty as string | null)],
    });
    const { container, root } = await renderPage();
    try {
      assert.equal(explanationSource(container), "base", `surcharge ${JSON.stringify(empty)}`);
      assert.equal(explanation(container), translate("fr", statusExplanationKey("accepted")));
    } finally {
      root.unmount();
      container.remove();
    }
    t.mock.restoreAll();
  }
});

// --------------------------------------------------------------------
// 3. Aucun statut inventable par configuration.
// --------------------------------------------------------------------

test("3. une surcharge portant un statut NON canonique est ignorée -- aucun 8e statut affichable", async (t) => {
  installRpc(t, {
    tracking: { order_status: "ready", service_mode: "delivery" },
    statusText: [
      override("out_for_delivery", "Votre commande est en route !"),
      override("delivered", "Livré"),
      override("driver_assigned", "Livreur assigné"),
    ],
  });
  const { container, root } = await renderPage();
  try {
    assert.equal(explanationSource(container), "base");
    assert.equal(explanation(container), translate("fr", statusExplanationKey("ready")));
    const text = container.textContent ?? "";
    for (const invented of ["en route", "Livré", "Livreur assigné"]) {
      assert.equal(text.includes(invented), false, `« ${invented} » ne doit jamais s'afficher`);
    }
    // La frise reste EXACTEMENT les 5 étapes de la progression normale.
    assert.equal(steps(container).length, 5);
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------------
// 4. Isolation tenant et échec fermé.
// --------------------------------------------------------------------

test("4a. une surcharge liée à une AUTRE commande est intégralement rejetée", async (t) => {
  installRpc(t, {
    tracking: { order_status: "preparing" },
    statusText: [
      { bound_order_id: OTHER_ORDER_ID, status: "preparing", body: "Texte d'un autre marchand" },
    ],
  });
  const { container, root } = await renderPage();
  try {
    assert.equal(explanationSource(container), "base");
    assert.equal(
      (container.textContent ?? "").includes("Texte d'un autre marchand"),
      false,
      "aucun texte d'une autre commande ne doit jamais s'afficher"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("4b. UNE SEULE ligne incohérente invalide TOUTE la réponse (jamais un mélange partiel)", async (t) => {
  installRpc(t, {
    tracking: { order_status: "preparing" },
    statusText: [
      override("preparing", "Texte légitime"),
      { bound_order_id: OTHER_ORDER_ID, status: "ready", body: "Fuite" },
    ],
  });
  const { container, root } = await renderPage();
  try {
    assert.equal(explanationSource(container), "base");
    assert.equal((container.textContent ?? "").includes("Texte légitime"), false);
    assert.equal((container.textContent ?? "").includes("Fuite"), false);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("4c. panne de lecture des surcharges : la page reste COMPLÈTE, avec le texte de base", async (t) => {
  for (const failure of ["error", "throw", "unavailable"] as const) {
    installRpc(t, { tracking: { order_status: "completed" }, statusText: failure });
    const { container, root } = await renderPage();
    try {
      assert.equal(explanationSource(container), "base", `panne ${failure}`);
      assert.equal(explanation(container), translate("fr", statusExplanationKey("completed")));
      // La page reste complète : badge, frise, total.
      assert.notEqual(badge(container), "");
      assert.equal(steps(container).length, 5);
      assert.ok((container.textContent ?? "").includes("31,50"));
    } finally {
      root.unmount();
      container.remove();
    }
    t.mock.restoreAll();
  }
});

test("4d. la lecture des surcharges utilise la MÊME capacité, jamais un second mécanisme d'accès", async (t) => {
  const calls = installRpc(t, { tracking: { order_status: "new" } });
  const { container, root } = await renderPage();
  try {
    assert.ok(
      calls.includes("get_order_tracking_status_text_by_capability"),
      "la lecture doit passer par la RPC à preuve de capacité"
    );
    // Aucune lecture directe de table, aucune autre RPC inventée.
    for (const c of calls) {
      assert.ok(
        [
          "get_order_tracking_by_capability",
          "get_order_tracking_customer_context_by_capability",
          "get_order_tracking_status_text_by_capability",
        ].includes(c),
        `RPC inattendue appelée par la page : ${c}`
      );
    }
  } finally {
    root.unmount();
    container.remove();
  }
});
