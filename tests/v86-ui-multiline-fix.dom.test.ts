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
// UI MULTILINE FIX v1 -- preuve comportementale RÉELLE (rendu React
// dans un vrai DOM, jamais une lecture du fichier source) que
// RestaurantInfoCard préserve les retours à la ligne (\n) réellement
// saisis dans config.opening_hours (cas réel : Au Lait Cru).
//
// Audit préalable (voir rapport) : la donnée est un simple text
// PostgreSQL, sans contrainte empêchant les \n internes (seul le
// trim des bords est appliqué côté RPC). Le rendu React préserve déjà
// les \n dans le nœud texte du DOM -- le défaut était PUREMENT CSS
// (white-space: normal par défaut, qui collapse les \n en espace).
// Aucune transformation de la donnée, aucun <br> injecté, aucun
// dangerouslySetInnerHTML.
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
export { default as RestaurantInfoCard } from "@/components/RestaurantInfoCard";
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
const tmpFile = path.join(tmpDir, "RestaurantInfoCard.mjs");
writeFileSync(tmpFile, code);
const { RestaurantInfoCard } = await import(pathToFileURL(tmpFile).href);
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
    },
    categories: [],
    hiddenCategories: [],
  };
}

function render(restaurant: Record<string, unknown>) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(RestaurantInfoCard, { restaurant }));
  return { container, root };
}

test("UI MULTILINE FIX v1: config.opening_hours multiligne (cas réel Au Lait Cru) -- les retours à la ligne sont préservés dans le DOM rendu, jamais fusionnés", async () => {
  const multilineHours =
    "Lundi 16:00 – 20:00\nMar – Ven 10:00 – 14:00\n16:00 – 20:00\nSamedi 10:00 – 19:30\nDimanche\nFermé";
  const { container, root } = render(baseRestaurant(multilineHours));
  await flush();

  const hoursParagraph = Array.from(container.querySelectorAll("p")).find((p) =>
    p.textContent?.includes("Lundi")
  );
  assert.ok(hoursParagraph, "le paragraphe des horaires doit être présent dans le DOM");

  // Preuve que la donnée elle-même (nœud texte réel) contient bien
  // les \n -- React ne les a jamais supprimés, confirmant que le bug
  // était purement CSS, jamais une transformation de la donnée.
  assert.ok(hoursParagraph!.textContent!.includes("\n"), "le texte réellement rendu doit contenir les retours à la ligne d'origine, jamais fusionnés en espaces");
  assert.equal(hoursParagraph!.textContent, multilineHours, "le contenu textuel du DOM doit être IDENTIQUE, caractère pour caractère, à la donnée d'origine -- aucune transformation");

  // Preuve que la préservation visuelle est bien assurée par CSS
  // (whitespace-pre-wrap), jamais par une injection de <br>.
  assert.ok(hoursParagraph!.className.includes("whitespace-pre-wrap"), "la classe whitespace-pre-wrap doit être appliquée pour que le navigateur préserve visuellement ces retours");
  assert.ok(!hoursParagraph!.innerHTML.includes("<br"), "aucun <br> ne doit avoir été injecté manuellement dans le HTML");

  root.unmount();
});

test("UI MULTILINE FIX v1: config.opening_hours mono-ligne -- comportement inchangé (non-régression), pas de whitespace-pre-wrap superflu visible dans le rendu simple", async () => {
  const { container, root } = render(baseRestaurant("07:00 – 23:00"));
  await flush();

  const hoursParagraph = Array.from(container.querySelectorAll("p")).find((p) =>
    p.textContent?.includes("07:00")
  );
  assert.ok(hoursParagraph, "le paragraphe des horaires doit être présent");
  assert.equal(hoursParagraph!.textContent, "Tous les jours : 07:00 – 23:00");
  root.unmount();
});

test("UI MULTILINE FIX v1: aucun opening_hours (null) -- aucune ligne 'Horaires' rendue, comportement inchangé", async () => {
  const { container, root } = render(baseRestaurant(null));
  await flush();
  const labels = Array.from(container.querySelectorAll("p")).map((p) => p.textContent);
  assert.ok(!labels.some((l) => l?.includes("Horaires")), "aucun libellé Horaires ne doit apparaître sans donnée");
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
