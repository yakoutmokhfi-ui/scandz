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

const { supabase } = await import("../lib/supabase.ts");
const { createTrackingSessionToken, TRACKING_SESSION_COOKIE_NAME } = await import(
  "../lib/server/tracking-session.ts"
);

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

// La commande RÉELLEMENT ouverte a une session VALIDE ET EXISTANTE --
// construite avec le VRAI mécanisme de chiffrement AES-256-GCM, jamais
// une chaîne fabriquée à la main.
// CUSTOMER TRACKING v3.1 : la session porte la capacité de suivi.
const CAP_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "ab".repeat(32);
const EXISTING_SESSION_TOKEN = createTrackingSessionToken(ORDER_ID, CAP_ID, SECRET);

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
export { default as OrderConfirmation } from "@/components/OrderConfirmation";
export { default as WithdrawalPanel } from "@/components/WithdrawalPanel";
export * as linkHelpers from "@/lib/tracking/link";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-wdirect-"));
const tmpFile = path.join(tmpDir, "Bundle.mjs");
writeFileSync(tmpFile, code);
const { TrackingPage, OrderConfirmation, WithdrawalPanel, linkHelpers } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(check: () => boolean, description: string, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    await flush(intervalMs);
  }
}

// ====================================================================
// RÉTRACTATION DIRECTE -- « Demander une rétractation » (écran de
// confirmation) doit ouvrir DIRECTEMENT le formulaire.
//
// CONTRAT (mandat CIO) :
//   - le bouton n'affiche PAS d'abord la page de suivi, sa frise de
//     statuts, ni un SECOND bouton de rétractation ;
//   - la vérification serveur de l'éligibilité et la protection par
//     jeton sont CONSERVÉES : connaître l'identifiant de commande ne
//     donne aucun accès au formulaire ;
//   - la vue par défaut `/track/<id>` est inchangée.
//
// Mécanisme : `/track/<id>?view=withdrawal#<jeton>`. Le jeton reste
// UNIQUEMENT dans le fragment (jamais envoyé au serveur) ; `view` est
// un paramètre de PRÉSENTATION à liste blanche stricte, sans pouvoir
// d'accès : sans session valide, la page affiche la même passerelle
// d'entrée qu'avant.
// ====================================================================

const OTHER_ORDER_ID = "44444444-4444-4444-8444-444444444444";
const LINE_A = "55555555-5555-4555-8555-555555555555";
const LINE_B = "66666666-6666-4666-8666-666666666666";

const OPTION_ROWS = [
  {
    bound_order_id: ORDER_ID,
    order_number: 104,
    order_item_id: LINE_A,
    item_name: "Fromage frais",
    option_name: null,
    ordered_quantity: 2,
    already_requested: 0,
    remaining_quantity: 2,
  },
  {
    bound_order_id: ORDER_ID,
    order_number: 104,
    order_item_id: LINE_B,
    item_name: "Yaourt",
    option_name: "Nature",
    ordered_quantity: 1,
    already_requested: 0,
    remaining_quantity: 1,
  },
];

interface RpcPlan {
  options?: unknown[] | "error";
  tracking?: boolean;
}

function installRpc(t: { mock: { method: Function } }, plan: RpcPlan = {}) {
  const calls: string[] = [];
  t.mock.method(supabase, "rpc", async (name: string) => {
    calls.push(name);
    if (name === "get_order_tracking_by_capability") return { data: [VALID_ROW], error: null };
    if (name === "get_withdrawal_options_by_capability") {
      if (plan.options === "error") return { data: null, error: { message: "boom" } };
      return { data: plan.options ?? OPTION_ROWS, error: null };
    }
    if (name === "get_order_tracking_customer_context_by_capability") return { data: [], error: null };
    if (name === "get_order_tracking_status_text_by_capability") return { data: [], error: null };
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });
  return calls;
}

const VALID_ROW = {
  bound_order_id: ORDER_ID,
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

const GOOD_COOKIE = createTrackingSessionToken(ORDER_ID, CAP_ID, SECRET);

function setLocation(pathAndQuery: string, hash = "") {
  dom.reconfigure({ url: `http://localhost${pathAndQuery}${hash}` });
}

async function renderPage(opts: {
  search?: Record<string, string | string[] | undefined>;
  cookie?: string | null;
  orderId?: string;
}) {
  (globalThis as any).__mockCookieStore =
    opts.cookie === null ? {} : { [TRACKING_SESSION_COOKIE_NAME]: opts.cookie ?? GOOD_COOKIE };
  const element = await TrackingPage({
    params: Promise.resolve({ orderId: opts.orderId ?? ORDER_ID }),
    searchParams: Promise.resolve(opts.search ?? {}),
  });
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  await flush(40);
  return { container, root };
}

const q = (c: Element, sel: string) => c.querySelector(sel);
const FORM_STEP = '[data-withdrawal-step="selection"]';
const OPEN_BTN = '[data-withdrawal-action="open"]';

function assertNoTrackingView(c: Element) {
  assert.ok(q(c, "ol") === null, "aucune frise de statuts");
  assert.ok(q(c, "[data-tracking-status-text]") === null, "aucun texte de statut de suivi");
  assert.equal(q(c, "[aria-live=polite]") !== null && /Prête|retrait/.test(c.textContent ?? "") , false, "aucun badge de statut");
  assert.equal(/Actualiser le suivi/.test(c.textContent ?? ""), false, "aucun lien d'actualisation du suivi");
  assert.equal(/Suivi de (ma )?commande/i.test(c.textContent ?? ""), false, "aucun titre de page de suivi");
}

// ------------------------------------------------------------------
// 1. Bouton de l'écran de confirmation
// ------------------------------------------------------------------

async function renderConfirmation(props: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderConfirmation, {
      restaurant: {
        id: "r1", name: "Epicerie Alpha (test)", slug: "epicerie-alpha", is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        config: { restaurant_id: "r1", max_tables: 1, currency: "EUR", whatsapp_number: "+33600000000", whatsapp_enabled: true, address: null, latitude: null, longitude: null, logo_url: null, cover_url: null, opening_hours: null, source_language: "fr" },
        categories: [], hiddenCategories: [], activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
      },
      context: null,
      orderNumber: 42,
      onBackToMenu: () => {},
      onNewOrder: () => {},
      ...props,
    })
  );
  await flush();
  return { container, root };
}

test("[WD-1] « Demander une rétractation » pointe vers la VUE FORMULAIRE : /track/<id>?view=withdrawal#<jeton> (jeton uniquement dans le fragment)", async () => {
  const { container, root } = await renderConfirmation({
    trackingPath: `/track/${ORDER_ID}#${TOKEN}`,
    withdrawalEligible: true,
  });
  try {
    const a = container.querySelector("[data-order-confirmation-withdrawal]") as HTMLAnchorElement | null;
    assert.ok(a, "le bouton doit exister quand l'éligibilité est prouvée");
    assert.equal(a!.getAttribute("href"), `/track/${ORDER_ID}?view=withdrawal#${TOKEN}`);
    assert.equal((a!.getAttribute("href") ?? "").split("#")[0]!.includes(TOKEN), false, "le jeton ne doit jamais être dans le chemin ou la requête");
    assert.equal(a!.textContent?.trim(), "Demander une rétractation");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-2] le bouton reste ABSENT sans preuve d'éligibilité ou sans lien de suivi (échec fermé inchangé)", async () => {
  for (const props of [
    { trackingPath: `/track/${ORDER_ID}#${TOKEN}`, withdrawalEligible: false },
    { trackingPath: `/track/${ORDER_ID}#${TOKEN}`, withdrawalEligible: undefined },
    { trackingPath: null, withdrawalEligible: true },
    { trackingPath: "https://evil.example/x", withdrawalEligible: true },
    { trackingPath: `/track/not-a-uuid#${TOKEN}`, withdrawalEligible: true },
    { trackingPath: `/track/${ORDER_ID}`, withdrawalEligible: true },
  ]) {
    const { container, root } = await renderConfirmation(props);
    try {
      assert.ok(container.querySelector("[data-order-confirmation-withdrawal]") === null,
        `bouton inattendu pour ${JSON.stringify(props)}`
      );
    } finally {
      root.unmount();
      container.remove();
    }
  }
});

test("[WD-3] helpers de lien : construction stricte, aucune fuite de jeton, liste blanche de vue", () => {
  const h = linkHelpers as any;
  assert.equal(h.buildWithdrawalViewPath(ORDER_ID, TOKEN), `/track/${ORDER_ID}?view=withdrawal#${TOKEN}`);
  assert.equal(h.withdrawalViewPathFromTrackingPath(`/track/${ORDER_ID}#${TOKEN}`), `/track/${ORDER_ID}?view=withdrawal#${TOKEN}`);
  // Entrées mal formées : null (échec fermé), jamais une URL « réparée ».
  for (const bad of ["", "/track/", `/track/${ORDER_ID}`, `/track/${ORDER_ID}#`, `//evil.example/track/${ORDER_ID}#${TOKEN}`, `/track/${ORDER_ID}?x=1#${TOKEN}`, `/track/${ORDER_ID}/../x#${TOKEN}`, `/track/${ORDER_ID}#${TOKEN}#2`, `http://x/track/${ORDER_ID}#${TOKEN}`, "/track/zzz#abc"]) {
    assert.equal(h.withdrawalViewPathFromTrackingPath(bad), null, `devrait être refusé : ${JSON.stringify(bad)}`);
  }
  // Liste blanche stricte de `view`.
  assert.equal(h.parseTrackingView("withdrawal"), "withdrawal");
  for (const bad of [undefined, "", "Withdrawal", "withdrawal ", "withdrawal,x", "tracking", "../", "__proto__", ["withdrawal"], ["withdrawal", "x"], ["x", "withdrawal"], 1, null]) {
    assert.equal(h.parseTrackingView(bad as any), null, `devrait être refusé : ${JSON.stringify(bad)}`);
  }
  // Chemin propre : inchangé par défaut, `view` optionnel et seul paramètre.
  assert.equal(h.buildCleanTrackingPath(ORDER_ID), `/track/${ORDER_ID}`);
  assert.equal(h.buildCleanTrackingPath(ORDER_ID, "withdrawal"), `/track/${ORDER_ID}?view=withdrawal`);
  assert.equal(h.buildCleanTrackingPath(ORDER_ID, null), `/track/${ORDER_ID}`);
});

// ------------------------------------------------------------------
// 2. Accès direct au formulaire (session valide + éligibilité prouvée)
// ------------------------------------------------------------------

test("[WD-4] ?view=withdrawal + session valide + lignes éligibles : le FORMULAIRE s'affiche directement -- ni suivi, ni frise, ni second bouton", async (t) => {
  const calls = installRpc(t);
  setLocation(`/track/${ORDER_ID}?view=withdrawal`);
  const { container, root } = await renderPage({ search: { view: "withdrawal" } });
  try {
    assert.ok(q(container, FORM_STEP), "le formulaire (étape de sélection) doit être affiché d'emblée");
    assert.ok(q(container, OPEN_BTN) === null, "aucun SECOND bouton « Exercer mon droit de rétractation »");
    assertNoTrackingView(container);
    // Les lignes éligibles sont proposées, rien d'autre.
    assert.ok(q(container, `[data-withdrawal-line="${LINE_A}"]`));
    assert.ok(q(container, `[data-withdrawal-line="${LINE_B}"]`));
    assert.ok((container.textContent ?? "").includes("104"), "référence de commande affichée par le formulaire");
    // La vérification serveur d'éligibilité a bien eu lieu.
    assert.ok(calls.includes("get_withdrawal_options_by_capability"));
    // Ouvrir le formulaire n'écrit RIEN.
    assert.equal(calls.some((c) => /create|insert|withdrawal_request|submit/i.test(c) && c !== "get_withdrawal_options_by_capability"), false);
    // Pas de jeton dans le HTML rendu.
    assert.equal(container.innerHTML.includes(TOKEN), false);
    assert.equal(container.innerHTML.includes(SECRET), false);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-5] le formulaire direct est UTILISABLE : sélection -> « Continuer » -> étape de vérification, sans aucun appel réseau avant la confirmation", async (t) => {
  installRpc(t);
  const fetchCalls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    fetchCalls.push(url);
    throw new Error("aucun appel réseau avant la confirmation");
  };
  setLocation(`/track/${ORDER_ID}?view=withdrawal`);
  const { container, root } = await renderPage({ search: { view: "withdrawal" } });
  try {
    const check = q(container, `[data-withdrawal-line="${LINE_A}"] input[type=checkbox]`) as HTMLInputElement | null;
    assert.ok(check, "case de sélection de la première ligne");
    check!.click();
    await flush(30);
    const cont = q(container, '[data-withdrawal-action="continue"]') as HTMLButtonElement | null;
    assert.ok(cont, "bouton Continuer");
    cont!.click();
    await flush(30);
    assert.ok(q(container, '[data-withdrawal-step="review"]'), "étape de vérification atteinte");
    assert.deepEqual(fetchCalls, [], "rien n'est envoyé tant que la rétractation n'est pas confirmée");
  } finally {
    root.unmount();
    container.remove();
    delete (globalThis as any).fetch;
  }
});

test("[WD-6] la langue est respectée dans la vue formulaire (?lang=en)", async (t) => {
  installRpc(t);
  setLocation(`/track/${ORDER_ID}?view=withdrawal&lang=en`);
  const { container, root } = await renderPage({ search: { view: "withdrawal", lang: "en" } });
  try {
    assert.ok(q(container, FORM_STEP));
    assert.ok((container.textContent ?? "").includes("withdrawal"), "libellés anglais attendus");
    assert.equal((container.textContent ?? "").includes("Exercer mon droit"), false);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ------------------------------------------------------------------
// 3. Vue par défaut INCHANGÉE + valeurs de `view` non reconnues
// ------------------------------------------------------------------

test("[WD-7] sans `view` : la page de suivi complète est inchangée (frise, statut, bouton d'ouverture du formulaire FERMÉ)", async (t) => {
  installRpc(t);
  setLocation(`/track/${ORDER_ID}`);
  const { container, root } = await renderPage({ search: {} });
  try {
    assert.ok(q(container, "ol"), "frise de suivi présente");
    assert.ok(q(container, "[data-tracking-status-text]"));
    assert.ok(q(container, OPEN_BTN), "le formulaire reste fermé derrière son bouton dans la vue de suivi");
    assert.ok(q(container, FORM_STEP) === null);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-8] valeurs de `view` inconnues, mal casées, répétées ou vides : retombent sur la vue de suivi par défaut (liste blanche stricte)", async (t) => {
  installRpc(t);
  for (const view of ["foo", "Withdrawal", "WITHDRAWAL", "withdrawal ", "", ["withdrawal", "withdrawal"], ["x", "withdrawal"], undefined] as Array<string | string[] | undefined>) {
    setLocation(`/track/${ORDER_ID}`);
    const { container, root } = await renderPage({ search: { view } });
    try {
      assert.ok(q(container, "ol"), `vue de suivi attendue pour view=${JSON.stringify(view)}`);
      assert.ok(q(container, FORM_STEP) === null, `formulaire ouvert à tort pour view=${JSON.stringify(view)}`);
    } finally {
      root.unmount();
      container.remove();
    }
  }
});

// ------------------------------------------------------------------
// 4. PROTECTION : connaître l'identifiant ne donne aucun accès
// ------------------------------------------------------------------

test("[WD-9] ?view=withdrawal SANS session : passerelle d'entrée uniquement -- aucun formulaire, aucune lecture d'éligibilité, aucune donnée de commande", async (t) => {
  const calls = installRpc(t);
  setLocation(`/track/${ORDER_ID}?view=withdrawal`); // aucun fragment
  const { container, root } = await renderPage({ search: { view: "withdrawal" }, cookie: null });
  try {
    await flush(60);
    assert.ok(q(container, FORM_STEP) === null);
    assert.ok(q(container, OPEN_BTN) === null);
    assert.ok(q(container, "[data-withdrawal-line]") === null);
    assert.equal((container.textContent ?? "").includes("Fromage"), false, "aucune ligne de commande divulguée");
    assert.equal((container.textContent ?? "").includes("104"), false, "aucun numéro de commande divulgué");
    assert.deepEqual(calls, [], "aucune RPC : la capacité n'a pas été prouvée");
    // Lien invalide (pas de fragment) : message générique « lien introuvable ».
    assert.ok((container.textContent ?? "").includes("Lien de suivi introuvable"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-10] session d'une AUTRE commande / cookie altéré / cookie vide : même refus, aucun formulaire", async (t) => {
  const calls = installRpc(t);
  const otherSession = createTrackingSessionToken(OTHER_ORDER_ID, CAP_ID, SECRET);
  const tampered = GOOD_COOKIE.slice(0, -4) + (GOOD_COOKIE.endsWith("AAAA") ? "BBBB" : "AAAA");
  for (const cookie of [otherSession, tampered, "", "garbage"]) {
    setLocation(`/track/${ORDER_ID}?view=withdrawal`);
    const { container, root } = await renderPage({ search: { view: "withdrawal" }, cookie });
    try {
      await flush(40);
      assert.ok(q(container, FORM_STEP) === null, `formulaire exposé avec le cookie ${cookie.slice(0, 8)}…`);
      assert.equal((container.textContent ?? "").includes("Fromage"), false);
    } finally {
      root.unmount();
      container.remove();
    }
  }
  assert.deepEqual(calls, [], "aucune lecture d'éligibilité sans session valide pour CETTE commande");
});

test("[WD-11] identifiant de commande malformé : réponse générique, aucune RPC", async (t) => {
  const calls = installRpc(t);
  const { container, root } = await renderPage({ search: { view: "withdrawal" }, orderId: "not-a-uuid" });
  try {
    assert.ok(q(container, FORM_STEP) === null);
    assert.ok((container.textContent ?? "").includes("Lien de suivi introuvable"));
    assert.deepEqual(calls, []);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ------------------------------------------------------------------
// 5. Éligibilité vérifiée côté serveur : états de repli
// ------------------------------------------------------------------

test("[WD-12] session valide mais AUCUNE ligne éligible : pas de formulaire, message clair et lien vers le suivi (jamais un formulaire vide)", async (t) => {
  installRpc(t, { options: [] });
  setLocation(`/track/${ORDER_ID}?view=withdrawal`);
  const { container, root } = await renderPage({ search: { view: "withdrawal" } });
  try {
    assert.ok(q(container, FORM_STEP) === null);
    assert.ok(q(container, OPEN_BTN) === null);
    assert.ok(q(container, "[data-withdrawal-unavailable=none]"), "état « aucune ligne éligible » explicite");
    const back = q(container, "a[data-withdrawal-back-to-tracking]") as HTMLAnchorElement | null;
    assert.ok(back, "lien de retour vers le suivi");
    assert.equal(back!.getAttribute("href"), `/track/${ORDER_ID}`, "chemin propre, jamais de jeton");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-13] erreur de lecture d'éligibilité : échec FERMÉ (aucun formulaire), message d'indisponibilité temporaire avec repli", async (t) => {
  installRpc(t, { options: "error" });
  setLocation(`/track/${ORDER_ID}?view=withdrawal`);
  const { container, root } = await renderPage({ search: { view: "withdrawal" } });
  try {
    assert.ok(q(container, FORM_STEP) === null);
    assert.ok(q(container, "[data-withdrawal-unavailable=error]"), "état d'indisponibilité temporaire explicite");
    assert.ok(q(container, "a[data-withdrawal-back-to-tracking]"));
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-14] la RPC renvoie une ligne liée à une AUTRE commande : refus (défense en profondeur), aucun formulaire, aucune ligne rendue", async (t) => {
  installRpc(t, { options: [{ ...OPTION_ROWS[0]!, bound_order_id: OTHER_ORDER_ID }] });
  setLocation(`/track/${ORDER_ID}?view=withdrawal`);
  const { container, root } = await renderPage({ search: { view: "withdrawal" } });
  try {
    assert.ok(q(container, FORM_STEP) === null);
    assert.equal((container.textContent ?? "").includes("Fromage"), false);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ------------------------------------------------------------------
// 6. Passerelle d'entrée : `view` survit à l'échange, le jeton non
// ------------------------------------------------------------------

async function runGate(url: string, hash: string) {
  setLocation(url, hash);
  (globalThis as any).__mockRefreshCount = 0;
  const fetchCalls: Array<{ url: string; body: any }> = [];
  (globalThis as any).fetch = async (u: string, init: RequestInit) => {
    fetchCalls.push({ url: u, body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { container, root } = await renderPage({ search: {}, cookie: null });
  await waitFor(() => fetchCalls.length > 0, "échange tenté");
  await waitFor(() => (globalThis as any).__mockRefreshCount > 0, "rafraîchissement demandé");
  const result = { search: window.location.search, hash: window.location.hash, path: window.location.pathname, fetchCalls };
  root.unmount();
  container.remove();
  delete (globalThis as any).fetch;
  return result;
}

test("[WD-15] passerelle : après échange, `?view=withdrawal` est CONSERVÉ, le fragment (jeton) retiré, et le jeton ne part que dans le corps du POST", async (t) => {
  installRpc(t);
  const r = await runGate(`/track/${ORDER_ID}?view=withdrawal`, `#${TOKEN}`);
  assert.equal(r.path, `/track/${ORDER_ID}`);
  assert.equal(r.search, "?view=withdrawal");
  assert.equal(r.hash, "");
  assert.equal(r.fetchCalls.length, 1);
  assert.equal(r.fetchCalls[0]!.url, "/api/track/exchange");
  assert.deepEqual(r.fetchCalls[0]!.body, { orderId: ORDER_ID, publicToken: TOKEN });
});

test("[WD-16] passerelle : sans `view`, ou avec une valeur inconnue/malveillante, l'URL redevient le chemin PROPRE (comportement inchangé, rien de plus n'est conservé)", async (t) => {
  installRpc(t);
  for (const search of ["", "?view=foo", "?view=withdrawal&view=x", "?view=Withdrawal", "?x=1&view=withdrawal", "?lang=en"]) {
    const r = await runGate(`/track/${ORDER_ID}${search}`, `#${TOKEN}`);
    // `?x=1&view=withdrawal` et `?lang=en` : seul `view=withdrawal` EXACT et SEUL est conservé.
    assert.equal(r.path, `/track/${ORDER_ID}`);
    assert.equal(r.search, "", `requête conservée à tort pour ${search}`);
    assert.equal(r.hash, "");
  }
});

test("[WD-18] parcours bout en bout : lien du bouton -> passerelle (échange) -> `view=withdrawal` survit dans l'URL -> la page rend le formulaire seul, sans frise ni second bouton", async (t) => {
  installRpc(t);
  // 1. Le lien exact produit par l'écran de confirmation.
  const { container: conf, root: confRoot } = await renderConfirmation({
    trackingPath: `/track/${ORDER_ID}#${TOKEN}`,
    withdrawalEligible: true,
  });
  const href = (conf.querySelector("[data-order-confirmation-withdrawal]") as HTMLAnchorElement).getAttribute("href")!;
  confRoot.unmount();
  conf.remove();
  assert.equal(href, `/track/${ORDER_ID}?view=withdrawal#${TOKEN}`);

  // 2. Première visite SANS session : la passerelle échange le jeton (corps du POST)
  //    puis réécrit l'URL en conservant `?view=withdrawal` et en retirant le fragment.
  const u = new URL(href, "http://localhost");
  const gate = await runGate(u.pathname + u.search, u.hash);
  assert.equal(gate.search, "?view=withdrawal");
  assert.equal(gate.hash, "");
  assert.deepEqual(gate.fetchCalls[0]!.body, { orderId: ORDER_ID, publicToken: TOKEN });

  // 3. Le rendu serveur qui suit (session désormais posée) reçoit cette même requête.
  const view = new URLSearchParams(gate.search).get("view") ?? undefined;
  const { container, root } = await renderPage({ search: { view } });
  try {
    assert.ok(q(container, FORM_STEP), "formulaire ouvert d'emblée");
    assert.ok(q(container, OPEN_BTN) === null, "aucun second bouton");
    assertNoTrackingView(container);
    assert.equal(container.innerHTML.includes(TOKEN), false);
  } finally {
    root.unmount();
    container.remove();
  }
});

// ------------------------------------------------------------------
// 6b. « Retour » de la vue autonome (défaut P3, contre-audit Turing sur 5b81d34)
//
// Dans la vue formulaire seule, « Retour » (première étape) refermait le
// formulaire et ramenait le client à un bouton d'entrée REDONDANT
// (« Exercer mon droit de rétractation ») -- exactement l'écran
// intermédiaire que le parcours direct supprime. Destination cohérente :
// la page de suivi PARENT (`/track/<id>`, chemin propre, sans jeton ni
// requête) où ce panneau vit déjà derrière son bouton d'entrée ; elle
// repasse par la session serveur, donc ne contourne aucune vérification.
// ------------------------------------------------------------------

function backControl(c: Element): HTMLElement | null {
  const section = q(c, FORM_STEP);
  if (!section) return null;
  return ([...section.querySelectorAll("a,button")] as HTMLElement[]).find(
    (el) => (el.textContent ?? "").trim() === "Retour"
  ) ?? null;
}

test("[WD-19] vue autonome, étape de sélection : « Retour » mène à la page de suivi PARENT (lien propre, sans jeton ni requête) -- il ne referme pas le formulaire sur un bouton d'entrée redondant", async (t) => {
  installRpc(t);
  setLocation(`/track/${ORDER_ID}?view=withdrawal`);
  const { container, root } = await renderPage({ search: { view: "withdrawal" } });
  try {
    const back = backControl(container);
    assert.ok(back, "un contrôle « Retour » existe à la première étape");
    // Reproduction du défaut : activer « Retour » ne doit JAMAIS laisser le client sur le
    // bouton d'entrée redondant (avant le correctif, le panneau se refermait dessus).
    back!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    await flush(30);
    assert.ok(q(container, OPEN_BTN) === null, "jamais le bouton d'entrée redondant après « Retour »");
    // Le contrôle est une vraie navigation vers la page parent, au chemin PROPRE.
    assert.equal(backControl(container) === null ? "A" : backControl(container)!.tagName, "A", "navigation réelle vers la page parent, pas un état local");
    assert.equal(back!.getAttribute("href"), `/track/${ORDER_ID}`, "chemin PROPRE : ni jeton, ni requête, ni fragment");
    assert.equal(container.innerHTML.includes(TOKEN), false);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-20] vue de suivi par défaut : « Retour » de la sélection referme le panneau derrière SON bouton d'entrée (comportement inchangé -- là, ce bouton n'est pas redondant)", async (t) => {
  installRpc(t);
  setLocation(`/track/${ORDER_ID}`);
  const { container, root } = await renderPage({ search: {} });
  try {
    (q(container, OPEN_BTN) as HTMLElement).click();
    await flush(30);
    const back = backControl(container);
    assert.ok(back);
    assert.equal(back!.tagName, "BUTTON", "état local, pas de navigation");
    back!.click();
    await flush(30);
    assert.ok(q(container, OPEN_BTN) !== null, "retour au bouton d'entrée de la page de suivi");
    assert.ok(q(container, FORM_STEP) === null);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[WD-21] vue autonome : « Retour » de l'étape de vérification revient à la SÉLECTION (jamais hors du formulaire), et aucune entrée d'historique n'est créée par le panneau", async (t) => {
  installRpc(t);
  setLocation(`/track/${ORDER_ID}?view=withdrawal`);
  let pushes = 0;
  const realPush = window.history.pushState.bind(window.history);
  const realReplace = window.history.replaceState.bind(window.history);
  (window.history as any).pushState = (...a: unknown[]) => { pushes++; return (realPush as any)(...a); };
  (window.history as any).replaceState = (...a: unknown[]) => { pushes++; return (realReplace as any)(...a); };
  const { container, root } = await renderPage({ search: { view: "withdrawal" } });
  try {
    pushes = 0; // ne compte que les interactions du panneau (le scrubber de fragment est hors périmètre)
    (q(container, `[data-withdrawal-line="${LINE_A}"] input[type=checkbox]`) as HTMLInputElement).click();
    await flush(30);
    (q(container, '[data-withdrawal-action="continue"]') as HTMLButtonElement).click();
    await flush(30);
    assert.ok(q(container, '[data-withdrawal-step="review"]'));
    const reviewBack = ([...q(container, '[data-withdrawal-step="review"]')!.querySelectorAll("button")] as HTMLElement[]).find((b) => (b.textContent ?? "").trim() === "Retour")!;
    reviewBack.click();
    await flush(30);
    assert.ok(q(container, FORM_STEP), "retour à la sélection");
    assert.ok(q(container, OPEN_BTN) === null);
    assert.equal(pushes, 0, "le panneau ne manipule jamais l'historique du navigateur");
  } finally {
    window.history.pushState = realPush;
    window.history.replaceState = realReplace;
    root.unmount();
    container.remove();
  }
});

test("[WD-22] destination du « Retour » : la page parent repasse par la session serveur -- sans session valide pour CETTE commande, aucune donnée de suivi ni de commande", async (t) => {
  const calls = installRpc(t);
  for (const cookie of [null, createTrackingSessionToken(OTHER_ORDER_ID, CAP_ID, SECRET), "garbage"]) {
    setLocation(`/track/${ORDER_ID}`); // aucun fragment : le lien propre ne porte aucune capacité
    const { container, root } = await renderPage({ search: {}, cookie });
    try {
      await flush(40);
      assert.ok(q(container, "ol") === null, "aucune frise");
      assert.ok(q(container, FORM_STEP) === null && q(container, OPEN_BTN) === null);
      assert.equal((container.textContent ?? "").includes("104"), false, "aucun numéro de commande");
      assert.equal((container.textContent ?? "").includes("Fromage"), false);
    } finally {
      root.unmount();
      container.remove();
    }
  }
  assert.deepEqual(calls, [], "aucune lecture sans session valide");
});

test("[WD-23] bouton Précédent du navigateur après « Retour » : la vue formulaire est RE-DEMANDÉE au serveur -- sans session, non éligible ou erreur, jamais de formulaire ni de commande ; avec session et éligibilité, formulaire frais", async (t) => {
  let plan: RpcPlan = {};
  const calls: string[] = [];
  t.mock.method(supabase, "rpc", async (name: string) => {
    calls.push(name);
    if (name === "get_order_tracking_by_capability") return { data: [VALID_ROW], error: null };
    if (name === "get_withdrawal_options_by_capability") {
      if (plan.options === "error") return { data: null, error: { message: "boom" } };
      return { data: plan.options ?? OPTION_ROWS, error: null };
    }
    if (name === "get_order_tracking_customer_context_by_capability") return { data: [], error: null };
    if (name === "get_order_tracking_status_text_by_capability") return { data: [], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const back = async (opts: { cookie?: string | null; plan?: RpcPlan }) => {
    plan = opts.plan ?? {};
    setLocation(`/track/${ORDER_ID}?view=withdrawal`);
    return renderPage({ search: { view: "withdrawal" }, cookie: opts.cookie });
  };

  // 0. aller : formulaire -> « Retour » (lien parent) ; la page parent est le suivi complet.
  setLocation(`/track/${ORDER_ID}`);
  const parent = await renderPage({ search: {} });
  assert.ok(q(parent.container, "ol"), "la page parent est le suivi complet (session valide)");
  parent.root.unmount(); parent.container.remove();

  // 1. Précédent, session expirée / retirée
  let r = await back({ cookie: null });
  await flush(40);
  assert.ok(q(r.container, FORM_STEP) === null && q(r.container, "[data-withdrawal-line]") === null);
  assert.equal((r.container.textContent ?? "").includes("Fromage"), false);
  r.root.unmount(); r.container.remove();

  // 2. Précédent, session d'une autre commande
  r = await back({ cookie: createTrackingSessionToken(OTHER_ORDER_ID, CAP_ID, SECRET) });
  await flush(40);
  assert.ok(q(r.container, FORM_STEP) === null);
  r.root.unmount(); r.container.remove();

  // 3. Précédent, session valide mais commande devenue non éligible
  r = await back({ plan: { options: [] } });
  assert.ok(q(r.container, FORM_STEP) === null && q(r.container, OPEN_BTN) === null);
  assert.ok(q(r.container, "[data-withdrawal-unavailable=none]"));
  r.root.unmount(); r.container.remove();

  // 4. Précédent, erreur de lecture d'éligibilité : échec fermé
  r = await back({ plan: { options: "error" } });
  assert.ok(q(r.container, FORM_STEP) === null);
  assert.ok(q(r.container, "[data-withdrawal-unavailable=error]"));
  r.root.unmount(); r.container.remove();

  // 5. Précédent, tout valide : formulaire FRAIS (rien d'une saisie précédente)
  r = await back({});
  assert.ok(q(r.container, FORM_STEP));
  assert.equal(q(r.container, '[data-withdrawal-step="review"]'), null);
  r.root.unmount(); r.container.remove();

  // Lectures d'éligibilité : 1 (page parent, étape 0) + 3 (cas 3, 4, 5 : relue à chaque retour).
  // Les cas 1-2 (sans session valide pour cette commande) n'en ont fait AUCUNE.
  assert.equal(calls.filter((c) => c === "get_withdrawal_options_by_capability").length, 4);
});

test("[WD-24] destination du « Retour » : seul un chemin propre /track/<id> est accepté ; tout autre lien (hôte externe, protocole-relatif, javascript:, requête, fragment, jeton) est IGNORÉ -- jamais un lien arbitraire", async () => {
  const mount = async (backHref: string | undefined) => {
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const root = createRoot(container);
    root.render(
      React.createElement(WithdrawalPanel, {
        orderId: ORDER_ID, orderNumber: 104, lang: "fr", startOpen: true, backHref,
        options: [{ orderItemId: LINE_A, itemName: "Fromage frais", optionName: null, orderedQuantity: 2, remainingQuantity: 2 }],
      })
    );
    await flush(30);
    return { container, root };
  };
  const good = await mount(`/track/${ORDER_ID}`);
  assert.equal(backControl(good.container)!.tagName, "A");
  assert.equal(backControl(good.container)!.getAttribute("href"), `/track/${ORDER_ID}`);
  good.root.unmount(); good.container.remove();
  for (const bad of [undefined, "", "https://evil.example/track/x", "//evil.example/x", "javascript:alert(1)", `/track/${ORDER_ID}?view=withdrawal`, `/track/${ORDER_ID}#${TOKEN}`, `/track/${ORDER_ID}/withdrawal`, "/track/", "/dashboard"]) {
    const m = await mount(bad);
    const ctl = backControl(m.container);
    assert.ok(ctl, "un « Retour » existe");
    assert.equal(ctl!.tagName, "BUTTON", `lien non sûr accepté : ${JSON.stringify(bad)}`);
    assert.equal(ctl!.hasAttribute("href"), false);
    m.root.unmount(); m.container.remove();
  }
});

// ------------------------------------------------------------------
// 7. i18n : nouvelles clés présentes et traduites
// ------------------------------------------------------------------

test("[WD-17] clés i18n de la vue formulaire : présentes en FR/EN/AR, non vides, distinctes de la clé, NL retombe sur FR", async () => {
  const { translate } = await import("../lib/i18n.ts");
  for (const key of ["withdrawalDirectNoneTitle", "withdrawalDirectNoneMessage", "withdrawalDirectToTracking"]) {
    const fr = translate("fr", key);
    assert.notEqual(fr, key, `clé FR absente : ${key}`);
    for (const lang of ["en", "ar"] as const) {
      const v = translate(lang, key);
      assert.notEqual(v, key, `${lang}: clé absente : ${key}`);
      assert.notEqual(v, fr, `${lang}: ${key} identique au français (non traduit)`);
    }
    assert.equal(translate("nl", key), fr);
  }
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  for (const k of ["window", "document", "navigator", "HTMLElement", "Event", "requestAnimationFrame", "cancelAnimationFrame", "__mockCookieStore"]) {
    delete (globalThis as any)[k];
  }
});
