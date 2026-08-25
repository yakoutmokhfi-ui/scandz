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
// FULFILLMENT ROUTING LOT C — preuve comportementale RÉELLE (rendu
// React dans un vrai DOM, appel supabase.rpc réellement intercepté,
// jamais une lecture du fichier source) du hook
// usePublicDeliveryFulfillments :
//   1. il appelle bien get_restaurant_public_delivery_fulfillments via
//      supabase.rpc() (jamais un accès direct table) ;
//   2. les 3 états (loading/loaded/error) sont exposés correctement ;
//   3. mission §5 -- protection restaurantId : au premier rendu suivant
//      un changement de restaurantId, AVANT toute résolution async,
//      l'état est IMMÉDIATEMENT loading -- jamais les anciennes règles
//      exposées sous la nouvelle clé (même patron et même preuve que
//      L2B4A1-01, lib/use-public-field-requirements.ts).
//
// Même technique déjà établie dans le projet (esbuild.build() + plugin
// d'alias "@/" + jsdom + t.mock.method sur le client Supabase partagé).
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
const { flushSync } = await import("react-dom");
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
      // lib/supabase.ts DOIT rester externe -- singleton partagé,
      // requis pour que t.mock.method ait un effet réel (même raison
      // documentée dans tous les tests DOM du projet).
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

const entrySource = `
import { usePublicDeliveryFulfillments } from "@/lib/use-public-delivery-fulfillments";
export function TestHarness({ restaurantId }: { restaurantId: string }) {
  const { state, data } = usePublicDeliveryFulfillments(restaurantId);
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-lotc-hook-"));
const tmpFile = path.join(tmpDir, "TestHarness.mjs");
writeFileSync(tmpFile, code);
const { TestHarness } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

test("LOT C: le hook appelle RÉELLEMENT get_restaurant_public_delivery_fulfillments via supabase.rpc (jamais un accès direct table), transitionnant loading -> loaded avec des règles non vides", async (t) => {
  let capturedRpcName: string | undefined;
  let capturedArgs: unknown;
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    capturedRpcName = name;
    capturedArgs = args;
    return {
      data: [
        {
          fulfillment_code: "local_delivery_75",
          zone_prefixes: ["75", "77"],
          is_fallback: false,
          min_items: 2,
          customer_text: "Livraison locale le jour même",
          display_order: 0,
        },
      ],
      error: null,
    };
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  root.render(React.createElement(TestHarness, { restaurantId: "r-migrated" }));
  await flush();
  const beforeLoad = readOutput(container);
  assert.equal(beforeLoad.state.status, "loading", "l'état initial doit être 'loading', jamais 'loaded' avant que la RPC ait répondu");
  assert.equal(beforeLoad.data, null, "aucune règle ne doit être présentée pendant le chargement");

  await waitFor(() => readOutput(container)?.state?.status === "loaded", "transition vers l'état 'loaded'");
  const afterLoad = readOutput(container);
  assert.equal(afterLoad.state.status, "loaded");
  assert.deepEqual(afterLoad.data, [
    {
      fulfillmentCode: "local_delivery_75",
      zonePrefixes: ["75", "77"],
      isFallback: false,
      minItems: 2,
      customerText: "Livraison locale le jour même",
      displayOrder: 0,
    },
  ]);

  assert.equal(capturedRpcName, "get_restaurant_public_delivery_fulfillments", "le hook doit appeler EXACTEMENT cette RPC");
  assert.deepEqual(capturedArgs, { p_restaurant_id: "r-migrated" });

  root.unmount();
});

test("LOT C: établissement de référence non-migré (tableau VIDE, style Sanaa) -- état 'loaded', data=[] (jamais null, jamais une exception) -- déclenche le pont de migration vers le chemin legacy", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TestHarness, { restaurantId: "r-legacy-sanaa-like" }));
  await waitFor(() => readOutput(container)?.state?.status === "loaded", "transition vers l'état 'loaded' (aucune règle migrée)");

  const output = readOutput(container);
  assert.equal(output.state.status, "loaded");
  assert.deepEqual(output.data, [], "un tableau VIDE est une réponse métier valide et POSITIVEMENT connue -- jamais confondue avec loading/error");

  root.unmount();
});

test("LOT C: erreur RPC -- état 'error', data=null, jamais de crash, jamais de détail technique exposé, jamais un déguisement en 'aucune règle constatée'", async (t) => {
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
  assert.equal(output.data, null, "aucune règle ne doit jamais être exposée en cas d'erreur");
  assert.ok(!container.innerHTML.includes("panne réseau simulée"), "aucun détail technique de l'erreur ne doit apparaître dans le rendu");

  root.unmount();
});

test("LOT C (mission §5, race-safety L2B4A1-01): au premier rendu suivant un changement de restaurantId, AVANT toute résolution async, l'état est IMMÉDIATEMENT loading/data:null -- jamais les anciennes règles exposées sous la nouvelle clé", async (t) => {
  const resolvers: Array<(v: { data: unknown; error: null }) => void> = [];
  const calls: unknown[] = [];
  t.mock.method(supabase, "rpc", async (_name: string, args: unknown) => {
    calls.push(args);
    return new Promise((resolve) => resolvers.push(resolve));
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  try {
    // 1. Monter avec le restaurant A.
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-a" }));
    });
    await waitFor(() => calls.length === 1, "premier appel RPC déclenché (r-a)");
    resolvers[0]({
      data: [
        {
          fulfillment_code: "local_delivery_a",
          zone_prefixes: ["75"],
          is_fallback: false,
          min_items: 1,
          customer_text: "Livraison A",
          display_order: 0,
        },
      ],
      error: null,
    });
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "loaded(A)");
    const loadedA = readOutput(container);
    assert.equal(loadedA.data[0].fulfillmentCode, "local_delivery_a");

    // 2. Changer IMMÉDIATEMENT vers le restaurant B, via flushSync pour
    // forcer le rendu+commit DOM synchrone.
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-b" }));
    });

    // 3. Inspection DU PREMIER RENDU, SANS AUCUNE ATTENTE -- la
    // promesse RPC pour B n'a volontairement PAS encore été résolue.
    const firstRenderAfterKeyChange = readOutput(container);
    assert.equal(
      firstRenderAfterKeyChange.state.status,
      "loading",
      "le premier rendu suivant le changement de restaurantId doit être 'loading', jamais l'ancien 'loaded' -- avant toute attente, avant toute résolution de l'effet"
    );
    assert.equal(firstRenderAfterKeyChange.data, null, "aucune règle ne doit être exposée pendant cette fenêtre");
    assert.notDeepEqual(
      firstRenderAfterKeyChange.data,
      loadedA.data,
      "les règles de r-a ne doivent jamais réapparaître sous r-b"
    );

    // Complète le scénario : B se résout correctement ensuite.
    await waitFor(() => calls.length === 2, "second appel RPC déclenché (r-b)");
    resolvers[1]({ data: [], error: null });
    await waitFor(() => Array.isArray(readOutput(container)?.data), "loaded(B)");
    assert.deepEqual(readOutput(container).data, []);
  } finally {
    root.unmount();
  }
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
