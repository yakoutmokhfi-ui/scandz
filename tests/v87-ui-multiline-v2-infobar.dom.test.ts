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
// UI MULTILINE FIX v2 -- preuve comportementale RÉELLE que
// RestaurantInfoBar (le SEUL composant réellement rendu sur la page
// publique -- RestaurantInfoCard n'est importé nulle part dans
// l'arbre de rendu réel, confirmé par recherche exhaustive) préserve
// les retours à la ligne réellement saisis dans config.opening_hours,
// désormais possibles depuis le passage à un <textarea> côté
// Dashboard.
//
// Cause racine réelle (confirmée en Production, contre-audit Work) :
// la donnée réelle d'Au Lait Cru ne contenait AUCUN \n -- une seule
// longue ligne à espaces multiples, saisie via un <input> simple
// ligne qui empêchait structurellement toute saisie multiligne. Ce
// test prouve le NOUVEAU chemin de bout en bout, pas l'ancien
// symptôme (qui n'était pas un bug de rendu CSS, mais une incapacité
// de SAISIE).
//
// Même technique déjà établie dans le projet (esbuild.build() +
// plugin d'alias "@/" + jsdom).
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

const entrySource = `
export { default as RestaurantInfoBar } from "@/components/RestaurantInfoBar";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "RestaurantInfoBar.mjs");
writeFileSync(tmpFile, code);
const { RestaurantInfoBar } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseRestaurant(openingHours: string | null) {
  return {
    id: "r1",
    name: "Au Lait Cru",
    slug: "au-lait-cru-inexistant",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r1",
      max_tables: 10,
      currency: "EUR",
      whatsapp_number: "+33600000000",
      address: null,
      latitude: null,
      longitude: null,
      logo_url: null,
      cover_url: null,
      opening_hours: openingHours,
      maps_url: null,
    },
    categories: [],
    hiddenCategories: [],
  };
}

function render(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(RestaurantInfoBar, { restaurant }));
  return { container, root };
}

test("UI MULTILINE FIX v2: RestaurantInfoBar (composant RÉELLEMENT rendu en Production) préserve les retours à la ligne d'une valeur opening_hours multiligne", async () => {
  const multilineHours =
    "Lundi 16:00 – 20:00\nMar – Ven 10:00 – 14:00\n16:00 – 20:00\nSamedi 10:00 – 19:30\nDimanche\nFermé";
  const { container, root } = render(baseRestaurant(multilineHours));
  await flush();

  const hoursCell = container.querySelector("span.whitespace-pre-wrap");
  assert.ok(hoursCell, "la cellule des horaires doit être présente dans le DOM, avec whitespace-pre-wrap");

  assert.equal(hoursCell!.textContent, multilineHours, "le texte réellement rendu doit être IDENTIQUE, caractère pour caractère, à la donnée d'origine -- \\n compris");
  assert.ok(hoursCell!.className.includes("whitespace-pre-wrap"), "la cellule des horaires doit porter whitespace-pre-wrap");
  assert.ok(!hoursCell!.className.includes("truncate"), "la cellule des horaires ne doit plus être tronquée (incompatible avec un contenu multiligne légitime)");
  root.unmount();
});

test("UI MULTILINE FIX v2: RestaurantInfoBar -- adresse/téléphone restent compacts (truncate), non affectés par ce correctif", async () => {
  const restaurant = baseRestaurant("07:00 – 23:00");
  (restaurant.config as any).address = "10 rue de Paris, 75001 Paris, une adresse volontairement très longue pour tester la troncature";
  const { container, root } = render(restaurant);
  await flush();

  const addressCell = Array.from(container.querySelectorAll("span.truncate")).find((s) =>
    s.textContent?.includes("rue de Paris")
  );
  assert.ok(addressCell, "la cellule adresse (truncate) doit être présente");
  assert.ok(addressCell!.className.includes("truncate"), "l'adresse doit rester tronquée, comportement compact inchangé");
  assert.ok(!addressCell!.className.includes("whitespace-pre-wrap"), "l'adresse ne doit jamais recevoir whitespace-pre-wrap");
  root.unmount();
});

test("UI MULTILINE FIX v2: RestaurantInfoBar -- valeur mono-ligne pour les horaires -- comportement inchangé, aucun formatage automatique ajouté", async () => {
  const { container, root } = render(baseRestaurant("07:00 – 23:00"));
  await flush();
  const hoursCell = container.querySelector("span.whitespace-pre-wrap");
  assert.ok(hoursCell, "la cellule des horaires doit être présente");
  assert.equal(hoursCell!.textContent, "Tous les jours : 07:00 – 23:00");
  // Le préfixe "Tous les jours" est un comportement PRÉEXISTANT
  // (horaire purement numérique), non introduit par ce correctif --
  // vérifié explicitement qu'aucun \n ni <br> n'apparaît pour une
  // valeur mono-ligne.
  assert.ok(!hoursCell!.textContent!.includes("\n"), "une valeur mono-ligne ne doit jamais gagner de retour à la ligne artificiel");
  assert.ok(!hoursCell!.innerHTML.includes("<br"), "aucun <br> ne doit jamais être injecté");
  root.unmount();
});

test("UI MULTILINE FIX v2: aucun parsing sémantique des horaires -- une valeur multiligne arbitraire (jamais vue, sans rapport avec des jours) est rendue telle quelle", async () => {
  const arbitraryMultiline = "Première ligne quelconque\nDeuxième ligne sans rapport\nTroisième";
  const { container, root } = render(baseRestaurant(arbitraryMultiline));
  await flush();
  const hoursCell = container.querySelector("span.whitespace-pre-wrap");
  assert.ok(hoursCell);
  assert.equal(hoursCell!.textContent, arbitraryMultiline, "le contenu est rendu tel quel, jamais réinterprété ou reformaté selon une logique métier d'horaires");
  root.unmount();
});

// ====================================================================
// Corrige BUG UI 1 (fiche publique, zone Horaires trop étroite) :
// preuve comportementale RÉELLE (rendu DOM) que la cellule horaires
// obtient désormais davantage de largeur -- pleine ligne sur mobile
// (comme l'adresse), 2 colonnes sur 4 à partir de sm (au lieu d'1 sur
// 3 auparavant) -- SANS régresser ni l'adresse, ni le téléphone, ni
// le comportement multiline déjà couvert plus haut dans ce fichier.
// ====================================================================

test("BUG UI 1 : la cellule horaires obtient col-span-2 sm:col-span-2 (pleine largeur mobile + moitié à partir de sm), grille passée à sm:grid-cols-4", async () => {
  const restaurant = baseRestaurant("Mar – Ven 10:00 – 14:00 / 16:00 – 20:00");
  (restaurant.config as any).address = "10 rue de Paris, 75001 Paris";
  const { container, root } = render(restaurant);
  await flush();

  const grid = container.querySelector(".grid");
  assert.ok(grid, "le conteneur grille doit être présent");
  assert.ok(grid!.className.includes("sm:grid-cols-4"), `la grille doit désormais utiliser sm:grid-cols-4, reçu: "${grid!.className}"`);
  assert.ok(!grid!.className.includes("sm:grid-cols-3"), "l'ancienne valeur sm:grid-cols-3 ne doit plus être présente");

  const hoursCell = container.querySelector("span.whitespace-pre-wrap")!;
  const hoursWrapper = hoursCell.closest('[class*="items-start"]')!;
  assert.ok(hoursWrapper.className.includes("col-span-2"), "la cellule horaires doit occuper toute la largeur sur mobile (col-span-2)");
  assert.ok(hoursWrapper.className.includes("sm:col-span-2"), `la cellule horaires doit occuper 2 colonnes sur 4 à partir de sm, reçu: "${hoursWrapper.className}"`);
  assert.ok(hoursCell.className.includes("whitespace-pre-wrap"), "le multiline existant (Bug 1 ne doit pas y toucher) reste préservé");

  root.unmount();
});

test("BUG UI 1 : l'adresse (wide) conserve exactement son comportement d'avant -- col-span-2 sm:col-span-1, jamais sm:col-span-2", async () => {
  const restaurant = baseRestaurant("07:00 – 23:00");
  (restaurant.config as any).address = "10 rue de Paris, 75001 Paris";
  const { container, root } = render(restaurant);
  await flush();

  const addressCell = Array.from(container.querySelectorAll('[class*="items-start"]')).find((el) =>
    el.textContent?.includes("rue de Paris")
  )!;
  assert.ok(addressCell, "la cellule adresse doit être présente");
  assert.ok(addressCell.className.includes("col-span-2"), "l'adresse reste pleine largeur sur mobile, comme avant");
  assert.ok(addressCell.className.includes("sm:col-span-1"), `l'adresse doit rester sur 1 colonne à partir de sm (comportement inchangé), reçu: "${addressCell.className}"`);
  assert.ok(!addressCell.className.includes("sm:col-span-2"), "l'adresse ne doit jamais recevoir le nouveau span réservé aux horaires");

  root.unmount();
});

test("BUG UI 1 : le téléphone (ni wide ni wideDesktop) n'obtient aucun span explicite -- comportement par défaut (1 colonne) inchangé", async () => {
  // getSettings(slug).phone n'est renseigné que pour certains slugs
  // réels du fichier de configuration statique (lib/restaurants-config.ts)
  // -- "au-lait-cru-inexistant" (utilisé par baseRestaurant()) n'y
  // figure pas volontairement (cas générique par défaut). "illico-presto"
  // y a un téléphone défini ("+213 41 55 12 34"), seul moyen réel de
  // faire apparaître la cellule téléphone dans ce rendu.
  const restaurant = baseRestaurant("07:00 – 23:00");
  restaurant.slug = "illico-presto";
  const { container, root } = render(restaurant);
  await flush();

  const phoneCell = container.querySelector('a[href^="tel:"]');
  assert.ok(phoneCell, "la cellule téléphone (lien tel:) doit être présente");
  assert.ok(!phoneCell.className.includes("col-span-2"), "le téléphone ne doit gagner aucun col-span (comportement par défaut inchangé)");

  root.unmount();
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
