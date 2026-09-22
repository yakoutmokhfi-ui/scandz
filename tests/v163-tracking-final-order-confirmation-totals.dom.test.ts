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
// Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "total
// amount visibility" / "invoice-request indicator").
//
// components/OrderConfirmation.tsx gagne deux props OPTIONNELLES,
// `totalAmount`/`invoiceRequested` -- ce fichier est un COMPLÉMENT de
// tests/v122h-tracking-order-confirmation.dom.test.ts (laissé
// INCHANGÉ : son propre render() ne fournit pas ces deux props, ce qui
// prouve au passage la non-régression -- absentes, elles n'affichent
// simplement rien de nouveau).
//
// Même harnais esbuild+JSDOM que v122h (composant bundlé isolément,
// react/react-dom externalisés).
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
export { default as OrderConfirmation } from "@/components/OrderConfirmation";
export { I18nProvider } from "@/lib/i18n-context";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v163-"));
const tmpFile = path.join(tmpDir, "OrderConfirmation.mjs");
writeFileSync(tmpFile, code);
const { OrderConfirmation, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fixture RestaurantFull minimale, IDENTIQUE à v122h -- seuls
 *  restaurant.name et restaurant.config.currency sont lus par ce
 *  composant. */
const RESTAURANT = {
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
  categories: [],
  hiddenCategories: [],
  activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
};

function render(props: {
  totalAmount?: number | null;
  invoiceRequested?: boolean;
  lang?: "fr" | "en" | "ar";
  context?: any;
}) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const element = React.createElement(OrderConfirmation, {
    restaurant: RESTAURANT,
    context: props.context ?? null,
    orderNumber: 42,
    trackingPath: null,
    totalAmount: props.totalAmount,
    invoiceRequested: props.invoiceRequested,
    onBackToMenu: () => {},
    onNewOrder: () => {},
  });
  root.render(
    props.lang
      ? React.createElement(
          I18nProvider,
          { lang: props.lang, sourceLanguage: "fr", activeLanguages: RESTAURANT.activeLanguages },
          element
        )
      : element
  );
  return { container, root };
}

test("mandat « total amount visibility » : totalAmount fourni -- le montant FORMATÉ (devise EUR) est rendu", async () => {
  const { container, root } = render({ totalAmount: 24.9 });
  await flush();

  assert.ok(container.textContent?.includes("Montant total"), "le libellé doit être rendu");
  // formatPrice(24.9, "EUR") -> Intl.NumberFormat("fr-FR", {style:"currency",currency:"EUR"}) ;
  // on vérifie la présence des chiffres significatifs plutôt que la
  // ponctuation exacte des espaces insécables Intl (fragile).
  assert.ok(container.textContent?.includes("24,90"), "le montant formaté doit apparaître");

  root.unmount();
  container.remove();
});

test("mandat « total amount visibility » : totalAmount ABSENT (undefined) -- aucune ligne de montant rendue, jamais un montant inventé", async () => {
  const { container, root } = render({});
  await flush();

  assert.equal(container.textContent?.includes("Montant total"), false);

  root.unmount();
  container.remove();
});

test("mandat « total amount visibility » : totalAmount=0 -- la ligne EST rendue (0 est une valeur légitime, jamais confondu avec « absent »)", async () => {
  const { container, root } = render({ totalAmount: 0 });
  await flush();

  assert.ok(container.textContent?.includes("Montant total"));

  root.unmount();
  container.remove();
});

test("mandat « invoice-request indicator » : invoiceRequested=true -- l'indicateur de facture est rendu", async () => {
  const { container, root } = render({ invoiceRequested: true });
  await flush();

  assert.ok(container.textContent?.includes("Facture demandée"));

  root.unmount();
  container.remove();
});

test("mandat « invoice-request indicator » : invoiceRequested absent/false -- AUCUN indicateur rendu (jamais un état « facture en cours » par défaut)", async () => {
  const { container: c1, root: r1 } = render({});
  await flush();
  assert.equal(c1.textContent?.includes("Facture demandée"), false);
  r1.unmount();
  c1.remove();

  const { container: c2, root: r2 } = render({ invoiceRequested: false });
  await flush();
  assert.equal(c2.textContent?.includes("Facture demandée"), false);
  r2.unmount();
  c2.remove();
});

test("mandat §25 (langue) : en anglais, le libellé de montant total est traduit", async () => {
  const { container, root } = render({ totalAmount: 24.9, lang: "en" });
  await flush();

  assert.ok(container.textContent?.includes("Total amount"));
  assert.equal(container.textContent?.includes("Montant total"), false);

  root.unmount();
  container.remove();
});

test("mandat « FR/EN/AR i18n » : en arabe, le libellé de montant total ET l'indicateur de facture sont traduits", async () => {
  const { container, root } = render({ totalAmount: 24.9, invoiceRequested: true, lang: "ar" });
  await flush();

  assert.ok(container.textContent?.includes("المبلغ الإجمالي"), "libellé de montant total en arabe");
  assert.ok(container.textContent?.includes("تم طلب الفاتورة"), "indicateur de facture en arabe");

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------------
// mandat « correct fulfillment wording » -- le résumé de mode de
// service (contextSummary) N'EST PAS modifié par ce lot, mais n'avait
// jusqu'ici AUCUNE couverture de test dédiée sur l'écran de
// confirmation lui-même (tests/v122h-... ne couvre que trackingPath,
// jamais `context`) -- ce lot ferme ce trou de couverture requis par
// le mandat, sans changer le comportement lui-même.
// --------------------------------------------------------------------

test("mandat « correct fulfillment wording » : contexte « table » -- libellé de table rendu, jamais un code interne", async () => {
  const { container, root } = render({ context: { mode: "table", tableNumber: 7 } });
  await flush();

  assert.ok(container.textContent?.includes("Table 7"), "libellé traduit avec le numéro de table, jamais l'enum brut \"table\"");

  root.unmount();
  container.remove();
});

const FIXTURE_CUSTOMER = {
  name: "A. Test",
  // CFTE v1 : champs de SAISIE ajoutés à CustomerInfo (aucune colonne
  // persistante). Vides ici -- le nom d'affichage retombe alors sur
  // `name`, comportement strictement inchangé pour ce test.
  firstName: "",
  lastName: "",
  street: "1 rue Test",
  postalCode: "75000",
  city: "Paris",
  phone: "+33600000000",
  email: "test@example.com",
};

test("mandat « correct fulfillment wording » : contexte « pickup » -- libellé de retrait rendu", async () => {
  const { container, root } = render({
    context: { mode: "pickup", customer: FIXTURE_CUSTOMER },
  });
  await flush();

  assert.ok(container.textContent?.includes("emporter"));

  root.unmount();
  container.remove();
});

test("mandat « correct fulfillment wording » : contexte « delivery » -- libellé de livraison rendu avec la zone, jamais l'enum brut", async () => {
  const { container, root } = render({
    context: { mode: "delivery", zoneLabel: "Centre-ville", customer: FIXTURE_CUSTOMER },
  });
  await flush();

  assert.ok(container.textContent?.includes("Livraison"));
  assert.ok(container.textContent?.includes("Centre-ville"));

  root.unmount();
  container.remove();
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
