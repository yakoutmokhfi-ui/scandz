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
// AU LAIT CRU — CASE 1A -- test dédié au finding ALC-SM-02 (audit
// Work, MEDIUM) : les 3 états loading/error/loaded([]) du sélecteur de
// modes de vente doivent être DISTINGUÉS explicitement dans le message
// affiché au client, jamais confondus :
//   - "loading"           -> message de chargement (existant) ;
//   - "error"              -> message neutre dédié, JAMAIS un
//                             chargement infini, aucun repli legacy ;
//   - "loaded", liste VIDE -> message dédié "aucun mode disponible",
//                             JAMAIS "Choisissez le retrait ou la
//                             livraison" (qui suppose un choix réel).
// Dans les 3 cas : soumission impossible (bouton d'envoi absent).
//
// Montage réel de MenuView (rendu React dans un vrai DOM, appels
// supabase.rpc/supabase.from réellement interceptés) -- même patron
// que tests/v91-lot2b4a2-dynamic-form.dom.test.ts /
// tests/v92-aulaitcru-sale-modes-runtime.dom.test.ts.
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
      const candidate = ["", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p));
      const resolvedPath = candidate ?? base;
      if (resolvedPath.endsWith(path.join("lib", "supabase.ts"))) {
        return { path: pathToFileURL(resolvedPath).href, external: true };
      }
      return { path: resolvedPath };
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v94-"));
const tmpFile = path.join(tmpDir, "MenuView.mjs");
writeFileSync(tmpFile, code);
const { MenuView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 3000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(intervalMs);
  }
}

function click(el: Element) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function buttonWithText(container: Element, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

/** Fixture minimale, un seul produit -- non liée à un établissement
 *  connu de lib/restaurants-config.ts (comportement 100% piloté par la
 *  RPC mockée, jamais par un repli statique). */
function testRestaurant() {
  return {
    id: "r-alcsm02-test",
    name: "Test (ALC-SM-02)",
    slug: "alc-sm-02-test",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    config: {
      restaurant_id: "r-alcsm02-test",
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
        restaurant_id: "r-alcsm02-test",
        name: "Produits",
        display_order: 1,
        is_active: true,
        menu_items: [
          {
            id: "item-1",
            category_id: "cat-1",
            name: "Article",
            description: null,
            short_description: null,
            price: 4,
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

async function renderAndAddOneItemToCart() {
  const restaurant = testRestaurant();
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(MenuView, { restaurant }));
  await flush();

  const addBtn = buttonWithText(container, "Ajouter");
  assert.ok(addBtn, "le bouton Ajouter doit être présent");
  click(addBtn!);
  await flush();

  const cartBar = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("🛒")
  );
  assert.ok(cartBar, "la barre panier doit apparaître dès qu'un article est ajouté");
  click(cartBar!);
  await flush();

  return { container, root };
}

/** Zone/message d'action de la carte (bouton d'envoi OU message
 *  `missing`) -- dernier <p> ou <button> de la zone footer, identifié
 *  ici par le fait que le texte du bouton d'envoi est connu et fixe. */
function sendButton(container: Element) {
  return buttonWithText(container, "Enregistrer et continuer sur WhatsApp");
}

test("ALC-SM-02 (loading) : message de chargement affiché, envoi impossible, tant que get_restaurant_public_sale_modes n'a pas répondu", async (t) => {
  // getPublicSaleModes() attend Promise.all([RPC, sale_mode_catalog]) --
  // sale_mode_catalog DOIT se résoudre normalement ici (immédiatement),
  // faute de quoi Promise.all rejetterait dès que ce second appel
  // échoue, quel que soit l'état (jamais résolu, volontairement) du
  // premier -- ce qui testerait "error", pas "loading", par accident.
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: [], error: null }) };
    }
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async () => new Promise(() => {})); // jamais résolu

  const { container, root } = await renderAndAddOneItemToCart();
  try {
    await flush(50);
    assert.equal(sendButton(container), undefined, "aucune soumission possible pendant le chargement");
    assert.ok(
      container.textContent?.includes("Chargement…"),
      "le message de chargement (mcLoading) doit être visible pendant l'état 'loading'"
    );
    assert.ok(
      !container.textContent?.includes("Choisissez le retrait ou la livraison"),
      "le message 'Choisissez le retrait ou la livraison' ne doit jamais apparaître pendant le chargement"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("ALC-SM-02 (error) : message neutre dédié affiché, envoi impossible, jamais un chargement infini, quand get_restaurant_public_sale_modes échoue", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: [], error: null }) };
    }
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_restaurant_public_sale_modes") {
      return { data: null, error: { message: "panne réseau simulée" } };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderAndAddOneItemToCart();
  try {
    await waitFor(
      () => container.textContent?.includes("Impossible de charger les modes de commande.") === true,
      "le message d'erreur dédié doit apparaître après échec de la RPC"
    );
    assert.equal(sendButton(container), undefined, "aucune soumission possible après une erreur de chargement");
    assert.ok(
      !container.textContent?.includes("Chargement…"),
      "l'état 'error' ne doit jamais rester affiché comme un chargement infini"
    );
    assert.ok(
      !container.textContent?.includes("Choisissez le retrait ou la livraison"),
      "le message 'Choisissez le retrait ou la livraison' ne doit jamais apparaître après une erreur"
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("ALC-SM-02 (loaded vide) : message dédié 'aucun mode disponible' affiché, envoi impossible, jamais confondu avec un chargement ou une erreur, jamais 'Choisissez le retrait ou la livraison'", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "sale_mode_catalog") {
      return { select: async () => ({ data: [], error: null }) };
    }
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_restaurant_public_sale_modes") {
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = await renderAndAddOneItemToCart();
  try {
    await waitFor(
      () => container.textContent?.includes("Aucun mode de commande n'est disponible pour le moment.") === true,
      "le message dédié 'aucun mode disponible' doit apparaître pour loaded([])"
    );
    assert.equal(sendButton(container), undefined, "aucune soumission possible quand aucun mode n'est disponible");
    assert.ok(
      !container.textContent?.includes("Chargement…"),
      "loaded([]) n'est pas un chargement -- ne doit jamais afficher le message de chargement"
    );
    assert.ok(
      !container.textContent?.includes("Impossible de charger les modes de commande."),
      "loaded([]) n'est pas une erreur -- ne doit jamais afficher le message d'erreur"
    );
    assert.ok(
      !container.textContent?.includes("Choisissez le retrait ou la livraison"),
      "ALC-SM-02: 'Choisissez le retrait ou la livraison' n'a aucun sens sans choix réel -- ne doit JAMAIS apparaître quand la liste résolue est vide"
    );
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
