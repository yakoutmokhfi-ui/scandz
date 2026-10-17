import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

// ====================================================================
// ISSUE #159 — URL publique courte /au-lait-cru.
//
// Mécanisme : une réécriture Next.js EXACTE (next.config.mjs) vers le
// handler existant /r/[slug]. Ces tests figent les propriétés qui
// empêchent toute régression :
//   - /au-lait-cru -> /r/au-lait-cru ; /r/au-lait-cru inchangé ;
//   - pas de catch-all : les routes réservées / assets / slugs inconnus
//     ne sont JAMAIS appariés ;
//   - la requête (query string) n'est pas écrasée par la destination ;
//   - aucun middleware, aucune route Monetico / panier / suivi touchée.
// Le comportement HTTP réel (statuts, query string, 404) est vérifié
// séparément contre `next start` (voir le rapport de la PR).
// ====================================================================

const require = createRequire(import.meta.url);
const { match } = require("next/dist/compiled/path-to-regexp") as {
  match: (src: string, opts?: Record<string, unknown>) => (p: string) => unknown;
};

const mod = (await import("../next.config.mjs")) as {
  default: {
    rewrites?: () => Promise<unknown>;
    headers?: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
  };
  PUBLIC_SLUG_ALIASES: readonly string[];
};
const config = mod.default;
type Rewrite = { source: string; destination: string; has?: unknown; missing?: unknown; basePath?: unknown };
const rewrites = (await config.rewrites!()) as Rewrite[];

function matches(path: string): Rewrite | null {
  for (const r of rewrites) {
    if (match(r.source, { decode: decodeURIComponent })(path)) return r;
  }
  return null;
}

test("#159: /au-lait-cru est réécrit vers le handler existant /r/au-lait-cru", () => {
  assert.deepEqual(rewrites, [{ source: "/au-lait-cru", destination: "/r/au-lait-cru" }]);
  assert.deepEqual([...mod.PUBLIC_SLUG_ALIASES], ["au-lait-cru"]);
  assert.equal(matches("/au-lait-cru")?.destination, "/r/au-lait-cru");
});

test("#159: rewrites() est un TABLEAU simple (afterFiles) : une page ou un fichier réel garde la priorité", () => {
  assert.ok(Array.isArray(rewrites), "ni beforeFiles ni fallback");
});

test("#159: le lien historique /r/au-lait-cru n'est PAS capté par la réécriture (aucune redirection, aucun changement)", () => {
  assert.equal(matches("/r/au-lait-cru"), null);
  assert.equal(matches("/r/au-lait-cru/"), null);
  assert.equal(matches("/r/autre-slug"), null);
});

test("#159: la destination ne porte ni query, ni paramètre, ni condition -> la query string du client est transmise intacte", () => {
  for (const r of rewrites) {
    assert.match(r.destination, /^\/r\/[a-z0-9]+(?:-[a-z0-9]+)*$/, "destination = /r/<slug> exact, sans '?'");
    assert.equal(r.has, undefined);
    assert.equal(r.missing, undefined);
  }
});

test("#159: aucune règle générique (pas de catch-all, pas de paramètre, pas de joker)", () => {
  for (const r of rewrites) {
    assert.match(r.source, /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/, `source exacte: ${r.source}`);
    assert.doesNotMatch(r.source, /[:*()[\]?+{}]/);
  }
  assert.equal(rewrites.length, mod.PUBLIC_SLUG_ALIASES.length, "une entrée par alias");
});

test("#159: slugs inconnus, routes réservées et assets statiques ne sont JAMAIS appariés", () => {
  const untouched = [
    "/", "/inconnu", "/au-lait-cru-x", "/xau-lait-cru", "/au-lait-cru/x", "/au-lait-cru/menu",
    "/api", "/api/payments/monetico/callback", "/api/payments/monetico/checkout", "/api/internal/payments/monetico/recover",
    "/api/track/exchange", "/_next/static/chunks/main.js", "/_next/image", "/dashboard", "/dashboard/login",
    "/admin/establishments", "/checkout", "/checkout/success", "/track/abc", "/track/abc/withdrawal", "/legal/cgv",
    "/favicon.ico", "/robots.txt", "/sitemap.xml", "/logo.png", "/.well-known/security.txt",
  ];
  for (const p of untouched) assert.equal(matches(p), null, `${p} ne doit pas être réécrit`);
});

test("#159: aucun alias ne masque une route réservée ni un fichier réel", () => {
  const reserved = new Set(["api", "_next", "dashboard", "admin", "checkout", "track", "legal", "r", "favicon.ico", "robots.txt"]);
  const appDirs = readdirSync(new URL("../app/", import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const slug of mod.PUBLIC_SLUG_ALIASES) {
    assert.ok(!reserved.has(slug), `${slug} est réservé`);
    assert.ok(!appDirs.includes(slug), `app/${slug} existe déjà: la réécriture le masquerait`);
    assert.ok(!existsSync(new URL(`../public/${slug}`, import.meta.url)), `public/${slug} existe déjà`);
  }
});

test("#159: aucun middleware n'est introduit ; le handler /r/[slug] et son 404 existent et sont inchangés dans leur contrat", () => {
  for (const f of ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"]) {
    assert.equal(existsSync(new URL(`../${f}`, import.meta.url)), false, f);
  }
  const page = readFileSync(new URL("../app/r/[slug]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getRestaurantBySlug\(slug\)/);
  assert.match(page, /if \(!restaurant\) \{\s*notFound\(\);/);
  assert.ok(existsSync(new URL("../app/r/[slug]/not-found.tsx", import.meta.url)));
});

test("#159: les en-têtes /track et /api/track existants sont conservés tels quels", async () => {
  const headers = await config.headers!();
  assert.deepEqual(headers.map((h) => h.source), ["/track/:path*", "/api/track/:path*"]);
});

test("#159: aucun code ne dérive l'URL d'un commerçant du chemin /r/ (le slug vient des paramètres de route)", () => {
  const monetico = readFileSync(new URL("../app/api/payments/monetico/checkout/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(monetico, /\/r\//, "le checkout Monetico ne dépend pas du chemin /r/");
  const callback = readFileSync(new URL("../app/api/payments/monetico/callback/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(callback, /\/r\//);
});
