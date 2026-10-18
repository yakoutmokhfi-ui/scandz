import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { publicMenuHref } from "../lib/dashboard-nav.ts";
import {
  PUBLIC_MENU_HOST,
  PUBLIC_MENU_URLS,
  publicMenuUrlForSlug,
} from "../lib/public-menu-url.ts";
import nextConfig, { PUBLIC_SLUG_ALIASES } from "../next.config.mjs";
import type { MerchantRestaurant } from "../lib/dashboard-types.ts";

// ====================================================================
// Issue #159 (suite PR #161) — « Voir le menu » et l'URL publique du
// cockpit utilisent l'URL définitive d'Au Lait Cru ; les autres
// marchands gardent /r/{slug} ; /r/au-lait-cru reste servi.
// ====================================================================

const DEFINITIVE = "https://shop.scanym.com/au-lait-cru";

function mapping(restaurantId: string, slug: string): MerchantRestaurant {
  return {
    restaurant_id: restaurantId,
    role: "owner",
    restaurants: { id: restaurantId, name: "Test", slug },
  };
}

test("#159 Voir le menu: Au Lait Cru -> https://shop.scanym.com/au-lait-cru", () => {
  assert.equal(publicMenuHref("r1", [mapping("r1", "au-lait-cru")]), DEFINITIVE);
});

test("#159 Voir le menu: slug Au Lait Cru avec espaces en bordure -> même URL définitive", () => {
  assert.equal(publicMenuHref("r1", [mapping("r1", "  au-lait-cru ")]), DEFINITIVE);
});

test("#159 Voir le menu: autres marchands inchangés (/r/{slug} relatif)", () => {
  assert.equal(publicMenuHref("r1", [mapping("r1", "illico-presto")]), "/r/illico-presto");
  assert.equal(publicMenuHref("r1", [mapping("r1", "sanaa-cookies")]), "/r/sanaa-cookies");
  assert.equal(publicMenuHref("r1", [mapping("r1", "café & co")]), "/r/caf%C3%A9%20%26%20co");
});

test("#159 Voir le menu: l'URL suit l'établissement COURANT quand Au Lait Cru et un autre marchand coexistent", () => {
  const mappings = [mapping("r1", "au-lait-cru"), mapping("r2", "sanaa-cookies")];
  assert.equal(publicMenuHref("r1", mappings), DEFINITIVE);
  assert.equal(publicMenuHref("r2", mappings), "/r/sanaa-cookies");
});

test("#159 Voir le menu: pas d'URL pour mapping absent, restaurants null, slug vide", () => {
  assert.equal(publicMenuHref("r-inconnu", [mapping("r1", "au-lait-cru")]), null);
  assert.equal(publicMenuHref("r1", []), null);
  assert.equal(
    publicMenuHref("r1", [{ restaurant_id: "r1", role: "owner", restaurants: null }]),
    null
  );
  assert.equal(publicMenuHref("r1", [mapping("r1", "  ")]), null);
});

test("#159 cockpit: Au Lait Cru -> URL définitive quelle que soit l'origine du back-office", () => {
  assert.equal(publicMenuUrlForSlug("au-lait-cru", "https://scanym-sanaa.vercel.app"), DEFINITIVE);
  assert.equal(publicMenuUrlForSlug("au-lait-cru", "http://localhost:3000"), DEFINITIVE);
  assert.equal(publicMenuUrlForSlug("au-lait-cru", ""), DEFINITIVE);
});

test("#159 cockpit: autres marchands -> {origin}/r/{slug} comme avant", () => {
  assert.equal(
    publicMenuUrlForSlug("sanaa-cookies", "https://scanym-sanaa.vercel.app"),
    "https://scanym-sanaa.vercel.app/r/sanaa-cookies"
  );
  assert.equal(publicMenuUrlForSlug("illico-presto", ""), "/r/illico-presto");
});

test("#159 helper: entrées vides/invalides -> null ; slugs hérités de Object.prototype ne matchent jamais", () => {
  assert.equal(publicMenuUrlForSlug(null), null);
  assert.equal(publicMenuUrlForSlug(undefined), null);
  assert.equal(publicMenuUrlForSlug(""), null);
  assert.equal(publicMenuUrlForSlug("   "), null);
  assert.equal(publicMenuUrlForSlug("constructor"), "/r/constructor");
  assert.equal(publicMenuUrlForSlug("__proto__"), "/r/__proto__");
  assert.equal(publicMenuUrlForSlug("toString"), "/r/toString");
});

test("#159 la table d'URLs définitives est figée, sur HTTPS, et ne vise que le domaine shop.scanym.com", () => {
  assert.equal(PUBLIC_MENU_HOST, "https://shop.scanym.com");
  assert.ok(Object.isFrozen(PUBLIC_MENU_URLS));
  for (const [slug, url] of Object.entries(PUBLIC_MENU_URLS)) {
    assert.equal(url, `${PUBLIC_MENU_HOST}/${slug}`);
  }
});

test("#159 une seule liste pilote la réécriture ET l'URL du back-office (config/public-slug-aliases.mjs)", () => {
  assert.deepEqual(Object.keys(PUBLIC_MENU_URLS).sort(), [...PUBLIC_SLUG_ALIASES].sort());
  const cfg = readFileSync("next.config.mjs", "utf8");
  assert.ok(cfg.includes('from "./config/public-slug-aliases.mjs"'), "next.config.mjs doit lire la liste partagée");
  assert.ok(!/Object\.freeze\(\[\s*"/.test(cfg), "next.config.mjs ne doit plus redéclarer sa propre liste");
  const lib = readFileSync("lib/public-menu-url.ts", "utf8");
  assert.ok(lib.includes('from "../config/public-slug-aliases.mjs"'));
});

test("#159 garde NO-HARDCODE respecté: aucun nom de marchand dans le code exécutable de lib/public-menu-url.ts", () => {
  const code = readFileSync("lib/public-menu-url.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
  assert.ok(!/au[-_ ]?lait[-_ ]?cru/i.test(code));
});

test("#159 /r/au-lait-cru reste fonctionnel: réécriture /au-lait-cru -> /r/au-lait-cru conservée, handler présent, aucune redirection", async () => {
  const config = nextConfig as { rewrites?: () => Promise<unknown>; redirects?: unknown };
  const rewrites = (await config.rewrites!()) as { source: string; destination: string }[];
  assert.ok(
    rewrites.some((r) => r.source === "/au-lait-cru" && r.destination === "/r/au-lait-cru")
  );
  assert.ok(existsSync("app/r/[slug]/page.tsx"), "le handler /r/[slug] doit exister");
  assert.equal(config.redirects, undefined, "aucune redirection ne doit retirer /r/au-lait-cru");
});

test("#159 composants: aucun slug ni domaine codé en dur dans DashboardNav ; le cockpit passe par le helper partagé", () => {
  const nav = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  assert.ok(!nav.includes("au-lait-cru"));
  assert.ok(!nav.includes("shop.scanym.com"));
  const cockpit = readFileSync("app/admin/establishments/cockpit/page.tsx", "utf8");
  assert.ok(cockpit.includes("publicMenuUrlForSlug(summary.slug, origin)"));
  assert.ok(!cockpit.includes("/r/${summary.slug}"), "plus de construction /r/ en ligne dans le cockpit");
  assert.ok(!cockpit.includes("au-lait-cru"));
  assert.ok(!cockpit.includes("shop.scanym.com"));
});
