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

/**
 * Corrige ALC-SM-03 (audit Work, LOW, AU LAIT CRU CASE 1) : la
 * seconde assertion de ce test affirmait "FulfillmentSelector.tsx
 * doit toujours accepter settings en prop, pour ses autres usages
 * (allowedServiceModes)" et vérifiait `fulfillmentSrc.includes("RestaurantSettings")`
 * -- SANS retirer les commentaires au préalable (contrairement à
 * toutes les autres recherches "code réel" de ce fichier, qui
 * utilisent systématiquement `stripComments`). Cette assertion
 * continuait donc à PASSER après AU LAIT CRU CASE 1 (voir
 * components/FulfillmentSelector.tsx, section "AU LAIT CRU (sale
 * modes)"), alors que `settings`/`RestaurantSettings` n'est plus DU
 * TOUT une prop acceptée par ce composant depuis ce lot (remplacée
 * par `deliveryModeAvailable`, un booléen dérivé de la liste RÉELLE
 * des modes activés) -- uniquement parce que la chaîne
 * "RestaurantSettings" survit dans un COMMENTAIRE documentaire (ligne
 * ~136 du fichier), jamais dans du code réel. Un faux positif
 * classique : l'assertion protégeait un invariant qui n'est plus
 * pertinent, et son implémentation (recherche sur la source brute,
 * pas le code) l'a laissé passer silencieusement au lieu d'échouer.
 *
 * Décision : l'invariant original ("ne pas retirer settings à tort
 * par une correction trop large") n'a plus lieu d'être -- le retrait
 * de `settings` par AU LAIT CRU CASE 1 est délibéré, documenté, et
 * son remplacement (`deliveryModeAvailable`) est lui-même dérivé de
 * la liste réelle des modes, jamais d'un raccourci. L'assertion est
 * donc REMPLACÉE (pas simplement supprimée) par l'invariant ACTUEL :
 * `settings`/`RestaurantSettings` doit avoir ENTIÈREMENT disparu du
 * CODE réel (comments exclus, comme partout ailleurs dans ce fichier)
 * de FulfillmentSelector.tsx, et `deliveryModeAvailable` doit être
 * effectivement présent comme mécanisme de remplacement -- pour que
 * toute réintroduction future de `settings` comme prop (régression)
 * fasse à nouveau échouer ce test, plutôt que de passer à tort.
 */
test("L2B3-01: MenuView.tsx continue de lire les AUTRES réglages (thème, options...) via restaurants-config.ts, non migrés par ce lot", () => {
  const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
  assert.ok(menuViewSrc.includes("getSettings"), "MenuView.tsx doit toujours lire les autres réglages (thème, options, etc.) via restaurants-config.ts");
});

test("ALC-SM-03: FulfillmentSelector.tsx n'accepte plus `settings`/RestaurantSettings en prop (code réel, commentaires exclus) -- remplacé par `deliveryModeAvailable`, dérivé de la liste réelle des modes (AU LAIT CRU CASE 1)", () => {
  const fulfillmentSrc = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  const fulfillmentCodeOnly = stripComments(fulfillmentSrc);

  assert.ok(
    !fulfillmentCodeOnly.includes("RestaurantSettings"),
    "FulfillmentSelector.tsx ne doit plus référencer RestaurantSettings dans le code réel -- settings n'est plus une prop acceptée depuis AU LAIT CRU CASE 1"
  );
  assert.ok(
    !/\bsettings\s*:/.test(fulfillmentCodeOnly),
    "FulfillmentSelector.tsx ne doit plus déclarer de prop `settings` dans le code réel"
  );
  assert.ok(
    fulfillmentCodeOnly.includes("deliveryModeAvailable"),
    "FulfillmentSelector.tsx doit utiliser deliveryModeAvailable (dérivé de la liste réelle des modes activés) pour son message d'éligibilité livraison, plus jamais settings.allowedServiceModes"
  );
});
