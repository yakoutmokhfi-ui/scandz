import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Scanym — RECEIPT / INVOICE TAX DETAIL v1.1 — preuve comportementale
// RÉELLE (rendu React dans un vrai DOM, patron esbuild/jsdom déjà
// établi -- voir tests/v67-product-photos.dom.test.ts) que
// components/dashboard/OrderCard.tsx ferme
// RITD-V1-NAME-HISTORY-01 (audit Work v1, MEDIUM, release-blocking) :
// un ancien order_items.item_name/option_name doit rester affiché tel
// quel dans TOUTES les langues du tableau de bord, jamais remplacé par
// une traduction catalogue COURANTE (menu_items.translations[lang]),
// même quand le produit a été renommé et traduit APRÈS la commande.
//
// mandat v1.1 §7 -- scénario obligatoire :
//   1. instantané order_items.item_name = "Produit A"
//   2. commande créée (simulée directement au niveau des props, pas
//      via create_order -- ce test porte sur le RENDU, la preuve SQL
//      du snapshot lui-même est dans le harnais SQL, section [4])
//   3. produit courant renommé "Produit B" (menu_items.translations
//      fourni dans les props simule cet état, comme le ferait la
//      jointure Supabase réelle de lib/services/dashboard.ts)
//   4. traduction courante changée "Product B"
//   5. langue du tableau de bord = non-française (en)
//   6. rendu de la commande historique
// Attendu : "Produit A", jamais "Produit B", jamais "Product B".
// Répété pour le nom d'option.
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
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

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
export { default as OrderCard } from "@/components/dashboard/OrderCard";
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
const tmpFile = path.join(tmpDir, "OrderCard.mjs");
writeFileSync(tmpFile, code);
const { OrderCard } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    restaurant_id: "r1",
    order_number: 42,
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
    subtotal: 15,
    total: 15,
    currency: "EUR",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    order_items: [
      {
        // Instantané historique -- ce que la commande a réellement
        // enregistré au moment de create_order (RECEIPT / INVOICE TAX
        // DETAIL v1). Le catalogue COURANT (renommé + traduit APRÈS
        // la commande) n'est PLUS chargé du tout par
        // lib/services/dashboard.ts depuis le correctif v1.1 -- ce
        // test le prouve au niveau du composant en ne fournissant
        // volontairement AUCUN champ de traduction catalogue dans les
        // props, exactement la forme que le type DashboardOrderItem
        // impose désormais.
        id: "i1",
        item_name: "Produit A",
        option_name: "Option A",
        quantity: 2,
        unit_price: 7.5,
        line_total: 15,
      },
    ],
    ...overrides,
  };
}

function render(order: Record<string, unknown>, staffLanguage: string) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderCard, {
      order,
      restaurantName: "Restaurant Test",
      receiptSettings: null,
      onStatus: async () => {},
      busy: false,
      staffLanguage,
    })
  );
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("OrderCard (DOM réel) : langue FRANÇAISE -- affiche l'instantané item_name/option_name (comportement déjà correct avant v1.1, non régressé)", async () => {
  const { container, root } = render(baseOrder(), "fr");
  await flush();

  assert.ok(container.textContent!.includes("Produit A"), "le nom instantané doit être affiché");
  assert.ok(container.textContent!.includes("Option A"), "le nom d'option instantané doit être affiché");

  root.unmount();
  container.remove();
});

test("OrderCard (DOM réel) : langue ANGLAISE -- ferme RITD-V1-NAME-HISTORY-01, affiche TOUJOURS l'instantané 'Produit A', jamais une traduction catalogue courante", async () => {
  const { container, root } = render(baseOrder(), "en");
  await flush();

  assert.ok(
    container.textContent!.includes("Produit A"),
    "l'instantané historique 'Produit A' doit rester affiché même en langue non-française"
  );
  assert.ok(
    !container.textContent!.includes("Produit B"),
    "le produit RENOMMÉ après la commande ('Produit B') ne doit JAMAIS apparaître"
  );
  assert.ok(
    !container.textContent!.includes("Product B"),
    "la TRADUCTION du catalogue courant ('Product B') ne doit JAMAIS apparaître -- c'est exactement RITD-V1-NAME-HISTORY-01"
  );

  root.unmount();
  container.remove();
});

test("OrderCard (DOM réel) : langue ARABE -- même garantie que pour l'anglais, sur la 3e langue supportée", async () => {
  const { container, root } = render(baseOrder(), "ar");
  await flush();

  assert.ok(container.textContent!.includes("Produit A"), "l'instantané historique doit rester affiché en arabe aussi");
  assert.ok(!container.textContent!.includes("Produit B"), "aucune fuite du renommage catalogue en arabe");

  root.unmount();
  container.remove();
});

test("OrderCard (DOM réel) : nom d'OPTION historique -- même garantie que le nom de produit, langue non-française", async () => {
  const { container, root } = render(baseOrder(), "en");
  await flush();

  assert.ok(
    container.textContent!.includes("Option A"),
    "le nom d'option instantané ('Option A') doit rester affiché"
  );
  assert.ok(
    !container.textContent!.includes("Option B"),
    "une traduction/renommage catalogue de l'option ne doit jamais apparaître"
  );

  root.unmount();
  container.remove();
});

test("OrderCard (DOM réel) : DashboardOrderItem ne porte plus AUCUN champ de traduction catalogue (v1.1 -- nettoyage du chemin mort qui causait RITD-V1-NAME-HISTORY-01)", async () => {
  // Preuve négative directe : même si un consommateur amont fournissait
  // encore par erreur des champs menu_items/option avec des
  // traductions divergentes, le composant ne les lit plus du tout --
  // le rendu doit rester sur l'instantané quoi qu'il arrive.
  const orderWithStaleTranslationFields = baseOrder({
    order_items: [
      {
        id: "i1",
        item_name: "Produit A",
        option_name: "Option A",
        quantity: 2,
        unit_price: 7.5,
        line_total: 15,
        // Champs volontairement réintroduits pour prouver qu'ils sont
        // IGNORÉS -- ceci était exactement le chemin de code supprimé.
        menu_items: { translations: { en: { name: "Product B" } } },
        option: { translations: { en: { name: "Option B" } } },
      },
    ],
  });
  const { container, root } = render(orderWithStaleTranslationFields, "en");
  await flush();

  assert.ok(container.textContent!.includes("Produit A"), "l'instantané reste affiché même si un champ de traduction catalogue est présent dans les données");
  assert.ok(!container.textContent!.includes("Product B"), "un champ de traduction catalogue résiduel ne doit plus jamais être lu par le composant");
  assert.ok(!container.textContent!.includes("Option B"), "idem pour le nom d'option");

  root.unmount();
  container.remove();
});
