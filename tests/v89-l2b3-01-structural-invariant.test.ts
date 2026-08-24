import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Corrige L2B3-01 (point 7 de la mission) : invariant structurel qui
// échoue si le parcours delivery actif (FulfillmentSelector.tsx,
// MenuView.tsx, lib/use-public-delivery-info.ts) réintroduit
// settings.deliveryAreaLabel / settings.deliveryZones /
// settings.deliveryMinItems comme source de vérité runtime.
//
// Recherche sur le CODE réel uniquement (commentaires/chaînes de
// documentation retirés avant l'analyse) -- jamais contournable en
// citant simplement ces noms dans un commentaire explicatif.
// ====================================================================

const LEGACY_DELIVERY_PATTERNS = [
  "settings.deliveryAreaLabel",
  "settings.deliveryZones",
  "settings.deliveryMinItems",
];

const ACTIVE_DELIVERY_PATH_FILES = [
  "components/FulfillmentSelector.tsx",
  "components/MenuView.tsx",
  "lib/use-public-delivery-info.ts",
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "");
}

for (const file of ACTIVE_DELIVERY_PATH_FILES) {
  test(`L2B3-01 (invariant structurel): ${file} -- aucun des 3 champs legacy (deliveryAreaLabel/deliveryZones/deliveryMinItems) n'est utilisé comme source de vérité runtime`, () => {
    const src = readFileSync(file, "utf8");
    const codeOnly = stripComments(src);
    for (const pattern of LEGACY_DELIVERY_PATTERNS) {
      assert.ok(
        !codeOnly.includes(pattern),
        `${file} contient encore "${pattern}" dans le code réel -- réintroduction interdite du parcours legacy`
      );
    }
  });
}

test("L2B3-01 (invariant structurel, complémentaire) : lib/delivery.ts (getDeliveryStatusFromPublicInfo) ne référence aucun des 3 champs legacy dans sa propre logique", () => {
  const src = readFileSync("lib/delivery.ts", "utf8");
  const codeOnly = stripComments(src);
  const start = codeOnly.indexOf("export function getDeliveryStatusFromPublicInfo");
  const end = codeOnly.indexOf("\n}", start);
  const body = codeOnly.slice(start, end);
  for (const pattern of LEGACY_DELIVERY_PATTERNS) {
    assert.ok(!body.includes(pattern), `getDeliveryStatusFromPublicInfo ne doit jamais référencer "${pattern}"`);
  }
});

test("L2B3-01: RestaurantSettings/restaurants-config.ts peuvent légitimement subsister dans MenuView.tsx et FulfillmentSelector.tsx pour d'AUTRES usages non migrés -- ce test confirme que ces imports restent présents, jamais retirés à tort par une correction trop large", () => {
  const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
  const fulfillmentSrc = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  assert.ok(menuViewSrc.includes("getSettings"), "MenuView.tsx doit toujours lire les autres réglages (thème, options, etc.) via restaurants-config.ts");
  assert.ok(fulfillmentSrc.includes("RestaurantSettings"), "FulfillmentSelector.tsx doit toujours accepter settings en prop, pour ses autres usages (allowedServiceModes)");
});
