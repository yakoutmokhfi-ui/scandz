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
// LOT 2B.3 -- preuve comportementale RÉELLE (rendu React dans un vrai
// DOM, appel supabase.rpc réellement intercepté, jamais une lecture
// du fichier source) que la bascule runtime fonctionne :
//   1. le hook usePublicDeliveryInfo appelle bien
//      get_restaurant_public_delivery_info via supabase.rpc()
//      (intercepté par mock, jamais un vrai appel réseau) ;
//   2. les 3 états (loading/loaded/error) sont exposés correctement,
//      dans le bon ordre ;
//   3. aucun état ne présente jamais eligible=true de façon
//      prématurée ou erronée.
//
// Même technique déjà établie dans le projet (esbuild.build() +
// plugin d'alias "@/" + jsdom pour les composants ; t.mock.method sur
// le client Supabase partagé pour intercepter les appels réseau,
// comme tests/v67-product-photos.test.ts).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
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
const { supabase } = await import("../lib/supabase.ts");

const REPO_ROOT = process.cwd();

const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const base = path.join(REPO_ROOT, rel);
      const candidate = ["", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p));
      const resolvedPath = candidate ?? base;
      // lib/supabase.ts DOIT rester externe (jamais bundlé/inliné) :
      // le client Supabase est un singleton PARTAGÉ dans tout le
      // projet -- le mocker (t.mock.method) n'a d'effet que si le
      // code testé importe EXACTEMENT la même instance de module que
      // le test lui-même. Un bundle inlinerait une copie séparée,
      // rendant tout mock inopérant (confirmé empiriquement : sans
      // cette exception, les appels supabase.rpc() du hook
      // atteignaient réellement le réseau au lieu d'être interceptés).
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

// Composant d'essai minimal : appelle le hook et expose son état
// intégral sous forme de texte JSON dans le DOM, pour lecture directe
// après chaque flush() -- jamais une supposition sur le comportement
// interne, une lecture réelle du rendu.
const entrySource = `
import { usePublicDeliveryInfo } from "@/lib/use-public-delivery-info";
export function TestHarness({ restaurantId }: { restaurantId: string }) {
  const { state, data } = usePublicDeliveryInfo(restaurantId);
  return <pre data-testid="harness-output">{JSON.stringify({ state, data })}</pre>;
}
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
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "TestHarness.mjs");
writeFileSync(tmpFile, code);
const { TestHarness } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Attente déterministe par sondage, jamais un compte fixe de flush()
 *  -- même discipline déjà établie dans le projet
 *  (v67b-photo-placeholder.dom.test.ts) pour éviter tout flake lié au
 *  nombre de ticks macrotask réellement nécessaires après une chaîne
 *  de Promises. */
async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 2000,
  intervalMs = 5
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush();
  }
}

function readOutput(container: Element) {
  const pre = container.querySelector('[data-testid="harness-output"]');
  return pre ? JSON.parse(pre.textContent || "{}") : null;
}

test("LOT 2B.3: le hook appelle RÉELLEMENT get_restaurant_public_delivery_info via supabase.rpc (jamais un appel Supabase caché ailleurs), transitionnant loading -> loaded", async (t) => {
  let capturedRpcName: string | undefined;
  let capturedArgs: unknown;
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    capturedRpcName = name;
    capturedArgs = args;
    return {
      data: [{ delivery_zone_prefixes: ["75", "77"], delivery_min_items: 10, delivery_area_label: "Île-de-France" }],
      error: null,
    };
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  root.render(React.createElement(TestHarness, { restaurantId: "r-sanaa" }));
  await flush();
  const beforeLoad = readOutput(container);
  assert.equal(beforeLoad.state.status, "loading", "l'état initial doit être 'loading', jamais 'loaded' avant que la RPC ait répondu");
  assert.equal(beforeLoad.data, null, "aucune donnée éligible ne doit être présentée pendant le chargement");

  await waitFor(() => readOutput(container)?.state?.status === "loaded", "transition vers l'état 'loaded'");
  const afterLoad = readOutput(container);
  assert.equal(afterLoad.state.status, "loaded");
  assert.deepEqual(afterLoad.data, { zonePrefixes: ["75", "77"], minItems: 10, areaLabel: "Île-de-France" });

  assert.equal(capturedRpcName, "get_restaurant_public_delivery_info", "le hook doit appeler EXACTEMENT cette RPC -- preuve que la bascule runtime est réelle");
  assert.deepEqual(capturedArgs, { p_restaurant_id: "r-sanaa" });

  root.unmount();
});

test("LOT 2B.3: erreur RPC -- état 'error', data=null, jamais de crash, jamais de détail technique exposé", async (t) => {
  t.mock.method(supabase, "rpc", async () => {
    throw new Error("panne réseau simulée, message technique interne");
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TestHarness, { restaurantId: "r-error" }));
  await waitFor(() => readOutput(container)?.state?.status === "error", "transition vers l'état 'error'");

  const output = readOutput(container);
  assert.equal(output.state.status, "error");
  assert.equal(output.data, null, "aucune livraison éligible ne doit jamais être présentée en cas d'erreur");
  assert.ok(!container.innerHTML.includes("panne réseau simulée"), "aucun détail technique de l'erreur ne doit apparaître dans le rendu");

  root.unmount();
});

test("LOT 2B.3: PublicDeliveryInfo = null (mode delivery non configuré/désactivé) -- état 'loaded', data=null, jamais une exception", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TestHarness, { restaurantId: "r-no-delivery" }));
  await waitFor(() => readOutput(container)?.state?.status === "loaded", "transition vers l'état 'loaded' (aucune configuration livraison)");

  const output = readOutput(container);
  assert.equal(output.state.status, "loaded");
  assert.equal(output.data, null);

  root.unmount();
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
