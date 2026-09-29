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
// Scanym — TRACKING FRESHNESS v1 — AUDIT REMEDIATION (issue #11,
// comment `5884325325`), volet COMPOSANT :
//
//   [E] BLOCKER A -- le verrou mono-vol PARTAGÉ
//       (lib/tracking/refresh-lock.ts) protège désormais les TROIS
//       déclencheurs (minuteur, focus, clic manuel), montés dans DEUX
//       composants distincts (TrackingAutoRefresh +
//       TrackingManualRefreshLink) : aucune combinaison des trois ne
//       peut jamais empiler un second `router.refresh()` par-dessus
//       un premier encore en attente ; le verrou se relâche aussi
//       bien après un SUCCÈS qu'après un ÉCHEC réseau.
//   [F] BLOCKER A (complément) -- le clic manuel sans JavaScript
//       (repli, mandat §19) reste un `<Link href>` valide.
//   [G] BLOCKER A (complément, relevé par l'audit) -- un retour de
//       focus PENDANT que l'onglet est marqué "hidden" ne déclenche
//       plus de requête réseau (même garde que le minuteur).
//
// Même harnais que tests/tracking-freshness-v1.dom.test.ts (esbuild +
// JSDOM + mock de next/navigation), étendu pour monter les DEUX
// composants ensemble. Le volet BLOCKER B (app/track/[orderId]/
// page.tsx, branches d'erreur) vit dans un fichier SÉPARÉ,
// tests/tracking-freshness-v1-audit-remediation-page.dom.test.ts --
// jamais dans le même fichier qu'un harnais composant : ce dépôt
// n'a, à ce jour, jamais mêlé un harnais "fenêtre JSDOM nue pour un
// composant client" et un harnais "page Server Component réelle"
// dans un seul et même module (voir tracking-freshness-v1.dom.test.ts
// vs cclt-v1-tracking-page.dom.test.ts, déjà séparés pour la même
// raison) -- les deux harnais construisent des bundles esbuild
// distincts avec des jeux de mocks distincts (next/headers,
// @/lib/server/tracking-service, etc. n'existent que côté page), et
// les combiner dans un seul module a provoqué un blocage du
// processus de test à l'exécution (l'objet `window` JSDOM du volet
// composant, déjà posé sur `globalThis` avant que le bundle de PAGE
// ne soit importé, changeait le comportement observé de ce second
// bundle) -- séparés, les deux volets s'exécutent chacun normalement.
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

function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// --------------------------------------------------------------------
// Harnais COMPOSANT : TrackingAutoRefresh + TrackingManualRefreshLink
// montés ensemble, comme ils le sont réellement sur
// app/track/[orderId]/page.tsx (deux enfants directs de la même page,
// ni parent ni enfant l'un de l'autre).
// --------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/track/11111111-1111-4111-8111-111111111111",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).MouseEvent = window.MouseEvent;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

(globalThis as any).__mockRouterRefresh = undefined;

const MOCK_NAV = `
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
`;

const MOCK_LINK = `
import { createElement } from "react";
export default function Link(props) {
  const { href, children, ...rest } = props;
  return createElement("a", { href, ...rest }, children);
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "next/link": MOCK_LINK,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-remediation-mocks",
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
      contents: mocks[args.path] ?? "export {};",
      loader: "ts",
    }));
  },
};

const entrySource = `
export { default as TrackingAutoRefresh } from "@/components/TrackingAutoRefresh";
export { default as TrackingManualRefreshLink } from "@/components/TrackingManualRefreshLink";
export { __resetTrackingRefreshLockForTests } from "@/lib/tracking/refresh-lock";
`;

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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-trackfresh-remediation-"));
const tmpFile = path.join(tmpDir, "components.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { TrackingAutoRefresh, TrackingManualRefreshLink, __resetTrackingRefreshLockForTests } = await import(
  pathToFileURL(tmpFile).href
);
rmSync(tmpDir, { recursive: true, force: true });

const CLEAN_HREF = "/track/11111111-1111-4111-8111-111111111111";
const REFRESH_LABEL = "Actualiser le suivi";

function renderBoth(props: { enabled: boolean; intervalMs?: number }) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(TrackingAutoRefresh, props),
      React.createElement(TrackingManualRefreshLink, { href: CLEAN_HREF, label: REFRESH_LABEL })
    )
  );
  return { container, root };
}

function clickManualLink(container: Element) {
  const anchor = container.querySelector("a")!;
  assert.ok(anchor, "le lien de rafraîchissement manuel doit être rendu");
  anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

// --------------------------------------------------------------
// [E] BLOCKER A — verrou PARTAGÉ entre les trois déclencheurs.
// --------------------------------------------------------------

test("[E1] BLOCKER A : un clic manuel PENDANT un rafraîchissement déclenché par le FOCUS (en attente) est ignoré -- jamais empilé", async () => {
  __resetTrackingRefreshLockForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 1, "le focus doit déclencher un premier rafraîchissement");

    clickManualLink(container);
    await flush(40);
    assert.equal(callCount, 1, "le clic manuel pendant un rafraîchissement de focus en attente est ignoré");

    deferred.resolve();
    await flush(20);

    clickManualLink(container);
    await waitFor(() => callCount === 2, "un clic manuel APRÈS résolution doit déclencher normalement");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[E2] BLOCKER A : un tic de minuteur PENDANT un rafraîchissement MANUEL (en attente) est ignoré -- jamais empilé", async () => {
  __resetTrackingRefreshLockForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 30 });
  try {
    await flush(20);

    clickManualLink(container);
    await waitFor(() => callCount === 1, "le clic manuel doit déclencher un premier rafraîchissement");

    // Laisse largement le temps à au moins deux tics du minuteur
    // (30ms) de se produire pendant que le rafraîchissement manuel
    // reste en attente -- aucun ne doit s'empiler.
    await flush(90);
    assert.equal(callCount, 1, "aucun tic de minuteur ne s'empile pendant un rafraîchissement manuel en attente");

    deferred.resolve();
    await waitFor(() => callCount === 2, "le prochain tic APRÈS résolution doit déclencher normalement", 3000, 10);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[E3] BLOCKER A : un focus PENDANT un rafraîchissement de MINUTEUR (en attente) est ignoré -- jamais empilé", async () => {
  __resetTrackingRefreshLockForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  // On déclenche le PREMIER rafraîchissement via un focus (cadence du
  // minuteur volontairement longue), PUIS on vérifie qu'un SECOND
  // focus ET un clic manuel pendant qu'il reste en attente sont TOUS
  // deux ignorés -- même scénario que le test [C] pré-existant
  // (tests/tracking-freshness-v1.dom.test.ts), mais désormais à
  // travers le verrou PARTAGÉ, aux côtés du composant de lien manuel
  // monté simultanément.
  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 1, "premier focus");

    window.dispatchEvent(new window.Event("focus"));
    clickManualLink(container);
    await flush(40);
    assert.equal(callCount, 1, "un second focus ET un clic manuel pendant un rafraîchissement en attente sont TOUS deux ignorés");

    deferred.resolve();
    await flush(20);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[E4] BLOCKER A, point 4 : le verrou se relâche après un ÉCHEC réseau (promesse rejetée), pas seulement après un succès", async () => {
  __resetTrackingRefreshLockForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    clickManualLink(container);
    await waitFor(() => callCount === 1, "premier clic manuel");

    // Second déclenchement (focus) pendant que le premier reste en
    // attente : ignoré, comme attendu.
    window.dispatchEvent(new window.Event("focus"));
    await flush(30);
    assert.equal(callCount, 1, "précondition : toujours un seul appel avant l'échec");

    // Le rafraîchissement en attente ÉCHOUE (réseau, timeout, 5xx...).
    deferred.reject(new Error("network error (simulated)"));
    await flush(20);

    // Le verrou doit être relâché malgré l'échec -- un déclenchement
    // SUIVANT doit fonctionner normalement, pas rester bloqué
    // indéfiniment.
    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 2, "un déclenchement après un échec réseau doit réussir -- le verrou n'est pas resté bloqué");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// [F] BLOCKER A (complément) — repli sans JavaScript intact.
// --------------------------------------------------------------

test("[F] TrackingManualRefreshLink rend un <a href> valide (repli sans JavaScript, mandat §19) avec le libellé accessible attendu", async () => {
  __resetTrackingRefreshLockForTests();
  const { container, root } = renderBoth({ enabled: false });
  try {
    await flush(20);
    const anchor = container.querySelector("a")!;
    assert.equal(anchor.getAttribute("href"), CLEAN_HREF, "href identique au chemin propre fourni -- une navigation SANS JS fonctionnerait");
    assert.equal(anchor.getAttribute("aria-label"), REFRESH_LABEL);
    assert.equal(anchor.textContent?.includes(REFRESH_LABEL), true, "libellé visible, pas seulement le symbole ⟳ seul (mandat §24)");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// [G] BLOCKER A (relevé par l'audit) — focus pendant onglet caché.
// --------------------------------------------------------------

test("[G] un retour de focus PENDANT que l'onglet est marqué caché ne déclenche AUCUNE requête réseau", async () => {
  __resetTrackingRefreshLockForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };
  Object.defineProperty(window.document, "visibilityState", { value: "hidden", configurable: true });

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    window.dispatchEvent(new window.Event("focus"));
    await flush(40);
    assert.equal(callCount, 0, "un focus pendant que l'onglet est caché ne doit déclencher aucun rafraîchissement");

    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 1, "le focus redevient opérant dès que l'onglet redevient visible");
  } finally {
    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
    root.unmount();
    container.remove();
  }
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
  delete (globalThis as any).Event;
  delete (globalThis as any).MouseEvent;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mockRouterRefresh;
});
