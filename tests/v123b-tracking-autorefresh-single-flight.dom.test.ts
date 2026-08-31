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
// Scanym — CUSTOMER TRACKING EXPERIENCE v2.1 —
// components/TrackingAutoRefresh.tsx : ferme CTE-V2-AUTOREFRESH-01
// (LOW, Work re-audit de v2) — preuve COMPORTEMENTALE de la garde
// mono-vol ("single-flight guard"), mandat §7/§12.
//
// AUCUN test comportemental dédié n'existait pour ce composant avant
// v2.1 (seule sa PRÉSENCE architecturale était vérifiée par
// tests/v122j-tracking-structural.test.ts). Ce fichier répare ce vide
// ET prouve la garde mono-vol ajoutée par le correctif v2.1.
//
// `next/navigation` est mocké avec un `useRouter().refresh` REDIRIGÉ
// vers une fonction contrôlée par CHAQUE test individuellement
// (`globalThis.__mockRouterRefresh`, réaffectée à chaque test) --
// même principe que tests/v122g-tracking-entrygate.dom.test.ts, étendu
// ici pour permettre à un test de fournir un thenable dont la
// résolution est entièrement pilotée par le test (voir le commentaire
// de tête de TrackingAutoRefresh.tsx : cette branche `result.then` est
// INERTE en production réelle et existe UNIQUEMENT pour ce genre de
// contrôle déterministe en test).
//
// `intervalMs` est réduit à une valeur de quelques dizaines de
// millisecondes dans chaque test (jamais les ~15s réels du mandat --
// intervalMs reste un paramètre explicite du composant, la cadence
// réelle de production n'est donc pas modifiée) pour observer
// plusieurs tics en un temps de test raisonnable ; l'attente reste par
// SONDAGE (`waitFor`, même convention établie que tests/v92-*.dom.test.ts
// et tests/v122g-*.dom.test.ts) plutôt que des délais fixes.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/track/11111111-1111-4111-8111-111111111111",
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
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

// Réaffecté par chaque test -- voir le commentaire de tête.
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

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) {
        return { path: args.path, namespace: "mock" };
      }
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"]
          .map((ext) => base + ext)
          .find((p) => existsSync(p));
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

const entrySource = `
export { default as TrackingAutoRefresh } from "@/components/TrackingAutoRefresh";
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
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v123b-"));
const tmpFile = path.join(tmpDir, "TrackingAutoRefresh.mjs");
writeFileSync(tmpFile, code);
const { TrackingAutoRefresh } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(intervalMs);
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("mandat §7 : cadence normale préservée -- plusieurs rafraîchissements espacés se produisent tant que 'enabled' reste vrai (refresh() ne retourne rien, comme en PRODUCTION réelle -- branche 'thenable' non déclenchée)", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    // Comportement RÉEL de production : `router.refresh()` ne retourne
    // rien (`void`) -- voir le commentaire de tête de
    // TrackingAutoRefresh.tsx.
    return undefined;
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 30 }));

  await waitFor(() => callCount >= 3, "au moins 3 rafraîchissements doivent se produire sous cadence normale");

  root.unmount();
  const countAtUnmount = callCount;
  await flush(120);
  assert.equal(callCount, countAtUnmount, "aucun rafraîchissement supplémentaire après démontage -- l'intervalle doit être annulé");

  container.remove();
});

test("mandat §19 (préservé) : le rafraîchissement s'arrête dès que 'enabled' devient faux, sans attendre un démontage", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 30 }));

  await waitFor(() => callCount >= 1, "au moins un premier rafraîchissement doit se produire");

  root.render(React.createElement(TrackingAutoRefresh, { enabled: false, intervalMs: 30 }));
  await flush(30); // laisse le temps à l'effet de nettoyage de s'exécuter

  const countAfterDisable = callCount;
  await flush(120);
  assert.equal(callCount, countAfterDisable, "aucun rafraîchissement supplémentaire une fois 'enabled' passé à faux");

  root.unmount();
  container.remove();
});

test("CTE-V2-AUTOREFRESH-01 (ferme, garde mono-vol) : un rafraîchissement encore EN ATTENTE fait IGNORER les tics suivants -- aucun empilement d'appels concurrents", async () => {
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    // Thenable CONTRÔLÉ PAR LE TEST -- voir le commentaire de tête de
    // TrackingAutoRefresh.tsx : cette branche n'existe en production
    // que pour permettre exactement ce genre de contrôle déterministe.
    return deferred.promise;
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 30 }));

  await waitFor(() => callCount === 1, "le premier rafraîchissement doit se déclencher");

  // Plusieurs cadences (~30ms chacune) s'écoulent PENDANT que le
  // premier rafraîchissement reste en attente -- AVANT le correctif
  // v2.1, chacun de ces tics aurait empilé un second/troisième appel
  // `router.refresh()` concurrent par-dessus le premier, non résolu.
  await flush(150);
  assert.equal(callCount, 1, "aucun second appel ne doit se produire tant que le premier rafraîchissement reste en attente (garde mono-vol)");

  // Le rafraîchissement en attente se résout enfin -- le tic SUIVANT
  // (cadence inchangée) doit alors redéclencher normalement.
  deferred.resolve();
  await waitFor(() => callCount === 2, "un second rafraîchissement doit se déclencher normalement une fois le premier résolu");

  root.unmount();
  container.remove();
});
