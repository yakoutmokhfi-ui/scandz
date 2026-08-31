import { test } from "node:test";
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
// ferme CTE-V2-MULTIORDER-COVERAGE-01 (LOW, Work re-audit de v2),
// mandat §8 : "one cookie jar/browser context: establish session A,
// establish session B, order A page still works, order B page still
// works, A cookie not sent to B, B cookie not sent to A, unrelated
// order gets neither."
//
// AUCUN changement d'architecture (mandat §8, "No architecture change
// required") -- ce test COMBINE deux disciplines déjà établies dans ce
// dépôt plutôt que d'en introduire une nouvelle :
//   - tests/v122f-tracking-exchange-route.test.ts : invoque
//     RÉELLEMENT le handler POST de app/api/track/exchange/route.ts
//     avec un vrai NextRequest, et lit l'en-tête Set-Cookie RÉEL qu'il
//     produit (jamais un jeton fabriqué à la main) ;
//   - tests/v123a-*.dom.test.ts : monte RÉELLEMENT
//     app/track/[orderId]/page.tsx (Server Component appelé
//     directement) avec next/headers mocké.
//
// Le "cookie jar" du mandat est modélisé ici par une classe
// SimpleCookieJar qui reproduit fidèlement l'algorithme de
// correspondance de chemin des cookies RFC 6265 §5.1.4 (le MÊME
// algorithme qu'un navigateur réel applique pour décider quels cookies
// annexer à quelle requête) : elle capture le VRAI Set-Cookie émis par
// route.ts pour CHAQUE commande (donc le VRAI attribut Path=/track/<order_id>
// posé par ce fichier, mandat §10, "narrow path where practical"), puis,
// pour toute page ouverte, ne retient QUE le(s) cookie(s) dont le
// chemin correspond au chemin demandé -- exactement le comportement
// qu'un navigateur réel appliquerait, jamais une simulation
// approximative ou un raccourci qui présupposerait le résultat.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/track/exchange/route.ts");

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const TOKEN_A = "22222222-2222-4222-8222-222222222222";
const ORDER_B = "33333333-3333-4333-8333-333333333333";
const TOKEN_B = "44444444-4444-4444-8444-444444444444";
// Commande TIERCE, sans rapport -- aucune session n'est jamais établie
// pour elle dans ce test (mandat §8, "unrelated order gets neither").
const ORDER_C = "55555555-5555-4555-8555-555555555555";

const ROW_A = {
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
const ROW_B = {
  order_status: "preparing",
  service_mode: "dine_in",
  order_number: 205,
  created_at: "2026-01-02T11:00:00Z",
  accepted_at: "2026-01-02T11:05:00Z",
  preparing_at: "2026-01-02T11:10:00Z",
  ready_at: null,
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
};

function makeExchangeRequest(body: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest("https://example.com/api/track/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ------------------------------------------------------------------
// "Cookie jar" fidèle à RFC 6265 §5.1.4 -- voir le commentaire de tête.
// ------------------------------------------------------------------
interface StoredCookie {
  name: string;
  value: string;
  cookiePath: string;
}

class SimpleCookieJar {
  private cookies: StoredCookie[] = [];

  captureSetCookie(setCookieHeader: string): void {
    const parts = setCookieHeader.split(";").map((p) => p.trim());
    const [name, value] = parts[0]!.split("=");
    const pathAttr = parts.find((p) => p.toLowerCase().startsWith("path="));
    const cookiePath = pathAttr ? pathAttr.slice("path=".length) : "/";
    this.cookies.push({ name: name!, value: value!, cookiePath });
  }

  private pathMatches(cookiePath: string, requestPath: string): boolean {
    // RFC 6265 §5.1.4 (algorithme "path-match") -- le chemin du cookie
    // doit être un PRÉFIXE de segment complet du chemin demandé, jamais
    // une simple correspondance de préfixe textuel brut.
    if (requestPath === cookiePath) return true;
    if (!requestPath.startsWith(cookiePath)) return false;
    if (cookiePath.endsWith("/")) return true;
    return requestPath.charAt(cookiePath.length) === "/";
  }

  /** Reproduit ce qu'un VRAI navigateur annexerait au Cookie header
   *  d'une requête vers `requestPath` -- utilisé ici pour peupler le
   *  magasin `next/headers` mocké AVANT chaque rendu de page. */
  cookiesForPath(requestPath: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const c of this.cookies) {
      if (this.pathMatches(c.cookiePath, requestPath)) {
        result[c.name] = c.value;
      }
    }
    return result;
  }
}

// ------------------------------------------------------------------
// Bundle esbuild de la page de suivi -- même harnais que
// tests/v123a-tracking-page-existing-session-fragment.dom.test.ts.
// ------------------------------------------------------------------

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

const REPO_ROOT = process.cwd();

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
    refresh: () => {},
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
  platform: "node", // voir tests/v123a-*.dom.test.ts -- requis pour "node:crypto"
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v123c-"));
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

/** Rend app/track/[orderId]/page.tsx pour `orderId`, en ne peuplant le
 *  magasin de cookies MOQUÉ QU'AVEC ce que `jar.cookiesForPath(...)`
 *  retournerait RÉELLEMENT pour ce chemin -- jamais l'intégralité du
 *  jar (ce serait tricher : un vrai navigateur ne fait jamais ça). */
async function renderTrackingPage(
  jar: SimpleCookieJar,
  orderId: string
): Promise<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  (globalThis as any).__mockCookieStore = jar.cookiesForPath(`/track/${orderId}`);

  const element = await TrackingPage({
    params: Promise.resolve({ orderId }),
    searchParams: Promise.resolve({}),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  return { container, root };
}

test("CTE-V2-MULTIORDER-COVERAGE-01 (ferme) : deux sessions coexistent dans un même jar de cookies -- chaque commande reste accessible, aucune fuite croisée, commande tierce sans session", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string, params: { p_order_id: string; p_public_token: string }) => {
    if (name !== "get_order_tracking") throw new Error(`RPC inattendue : ${name}`);
    if (params.p_order_id === ORDER_A && params.p_public_token === TOKEN_A) {
      return { data: [ROW_A], error: null };
    }
    if (params.p_order_id === ORDER_B && params.p_public_token === TOKEN_B) {
      return { data: [ROW_B], error: null };
    }
    // Tout autre couple (y compris un jeton d'une commande utilisé
    // pour une autre) -- possession incorrecte, ensemble vide (même
    // comportement RÉEL que la RPC publiée pour un couple croisé).
    return { data: [], error: null };
  });

  // --------------------------------------------------------------
  // Établit la session A, PUIS la session B, dans le MÊME jar --
  // mandat §8, "establish session A, establish session B".
  // --------------------------------------------------------------
  const jar = new SimpleCookieJar();

  const resA = await POST(makeExchangeRequest({ orderId: ORDER_A, publicToken: TOKEN_A }));
  assert.equal(resA.status, 200, "l'échange pour la commande A doit réussir");
  const setCookieA = resA.headers.get("set-cookie");
  assert.ok(setCookieA, "Set-Cookie doit être présent pour la commande A");
  assert.ok(setCookieA!.includes(`Path=/track/${ORDER_A}`), "le cookie A doit être scindé sur /track/<ORDER_A>");
  jar.captureSetCookie(setCookieA!);

  const resB = await POST(makeExchangeRequest({ orderId: ORDER_B, publicToken: TOKEN_B }));
  assert.equal(resB.status, 200, "l'échange pour la commande B doit réussir");
  const setCookieB = resB.headers.get("set-cookie");
  assert.ok(setCookieB, "Set-Cookie doit être présent pour la commande B");
  assert.ok(setCookieB!.includes(`Path=/track/${ORDER_B}`), "le cookie B doit être scindé sur /track/<ORDER_B>");
  jar.captureSetCookie(setCookieB!);

  // --------------------------------------------------------------
  // "A cookie not sent to B, B cookie not sent to A" -- vérifié
  // directement au niveau du jar, AVANT même de rendre quoi que ce
  // soit : reproduit fidèlement ce qu'un navigateur réel annexerait.
  // --------------------------------------------------------------
  const cookiesForA = jar.cookiesForPath(`/track/${ORDER_A}`);
  const cookiesForB = jar.cookiesForPath(`/track/${ORDER_B}`);
  const cookiesForC = jar.cookiesForPath(`/track/${ORDER_C}`);

  assert.equal(Object.keys(cookiesForA).length, 1, "exactement un cookie doit s'appliquer au chemin de la commande A");
  assert.equal(Object.keys(cookiesForB).length, 1, "exactement un cookie doit s'appliquer au chemin de la commande B");
  assert.notEqual(cookiesForA.st_session, cookiesForB.st_session, "le cookie annexé à A ne doit JAMAIS être celui de B (et réciproquement)");
  assert.deepEqual(cookiesForC, {}, "mandat §8 : une commande TIERCE, sans rapport, ne doit recevoir AUCUN des deux cookies");

  // --------------------------------------------------------------
  // "order A page still works, order B page still works" -- rendu
  // RÉEL de app/track/[orderId]/page.tsx, cookie filtré par chemin.
  // --------------------------------------------------------------
  const { container: containerA, root: rootA } = await renderTrackingPage(jar, ORDER_A);
  await waitFor(() => containerA.textContent!.includes("104"), "la page A doit afficher les données de la commande A");
  assert.ok(containerA.textContent!.includes("104"), "numéro de commande A affiché");
  assert.equal(containerA.textContent!.includes("205"), false, "la page A ne doit JAMAIS afficher le numéro de la commande B");
  assert.equal(containerA.textContent!.includes(TOKEN_A), false, "le jeton A ne doit jamais être rendu");
  assert.equal(containerA.textContent!.includes(TOKEN_B), false, "le jeton B ne doit jamais apparaître sur la page A");
  rootA.unmount();
  containerA.remove();

  const { container: containerB, root: rootB } = await renderTrackingPage(jar, ORDER_B);
  await waitFor(() => containerB.textContent!.includes("205"), "la page B doit afficher les données de la commande B");
  assert.ok(containerB.textContent!.includes("205"), "numéro de commande B affiché");
  assert.equal(containerB.textContent!.includes("104"), false, "la page B ne doit JAMAIS afficher le numéro de la commande A");
  assert.equal(containerB.textContent!.includes(TOKEN_B), false, "le jeton B ne doit jamais être rendu");
  assert.equal(containerB.textContent!.includes(TOKEN_A), false, "le jeton A ne doit jamais apparaître sur la page B");
  rootB.unmount();
  containerB.remove();

  // --------------------------------------------------------------
  // "unrelated order gets neither" -- rendu RÉEL de la page pour la
  // commande TIERCE C : le jar ne lui annexe aucun cookie (déjà
  // vérifié ci-dessus), donc aucune session -- la page doit retomber
  // sur la porte d'entrée (TrackingEntryGate), jamais sur des données
  // de suivi (ni celles de A, ni celles de B).
  // --------------------------------------------------------------
  const { container: containerC, root: rootC } = await renderTrackingPage(jar, ORDER_C);
  await waitFor(
    () => containerC.textContent!.trim().length > 0,
    "la page C doit rendre quelque chose (l'écran de porte d'entrée, en attente de fragment)"
  );
  assert.equal(containerC.textContent!.includes("104"), false, "la commande tierce ne doit jamais afficher les données de A");
  assert.equal(containerC.textContent!.includes("205"), false, "la commande tierce ne doit jamais afficher les données de B");
  assert.equal(containerC.textContent!.includes(TOKEN_A), false);
  assert.equal(containerC.textContent!.includes(TOKEN_B), false);
  rootC.unmount();
  containerC.remove();
});
