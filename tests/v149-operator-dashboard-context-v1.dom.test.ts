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
// OPERATOR DASHBOARD CONTEXT v1 — CROSS-MERCHANT NAVIGATION SAFETY
// (bug/release blocker fix).
//
// Rendu RÉEL en DOM (jsdom) de trois pages Dashboard réelles --
// app/dashboard/catalogue/page.tsx (rôle PRIMAIRE de reproduction),
// app/dashboard/payment/page.tsx, app/dashboard/delivery-pricing/page.tsx
// -- jamais une réimplémentation. Seuls next/navigation,
// @/lib/services/auth, @/lib/services/establishments et
// @/lib/services/dashboard sont remplacés par des modules virtuels
// (esbuild onResolve/onLoad, namespace "mock") ; la logique de
// résolution du restaurant affiché (l'objet du correctif) n'est
// JAMAIS mockée : c'est précisément ce que ce fichier prouve.
//
// Preuve visée (mandat "OPERATOR DASHBOARD CONTEXT v1") :
//   - Au lait cru -> Au lait cru, Royal Hotel -> Royal Hotel,
//     Sanaa -> Sanaa (jamais de repli croisé) ;
//   - jamais de repli silencieux vers le propre rattachement
//     restaurant_users de l'opérateur (Sanaa) quand `?r=` cible un
//     AUTRE établissement ;
//   - fail-closed : une cible non autorisable (RPC métier qui refuse)
//     ne renvoie JAMAIS les données d'un autre restaurant, seulement
//     une erreur sûre générique ;
//   - comportement marchand ORDINAIRE strictement inchangé (aucune
//     notion d'opérateur, `?r=` ignoré si absent/non pertinent) ;
//   - `?r=` seul n'est JAMAIS traité comme une autorisation (aucune
//     ligne restaurant_users fictive n'est jamais créée ici -- ce
//     fichier ne touche à aucune base, il vérifie seulement que le
//     composant ne simule aucune adhésion) ;
//   - aucun flash transitoire du mauvais restaurant pendant le
//     chargement ;
//   - Delivery pricing / Payment restent en LECTURE fail-closed
//     (aucun bypass SQL opérateur aujourd'hui, voir
//     OPERATOR-CONTEXT-CONTRACT.md) : le restaurant ciblé est
//     correctement retenu pour l'affichage, mais l'appel RPC métier
//     échoue proprement (message générique), jamais une fuite.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/catalogue?r=r-au-lait-cru",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).File = window.File;
(globalThis as any).URL.createObjectURL = () => "blob:mock-preview-url";
(globalThis as any).URL.revokeObjectURL = () => {};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

// --------------------------------------------------------------
// Trois établissements fixtures, correspondant EXACTEMENT à la
// reproduction du mandat : Au lait cru (r-au-lait-cru), Royal Hotel
// (r-royal-hotel), et Sanaa Cookies & Fondant (r-sanaa) -- le
// rattachement restaurant_users PROPRE (fictif) de l'opérateur de
// test, celui vers lequel le bug faisait retomber TOUT lien Cockpit
// avant correctif.
// --------------------------------------------------------------
const ESTABLISHMENTS: Record<string, { name: string; slug: string }> = {
  "r-au-lait-cru": { name: "Au lait cru", slug: "au-lait-cru" },
  "r-royal-hotel": { name: "Royal Hotel", slug: "royal-hotel" },
  "r-sanaa": { name: "Sanaa Cookies & Fondant", slug: "sanaa-cookies-fondant" },
};

(globalThis as any).__mockUser = { id: "operator-1" };
(globalThis as any).__mockIsOperator = true;
(globalThis as any).__mockGetSummaryThrows = false;
(globalThis as any).__mockGetSummary = async (id: string) => {
  if ((globalThis as any).__mockGetSummaryThrows) throw new Error("not found");
  const e = ESTABLISHMENTS[id];
  if (!e) throw new Error("not found");
  return { restaurantId: id, name: e.name, slug: e.slug, status: "active", ownerEmail: null, ownerStatus: null };
};
// L'opérateur de test a UNE SEULE adhésion restaurant_users réelle :
// Sanaa. C'est précisément le restaurant vers lequel le bug faisait
// retomber tout lien Cockpit ciblant un AUTRE établissement.
(globalThis as any).__mockMappings = [
  { restaurant_id: "r-sanaa", role: "owner", restaurants: { id: "r-sanaa", name: "Sanaa Cookies & Fondant", slug: "sanaa-cookies-fondant" } },
];
(globalThis as any).__mockReplaceCalls = [] as string[];

// RPC métier "réelles" -- reflètent le contrat confirmé lors de la
// découverte : le catalogue accepte déjà is_scanym_operator() (aucun
// SQL requis), payment/delivery-pricing en LECTURE et
// delivery-pricing en ÉCRITURE ne l'acceptent PAS encore (gap SQL
// confirmé, signalé -- jamais corrigé ici).
(globalThis as any).__mockCatalogueDeniesFor = new Set<string>();
(globalThis as any).__mockPaymentDeniesForNonMember = true;
(globalThis as any).__mockDeliveryDeniesForNonMember = true;
(globalThis as any).__mockRpcCallLog = [] as { fn: string; restaurantId: string }[];

const CATALOGUE_BY_RESTAURANT: Record<string, any[]> = {
  "r-au-lait-cru": [{ category_id: "c-alc", category_name: "Fromages", category_translations: null, category_display_order: 0, category_is_option_source: false, category_description: null, products: [], subcategories: [] }],
  "r-royal-hotel": [{ category_id: "c-rh", category_name: "Suites", category_translations: null, category_display_order: 0, category_is_option_source: false, category_description: null, products: [], subcategories: [] }],
  "r-sanaa": [{ category_id: "c-sanaa", category_name: "Cookies", category_translations: null, category_display_order: 0, category_is_option_source: false, category_description: null, products: [], subcategories: [] }],
};

// ---- Contenu des modules mockés (JS pur, namespace "mock") ----

const MOCK_NAV = `
const _router = {
  replace: (href) => { (globalThis).__mockReplaceCalls.push(href); },
  push: () => {},
};
export function useRouter() { return _router; }
export function usePathname() { return (globalThis).__mockPathname || "/dashboard/catalogue"; }
`;

const MOCK_AUTH = `
export async function getUser() { return (globalThis).__mockUser; }
export async function signOut() {}
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__mockIsOperator; }
export async function getEstablishmentSummary(id) { return (globalThis).__mockGetSummary(id); }
`;

// Un seul module combiné couvre les trois pages (catalogue/payment/
// delivery-pricing) : chaque page n'importe qu'un sous-ensemble, les
// exports superflus pour une page donnée sont inoffensifs.
const MOCK_DASHBOARD = `
class CategoryDuplicateNameError extends Error {}
class CategoryDescriptionTooLongError extends Error {}
class DescriptionTooLongError extends Error {}
class ShortDescriptionTooLongError extends Error {}
class SubcategoryDuplicateNameError extends Error {}
class SubcategoryCategoryMismatchError extends Error {}
export { CategoryDuplicateNameError, CategoryDescriptionTooLongError, DescriptionTooLongError, ShortDescriptionTooLongError, SubcategoryDuplicateNameError, SubcategoryCategoryMismatchError };

export async function getMerchantRestaurants() {
  return (globalThis).__mockMappings;
}

export async function getRestaurantSettings() {
  return { currency: "DZD", staff_receipt_language: "fr" };
}

export async function getMerchantCatalogue(id) {
  (globalThis).__mockRpcCallLog.push({ fn: "get_merchant_catalogue", restaurantId: id });
  if ((globalThis).__mockCatalogueDeniesFor.has(id)) {
    throw new Error("Not authorized for this restaurant");
  }
  const CATALOGUE = ${JSON.stringify(CATALOGUE_BY_RESTAURANT)};
  return CATALOGUE[id] ?? [];
}

export async function createProduct() { return "new-product-id"; }
export async function updateProduct() {}
export async function createCategory() { return "new-category-id"; }
export async function updateCategory() {}
export async function createSubcategory() { return "new-subcategory-id"; }
export async function updateSubcategory() {}
export async function setProductAvailability() {}
export async function setProductOrder() {}
export async function archiveProduct() {}
export async function restoreProduct() {}

// Un opérateur qui n'est membre d'AUCUN restaurant_users du restaurant
// ciblé reçoit un refus explicite (fail closed) -- exactement l'état
// SQL confirmé lors de la découverte (is_member_of() uniquement,
// aucun bypass is_scanym_operator()).
export async function getMerchantPaymentProviderConfig(id) {
  (globalThis).__mockRpcCallLog.push({ fn: "get_merchant_payment_provider_config", restaurantId: id });
  const isOwnMembership = (globalThis).__mockMappings.some((m) => m.restaurant_id === id);
  if (!isOwnMembership && (globalThis).__mockPaymentDeniesForNonMember) {
    throw new Error("Not authorized for this restaurant");
  }
  return [{ providerCode: "monetico", mode: "live", configurationStatus: "configured", isEnabled: true, lastVerifiedAt: null, updatedAt: null }];
}

export async function getMerchantDeliveryFulfillmentPricing(id) {
  (globalThis).__mockRpcCallLog.push({ fn: "get_merchant_delivery_fulfillment_pricing", restaurantId: id });
  const isOwnMembership = (globalThis).__mockMappings.some((m) => m.restaurant_id === id);
  if (!isOwnMembership && (globalThis).__mockDeliveryDeniesForNonMember) {
    throw new Error("Not authorized for this restaurant");
  }
  return [{ ruleId: "rule-1", fulfillmentLabel: "Livraison standard", pricingMode: "fixed", fixedFee: 300, freeThreshold: null, customerText: null }];
}

export async function updateMerchantDeliveryFulfillmentPricing() {
  throw new Error("Not authorized for this restaurant");
}
`;

const MOCK_PRODUCT_PHOTO = `
export class InvalidFileTypeError extends Error {}
export class FileTooLargeError extends Error {}
export class PhotoUploadError extends Error {}
export class PhotoRemoveError extends Error {}
export async function validateProductPhotoFile() { return { mime: "image/jpeg", ext: "jpg" }; }
export async function addOrReplaceProductPhoto() { return "https://example.supabase.co/x.jpg"; }
export async function removeProductPhoto() {}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/product-photo": MOCK_PRODUCT_PHOTO,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path in mocks) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
  },
};

async function buildPage(entryRelPath: string, exportName: string) {
  const entrySource = `export { default as ${exportName} } from "@/${entryRelPath}";`;
  const buildResult = await esbuild.build({
    stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    plugins: [mockPlugin],
    external: ["react", "react-dom", "react-dom/client"],
  });
  const code = buildResult.outputFiles[0].text;
  const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
  const tmpFile = path.join(tmpDir, `${exportName}.mjs`);
  writeFileSync(tmpFile, code);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpDir, { recursive: true, force: true });
  return mod[exportName];
}

const CataloguePage = await buildPage("app/dashboard/catalogue/page.tsx", "CataloguePage");
const PaymentPage = await buildPage("app/dashboard/payment/page.tsx", "PaymentPage");
const DeliveryPricingPage = await buildPage("app/dashboard/delivery-pricing/page.tsx", "DeliveryPricingPage");

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition jamais satisfaite avant le délai");
    await flush(intervalMs);
  }
}

function render(Component: any) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Component));
  return { container, root };
}

function resetGlobalMockState() {
  (globalThis as any).__mockIsOperator = true;
  (globalThis as any).__mockGetSummaryThrows = false;
  (globalThis as any).__mockMappings = [
    { restaurant_id: "r-sanaa", role: "owner", restaurants: { id: "r-sanaa", name: "Sanaa Cookies & Fondant", slug: "sanaa-cookies-fondant" } },
  ];
  (globalThis as any).__mockReplaceCalls = [];
  (globalThis as any).__mockCatalogueDeniesFor = new Set<string>();
  (globalThis as any).__mockPaymentDeniesForNonMember = true;
  (globalThis as any).__mockDeliveryDeniesForNonMember = true;
  (globalThis as any).__mockRpcCallLog = [];
}

// ====================================================================
// CATALOGUE (reproduction primaire) — Au lait cru / Royal Hotel / Sanaa
// ====================================================================

test("Scénario 1 — Catalogue : lien Cockpit vers Au lait cru affiche Au lait cru (jamais Sanaa)", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-au-lait-cru");
  const { container, root } = render(CataloguePage);
  await waitFor(() => container.textContent!.includes("Au lait cru"));
  assert.ok(container.textContent!.includes("Au lait cru"));
  assert.ok(!container.textContent!.includes("Sanaa Cookies"));
  root.unmount();
  container.remove();
});

test("Scénario 2 — Catalogue : lien Cockpit vers Royal Hotel affiche Royal Hotel (jamais Sanaa)", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const { container, root } = render(CataloguePage);
  await waitFor(() => container.textContent!.includes("Royal Hotel"));
  assert.ok(container.textContent!.includes("Royal Hotel"));
  assert.ok(!container.textContent!.includes("Sanaa Cookies"));
  root.unmount();
  container.remove();
});

test("Scénario 3 — Catalogue : Sanaa reste correct quand c'est RÉELLEMENT le restaurant sélectionné (adhésion propre, pas de ?r= distinct)", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue");
  const { container, root } = render(CataloguePage);
  await waitFor(() => container.textContent!.includes("Sanaa Cookies"));
  assert.ok(container.textContent!.includes("Sanaa Cookies"));
  root.unmount();
  container.remove();
});

test("Scénario 4 — Catalogue : changer de cible (Au lait cru -> Royal Hotel) ne retient AUCUNE donnée de l'ancien restaurant", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-au-lait-cru");
  const first = render(CataloguePage);
  await waitFor(() => first.container.textContent!.includes("Au lait cru"));
  first.root.unmount();
  first.container.remove();

  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const second = render(CataloguePage);
  await waitFor(() => second.container.textContent!.includes("Royal Hotel"));
  assert.ok(!second.container.textContent!.includes("Au lait cru"));
  assert.ok(!second.container.textContent!.includes("Sanaa Cookies"));
  second.root.unmount();
  second.container.remove();
});

test("Scénario 5 — Catalogue : aucun repli silencieux vers l'adhésion propre (Sanaa) quand ?r= cible un autre établissement, MÊME AVANT résolution complète (pas de flash Sanaa)", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const { container, root } = render(CataloguePage);
  // Vérifie immédiatement après le montage (avant que le flush actif
  // ne laisse le temps à l'effet de résoudre) : le nom de Sanaa ne doit
  // JAMAIS apparaître, pas même de façon transitoire pendant les
  // premiers ticks de la résolution asynchrone.
  for (let i = 0; i < 5; i++) {
    assert.ok(!container.textContent!.includes("Sanaa Cookies"), "aucun flash transitoire de Sanaa ne doit apparaître");
    await flush(5);
  }
  await waitFor(() => container.textContent!.includes("Royal Hotel"));
  assert.ok(!container.textContent!.includes("Sanaa Cookies"));
  root.unmount();
  container.remove();
});

test("Scénario 6 — Catalogue : la RPC métier reçoit exactement l'ID de restaurant ciblé (aucune ligne restaurant_users fictive n'est jamais créée ou lue pour l'établissement ciblé)", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const { container, root } = render(CataloguePage);
  await waitFor(() => container.textContent!.includes("Royal Hotel"));
  const calls = (globalThis as any).__mockRpcCallLog as { fn: string; restaurantId: string }[];
  assert.ok(calls.some((c) => c.fn === "get_merchant_catalogue" && c.restaurantId === "r-royal-hotel"));
  // `mappings` (restaurant_users) n'a jamais été altéré pour inclure
  // r-royal-hotel : seule la RPC ciblée fait foi, jamais un
  // rattachement fabriqué côté client.
  assert.deepEqual(
    (globalThis as any).__mockMappings.map((m: any) => m.restaurant_id),
    ["r-sanaa"]
  );
  root.unmount();
  container.remove();
});

test("Scénario 7 — Catalogue : cible non autorisable (RPC refuse) échoue de façon SÛRE -- jamais le rendu d'un autre restaurant", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockCatalogueDeniesFor = new Set(["r-royal-hotel"]);
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const { container, root } = render(CataloguePage);
  await flush(200);
  assert.ok(!container.textContent!.includes("Sanaa Cookies"), "un refus RPC ne doit jamais faire retomber sur Sanaa");
  assert.ok(!container.textContent!.includes("Au lait cru"));
  root.unmount();
  container.remove();
});

test("Scénario 8 — Catalogue : refresh (remontage identique) préserve le contexte -- même ?r=, même établissement résolu", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-au-lait-cru");
  const first = render(CataloguePage);
  await waitFor(() => first.container.textContent!.includes("Au lait cru"));
  first.root.unmount();
  first.container.remove();

  // "Refresh" simulé : remontage frais avec exactement la même URL.
  const second = render(CataloguePage);
  await waitFor(() => second.container.textContent!.includes("Au lait cru"));
  assert.ok(!second.container.textContent!.includes("Sanaa Cookies"));
  second.root.unmount();
  second.container.remove();
});

test("Scénario 9 — Catalogue : navigation (back/forward simulé) entre deux ?r= distincts reste isolée par montage", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const a = render(CataloguePage);
  await waitFor(() => a.container.textContent!.includes("Royal Hotel"));

  window.history.pushState({}, "", "/dashboard/catalogue?r=r-au-lait-cru");
  const b = render(CataloguePage);
  await waitFor(() => b.container.textContent!.includes("Au lait cru"));

  // "Back" : nouveau montage revenant à Royal Hotel.
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const c = render(CataloguePage);
  await waitFor(() => c.container.textContent!.includes("Royal Hotel"));
  assert.ok(!c.container.textContent!.includes("Au lait cru"));
  assert.ok(!c.container.textContent!.includes("Sanaa Cookies"));

  a.root.unmount(); a.container.remove();
  b.root.unmount(); b.container.remove();
  c.root.unmount(); c.container.remove();
});

test("Scénario 10 — Catalogue : un utilisateur authentifié NON opérateur ne peut PAS utiliser ?r= pour accéder à un autre établissement (repli sur sa propre adhésion, comportement inchangé)", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockIsOperator = false;
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const { container, root } = render(CataloguePage);
  await waitFor(() => container.textContent!.includes("Sanaa Cookies"));
  assert.ok(!container.textContent!.includes("Royal Hotel"), "?r= seul ne doit jamais suffire à autoriser un non-opérateur");
  root.unmount();
  container.remove();
});

test("Scénario 11 — Catalogue : comportement marchand ORDINAIRE totalement inchangé (aucun ?r=, sélecteur normal)", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockIsOperator = false;
  (globalThis as any).__mockMappings = [
    { restaurant_id: "r-ordinary", role: "owner", restaurants: { id: "r-ordinary", name: "Restaurant Ordinaire", slug: "ordinaire" } },
  ];
  window.history.pushState({}, "", "/dashboard/catalogue");
  const { container, root } = render(CataloguePage);
  await waitFor(() => container.textContent!.includes("Ma carte") || container.querySelectorAll("button").length > 0);
  await flush(100);
  assert.ok(!container.textContent!.includes("Sanaa"));
  assert.ok(!container.textContent!.includes("Royal Hotel"));
  assert.ok(!container.textContent!.includes("Au lait cru"));
  root.unmount();
  container.remove();
});

test("Scénario 12 — Catalogue : le nom d'affichage résiste à un échec du résumé (getEstablishmentSummary) -- best effort, l'ID reste la source de vérité pour le chargement", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockGetSummaryThrows = true;
  window.history.pushState({}, "", "/dashboard/catalogue?r=r-royal-hotel");
  const { container, root } = render(CataloguePage);
  await flush(200);
  const calls = (globalThis as any).__mockRpcCallLog as { fn: string; restaurantId: string }[];
  assert.ok(calls.some((c) => c.fn === "get_merchant_catalogue" && c.restaurantId === "r-royal-hotel"), "le catalogue du bon restaurant doit être chargé même si le résumé (nom affiché) échoue");
  assert.ok(!container.textContent!.includes("Sanaa Cookies"));
  root.unmount();
  container.remove();
});

// ====================================================================
// PAYMENT — module READ-ONLY, fail-closed (aucun bypass SQL opérateur)
// ====================================================================

test("Scénario 13 — Payment : cible Royal Hotel correctement retenue pour l'affichage, mais la RPC échoue de façon SÛRE (fail-closed, gap SQL confirmé) -- jamais les données de Sanaa", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/payment?r=r-royal-hotel");
  const { container, root } = render(PaymentPage);
  await waitFor(() => container.textContent!.includes("Impossible de charger les informations de paiement."));
  assert.ok(!container.textContent!.includes("Sanaa"));
  assert.ok(!/monetico|configured|live/i.test(container.textContent ?? ""), "aucune donnée de paiement ne doit jamais être affichée pour une cible non autorisée");
  root.unmount();
  container.remove();
});

test("Scénario 14 — Payment : marchand ordinaire (non-opérateur) garde son comportement normal (lecture de son propre restaurant)", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockIsOperator = false;
  (globalThis as any).__mockPaymentDeniesForNonMember = false;
  window.history.pushState({}, "", "/dashboard/payment");
  const { container, root } = render(PaymentPage);
  await waitFor(() => /monetico|Paiement/i.test(container.textContent ?? ""));
  assert.ok(container.textContent!.includes("Sanaa Cookies"));
  root.unmount();
  container.remove();
});

// ====================================================================
// DELIVERY PRICING — édition reste role-based-only (gap SQL confirmé
// en LECTURE et en ÉCRITURE)
// ====================================================================

test("Scénario 15 — Delivery pricing : cible Royal Hotel correctement retenue pour l'affichage, LECTURE fail-closed (jamais les tarifs de Sanaa)", async () => {
  resetGlobalMockState();
  window.history.pushState({}, "", "/dashboard/delivery-pricing?r=r-royal-hotel");
  const { container, root } = render(DeliveryPricingPage);
  await waitFor(() => container.textContent!.includes("Chargement des tarifs de livraison impossible"));
  assert.ok(!container.textContent!.includes("Livraison standard"));
  root.unmount();
  container.remove();
});

test("Scénario 16 — Delivery pricing : un opérateur consultant un établissement hors adhésion ne voit JAMAIS de bouton d'édition actif (canEdit reste role-based-only, aucun bypass SQL n'existe encore)", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockDeliveryDeniesForNonMember = false; // la lecture réussit ici pour isoler l'assertion canEdit
  window.history.pushState({}, "", "/dashboard/delivery-pricing?r=r-royal-hotel");
  const { container, root } = render(DeliveryPricingPage);
  await waitFor(() => container.textContent!.includes("Livraison standard"));
  const inputs = [...container.querySelectorAll("input")] as HTMLInputElement[];
  assert.ok(inputs.length > 0, "les règles doivent être rendues");
  for (const input of inputs) {
    assert.equal(input.disabled, true, "un opérateur sans adhésion réelle ne doit jamais pouvoir éditer tant que le SQL requis n'est pas ajouté");
  }
  root.unmount();
  container.remove();
});

test("Scénario 17 — Delivery pricing : marchand ordinaire (owner de son propre restaurant) garde l'édition normale inchangée", async () => {
  resetGlobalMockState();
  (globalThis as any).__mockIsOperator = false;
  (globalThis as any).__mockDeliveryDeniesForNonMember = false;
  window.history.pushState({}, "", "/dashboard/delivery-pricing");
  const { container, root } = render(DeliveryPricingPage);
  await waitFor(() => container.textContent!.includes("Livraison standard"));
  const inputs = [...container.querySelectorAll("input")] as HTMLInputElement[];
  assert.ok(inputs.some((i) => i.disabled === false), "un owner de son propre restaurant doit garder l'édition normale");
  root.unmount();
  container.remove();
});

// ====================================================================
// Preuve structurelle complémentaire — le Cockpit Opérateur construit
// toujours ?r=<id> pour les 4 liens marchands (référence non modifiée
// par ce lot, re-vérifiée ici pour non-régression).
// ====================================================================

test("Scénario 18 — Preuve structurelle : le Cockpit Opérateur (non modifié par ce lot) construit bien ?r=<id> pour catalogue/payment/delivery-pricing/settings", () => {
  const src = readFileSync(path.join(REPO_ROOT, "app/admin/establishments/cockpit/page.tsx"), "utf8");
  for (const route of ["catalogue", "payment", "delivery-pricing", "settings"]) {
    const re = new RegExp(`/dashboard/${route}\\?r=\\$\\{`);
    assert.ok(re.test(src), `le Cockpit doit construire un lien ?r=<id> vers /dashboard/${route}`);
  }
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).File;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mockUser;
  delete (globalThis as any).__mockIsOperator;
  delete (globalThis as any).__mockGetSummaryThrows;
  delete (globalThis as any).__mockGetSummary;
  delete (globalThis as any).__mockMappings;
  delete (globalThis as any).__mockReplaceCalls;
  delete (globalThis as any).__mockCatalogueDeniesFor;
  delete (globalThis as any).__mockPaymentDeniesForNonMember;
  delete (globalThis as any).__mockDeliveryDeniesForNonMember;
  delete (globalThis as any).__mockRpcCallLog;
});
