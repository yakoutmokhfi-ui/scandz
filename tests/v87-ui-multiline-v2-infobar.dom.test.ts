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

test("CUSTOMER INFO CARD v1.1 : RestaurantInfoBar -- l'adresse n'est plus tronquée (plus de `truncate`), elle s'enroule naturellement sur toute la largeur désormais disponible", async () => {
  const restaurant = baseRestaurant("07:00 – 23:00");
  (restaurant.config as any).address = "10 rue de Paris, 75001 Paris, une adresse volontairement très longue pour prouver qu'elle n'est plus tronquée";
  const { container, root } = render(restaurant);
  await flush();

  const addressCell = Array.from(container.querySelectorAll("span.whitespace-normal")).find((s) =>
    s.textContent?.includes("rue de Paris")
  );
  assert.ok(addressCell, "la cellule adresse doit être présente");
  assert.equal(
    addressCell!.textContent,
    "10 rue de Paris, 75001 Paris, une adresse volontairement très longue pour prouver qu'elle n'est plus tronquée",
    "le texte complet doit être rendu tel quel, jamais coupé"
  );
  assert.ok(!addressCell!.className.includes("truncate"), "l'adresse ne doit plus jamais être tronquée (remédiation v1.1 -- pleine largeur disponible)");
  assert.ok(addressCell!.className.includes("whitespace-normal"), "l'adresse doit s'enrouler normalement, jamais whitespace-pre-wrap (réservé aux horaires)");
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
// CUSTOMER INFO CARD / ADDRESS-HOURS REMEDIATION v1.1 -- preuve
// comportementale RÉELLE (rendu DOM) que la carte d'informations
// utilise désormais un empilement VERTICAL PLEINE LARGEUR (jamais une
// grille CSS à colonnes, à aucun palier) : Adresse en premier, Horaires
// DIRECTEMENT en dessous, Téléphone ensuite -- SANS régresser le
// comportement multiline déjà couvert plus haut dans ce fichier.
//
// Remplace les anciens tests "BUG UI 1" (grid-cols-4/col-span), qui
// vérifiaient l'ancienne disposition en colonnes que ce lot supprime
// intentionnellement (mandat : "Do not switch back to a two-column
// layout on larger screens").
// ====================================================================

test("CUSTOMER INFO CARD v1.1 : aucune grille CSS à colonnes -- le conteneur des champs est un empilement flex vertical (flex-col), à AUCUN palier de largeur", async () => {
  const restaurant = baseRestaurant("Mar – Ven 10:00 – 14:00 / 16:00 – 20:00");
  (restaurant.config as any).address = "10 rue de Paris, 75001 Paris";
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(container.querySelector(".grid"), null, "aucun conteneur '.grid' ne doit plus exister -- la disposition en colonnes est supprimée");
  const stack = container.querySelector(".flex-col");
  assert.ok(stack, "un conteneur flex-col (empilement vertical) doit envelopper les champs");
  assert.ok(!stack!.className.includes("grid-cols"), "aucune classe grid-cols ne doit subsister sur ce conteneur");
  assert.ok(!stack!.className.includes("sm:grid-cols"), "aucune classe sm:grid-cols ne doit réintroduire une disposition en colonnes à partir d'un certain palier");

  root.unmount();
});

test("CUSTOMER INFO CARD v1.1 : Adresse en premier, Horaires DIRECTEMENT en dessous (jamais le téléphone entre les deux) -- ordre exact requis par le mandat", async () => {
  const restaurant = baseRestaurant("Mar – Ven 10:00 – 14:00 / 16:00 – 20:00");
  restaurant.slug = "illico-presto"; // seul slug statique avec un téléphone configuré
  (restaurant.config as any).address = "10 rue de Paris, 75001 Paris";
  const { container, root } = render(restaurant);
  await flush();

  const rowLabels = Array.from(container.querySelectorAll(".flex-col > *")).map(
    (row) => row.querySelector(".uppercase")?.textContent
  );
  assert.deepEqual(
    rowLabels,
    ["Adresse", "Horaires", "Téléphone"],
    `l'ordre affiché doit être Adresse, Horaires, Téléphone (horaires DIRECTEMENT après adresse) -- reçu: ${JSON.stringify(rowLabels)}`
  );

  root.unmount();
});

test("CUSTOMER INFO CARD v1.1 : chaque champ (adresse, horaires, téléphone) occupe systématiquement 100% de la largeur de la carte, sur tous les paliers -- aucun col-span, aucune classe responsive de largeur partielle", async () => {
  const restaurant = baseRestaurant("07:00 – 23:00");
  restaurant.slug = "illico-presto";
  (restaurant.config as any).address = "10 rue de Paris, 75001 Paris";
  const { container, root } = render(restaurant);
  await flush();

  const rows = Array.from(container.querySelectorAll(".flex-col > *"));
  assert.equal(rows.length, 3, "3 champs attendus (adresse, horaires, téléphone)");
  for (const row of rows) {
    assert.ok(row.className.includes("w-full"), `chaque ligne doit porter w-full (pleine largeur), reçu pour "${row.textContent?.slice(0, 20)}": "${row.className}"`);
    assert.ok(!row.className.includes("col-span"), "aucune classe col-span ne doit subsister sur aucune ligne");
    assert.ok(!/\bsm:w-|md:w-|lg:w-/.test(row.className), "aucune classe de largeur responsive partielle ne doit réintroduire un comportement en colonnes à un palier plus large");
  }

  root.unmount();
});

test("CUSTOMER INFO CARD v1.1 : le téléphone (dernier de l'empilement) n'obtient aucun col-span -- comportement par défaut, pleine largeur comme les autres champs", async () => {
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
  assert.ok(!phoneCell.className.includes("col-span"), "le téléphone ne doit gagner aucun col-span");
  assert.ok(phoneCell.className.includes("w-full"), "le téléphone doit occuper toute la largeur, comme les autres champs");

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
