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
// Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1.1
// MCC-V1-WITHDRAWAL-ELIGIBILITY-RACE-01 (audit indépendant
// OpenAI/Codex, blocker 1) — PREUVE COMPORTEMENTALE de la course.
//
// Le défaut, tel que l'audit l'a décrit : une réponse LENTE de
// /api/checkout/withdrawal-eligibility appartenant à la commande A
// pouvait muter l'état de confirmation d'une commande B plus récente,
// et faire apparaître un appel à l'action de rétractation sur une
// commande NON rétractable.
//
// Ce fichier monte MenuView EN ENTIER (même harnais que
// tests/v122i-tracking-menuview-wiring.dom.test.ts : `supabase.rpc`
// intercepté à la frontière réseau la plus basse, interactions
// utilisateur réelles jusqu'au clic d'envoi) et pilote l'ORDRE
// D'ARRIVÉE des réponses d'éligibilité au moyen de promesses
// différées — c'est le TEST, non le hasard de l'ordonnancement, qui
// décide quelle réponse arrive quand.
//
// Scénarios EXIGÉS par le mandat de remédiation :
//   [RACE-1] A éligible (réponse retardée) -> fermer A -> créer B non
//            éligible -> réponse B (false) -> réponse A TARDIVE (true)
//            => B NE DOIT PAS afficher le CTA ;
//   [RACE-2] ordre INVERSE : la réponse A tardive (true) arrive AVANT
//            la réponse B (false) => B NE DOIT PAS afficher le CTA ;
//   [RACE-3] le CTA appartient TOUJOURS à la commande / au
//            trackingPath dont l'éligibilité a été vérifiée ;
//   [RACE-4] fermer l'écran invalide les résultats en vol et remet
//            l'état d'éligibilité à zéro.
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
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
      const resolvedPath = candidate ?? base;
      // `@/lib/supabase` reste EXTERNE : le test doit intercepter la
      // MÊME instance de client que le bundle utilise.
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
    });
  },
};

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as MenuView } from "@/components/MenuView";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-mcc-race-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor(check: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(10);
  }
}
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}
function buttonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}
function inputById(container: Element, id: string): HTMLInputElement | null {
  return container.querySelector(`#${id}`);
}

/** Promesse DIFFÉRÉE : c'est le test qui décide quand — et dans quel
 *  ordre — chaque réponse d'éligibilité arrive. Sans cela, le scénario
 *  dépendrait de l'ordonnancement, et un test vert ne prouverait rien. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Le CTA de rétractation, et lui seul (l'écran ne porte plus de
 *  bouton « Suivre ma commande » — MCC-V1-CONTRACT-CHANGE-01). */
function withdrawalCta(container: Element): HTMLAnchorElement | null {
  return container.querySelector<HTMLAnchorElement>("[data-order-confirmation-withdrawal]");
}

/** Absence assertée SANS sérialiser le nœud trouvé : un nœud JSDOM est
 *  un graphe cyclique volumineux, et `assert.equal(el, null)` épuise la
 *  mémoire du processus quand il ÉCHOUE — l'échec deviendrait
 *  indiscernable d'un plantage d'infrastructure. */
function assertNoWithdrawalCta(container: Element, why: string) {
  const found = withdrawalCta(container);
  assert.equal(found === null, true, `${why} — un CTA de rétractation est rendu (href=${found?.getAttribute("href")})`);
}

// --- Fixture : même établissement que v101/v122i ---------------------
function sanaaCookiesRestaurant() {
  return {
    id: "r-sanaa-test",
    name: "Sanaa Cookies (test)",
    slug: "sanaa-cookies",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r-sanaa-test",
      max_tables: 10,
      currency: "EUR",
      whatsapp_number: "+33600000000",
      address: null,
      latitude: null,
      longitude: null,
      logo_url: null,
      cover_url: null,
      opening_hours: null,
      source_language: "fr",
    },
    categories: [
      {
        id: "cat-1",
        restaurant_id: "r-sanaa-test",
        name: "Cookies",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: "item-1",
            category_id: "cat-1",
            name: "Cookie chocolat",
            description: null,
            short_description: null,
            price: 3.5,
            image_url: null,
            display_order: 1,
            is_available: true,
          },
        ],
      },
    ],
    hiddenCategories: [],
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}

const SALE_MODE_CATALOG_ROWS = [
  { code: "table", label: "Sur place", category: "dine_in" },
  { code: "pickup", label: "Retrait", category: "pickup" },
  { code: "delivery", label: "Livraison", category: "delivery" },
];
const PICKUP_SALE_MODE_ROWS = [
  { mode_code: "pickup", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
  { mode_code: "delivery", customer_text: null, pricing_mode: "free" as const, fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null },
];
const PICKUP_REQS = [
  { field: "customer_name", requirement: "required", one_of_group: null },
  { field: "phone", requirement: "required", one_of_group: null },
];

// Deux commandes DISTINCTES : A puis B. Les identités doivent être
// séparées sur les DEUX composantes (order_id ET public_token), sinon
// une concordance accidentelle masquerait le défaut.
const ORDER_A = { orderId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", token: "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa", number: 101 };
const ORDER_B = { orderId: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", token: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", number: 102 };
const trackingPathOf = (o: typeof ORDER_A) => `/track/${o.orderId}#${o.token}`;

interface Backend {
  readonly createOrderCalls: number[];
  readonly eligibilityCalls: Array<{ orderId: string; publicToken: string }>;
}

/**
 * Intercepte `supabase.rpc` (create_order renvoie A puis B, dans
 * l'ordre des appels) et `globalThis.fetch` (la route d'éligibilité
 * renvoie une promesse DIFFÉRÉE par commande, fournie par le test).
 */
function installBackend(
  t: { mock: { method: Function } },
  deferredByOrderId: Map<string, Deferred<boolean>>
): Backend {
  const backend: Backend = { createOrderCalls: [], eligibilityCalls: [] };
  const orders = [ORDER_A, ORDER_B];

  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: SALE_MODE_CATALOG_ROWS, error: null }) };
    }
    throw new Error(`table inattendue dans ce test : ${table}`);
  });

  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "get_restaurant_public_sale_modes") return { data: PICKUP_SALE_MODE_ROWS, error: null };
    if (name === "get_restaurant_public_field_requirements") {
      return { data: args.p_mode_code === "pickup" ? PICKUP_REQS : [], error: null };
    }
    if (name === "get_restaurant_public_delivery_info") return { data: [], error: null };
    if (name === "get_restaurant_public_delivery_fulfillments") return { data: [], error: null };
    if (name === "get_restaurant_public_communication_texts") return { data: [], error: null };
    if (name === "get_restaurant_public_cgv") return { data: [], error: null };
    if (name === "mark_whatsapp_opened") return { data: null, error: null };
    if (name === "create_order") {
      const o = orders[backend.createOrderCalls.length] ?? ORDER_B;
      backend.createOrderCalls.push(o.number);
      return {
        data: [
          {
            order_id: o.orderId,
            order_number: o.number,
            public_token: o.token,
            subtotal: 3.5,
            delivery_fee: 0,
            total: 3.5,
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });

  (globalThis as any).fetch = async (input: unknown, init: any) => {
    const url = String(input);
    if (url.includes("/api/checkout/withdrawal-eligibility")) {
      const body = JSON.parse(init.body);
      backend.eligibilityCalls.push({ orderId: body.orderId, publicToken: body.publicToken });
      const deferred = deferredByOrderId.get(body.orderId);
      if (!deferred) throw new Error(`aucune promesse différée pour la commande ${body.orderId}`);
      const eligible = await deferred.promise;
      return new Response(JSON.stringify({ eligible }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`requête sortante inattendue : ${url}`);
  };

  return backend;
}

/** Monte MenuView, remplit un parcours pickup et rend le bouton d'envoi. */
async function renderAndReachSubmit() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant: sanaaCookiesRestaurant() }));
  await flush();
  return { container, root };
}

async function fillPickupAndSubmit(container: Element) {
  const addBtn = buttonWithText(container, "Ajouter");
  assert.ok(addBtn, "le bouton Ajouter doit être présent");
  click(addBtn!);
  await flush();

  const cartBar = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("🛒"));
  if (cartBar) {
    click(cartBar);
    await flush();
  }

  const modeBtn = buttonWithText(container, "À emporter");
  assert.ok(modeBtn, 'le bouton de mode "À emporter" doit être présent');
  click(modeBtn!);
  await waitFor(() => inputById(container, "customer_name") !== null, "champs pickup rendus");

  setNativeValue(inputById(container, "customer_name")!, "Victor");
  setNativeValue(inputById(container, "phone")!, "0612345678");
  await flush(50);

  const submitBtn = buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
  assert.ok(submitBtn, "le bouton d'envoi doit être atteignable en mode pickup");
  click(submitBtn!);
  await waitFor(
    () => container.textContent?.includes("Commande envoyée avec succès") ?? false,
    "écran de confirmation"
  );
}

/** « Passer une autre commande » / « Retour au menu » : les deux
 *  appellent `closeConfirmation`. */
async function closeConfirmation(container: Element) {
  const back = container.querySelector<HTMLButtonElement>("[data-order-confirmation-back-to-menu]");
  assert.ok(back, "le bouton de retour au menu doit être présent");
  click(back!);
  await waitFor(
    () => !(container.textContent?.includes("Commande envoyée avec succès") ?? false),
    "fermeture de l'écran de confirmation"
  );
}

// ====================================================================
// [RACE-1] Ordre EXIGÉ par le mandat : réponse B d'abord, réponse A
//          tardive ensuite.
// ====================================================================

test("[RACE-1] A éligible (réponse retardée) -> fermer A -> B NON éligible -> réponse B -> réponse A TARDIVE : B n'affiche JAMAIS le CTA", async (t) => {
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (window as any).open = () => ({});
  const dA = makeDeferred<boolean>();
  const dB = makeDeferred<boolean>();
  const backend = installBackend(t, new Map([[ORDER_A.orderId, dA], [ORDER_B.orderId, dB]]));

  const { container, root } = await renderAndReachSubmit();
  try {
    // --- Commande A : confirmée, réponse d'éligibilité RETENUE.
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 1, "éligibilité demandée pour A");
    assert.equal(backend.eligibilityCalls[0]!.orderId, ORDER_A.orderId);
    assertNoWithdrawalCta(container, "A : aucune preuve encore arrivée");

    // --- Fermeture de A, pendant que sa réponse est TOUJOURS en vol.
    await closeConfirmation(container);

    // --- Commande B : confirmée, puis sa réponse (false) arrive.
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 2, "éligibilité demandée pour B");
    assert.equal(backend.eligibilityCalls[1]!.orderId, ORDER_B.orderId);
    dB.resolve(false);
    await flush(30);
    assertNoWithdrawalCta(container, "B n'est pas rétractable");

    // --- LA RÉPONSE TARDIVE DE A ARRIVE MAINTENANT, et elle dit `true`.
    dA.resolve(true);
    await flush(60);

    assertNoWithdrawalCta(
      container,
      "MCC-V1-WITHDRAWAL-ELIGIBILITY-RACE-01 : une réponse tardive de A ne doit JAMAIS ouvrir le CTA sur B"
    );
    // L'écran affiche bien B, pas A -- sinon l'assertion ci-dessus
    // serait vraie pour une mauvaise raison.
    assert.equal(container.textContent?.includes("Commande n°102"), true, "l'écran affiche bien la commande B");
    assert.deepEqual(backend.createOrderCalls, [101, 102]);
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

// ====================================================================
// [RACE-2] Ordre INVERSE, exigé explicitement par le mandat.
// ====================================================================

test("[RACE-2] ordre INVERSE : la réponse A tardive (true) arrive AVANT la réponse B (false) -- B n'affiche toujours pas le CTA", async (t) => {
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (window as any).open = () => ({});
  const dA = makeDeferred<boolean>();
  const dB = makeDeferred<boolean>();
  const backend = installBackend(t, new Map([[ORDER_A.orderId, dA], [ORDER_B.orderId, dB]]));

  const { container, root } = await renderAndReachSubmit();
  try {
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 1, "éligibilité demandée pour A");
    await closeConfirmation(container);

    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 2, "éligibilité demandée pour B");

    // A d'abord (tardive, `true`), B ensuite (`false`).
    dA.resolve(true);
    await flush(40);
    assertNoWithdrawalCta(container, "la réponse tardive de A ne doit pas ouvrir le CTA sur B");

    dB.resolve(false);
    await flush(40);
    assertNoWithdrawalCta(container, "B n'est pas rétractable, quel que soit l'ordre d'arrivée");
    assert.equal(container.textContent?.includes("Commande n°102"), true, "l'écran affiche bien la commande B");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

// ====================================================================
// [RACE-3] Le CTA appartient TOUJOURS à la commande dont l'éligibilité
//          a été vérifiée — contrôle d'APPARTENANCE, pas seulement
//          d'absence (un test qui ne prouve que des absences passerait
//          sur un composant qui n'affiche jamais rien).
// ====================================================================

test("[RACE-3] quand le CTA s'affiche, son href est EXACTEMENT le trackingPath de la commande dont l'éligibilité a été vérifiée", async (t) => {
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (window as any).open = () => ({});
  const dA = makeDeferred<boolean>();
  const dB = makeDeferred<boolean>();
  const backend = installBackend(t, new Map([[ORDER_A.orderId, dA], [ORDER_B.orderId, dB]]));

  const { container, root } = await renderAndReachSubmit();
  try {
    // A est RÉELLEMENT rétractable : le CTA doit apparaître, et pointer A.
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 1, "éligibilité demandée pour A");
    dA.resolve(true);
    await waitFor(() => withdrawalCta(container) !== null, "CTA de rétractation affiché pour A");

    const ctaA = withdrawalCta(container)!;
    assert.equal(ctaA.getAttribute("href"), trackingPathOf(ORDER_A), "le href est le trackingPath de A");
    // La preuve a bien été demandée POUR CE COUPLE, pas pour un autre.
    assert.deepEqual(backend.eligibilityCalls[0], {
      orderId: ORDER_A.orderId,
      publicToken: ORDER_A.token,
    });
    // Le jeton ne voyage que dans le fragment (contrat §6/§7 préservé).
    const urlA = new URL(ctaA.getAttribute("href")!, "http://localhost");
    assert.equal(urlA.pathname, `/track/${ORDER_A.orderId}`);
    assert.equal(urlA.search, "");
    assert.equal(urlA.hash, `#${ORDER_A.token}`);

    // --- B rétractable AUSSI : le CTA doit basculer sur B, jamais
    //     rester sur A. C'est le pendant positif de RACE-1 : on prouve
    //     que la liaison SUIT la commande affichée.
    await closeConfirmation(container);
    assertNoWithdrawalCta(container, "la fermeture doit effacer le CTA");

    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 2, "éligibilité demandée pour B");
    dB.resolve(true);
    await waitFor(() => withdrawalCta(container) !== null, "CTA de rétractation affiché pour B");

    const ctaB = withdrawalCta(container)!;
    assert.equal(ctaB.getAttribute("href"), trackingPathOf(ORDER_B), "le href est désormais le trackingPath de B");
    assert.equal(
      ctaB.getAttribute("href")!.includes(ORDER_A.orderId),
      false,
      "aucun résidu de la commande A dans le href de B"
    );
    assert.equal(
      ctaB.getAttribute("href")!.includes(ORDER_A.token),
      false,
      "aucun résidu du jeton de A dans le href de B"
    );
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

// ====================================================================
// [RACE-4] `closeConfirmation()` invalide les résultats EN VOL et
//          remet l'état d'éligibilité à zéro.
// ====================================================================

test("[RACE-4] fermer l'écran invalide une réponse en vol : réaffichée, la MÊME commande ne réutilise pas l'ancienne preuve", async (t) => {
  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (window as any).open = () => ({});
  const dA = makeDeferred<boolean>();
  const dB = makeDeferred<boolean>();
  const backend = installBackend(t, new Map([[ORDER_A.orderId, dA], [ORDER_B.orderId, dB]]));

  const { container, root } = await renderAndReachSubmit();
  try {
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 1, "éligibilité demandée pour A");

    // Fermeture AVANT que la réponse n'arrive.
    await closeConfirmation(container);

    // La réponse de A arrive alors qu'AUCUN écran n'est affiché : elle
    // ne doit rien écrire. Si elle écrivait, la preuve resterait en
    // mémoire et le CTA apparaîtrait à la réouverture.
    dA.resolve(true);
    await flush(50);
    assertNoWithdrawalCta(container, "aucun écran affiché : rien ne doit être rendu");

    // Nouvelle commande (B), NON rétractable : l'ancienne preuve de A
    // ne doit pas lui être attribuée.
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 2, "éligibilité demandée pour B");
    dB.resolve(false);
    await flush(40);
    assertNoWithdrawalCta(container, "la preuve invalidée de A ne doit jamais servir à B");
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
  }
});

// ====================================================================
// [RACE-5] CONTRÔLE NÉGATIF — la garde est bien celle qui protège.
//
// Sans ce contrôle, les quatre tests ci-dessus passeraient aussi sur un
// composant qui n'afficherait JAMAIS de CTA. On recompile donc MenuView
// avec la garde de péremption RETIRÉE, et on vérifie que le scénario
// RACE-1 ÉCHOUE alors — c'est-à-dire que le défaut que l'audit a décrit
// est bien reproductible, et que c'est bien ce correctif qui le ferme.
// ====================================================================

test("[RACE-5] contrôle négatif : garde de péremption retirée => la réponse tardive de A ouvre le CTA sur B (le défaut est reproduit)", async (t) => {
  const { readFileSync } = await import("node:fs");
  const original = readFileSync(path.join(REPO_ROOT, "components/MenuView.tsx"), "utf8");
  const GUARD = "if (confirmationGenerationRef.current !== confirmationGeneration) return;";
  assert.ok(
    original.includes(GUARD),
    "la garde de péremption doit exister dans MenuView.tsx (sinon ce contrôle négatif ne prouve rien)"
  );
  // On retire AUSSI les comparaisons d'identité au rendu : le contrôle
  // négatif doit reconstituer le comportement v1 (un booléen sans
  // identité), pas un demi-correctif.
  const sabotaged = original
    .replace(GUARD, "/* garde retirée par le contrôle négatif */")
    .replace(
      "withdrawalEligibilityProof.orderId === confirmedOrderId &&",
      ""
    )
    .replace(
      "withdrawalEligibilityProof.trackingPath === confirmedTrackingPath &&",
      ""
    )
    .replace(
      "withdrawalEligibilityProof.generation === confirmationGenerationRef.current &&",
      ""
    );
  assert.notEqual(sabotaged, original, "le sabotage doit modifier la source");

  const sabotageDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-mcc-race-neg-"));
  const sabotagedComponent = path.join(sabotageDir, "MenuViewSabotaged.tsx");
  writeFileSync(sabotagedComponent, sabotaged);

  const negPlugin: esbuild.Plugin = {
    name: "at-alias-neg",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const rel = args.path.slice(2);
        // La seule substitution : le composant saboté remplace l'original.
        if (rel === "components/MenuView") return { path: sabotagedComponent };
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        const resolvedPath = candidate ?? base;
        if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
          return { path: pathToFileURL(resolvedPath).href, external: true };
        }
        return { path: resolvedPath };
      });
    },
  };
  const negBuild = await esbuild.build({
    stdin: {
      contents: `export { default as MenuView } from "@/components/MenuView";`,
      resolveDir: REPO_ROOT,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    plugins: [negPlugin],
    external: ["react", "react-dom", "react-dom/client"],
  });
  const negFile = path.join(sabotageDir, "MenuViewSabotaged.mjs");
  writeFileSync(negFile, negBuild.outputFiles[0].text);
  const { MenuView: SabotagedMenuView } = await import(pathToFileURL(negFile).href);
  rmSync(sabotageDir, { recursive: true, force: true });

  const realFetch = globalThis.fetch;
  const realOpen = window.open;
  (window as any).open = () => ({});
  const dA = makeDeferred<boolean>();
  const dB = makeDeferred<boolean>();
  const backend = installBackend(t, new Map([[ORDER_A.orderId, dA], [ORDER_B.orderId, dB]]));

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(SabotagedMenuView, { restaurant: sanaaCookiesRestaurant() }));
  await flush();

  try {
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 1, "éligibilité demandée pour A");
    await closeConfirmation(container);
    await fillPickupAndSubmit(container);
    await waitFor(() => backend.eligibilityCalls.length === 2, "éligibilité demandée pour B");
    dB.resolve(false);
    await flush(30);
    dA.resolve(true);
    await flush(60);

    // SUR LE COMPOSANT SABOTÉ, le CTA DOIT apparaître : c'est la preuve
    // que le scénario est réellement discriminant et que la garde du
    // composant réel est ce qui le ferme.
    assert.notEqual(
      withdrawalCta(container),
      null,
      "sans garde, la réponse tardive de A DOIT ouvrir le CTA sur B -- sinon le scénario RACE-1 ne prouve rien"
    );
  } finally {
    root.unmount();
    container.remove();
    (window as any).open = realOpen;
    (globalThis as any).fetch = realFetch;
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
