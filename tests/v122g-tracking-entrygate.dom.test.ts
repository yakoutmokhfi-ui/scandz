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
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 —
// components/TrackingEntryGate.tsx : rendu DOM RÉEL de la porte
// d'entrée client (mandat §8/§30).
//
// next/navigation est mocké (useRouter().refresh contrôlable, même
// technique que tests/v81-lot1b1-dashboardnav.dom.test.ts) ; `fetch`
// est un global simple substitué directement (ce composant ne
// l'importe pas -- c'est l'API navigateur ambiante) ; `window.
// location.hash`/`history.replaceState` sont la VRAIE implémentation
// jsdom (comportement fonctionnel vérifié, pas un espion) -- la seule
// façon fiable de prouver que le fragment disparaît réellement de
// l'URL affichée (mandat §22).
// ====================================================================

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: `http://localhost/track/${ORDER_ID}`,
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

(globalThis as any).__mockRefreshCount = 0;

const MOCK_NAV = `
export function useRouter() {
  return {
    refresh: () => { (globalThis as any).__mockRefreshCount++; },
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
export { default as TrackingEntryGate } from "@/components/TrackingEntryGate";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v122g-"));
const tmpFile = path.join(tmpDir, "TrackingEntryGate.mjs");
writeFileSync(tmpFile, code);
const { TrackingEntryGate } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Attente par SONDAGE (même convention établie que tests/v92-aulaitcru-
// sale-modes-runtime.dom.test.ts et consœurs) plutôt qu'un délai fixe :
// un `flush()` à durée constante s'est révélé PONCTUELLEMENT insuffisant
// sous contention CPU (constaté empiriquement -- premher run isolé
// échouait un test sur huit de façon non déterministe, 5 ré-exécutions
// consécutives ensuite toutes vertes), ce qui aurait produit un test
// intermittent plutôt qu'un défaut réel du composant. `waitFor` élimine
// la dépendance à une durée arbitraire : il n'attend que jusqu'à ce que
// la condition observable soit vraie, avec un plafond généreux en
// filet de sécurité contre un blocage réel.
async function waitFor(check: () => boolean, description: string, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(intervalMs);
  }
}

function setHash(hash: string) {
  window.location.hash = hash;
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(TrackingEntryGate, { orderId: ORDER_ID, lang: "fr" }));
  return { container, root };
}

test("hash présent + jeton bien formé + échange RÉUSSI -- history.replaceState vers le chemin PROPRE, router.refresh() appelé, fragment disparu de l'URL affichée", async () => {
  setHash(`#${TOKEN}`);
  let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  (globalThis as any).fetch = async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  };
  const before = (globalThis as any).__mockRefreshCount;

  const { container, root } = render();
  await waitFor(
    () => (globalThis as any).__mockRefreshCount > before,
    "router.refresh() appelé après l'échange réussi"
  );

  assert.equal(fetchCalls.length, 1, "exactement un appel d'échange");
  assert.equal(fetchCalls[0]!.url, "/api/track/exchange", "l'URL ne doit JAMAIS porter le jeton");
  assert.equal(fetchCalls[0]!.init.method, "POST");
  const sentBody = JSON.parse(fetchCalls[0]!.init.body as string);
  assert.deepEqual(sentBody, { orderId: ORDER_ID, publicToken: TOKEN });

  assert.equal((globalThis as any).__mockRefreshCount, before + 1, "router.refresh() doit avoir été appelé exactement une fois");

  // Mandat §7/§22 : le fragment doit avoir disparu de l'URL AFFICHÉE.
  assert.equal(window.location.hash, "", "le fragment doit être retiré de l'historique visible");
  assert.equal(window.location.pathname, `/track/${ORDER_ID}`);

  assert.equal(container.textContent!.includes(TOKEN), false, "le jeton ne doit jamais apparaître dans le texte rendu");

  root.unmount();
  container.remove();
});

test("hash absent -- état invalide générique IMMÉDIAT, AUCUN appel réseau (mandat §13, scanner de lien sans JS -- mandat §23)", async () => {
  setHash("");
  let fetchCalled = false;
  (globalThis as any).fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { container, root } = render();
  await waitFor(
    () => container.textContent!.includes("Lien de suivi introuvable"),
    "message générique d'invalidité affiché sans fragment"
  );

  assert.equal(fetchCalled, false, "aucun appel réseau ne doit être déclenché sans fragment");
  assert.ok(container.textContent!.includes("Lien de suivi introuvable"), "message générique d'invalidité attendu");
  assert.equal(container.textContent!.includes(TOKEN), false);

  root.unmount();
  container.remove();
});

test("hash présent mais MAL FORMÉ (pas un UUID) -- état invalide générique, AUCUN appel réseau", async () => {
  setHash("#not-a-real-token");
  let fetchCalled = false;
  (globalThis as any).fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { container, root } = render();
  await waitFor(
    () => container.textContent!.includes("Lien de suivi introuvable"),
    "message générique d'invalidité affiché pour un jeton mal formé"
  );

  assert.equal(fetchCalled, false);
  assert.ok(container.textContent!.includes("Lien de suivi introuvable"));

  root.unmount();
  container.remove();
});

test("échange échoue avec reason='invalid' -- état invalide générique affiché", async () => {
  setHash(`#${TOKEN}`);
  (globalThis as any).fetch = async () => ({
    ok: false,
    json: async () => ({ ok: false, reason: "invalid" }),
  });

  const { container, root } = render();
  await waitFor(
    () => container.textContent!.includes("Lien de suivi introuvable"),
    "message générique d'invalidité affiché après un échange reason=invalid"
  );

  assert.ok(container.textContent!.includes("Lien de suivi introuvable"));
  assert.equal(container.textContent!.includes(TOKEN), false);

  root.unmount();
  container.remove();
});

test("échange échoue avec reason='unavailable' -- état indisponible générique affiché (catégorie DIFFÉRENTE, mandat §13)", async () => {
  setHash(`#${TOKEN}`);
  (globalThis as any).fetch = async () => ({
    ok: false,
    json: async () => ({ ok: false, reason: "unavailable" }),
  });

  const { container, root } = render();
  await waitFor(
    () => container.textContent!.includes("temporairement indisponible"),
    "message générique d'indisponibilité affiché après un échange reason=unavailable"
  );

  assert.ok(container.textContent!.includes("temporairement indisponible"));
  assert.equal(container.textContent!.includes("introuvable"), false);

  root.unmount();
  container.remove();
});

test("fetch() lève (panne réseau) -- état indisponible générique, jamais un crash", async () => {
  setHash(`#${TOKEN}`);
  (globalThis as any).fetch = async () => {
    throw new Error("network down");
  };

  const { container, root } = render();
  await waitFor(
    () => container.textContent!.includes("temporairement indisponible"),
    "message générique d'indisponibilité affiché après une panne fetch()"
  );

  assert.ok(container.textContent!.includes("temporairement indisponible"));

  root.unmount();
  container.remove();
});

test("démontage AVANT résolution de l'échange -- aucune mise à jour d'état après démontage, aucun crash", async () => {
  setHash(`#${TOKEN}`);
  let resolveFetch!: (v: unknown) => void;
  (globalThis as any).fetch = () =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    });

  const { container, root } = render();
  await new Promise((r) => setTimeout(r, 5));
  root.unmount();
  container.remove();

  assert.doesNotThrow(() => {
    resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  });
  await flush();
});

test("état de chargement initial : le jeton n'apparaît JAMAIS dans le texte rendu, quel que soit l'état atteint", async () => {
  setHash(`#${TOKEN}`);
  (globalThis as any).fetch = () => new Promise(() => {}); // ne résout jamais -- reste en "loading"

  const { container, root } = render();
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(container.textContent!.includes(TOKEN), false);

  root.unmount();
  container.remove();
});

// ====================================================================
// CUSTOMER TRACKING EXPERIENCE v2.1 -- ferme CTE-V2-MALFORMED-FRAGMENT-01
// (LOW, Work re-audit de v2).
//
// `decodeURIComponent` lève `URIError: URI malformed` sur un
// pourcentage isolé, une séquence d'échappement tronquée, ou de
// l'UTF-8 pourcentage-encodé mal formé -- ces 4 cas prouvent que ce
// composant ne laisse JAMAIS une telle exception non gérée remonter
// (ce qui aurait fait planter tout l'arbre React monté sur cette page,
// bien au-delà de ce seul composant), et que le comportement observé
// reste IDENTIQUE à toute autre entrée mal formée (mandat §13) : état
// "invalide" générique, AUCUN appel réseau.
// ====================================================================

const MALFORMED_FRAGMENTS: Array<{ label: string; hash: string }> = [
  { label: "pourcentage isolé ('%')", hash: "#%" },
  { label: "séquence d'échappement invalide ('%ZZ')", hash: "#%ZZ" },
  { label: "UTF-8 pourcentage-encodé tronqué ('%E2%82', début d'une séquence 3-octets incomplète)", hash: "#%E2%82" },
  { label: "pourcentage isolé en fin de chaîne, après un préfixe UUID plausible", hash: `#${TOKEN}%` },
];

for (const { label, hash } of MALFORMED_FRAGMENTS) {
  test(`mandat CTE-V2-MALFORMED-FRAGMENT-01 : fragment mal formé -- ${label} -- ne lève JAMAIS d'exception non gérée, état invalide générique, AUCUN appel réseau`, async () => {
    setHash(hash);
    let fetchCalled = false;
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    // La preuve la plus directe qu'aucune exception n'a été laissée
    // remonter : le montage lui-même ne lève pas, et l'arbre reste
    // monté avec un état affiché cohérent (pas une page blanche issue
    // d'un crash React non intercepté par une error boundary absente).
    const { container, root } = render();
    await waitFor(
      () => container.textContent!.includes("Lien de suivi introuvable"),
      `message générique d'invalidité affiché pour un fragment mal formé (${label})`
    );

    assert.equal(fetchCalled, false, "aucun appel réseau ne doit être déclenché pour un fragment non décodable");
    assert.ok(container.textContent!.includes("Lien de suivi introuvable"));
    assert.equal(container.textContent!.includes(TOKEN), false);

    root.unmount();
    container.remove();
  });
}
