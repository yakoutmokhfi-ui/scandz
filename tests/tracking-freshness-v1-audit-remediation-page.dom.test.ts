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
// Scanym — TRACKING FRESHNESS v1 — AUDIT REMEDIATION (issue #11,
// comment `5884325325`), volet PAGE (BLOCKER B) :
//
//   app/track/[orderId]/page.tsx : les branches d'erreur TRANSITOIRE
//   (TrackingServerUnavailableError, et l'exception générique non
//   classifiée) montent désormais un mécanisme de récupération
//   (TrackingAutoRefresh à cadence lente + TrackingManualRefreshLink) ;
//   les branches TERMINALES (TrackingLinkInvalidError, order_id
//   malformé) restent SANS aucun mécanisme de récupération,
//   inchangées.
//
// Même harnais de PAGE RÉELLE que tests/cclt-v1-tracking-page.dom.test.ts
// (esbuild + JSDOM + page.tsx réellement importé), mais mocke
// @/lib/server/tracking-service DIRECTEMENT plutôt que la RPC
// Supabase : les trois façons dont getOrderTracking peut échouer
// (résultat RPC vide, erreur Postgrest, exception réseau) sont déjà
// couvertes exhaustivement par tests/v122d-tracking-service.test.ts
// (mapping RPC -> erreur typée) -- ce fichier ne teste QUE le CHOIX
// DE BRANCHE de page.tsx une fois l'erreur typée obtenue, jamais ce
// mapping une seconde fois.
//
// VOLONTAIREMENT dans un fichier SÉPARÉ du volet composant
// (tests/tracking-freshness-v1-audit-remediation.dom.test.ts) : ce
// dépôt n'a jamais mêlé un harnais "fenêtre JSDOM nue pour un
// composant client" et un harnais "page Server Component réelle"
// dans un seul module (voir la même séparation pré-existante entre
// tracking-freshness-v1.dom.test.ts et cclt-v1-tracking-page.dom.test.ts)
// -- les combiner a provoqué un blocage du processus de test à
// l'exécution pendant le développement de ce lot.
// ====================================================================

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 3000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(intervalMs);
  }
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/track/77777777-7777-4777-8777-777777777777",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).MouseEvent = window.MouseEvent;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_ID = "77777777-7777-4777-8777-777777777777";
const CAP_ID = "99999999-9999-4999-8999-999999999999";
const SECRET = "3c".repeat(32);
const SESSION_TOKEN = createTrackingSessionToken(ORDER_ID, CAP_ID, SECRET);

(globalThis as any).__mockCookieStore = { [TRACKING_SESSION_COOKIE_NAME]: SESSION_TOKEN };
(globalThis as any).__mockRouterRefresh = undefined;
(globalThis as any).__mockTrackingErrorKind = undefined;

const mocks: Record<string, string> = {
  "next/headers": `
export async function cookies() {
  const store = (globalThis).__mockCookieStore || {};
  return { get(name) { return name in store ? { name, value: store[name] } : undefined; } };
}`,
  "next/navigation": `
export function useRouter() {
  return {
    refresh: (...args) => {
      const fn = (globalThis).__mockRouterRefresh;
      return fn ? fn(...args) : undefined;
    },
    replace: () => {},
    push: () => {},
  };
}
export function notFound() { throw new Error("notFound"); }`,
  "next/link": `
import { createElement } from "react";
export default function Link(props) { const { href, children, ...rest } = props; return createElement("a", { href, ...rest }, children); }`,
  // Intercepte @/lib/server/tracking-service DIRECTEMENT, plutôt que
  // la RPC Supabase -- voir le commentaire de tête. Importe les
  // VRAIES classes d'erreur (@/lib/server/tracking-errors, résolues
  // normalement par ce même plugin ci-dessous, donc la MÊME
  // référence de classe que celle importée par page.tsx dans ce
  // bundle) pour que `instanceof` dans page.tsx reconnaisse
  // l'instance lancée ici.
  "@/lib/server/tracking-service": `
import { TrackingLinkInvalidError, TrackingServerUnavailableError } from "@/lib/server/tracking-errors";
export async function getOrderTracking(input) {
  const kind = (globalThis).__mockTrackingErrorKind;
  if (kind === "invalid") throw new TrackingLinkInvalidError();
  if (kind === "unavailable") throw new TrackingServerUnavailableError();
  if (kind === "generic") throw new Error("boom -- unexpected/unclassified exception (test double)");
  throw new Error("[test] __mockTrackingErrorKind must be set before rendering the page");
}`,
};

const mockPlugin: esbuild.Plugin = {
  name: "trackfresh-remediation-page-mocks",
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-trackfresh-remediation-page-"));
const tmpFile = path.join(tmpDir, "TrackingPage.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { TrackingPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const CLEAN_HREF = "/track/77777777-7777-4777-8777-777777777777";
const REFRESH_LABEL = "Actualiser le suivi";

async function renderTrackingPage(orderId: string) {
  const element = await TrackingPage({
    params: Promise.resolve({ orderId }),
    searchParams: Promise.resolve({}),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await flush();
  return { container, root };
}

function clickManualLink(container: Element) {
  const anchor = container.querySelector("a")!;
  assert.ok(anchor, "le lien de rafraîchissement manuel doit être rendu");
  anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

test("[H1] BLOCKER B : TrackingLinkInvalidError (lien invalide, TERMINAL) -- aucun mécanisme de récupération, inchangé", async (t) => {
  (globalThis as any).__mockTrackingErrorKind = "invalid";
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = await renderTrackingPage(ORDER_ID);
  try {
    assert.equal(container.querySelector("a"), null, "aucun lien de récupération sur un lien invalide -- état terminal");
    window.dispatchEvent(new window.Event("focus"));
    await flush(40);
    assert.equal(callCount, 0, "aucun auto-refresh monté sur cette branche -- un focus ne doit rien déclencher");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[H2] BLOCKER B : TrackingServerUnavailableError (panne serveur, TRANSITOIRE) -- le lien manuel de récupération est monté", async (t) => {
  (globalThis as any).__mockTrackingErrorKind = "unavailable";

  const { container, root } = await renderTrackingPage(ORDER_ID);
  try {
    assert.ok(container.textContent?.includes("Suivi temporairement indisponible"), "message d'indisponibilité toujours affiché");
    const anchor = container.querySelector("a");
    assert.ok(anchor, "un lien de récupération DOIT être rendu sur une panne transitoire");
    assert.equal(anchor!.getAttribute("href"), CLEAN_HREF, "chemin propre, sans jeton, identique au chemin de succès");
    assert.equal(anchor!.getAttribute("aria-label"), REFRESH_LABEL);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[H3] BLOCKER B : TrackingServerUnavailableError -- l'auto-refresh est réellement monté et ACTIF (un focus déclenche un rafraîchissement)", async (t) => {
  (globalThis as any).__mockTrackingErrorKind = "unavailable";
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = await renderTrackingPage(ORDER_ID);
  try {
    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 1, "un focus doit déclencher un rafraîchissement sur la branche de panne transitoire");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[H4] BLOCKER B : TrackingServerUnavailableError -- le clic manuel utilise le MÊME verrou partagé que l'auto-refresh", async (t) => {
  (globalThis as any).__mockTrackingErrorKind = "unavailable";
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = await renderTrackingPage(ORDER_ID);
  try {
    clickManualLink(container);
    await waitFor(() => callCount === 1, "le clic manuel doit déclencher un rafraîchissement sur la branche de panne transitoire");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[H5] BLOCKER B : exception GÉNÉRIQUE non classifiée (filet défensif) -- traitée comme transitoire, PAS comme une troisième catégorie terminale inventée", async (t) => {
  (globalThis as any).__mockTrackingErrorKind = "generic";

  const { container, root } = await renderTrackingPage(ORDER_ID);
  try {
    assert.ok(container.textContent?.includes("Suivi temporairement indisponible"), "même message que la panne serveur classifiée");
    const anchor = container.querySelector("a");
    assert.ok(anchor, "le lien de récupération est monté aussi sur l'exception générique -- jamais traitée comme terminale");
    assert.equal(anchor!.getAttribute("href"), CLEAN_HREF);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[H6] BLOCKER B, non-régression : order_id malformé (TERMINAL, inchangé par ce lot) -- toujours aucun mécanisme de récupération", async (t) => {
  const { container, root } = await renderTrackingPage("not-a-uuid");
  try {
    assert.equal(container.querySelector("a"), null, "order_id malformé : toujours aucun lien de récupération");
  } finally {
    root.unmount();
    container.remove();
  }
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  // ROUND 2 (re-audit Margaux, comment `5885210667`, appliqué ici
  // aussi par cohérence bien que BLOCKER B -- le volet de ce fichier
  // -- reste fermé et non modifié par ce lot) : un `unref()` AVEUGLE
  // de TOUTE poignée active masquerait une vraie fuite créée par ce
  // harnais exactement aussi silencieusement qu'il masque la poignée
  // `MessagePort` bénigne du planificateur de React. On ne relâche
  // donc QUE les poignées dont le CONSTRUCTEUR est reconnu comme
  // provenant de ce mécanisme connu et inoffensif -- toute autre
  // poignée active reste NON relâchée.
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    const ctorName = h?.constructor?.name;
    if (ctorName === "MessagePort" && typeof h.unref === "function") {
      h.unref();
    }
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).MouseEvent;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mockCookieStore;
  delete (globalThis as any).__mockRouterRefresh;
  delete (globalThis as any).__mockTrackingErrorKind;
});
