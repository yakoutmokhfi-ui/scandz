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
// LOT 2B.4a.1 v2 -- test dédié au finding L2B4A1-01 (audit Work,
// HIGH) : "le hook usePublicFieldRequirements conserve l'ancien état
// dans useState ; lors d'un changement de restaurantId/modeCode, le
// PREMIER RENDU suivant le changement peut encore exposer l'ancien
// état loaded (données d'un AUTRE restaurant/mode), le passage à
// loading n'arrivant qu'ensuite via useEffect."
//
// Reproduit EXACTEMENT le scénario minimal de la mission :
//   1. monter le hook avec clé A ;
//   2. attendre loaded(A) ;
//   3. changer immédiatement les props vers clé B ;
//   4. inspecter LE PREMIER RENDU après ce changement ;
//   5. AVANT que le nouvel effet async n'ait résolu B ;
//   6. vérifier que l'état exposé est IMMÉDIATEMENT loading/data:null ;
//   7. vérifier que les données A ne sont JAMAIS exposées sous la clé B ;
//   8. vérifier que canAttemptSubmit(...) est false pendant cette fenêtre.
//
// Méthode de preuve -- AUCUNE attente (ni flush(), ni waitFor(), ni
// setTimeout) entre le déclenchement du changement de props et
// l'inspection : le changement de props passe par flushSync() (React,
// react-dom) pour forcer le rendu+commit DOM à se produire de façon
// synchrone, PUIS la sortie est lue IMMÉDIATEMENT, dans la même
// portion de code synchrone, avant tout retour à la boucle
// d'événements. C'est la seule façon de prouver "dès le rendu
// courant, avant l'exécution du nouvel effet" plutôt que "loading
// finit par apparaître" (que l'ancienne implémentation aurait aussi
// fini par satisfaire, via useEffect, en violation du contrat
// fail-closed pour la fenêtre concernée). Confirmé expérimentalement
// que ce test échoue sur l'implémentation précédente (état "loaded"
// de la clé A encore présent à cet instant précis) et passe sur la
// version corrigée -- voir RAPPORT.md, section "Preuve avant/après".
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
const { canAttemptSubmit } = await import("../lib/use-public-field-requirements.ts");

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
      // lib/supabase.ts DOIT rester externe -- même raison que les
      // autres tests DOM du projet (singleton partagé, requis pour
      // que t.mock.method ait un effet réel).
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

const entrySource = `
import { usePublicFieldRequirements } from "@/lib/use-public-field-requirements";
export function TestHarness({ restaurantId, modeCode }: { restaurantId: string; modeCode: string }) {
  const { state, data } = usePublicFieldRequirements(restaurantId, modeCode);
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-l2b4a101-"));
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
  timeoutMs = 2000
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

test("L2B4A1-01: au premier rendu suivant un changement de restaurantId, AVANT toute résolution async, l'état est IMMÉDIATEMENT loading/data:null -- jamais l'ancien loaded(A)", async (t) => {
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
    // 1. Monter avec clé A (r-a / pickup).
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-a", modeCode: "pickup" }));
    });
    await waitFor(() => calls.length === 1, "premier appel RPC déclenché (r-a)");
    resolvers[0]({
      data: [{ field: "customer_name", requirement: "required", one_of_group: null }],
      error: null,
    });
    // 2. Attendre loaded(A).
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "loaded(A)");
    const loadedA = readOutput(container);
    assert.equal(loadedA.state.status, "loaded");
    assert.deepEqual(loadedA.data.map((r: any) => r.field), ["customer_name"]);
    assert.equal(canAttemptSubmit(loadedA.state), true);

    // 3. Changer IMMÉDIATEMENT les props vers clé B (r-b / pickup),
    // via flushSync pour forcer le rendu+commit DOM synchrone.
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-b", modeCode: "pickup" }));
    });

    // 4-5. Inspection DU PREMIER RENDU, IMMÉDIATEMENT après
    // flushSync(), SANS AUCUNE ATTENTE (ni flush(), ni waitFor(), ni
    // setTimeout) -- la promesse RPC pour B n'a volontairement PAS
    // encore été résolue (resolvers[1] n'existe peut-être même pas
    // encore), donc quoi que ce rendu expose, ce ne peut être qu'un
    // reliquat de l'ancien état (bug) ou l'état correctement
    // réinitialisé (correctif) -- jamais une donnée réelle de B.
    const firstRenderAfterKeyChange = readOutput(container);

    // 6. L'état exposé doit être IMMÉDIATEMENT loading/data:null.
    assert.equal(
      firstRenderAfterKeyChange.state.status,
      "loading",
      "L2B4A1-01: le premier rendu suivant le changement de restaurantId doit être 'loading', jamais l'ancien 'loaded' -- avant toute attente, avant toute résolution de l'effet"
    );
    assert.equal(
      firstRenderAfterKeyChange.data,
      null,
      "L2B4A1-01: aucune donnée ne doit être exposée pendant cette fenêtre"
    );

    // 7. Les données de A ne sont JAMAIS exposées sous la clé B.
    assert.notDeepEqual(
      firstRenderAfterKeyChange.data,
      loadedA.data,
      "L2B4A1-01: les exigences de r-a (customer_name) ne doivent jamais réapparaître sous r-b"
    );

    // 8. canAttemptSubmit(...) est false pendant cette fenêtre --
    // preuve directe que le contrat fail-closed n'est jamais rompu,
    // pas seulement que l'état "a l'air" correct.
    assert.equal(
      canAttemptSubmit(firstRenderAfterKeyChange.state),
      false,
      "L2B4A1-01: canAttemptSubmit() ne doit jamais retourner true pour une clé dont la requête n'est pas encore résolue"
    );

    // Complète le scénario : B se résout correctement ensuite, sans
    // que rien de ce qui précède n'ait été contourné.
    await waitFor(() => calls.length === 2, "second appel RPC déclenché (r-b)");
    resolvers[1]({
      data: [{ field: "phone", requirement: "required", one_of_group: null }],
      error: null,
    });
    await waitFor(() => readOutput(container)?.data?.[0]?.field === "phone", "loaded(B)");
    assert.equal(canAttemptSubmit(readOutput(container).state), true);
  } finally {
    root.unmount();
  }
});

test("L2B4A1-01 (variante modeCode): au premier rendu suivant un changement de modeCode (même restaurant), AVANT toute résolution async, l'état est IMMÉDIATEMENT loading/data:null", async (t) => {
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
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-sanaa", modeCode: "pickup" }));
    });
    await waitFor(() => calls.length === 1, "premier appel RPC déclenché (pickup)");
    resolvers[0]({
      data: [
        { field: "customer_name", requirement: "required", one_of_group: null },
        { field: "phone", requirement: "one_of", one_of_group: "contact" },
        { field: "email", requirement: "one_of", one_of_group: "contact" },
      ],
      error: null,
    });
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "loaded(pickup)");
    const loadedPickup = readOutput(container);
    assert.equal(loadedPickup.data.length, 3);

    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-sanaa", modeCode: "delivery" }));
    });
    const firstRenderAfterModeChange = readOutput(container);

    assert.equal(firstRenderAfterModeChange.state.status, "loading", "L2B4A1-01 (modeCode): doit être 'loading' immédiatement, jamais l'ancien 'loaded' de pickup");
    assert.equal(firstRenderAfterModeChange.data, null);
    assert.equal(canAttemptSubmit(firstRenderAfterModeChange.state), false);
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
