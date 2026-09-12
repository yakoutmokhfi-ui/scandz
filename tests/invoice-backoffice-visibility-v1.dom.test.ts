import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — INVOICE BACKOFFICE VISIBILITY + BILLING ADDRESS v1
// (Claude Monet), mandat Section E / matrice de test §I, éléments
// 11 à 16.
//
// Preuve comportementale RÉELLE (rendu React dans un vrai DOM, patron
// esbuild/jsdom déjà établi -- voir
// tests/v133-receipt-invoice-name-history.dom.test.ts) que
// components/dashboard/OrderCard.tsx affiche désormais la demande de
// facture (order_invoice_request) QUAND ELLE EXISTE, sans jamais
// afficher de statut de génération/envoi (mandat, littéral : "Do NOT
// display 'Facture générée'/'Envoyée'"). Le dernier test (16) prouve,
// par un mock direct de `supabase.from`, que
// `lib/services/dashboard.ts` embarque désormais la relation
// `order_invoice_request` dans sa requête -- SANS introduire
// d'endpoint service-role (même client authentifié qu'avant ce lot).
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
    service_mode: "delivery",
    table_number: null,
    customer_name: "Yakout",
    customer_phone: "0612345678",
    customer_email: null,
    delivery_address: "10 rue de Rivoli, 75001 Paris",
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
        id: "i1",
        item_name: "Cookie chocolat",
        option_name: null,
        quantity: 2,
        unit_price: 7.5,
        line_total: 15,
      },
    ],
    // Par défaut, AUCUNE demande de facture (cas normal, majoritaire) --
    // chaque test ci-dessous fournit `order_invoice_request` explicitement
    // lorsqu'il veut prouver le comportement inverse.
    order_invoice_request: null,
    ...overrides,
  };
}

function render(order: Record<string, unknown>) {
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
      staffLanguage: "fr",
    })
  );
  return { container, root };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("11. OrderCard -- AUCUNE demande de facture (order_invoice_request null) : ni badge 'Facture demandée', ni bloc de détails", async () => {
  const { container, root } = render(baseOrder());
  await flush();

  assert.ok(
    !container.textContent!.includes("Facture demandée"),
    "aucun badge de demande de facture ne doit apparaître sans order_invoice_request"
  );

  root.unmount();
  container.remove();
});

test("12. OrderCard -- demande de facture présente : badge 'Facture demandée' affiché", async () => {
  const { container, root } = render(
    baseOrder({
      order_invoice_request: {
        invoice_type: "individual",
        company_legal_name: null,
        vat_number: null,
        contact_name: null,
        contact_email: null,
        address_line_1: "10 rue de Rivoli",
        address_line_2: null,
        city: "Paris",
        postal_code: "75001",
        country: "FR",
        updated_at: new Date().toISOString(),
      },
    })
  );
  await flush();

  assert.ok(
    container.textContent!.includes("Facture demandée"),
    "le badge 'Facture demandée' doit apparaître dès que order_invoice_request existe"
  );
  // Mandat, littéral : "Do NOT display 'Facture générée'/'Envoyée'" --
  // aucune de ces mentions ne doit jamais apparaître (ce lot n'introduit
  // aucune colonne de statut de génération/envoi).
  assert.ok(!container.textContent!.includes("Facture générée"));
  assert.ok(!container.textContent!.includes("Envoyée"));

  root.unmount();
  container.remove();
});

test("13. OrderCard -- facture INDIVIDUELLE : type, contact et adresse affichés ; aucune mention société/TVA", async () => {
  const { container, root } = render(
    baseOrder({
      order_invoice_request: {
        invoice_type: "individual",
        company_legal_name: null,
        vat_number: null,
        contact_name: "Jean Client",
        contact_email: "jean@example.com",
        address_line_1: "10 rue de Rivoli",
        address_line_2: "Bâtiment B",
        city: "Paris",
        postal_code: "75001",
        country: "FR",
        updated_at: new Date().toISOString(),
      },
    })
  );
  await flush();

  assert.ok(container.textContent!.includes("Particulier"), "le type de facture (individuel) doit être affiché");
  assert.ok(container.textContent!.includes("Jean Client"), "le nom de contact doit être affiché");
  assert.ok(container.textContent!.includes("jean@example.com"), "l'email de contact doit être affiché");
  assert.ok(container.textContent!.includes("10 rue de Rivoli"), "l'adresse de facturation doit être affichée");
  assert.ok(container.textContent!.includes("Bâtiment B"), "le complément d'adresse doit être affiché quand présent");
  assert.ok(container.textContent!.includes("75001"));
  assert.ok(container.textContent!.includes("Paris"));

  root.unmount();
  container.remove();
});

test("14. OrderCard -- facture SOCIÉTÉ : raison sociale, TVA, type et adresse tous affichés", async () => {
  const { container, root } = render(
    baseOrder({
      order_invoice_request: {
        invoice_type: "company",
        company_legal_name: "ACME SARL",
        vat_number: "FR12345678901",
        contact_name: "Jeanne Compta",
        contact_email: "compta@acme.example",
        address_line_1: "1 avenue Société",
        address_line_2: null,
        city: "Lyon",
        postal_code: "69001",
        country: "FR",
        updated_at: new Date().toISOString(),
      },
    })
  );
  await flush();

  assert.ok(container.textContent!.includes("Société"), "le type de facture (société) doit être affiché");
  assert.ok(container.textContent!.includes("ACME SARL"), "la raison sociale doit être affichée");
  assert.ok(container.textContent!.includes("FR12345678901"), "le numéro de TVA doit être affiché");
  assert.ok(container.textContent!.includes("Jeanne Compta"));
  assert.ok(container.textContent!.includes("compta@acme.example"));
  assert.ok(container.textContent!.includes("1 avenue Société"));

  root.unmount();
  container.remove();
});

test("15. OrderCard -- champs optionnels (TVA/contact/complément d'adresse) absents : rendu SANS crash, aucune mention 'null'/'undefined'", async () => {
  const { container, root } = render(
    baseOrder({
      order_invoice_request: {
        invoice_type: "company",
        company_legal_name: "ACME SARL",
        vat_number: null,
        contact_name: null,
        contact_email: null,
        address_line_1: "1 avenue Société",
        address_line_2: null,
        city: "Lyon",
        postal_code: "69001",
        country: "FR",
        updated_at: new Date().toISOString(),
      },
    })
  );
  await flush();

  assert.ok(container.textContent!.includes("Facture demandée"));
  assert.ok(container.textContent!.includes("ACME SARL"));
  assert.ok(!container.textContent!.includes("null"), "aucune valeur optionnelle absente ne doit apparaître comme la chaîne 'null'");
  assert.ok(!container.textContent!.includes("undefined"), "idem pour 'undefined'");

  root.unmount();
  container.remove();
});

// NOTE : la preuve que getDashboardOrders() embarque désormais
// order_invoice_request (mandat, item 16 de la matrice de test) vit
// dans un fichier SÉPARÉ, délibérément PLAIN (jamais .dom.test.ts) :
// tests/invoice-backoffice-visibility-v1-query.test.ts -- voir le
// commentaire de tête de ce fichier pour l'explication complète
// (conflit réel, non lié à ce lot, entre le client Supabase et un
// `globalThis.window` jsdom simultanés).
