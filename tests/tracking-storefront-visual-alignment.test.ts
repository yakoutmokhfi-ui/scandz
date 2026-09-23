import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.TRACKING_SESSION_SECRET =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ====================================================================
// Scanym — TRACKING : ALIGNEMENT VISUEL SUR LA BOUTIQUE
//
// Ajustement de PRÉSENTATION UNIQUEMENT (mandat : « Do not change the
// tracking logic or statuses »). Ce test prouve les DEUX moitiés :
//
//   1. la page de suivi rend bien la palette de la BOUTIQUE (fond
//      sombre, texte blanc, secondaire gris clair, doré de la
//      boutique, pastille identique à la sélection active du
//      catalogue, cartes sombres à filet discret) -- via le MÊME
//      système de couleurs (`themeStyle`, variables `--sc-*`), sans
//      couleur littérale dans la page ;
//   2. la logique et les statuts n'ont PAS bougé : mêmes autorités de
//      libellé, même frise, mêmes statuts canoniques, aucun statut
//      ajouté, aucun état inventé.
// ====================================================================

const REPO_ROOT = process.cwd();
const PAGE_PATH = "app/track/[orderId]/page.tsx";
const PAGE_SRC = readFileSync(path.join(REPO_ROOT, PAGE_PATH), "utf8");

const { themeStyle, THEMES, DEFAULT_THEME, TRACKING_SURFACE_COLORS } = await import(
  "../lib/themes.ts"
);
const { contrastRatio, relativeLuminance } = await import("../lib/color-contrast.ts");

const VARS = themeStyle(DEFAULT_THEME, TRACKING_SURFACE_COLORS);

// --------------------------------------------------------------------
// 1. La palette réellement produite
// --------------------------------------------------------------------

test("visuel: la palette de suivi est SOMBRE (fond quasi noir), comme la boutique", () => {
  const bg = VARS["--sc-bg"];
  assert.equal(
    relativeLuminance(bg) < 0.05,
    true,
    `fond attendu très sombre, obtenu ${bg} (luminance ${relativeLuminance(bg)})`
  );
  // Fond de page ET surfaces de carte partagent ce fond : `bg-crema`
  // (= var(--sc-bg)) est la seule surface utilisée par la page.
  assert.equal(VARS["--sc-ink"] !== undefined, true);
  assert.equal(relativeLuminance(VARS["--sc-ink"]) < 0.05, true);
});

test("visuel: texte principal BLANC et texte secondaire GRIS CLAIR, tous deux ≥ 4,5:1", () => {
  const bg = VARS["--sc-bg"];
  assert.equal(VARS["--sc-ink-on-bg"], "#ffffff");

  const muted = VARS["--sc-ink-on-bg-muted"];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(muted.slice(i, i + 2), 16));
  assert.equal(Math.max(r, g, b) - Math.min(r, g, b) <= 8, true, `gris attendu, obtenu ${muted}`);
  assert.equal(relativeLuminance(muted) > 0.3, true, `gris clair attendu, obtenu ${muted}`);
  assert.equal(relativeLuminance(muted) < relativeLuminance("#ffffff"), true);

  assert.equal(contrastRatio(VARS["--sc-ink-on-bg"], bg) >= 4.5, true);
  assert.equal(contrastRatio(muted, bg) >= 4.5, true);
});

test("visuel: l'accent est EXACTEMENT le doré déjà utilisé par la boutique (référencé, jamais recopié)", () => {
  const storefrontGold = THEMES[DEFAULT_THEME].highlight;
  assert.equal(VARS["--sc-accent"], storefrontGold);
  assert.equal(VARS["--sc-highlight"], storefrontGold);
  const themesSrc = readFileSync(path.join(REPO_ROOT, "lib/themes.ts"), "utf8");
  const block = themesSrc.slice(themesSrc.indexOf("TRACKING_SURFACE_COLORS"));
  assert.equal(
    block.includes("THEMES[DEFAULT_THEME].highlight"),
    true,
    "le doré doit être référencé depuis THEMES, pas réécrit en dur"
  );
  assert.equal(
    block.slice(0, block.indexOf("};")).includes(storefrontGold),
    false,
    "le doré ne doit pas être recopié littéralement dans TRACKING_SURFACE_COLORS"
  );
});

test("visuel: pastille/boutons et liens dorés restent lisibles (AA) sur la palette sombre", () => {
  const bg = VARS["--sc-bg"];
  assert.equal(contrastRatio(VARS["--sc-accent-text"], VARS["--sc-accent"]) >= 4.5, true);
  assert.equal(contrastRatio(VARS["--sc-accent-dark-on-bg"], bg) >= 4.5, true);
  assert.equal(contrastRatio(VARS["--sc-accent"], bg) >= 3, true);
});

test("visuel: THEMES n'a PAS été modifié -- ceci n'est pas un nouveau thème commerçant", () => {
  assert.deepEqual(Object.keys(THEMES).sort(), ["cafe", "frais", "gourmand", "nuit", "terrasse"]);
  assert.deepEqual(THEMES.cafe, {
    ink: "#221510",
    bg: "#F6F2EC",
    accent: "#A3651F",
    accentDark: "#8A5322",
    highlight: "#C6A15B",
  });
});

// --------------------------------------------------------------------
// 2. Ce que la page écrit réellement
// --------------------------------------------------------------------

test("structure: la page monte les variables du MÊME système de couleurs que la boutique", () => {
  assert.equal(
    /style=\{themeStyle\(DEFAULT_THEME, TRACKING_SURFACE_COLORS\) as React\.CSSProperties\}/.test(
      PAGE_SRC
    ),
    true,
    "le conteneur de suivi doit poser themeStyle(DEFAULT_THEME, TRACKING_SURFACE_COLORS)"
  );
  assert.equal(/from "@\/lib\/themes"/.test(PAGE_SRC), true);
});

test("structure: aucune couleur littérale ni surface claire figée dans la page de suivi", () => {
  const code = PAGE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const forbidden of ["bg-white", "text-white", "bg-black", "text-green-", "text-gray-"]) {
    assert.equal(code.includes(forbidden), false, `classe figée interdite : ${forbidden}`);
  }
  assert.equal(/#[0-9A-Fa-f]{6}/.test(code), false, "aucune couleur hexadécimale dans la page");
});

test("structure: cartes sombres à filet discret, pastille identique à la sélection de la boutique", () => {
  const cards = PAGE_SRC.match(/border border-caramel\/30 bg-crema/g) ?? [];
  assert.equal(cards.length, 2, "carte de contact et encadré d'exception attendus");
  assert.equal(
    /rounded-full bg-caramel px-4 py-1\.5 text-sm font-bold text-caramel-ink shadow-sm/.test(
      PAGE_SRC
    ),
    true
  );
  for (const pill of ["components/CategoryNav.tsx", "components/SubcategoryFilter.tsx"]) {
    assert.equal(
      readFileSync(path.join(REPO_ROOT, pill), "utf8").includes("bg-caramel text-caramel-ink"),
      true,
      `${pill} reste l'autorité visuelle de la sélection active`
    );
  }
});

test("non-régression: la logique et les statuts de suivi sont INCHANGÉS", () => {
  for (const authority of [
    "buildTimeline(tracking.orderStatus",
    "statusLabelKey(tracking.orderStatus)",
    "statusLabelKeyForServiceMode(tracking.orderStatus, tracking.serviceMode)",
    "timelineStepLabelKey(step.status, tracking.serviceMode)",
    "isTerminalStatus(tracking.orderStatus)",
    "<TrackingAutoRefresh enabled={!terminal} />",
  ]) {
    assert.equal(PAGE_SRC.includes(authority), true, `autorité de suivi perdue : ${authority}`);
  }
  const statusLiterals = (PAGE_SRC.match(/"(new|accepted|preparing|ready|completed|rejected|cancelled)"/g) ?? []).sort();
  assert.deepEqual(statusLiterals, ['"cancelled"', '"rejected"']);
  for (const forbidden of ["delivering", "dispatched", "courier", "driver", "paid", "refunded"]) {
    assert.equal(PAGE_SRC.includes(`"${forbidden}"`), false);
  }
});

// --------------------------------------------------------------------
// 3. Rendu réel (DOM) : les variables arrivent bien sur la page
// --------------------------------------------------------------------

const ORDER_ID = "77777777-7777-4777-8777-777777777777";
const CAP_ID = "99999999-9999-4999-8999-999999999999";
const SECRET = "3c".repeat(32);

const { supabase } = await import("../lib/supabase.ts");
const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);
const SESSION_TOKEN = createTrackingSessionToken(ORDER_ID, CAP_ID, SECRET);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: `http://localhost/track/${ORDER_ID}`,
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

(globalThis as any).__mockCookieStore = { [TRACKING_SESSION_COOKIE_NAME]: SESSION_TOKEN };

const mocks: Record<string, string> = {
  "next/headers": `
export async function cookies() {
  const store = (globalThis).__mockCookieStore || {};
  return { get(name) { return name in store ? { name, value: store[name] } : undefined; } };
}`,
  "next/navigation": `
export function useRouter() { return { refresh: () => {}, replace: () => {}, push: () => {} }; }
export function notFound() { throw new Error("notFound"); }`,
  "next/link": `
import { createElement } from "react";
export default function Link(props) { const { href, children, ...rest } = props; return createElement("a", { href, ...rest }, children); }`,
};

const mockPlugin: esbuild.Plugin = {
  name: "tracking-visual-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path === "server-only") return { path: "server-only", namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        if (base.endsWith(path.join("lib", "supabase"))) {
          return { path: pathToFileURL(base + ".ts").href, external: true };
        }
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
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

const built = await esbuild.build({
  stdin: {
    contents: `export { default as TrackingPage } from "@/app/track/[orderId]/page";`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  platform: "node",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-track-visual-"));
const tmpFile = path.join(tmpDir, "TrackingPage.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { TrackingPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function trackingRow(overrides: Record<string, unknown> = {}) {
  return {
    bound_order_id: ORDER_ID,
    order_status: "preparing",
    service_mode: "pickup",
    order_number: 42,
    created_at: "2026-09-22T08:00:00Z",
    accepted_at: "2026-09-22T08:01:00Z",
    preparing_at: "2026-09-22T08:02:00Z",
    ready_at: null,
    completed_at: null,
    rejected_at: null,
    cancelled_at: null,
    order_total: 31.5,
    order_currency: "EUR",
    invoice_requested: false,
    ...overrides,
  };
}

async function renderPage(t: any, opts: { context?: Record<string, unknown> | null } = {}) {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_order_tracking_by_capability") return { data: [trackingRow()], error: null };
    if (name === "get_order_tracking_customer_context_by_capability") {
      return {
        data: opts.context === null ? [] : [
          opts.context ?? {
            bound_order_id: ORDER_ID,
            restaurant_name: "Épicerie Alpha",
            public_phone: "+33 1 23 45 67 89",
            public_email: "contact@alpha.example",
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  const element = await TrackingPage({
    params: Promise.resolve({ orderId: ORDER_ID }),
    searchParams: Promise.resolve({}),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  t.after(() => {
    root.unmount();
    container.remove();
  });
  return { container };
}

test("rendu: le conteneur de suivi porte réellement les variables sombres/dorées", async (t) => {
  const { container } = await renderPage(t);
  const main = container.querySelector("main");
  assert.equal(main !== null, true);
  const style = main!.getAttribute("style") ?? "";
  for (const [name, value] of Object.entries(VARS)) {
    assert.equal(
      style.includes(`${name}: ${value}`),
      true,
      `variable ${name}: ${value} absente du style rendu`
    );
  }
  assert.equal(main!.className.includes("bg-crema"), true);
  assert.equal(main!.className.includes("min-h-dvh"), true);
});

test("rendu: pastille dorée, jalons dorés, carte de contact sombre à filet", async (t) => {
  const { container } = await renderPage(t);

  const badge = container.querySelector('[aria-live="polite"]')!;
  assert.equal(badge.className.includes("bg-caramel"), true);
  assert.equal(badge.className.includes("text-caramel-ink"), true);
  assert.equal(badge.className.includes("rounded-full"), true);

  const markers = [...container.querySelectorAll("ol li span[aria-hidden]")];
  assert.equal(markers.length > 0, true);
  const reached = markers.filter((m) => m.textContent === "✓");
  assert.equal(reached.length > 0, true);
  for (const m of reached) assert.equal(m.className.includes("text-caramel"), true);
  for (const m of markers.filter((x) => x.textContent === "○")) {
    assert.equal(m.className.includes("text-ink-on-bg-muted"), true);
  }

  const contact = container.querySelector("[data-tracking-merchant-contact]")!;
  assert.equal(contact.className.includes("border-caramel/30"), true);
  assert.equal(contact.className.includes("bg-crema"), true);
  assert.equal(contact.className.includes("bg-white"), false);
});

test("rendu: le contenu de suivi (statuts, libellés, contacts) est inchangé par le restylage", async (t) => {
  const { container } = await renderPage(t);
  assert.equal(container.querySelector('[aria-live="polite"]')!.textContent, "En préparation");
  assert.deepEqual(
    [...container.querySelectorAll("ol li")].map((li) =>
      (li.textContent ?? "").replace(/^[✓○]/, "").trim()
    ),
    ["Commande reçue", "Commande acceptée", "En préparation", "Prête pour le retrait", "Terminée"]
  );
  assert.equal(
    container.querySelector('li[aria-current="step"]')!.textContent!.includes("En préparation"),
    true
  );
  assert.equal(
    container.querySelector('a[href="tel:+33123456789"]') !== null,
    true
  );
  assert.equal(
    container.querySelector('a[href="mailto:contact@alpha.example"]') !== null,
    true
  );
  assert.equal(/whatsapp|wa\.me/i.test(container.innerHTML), false);
});
