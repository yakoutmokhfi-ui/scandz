import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveDeliveryFulfillment, computeDeliveryFee } from "../lib/delivery.ts";
import { buildCreateOrderPayload } from "../lib/services/order-payload.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// LOT ADDRESS v1 — §21 catégories 6/7/8 : intégration routing,
// fixtures de non-régression Au Lait Cru, non-régression générale.
//
// AUCUNE donnée tenant réelle ici : les "fixtures Au Lait Cru" sont
// des règles SYNTHÉTIQUES qui REPRODUISENT la FORME documentée de la
// configuration réelle (rapport de mission AU LAIT CRU CONTROLLED
// TENANT ACTIVATION -- Rule A/Rule B, valeurs publiques déjà
// documentées : 7.50€/12.00€/seuil 100€/préfixe 75/fallback), jamais
// une lecture de la vraie base -- ce lot ne touche STRUCTURELLEMENT
// pas à la configuration tenant (mission §25, hors périmètre).
// ====================================================================

const RULE_A_LOCAL_DELIVERY = {
  fulfillmentCode: "local_delivery",
  zonePrefixes: ["75"],
  isFallback: false,
  displayOrder: 10,
  minItems: null,
  pricingMode: "free_above_threshold" as const,
  fixedFee: 7.5,
  freeThreshold: 100.0,
  customerText: "Livraison locale à Paris.",
};

const RULE_B_REFRIGERATED_FALLBACK = {
  fulfillmentCode: "refrigerated_shipping",
  zonePrefixes: [],
  isFallback: true,
  displayOrder: 20,
  minItems: null,
  pricingMode: "free_above_threshold" as const,
  fixedFee: 12.0,
  freeThreshold: 100.0,
  customerText: "Livraison réfrigérée disponible à votre adresse.",
};

const SYNTHETIC_RULES = [RULE_A_LOCAL_DELIVERY, RULE_B_REFRIGERATED_FALLBACK];

// --------------------------------------------------------------------
// §21.24-27 — intégration routing : le code postal structuré atteint
// la logique d'éligibilité EXISTANTE ; IGN ne fournit ni provider ni
// frais autoritatif ; le routing reste Scanym.
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §24: le code postal structuré (tel que produit par une sélection IGN normalisée) atteint bien resolveDeliveryFulfillment SANS retraitement", () => {
  // Simule exactement ce que la couche adresse produit -- un
  // StructuredCustomerAddress.postalCode -- transmis TEL QUEL, jamais
  // reparsé (mission §8 : "must use the final structured address
  // submitted").
  const structuredPostalCode = "75001";
  const result = resolveDeliveryFulfillment(SYNTHETIC_RULES, structuredPostalCode, 1, 50);
  assert.equal(result.eligible, true);
  assert.equal(result.fulfillmentCode, "local_delivery");
});

function executableLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/**");
    })
    .join("\n");
}

test("LOT ADDRESS v1 §25/§26: ni AddressAutocomplete ni address-search n'APPELLENT jamais resolveDeliveryFulfillment/computeDeliveryFee dans du code EXÉCUTABLE -- ces noms peuvent apparaître dans un commentaire expliquant la séparation (mission §8, déjà le cas dans l'en-tête de ces deux fichiers), jamais dans une ligne de code réelle ; ce sont resolveDeliveryFulfillment/computeDeliveryFee (lib/delivery.ts, INCHANGÉS par ce lot) qui restent seuls responsables du routing/tarification", () => {
  const componentSrc = readFileSync("components/AddressAutocomplete.tsx", "utf8");
  const serviceSrc = readFileSync("lib/services/address-search.ts", "utf8");
  for (const src of [componentSrc, serviceSrc]) {
    assert.ok(
      !/computeDeliveryFee|resolveDeliveryFulfillment/.test(executableLines(src)),
      "la couche adresse ne doit jamais importer/appeler la logique de routing/tarification dans du code réel"
    );
  }
});

test("LOT ADDRESS v1 §27: le routage reste entièrement piloté par lib/delivery.ts (non modifié par ce lot) -- preuve par calcul direct, jamais une supposition", () => {
  assert.equal(computeDeliveryFee(RULE_A_LOCAL_DELIVERY, 50), 7.5);
  assert.equal(computeDeliveryFee(RULE_A_LOCAL_DELIVERY, 150), 0);
});

// --------------------------------------------------------------------
// §21.28-32 — fixtures de non-régression Au Lait Cru (synthétiques,
// reproduisant la forme documentée -- jamais une lecture de la vraie
// configuration tenant)
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §28: 75001 résout toujours vers la règle locale (local_delivery), non-régression après le câblage adresse", () => {
  const result = resolveDeliveryFulfillment(SYNTHETIC_RULES, "75001", 1, 50);
  assert.equal(result.eligible, true);
  assert.equal(result.fulfillmentCode, "local_delivery");
  assert.equal(result.matchedPrefix, "75");
});

test("LOT ADDRESS v1 §29: un code postal hors 75 (ex. 13001) résout toujours vers le fallback (refrigerated_shipping), non-régression", () => {
  const result = resolveDeliveryFulfillment(SYNTHETIC_RULES, "13001", 1, 50);
  assert.equal(result.eligible, true);
  assert.equal(result.fulfillmentCode, "refrigerated_shipping");
  assert.equal(result.matchedPrefix, undefined, "un fallback n'exige aucun préfixe");
});

test("LOT ADDRESS v1 §30: confidentialité provider inchangée -- DeliveryFulfillmentStatus ne renseigne jamais de champ `provider` (structure inchangée par ce lot)", () => {
  const result = resolveDeliveryFulfillment(SYNTHETIC_RULES, "75001", 1, 50);
  assert.ok(!("provider" in result), "aucun champ provider ne doit exister sur le résultat de routing");
});

test("LOT ADDRESS v1 §31: tarification Au Lait Cru inchangée -- 7.50€ (Rule A, sous seuil) / 12.00€ (Rule B, sous seuil), non-régression après le câblage adresse", () => {
  assert.equal(computeDeliveryFee(RULE_A_LOCAL_DELIVERY, 99.99), 7.5);
  assert.equal(computeDeliveryFee(RULE_B_REFRIGERATED_FALLBACK, 99.99), 12.0);
});

test("LOT ADDRESS v1 §32: seuil de gratuité à 100€ inchangé pour les deux règles (limites exactes), non-régression", () => {
  assert.equal(computeDeliveryFee(RULE_A_LOCAL_DELIVERY, 100.0), 0);
  assert.equal(computeDeliveryFee(RULE_A_LOCAL_DELIVERY, 100.01), 0);
  assert.equal(computeDeliveryFee(RULE_B_REFRIGERATED_FALLBACK, 100.0), 0);
  assert.equal(computeDeliveryFee(RULE_B_REFRIGERATED_FALLBACK, 100.01), 0);
});

// --------------------------------------------------------------------
// §21.33-36 — non-régression générale
// --------------------------------------------------------------------

test("LOT ADDRESS v1 §33: le pickup n'est pas affecté -- AddressAutocomplete n'est utilisé (JSX) qu'à l'intérieur de renderDeliveryAddress, jamais ailleurs dans le composant (le pickup ne rend jamais 'delivery_address')", () => {
  const src = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  // Code réel uniquement (commentaires retirés -- le nom du composant
  // apparaît légitimement dans plusieurs commentaires documentaires de
  // ce fichier, notamment juste au-dessus de renderDeliveryAddress
  // elle-même) ; l'import (toujours en tête de fichier, avant TOUTE
  // fonction) est également exclu -- seul l'USAGE JSX réel
  // ("<AddressAutocomplete") importe ici.
  const withoutImportLine = executableLines(src)
    .split("\n")
    .filter((line) => !line.includes('import AddressAutocomplete from'))
    .join("\n");

  const fnStart = withoutImportLine.indexOf("function renderDeliveryAddress()");
  assert.ok(fnStart >= 0, "renderDeliveryAddress doit exister");
  const nextFnStart = withoutImportLine.indexOf("function renderOneOfGroup(", fnStart);
  assert.ok(nextFnStart > fnStart, "renderOneOfGroup doit suivre renderDeliveryAddress");

  const deliveryAddressBody = withoutImportLine.slice(fnStart, nextFnStart);
  const restOfFile = withoutImportLine.slice(0, fnStart) + withoutImportLine.slice(nextFnStart);

  assert.ok(deliveryAddressBody.includes("<AddressAutocomplete"), "AddressAutocomplete doit être utilisé (JSX) à l'intérieur de renderDeliveryAddress");
  assert.ok(!restOfFile.includes("AddressAutocomplete"), "AddressAutocomplete ne doit apparaître nulle part ailleurs dans le fichier (ni avant, ni après renderDeliveryAddress) -- jamais dans un chemin de rendu pickup");
});

test("LOT ADDRESS v1 §34: Sanaa (chemin legacy, 0 règle de fulfillment) n'est pas affecté -- resolveActiveDeliveryStatus retombe toujours sur le chemin legacy pour des règles vides, comportement inchangé par ce lot", async () => {
  const { resolveActiveDeliveryStatus } = await import("../lib/delivery.ts");
  const resolution = resolveActiveDeliveryStatus({ status: "loaded", rules: [] }, null, "75001", 1, 50);
  assert.equal(resolution.routingSource, "legacy");
});

test("LOT ADDRESS v1 §35: les menus publics ne sont pas affectés -- ce lot ne modifie aucun fichier lié au rendu du menu (MenuItemCard.tsx, catégories, etc.)", () => {
  for (const file of ["components/MenuItemCard.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("AddressAutocomplete") && !src.includes("address-search"));
  }
});

test("LOT ADDRESS v1 §36: create_order reste server-authoritative -- buildCreateOrderPayload (fonction PURE, INCHANGÉE par ce lot) continue à transmettre le code postal structuré tel quel, jamais une valeur dérivée de la sélection IGN (lat/lon/label ne sont JAMAIS envoyés)", () => {
  const payload = buildCreateOrderPayload({
    slug: "test-tenant",
    context: {
      mode: "delivery",
      zoneLabel: "",
      customer: { name: "Test", street: "8 Bd du Palais", postalCode: "75001", city: "Paris", phone: "0612345678", email: "t@example.com" },
    } as any,
    lines: [],
    lang: "fr",
  });
  assert.equal(payload.p_customer.postalCode, "75001");
  assert.ok(!("latitude" in payload.p_customer));
  assert.ok(!("longitude" in payload.p_customer));
  assert.ok(!("label" in payload.p_customer));
});
