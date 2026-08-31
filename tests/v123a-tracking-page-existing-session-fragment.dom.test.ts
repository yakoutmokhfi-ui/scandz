import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.TRACKING_SESSION_SECRET =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2.1 —
// app/track/[orderId]/page.tsx : ferme CTE-V2-HISTORY-01 (blocage de
// publication UNIQUE, Work re-audit de v2).
//
// MANDAT (§5, test comportemental REQUIS) : session valide EXISTANTE
// + ouverture du lien d'origine `/track/<order_id>#<public_token>`.
// Attendu :
//   - les données de suivi restent disponibles (la session déjà valide
//     suffit -- aucun échange n'est nécessaire) ;
//   - AUCUNE requête POST d'échange ne se produit ;
//   - l'URL devient `/track/<order_id>` ;
//   - le fragment est retiré AVANT toute utilisation ultérieure ;
//   - le jeton n'est jamais rendu ;
//   - le jeton n'est jamais copié vers la chaîne de requête ou le
//     chemin.
//
// C'EST EXACTEMENT LE SCÉNARIO QUI AURAIT ÉCHOUÉ AVANT LE CORRECTIF
// v2.1 : en v2, le retrait du fragment n'avait lieu QUE dans
// components/TrackingEntryGate.tsx, jamais rendu quand une session
// valide existe déjà -- le fragment restait donc visible
// indéfiniment. Ce test monte RÉELLEMENT app/track/[orderId]/page.tsx
// (un Server Component asynchrone appelé directement comme une
// fonction -- technique déjà établie dans ce dépôt pour les tests DOM
// de composants "use client" bundlés par esbuild, étendue ici à
// l'appel direct d'un Server Component asynchrone, dont le retour est
// un arbre React ordinaire une fois résolu) avec une VRAIE session
// signée (créée via lib/server/tracking-session.ts, jamais un jeton
// de session fabriqué à la main) posée dans un cookie MOQUÉ, et une
// VRAIE RPC `get_order_tracking` interceptée au niveau `supabase.rpc`
// (jamais au niveau `lib/server/tracking-service.ts` lui-même --
// même discipline que tests/v101-*.dom.test.ts et
// tests/v122i-*.dom.test.ts : ne mocker que la frontière réseau la
// plus basse).
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

// La commande RÉELLEMENT ouverte a une session VALIDE ET EXISTANTE --
// construite avec le VRAI mécanisme de chiffrement AES-256-GCM, jamais
// une chaîne fabriquée à la main.
const EXISTING_SESSION_TOKEN = createTrackingSessionToken(ORDER_ID, TOKEN);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  // L'URL initiale porte ENCORE le fragment d'origine -- exactement le
  // scénario mandaté : le client rouvre son lien de confirmation
  // pendant que sa session (2h) est toujours valide.
  url: `http://localhost/track/${ORDER_ID}#${TOKEN}`,
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

const REPO_ROOT = process.cwd();

// Magasin de cookies MOQUÉ, contrôlé par le test -- représente
// EXACTEMENT ce que `await cookies()` (next/headers) renverrait dans
// une vraie requête serveur Next.js portant déjà un cookie de session
// valide.
(globalThis as any).__mockCookieStore = {};

const MOCK_HEADERS = `
export async function cookies() {
  const store = (globalThis).__mockCookieStore || {};
  return {
    get(name) {
      return name in store ? { name, value: store[name] } : undefined;
    },
  };
}
`;

const MOCK_NAV = `
export function useRouter() {
  return {
    refresh: () => { (globalThis).__mockRefreshCount = ((globalThis).__mockRefreshCount || 0) + 1; },
    replace: () => {},
    push: () => {},
  };
}
`;

// next/link : simple passe-plat vers <a>, aucune dépendance interne
// Next.js -- même principe que le mock next/navigation (aucune
// bibliothèque Next.js réelle n'est jamais bundlée par ce harnais
// esbuild, qui n'externalise QUE react/react-dom et @/lib/supabase).
const MOCK_LINK = `
import { createElement } from "react";
export default function Link(props) {
  const { href, children, ...rest } = props;
  return createElement("a", { href, ...rest }, children);
}
`;

const mocks: Record<string, string> = {
  "next/headers": MOCK_HEADERS,
  "next/navigation": MOCK_NAV,
  "next/link": MOCK_LINK,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) {
        return { path: args.path, namespace: "mock" };
      }
      // "server-only" : même stub TEST-ONLY que tests/server-only-stub.mjs
      // (utilisé par le résolveur ESM natif de Node pour `node --test`) --
      // esbuild ne passe JAMAIS par ce hook Node, donc ce lot a besoin de
      // sa PROPRE redirection équivalente pour bundler
      // lib/server/tracking-service.ts et lib/server/tracking-session.ts
      // (tous deux gardés par `import "server-only";`) sans faire lever
      // l'implémentation réelle du paquet "server-only" (qui lève
      // systématiquement hors de la condition d'export "react-server",
      // jamais appliquée par cette configuration esbuild).
      if (args.path === "server-only") {
        return { path: "server-only", namespace: "mock" };
      }
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        if (base.endsWith(path.join("lib", "supabase"))) {
          return { path: pathToFileURL(base + ".ts").href, external: true };
        }
        const candidate = ["", ".tsx", ".ts"]
          .map((ext) => base + ext)
          .find((p) => existsSync(p));
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
export { default as TrackingPage } from "@/app/track/[orderId]/page";
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
  // `platform: "node"` -- ce lot est le PREMIER de ce dépôt à bundler
  // directement du code SERVEUR (lib/server/tracking-session.ts, via
  // app/track/[orderId]/page.tsx) plutôt que de se limiter à des
  // composants "use client" : sans cette option, esbuild refuse de
  // résoudre les imports natifs Node préfixés "node:" (ici
  // "node:crypto", utilisé par le chiffrement AES-256-GCM de la
  // session -- mandat §9/§10). Aucune incidence sur le bundle : les
  // modules Node natifs restent simplement NON bundlés (comportement
  // par défaut de esbuild en `platform: "node"`), exécutés par le
  // VRAI Node.js qui fait tourner ce test -- jamais simulés/mockés.
  platform: "node",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v123a-"));
const tmpFile = path.join(tmpDir, "TrackingPage.mjs");
writeFileSync(tmpFile, code);
const { TrackingPage } = await import(pathToFileURL(tmpFile).href);
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

const VALID_ROW = {
  order_status: "ready",
  service_mode: "pickup",
  order_number: 104,
  created_at: "2026-01-01T10:00:00Z",
  accepted_at: "2026-01-01T10:05:00Z",
  preparing_at: "2026-01-01T10:10:00Z",
  ready_at: "2026-01-01T10:20:00Z",
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
};

test("mandat §5 (test comportemental REQUIS) : session valide EXISTANTE + réouverture du lien d'origine avec fragment -- données de suivi disponibles, AUCUN POST d'échange, URL propre, fragment retiré, jeton jamais rendu/copié", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking") return { data: [VALID_ROW], error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });

  (globalThis as any).__mockCookieStore = {
    [TRACKING_SESSION_COOKIE_NAME]: EXISTING_SESSION_TOKEN,
  };

  let fetchCalls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    fetchCalls.push(url);
    throw new Error("aucun appel réseau ne devrait jamais être tenté par ce scénario");
  };

  // Confirme l'état INITIAL de l'URL avant montage : le fragment
  // d'origine est bien présent (reproduit fidèlement le scénario
  // mandaté -- le client vient de rouvrir son lien de confirmation).
  assert.equal(window.location.hash, `#${TOKEN}`, "précondition : le fragment d'origine doit être présent avant le montage");

  const element = await TrackingPage({
    params: Promise.resolve({ orderId: ORDER_ID }),
    searchParams: Promise.resolve({}),
  });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);

  // Mandat §5 : "URL becomes /track/<order_id> ; fragment removed
  // before continued use" -- exactement le comportement qui manquait
  // avant le correctif v2.1 (aucun TrackingEntryGate n'est rendu dans
  // cette branche, donc rien ne retirait jamais le fragment avant
  // components/TrackingFragmentScrubber.tsx).
  await waitFor(
    () => window.location.hash === "",
    "le fragment doit être retiré même quand une session valide existait déjà"
  );

  assert.equal(window.location.pathname, `/track/${ORDER_ID}`, "l'URL doit devenir le chemin PROPRE");
  assert.equal(window.location.search, "", "le jeton ne doit JAMAIS être copié dans la chaîne de requête");
  assert.equal(window.location.hash, "", "aucun fragment résiduel");

  // Mandat §5 : "no exchange POST occurs" -- AUCUN appel réseau du
  // tout dans ce scénario (la session déjà valide suffit).
  assert.deepEqual(fetchCalls, [], "aucune requête d'échange ne doit jamais être tentée quand une session valide existe déjà");

  // Mandat §5 : "tracking data remains available".
  assert.ok(container.textContent!.includes("104"), "le numéro de commande RÉEL doit être affiché (preuve que les données de suivi sont bien disponibles)");
  assert.ok(
    container.textContent!.includes("Prête pour le retrait") || container.textContent!.includes("retrait"),
    "le libellé de statut adapté au mode pickup doit être affiché (la frise de suivi complète est bien rendue, pas seulement un écran de chargement)"
  );

  // Mandat §5 : "token not rendered ; token not copied to query/path".
  assert.equal(container.textContent!.includes(TOKEN), false, "le jeton ne doit jamais apparaître dans le texte rendu");
  assert.equal(container.innerHTML.includes(TOKEN), false, "le jeton ne doit jamais apparaître dans le HTML rendu (attributs inclus)");

  root.unmount();
  container.remove();
});
