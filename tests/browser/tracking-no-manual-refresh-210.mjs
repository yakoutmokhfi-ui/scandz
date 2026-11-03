// Issue #210 -- PREUVE EN VRAI NAVIGATEUR (Chromium via Playwright) que le suivi de
// commande s'affiche dès l'ouverture du lien, sans « Actualiser » manuel, puis suit
// les changements de statut.
//
// Hors `npm test` (qui ne lance que tests/*.test.ts). Prérequis : un build de
// production de l'application démarré avec le faux Supabase local
// (voir tests/browser/README.md), et Playwright résolvable.
//
//   STUB_PORT=54399 APP_URL=http://127.0.0.1:3100 node tests/browser/tracking-no-manual-refresh-210.mjs
//
// Données 100 % synthétiques : aucune commande, aucun paiement, aucun e-mail, aucune
// base réelle, aucun lien privé réel. Code de sortie non nul au moindre écart.
import { createRequire } from "node:module";
import { startStub } from "./stub-supabase.mjs";

const require = createRequire(process.env.PLAYWRIGHT_RESOLVE_FROM || import.meta.url);
const { chromium } = require("playwright");

const APP = process.env.APP_URL || "http://127.0.0.1:3100";
const STUB_PORT = Number(process.env.STUB_PORT || 54399);
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const only = (process.env.ONLY || "").split(",").filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = async (path, body) =>
  (await fetch(STUB + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
const seed = (o = {}) => ctl("/__ctl/seed", { status: "preparing", ...o });
const capLink = (s) => `${APP}/track/${s.orderId}#c1.${s.capabilityId}.${s.secret}`;
const legacyLink = (s) => `${APP}/track/${s.orderId}#${s.legacyToken}`;
const cleanLink = (s) => `${APP}/track/${s.orderId}`;
const secretsOf = (s) => [s.secret, s.capabilityId, s.legacyToken].filter(Boolean);

const text = (page) =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim()).catch(() => "");
async function waitFor(page, pred, timeout) {
  const t = Date.now();
  let last = "";
  while (Date.now() - t < timeout) {
    last = await text(page);
    if (pred(last)) return { ok: true, ms: Date.now() - t, txt: last };
    await sleep(100);
  }
  return { ok: false, ms: Date.now() - t, txt: last };
}
const hasOrder = (n) => (txt) => new RegExp(`#${n}\\b`).test(txt);

/** Observe tout ce que le navigateur envoie à l'application / affiche en console. */
function observe(page) {
  const o = { requests: [], docs: 0, rsc: 0, rscFailed: 0, console: [], errors: [] };
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(APP).origin) return;
    if (r.isNavigationRequest()) o.docs++;
    if (u.search.includes("_rsc=")) o.rsc++;
    o.requests.push({ method: r.method(), url: r.url(), body: r.postData() || "", headers: JSON.stringify(r.headers()) });
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("_rsc=")) o.rscFailed++;
  });
  page.on("console", (m) => o.console.push(m.text()));
  page.on("pageerror", (e) => o.errors.push(String(e.message)));
  return o;
}

/** Aucune capacité / jeton / secret dans une URL, un en-tête, la console, le stockage JS. */
async function assertNoLeak(page, obs, secrets, checks, label) {
  const inUrl = obs.requests.filter((r) => secrets.some((x) => r.url.includes(x) || r.headers.includes(x)));
  checks.push([`${label} : aucune capacité/jeton dans une URL ni un en-tête`, inUrl.length === 0]);
  const outsideExchange = obs.requests.filter((r) => secrets.some((x) => r.body.includes(x)) && !(r.method === "POST" && new URL(r.url).pathname === "/api/track/exchange"));
  checks.push([`${label} : la capacité ne transite que dans le CORPS de POST /api/track/exchange`, outsideExchange.length === 0]);
  checks.push([`${label} : rien dans la console`, !obs.console.some((c) => secrets.some((x) => c.includes(x))) && !obs.errors.some((c) => secrets.some((x) => c.includes(x)))]);
  const storage = await page
    .evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }))
    .catch(() => "");
  checks.push([`${label} : rien dans localStorage / sessionStorage / document.cookie`, !secrets.some((x) => storage.includes(x))]);
  checks.push([`${label} : URL affichée sans fragment`, !page.url().includes("#")]);
}

const results = [];
async function scenario(name, fn) {
  // ONLY=A,E,K filtre par identifiant (premier mot) du scénario.
  if (only.length && !only.includes(name.split(" ")[0])) return;
  const browser = await chromium.launch();
  const checks = [];
  let error = null;
  try {
    await fn(browser, checks);
  } catch (e) {
    error = String(e.message).slice(0, 300);
  } finally {
    await browser.close();
  }
  const failed = checks.filter(([, ok]) => !ok).map(([d]) => d);
  results.push({ name, checks: checks.length, failed, error });
  console.log(`${error || failed.length ? "FAIL" : "PASS"}  ${name}  (${checks.length - failed.length}/${checks.length})${error ? "  ERREUR: " + error : ""}`);
  for (const f of failed) console.log(`        ✗ ${f}`);
}

const stub = await startStub(STUB_PORT);
try {
  // A. Première ouverture depuis un e-mail, AUCUNE session : la commande s'affiche seule.
  await scenario("A première ouverture (lien e-mail, sans session)", async (browser, checks) => {
    const s = await seed({ number: 4242 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const obs = observe(page);
    await page.goto(capLink(s), { waitUntil: "load" });
    const r = await waitFor(page, hasOrder(4242), 3000);
    checks.push(["la commande s'affiche en moins de 3 s, sans clic ni rechargement", r.ok]);
    checks.push(["un seul chargement de document (aucun rechargement)", obs.docs === 1]);
    checks.push(["aucun bouton « Actualiser » nécessaire : la coquille de chargement a disparu", !/Chargement du suivi/.test(r.txt)]);
    const cookies = await ctx.cookies();
    const c = cookies.find((k) => k.name === "st_session");
    checks.push(["cookie de session HttpOnly, SameSite=Lax, limité au chemin de la commande", !!c && c.httpOnly && c.sameSite === "Lax" && c.path === `/track/${s.orderId}`]);
    await assertNoLeak(page, obs, secretsOf(s), checks, "A");
  });

  // B. Réouverture du MÊME lien avec une session existante.
  await scenario("B réouverture avec session (même lien e-mail)", async (browser, checks) => {
    const s = await seed({ number: 4243, status: "accepted" });
    const ctx = await browser.newContext();
    const p1 = await ctx.newPage();
    await p1.goto(capLink(s));
    await waitFor(p1, hasOrder(4243), 5000);
    await p1.close();
    const p2 = await ctx.newPage();
    await p2.goto(capLink(s), { waitUntil: "load" });
    const r = await waitFor(p2, hasOrder(4243), 3000);
    checks.push(["le lien rouvert affiche la commande en moins de 3 s", r.ok]);
    checks.push(["l'état courant est affiché (Commande acceptée)", /accept/i.test(r.txt)]);
  });

  // C. Page laissée ouverte : le statut change côté serveur, la page suit seule.
  await scenario("C statut suivi en page ouverte (sans action)", async (browser, checks) => {
    const s = await seed({ number: 4244, status: "new" });
    const page = await (await browser.newContext()).newPage();
    await page.goto(capLink(s));
    const first = await waitFor(page, hasOrder(4244), 3000);
    checks.push(["affichage initial sans actualisation", first.ok]);
    await ctl("/__ctl/status", { orderId: s.orderId, status: "accepted" });
    const r = await waitFor(page, (t) => /accept/i.test(t), 12000);
    checks.push(["le nouveau statut apparaît sans action de l'utilisateur (≤ 12 s, cadence 5 s)", r.ok]);
    await ctl("/__ctl/status", { orderId: s.orderId, status: "preparing" });
    const r2 = await waitFor(page, (t) => /pr[ée]par/i.test(t), 12000);
    checks.push(["un second changement est aussi suivi", r2.ok]);
  });

  // D. Retour de focus : rafraîchissement immédiat, sans attendre le tic.
  await scenario("D retour de focus", async (browser, checks) => {
    const s = await seed({ number: 4245, status: "new" });
    const page = await (await browser.newContext()).newPage();
    await page.goto(capLink(s));
    await waitFor(page, hasOrder(4245), 3000);
    await sleep(300);
    await ctl("/__ctl/status", { orderId: s.orderId, status: "ready" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const r = await waitFor(page, (t) => /pr[êe]te/i.test(t), 3000);
    checks.push(["le statut est à jour moins de 3 s après le retour de focus", r.ok]);
  });

  // D2. Retour depuis un autre onglet.
  await scenario("D2 retour depuis un autre onglet", async (browser, checks) => {
    const s = await seed({ number: 4246, status: "new" });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(capLink(s));
    await waitFor(page, hasOrder(4246), 3000);
    const other = await ctx.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    await ctl("/__ctl/status", { orderId: s.orderId, status: "accepted" });
    await page.bringToFront();
    const r = await waitFor(page, (t) => /accept/i.test(t), 7000);
    checks.push(["le statut est à jour après retour sur l'onglet", r.ok]);
  });

  // E. Autre appareil (autre contexte navigateur), même lien e-mail réutilisable.
  await scenario("E autre appareil (même lien e-mail)", async (browser, checks) => {
    const s = await seed({ number: 4247 });
    const c1 = await browser.newContext();
    const p1 = await c1.newPage();
    await p1.goto(capLink(s));
    await waitFor(p1, hasOrder(4247), 3000);
    const c2 = await browser.newContext();
    const p2 = await c2.newPage();
    const obs = observe(p2);
    await p2.goto(capLink(s));
    const r = await waitFor(p2, hasOrder(4247), 3000);
    checks.push(["le même lien affiche la commande sur un autre contexte, sans actualisation", r.ok]);
    await assertNoLeak(p2, obs, secretsOf(s), checks, "E");
  });

  // F. Session expirée / supprimée.
  await scenario("F session absente ou expirée", async (browser, checks) => {
    const s = await seed({ number: 4248 });
    const ctx = await browser.newContext();
    const p1 = await ctx.newPage();
    await p1.goto(capLink(s));
    await waitFor(p1, hasOrder(4248), 3000);
    await ctx.clearCookies();
    const p2 = await ctx.newPage();
    await p2.goto(capLink(s));
    const r = await waitFor(p2, hasOrder(4248), 3000);
    checks.push(["lien e-mail rouvert sans cookie : la commande s'affiche (réutilisable)", r.ok]);
    await ctx.clearCookies();
    const p3 = await ctx.newPage();
    await p3.goto(cleanLink(s));
    const g = await waitFor(p3, (t) => /introuvable|valide/i.test(t), 3000);
    checks.push(["chemin propre sans cookie ni fragment : état générique, aucune donnée de commande", g.ok && !/#4248/.test(g.txt)]);
  });

  // G. Retour arrière.
  await scenario("G retour arrière", async (browser, checks) => {
    const s = await seed({ number: 4249 });
    const page = await (await browser.newContext()).newPage();
    await page.goto(capLink(s));
    await waitFor(page, hasOrder(4249), 3000);
    await page.goto(APP + "/robots.txt");
    await page.goBack({ waitUntil: "load" });
    const r = await waitFor(page, hasOrder(4249), 3000);
    checks.push(["après retour arrière la commande est affichée, sans actualisation", r.ok]);
    checks.push(["l'URL du retour arrière ne porte aucun fragment", !page.url().includes("#")]);
  });

  // H. Lien legacy one-shot inchangé.
  await scenario("H lien legacy (one-shot)", async (browser, checks) => {
    const s = await seed({ number: 4250 });
    const page = await (await browser.newContext()).newPage();
    const obs = observe(page);
    await page.goto(legacyLink(s));
    const first = await waitFor(page, hasOrder(4250), 3000);
    checks.push(["première ouverture legacy : la commande s'affiche seule", first.ok]);
    await assertNoLeak(page, obs, secretsOf(s), checks, "H");
    const p2 = await (await browser.newContext()).newPage();
    await p2.goto(legacyLink(s));
    const replay = await waitFor(p2, (t) => /introuvable|valide/i.test(t), 3000);
    checks.push(["rejeu legacy sur un autre contexte : refusé, générique, rien révélé", replay.ok && !/#4250/.test(replay.txt)]);
  });

  // I. Panne puis reprise.
  await scenario("I panne puis reprise automatique", async (browser, checks) => {
    const s = await seed({ number: 4251 });
    const page = await (await browser.newContext()).newPage();
    await page.goto(capLink(s));
    await waitFor(page, hasOrder(4251), 3000);
    await ctl("/__ctl/mode", { fail: true });
    const down = await waitFor(page, (t) => /indisponible/i.test(t), 12000);
    checks.push(["panne : message générique « temporairement indisponible »", down.ok && !/#4251/.test(down.txt)]);
    checks.push(["panne : le repli manuel « Actualiser le suivi » reste proposé", /Actualiser le suivi/.test(down.txt)]);
    await ctl("/__ctl/mode", { fail: false });
    const up = await waitFor(page, hasOrder(4251), 30000);
    checks.push(["reprise automatique sans action quand le service revient (≤ 30 s)", up.ok]);
  });

  // J. États terminaux : le polling s'arrête.
  await scenario("J état terminal : arrêt du polling", async (browser, checks) => {
    const s = await seed({ number: 4252, status: "completed" });
    const page = await (await browser.newContext()).newPage();
    const obs = observe(page);
    await page.goto(capLink(s));
    const r = await waitFor(page, hasOrder(4252), 3000);
    checks.push(["commande terminée affichée", r.ok]);
    await sleep(500);
    const before = obs.rsc;
    await sleep(8000);
    checks.push(["aucune requête de rafraîchissement pendant 8 s en état terminal", obs.rsc === before]);
  });

  // K. Plusieurs commandes dans le même navigateur : cookies isolés.
  await scenario("K deux commandes, isolation des sessions", async (browser, checks) => {
    const a = await seed({ number: 4261 });
    const b = await seed({ number: 4262 });
    const ctx = await browser.newContext();
    const pa = await ctx.newPage();
    await pa.goto(capLink(a));
    const ra = await waitFor(pa, hasOrder(4261), 3000);
    const pb = await ctx.newPage();
    await pb.goto(capLink(b));
    const rb = await waitFor(pb, hasOrder(4262), 3000);
    checks.push(["commande A affichée", ra.ok]);
    checks.push(["commande B affichée dans le même navigateur", rb.ok]);
    const only = await browser.newContext();
    const oa = await only.newPage();
    await oa.goto(capLink(a));
    await waitFor(oa, hasOrder(4261), 3000);
    const ob = await only.newPage();
    await ob.goto(cleanLink(b));
    const g = await waitFor(ob, (t) => /introuvable|valide/i.test(t), 3000);
    checks.push(["la session de A n'ouvre pas B : état générique, rien révélé de B", g.ok && !/#4262/.test(g.txt)]);
  });

  // M. Capacité expirée alors que la page est ouverte : générique, rien révélé.
  await scenario("M capacité expirée en cours de suivi", async (browser, checks) => {
    const s = await seed({ number: 4271 });
    const page = await (await browser.newContext()).newPage();
    await page.goto(capLink(s));
    await waitFor(page, hasOrder(4271), 3000);
    await ctl("/__ctl/expire", { orderId: s.orderId, capabilityId: s.capabilityId });
    const r = await waitFor(page, (t) => /introuvable|valide/i.test(t), 12000);
    checks.push(["capacité expirée : état générique au prochain rafraîchissement", r.ok]);
    checks.push(["capacité expirée : aucune donnée de commande n'est plus affichée", !/#4271/.test(r.txt)]);
  });

  // N. Lien invalide d'emblée (capacité fausse) : générique, sans appel de rendu de commande.
  await scenario("N capacité invalide dès l'ouverture", async (browser, checks) => {
    const s = await seed({ number: 4281 });
    const bad = `${APP}/track/${s.orderId}#c1.${s.capabilityId}.${"0".repeat(64)}`;
    const page = await (await browser.newContext()).newPage();
    await page.goto(bad);
    const r = await waitFor(page, (t) => /introuvable|valide/i.test(t), 3000);
    checks.push(["capacité invalide : état générique, aucune donnée de commande", r.ok && !/#4281/.test(r.txt)]);
  });
} finally {
  await stub.close();
}

const bad = results.filter((r) => r.error || r.failed.length);
console.log(`\n${results.length - bad.length}/${results.length} scénarios verts`);
process.exit(bad.length ? 1 : 0);
