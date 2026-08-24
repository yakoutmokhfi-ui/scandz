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
// AU LAIT CRU — CASE 1A -- test dédié au finding ALC-SM-01 (audit
// Work, HIGH) : "usePublicSaleModes() conserve potentiellement les
// modes d'un ancien tenant au premier rendu après changement de
// restaurantId."
//
// Reproduit EXACTEMENT le scénario minimal de la mission, en miroir
// direct de la méthode déjà auditée pour L2B4A1-01
// (tests/v90-lot2b4a1-l2b4a1-01-fail-closed-key-change.dom.test.ts) :
//   1. monter le hook avec restaurantId A ;
//   2. attendre loaded(modes A) ;
//   3. changer IMMÉDIATEMENT les props vers restaurantId B ;
//   4. inspecter LE PREMIER RENDU après ce changement, SANS AUCUNE
//      ATTENTE (flushSync, jamais flush()/waitFor()/setTimeout) ;
//   5. vérifier que l'état exposé est IMMÉDIATEMENT loading/data:null,
//      jamais l'ancien loaded(A) ;
//   6. vérifier que canAttemptToSelectSaleMode(...) est false pendant
//      cette fenêtre.
//
// Un second test couvre la protection complémentaire, explicitement
// demandée par la mission : réponses asynchrones dans le désordre
// (A démarre, B démarre avant que A ne réponde, A répond enfin après)
// -- A ne doit JAMAIS écraser l'état déjà posé pour B.
//
// Méthode de preuve identique à L2B4A1-01 : flushSync() (react-dom)
// pour forcer le rendu+commit DOM synchrone, puis lecture IMMÉDIATE,
// dans la même portion de code synchrone -- la seule façon de prouver
// "dès le rendu courant" plutôt que "finit par apparaître" (que
// l'ancienne implémentation, corrigée par ALC-SM-01, aurait aussi fini
// par satisfaire via useEffect, en violation du contrat fail-closed
// pour la fenêtre concernée).
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
const { canAttemptToSelectSaleMode } = await import("../lib/use-public-sale-modes.ts");

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
      // autres tests DOM du projet (singleton partagé, requis pour que
      // t.mock.method ait un effet réel).
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

const entrySource = `
import { usePublicSaleModes } from "@/lib/use-public-sale-modes";
export function TestHarness({ restaurantId }: { restaurantId: string }) {
  const { state, data } = usePublicSaleModes(restaurantId);
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-alcsm01-"));
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

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];

function saleModeRow(modeCode: string) {
  return {
    mode_code: modeCode,
    customer_text: null,
    pricing_mode: "free",
    fixed_fee: null,
    free_threshold: null,
    delay_value: null,
    delay_unit: null,
  };
}

/** Mocke supabase.from("sale_mode_catalog") (immédiat, requis par
 *  getPublicSaleModes()) et supabase.rpc("get_restaurant_public_sale_modes")
 *  (contrôlé manuellement via les resolvers renvoyés, un par appel,
 *  dans l'ordre des appels). */
function mockDeferredRpc(t: { mock: { method: Function } }) {
  const resolvers: Array<(v: { data: unknown; error: null }) => void> = [];
  const calls: unknown[] = [];
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name !== "get_restaurant_public_sale_modes") {
      throw new Error(`RPC inattendue dans ce test : ${name}`);
    }
    calls.push(args);
    return new Promise((resolve) => resolvers.push(resolve));
  });
  return { resolvers, calls };
}

test("ALC-SM-01: au premier rendu suivant un changement de restaurantId, AVANT toute résolution async, l'état est IMMÉDIATEMENT loading/data:null -- jamais l'ancien loaded(modes A)", async (t) => {
  const { resolvers, calls } = mockDeferredRpc(t);

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  try {
    // 1. Monter avec restaurantId A.
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-a" }));
    });
    await waitFor(() => calls.length === 1, "premier appel RPC déclenché (r-a)");
    resolvers[0]({ data: [saleModeRow("table")], error: null });

    // 2. Attendre loaded(A).
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "loaded(A)");
    const loadedA = readOutput(container);
    assert.equal(loadedA.state.status, "loaded");
    assert.deepEqual(loadedA.data.map((m: any) => m.code), ["table"]);
    assert.equal(canAttemptToSelectSaleMode(loadedA.state), true);

    // 3. Changer IMMÉDIATEMENT les props vers restaurantId B, via
    // flushSync pour forcer le rendu+commit DOM synchrone.
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-b" }));
    });

    // 4-5. Inspection DU PREMIER RENDU, IMMÉDIATEMENT après
    // flushSync(), SANS AUCUNE ATTENTE -- la promesse RPC pour B n'a
    // volontairement PAS encore été résolue, donc quoi que ce rendu
    // expose, ce ne peut être qu'un reliquat de l'ancien état (bug) ou
    // l'état correctement réinitialisé (correctif) -- jamais une
    // donnée réelle de B.
    const firstRenderAfterKeyChange = readOutput(container);

    assert.equal(
      firstRenderAfterKeyChange.state.status,
      "loading",
      "ALC-SM-01: le premier rendu suivant le changement de restaurantId doit être 'loading', jamais l'ancien 'loaded' -- avant toute attente, avant toute résolution de l'effet"
    );
    assert.equal(
      firstRenderAfterKeyChange.data,
      null,
      "ALC-SM-01: aucune donnée ne doit être exposée pendant cette fenêtre"
    );
    assert.notDeepEqual(
      firstRenderAfterKeyChange.data,
      loadedA.data,
      "ALC-SM-01: les modes de r-a (table) ne doivent jamais réapparaître sous r-b"
    );
    assert.equal(
      canAttemptToSelectSaleMode(firstRenderAfterKeyChange.state),
      false,
      "ALC-SM-01: canAttemptToSelectSaleMode() ne doit jamais retourner true pour une clé dont la requête n'est pas encore résolue"
    );

    // Complète le scénario : B se résout correctement ensuite.
    await waitFor(() => calls.length === 2, "second appel RPC déclenché (r-b)");
    resolvers[1]({ data: [saleModeRow("pickup"), saleModeRow("delivery")], error: null });
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "loaded(B)");
    const loadedB = readOutput(container);
    assert.deepEqual(loadedB.data.map((m: any) => m.code), ["pickup", "delivery"]);
    assert.equal(canAttemptToSelectSaleMode(loadedB.state), true);
  } finally {
    root.unmount();
  }
});

test("ALC-SM-01 (réponses async dans le désordre) : A démarre, B démarre avant que A ne réponde, A répond enfin après -- A ne doit JAMAIS écraser l'état déjà posé pour B", async (t) => {
  const { resolvers, calls } = mockDeferredRpc(t);

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  try {
    // A démarre.
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-a" }));
    });
    await waitFor(() => calls.length === 1, "appel RPC pour r-a déclenché");

    // B démarre AVANT que A n'ait répondu (A reste "en vol").
    flushSync(() => {
      root.render(React.createElement(TestHarness, { restaurantId: "r-b" }));
    });
    await waitFor(() => calls.length === 2, "appel RPC pour r-b déclenché, alors que r-a n'a toujours pas répondu");

    // B répond en premier.
    resolvers[1]({ data: [saleModeRow("pickup")], error: null });
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "loaded(B)");
    const afterB = readOutput(container);
    assert.deepEqual(afterB.data.map((m: any) => m.code), ["pickup"]);

    // A répond ENFIN, après B -- ne doit JAMAIS écraser l'état déjà
    // posé pour B (l'effet de A a été nettoyé -- `cancelled` -- au
    // moment où restaurantId est passé à "r-b").
    resolvers[0]({ data: [saleModeRow("table")], error: null });
    await flush();
    await flush();

    const afterLateA = readOutput(container);
    assert.equal(afterLateA.state.status, "loaded", "l'état reste résolu (loaded), la réponse tardive de A ne doit jamais le faire régresser");
    assert.deepEqual(
      afterLateA.data.map((m: any) => m.code),
      ["pickup"],
      "ALC-SM-01: la réponse tardive de r-a (table) ne doit JAMAIS écraser l'état déjà posé pour r-b (pickup)"
    );
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
