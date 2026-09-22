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
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ====================================================================
// Scanym — CUSTOMER CONTACT + LIVE TRACKING v1
// Page de suivi RÉELLE (app/track/[orderId]/page.tsx), même harnais que
// tests/v166 : RPC interceptées à la frontière réseau (`supabase.rpc`),
// session de suivi réellement signée.
//
// Couvre : les 7 statuts réels (new/accepted/preparing/ready/completed/
// rejected/cancelled), retrait vs livraison, statut inconnu en échec
// fermé, aucun état livreur/prestataire inventé, contact public, échec
// fermé du contexte client, contexte lié à une AUTRE commande ignoré,
// sécurité de capacité inchangée, suivi indépendant de WhatsApp.
// Commande d'exemple de la cliente MYRIAM.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_ORDER_ID = "88888888-8888-4888-8888-888888888888";
const CAP_ID = "99999999-9999-4999-8999-999999999999";
const SECRET = "3c".repeat(32);
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
  name: "cclt-mocks",
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-cclt-track-"));
const tmpFile = path.join(tmpDir, "TrackingPage.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { TrackingPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });


// --------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------

const T = {
  created: "2026-09-22T08:00:00Z",
  accepted: "2026-09-22T08:01:00Z",
  preparing: "2026-09-22T08:02:00Z",
  ready: "2026-09-22T08:10:00Z",
  completed: "2026-09-22T08:30:00Z",
  exception: "2026-09-22T08:05:00Z",
};

function trackingRow(overrides: Record<string, unknown> = {}) {
  return {
    bound_order_id: ORDER_ID,
    order_status: "new",
    service_mode: "pickup",
    order_number: 42,
    created_at: T.created,
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

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    bound_order_id: ORDER_ID,
    restaurant_name: "Épicerie Alpha",
    public_phone: "+33 1 23 45 67 89",
    public_email: "contact@alpha.example",
    ...overrides,
  };
}

type RpcPlan = {
  tracking: Record<string, unknown>;
  context?: Record<string, unknown> | "error" | "throw" | null;
};

function installRpc(t: any, plan: RpcPlan) {
  const calls: { name: string; args: any }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    if (name === "get_order_tracking_by_capability") {
      return { data: [plan.tracking], error: null };
    }
    if (name === "get_order_tracking_customer_context_by_capability") {
      if (plan.context === "throw") throw new Error("network down");
      if (plan.context === "error") return { data: null, error: { code: "42883", message: "absent" } };
      return { data: plan.context ? [plan.context] : [], error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return calls;
}

function flush(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function renderPage() {
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

const stepLabels = (c: Element) =>
  [...c.querySelectorAll("ol li")].map((li) => li.textContent?.replace(/^[✓○]/, "").trim() ?? "");
const stepMarks = (c: Element) => [...c.querySelectorAll("ol li span[aria-hidden]")].map((s) => s.textContent);
const badge = (c: Element) => c.querySelector('[aria-live="polite"]')?.textContent ?? "";
const currentStep = (c: Element) => c.querySelector('li[aria-current="step"]')?.textContent?.replace(/^[✓○]/, "").trim() ?? null;
const exceptionBox = (c: Element) => c.querySelector('p[role="status"]')?.textContent ?? null;

function assertNoWhatsapp(container: Element) {
  const html = container.innerHTML.toLowerCase();
  assert.equal(html.includes("whatsapp"), false, "aucune mention WhatsApp sur le suivi");
  assert.equal(html.includes("wa.me"), false, "aucun lien wa.me sur le suivi");
  assert.equal(html.includes("واتساب"), false);
}

const INVENTED_STATE = /en cours de livraison|livrée|livreur|en route|out for delivery|delivered|courier|eta\b|minutes/i;

// --------------------------------------------------------------------
// Matrice des 7 statuts réels
// --------------------------------------------------------------------

const PICKUP_STEPS = ["Commande reçue", "Commande acceptée", "En préparation", "Prête pour le retrait", "Terminée"];
const DELIVERY_STEPS = ["Commande reçue", "Commande acceptée", "En préparation", "Prête, en attente de prise en charge", "Terminée"];

const MATRIX = [
  { name: "new", mode: "pickup", row: {}, badge: "Commande reçue", marks: ["✓", "○", "○", "○", "○"], current: "Commande reçue", exception: null, steps: PICKUP_STEPS },
  { name: "accepted", mode: "pickup", row: { accepted_at: T.accepted }, badge: "Commande acceptée", marks: ["✓", "✓", "○", "○", "○"], current: "Commande acceptée", exception: null, steps: PICKUP_STEPS },
  { name: "preparing", mode: "pickup", row: { accepted_at: T.accepted, preparing_at: T.preparing }, badge: "En préparation", marks: ["✓", "✓", "✓", "○", "○"], current: "En préparation", exception: null, steps: PICKUP_STEPS },
  { name: "ready", mode: "pickup", row: { accepted_at: T.accepted, preparing_at: T.preparing, ready_at: T.ready }, badge: "Prête pour le retrait", marks: ["✓", "✓", "✓", "✓", "○"], current: "Prête pour le retrait", exception: null, steps: PICKUP_STEPS },
  { name: "ready", mode: "click_collect", row: { accepted_at: T.accepted, preparing_at: T.preparing, ready_at: T.ready }, badge: "Prête pour le retrait", marks: ["✓", "✓", "✓", "✓", "○"], current: "Prête pour le retrait", exception: null, steps: PICKUP_STEPS },
  { name: "ready", mode: "delivery", row: { accepted_at: T.accepted, preparing_at: T.preparing, ready_at: T.ready }, badge: "Prête, en attente de prise en charge", marks: ["✓", "✓", "✓", "✓", "○"], current: "Prête, en attente de prise en charge", exception: null, steps: DELIVERY_STEPS },
  { name: "completed", mode: "pickup", row: { accepted_at: T.accepted, preparing_at: T.preparing, ready_at: T.ready, completed_at: T.completed }, badge: "Terminée", marks: ["✓", "✓", "✓", "✓", "✓"], current: "Terminée", exception: null, steps: PICKUP_STEPS },
  { name: "completed", mode: "delivery", row: { accepted_at: T.accepted, preparing_at: T.preparing, ready_at: T.ready, completed_at: T.completed }, badge: "Terminée", marks: ["✓", "✓", "✓", "✓", "✓"], current: "Terminée", exception: null, steps: DELIVERY_STEPS },
  { name: "rejected", mode: "pickup", row: { rejected_at: T.exception }, badge: "Commande refusée", marks: ["✓", "○", "○", "○", "○"], current: null, exception: "Commande refusée", steps: PICKUP_STEPS },
  { name: "cancelled", mode: "delivery", row: { accepted_at: T.accepted, cancelled_at: T.exception }, badge: "Commande annulée", marks: ["✓", "✓", "○", "○", "○"], current: null, exception: "Commande annulée", steps: DELIVERY_STEPS },
] as const;

for (const c of MATRIX) {
  test(`CCLT-TRACK-STATUS ${c.name} / ${c.mode} : badge, frise et étape courante suivent le statut RÉEL ; aucune étape inventée`, async (t) => {
    installRpc(t, { tracking: trackingRow({ order_status: c.name, service_mode: c.mode, ...c.row }), context: null });
    const { container, root } = await renderPage();
    try {
      assert.equal(badge(container), c.badge);
      assert.deepEqual(stepLabels(container), [...c.steps], "exactement les 5 étapes réelles");
      assert.deepEqual(stepMarks(container), [...c.marks]);
      assert.equal(currentStep(container), c.current);
      assert.equal(exceptionBox(container), c.exception);
      assert.equal(INVENTED_STATE.test(container.textContent ?? ""), false, "aucun état livreur/prestataire/ETA inventé");
      if (c.mode !== "delivery") {
        assert.equal(/livraison|prise en charge/i.test(stepLabels(container).join(" ")), false, "retrait : jamais un libellé de livraison");
      }
      assertNoWhatsapp(container);
    } finally {
      root.unmount();
      container.remove();
    }
  });
}

test("CCLT-TRACK-UNKNOWN statut inconnu : échec FERMÉ (message « indisponible »), aucune frise, aucune section", async (t) => {
  for (const status of ["out_for_delivery", "delivered", "", "READY"]) {
    t.mock.restoreAll();
    installRpc(t, { tracking: trackingRow({ order_status: status }), context: contextRow() });
    const { container, root } = await renderPage();
    try {
      assert.ok(container.textContent?.includes("Suivi temporairement indisponible"), status);
      assert.equal(container.querySelector("ol") === null, true, `${status}: aucune frise`);
      assert.equal(container.querySelector("[data-tracking-merchant-contact]") === null, true, `${status}: aucune section`);
    } finally {
      root.unmount();
      container.remove();
    }
  }
});

// --------------------------------------------------------------------
// Contact public
// --------------------------------------------------------------------

test("CCLT-TRACK-CONTACT-01 contact PUBLIC affiché (tel:/mailto:), sans WhatsApp, lu avec la MÊME capacité", async (t) => {
  const calls = installRpc(t, { tracking: trackingRow(), context: contextRow() });
  const { container, root } = await renderPage();
  try {
    const section = container.querySelector("[data-tracking-merchant-contact]");
    assert.ok(section, "section contact affichée");
    assert.ok(section!.textContent?.includes("Contacter Épicerie Alpha"));
    assert.deepEqual([...section!.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["tel:+33123456789", "mailto:contact@alpha.example"]);
    const ctx = calls.find((c) => c.name === "get_order_tracking_customer_context_by_capability");
    const main = calls.find((c) => c.name === "get_order_tracking_by_capability");
    assert.deepEqual(ctx?.args, main?.args, "même capacité que la lecture principale");
    assert.deepEqual(main?.args, { p_order_id: ORDER_ID, p_capability_id: CAP_ID, p_secret: SECRET });
    assertNoWhatsapp(container);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("CCLT-TRACK-CONTACT-02 téléphone seul / e-mail seul / aucun contact", async (t) => {
  const cases = [
    { ctx: { public_email: null }, hrefs: ["tel:+33123456789"] },
    { ctx: { public_phone: null }, hrefs: ["mailto:contact@alpha.example"] },
    { ctx: { public_phone: null, public_email: "  " }, hrefs: null },
  ];
  for (const c of cases) {
    t.mock.restoreAll();
    installRpc(t, { tracking: trackingRow(), context: contextRow(c.ctx) });
    const { container, root } = await renderPage();
    try {
      const section = container.querySelector("[data-tracking-merchant-contact]");
      if (c.hrefs === null) {
        assert.equal(section === null, true, "aucune section sans contact");
      } else {
        assert.deepEqual([...section!.querySelectorAll("a")].map((a) => a.getAttribute("href")), c.hrefs);
      }
    } finally {
      root.unmount();
      container.remove();
    }
  }
});

test("CCLT-TRACK-CONTACT-03 échec du contexte client (erreur RPC, exception, lot SQL absent) : suivi COMPLET, sans section contact", async (t) => {
  for (const context of ["error", "throw", null] as const) {
    t.mock.restoreAll();
    installRpc(t, { tracking: trackingRow({ order_status: "accepted", accepted_at: T.accepted }), context });
    const { container, root } = await renderPage();
    try {
      assert.equal(stepLabels(container).length, 5, `${context}: frise toujours rendue`);
      assert.ok(container.textContent?.includes("Commande #42"), `${context}: numéro de commande rendu`);
      assert.equal(container.querySelector("[data-tracking-merchant-contact]") === null, true, `${context}: pas de contact`);
    } finally {
      root.unmount();
      container.remove();
    }
  }
});

test("CCLT-TRACK-CONTACT-04 isolation : un contexte lié à une AUTRE commande est ignoré (aucune fuite inter-commandes/commerçants)", async (t) => {
  installRpc(t, {
    tracking: trackingRow(),
    context: contextRow({ bound_order_id: OTHER_ORDER_ID, restaurant_name: "Maison Beta", public_email: "beta@beta.example" }),
  });
  const { container, root } = await renderPage();
  try {
    assert.equal(container.querySelector("[data-tracking-merchant-contact]") === null, true);
    assert.equal(container.textContent?.includes("Maison Beta"), false);
    assert.equal(container.textContent?.includes("beta@beta.example"), false);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("CCLT-TRACK-SEC-01 sans session valide : aucune lecture (ni suivi ni contact), porte d'entrée v3.1 inchangée", async (t) => {
  const calls = installRpc(t, { tracking: trackingRow(), context: contextRow() });
  const saved = (globalThis as any).__mockCookieStore;
  (globalThis as any).__mockCookieStore = {};
  try {
    const { container, root } = await renderPage();
    try {
      assert.deepEqual(calls, [], "aucune RPC sans session");
      assert.equal(container.querySelector("[data-tracking-merchant-contact]") === null, true);
    } finally {
      root.unmount();
      container.remove();
    }
  } finally {
    (globalThis as any).__mockCookieStore = saved;
  }
});
