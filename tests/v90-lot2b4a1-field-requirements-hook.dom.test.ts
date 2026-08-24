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
// LOT 2B.4a.1 -- preuve comportementale RÉELLE (rendu React dans un
// vrai DOM, appel supabase.rpc réellement intercepté, jamais une
// lecture du fichier source) du hook usePublicFieldRequirements :
//   1. appelle bien get_restaurant_public_field_requirements via
//      supabase.rpc() (intercepté par mock, jamais un vrai appel
//      réseau) ;
//   2. les 3 états (loading/loaded/error) sont exposés correctement,
//      dans le bon ordre, y compris loaded([]) distinct de loading
//      et de error ;
//   3. changement de restaurantId ou de modeCode -> nouvelle requête,
//      repasse par "loading" avant "loaded" ;
//   4. unmount avant résolution -- aucune mise à jour d'état après
//      démontage (aucun avertissement React), aucun crash.
//
// Même technique déjà établie dans le projet (esbuild.build() +
// plugin d'alias "@/" + jsdom ; t.mock.method sur le client Supabase
// partagé -- voir tests/v88-lot2b3-runtime-switch.dom.test.ts, dont
// ce fichier reprend le patron pour un nouveau hook indépendant).
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
      // lib/supabase.ts DOIT rester externe (jamais bundlé/inliné) --
      // même raison exacte que v88-lot2b3-runtime-switch.dom.test.ts :
      // le client Supabase est un singleton PARTAGÉ, le mock
      // (t.mock.method) n'a d'effet que si le code testé importe
      // EXACTEMENT la même instance de module que le test lui-même.
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v90-"));
const tmpFile = path.join(tmpDir, "TestHarness.mjs");
writeFileSync(tmpFile, code);
const { TestHarness } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Attente déterministe par sondage, jamais un compte fixe de flush()
 *  -- même discipline déjà établie dans le projet
 *  (v67b-photo-placeholder.dom.test.ts, v88-lot2b3-runtime-switch.dom.test.ts). */
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

const DELIVERY_REQUIREMENTS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "delivery_address", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
  { field: "email", requirement: "optional", one_of_group: null },
];

const PICKUP_REQUIREMENTS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "one_of", one_of_group: "contact" },
  { field: "email", requirement: "one_of", one_of_group: "contact" },
];

test("LOT 2B.4a.1: le hook appelle RÉELLEMENT get_restaurant_public_field_requirements via supabase.rpc (jamais un appel caché ailleurs), transitionnant loading -> loaded, avec le vrai catalogue delivery (customer_name/delivery_address/phone required, email optional)", async (t) => {
  let capturedRpcName: string | undefined;
  let capturedArgs: unknown;
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    capturedRpcName = name;
    capturedArgs = args;
    return { data: DELIVERY_REQUIREMENTS, error: null };
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  root.render(React.createElement(TestHarness, { restaurantId: "r-sanaa", modeCode: "delivery" }));
  await flush();
  const beforeLoad = readOutput(container);
  assert.equal(beforeLoad.state.status, "loading", "l'état initial doit être 'loading', jamais 'loaded' avant que la RPC ait répondu");
  assert.equal(beforeLoad.data, null, "aucune exigence ne doit être présentée pendant le chargement");

  await waitFor(() => readOutput(container)?.state?.status === "loaded", "transition vers l'état 'loaded'");
  const afterLoad = readOutput(container);
  assert.equal(afterLoad.state.status, "loaded");
  assert.equal(afterLoad.data.length, 4);
  assert.deepEqual(
    afterLoad.data.map((r: any) => [r.field, r.requirement]),
    [
      ["customer_name", "required"],
      ["delivery_address", "required"],
      ["phone", "required"],
      ["email", "optional"],
    ]
  );

  assert.equal(capturedRpcName, "get_restaurant_public_field_requirements", "le hook doit appeler EXACTEMENT cette RPC");
  assert.deepEqual(capturedArgs, { p_restaurant_id: "r-sanaa", p_mode_code: "delivery" });

  root.unmount();
});

test("LOT 2B.4a.1: loaded([]) -- réponse métier valide, distincte de loading et de error", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TestHarness, { restaurantId: "r-no-reqs", modeCode: "table" }));
  await waitFor(() => readOutput(container)?.state?.status === "loaded", "transition vers l'état 'loaded' (tableau vide)");

  const output = readOutput(container);
  assert.equal(output.state.status, "loaded");
  assert.deepEqual(output.data, [], "loaded([]) doit rester un tableau, jamais null ni undefined");
  assert.notEqual(output.state.status, "error");

  root.unmount();
});

test("LOT 2B.4a.1: erreur RPC -- état 'error', data=null, jamais de crash, jamais de détail technique exposé", async (t) => {
  t.mock.method(supabase, "rpc", async () => {
    throw new Error("panne réseau simulée, message technique interne");
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TestHarness, { restaurantId: "r-error", modeCode: "delivery" }));
  await waitFor(() => readOutput(container)?.state?.status === "error", "transition vers l'état 'error'");

  const output = readOutput(container);
  assert.equal(output.state.status, "error");
  assert.equal(output.data, null, "aucune exigence ne doit jamais être présentée en cas d'erreur");
  assert.ok(!container.innerHTML.includes("panne réseau simulée"), "aucun détail technique de l'erreur ne doit apparaître dans le rendu");

  root.unmount();
});

test("LOT 2B.4a.1: changement de restaurantId -- nouvelle requête, repasse par 'loading', données du nouvel établissement uniquement", async (t) => {
  // Promesses contrôlées manuellement (jamais une résolution
  // immédiate) : élimine toute course entre la micro-tâche de
  // résolution du mock et la macro-tâche flush(). `calls` est poussé
  // SYNCHRONEMENT dès l'invocation du mock (avant tout await) --
  // attendre calls.length via waitFor() est donc la seule preuve
  // fiable que l'effet a réellement démarré une nouvelle requête,
  // plutôt que de supposer un nombre fixe de flush() nécessaires
  // (l'expérimentation directe montre que ce nombre varie selon que
  // le rendu est le montage initial ou un re-rendu -- jamais supposé
  // ici, uniquement constaté via waitFor).
  const calls: unknown[] = [];
  const resolvers: Array<(v: { data: unknown; error: null }) => void> = [];
  t.mock.method(supabase, "rpc", async (_name: string, args: unknown) => {
    calls.push(args);
    return new Promise((resolve) => resolvers.push(resolve));
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  try {
    root.render(React.createElement(TestHarness, { restaurantId: "r-a", modeCode: "pickup" }));
    await waitFor(() => calls.length === 1, "premier appel RPC déclenché (r-a)");
    assert.equal(readOutput(container).state.status, "loading", "loading tant que le premier appel n'est pas résolu");
    resolvers[0]({ data: [{ field: "customer_name", requirement: "required", one_of_group: null }], error: null });
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "premier chargement (r-a)");
    assert.deepEqual(readOutput(container).data.map((r: any) => r.field), ["customer_name"]);

    root.render(React.createElement(TestHarness, { restaurantId: "r-b", modeCode: "pickup" }));
    await waitFor(() => calls.length === 2, "second appel RPC déclenché (r-b)");
    // calls.length passe à 2 dès l'appel synchrone à supabase.rpc() à
    // l'intérieur de l'effet -- mais le setState("loading") qui le
    // précède dans l'effet peut ne pas encore avoir été committé au
    // DOM à cet instant précis (rendu React asynchrone). Attendre
    // EN PLUS explicitement l'état "loading" dans le DOM (jamais un
    // flush() supplémentaire au nombre supposé à l'avance) élimine
    // cette course, sans jamais pouvoir masquer un vrai passage direct
    // à "loaded" : resolvers[1] n'est appelé nulle part avant cette
    // attente, donc "loaded" ne peut pas apparaître prématurément ici.
    await waitFor(() => readOutput(container)?.state?.status === "loading", "commit DOM de l'état 'loading' après changement de restaurantId");
    assert.equal(readOutput(container).state.status, "loading", "le changement de restaurantId doit remettre l'état à 'loading', jamais garder l'ancienne donnée affichée comme si elle était encore valide");
    assert.equal(readOutput(container).data, null, "aucune ancienne donnée ne doit rester exposée pendant le rechargement");

    resolvers[1]({ data: [{ field: "phone", requirement: "required", one_of_group: null }], error: null });
    await waitFor(() => readOutput(container)?.data?.[0]?.field === "phone", "second chargement (r-b)");
    const finalOutput = readOutput(container);
    assert.equal(finalOutput.state.status, "loaded");
    assert.deepEqual(finalOutput.data.map((r: any) => r.field), ["phone"]);

    assert.equal(calls.length, 2, "exactement 2 appels RPC -- un par restaurantId distinct, jamais de requête superflue");
    assert.deepEqual(calls[0], { p_restaurant_id: "r-a", p_mode_code: "pickup" });
    assert.deepEqual(calls[1], { p_restaurant_id: "r-b", p_mode_code: "pickup" });
  } finally {
    // Toujours démonter, même si une assertion échoue -- un root non
    // démonté laisserait un effet en attente susceptible de perturber
    // le minutage des tests suivants (constaté empiriquement).
    root.unmount();
  }
});

test("LOT 2B.4a.1: changement de modeCode (même restaurant) -- nouvelle requête, repasse par 'loading'", async (t) => {
  const calls: unknown[] = [];
  const resolvers: Array<(v: { data: unknown; error: null }) => void> = [];
  t.mock.method(supabase, "rpc", async (_name: string, args: unknown) => {
    calls.push(args);
    return new Promise((resolve) => resolvers.push(resolve));
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  try {
    root.render(React.createElement(TestHarness, { restaurantId: "r-sanaa", modeCode: "pickup" }));
    await waitFor(() => calls.length === 1, "premier appel RPC déclenché (pickup)");
    assert.equal(readOutput(container).state.status, "loading");
    resolvers[0]({ data: PICKUP_REQUIREMENTS, error: null });
    await waitFor(() => readOutput(container)?.state?.status === "loaded", "premier chargement (pickup)");
    assert.equal(readOutput(container).data.length, 3);

    root.render(React.createElement(TestHarness, { restaurantId: "r-sanaa", modeCode: "delivery" }));
    await waitFor(() => calls.length === 2, "second appel RPC déclenché (delivery)");
    // Voir le commentaire équivalent du test "changement de
    // restaurantId" -- même élimination de course entre calls.length
    // (synchrone) et le commit DOM réel de l'état "loading".
    await waitFor(() => readOutput(container)?.state?.status === "loading", "commit DOM de l'état 'loading' après changement de modeCode");
    assert.equal(readOutput(container).state.status, "loading", "le changement de modeCode doit remettre l'état à 'loading'");

    resolvers[1]({ data: DELIVERY_REQUIREMENTS, error: null });
    await waitFor(() => readOutput(container)?.data?.length === 4, "second chargement (delivery)");
    assert.deepEqual(readOutput(container).data.map((r: any) => r.field), ["customer_name", "delivery_address", "phone", "email"]);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { p_restaurant_id: "r-sanaa", p_mode_code: "pickup" });
    assert.deepEqual(calls[1], { p_restaurant_id: "r-sanaa", p_mode_code: "delivery" });
  } finally {
    root.unmount();
  }
});

test("LOT 2B.4a.1: unmount avant résolution de la RPC -- aucune mise à jour d'état après démontage, aucun avertissement React, aucun crash", async (t) => {
  let resolveRpc: (v: { data: unknown; error: null }) => void;
  const pending = new Promise((resolve) => {
    resolveRpc = resolve;
  });
  t.mock.method(supabase, "rpc", async () => pending);

  const originalConsoleError = console.error;
  const capturedErrors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    capturedErrors.push(args);
  };

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TestHarness, { restaurantId: "r-race", modeCode: "delivery" }));
  await flush();
  assert.equal(readOutput(container).state.status, "loading");

  // Démontage AVANT que la promesse de la RPC ne se résolve --
  // reproduit exactement la condition de course que le flag
  // `cancelled` du hook (identique au patron LOT 2B.3) doit couvrir.
  root.unmount();
  resolveRpc!({ data: DELIVERY_REQUIREMENTS, error: null });
  await flush();
  await flush();

  console.error = originalConsoleError;

  const reactStateWarning = capturedErrors.some((args) =>
    (args as unknown[]).some((a) => typeof a === "string" && a.includes("unmounted component"))
  );
  assert.equal(reactStateWarning, false, "aucun avertissement React de mise à jour d'état sur composant démonté ne doit être émis");
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
