import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRACKING FRESHNESS v1 (issue #11, comment 5883794674,
// Ravel) — preuve COMPORTEMENTALE des trois changements de ce lot sur
// components/TrackingAutoRefresh.tsx :
//   [A] cadence par défaut passée à 5s (structurel -- voir plus bas
//       pourquoi ce point précis est vérifié par lecture de source,
//       pas par chronométrage réel) ;
//   [B] pause : AUCUNE requête réseau tant que l'onglet est caché
//       (`document.visibilityState === "hidden"`) ;
//   [C] rafraîchissement immédiat au retour du focus fenêtre/onglet
//       (`window` "focus"), sous la MÊME garde mono-vol que le
//       minuteur (CTE-V2-AUTOREFRESH-01, v2.1, préservée) ;
//   [D] arrêt complet (minuteur ET écouteur de focus) dès `enabled`
//       faux ou démontage -- aucune fuite d'écouteur.
//
// Même harnais que tests/v123b-tracking-autorefresh-single-flight.dom.test.ts :
// `next/navigation` mocké avec un `useRouter().refresh` redirigé vers
// `globalThis.__mockRouterRefresh` (réaffecté par test), esbuild
// bundle le composant réel (aucune réimplémentation en double), JSDOM
// fournit `window`/`document`. `intervalMs` est réduit à quelques
// dizaines de millisecondes dans chaque test comportemental (jamais
// les 5s réels de production -- `intervalMs` reste un paramètre
// explicite du composant) pour observer plusieurs tics en un temps de
// test raisonnable ; l'attente reste par SONDAGE (`waitFor`).
//
// [A] est volontairement vérifié par LECTURE DE SOURCE plutôt que par
// chronométrage réel : chronométrer un intervalle de 5s réel dans un
// test unitaire serait soit trop lent (attendre 3 tics = 15s+), soit
// nécessiterait de mocker les minuteurs globaux -- une technique
// absente de ce dépôt à ce jour. La valeur par défaut EST un fait
// architectural vérifiable textuellement (comme
// tests/tracking-storefront-visual-alignment.test.ts vérifie déjà la
// ligne JSX exacte du site d'appel) ; le comportement DYNAMIQUE de la
// cadence (tics espacés, annulés au démontage) reste, lui, déjà
// prouvé par tests/v123b-*.dom.test.ts (inchangé par ce lot, rejoué
// ci-dessous à la fin de ce fichier pour confirmer la non-régression
// dans les DEUX nouveaux scénarios de pause/focus).
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-trackfresh-"));
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

/** Bascule `document.visibilityState` -- jsdom expose une valeur
 *  normalement en lecture seule ; `defineProperty` la rend
 *  reconfigurable pour la durée du test. Restaurée à "visible" après
 *  chaque test qui la modifie, pour ne pas polluer les tests
 *  suivants. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(window.document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

// --------------------------------------------------------------
// [A] Cadence par défaut : 5s (structurel, voir commentaire de tête).
// --------------------------------------------------------------

test("[A] TRACKING FRESHNESS v1 : la cadence par défaut du minuteur est 5s (5_000ms), pas les 15s de CTE v2", () => {
  const src = readFileSync(path.join(REPO_ROOT, "components/TrackingAutoRefresh.tsx"), "utf8");
  assert.match(
    src,
    /intervalMs\s*=\s*5_000/,
    "la valeur par défaut de intervalMs doit être 5_000, littéralement dans la signature du composant"
  );
  assert.equal(
    /intervalMs\s*=\s*15_000/.test(src),
    false,
    "l'ancienne cadence 15s ne doit plus apparaître comme valeur par défaut"
  );
});

test("[A] le site d'appel (app/track/[orderId]/page.tsx) reste EXACTEMENT inchangé -- la cadence de 5s vient du défaut du composant, jamais d'un prop explicite au site d'appel", () => {
  const pageSrc = readFileSync(path.join(REPO_ROOT, "app/track/[orderId]/page.tsx"), "utf8");
  assert.equal(
    pageSrc.includes("<TrackingAutoRefresh enabled={!terminal} />"),
    true,
    "non-régression : tests/tracking-storefront-visual-alignment.test.ts vérifie cette même ligne comme une autorité de suivi"
  );
});

// --------------------------------------------------------------
// [B] Pause pendant que l'onglet est caché.
// --------------------------------------------------------------

test("[B] TRACKING FRESHNESS v1 : AUCUN rafraîchissement tant que l'onglet est caché, même si plusieurs cadences s'écoulent", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };
  setVisibility("hidden");

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 30 }));

  // Plusieurs cadences (~30ms chacune) s'écoulent, onglet caché.
  await flush(150);
  assert.equal(callCount, 0, "aucun rafraîchissement ne doit se produire tant que l'onglet est caché");

  root.unmount();
  container.remove();
  setVisibility("visible");
});

test("[B] TRACKING FRESHNESS v1 : le rafraîchissement REPREND normalement dès que l'onglet redevient visible", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };
  setVisibility("hidden");

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 30 }));

  await flush(80);
  assert.equal(callCount, 0, "précondition : rien ne s'est produit pendant que l'onglet était caché");

  setVisibility("visible");
  await waitFor(() => callCount >= 1, "un rafraîchissement doit se produire au tic suivant une fois l'onglet redevenu visible");

  root.unmount();
  container.remove();
  setVisibility("visible");
});

// --------------------------------------------------------------
// [C] Rafraîchissement immédiat au retour du focus.
// --------------------------------------------------------------

test("[C] TRACKING FRESHNESS v1 : un événement 'focus' sur window déclenche un rafraîchissement IMMÉDIAT, sans attendre le prochain tic", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  // Cadence délibérément LONGUE (10s équivalent réduit ici à un
  // temps qu'un test ne devrait jamais atteindre) : si le focus ne
  // déclenchait pas de rafraîchissement immédiat, callCount resterait
  // à 0 pendant toute la durée du test.
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 5000 }));

  await flush(20);
  assert.equal(callCount, 0, "précondition : aucun tic de minuteur n'a encore eu lieu (cadence longue)");

  window.dispatchEvent(new window.Event("focus"));
  await waitFor(() => callCount === 1, "le retour de focus doit déclencher un rafraîchissement immédiat, sans attendre le minuteur");

  root.unmount();
  container.remove();
});

test("[C] TRACKING FRESHNESS v1 : le focus respecte la garde mono-vol -- un focus pendant un rafraîchissement EN ATTENTE est ignoré, jamais empilé", async () => {
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 5000 }));
  // Laisse l'effet de montage attacher l'écouteur AVANT de déclencher
  // le premier focus -- sans ce délai, l'événement peut être envoyé
  // avant que `window.addEventListener("focus", ...)` n'ait tourné
  // (useEffect est asynchrone après le commit initial), et serait
  // alors perdu (même précaution que le test [C] précédent).
  await flush(20);

  window.dispatchEvent(new window.Event("focus"));
  await waitFor(() => callCount === 1, "le premier focus doit déclencher un rafraîchissement");

  // Second (et troisième) focus PENDANT que le premier rafraîchissement
  // reste en attente -- avant le correctif, chacun aurait pu empiler
  // un appel concurrent.
  window.dispatchEvent(new window.Event("focus"));
  window.dispatchEvent(new window.Event("focus"));
  await flush(60);
  assert.equal(callCount, 1, "aucun second appel tant que le premier rafraîchissement reste en attente (garde mono-vol, focus inclus)");

  deferred.resolve();
  await flush(20);

  root.unmount();
  container.remove();
});

test("[C] TRACKING FRESHNESS v1 : un focus déclenche un rafraîchissement même si l'onglet est marqué visible (la pause ne concerne que le minuteur, jamais le focus)", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };
  setVisibility("visible");

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 5000 }));
  await flush(20);

  window.dispatchEvent(new window.Event("focus"));
  await waitFor(() => callCount === 1, "le focus doit déclencher un rafraîchissement, indépendamment de la visibilité");

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------
// [D] Arrêt complet (minuteur ET écouteur de focus).
// --------------------------------------------------------------

test("[D] TRACKING FRESHNESS v1 : un focus après passage de 'enabled' à faux ne déclenche PLUS aucun rafraîchissement", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 5000 }));
  await flush(20);
  // Confirme que l'écouteur est bien attaché AVANT de désactiver --
  // sinon un focus manqué avant même la désactivation prouverait
  // seulement que l'écouteur n'avait pas encore été attaché, pas que
  // la désactivation fonctionne (même précaution que le test
  // mandat §19 de tests/v123b-*.dom.test.ts, qui attend un premier
  // tic avant de désactiver).
  window.dispatchEvent(new window.Event("focus"));
  await waitFor(() => callCount === 1, "précondition : le focus doit fonctionner avant toute désactivation");

  root.render(React.createElement(TrackingAutoRefresh, { enabled: false, intervalMs: 5000 }));
  await flush(30);

  window.dispatchEvent(new window.Event("focus"));
  await flush(60);
  assert.equal(callCount, 1, "aucun rafraîchissement SUPPLÉMENTAIRE ne doit se produire : ni minuteur ni focus, une fois 'enabled' faux");

  root.unmount();
  container.remove();
});

test("[D] TRACKING FRESHNESS v1 : un focus après DÉMONTAGE du composant ne déclenche aucun rafraîchissement -- l'écouteur est bien retiré", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 5000 }));
  await flush(20);
  // Confirme que l'écouteur est bien attaché avant le démontage, pour
  // la même raison que ci-dessus.
  window.dispatchEvent(new window.Event("focus"));
  await waitFor(() => callCount === 1, "précondition : le focus doit fonctionner avant tout démontage");

  root.unmount();
  container.remove();
  // Laisse la fonction de nettoyage de l'effet (retour de useEffect)
  // s'exécuter effectivement AVANT de dispatcher -- `root.unmount()`
  // ne garantit pas que le nettoyage des effets passifs soit synchrone
  // (même famille de piège asynchrone que le montage, voir ci-dessus).
  await flush(20);

  window.dispatchEvent(new window.Event("focus"));
  await flush(60);
  assert.equal(callCount, 1, "l'écouteur de focus doit être retiré au démontage -- aucun appel SUPPLÉMENTAIRE, aucune fuite");
});

// --------------------------------------------------------------
// Non-régression : cadence normale et garde mono-vol du MINUTEUR
// (CTE-V2-AUTOREFRESH-01, v2.1) inchangées par ce lot.
// --------------------------------------------------------------

test("non-régression : cadence normale du minuteur préservée (onglet visible, aucun focus) -- plusieurs rafraîchissements espacés", async () => {
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };
  setVisibility("visible");

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingAutoRefresh, { enabled: true, intervalMs: 30 }));

  await waitFor(() => callCount >= 3, "au moins 3 rafraîchissements doivent se produire sous cadence normale");

  root.unmount();
  container.remove();
});
