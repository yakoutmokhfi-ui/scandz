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
// Scanym — PRINTED MERCHANT RECEIPT / VAT + LEGAL INFO FIX v1 (Claude
// Monet, root cause confirmé par Cat Stevens) — preuve comportementale
// RÉELLE (rendu React dans un vrai DOM, patron esbuild/jsdom déjà
// établi -- voir tests/v133-receipt-invoice-name-history.dom.test.ts,
// tests/lot-merchant-legal-tax-profile-v1-dom.test.ts) des DEUX
// scénarios qui exigent un rendu réel, pas seulement buildReceiptHtml
// en isolation (déjà couvert par
// tests/printed-receipt-vat-legal-fix-v1.test.ts, scénarios A-E) :
//
//   F. le bouton "Imprimer" ne doit PAS pouvoir déclencher l'impression
//      tant que receiptSettings n'a pas fini de charger pour le
//      restaurant courant (components/dashboard/OrderCard.tsx) ;
//   G. changer d'établissement ne doit JAMAIS laisser les réglages
//      ticket (légaux/fiscaux) d'un restaurant précédent rester actifs
//      pour l'impression d'un AUTRE restaurant (app/dashboard/page.tsx)
//      -- pas de fuite tenant.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard",
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

const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const base = path.join(REPO_ROOT, rel);
      const candidate = ["", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

function bundle(entrySource: string, name: string) {
  return esbuild
    .build({
      stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
      bundle: true,
      write: false,
      format: "esm",
      jsx: "automatic",
      target: "es2022",
      plugins: [aliasPlugin],
      external: ["react", "react-dom", "react-dom/client"],
    })
    .then(async (result) => {
      const code = result.outputFiles[0].text;
      const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", `tmp-dom-${name}-`));
      const tmpFile = path.join(tmpDir, `${name}.mjs`);
      writeFileSync(tmpFile, code);
      const mod = await import(pathToFileURL(tmpFile).href);
      rmSync(tmpDir, { recursive: true, force: true });
      return mod;
    });
}

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

// ====================================================================
// F. OrderCard -- le bouton Imprimer ne peut pas déclencher l'impression
//    tant que receiptSettingsReady est false.
// ====================================================================

const { default: OrderCard } = await bundle(
  `export { default } from "@/components/dashboard/OrderCard";`,
  "OrderCard"
);

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    restaurant_id: "r-au-lait-cru",
    order_number: 16,
    status: "new",
    service_mode: "pickup",
    table_number: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    delivery_address: null,
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 20,
    total: 20,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [
      { id: "i1", item_name: "Plat", option_name: null, quantity: 1, unit_price: 20, line_total: 20, tax_rate_snapshot: 20 },
    ],
    tax_settings_snapshot_default_tax_rate: 20,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_delivery_tax_allocations: [],
    ...overrides,
  };
}

function renderOrderCard(props: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderCard, {
      order: baseOrder(),
      restaurantName: "Au lait cru",
      receiptSettings: null,
      onStatus: async () => {},
      busy: false,
      staffLanguage: "fr",
      ...props,
    })
  );
  return { container, root };
}

function printButton(container: Element): HTMLButtonElement {
  const buttons = [...container.querySelectorAll("button")];
  const btn = buttons.find((b) => b.textContent === "Imprimer");
  assert.ok(btn, "le bouton Imprimer doit être présent");
  return btn as HTMLButtonElement;
}

test("F.1 receiptSettingsReady=false -- le bouton Imprimer est désactivé (disabled + aria-disabled), impossible à activer par un clic", async () => {
  const originalOpen = window.open;
  let openCalled = false;
  (window as any).open = (...args: unknown[]) => {
    openCalled = true;
    return originalOpen?.apply(window, args as any);
  };

  const { container, root } = renderOrderCard({ receiptSettingsReady: false, receiptSettings: null });
  await flush();

  const btn = printButton(container);
  assert.equal(btn.disabled, true, "le bouton doit être disabled tant que receiptSettingsReady est false");
  assert.equal(btn.getAttribute("aria-disabled"), "true");
  assert.equal(btn.getAttribute("data-receipt-settings-ready"), "false");

  click(btn);
  await flush();
  assert.equal(openCalled, false, "un clic sur un bouton disabled ne doit jamais ouvrir la fenêtre d'impression (garde défensive dans handlePrint également, voir F.2)");

  root.unmount();
  container.remove();
  window.open = originalOpen;
});

test("F.2 Garde défensive dans handlePrint() lui-même -- même si le gestionnaire était invoqué directement (pas seulement via le bouton), receiptSettingsReady=false empêche printReceipt() de s'exécuter", async () => {
  // Preuve indirecte : le bouton reste le seul point d'entrée exposé au
  // DOM, mais on vérifie ici que RETIRER manuellement `disabled` (comme
  // le ferait un utilisateur via les devtools, ou un futur appelant
  // moins prudent) ne suffit PAS à déclencher l'impression -- la garde
  // à l'intérieur de handlePrint() (if (!receiptSettingsReady) return;)
  // est une seconde ligne de défense indépendante du rendu du bouton.
  const originalOpen = window.open;
  let openCalled = false;
  (window as any).open = (...args: unknown[]) => {
    openCalled = true;
    return originalOpen?.apply(window, args as any);
  };

  const { container, root } = renderOrderCard({ receiptSettingsReady: false, receiptSettings: null });
  await flush();
  const btn = printButton(container);
  btn.disabled = false; // simule un contournement du seul état "disabled" HTML
  click(btn);
  await flush();

  assert.equal(openCalled, false, "handlePrint() doit refuser d'imprimer même si l'attribut disabled est retiré côté DOM -- la garde interne ne dépend pas de cet attribut");

  root.unmount();
  container.remove();
  window.open = originalOpen;
});

test("F.3 receiptSettingsReady=true (valeur par défaut si omis) -- comportement historique intact, le bouton Imprimer est actif et déclenche l'impression", async () => {
  const originalOpen = window.open;
  let openCalled = false;
  (window as any).open = (...args: unknown[]) => {
    openCalled = true;
    return { document: { open() {}, write() {}, close() {} } } as any;
  };

  const { container, root } = renderOrderCard({}); // receiptSettingsReady omis -- doit défaut à true
  await flush();
  const btn = printButton(container);
  assert.equal(btn.disabled, false, "par défaut (prop omise), le bouton doit rester actif -- non-régression pour tout appelant existant");

  click(btn);
  await flush();
  assert.equal(openCalled, true, "un clic sur le bouton actif doit déclencher l'impression");

  root.unmount();
  container.remove();
  window.open = originalOpen;
});

test("F.4 receiptSettingsReady passe de false à true (chargement qui se termine) -- le bouton redevient actif sans qu'aucune autre interaction ne soit nécessaire", async () => {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);

  function renderWith(ready: boolean) {
    root.render(
      React.createElement(OrderCard, {
        order: baseOrder(),
        restaurantName: "Au lait cru",
        receiptSettings: ready ? { business_name: "Au lait cru" } : null,
        receiptSettingsReady: ready,
        onStatus: async () => {},
        busy: false,
        staffLanguage: "fr",
      })
    );
  }

  renderWith(false);
  await flush();
  assert.equal(printButton(container).disabled, true);

  renderWith(true);
  await flush();
  assert.equal(printButton(container).disabled, false, "dès que receiptSettingsReady passe à true, le bouton doit redevenir actif immédiatement");

  root.unmount();
  container.remove();
});

// ====================================================================
// G. app/dashboard/page.tsx -- pas de fuite tenant : changer
//    d'établissement ne doit jamais laisser les réglages ticket d'un
//    restaurant précédent actifs/imprimables pour un AUTRE restaurant.
//
// Harnais : mocks des modules de service (next/navigation,
// @/lib/services/auth, @/lib/services/realtime, @/lib/services/
// dashboard) -- le VRAI composant app/dashboard/page.tsx est rendu et
// exercé tel quel (jamais une réimplémentation) ; seules ses
// dépendances de service sont contrôlées pour rendre le timing du
// race déterministe plutôt que dépendant de la vitesse réelle du
// réseau. Patron déjà établi par tests/lot-merchant-legal-tax-profile-
// v1-dom.test.ts (mocks next/navigation + @/lib/services/auth via un
// plugin esbuild dédié).
// ====================================================================

interface PendingRequest {
  restaurantId: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

(globalThis as any).__gReceiptSettingsResolvers = [] as PendingRequest[];
(globalThis as any).__gOrdersResolvers = [] as PendingRequest[];
(globalThis as any).__gMappings = [] as unknown[];

const MOCK_NAV = `
export function usePathname() { return "/dashboard"; }
const mockRouter = { replace: () => {}, push: () => {} };
export function useRouter() { return mockRouter; }
`;

const MOCK_AUTH = `
export async function getSession() { return { user: { id: "u-test-1" } }; }
export async function signOut() {}
`;

const MOCK_REALTIME = `
export function subscribeToOrders() { return () => {}; }
`;

// RECEIPT v1.1 -- `getDashboardOrders` est désormais DIFFÉRÉ au même
// titre que `getReceiptSettings` : chaque appel enregistre un resolver
// que le test déclenche EXPLICITEMENT. C'est ce qui permet de contrôler
// l'ORDRE DE RÉSOLUTION des deux flux (commandes vs réglages) de façon
// DÉTERMINISTE -- jamais par un délai arbitraire ni une hypothèse de
// timing (mandat v1.1 §4 : "Do not use timing assumptions. Do not use
// arbitrary delays.").
const MOCK_DASHBOARD_SERVICE = `
export async function getMerchantRestaurants() {
  return (globalThis).__gMappings;
}
export async function getDashboardOrders(restaurantId, _showHistory) {
  return new Promise((resolve, reject) => {
    (globalThis).__gOrdersResolvers.push({ restaurantId, resolve, reject });
  });
}
export async function getReceiptSettings(restaurantId) {
  return new Promise((resolve, reject) => {
    (globalThis).__gReceiptSettingsResolvers.push({ restaurantId, resolve, reject });
  });
}
export async function getRestaurantSettings(_restaurantId) {
  return { staff_receipt_language: "fr" };
}
export async function updateOrderStatus() {}
`;

const gMocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/realtime": MOCK_REALTIME,
  "@/lib/services/dashboard": MOCK_DASHBOARD_SERVICE,
};

const gMockPlugin: esbuild.Plugin = {
  name: "scanym-dashboard-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (gMocks[args.path]) {
        return { path: args.path, namespace: "gmock" };
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
    build.onLoad({ filter: /.*/, namespace: "gmock" }, (args) => ({
      contents: gMocks[args.path],
      loader: "ts",
    }));
  },
};

const gEntrySource = `
export { default as DashboardPage } from "@/app/dashboard/page";
`;

const gBuildResult = await esbuild.build({
  stdin: { contents: gEntrySource, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [gMockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const gCode = gBuildResult.outputFiles[0].text;
const gTmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-dashboard-"));
const gTmpFile = path.join(gTmpDir, "DashboardPage.mjs");
writeFileSync(gTmpFile, gCode);
const { DashboardPage } = await import(pathToFileURL(gTmpFile).href);
rmSync(gTmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------
// Contrôle DÉTERMINISTE de l'ordre de résolution (mandat v1.1 §5).
//
// `take*For()` RETIRE de la file les requêtes en attente pour un
// restaurant et les rend au test, qui décide QUAND (et dans quel
// ordre) les résoudre -- y compris APRÈS qu'un autre restaurant a été
// sélectionné, ce qui est exactement la condition de course auditée.
// Retirer plutôt que consulter garantit qu'une requête capturée ne
// peut pas être résolue deux fois par une étape ultérieure.
//
// Note : la page émet DEUX requêtes de commandes par sélection de
// restaurant (l'effet de changement de restaurant et l'effet
// showHistory se déclenchent tous deux sur `restaurantId`) -- ces
// aides travaillent donc sur des LOTS, jamais sur un compte exact
// codé en dur, pour ne pas devenir fragiles si ce détail évolue.
// ---------------------------------------------------------------
/**
 * Attend que la page ait RÉELLEMENT émis sa requête pour ce restaurant.
 *
 * C'est une attente SUR CONDITION (la requête est-elle enregistrée ?),
 * jamais un délai arbitraire censé « suffire » : le test ne reprend
 * qu'une fois le fait observable établi. L'ordre de RÉSOLUTION, lui,
 * reste entièrement piloté par le test (mandat v1.1 §4).
 */
async function waitForPending(
  queue: "__gOrdersResolvers" | "__gReceiptSettingsResolvers",
  restaurantId: string,
  label: string
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const all = (globalThis as any)[queue] as PendingRequest[];
    if (all.some((p) => p.restaurantId === restaurantId)) return;
    await flush(5);
  }
  assert.fail(`aucune requête ${label} en attente pour "${restaurantId}" apres attente`);
}

async function takeOrdersFor(restaurantId: string): Promise<PendingRequest[]> {
  await waitForPending("__gOrdersResolvers", restaurantId, "getDashboardOrders");
  const all = (globalThis as any).__gOrdersResolvers as PendingRequest[];
  const taken = all.filter((p) => p.restaurantId === restaurantId);
  (globalThis as any).__gOrdersResolvers = all.filter((p) => p.restaurantId !== restaurantId);
  return taken;
}

async function takeSettingsFor(restaurantId: string): Promise<PendingRequest[]> {
  await waitForPending("__gReceiptSettingsResolvers", restaurantId, "getReceiptSettings");
  const all = (globalThis as any).__gReceiptSettingsResolvers as PendingRequest[];
  const taken = all.filter((p) => p.restaurantId === restaurantId);
  (globalThis as any).__gReceiptSettingsResolvers = all.filter((p) => p.restaurantId !== restaurantId);
  return taken;
}

/** Variante NON bloquante : prend ce qui est la, sans rien attendre. */
function takeSettingsIfAny(restaurantId: string): PendingRequest[] {
  const all = (globalThis as any).__gReceiptSettingsResolvers as PendingRequest[];
  const taken = all.filter((p) => p.restaurantId === restaurantId);
  (globalThis as any).__gReceiptSettingsResolvers = all.filter((p) => p.restaurantId !== restaurantId);
  return taken;
}

function resolveAll(batch: PendingRequest[], value: unknown, label: string) {
  assert.ok(batch.length > 0, `au moins une requête en attente attendue pour ${label}`);
  for (const entry of batch) entry.resolve(value);
}

/** Attend puis résout les requêtes de réglages en attente d'un restaurant. */
async function resolveReceiptSettings(restaurantId: string, value: unknown) {
  resolveAll(await takeSettingsFor(restaurantId), value, `getReceiptSettings("${restaurantId}")`);
}

/** Attend puis résout les requêtes de commandes en attente d'un restaurant. */
async function resolveOrders(restaurantId: string, value: unknown) {
  resolveAll(await takeOrdersFor(restaurantId), value, `getDashboardOrders("${restaurantId}")`);
}

function receiptSettingsFor(restaurantId: string, legalName: string) {
  return {
    restaurant_id: restaurantId,
    business_name: `Restaurant ${restaurantId}`,
    legal_name: legalName,
    legal_address: null,
    phone: null,
    email: null,
    tax_identifier: null,
    registration_number: null,
    paper_width_mm: 58,
    show_tax_summary: true,
    prices_include_tax: true,
    tax_label: "TVA",
    default_tax_rate: 20,
    footer_text: null,
    restaurant_country: "FR",
  };
}

function orderFor(restaurantId: string, itemName: string, id: string) {
  return {
    id,
    restaurant_id: restaurantId,
    order_number: 1,
    status: "new",
    service_mode: "pickup",
    table_number: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    delivery_address: null,
    delivery_zone: null,
    customer_note: null,
    customer_language: "fr",
    subtotal: 10,
    total: 10,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [
      { id: `i-${id}`, item_name: itemName, option_name: null, quantity: 1, unit_price: 10, line_total: 10, tax_rate_snapshot: 20 },
    ],
    tax_settings_snapshot_default_tax_rate: 20,
    tax_settings_snapshot_prices_include_tax: true,
    tax_settings_snapshot_tax_label: "TVA",
    tax_settings_snapshot_show_tax_summary: true,
    order_delivery_tax_allocations: [],
  };
}

/** Deux établissements, sélecteur visible (mappings.length > 1). */
function twoRestaurantMappings() {
  return [
    { restaurant_id: "rA", role: "owner", restaurants: { id: "rA", name: "Restaurant A", slug: "resto-a" } },
    { restaurant_id: "rB", role: "owner", restaurants: { id: "rB", name: "Restaurant B", slug: "resto-b" } },
  ];
}

function resetHarness() {
  (globalThis as any).__gOrdersResolvers = [];
  (globalThis as any).__gReceiptSettingsResolvers = [];
  (globalThis as any).__gMappings = twoRestaurantMappings();
}

function mountDashboard() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(DashboardPage));
  return { container, root };
}

/** Carte de commande contenant ce libellé de produit, ou null. */
function orderCardFor(container: Element, itemName: string): Element | null {
  return [...container.querySelectorAll("article")].find((a) => a.textContent?.includes(itemName)) ?? null;
}

/** Bouton Imprimer de cette carte. Échoue si la carte est absente. */
function printButtonOf(container: Element, itemName: string): HTMLButtonElement {
  const card = orderCardFor(container, itemName);
  assert.ok(card, `la carte de commande "${itemName}" doit être affichée`);
  const btn = [...card!.querySelectorAll("button")].find((b) => b.textContent === "Imprimer");
  assert.ok(btn, `le bouton Imprimer de "${itemName}" doit être présent`);
  return btn as HTMLButtonElement;
}

/** true si une commande est affichée ET réellement imprimable. */
function isPrintable(container: Element, itemName: string): boolean {
  const card = orderCardFor(container, itemName);
  if (!card) return false;
  const btn = [...card.querySelectorAll("button")].find((b) => b.textContent === "Imprimer");
  if (!btn) return false;
  return !(btn as HTMLButtonElement).disabled;
}

/** Bascule d'établissement via le vrai <select> de DashboardNav. */
function selectRestaurant(container: Element, restaurantId: string) {
  const select = container.querySelector("select") as HTMLSelectElement;
  assert.ok(select, "le sélecteur d'établissement doit être visible (2 mappings)");
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  nativeSetter.call(select, restaurantId);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

test("G. Changer d'établissement -- les réglages ticket du restaurant PRÉCÉDENT ne restent jamais actifs/imprimables pour les commandes de l'AUTRE restaurant (pas de fuite tenant)", async () => {
  resetHarness();
  const { container, root } = mountDashboard();
  try {
    await flush(30);

    // Restaurant A sélectionné par défaut (premier mapping) : ses
    // commandes ET ses réglages sont résolus -- état pleinement cohérent.
    await resolveOrders("rA", [orderFor("rA", "Plat A", "oA1")]);
    await resolveReceiptSettings("rA", receiptSettingsFor("rA", "A SARL"));
    await flush(30);
    assert.equal(printButtonOf(container, "Plat A").disabled, false, "restaurant A pleinement chargé -- impression autorisée");

    // Bascule vers B, puis résolution des commandes de B SEULEMENT --
    // les réglages de B restent en attente.
    selectRestaurant(container, "rB");
    await flush(30);
    await resolveOrders("rB", [orderFor("rB", "Plat B", "oB1")]);
    await flush(30);

    assert.equal(
      printButtonOf(container, "Plat B").disabled,
      true,
      "restaurant B : réglages PAS ENCORE chargés -- impression bloquée, jamais un repli sur les réglages du restaurant A"
    );

    await resolveReceiptSettings("rB", receiptSettingsFor("rB", "B SARL"));
    await flush(30);

    assert.equal(
      printButtonOf(container, "Plat B").disabled,
      false,
      "restaurant B : commandes ET réglages chargés pour B -- impression autorisée avec SES PROPRES réglages"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// RECEIPT-V1-ORDER-SETTINGS-RACE-01 — tests adverses (mandat v1.1 §5).
//
// Le blocage audité : en v1, `receiptSettingsSeqRef` protégeait les
// réponses de RÉGLAGES périmées, mais `loadOrders()` n'avait AUCUNE
// protection équivalente -- ni garde de génération, ni vérification du
// restaurant -- et `orders` n'était pas vidé lors d'une bascule. Deux
// conséquences réelles :
//   (a) les réglages de B pouvaient devenir "prêts" pendant que les
//       commandes de A étaient ENCORE affichées -> une commande de A
//       devenait imprimable avec les mentions légales de B ;
//   (b) une réponse de commandes de A résolue APRÈS la sélection de B
//       écrasait l'état avec les commandes de A.
//
// Tous les scénarios ci-dessous contrôlent l'ordre de résolution de
// façon DÉTERMINISTE via des promesses différées -- aucun délai
// arbitraire, aucune hypothèse de timing. Chaque scénario démonte son
// rendu dans un `finally` : un échec d'assertion ne doit jamais laisser
// une page montée capter les requêtes du scénario suivant.
// ====================================================================

test("SCÉNARIO 1 (RACE-01) : A chargé -> bascule B -> les réglages de B résolvent AVANT les commandes de B -- aucune commande de A ne peut être imprimée avec les réglages de B", async () => {
  resetHarness();
  const { container, root } = mountDashboard();
  try {
    await flush(30);

    await resolveOrders("rA", [orderFor("rA", "Plat A", "oA1")]);
    await resolveReceiptSettings("rA", receiptSettingsFor("rA", "A SARL"));
    await flush(30);
    assert.equal(printButtonOf(container, "Plat A").disabled, false, "prérequis : A pleinement chargé et imprimable");

    // Bascule vers B. Les réglages de B résolvent, les commandes de B
    // restent EN ATTENTE -- c'est exactement la fenêtre auditée.
    selectRestaurant(container, "rB");
    await flush(30);
    await resolveReceiptSettings("rB", receiptSettingsFor("rB", "B SARL"));
    await flush(30);

    assert.equal(
      isPrintable(container, "Plat A"),
      false,
      "BLOCAGE RACE-01 : une commande du restaurant A ne doit JAMAIS être imprimable une fois B sélectionné -- surtout pas avec les réglages légaux de B"
    );

    // Et rien d'autre n'est imprimable non plus tant que les commandes
    // de B ne sont pas arrivées : aucune carte imprimable dans la page.
    const printableButtons = [...container.querySelectorAll("article button")].filter(
      (b) => b.textContent === "Imprimer" && !(b as HTMLButtonElement).disabled
    );
    assert.equal(printableButtons.length, 0, "aucune commande imprimable tant que commandes ET réglages de B ne sont pas tous deux chargés");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("SCÉNARIO 2 (RACE-01) : requête commandes de A EN VOL -> bascule B -> B résout -> la VIEILLE réponse de A résout ensuite -- la réponse périmée est ignorée, l'état de B reste intact", async () => {
  resetHarness();
  const { container, root } = mountDashboard();
  try {
    await flush(30);

    // Les requêtes de commandes de A sont capturées SANS être résolues :
    // elles resteront "en vol" pendant la bascule.
    const staleAOrders = await takeOrdersFor("rA");
    assert.ok(staleAOrders.length > 0, "prérequis : au moins une requête de commandes A en vol");
    await resolveReceiptSettings("rA", receiptSettingsFor("rA", "A SARL"));
    await flush(30);

    selectRestaurant(container, "rB");
    await flush(30);
    await resolveOrders("rB", [orderFor("rB", "Plat B", "oB1")]);
    await resolveReceiptSettings("rB", receiptSettingsFor("rB", "B SARL"));
    await flush(30);
    assert.equal(printButtonOf(container, "Plat B").disabled, false, "prérequis : B pleinement chargé");

    // La réponse PÉRIMÉE de A arrive maintenant, bien après la bascule.
    resolveAll(staleAOrders, [orderFor("rA", "Plat A", "oA1")], "requêtes A périmées");
    await flush(30);

    assert.ok(orderCardFor(container, "Plat A") === null, "BLOCAGE RACE-01 : une réponse de commandes PÉRIMÉE (restaurant A) ne doit jamais être appliquée après la sélection de B");
    assert.ok(orderCardFor(container, "Plat B"), "les commandes de B doivent rester affichées, intactes");
    assert.equal(printButtonOf(container, "Plat B").disabled, false, "l'état de B reste pleinement cohérent et imprimable");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("SCÉNARIO 3 (RACE-01) : A -> B -> A avec résolutions DÉLIBÉRÉMENT hors ordre -- seule la DERNIÈRE génération de A devient active ; ni l'ancienne A ni B ne contaminent l'état courant", async () => {
  resetHarness();
  const { container, root } = mountDashboard();
  try {
    await flush(30);

    // Génération 1 (A) : capturée, jamais résolue pour l'instant.
    const genOneAOrders = await takeOrdersFor("rA");
    const genOneASettings = await takeSettingsFor("rA");
    assert.ok(genOneAOrders.length > 0 && genOneASettings.length > 0, "prérequis : requêtes de génération 1 (A) en vol");

    // Bascule vers B : requêtes de B capturées, jamais résolues.
    selectRestaurant(container, "rB");
    await flush(30);
    const bOrders = await takeOrdersFor("rB");
    const bSettings = await takeSettingsFor("rB");
    assert.ok(bOrders.length > 0 && bSettings.length > 0, "prérequis : requêtes de B en vol");

    // Retour vers A : c'est la génération 3, la SEULE légitime.
    selectRestaurant(container, "rA");
    await flush(30);

    // Résolutions hors ordre : d'abord la génération 1 (A, périmée),
    // puis B (périmée), et enfin seulement la génération courante.
    resolveAll(genOneAOrders, [orderFor("rA", "Plat A GEN1", "oA-gen1")], "génération 1 A (périmée)");
    resolveAll(genOneASettings, receiptSettingsFor("rA", "A SARL GEN1"), "génération 1 A réglages (périmée)");
    await flush(30);
    resolveAll(bOrders, [orderFor("rB", "Plat B", "oB1")], "B (périmée)");
    resolveAll(bSettings, receiptSettingsFor("rB", "B SARL"), "B réglages (périmée)");
    await flush(30);

    assert.ok(orderCardFor(container, "Plat A GEN1") === null, "la génération 1 de A (périmée) ne doit jamais devenir active");
    assert.ok(orderCardFor(container, "Plat B") === null, "la réponse de B (périmée après le retour vers A) ne doit jamais contaminer l'état de A");
    const printableMid = [...container.querySelectorAll("article button")].filter(
      (b) => b.textContent === "Imprimer" && !(b as HTMLButtonElement).disabled
    );
    assert.equal(printableMid.length, 0, "rien d'imprimable tant que la génération COURANTE de A n'a pas résolu");

    // Enfin, la génération courante de A résout : elle seule s'applique.
    await resolveOrders("rA", [orderFor("rA", "Plat A GEN3", "oA-gen3")]);
    await resolveReceiptSettings("rA", receiptSettingsFor("rA", "A SARL GEN3"));
    await flush(30);

    assert.ok(orderCardFor(container, "Plat A GEN3"), "seule la DERNIÈRE génération de A doit devenir active");
    assert.ok(orderCardFor(container, "Plat A GEN1") === null, "la génération 1 ne réapparaît jamais");
    assert.ok(orderCardFor(container, "Plat B") === null, "aucune contamination par B");
    assert.equal(printButtonOf(container, "Plat A GEN3").disabled, false, "la génération courante de A est cohérente et imprimable");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("SCÉNARIO 4 (RACE-01) : order.restaurant_id != restaurantId sélectionné -- impression bloquée INDÉPENDAMMENT de l'état de l'UI (garde portée par OrderCard lui-même)", async () => {
  const originalOpen = window.open;
  let openCalled = false;
  (window as any).open = () => {
    openCalled = true;
    return { document: { open() {}, write() {}, close() {} } } as any;
  };

  // Tout est "prêt" du point de vue des réglages, et la carte est
  // rendue -- seule l'appartenance de la commande diverge.
  const { container, root } = renderOrderCard({
    order: baseOrder({ restaurant_id: "rA" }),
    receiptSettings: { business_name: "Restaurant B" },
    receiptSettingsReady: true,
    printRestaurantId: "rB",
  });
  try {
    await flush();

    const btn = printButton(container);
    assert.equal(btn.disabled, true, "commande d'un AUTRE restaurant que celui sélectionné -- bouton désactivé");

    // Garde défensive : même en retirant `disabled` côté DOM,
    // handlePrint() doit refuser (mandat v1.1 §3.E).
    btn.disabled = false;
    click(btn);
    await flush();
    assert.equal(openCalled, false, "handlePrint() doit refuser d'imprimer une commande n'appartenant pas au restaurant sélectionné, même si l'attribut disabled est retiré");
  } finally {
    root.unmount();
    container.remove();
    window.open = originalOpen;
  }
});

test("SCÉNARIO 4b (RACE-01) : même commande, mais appartenant BIEN au restaurant sélectionné -- impression autorisée (la garde ne bloque pas le cas légitime)", async () => {
  const originalOpen = window.open;
  let openCalled = false;
  (window as any).open = () => {
    openCalled = true;
    return { document: { open() {}, write() {}, close() {} } } as any;
  };

  const { container, root } = renderOrderCard({
    order: baseOrder({ restaurant_id: "rB" }),
    receiptSettings: { business_name: "Restaurant B" },
    receiptSettingsReady: true,
    printRestaurantId: "rB",
  });
  try {
    await flush();
    const btn = printButton(container);
    assert.equal(btn.disabled, false, "commande appartenant au restaurant sélectionné -- impression autorisée");
    click(btn);
    await flush();
    assert.equal(openCalled, true, "le cas légitime doit continuer d'imprimer normalement");
  } finally {
    root.unmount();
    container.remove();
    window.open = originalOpen;
  }
});

test("SCÉNARIO 5 (RACE-01) : commandes à jour mais RÉGLAGES périmés/d'un autre restaurant -- impression bloquée", async () => {
  resetHarness();
  const { container, root } = mountDashboard();
  try {
    await flush(30);

    await resolveOrders("rA", [orderFor("rA", "Plat A", "oA1")]);
    await resolveReceiptSettings("rA", receiptSettingsFor("rA", "A SARL"));
    await flush(30);

    // Bascule vers B : les COMMANDES de B arrivent (dataset à jour),
    // mais ses réglages restent en attente -- les seuls réglages jamais
    // chargés dans cette session sont ceux de A (périmés ici).
    selectRestaurant(container, "rB");
    await flush(30);
    await resolveOrders("rB", [orderFor("rB", "Plat B", "oB1")]);
    await flush(30);

    assert.equal(
      printButtonOf(container, "Plat B").disabled,
      true,
      "dataset de commandes à jour mais réglages non chargés pour CE restaurant -- impression bloquée"
    );

    // Preuve complémentaire : résoudre les réglages du MAUVAIS
    // restaurant (A, périmés) ne doit rien débloquer.
    const leftoverA = takeSettingsIfAny("rA");
    if (leftoverA.length > 0) {
      resolveAll(leftoverA, receiptSettingsFor("rA", "A SARL"), "réglages A résiduels");
      await flush(30);
      assert.equal(
        printButtonOf(container, "Plat B").disabled,
        true,
        "résoudre les réglages d'un AUTRE restaurant ne doit jamais rendre la commande courante imprimable"
      );
    }
  } finally {
    root.unmount();
    container.remove();
  }
});

test("SCÉNARIO 6 (RACE-01) : réglages à jour mais DATASET DE COMMANDES périmé/d'un autre restaurant -- impression bloquée", async () => {
  resetHarness();
  const { container, root } = mountDashboard();
  try {
    await flush(30);

    await resolveOrders("rA", [orderFor("rA", "Plat A", "oA1")]);
    await resolveReceiptSettings("rA", receiptSettingsFor("rA", "A SARL"));
    await flush(30);
    assert.equal(printButtonOf(container, "Plat A").disabled, false, "prérequis : A cohérent et imprimable");

    // Bascule vers B : SEULS les réglages de B arrivent. Le dataset de
    // commandes courant est donc, au mieux, celui de A -- périmé.
    selectRestaurant(container, "rB");
    await flush(30);
    await resolveReceiptSettings("rB", receiptSettingsFor("rB", "B SARL"));
    await flush(30);

    const printable = [...container.querySelectorAll("article button")].filter(
      (b) => b.textContent === "Imprimer" && !(b as HTMLButtonElement).disabled
    );
    assert.equal(
      printable.length,
      0,
      "réglages à jour pour B mais dataset de commandes non chargé pour B -- aucune commande imprimable"
    );
    assert.equal(isPrintable(container, "Plat A"), false, "la commande de A, en particulier, ne doit pas être imprimable");
  } finally {
    root.unmount();
    container.remove();
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
