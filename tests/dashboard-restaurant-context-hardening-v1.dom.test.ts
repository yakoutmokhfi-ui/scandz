import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — DASHBOARD RESTAURANT CONTEXT HARDENING v1 (Claude Monet)
//
// UNE règle de contexte, appliquée aux SEPT modules du backoffice
// commerçant. Les sept pages RÉELLES sont rendues dans un vrai DOM --
// aucune page n'est vérifiée par simple inspection de source ici.
// Seules les dépendances de service sont contrôlées, pour fixer de
// façon déterministe les rattachements du compte, le rôle opérateur et
// l'établissement demandé par l'URL.
//
// Fixture à deux établissements, comme demandé : "Au lait cru" /
// "Sanaa Cookies & Fondant".
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard",
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

const REPO_ROOT = process.cwd();

const AU_LAIT_CRU = "r-au-lait-cru";
const SANAA = "r-sanaa";
const ILLICO = "r-illico";
const FORGED = "r-forged-not-mine";

function mapping(id: string, name: string, slug: string) {
  return { restaurant_id: id, role: "owner" as const, restaurants: { id, name, slug } };
}

/** Commerçant ordinaire : Sanaa en PREMIER, Au lait cru en second. */
const MERCHANT_MAPPINGS = [
  mapping(SANAA, "Sanaa Cookies & Fondant", "sanaa"),
  mapping(AU_LAIT_CRU, "Au lait cru", "au-lait-cru"),
];
/** Opérateur Scanym : ne possède NI Au lait cru NI Sanaa en premier. */
const OPERATOR_OWN_MAPPINGS = [
  mapping(SANAA, "Sanaa Cookies & Fondant", "sanaa"),
  mapping(ILLICO, "Illico Presto", "illico"),
];

(globalThis as any).__navMappings = MERCHANT_MAPPINGS as unknown[];
(globalThis as any).__navIsOperator = false;
(globalThis as any).__navPathname = "/dashboard";
/** Journal des identifiants de restaurant réellement demandés aux services. */
(globalThis as any).__fetchLog = [] as string[];

// --------------------------------------------------------------
// Mocks de service GÉNÉRÉS depuis la liste réelle des exports : un
// export ajouté ailleurs ne casse pas ce test pour une raison sans
// rapport. Les fonctions qui portent réellement le scénario sont
// surchargées, et celles qui lisent des données de restaurant
// JOURNALISENT l'identifiant demandé -- c'est ce qui permet de prouver
// qu'aucune donnée n'est chargée pour un établissement substitué.
// --------------------------------------------------------------
function exportedNames(relPath: string): { fns: string[]; classes: string[] } {
  const src = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return {
    fns: [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    classes: [
      ...[...src.matchAll(/export\s+class\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
      ...[...src.matchAll(/export\s*\{([^}]*)\}\s*from/g)].flatMap((m) =>
        m[1].split(",").map((p) => p.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)
      ),
    ],
  };
}

function buildServiceMock(relPath: string, overrides: Record<string, string>): string {
  const { fns, classes } = exportedNames(relPath);
  const lines: string[] = [];
  for (const c of classes) lines.push(`export class ${c} extends Error {}`);
  for (const f of fns) {
    if (overrides[f]) continue;
    lines.push(`export async function ${f}() { return undefined; }`);
  }
  for (const body of Object.values(overrides)) lines.push(body);
  return lines.join("\n");
}

/** Journalise l'id demandé puis renvoie une valeur sûre. */
const logged = (name: string, value: string) =>
  `export async function ${name}(id) { if (typeof id === "string" && id) (globalThis).__fetchLog.push(${JSON.stringify(
    name
  )} + ":" + id); return ${value}; }`;

const MOCK_DASHBOARD = buildServiceMock("lib/services/dashboard.ts", {
  getMerchantRestaurants: `export async function getMerchantRestaurants() { return (globalThis).__navMappings; }`,
  getDashboardOrders: logged("getDashboardOrders", "[]"),
  getReceiptSettings: logged("getReceiptSettings", "null"),
  getMerchantCatalogue: logged("getMerchantCatalogue", "[]"),
  getMerchantPaymentProviderConfig: logged("getMerchantPaymentProviderConfig", "[]"),
  getMerchantDeliveryFulfillmentPricing: logged("getMerchantDeliveryFulfillmentPricing", "[]"),
  getRestaurantSettings: logged("getRestaurantSettings", `{ staff_receipt_language: "fr", source_language: "fr" }`),
  getRestaurantActiveLanguages: logged(
    "getRestaurantActiveLanguages",
    `[{ code: "fr", label: "Francais", dir: "ltr", display_order: 1 }]`
  ),
  getRestaurantTranslationSettings: logged("getRestaurantTranslationSettings", `{ source_language: "fr" }`),
  getRestaurantCurrency: logged("getRestaurantCurrency", `"EUR"`),
  getSupportedLanguages: `export async function getSupportedLanguages() { return [{ code: "fr", label: "Francais" }]; }`,
});

const MOCK_ESTABLISHMENTS = buildServiceMock("lib/services/establishments.ts", {
  isScanymOperator: `export async function isScanymOperator() { return (globalThis).__navIsOperator; }`,
  getEstablishmentSummary: `export async function getEstablishmentSummary(id) {
  const known = { ${JSON.stringify(AU_LAIT_CRU)}: "Au lait cru", ${JSON.stringify(SANAA)}: "Sanaa Cookies & Fondant", ${JSON.stringify(ILLICO)}: "Illico Presto" };
  return { id, name: known[id] ?? id, slug: id };
}`,
  listEstablishments: `export async function listEstablishments() { return []; }`,
});

const mocks: Record<string, string> = {
  "next/navigation": `export function usePathname() { return (globalThis).__navPathname ?? "/dashboard"; }
const r = { replace: () => {}, push: () => {} };
export function useRouter() { return r; }`,
  "@/lib/services/auth": `export async function getUser() { return { id: "u" }; }
export async function getSession() { return { user: { id: "u" } }; }
export async function signOut() {}`,
  "@/lib/services/realtime": `export function subscribeToOrders(id) {
  (globalThis).__fetchLog.push("subscribeToOrders:" + id);
  return () => { (globalThis).__fetchLog.push("unsubscribeOrders:" + id); };
}`,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
};
if (existsSync(path.join(REPO_ROOT, "lib/services/legal-cgv.ts"))) {
  mocks["@/lib/services/legal-cgv"] = buildServiceMock("lib/services/legal-cgv.ts", {});
}

const mockPlugin: esbuild.Plugin = {
  name: "ctxhard-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "ctxmock" };
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
        return { path: c ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "ctxmock" }, (a) => ({ contents: mocks[a.path], loader: "ts" }));
  },
};

const built = await esbuild.build({
  stdin: {
    contents: `
      export { default as Orders } from "@/app/dashboard/page";
      export { default as Catalogue } from "@/app/dashboard/catalogue/page";
      export { default as Settings } from "@/app/dashboard/settings/page";
      export { default as Payment } from "@/app/dashboard/payment/page";
      export { default as Cgv } from "@/app/dashboard/legal-cgv/page";
      export { default as Delivery } from "@/app/dashboard/delivery-pricing/page";
      export { default as Translations } from "@/app/dashboard/translations/page";
    `,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-ctxhard-"));
const tmpFile = path.join(tmpDir, "pages.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const P = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

/** Les SEPT modules ciblés (§2). */
const PAGES: { label: string; Component: unknown; pathname: string }[] = [
  { label: "Orders", Component: P.Orders, pathname: "/dashboard" },
  { label: "Catalogue", Component: P.Catalogue, pathname: "/dashboard/catalogue" },
  { label: "Settings", Component: P.Settings, pathname: "/dashboard/settings" },
  { label: "Payment", Component: P.Payment, pathname: "/dashboard/payment" },
  { label: "CGV", Component: P.Cgv, pathname: "/dashboard/legal-cgv" },
  { label: "DeliveryPricing", Component: P.Delivery, pathname: "/dashboard/delivery-pricing" },
  { label: "Translations", Component: P.Translations, pathname: "/dashboard/translations" },
];

function flush(ms = 140): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function setUrl(pathname: string, search: string) {
  (globalThis as any).__navPathname = pathname;
  window.history.replaceState({}, "", pathname + search);
}

function resetLog() {
  (globalThis as any).__fetchLog = [];
}
function fetchLog(): string[] {
  return (globalThis as any).__fetchLog as string[];
}
/** Identifiants de restaurant pour lesquels des données ont été demandées. */
function fetchedRestaurantIds(): string[] {
  return [...new Set(fetchLog().map((e) => e.split(":")[1]))];
}

function mount(Component: unknown) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Component as any));
  return { container, root };
}

function headerName(c: Element): string {
  return c.querySelector("h1")?.textContent?.trim() ?? "";
}

function navLinkHref(c: Element, label: string): string | null {
  const a = [...c.querySelectorAll("a")].find((x) => x.textContent?.trim() === label);
  return a ? a.getAttribute("href") : null;
}

/**
 * Établissement sur lequel la page travaille réellement, lu depuis le
 * `?r=` que la navigation régénère (projection directe de
 * `restaurantId`, et ce qui sera transmis à la page suivante).
 */
function activeRestaurantId(c: Element): string | null {
  const href = navLinkHref(c, "Commandes");
  if (!href) return null;
  const q = href.indexOf("?");
  return q < 0 ? null : new URLSearchParams(href.slice(q + 1)).get("r");
}

function selectorValue(c: Element): string | null {
  const s = c.querySelector("select") as HTMLSelectElement | null;
  return s ? s.value : null;
}

function isFailClosed(c: Element): boolean {
  return c.querySelector("[data-context-unavailable]") !== null;
}

/**
 * CONTEXT HARDENING v1.1 -- remplace l'ancien `await flush(140)`.
 *
 * Ce délai fixe était une HYPOTHÈSE DE TEMPS : suffisante quand ce
 * fichier tournait seul, elle ne l'était plus quand la suite complète
 * s'exécute en parallèle (observé : `[CGV] A` échouait en régression
 * complète mais passait isolé). Le mandat interdit explicitement les
 * hypothèses de temps, et ces tests ont vocation à devenir une barrière
 * de publication PERMANENTE : une barrière instable est pire
 * qu'inutile, elle apprend à ignorer les échecs.
 *
 * Deux CONDITIONS OBSERVABLES remplacent le délai :
 *   1. la page a atteint un état terminal -- soit sa navigation est
 *      rendue, soit l'état "contexte indisponible" est affiché ;
 *   2. le journal des requêtes est au repos (aucune nouvelle requête
 *      sur plusieurs sondages consécutifs), pour que les assertions
 *      « aucune donnée d'un autre établissement » portent sur un
 *      journal complet et non sur un instantané prématuré.
 */
async function settleUntilStable(container: Element): Promise<void> {
  const sleep = () => new Promise((r) => setTimeout(r, 5));
  let reachedTerminalState = false;
  for (let i = 0; i < 400 && !reachedTerminalState; i += 1) {
    reachedTerminalState = navLinkHref(container, "Commandes") !== null || isFailClosed(container);
    if (!reachedTerminalState) await sleep();
  }
  let previousLength = -1;
  let quietRounds = 0;
  for (let i = 0; i < 400 && quietRounds < 6; i += 1) {
    const length = fetchLog().length;
    quietRounds = length === previousLength ? quietRounds + 1 : 0;
    previousLength = length;
    await sleep();
  }
}

/** Ouvre une page et retourne un instantané observable de son contexte. */
async function openPage(
  page: { label: string; Component: unknown; pathname: string },
  search: string,
  opts: { mappings?: unknown[]; isOperator?: boolean } = {}
) {
  if (opts.mappings) (globalThis as any).__navMappings = opts.mappings;
  (globalThis as any).__navIsOperator = opts.isOperator ?? false;
  resetLog();
  setUrl(page.pathname, search);
  const { container, root } = mount(page.Component);
  await settleUntilStable(container);
  const snap = {
    active: activeRestaurantId(container),
    header: headerName(container),
    selector: selectorValue(container),
    failClosed: isFailClosed(container),
    fetched: fetchedRestaurantIds(),
    ordersHref: navLinkHref(container, "Commandes"),
    container,
    root,
  };
  return snap;
}

async function closePage(snap: { container: Element; root: { unmount(): void } }) {
  snap.root.unmount();
  (snap.container as any).remove();
}

// ====================================================================
// §5 / §14 — MATRICE URL DIRECTE, pour CHACUN des sept modules.
// ====================================================================

for (const page of PAGES) {
  test(`[${page.label}] A — ?r= marchand VALIDE : sélectionne exactement cet établissement (jamais mappings[0])`, async () => {
    // Au lait cru est le SECOND rattachement : le sélectionner prouve
    // qu'aucun repli sur le premier n'a eu lieu.
    const s = await openPage(page, `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
    try {
      assert.equal(s.active, AU_LAIT_CRU, `${page.label} : contexte actif attendu Au lait cru, obtenu "${s.active}"`);
      assert.equal(s.failClosed, false, "un contexte valide ne doit pas déclencher l'état indisponible");
      assert.ok(!s.header.includes("Sanaa"), `l'entête ne doit pas afficher Sanaa (obtenu : "${s.header}")`);
      // §6-§12 : aucune donnée métier chargée pour un autre établissement.
      const foreign = s.fetched.filter((id) => id !== AU_LAIT_CRU);
      assert.deepEqual(foreign, [], `aucune donnée ne doit être chargée pour un autre établissement (obtenu : ${JSON.stringify(s.fetched)})`);
    } finally {
      await closePage(s);
    }
  });

  test(`[${page.label}] C — ?r= INVALIDE : fail closed, aucune donnée d'un autre établissement`, async () => {
    const s = await openPage(page, `?r=${FORGED}`, { mappings: MERCHANT_MAPPINGS });
    try {
      assert.equal(s.failClosed, true, `${page.label} : un ?r= non résoluble doit produire un état indisponible explicite`);
      assert.notEqual(s.active, SANAA, "aucun repli silencieux sur mappings[0]");
      assert.deepEqual(
        s.fetched,
        [],
        `${page.label} : AUCUNE donnée métier ne doit être chargée en contexte invalide (obtenu : ${JSON.stringify(s.fetched)})`
      );
    } finally {
      await closePage(s);
    }
  });

  test(`[${page.label}] D — aucun ?r= : repli documenté sur le premier rattachement, jamais une erreur`, async () => {
    const s = await openPage(page, "", { mappings: MERCHANT_MAPPINGS });
    try {
      assert.equal(s.active, SANAA, `${page.label} : sans contexte demandé, le premier rattachement est sélectionné`);
      assert.equal(s.failClosed, false, "l'absence de ?r= n'est pas une erreur de contexte");
    } finally {
      await closePage(s);
    }
  });

  test(`[${page.label}] B — contexte OPÉRATEUR Scanym : conserve l'établissement demandé, sans le forcer sur son premier rattachement`, async () => {
    const s = await openPage(page, `?r=${AU_LAIT_CRU}`, {
      mappings: OPERATOR_OWN_MAPPINGS, // ne contient PAS Au lait cru
      isOperator: true,
    });
    try {
      assert.equal(s.active, AU_LAIT_CRU, `${page.label} : le contexte opérateur doit être préservé`);
      assert.equal(s.failClosed, false, "un opérateur autorisé ne doit pas voir l'état indisponible");
      assert.ok(!s.header.includes("Sanaa"), `§17 : l'entête ne doit jamais annoncer Sanaa (obtenu : "${s.header}")`);
      // §17 -- le sélecteur ne doit pas prétendre qu'un AUTRE
      // établissement est sélectionné.
      assert.notEqual(
        s.selector,
        SANAA,
        `§17 : le sélecteur affiche "${s.selector}" alors que le contexte réel est Au lait cru`
      );
      const foreign = s.fetched.filter((id) => id !== AU_LAIT_CRU);
      assert.deepEqual(foreign, [], `aucune donnée d'un autre établissement (obtenu : ${JSON.stringify(s.fetched)})`);
    } finally {
      await closePage(s);
    }
  });

  test(`[${page.label}] H — l'ORDRE des rattachements ne change pas le contexte explicite`, async () => {
    const a = await openPage(page, `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
    const first = a.active;
    await closePage(a);
    const b = await openPage(page, `?r=${AU_LAIT_CRU}`, { mappings: [...MERCHANT_MAPPINGS].reverse() });
    const second = b.active;
    await closePage(b);
    assert.equal(first, AU_LAIT_CRU);
    assert.equal(second, AU_LAIT_CRU);
    assert.equal(first, second, `${page.label} : le contexte explicite doit être indépendant de l'ordre des mappings`);
  });

  test(`[${page.label}] E/F/G — rafraîchissement et navigation arrière/avant : contexte déterministe et stable`, async () => {
    // Rafraîchissement = remontage à la même URL.
    const r1 = await openPage(page, `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
    const v1 = r1.active;
    await closePage(r1);
    const r2 = await openPage(page, `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
    const v2 = r2.active;
    await closePage(r2);
    assert.equal(v1, AU_LAIT_CRU);
    assert.equal(v2, AU_LAIT_CRU, `${page.label} : le rafraîchissement doit conserver l'établissement`);

    // Arrière/avant : l'URL redevient celle de l'autre établissement,
    // puis revient. Chaque rendu est piloté EXCLUSIVEMENT par l'URL --
    // il n'existe aucun état rémanent hors URL qui pourrait diverger.
    const back = await openPage(page, `?r=${SANAA}`, { mappings: MERCHANT_MAPPINGS });
    const vBack = back.active;
    await closePage(back);
    const fwd = await openPage(page, `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
    const vFwd = fwd.active;
    await closePage(fwd);
    assert.equal(vBack, SANAA, `${page.label} : retour arrière -> Sanaa`);
    assert.equal(vFwd, AU_LAIT_CRU, `${page.label} : avance -> Au lait cru`);
  });

  test(`[${page.label}] §16 — cohérence URL / entête / sélecteur / données / liens générés`, async () => {
    const s = await openPage(page, `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
    try {
      assert.equal(s.active, AU_LAIT_CRU, "contexte interne");
      assert.ok(s.header.includes("Au lait cru"), `entête (obtenu : "${s.header}")`);
      if (s.selector !== null) {
        assert.equal(s.selector, AU_LAIT_CRU, `sélecteur (obtenu : "${s.selector}")`);
      }
      for (const id of s.fetched) {
        assert.equal(id, AU_LAIT_CRU, `données chargées pour ${id} au lieu de Au lait cru`);
      }
      assert.equal(s.ordersHref, `/dashboard?r=${AU_LAIT_CRU}`, "liens de navigation générés");
    } finally {
      await closePage(s);
    }
  });
}

// ====================================================================
// §13 — MATRICE DE NAVIGATION CROISÉE (A et B).
// ====================================================================

const CROSS: [string, string][] = [
  ["Orders", "Catalogue"], ["Catalogue", "Orders"],
  ["Orders", "Settings"], ["Settings", "Orders"],
  ["Orders", "Payment"], ["Payment", "Orders"],
  ["Orders", "CGV"], ["CGV", "Orders"],
  ["Orders", "DeliveryPricing"], ["DeliveryPricing", "Orders"],
  ["Orders", "Translations"], ["Translations", "Orders"],
  ["Catalogue", "Settings"], ["Settings", "Catalogue"],
  ["Payment", "CGV"], ["CGV", "Payment"],
  ["Translations", "Catalogue"], ["Catalogue", "Translations"],
];

/** Libellé d'onglet de DashboardNav pour chaque module. */
const TAB_LABEL: Record<string, string> = {
  Orders: "Commandes",
  Catalogue: "Ma carte",
  Settings: "Réglages",
  Payment: "Paiement",
  CGV: "CGV",
  DeliveryPricing: "Tarifs de livraison",
  Translations: "Langues & traductions",
};

const PAGE_BY_LABEL = Object.fromEntries(PAGES.map((p) => [p.label, p]));

for (const restaurantId of [AU_LAIT_CRU, SANAA]) {
  const who = restaurantId === AU_LAIT_CRU ? "Au lait cru" : "Sanaa";
  test(`§13 — navigation croisée (${who}) : chaque transition conserve l'établissement`, async () => {
    for (const [from, to] of CROSS) {
      const src = PAGE_BY_LABEL[from];
      const s = await openPage(src, `?r=${restaurantId}`, { mappings: MERCHANT_MAPPINGS });
      try {
        assert.equal(s.active, restaurantId, `${from} : contexte source incorrect`);
        const href = navLinkHref(s.container, TAB_LABEL[to]);
        assert.ok(href, `${from} -> ${to} : l'onglet "${TAB_LABEL[to]}" doit exister`);
        assert.ok(
          href!.includes(`?r=${restaurantId}`),
          `${from} -> ${to} : le lien doit transporter ${who} (obtenu : "${href}")`
        );
      } finally {
        await closePage(s);
      }
      // La page de destination, ouverte avec ce lien, doit conserver
      // le même établissement.
      const dst = PAGE_BY_LABEL[to];
      const d = await openPage(dst, `?r=${restaurantId}`, { mappings: MERCHANT_MAPPINGS });
      try {
        assert.equal(d.active, restaurantId, `${from} -> ${to} : la destination a changé d'établissement`);
      } finally {
        await closePage(d);
      }
    }
  });
}

// ====================================================================
// §15 — ASYNC / RACE : aucune sélection transitoire de mappings[0].
// ====================================================================

for (const page of PAGES) {
  test(`[${page.label}] §15 — aucune sélection TRANSITOIRE de mappings[0], aucune donnée chargée pour un autre établissement`, async () => {
    (globalThis as any).__navMappings = MERCHANT_MAPPINGS; // Sanaa en premier
    (globalThis as any).__navIsOperator = false;
    resetLog();
    setUrl(page.pathname, `?r=${AU_LAIT_CRU}`);
    const { container, root } = mount(page.Component);
    try {
      const observed: (string | null)[] = [];
      for (let i = 0; i < 30; i += 1) {
        await flush(5);
        const v = activeRestaurantId(container);
        if (v !== null) observed.push(v);
      }
      assert.equal(
        observed.some((v) => v === SANAA),
        false,
        `${page.label} : sélection transitoire de mappings[0] détectée : ${JSON.stringify(observed)}`
      );
      assert.equal(observed[observed.length - 1], AU_LAIT_CRU, `${page.label} : état final incorrect`);
      const foreign = fetchedRestaurantIds().filter((id) => id !== AU_LAIT_CRU);
      assert.deepEqual(
        foreign,
        [],
        `${page.label} : requête émise pour un autre établissement pendant le chargement : ${JSON.stringify(foreign)}`
      );
    } finally {
      root.unmount();
      container.remove();
    }
  });
}

// ====================================================================
// §6 — Orders : aucune souscription temps réel sous établissement
// substitué, et nettoyage à la bascule.
// ====================================================================

test("§6 — Orders : la souscription temps réel ne vise QUE l'établissement résolu, et est nettoyée au démontage", async () => {
  const s = await openPage(PAGES[0], `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
  const subs = fetchLog().filter((e) => e.startsWith("subscribeToOrders:"));
  await closePage(s);
  assert.ok(subs.length > 0, "une souscription doit exister");
  for (const e of subs) {
    assert.equal(e, `subscribeToOrders:${AU_LAIT_CRU}`, `souscription sous un autre établissement : ${e}`);
  }
  const unsubs = fetchLog().filter((e) => e.startsWith("unsubscribeOrders:"));
  assert.ok(unsubs.length > 0, "la souscription doit être nettoyée au démontage");
});

test("§6 — Orders : contexte invalide -> AUCUNE souscription temps réel, AUCUN fetch commandes/réglages ticket", async () => {
  const s = await openPage(PAGES[0], `?r=${FORGED}`, { mappings: MERCHANT_MAPPINGS });
  try {
    assert.equal(s.failClosed, true, "fail closed attendu");
    assert.deepEqual(fetchLog(), [], `aucune requête ne doit partir : ${JSON.stringify(fetchLog())}`);
  } finally {
    await closePage(s);
  }
});

// ====================================================================
// §18 — contexte forgé : le client ne doit jamais charger de données
// pour un établissement non autorisé. (L'autorisation RÉELLE est
// serveur -- voir SECURITY-EVIDENCE.md ; ce test couvre la couche
// cliente, qui est celle que ce lot modifie.)
// ====================================================================

for (const page of PAGES) {
  test(`[${page.label}] §18 — ?r= forgé non autorisé : aucune lecture ni écriture déclenchée côté client`, async () => {
    const s = await openPage(page, `?r=${FORGED}`, { mappings: MERCHANT_MAPPINGS });
    try {
      assert.equal(s.failClosed, true, `${page.label} : doit échouer explicitement`);
      assert.deepEqual(
        fetchLog(),
        [],
        `${page.label} : aucune requête ne doit être émise avec un contexte forgé (obtenu : ${JSON.stringify(fetchLog())})`
      );
    } finally {
      await closePage(s);
    }
  });
}

// ====================================================================
// §15 — isolation A -> B : les données de A ne doivent jamais être
// rendues après bascule vers B.
// ====================================================================

test("§15 — isolation marchand A -> B : après bascule, aucune donnée ni entête de A ne subsiste", async () => {
  const a = await openPage(PAGES[0], `?r=${AU_LAIT_CRU}`, { mappings: MERCHANT_MAPPINGS });
  assert.equal(a.active, AU_LAIT_CRU);
  assert.ok(a.header.includes("Au lait cru"));
  await closePage(a);

  const b = await openPage(PAGES[0], `?r=${SANAA}`, { mappings: MERCHANT_MAPPINGS });
  try {
    assert.equal(b.active, SANAA, "après bascule, le contexte doit être B");
    assert.ok(b.header.includes("Sanaa"), `entête B attendue (obtenu : "${b.header}")`);
    const foreign = b.fetched.filter((id) => id !== SANAA);
    assert.deepEqual(foreign, [], `aucune donnée de A après bascule : ${JSON.stringify(foreign)}`);
  } finally {
    await closePage(b);
  }
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
