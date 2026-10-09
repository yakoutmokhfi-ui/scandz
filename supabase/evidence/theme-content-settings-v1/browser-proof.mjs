// THEME & CONTENT SETTINGS v1 -- étape 2 de la preuve navigateur.
// Compile le CSS RÉEL (Tailwind + app/globals.css) sur le balisage produit par
// render-markup.mjs, le charge dans Chromium et mesure les styles CALCULÉS.
//
//   node supabase/evidence/theme-content-settings-v1/browser-proof.mjs <markupDir> <outDir>
// Prérequis : playwright (NODE_PATH ou /opt/node-tools), Chromium (PLAYWRIGHT_BROWSERS_PATH / executablePath).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const markupDir = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3] ?? markupDir);
mkdirSync(outDir, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
for (const base of [process.env.PLAYWRIGHT_MODULE, "/opt/node-tools/node_modules/playwright", "playwright"].filter(Boolean)) {
  try { ({ chromium } = require(base)); break; } catch { /* essai suivant */ }
}
if (!chromium) throw new Error("playwright introuvable");

const css = path.join(outDir, "storefront.css");
execFileSync("npx", ["tailwindcss", "-c", "tailwind.config.ts", "-i", "app/globals.css", "-o", css, "--content", path.join(markupDir, "*.html")], { stdio: "pipe" });

const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const browser = await chromium.launch({ executablePath: exe });
const SEL = {
  page_container: "#proof-root [dir]",
  info_panel: '[data-sc-surface="info-panel"]',
  info_panel_label: '[data-sc-surface="info-panel"] span.uppercase',
  info_panel_value: '[data-sc-surface="info-panel"] span.text-xs',
  info_panel_icon: '[data-sc-surface="info-panel"] span[aria-hidden]',
  info_panel_divider: '[data-sc-surface="info-panel"] > div > :nth-child(2)',
  product_popup: 'dialog[data-sc-surface="popup"]:not([data-order-help-dialog])',
  product_popup_text: 'dialog[data-sc-surface="popup"]:not([data-order-help-dialog]) p',
  product_popup_close: 'dialog[data-sc-surface="popup"]:not([data-order-help-dialog]) button',
  order_help_popup: "dialog[data-order-help-dialog]",
  order_help_title: "dialog[data-order-help-dialog] h2",
  delivery_dialog: 'dialog[data-delivery-dialog="conditions"]',
  delivery_card: "[data-delivery-rule-card]",
  delivery_card_title: "[data-delivery-rule-card] h3",
};
const PROPS = ["backgroundColor", "color", "borderTopColor", "borderColor"];
const result = {};
for (const variant of ["default", "configured"]) {
  const page = await browser.newPage({ viewport: { width: 420, height: 1400 } });
  const html = readFileSync(path.join(markupDir, `${variant}.html`), "utf8");
  await page.setContent(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>${readFileSync(css, "utf8")}</style></head><body>${html}</body></html>`);
  result[variant] = await page.evaluate(([sel, props]) => {
    const out = {};
    for (const [name, s] of Object.entries(sel)) {
      const el = document.querySelector(s);
      if (!el) { out[name] = null; continue; }
      const cs = getComputedStyle(el);
      out[name] = Object.fromEntries(props.map((p) => [p, cs[p]]));
    }
    return out;
  }, [SEL, PROPS]);
  // En production MenuView pose aussi --sc-bg sur <html> : on reproduit ce fond de page.
  await page.evaluate(() => {
    const root = document.querySelector("#proof-root [dir]");
    document.body.style.margin = "0";
    document.body.style.background = getComputedStyle(root).getPropertyValue("--sc-bg");
  });
  await page.screenshot({ path: path.join(outDir, `${variant}-page.png`), fullPage: true });
  // Chaque fenêtre est ouverte EN MODAL (top layer), une à la fois, comme pour un visiteur.
  for (const [name, sel] of [["product-popup", SEL.product_popup], ["order-help-popup", SEL.order_help_popup], ["delivery-popup", SEL.delivery_dialog]]) {
    await page.evaluate((s) => document.querySelector(s).showModal(), sel);
    await page.screenshot({ path: path.join(outDir, `${variant}-${name}.png`) });
    await page.evaluate((s) => document.querySelector(s).close(), sel);
  }
  await page.close();
}
await browser.close();
writeFileSync(path.join(outDir, "computed-styles.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 1));
