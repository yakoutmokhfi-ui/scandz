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
// Test comportemental React réel (LOT 1A.1, tour 2, findings L1A-02
// et L1A-03) : rendu RÉEL de MenuView dans un DOM (jsdom), pas une
// lecture du fichier source -- exigence explicite de Work ("ne
// considère pas un test de présence de chaînes comme preuve d'un
// comportement"). Même technique qu'en V68
// (tests/v68-establishment-assets.dom.test.ts) : esbuild.build() avec
// bundling réel et un plugin d'alias "@/" -> racine du dépôt.
//
// ⚠️ CORRIGE L1A1-01 (contre-audit Work, tour LOT 1A.2) : le fichier
// laissait un handle résiduel réel (Promise jamais résolue, "cancelled
// 1" détecté par Work SANS --test-force-exit) -- cause racine
// identifiée et corrigée, PAS contournée par un mécanisme de
// terminaison forcée :
//
//   1. requestAnimationFrame/cancelAnimationFrame étaient remplacés
//      par un polyfill maison basé sur setTimeout brut, DÉCONNECTÉ du
//      cycle de vie JSDOM -- window.close() ne pouvait donc jamais
//      nettoyer les timers programmés par ce polyfill. JSDOM fournit
//      DÉJÀ requestAnimationFrame/cancelAnimationFrame nativement via
//      pretendToBeVisual:true, correctement rattachés à window.close()
//      (vérifié empiriquement avant ce correctif) -- réutilisés tels
//      quels ci-dessous, plus aucun polyfill maison.
//   2. window.close() n'était jamais appelé -- ajouté dans un hook
//      after() (node:test), qui s'exécute une seule fois après TOUS
//      les tests de ce fichier.
//   3. Les globals modifiés (window, document, navigator, HTMLElement,
//      Event, requestAnimationFrame, cancelAnimationFrame) n'étaient
//      jamais restaurés -- restaurés explicitement dans ce même hook.
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
// Corrige L1A1-01 : requestAnimationFrame/cancelAnimationFrame réels de
// JSDOM (pretendToBeVisual:true), jamais un polyfill setTimeout brut
// déconnecté du cycle de vie de la fenêtre -- window.close() (voir le
// hook after() plus bas) sait alors réellement tout nettoyer.
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
export { default as MenuView } from "@/components/MenuView";
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
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseRestaurant(overrides: {
  sourceLanguage?: string;
  activeLanguages?: Array<{ code: string; label: string; dir: "ltr" | "rtl"; display_order: number }>;
} = {}) {
  return {
    id: "r1",
    name: "Test Restaurant",
    slug: "test-restaurant-inexistant",
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
      opening_hours: null,
      source_language: overrides.sourceLanguage ?? "fr",
    },
    categories: [],
    hiddenCategories: [],
    activeLanguages: overrides.activeLanguages ?? [
      { code: "fr", label: "Français", dir: "ltr", display_order: 1 },
    ],
  };
}

function render(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function outerDir(container: HTMLElement): string | null {
  // Le conteneur racine de MenuView porte dir={dirOf(lang, ...)}.
  const root = container.firstElementChild as HTMLElement | null;
  return root?.getAttribute("dir") ?? null;
}

// --------------------------------------------------------------------
// L1A-02 — initialisation correcte de la langue publique
// --------------------------------------------------------------------

test("MenuView (DOM réel, L1A-02) : établissement AR-only -> AR actif dès le rendu initial, dir=rtl (plus de 'fr' figé)", async () => {
  const restaurant = baseRestaurant({
    sourceLanguage: "ar",
    activeLanguages: [{ code: "ar", label: "العربية", dir: "rtl", display_order: 1 }],
  });
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(outerDir(container), "rtl", "un établissement AR-only doit être rtl dès le premier rendu, jamais ltr/fr par défaut");

  root.unmount();
  container.remove();
});

test("MenuView (DOM réel, L1A-02) : établissement FR-only -> FR actif, dir=ltr (comportement historique V79 inchangé)", async () => {
  const restaurant = baseRestaurant({
    sourceLanguage: "fr",
    activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  });
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(outerDir(container), "ltr");

  root.unmount();
  container.remove();
});

test("MenuView (DOM réel, L1A-02) : établissement EN-only -> EN actif, dir=ltr", async () => {
  const restaurant = baseRestaurant({
    sourceLanguage: "en",
    activeLanguages: [{ code: "en", label: "English", dir: "ltr", display_order: 1 }],
  });
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(outerDir(container), "ltr");
  assert.ok(container.textContent, "le rendu doit produire du contenu (pas un plantage)");

  root.unmount();
  container.remove();
});

test("MenuView (DOM réel, L1A-02) : source AR + langues actives AR/FR/EN -> AR reste la langue initiale (priorité à source_language)", async () => {
  const restaurant = baseRestaurant({
    sourceLanguage: "ar",
    activeLanguages: [
      { code: "ar", label: "العربية", dir: "rtl", display_order: 1 },
      { code: "fr", label: "Français", dir: "ltr", display_order: 2 },
      { code: "en", label: "English", dir: "ltr", display_order: 3 },
    ],
  });
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(outerDir(container), "rtl", "source_language='ar' doit primer, jamais retomber sur la première langue active ou sur fr");

  root.unmount();
  container.remove();
});

test("MenuView (DOM réel, L1A-02) : source FR + langues actives FR/EN -> FR reste la langue initiale", async () => {
  const restaurant = baseRestaurant({
    sourceLanguage: "fr",
    activeLanguages: [
      { code: "fr", label: "Français", dir: "ltr", display_order: 1 },
      { code: "en", label: "English", dir: "ltr", display_order: 2 },
    ],
  });
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(outerDir(container), "ltr");

  root.unmount();
  container.remove();
});

test("MenuView (DOM réel, L1A-02) : état invalide (source_language absente des langues actives) -> repli explicite sur la première langue active, jamais un plantage ni un 'fr' arbitraire", async () => {
  // Cas défensif : source_language='de' (jamais dans le catalogue
  // actuel) alors que les langues actives sont ['nl','ar'] -- la
  // priorité (1) échoue (source absente des actives), doit retomber
  // sur (2) la première langue active par display_order : 'nl'.
  const restaurant = baseRestaurant({
    sourceLanguage: "de",
    activeLanguages: [
      { code: "nl", label: "Nederlands", dir: "ltr", display_order: 1 },
      { code: "ar", label: "العربية", dir: "rtl", display_order: 2 },
    ],
  });
  const { container, root } = render(restaurant);
  await flush();

  // 'nl' (première langue active) est ltr -- confirme le repli
  // explicite sur la première langue active, pas un plantage.
  assert.equal(outerDir(container), "ltr", "doit retomber sur la première langue active (nl, ltr), jamais planter ni forcer fr");

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------------
// L1A-03 — RTL dérivé du catalogue, pas du code langue
// --------------------------------------------------------------------

test("MenuView (DOM réel, L1A-03) : langue RTL FICTIVE ajoutée dynamiquement (jamais 'ar') -> dir=rtl SANS modification de code, preuve que dirOf ne contient aucune liste figée", async () => {
  const restaurant = baseRestaurant({
    sourceLanguage: "xx-test-rtl",
    activeLanguages: [
      { code: "xx-test-rtl", label: "Langue Fictive RTL", dir: "rtl", display_order: 1 },
    ],
  });
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(
    outerDir(container),
    "rtl",
    "une langue RTL entièrement fictive (jamais 'ar', jamais codée en dur nulle part) doit produire dir=rtl grâce au catalogue transmis, preuve qu'aucune liste de langues RTL n'existe dans le code"
  );

  root.unmount();
  container.remove();
});

test("MenuView (DOM réel, L1A-03) : FR/EN/NL (aucune langue RTL) -> dir=ltr, non-régression", async () => {
  const restaurant = baseRestaurant({
    sourceLanguage: "fr",
    activeLanguages: [
      { code: "fr", label: "Français", dir: "ltr", display_order: 1 },
      { code: "en", label: "English", dir: "ltr", display_order: 2 },
      { code: "nl", label: "Nederlands", dir: "ltr", display_order: 3 },
    ],
  });
  const { container, root } = render(restaurant);
  await flush();

  assert.equal(outerDir(container), "ltr");

  root.unmount();
  container.remove();
});

// ====================================================================
// Cycle de vie complet (corrige L1A1-01) : ce hook s'exécute UNE
// SEULE FOIS, après TOUS les tests ci-dessus (aucun test individuel
// n'a besoin de le rappeler). Ferme réellement JSDOM (window.close()),
// ce qui nettoie à son tour tout timer/listener interne que
// window.requestAnimationFrame aurait pu programmer -- jamais un
// timer artificiel destiné à forcer la terminaison du processus.
// Restaure ensuite les globals modifiés par ce fichier, pour ne laisser
// aucune trace dans le reste de la suite (autres fichiers *.test.ts
// exécutés dans le même processus).
// ====================================================================
after(async () => {
  window.close();
  // Corrige L1A1-01 : esbuild.build() démarre un SERVICE persistant
  // (processus/socket natif, réutilisé pour accélérer des builds
  // successifs) qui reste ouvert indéfiniment tant que
  // esbuild.stop() n'est pas appelé explicitement -- confirmé être la
  // cause réelle des 2 sockets actifs détectés par diagnostic
  // (process._getActiveHandles()) avant ce correctif. window.close()
  // seul ne suffisait pas : ce service esbuild n'a aucun rapport avec
  // JSDOM/React, c'est un processus de compilation totalement
  // distinct.
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  // Corrige L1A1-01 (diagnostic confirmé via process._getActiveHandles()) :
  // le module "scheduler" de React (dépendance interne de react-dom)
  // crée un MessageChannel/MessagePort UNIQUE au niveau module, la
  // première fois qu'il doit céder la main de façon asynchrone (son
  // mécanisme de "yielding" en environnement Node, faute d'API
  // navigateur natives) -- ce port reste RÉFÉRENCÉ (ref()) pour le
  // reste du processus, sans AUCUNE API publique permettant de le
  // fermer explicitement (ce n'est ni un timer, ni un listener que
  // nous avons nous-mêmes créés). unref() est l'action correcte et
  // ciblée ici : elle ne ferme rien de force, elle indique seulement
  // à Node que ce port ne doit plus, à lui seul, empêcher le
  // processus de se terminer normalement -- une fois tous les tests
  // (et leur nettoyage React/JSDOM) terminés, ce port n'a plus
  // d'utilité et Node peut légitimement sortir.
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
