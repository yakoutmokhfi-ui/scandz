#!/usr/bin/env node
/**
 * UX LOT 2026-10 — PREUVE NAVIGATEUR RÉEL (Chromium via Playwright).
 *
 * Pourquoi : les tests jsdom ne calculent AUCUNE mise en page. Le retour
 * de vérification en production (PR #166) a montré que « justify-center »
 * sur les pastilles produit et le correctif d'OrderHelpButton ne
 * changeaient rien à ce que voit le client : l'élément visé était la
 * rangée COLLECTIONS (CollectionNav) et le vrai « Comment passer
 * commande ? » est le dialogue de DeliveryConditions. Ce script monte les
 * composants RÉELS de la vitrine, avec la feuille de style Tailwind
 * produite par `next build`, dans Chromium, et mesure positions et
 * défilement à trois largeurs (390 / 768 / 1280 px).
 *
 * Prérequis : `next build` exécuté (pour .next/static/css), Playwright +
 * Chromium disponibles (`npx playwright install chromium` ou paquet
 * global). Usage :
 *   node scripts/ux-real-browser-check.mjs [--out <dossier>] [--no-assert]
 * Sortie : JSON des mesures sur stdout, captures PNG dans <dossier>
 * (défaut : .ux-check/), code de sortie 1 si une assertion échoue.
 *
 * Aucun accès réseau : page locale (file://), données synthétiques.
 */
import * as esbuild from "esbuild";
import path from "node:path";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const REPO = process.cwd();
const args = process.argv.slice(2);
const outDir = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : ".ux-check");
const doAssert = !args.includes("--no-assert");
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  try {
    ({ chromium } = require("/opt/npm-tools/node_modules/playwright"));
  } catch {
    console.error("Playwright introuvable : npx playwright install chromium (ou paquet global).");
    process.exit(2);
  }
}

// ---------------------------------------------------------------------
// 1. Page de test : composants RÉELS + CSS de production.
// ---------------------------------------------------------------------
const ENTRY = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import CollectionNav from "@/components/CollectionNav";
import { DeliveryConditionsButton } from "@/components/DeliveryConditions";
import ProductTags from "@/components/ProductTags";
import { I18nProvider } from "@/lib/i18n-context";

const FOUR = ["Bio", "Bretagne", "Pasteurisé", "Truffe"].map((label, i) => ({ id: "c" + i, label, displayOrder: 0, menuItemIds: ["a"] }));
const TWELVE = Array.from({ length: 12 }, (_, i) => ({ id: "m" + i, label: "Collection " + (i + 1), displayOrder: 0, menuItemIds: ["a"] }));
// Quatre règles de livraison avec un texte client LONG (synthétique) :
// le contenu du dialogue dépasse 85dvh sur un téléphone, comme en
// production chez un commerçant à plusieurs zones.
const RULES = Array.from({ length: 4 }, (_, i) => ({
  fulfillmentCode: "rule-" + i, zonePrefixes: ["75"], isFallback: i === 3, minItems: null, displayOrder: i,
  pricingMode: "fixed", fixedFee: 10, freeThreshold: null,
  customerText: "Zone " + (i + 1) + " : " + Array.from({ length: 9 }, (_, k) => "ligne " + (k + 1) + " des conditions de livraison, horaires, délais et remises.").join("\\n"),
  customerTextHash: null, translations: null,
}));

function App() {
  const [active, setActive] = useState(null);
  return (
    <I18nProvider lang="fr" sourceLanguage="fr" activeLanguages={[{ code: "fr", dir: "ltr" }]}>
      <main className="bg-crema text-ink-on-bg">
        <section id="s-nav4" className="mt-3"><CollectionNav collections={FOUR} activeId={active} onSelect={setActive} navLabel="Collections" /></section>
        <section id="s-nav12" className="mt-3"><CollectionNav collections={TWELVE} activeId={null} onSelect={() => {}} navLabel="Collections (débordement)" /></section>
        <section id="s-tags" className="mx-4 mt-3 w-64 rounded-xl border p-3"><p className="text-sm">Produit</p><ProductTags tags={["Bio", "Bretagne", "Pasteurisé", "Truffe", "Fermier"]} label="Tags" /></section>
        <section id="s-help"><DeliveryConditionsButton rules={RULES} currency="EUR" /></section>
      </main>
    </I18nProvider>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

const alias = {
  name: "at-alias",
  setup(b) {
    b.onResolve({ filter: /^@\// }, (a) => {
      const base = path.join(REPO, a.path.slice(2));
      const c = ["", ".tsx", ".ts"].map((e) => base + e).find((p) => existsSync(p));
      return { path: c ?? base };
    });
  },
};
const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: REPO, loader: "tsx" },
  bundle: true, write: false, format: "iife", jsx: "automatic", target: "es2022",
  plugins: [alias], absWorkingDir: REPO, define: { "process.env.NODE_ENV": '"production"' },
});
const cssDir = path.join(REPO, ".next/static/css");
if (!existsSync(cssDir)) {
  console.error("CSS de production absent : lancez d'abord `next build`.");
  process.exit(2);
}
const css = readdirSync(cssDir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(path.join(cssDir, f), "utf8")).join("\n");
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-crema"><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const htmlPath = path.join(outDir, "harness.html");
writeFileSync(htmlPath, html);

// ---------------------------------------------------------------------
// 2. Mesures Chromium.
// ---------------------------------------------------------------------
const browser = await chromium.launch();
const results = {};
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

for (const [width, height] of [[390, 740], [768, 900], [1280, 900]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => failures.push(`pageerror@${width}: ${e.message}`));
  await page.goto("file://" + htmlPath);
  await page.waitForSelector("[data-customer-collections-nav]");

  const rows = await page.evaluate(() => {
    const row = (nav) => {
      const ul = nav.querySelector("ul"); const lis = [...ul.querySelectorAll("li")];
      const u = ul.getBoundingClientRect(); const n = nav.getBoundingClientRect();
      const f = lis[0].getBoundingClientRect(); const l = lis[lis.length - 1].getBoundingClientRect();
      // Marges mesurées par rapport au conteneur de navigation (padding exclu).
      const cs = getComputedStyle(nav); const padL = parseFloat(cs.paddingLeft); const padR = parseFloat(cs.paddingRight);
      return {
        leftGap: +(f.left - (n.left + padL)).toFixed(2), rightGap: +((n.right - padR) - l.right).toFixed(2),
        overflow: ul.scrollWidth > ul.clientWidth + 1, scrollLeft: ul.scrollLeft, ulWidth: +u.width.toFixed(1), firstVisible: f.left >= n.left - 0.5,
      };
    };
    const [n4, n12] = [...document.querySelectorAll("[data-customer-collections-nav]")];
    const tags = document.querySelector("[data-product-tags]"); const tr = tags.getBoundingClientRect();
    const byRow = {}; for (const li of tags.querySelectorAll("li")) { const r = li.getBoundingClientRect(); (byRow[Math.round(r.top)] ??= []).push(r); }
    const tagRows = Object.values(byRow).map((rs) => ({ leftGap: +(Math.min(...rs.map((r) => r.left)) - tr.left).toFixed(2), rightGap: +(tr.right - Math.max(...rs.map((r) => r.right))).toFixed(2), n: rs.length }));
    return { nav4: row(n4), nav12: row(n12), tagRows };
  });

  await page.screenshot({ path: path.join(outDir, `${width}-page.png`), clip: { x: 0, y: 0, width, height: Math.min(height, 360) } });

  await page.click("#s-help button");
  await page.waitForTimeout(200);
  const help = await page.evaluate(() => {
    const d = document.querySelector('dialog[data-delivery-dialog="conditions"]');
    const dr = d.getBoundingClientRect(); const h2 = d.querySelector("h2"); const hr = h2.getBoundingClientRect();
    const close = [...d.querySelectorAll("button")].pop(); const cr = close.getBoundingClientRect();
    const ae = document.activeElement;
    return {
      open: d.open, scrollTop: d.scrollTop, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight,
      overflow: d.scrollHeight > d.clientHeight + 1,
      titleVisible: hr.top >= dr.top - 0.5 && hr.bottom <= dr.bottom + 0.5,
      closeVisible: cr.top >= dr.top - 0.5 && cr.bottom <= dr.bottom + 0.5,
      activeElement: ae === h2 ? "title" : ae === close ? "close" : ae === d ? "dialog" : ae?.tagName ?? null,
    };
  });
  await page.screenshot({ path: path.join(outDir, `${width}-help-dialog.png`) });
  await page.close();

  results[width] = { ...rows, help };

  // Assertions (après correctif) :
  // - rangée de 4 collections : tient dans la largeur -> centrée (marges égales à 1 px près) ;
  // - rangée de 12 : déborde -> première pastille visible à gauche, défilement à 0 (jamais tronquée) ;
  // - pastilles produit : chaque ligne centrée ;
  // - dialogue : contenu débordant sur 390 px, mais titre visible, scrollTop 0, focus sur le titre.
  check(!rows.nav4.overflow && Math.abs(rows.nav4.leftGap - rows.nav4.rightGap) <= 1 && rows.nav4.leftGap > 0, `nav4@${width} non centrée : ${JSON.stringify(rows.nav4)}`);
  check(rows.nav12.overflow ? (rows.nav12.firstVisible && rows.nav12.scrollLeft === 0) : Math.abs(rows.nav12.leftGap - rows.nav12.rightGap) <= 1, `nav12@${width} : ${JSON.stringify(rows.nav12)}`);
  for (const r of rows.tagRows) check(Math.abs(r.leftGap - r.rightGap) <= 1, `tags@${width} ligne non centrée : ${JSON.stringify(r)}`);
  check(help.open && help.scrollTop === 0 && help.titleVisible && help.activeElement === "title", `dialogue@${width} : ${JSON.stringify(help)}`);
  if (width === 390) check(help.overflow, `dialogue@390 : le contenu de test devrait déborder (preuve non concluante sinon) : ${JSON.stringify(help)}`);
}
await browser.close();

console.log(JSON.stringify(results, null, 1));
if (doAssert && failures.length) {
  console.error("ÉCHECS :\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log(doAssert ? "OK : toutes les assertions navigateur réel passent." : "(assertions désactivées)");
