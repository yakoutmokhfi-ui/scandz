import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { publicMenuHref } from "../lib/dashboard-nav.ts";
import type { MerchantRestaurant } from "../lib/dashboard-types.ts";
import { translate } from "../lib/i18n.ts";

// ====================================================================
// Sous-lot B — bouton "Voir le menu" dans la navigation dashboard.
//
// L'URL cible doit être dérivée de l'établissement courant (jamais
// codée en dur) et ne jamais produire /r/undefined ou /r/null quand
// aucun slug valide n'est disponible : c'est la logique testée ici,
// extraite en fonction pure (lib/dashboard-nav.ts) pour être
// vérifiable sans avoir à monter un contexte App Router complet
// (usePathname/useRouter, qui n'existent pas hors du runtime Next.js
// et rendraient un test DOM disproportionné pour une dérivation
// d'URL aussi simple).
// ====================================================================

function mappingWithSlug(restaurantId: string, slug: string): MerchantRestaurant {
  return {
    restaurant_id: restaurantId,
    role: "owner",
    restaurants: { id: restaurantId, name: "Test", slug },
  };
}

function mappingWithoutRestaurant(restaurantId: string): MerchantRestaurant {
  return { restaurant_id: restaurantId, role: "owner", restaurants: null };
}

test("bouton voir le menu: slug valide -> lien /r/{slug} correct", () => {
  const mappings = [mappingWithSlug("r1", "illico-presto")];
  assert.equal(publicMenuHref("r1", mappings), "/r/illico-presto");
});

test("bouton voir le menu: plusieurs établissements -> l'URL suit l'établissement COURANT, pas le premier de la liste", () => {
  const mappings = [
    mappingWithSlug("r1", "illico-presto"),
    mappingWithSlug("r2", "sanaa-cookies"),
  ];
  assert.equal(publicMenuHref("r2", mappings), "/r/sanaa-cookies");
  assert.equal(publicMenuHref("r1", mappings), "/r/illico-presto");
});

test("bouton voir le menu: aucun mapping pour l'établissement courant -> pas d'URL", () => {
  const mappings = [mappingWithSlug("r1", "illico-presto")];
  assert.equal(publicMenuHref("r-inconnu", mappings), null);
});

test("bouton voir le menu: aucun mapping du tout -> pas d'URL", () => {
  assert.equal(publicMenuHref("r1", []), null);
});

test("bouton voir le menu: restaurants absent (null) -> pas d'URL", () => {
  const mappings = [mappingWithoutRestaurant("r1")];
  assert.equal(publicMenuHref("r1", mappings), null);
});

test("bouton voir le menu: slug vide ou uniquement des espaces -> pas d'URL, jamais /r/ tout court", () => {
  assert.equal(publicMenuHref("r1", [mappingWithSlug("r1", "")]), null);
  assert.equal(publicMenuHref("r1", [mappingWithSlug("r1", "   ")]), null);
});

test("bouton voir le menu: espaces en bordure retirés (normalisation) avant construction de l'URL", () => {
  assert.equal(publicMenuHref("r1", [mappingWithSlug("r1", "  illico-presto  ")]), "/r/illico-presto");
});

test("bouton voir le menu: slug avec caractère spécial -> encodé dans l'URL (defense en profondeur)", () => {
  // Les slugs réels (illico-presto, sanaa-cookies) ne contiennent
  // aucun caractère nécessitant un encodage : ce test vérifie que le
  // mécanisme agit bien quand un caractère qui en aurait besoin est
  // présent, pas seulement qu'il est absent des cas actuels.
  assert.equal(publicMenuHref("r1", [mappingWithSlug("r1", "café & co")]), "/r/caf%C3%A9%20%26%20co");
});

test("bouton voir le menu: tirets, chiffres et lettres des slugs réels ne sont jamais altérés par l'encodage", () => {
  assert.equal(publicMenuHref("r1", [mappingWithSlug("r1", "illico-presto")]), "/r/illico-presto");
  assert.equal(publicMenuHref("r1", [mappingWithSlug("r1", "sanaa-cookies")]), "/r/sanaa-cookies");
});

test("bouton voir le menu: aucune URL générée ne contient jamais 'undefined' ou 'null'", () => {
  const cases: MerchantRestaurant[][] = [
    [],
    [mappingWithoutRestaurant("r1")],
    [mappingWithSlug("r1", "")],
  ];
  for (const mappings of cases) {
    const result = publicMenuHref("r1", mappings);
    if (result !== null) {
      assert.ok(!result.includes("undefined"), `URL invalide générée : ${result}`);
      assert.ok(!result.includes("null"), `URL invalide générée : ${result}`);
    }
  }
});

test("bouton voir le menu: DashboardNav dérive le lien de mappings/restaurantId, jamais d'URL codée en dur", () => {
  const source = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  assert.ok(
    source.includes("getPublicMenuHref(restaurantId, mappings)") ||
      source.includes("publicMenuHref(restaurantId, mappings)"),
    "le lien doit être dérivé de l'établissement courant via mappings, pas codé en dur"
  );
  assert.ok(
    !/\/r\/[a-z0-9-]+["'`]/.test(source.replace(/publicMenuHref/g, "")),
    "aucun slug ni chemin /r/... codé en dur ne doit apparaître dans le composant"
  );
});

test("bouton voir le menu: masqué proprement (pas rendu) quand aucun slug valide n'est disponible", () => {
  const source = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  assert.ok(
    /\{publicMenuHref\s*&&\s*\(/.test(source),
    "le lien doit être conditionné à la présence d'un publicMenuHref valide (rendu nul sinon), pas désactivé visuellement via un nouveau mécanisme"
  );
});

test("bouton voir le menu: ouvre dans un nouvel onglet, sans exposer window.opener", () => {
  const source = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  const linkBlock = source.slice(
    source.indexOf("{publicMenuHref &&"),
    source.indexOf("{children}")
  );
  assert.ok(linkBlock.includes('target="_blank"'), "doit s'ouvrir dans un nouvel onglet");
  assert.ok(
    linkBlock.includes('rel="noopener noreferrer"'),
    "doit couper la référence à window.opener (bonne pratique target=_blank)"
  );
});

test("bouton voir le menu: aucune régression sur la navigation dashboard existante (onglets, sélecteur, déconnexion)", () => {
  const source = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  // Les trois onglets et le sélecteur d'établissement, déjà présents
  // avant ce sous-lot, doivent rester intacts.
  assert.ok(source.includes('t("dsOrders")'));
  assert.ok(source.includes('t("mcTitle")'));
  assert.ok(source.includes('t("mcSettings")'));
  assert.ok(source.includes("onSelectRestaurant(e.target.value)"));
  assert.ok(source.includes('t("dsLogout")'));
  // href() (navigation entre onglets, conserve ?r=<id>) inchangée.
  assert.ok(source.includes('restaurantId ? `${base}?r=${restaurantId}` : base'));
});

test("bouton voir le menu: clé i18n dsViewMenu présente et distincte dans fr/en/ar", () => {
  const fr = translate("fr", "dsViewMenu");
  const en = translate("en", "dsViewMenu");
  const ar = translate("ar", "dsViewMenu");
  assert.equal(fr, "Voir le menu");
  assert.ok(en.length > 0 && en !== "dsViewMenu");
  assert.ok(ar.length > 0 && ar !== "dsViewMenu");
  assert.notEqual(fr, en);
});
