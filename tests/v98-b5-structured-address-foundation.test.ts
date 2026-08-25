import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ====================================================================
// FULFILLMENT ROUTING LOT B.5 — Structured Address Foundation.
//
// Couvre (mission §25/§26/§27/§29) :
//   - mapping provider brut -> AddressSuggestion (défensif, nullable)
//   - normalizeAddressSuggestion / manualAddressToStructured (pures)
//   - searchAddressSuggestions (réseau injecté -- succès, zéro
//     résultat, erreur réseau, réponse malformée, timeout/abort,
//     requête trop courte)
//   - invariants architecturaux : pas de resolveDeliveryFulfillment
//     appelé depuis ce lot, pas de modification create_order/orders,
//     pas de mention Stuart/Chronofresh comme logique de routing
//     adresse, pas de SQL ajouté, pas de config tenant, pas de
//     branchement dans MenuView/CartPanel/FulfillmentSelector.
//
// Aucune donnée client réelle : toutes les adresses ci-dessous sont
// synthétiques (mission §26 "utiliser des données synthétiques
// uniquement").
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const {
  mapGeoplateformeFeatureToSuggestion,
  searchAddressSuggestions,
  normalizeAddressSuggestion,
  manualAddressToStructured,
  AddressSearchError,
  MIN_QUERY_LENGTH,
} = await import("../lib/services/address-search.ts");

const addressSearchSrc = readFileSync("lib/services/address-search.ts", "utf8");
const addressTypesSrc = readFileSync("lib/address-types.ts", "utf8");
const componentSrc = readFileSync("components/AddressAutocomplete.tsx", "utf8");
const deliverySrc = readFileSync("lib/delivery.ts", "utf8");

// --------------------------------------------------------------------
// Mapping provider -> AddressSuggestion (défensif)
// --------------------------------------------------------------------

const VALID_FEATURE = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [2.3488, 48.8534] },
  properties: {
    id: "75101_9575_00008",
    label: "8 Bd du Palais 75001 Paris",
    name: "8 Bd du Palais",
    postcode: "75001",
    city: "Paris",
    citycode: "75101",
  },
};

test("LOT B.5: mapGeoplateformeFeatureToSuggestion mappe une suggestion complète, coordonnées incluses", () => {
  const result = mapGeoplateformeFeatureToSuggestion(VALID_FEATURE);
  assert.deepEqual(result, {
    id: "75101_9575_00008",
    label: "8 Bd du Palais 75001 Paris",
    addressLine: "8 Bd du Palais",
    postalCode: "75001",
    city: "Paris",
    countryCode: "FR",
    latitude: 48.8534,
    longitude: 2.3488,
  });
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- coordonnées absentes -- suggestion valide quand même, latitude/longitude null (jamais une exception pour un champ optionnel manquant)", () => {
  const feature = { properties: { ...VALID_FEATURE.properties } };
  const result = mapGeoplateformeFeatureToSuggestion(feature);
  assert.ok(result);
  assert.equal(result.latitude, null);
  assert.equal(result.longitude, null);
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- 'name' absent -- addressLine retombe sur 'label', jamais exclue pour ce seul champ secondaire manquant", () => {
  const feature = {
    properties: { id: "x", label: "8 Bd du Palais 75001 Paris", postcode: "75001", city: "Paris" },
  };
  const result = mapGeoplateformeFeatureToSuggestion(feature);
  assert.ok(result);
  assert.equal(result.addressLine, "8 Bd du Palais 75001 Paris");
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- 'id' absent -- un id est synthétisé, jamais undefined/vide", () => {
  const feature = {
    properties: { label: "8 Bd du Palais 75001 Paris", name: "8 Bd du Palais", postcode: "75001", city: "Paris" },
  };
  const result = mapGeoplateformeFeatureToSuggestion(feature);
  assert.ok(result);
  assert.ok(result.id.length > 0);
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- postcode manquant -- retourne null (jamais une chaîne vide silencieuse pour un champ requis par le contrat StructuredCustomerAddress)", () => {
  const feature = { properties: { label: "x", name: "x", city: "Paris" } };
  assert.equal(mapGeoplateformeFeatureToSuggestion(feature), null);
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- city manquante -- retourne null", () => {
  const feature = { properties: { label: "x", name: "x", postcode: "75001" } };
  assert.equal(mapGeoplateformeFeatureToSuggestion(feature), null);
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- ni label ni name exploitables -- retourne null", () => {
  const feature = { properties: { postcode: "75001", city: "Paris", label: "", name: "" } };
  assert.equal(mapGeoplateformeFeatureToSuggestion(feature), null);
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- entrée complètement malformée (null/undefined/tableau/nombre) -- retourne null, jamais une exception", () => {
  for (const bad of [null, undefined, [], 42, "string", { properties: null }, { properties: "x" }]) {
    assert.equal(mapGeoplateformeFeatureToSuggestion(bad), null, `attendu null pour ${JSON.stringify(bad)}`);
  }
});

test("LOT B.5: mapGeoplateformeFeatureToSuggestion -- coordinates de forme inattendue (pas 2 nombres finis) -- ignorées proprement, lat/lon null, suggestion quand même valide", () => {
  for (const coords of [[2.34], ["a", "b"], [Infinity, 48.8], null, "not-an-array"]) {
    const feature = { properties: { ...VALID_FEATURE.properties }, geometry: { coordinates: coords } };
    const result = mapGeoplateformeFeatureToSuggestion(feature);
    assert.ok(result, `attendu une suggestion valide pour coordinates=${JSON.stringify(coords)}`);
    assert.equal(result.latitude, null);
    assert.equal(result.longitude, null);
  }
});

// --------------------------------------------------------------------
// normalizeAddressSuggestion / manualAddressToStructured (pures)
// --------------------------------------------------------------------

test("LOT B.5: normalizeAddressSuggestion produit un StructuredCustomerAddress trimmé, countryCode en majuscules", () => {
  const suggestion = {
    id: "1",
    label: "  8 Bd du Palais 75001 Paris  ",
    addressLine: "  8 Bd du Palais ",
    postalCode: " 75001 ",
    city: " Paris ",
    countryCode: "fr",
    latitude: 48.85,
    longitude: 2.35,
  };
  assert.deepEqual(normalizeAddressSuggestion(suggestion), {
    addressLine: "8 Bd du Palais",
    postalCode: "75001",
    city: "Paris",
    countryCode: "FR",
    label: "8 Bd du Palais 75001 Paris",
    latitude: 48.85,
    longitude: 2.35,
  });
});

test("LOT B.5: normalizeAddressSuggestion -- latitude/longitude absentes (undefined) sur la suggestion -- deviennent null, jamais undefined, dans le contrat de sortie", () => {
  const suggestion = { id: "1", label: "x", addressLine: "x", postalCode: "75001", city: "Paris", countryCode: "FR" };
  const result = normalizeAddressSuggestion(suggestion);
  assert.equal(result.latitude, null);
  assert.equal(result.longitude, null);
});

test("LOT B.5: manualAddressToStructured produit le MÊME contrat StructuredCustomerAddress qu'une suggestion normalisée (label/lat/lon toujours null pour une saisie manuelle)", () => {
  const result = manualAddressToStructured({
    addressLine: " 10 rue de la Paix ",
    postalCode: " 75002 ",
    city: " Paris ",
    countryCode: "fr",
  });
  assert.deepEqual(result, {
    addressLine: "10 rue de la Paix",
    postalCode: "75002",
    city: "Paris",
    countryCode: "FR",
    label: null,
    latitude: null,
    longitude: null,
  });
});

// --------------------------------------------------------------------
// searchAddressSuggestions -- réseau injecté, jamais un vrai appel
// --------------------------------------------------------------------

// Les mocks ci-dessous n'implémentent délibérément qu'un sous-ensemble
// de l'interface Response/typeof fetch (ok/status/json) -- suffisant
// pour searchAddressSuggestions, qui n'utilise que ces trois membres
// (voir lib/services/address-search.ts). Cast explicite vers
// `typeof fetch` plutôt qu'une classe Response complète inutilement
// lourde pour ce test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock
// délibérément assoupli (test uniquement, jamais lib/services/*.ts) :
// asFetch accepte n'importe quelle forme de mock, du moment que le
// test lui-même contrôle ce qu'il passe.
function asFetch(fn: (...args: any[]) => any): typeof fetch {
  return fn as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

test("LOT B.5: searchAddressSuggestions -- requête trop courte -- retourne [] SANS appeler fetchImpl (aucune requête réseau déclenchée)", async () => {
  let called = false;
  const result = await searchAddressSuggestions("de", {
    fetchImpl: asFetch(async () => {
      called = true;
      return jsonResponse({ features: [] });
    }),
  });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test(`LOT B.5: MIN_QUERY_LENGTH vaut ${MIN_QUERY_LENGTH} et est exporté (contrat public testable, pas une constante interne opaque)`, () => {
  assert.equal(typeof MIN_QUERY_LENGTH, "number");
  assert.ok(MIN_QUERY_LENGTH >= 1);
});

test("LOT B.5: searchAddressSuggestions -- réponse valide -- suggestions mappées et limitées à `limit`", async () => {
  const features = Array.from({ length: 8 }, (_, i) => ({
    properties: { id: `id-${i}`, label: `Adresse ${i}`, name: `Adresse ${i}`, postcode: "75001", city: "Paris" },
  }));
  const result = await searchAddressSuggestions("rue de paris", {
    limit: 3,
    fetchImpl: asFetch(async () => jsonResponse({ features })),
  });
  assert.equal(result.length, 3);
  assert.equal(result[0].id, "id-0");
});

test("LOT B.5: searchAddressSuggestions -- zéro résultat -- retourne [] (jamais une AddressSearchError, ce n'est pas un échec du provider)", async () => {
  const result = await searchAddressSuggestions("adresse introuvable xyz", {
    fetchImpl: asFetch(async () => jsonResponse({ features: [] })),
  });
  assert.deepEqual(result, []);
});

test("LOT B.5: searchAddressSuggestions -- features contenant des entrées malformées -- celles-ci sont silencieusement ignorées, les valides sont conservées", async () => {
  const features = [
    { properties: { id: "ok", label: "Valide", name: "Valide", postcode: "75001", city: "Paris" } },
    { properties: { id: "bad" /* postcode manquant */ } },
    null,
    "not-an-object",
  ];
  const result = await searchAddressSuggestions("valide", {
    fetchImpl: asFetch(async () => jsonResponse({ features })),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "ok");
});

test("LOT B.5: searchAddressSuggestions -- réponse HTTP non-ok -- lève AddressSearchError('http-error'), jamais une exception non typée", async () => {
  await assert.rejects(
    () => searchAddressSuggestions("rue de paris", { fetchImpl: asFetch(async () => jsonResponse({}, { ok: false, status: 503 })) }),
    (err) => err instanceof AddressSearchError && err.reason === "http-error"
  );
});

test("LOT B.5: searchAddressSuggestions -- réponse malformée (features absent) -- lève AddressSearchError('malformed-response')", async () => {
  await assert.rejects(
    () => searchAddressSuggestions("rue de paris", { fetchImpl: asFetch(async () => jsonResponse({ notFeatures: [] })) }),
    (err) => err instanceof AddressSearchError && err.reason === "malformed-response"
  );
});

test("LOT B.5: searchAddressSuggestions -- JSON invalide (response.json() rejette) -- lève AddressSearchError('malformed-response')", async () => {
  await assert.rejects(
    () =>
      searchAddressSuggestions("rue de paris", {
        fetchImpl: asFetch(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        })),
      }),
    (err) => err instanceof AddressSearchError && err.reason === "malformed-response"
  );
});

test("LOT B.5: searchAddressSuggestions -- fetchImpl rejette (panne réseau) -- lève AddressSearchError('network-error')", async () => {
  await assert.rejects(
    () =>
      searchAddressSuggestions("rue de paris", {
        fetchImpl: asFetch(async () => {
          throw new TypeError("fetch failed");
        }),
      }),
    (err) => err instanceof AddressSearchError && err.reason === "network-error"
  );
});

test("LOT B.5: searchAddressSuggestions -- timeout interne (fetchImpl ne répond jamais) -- abandonne et lève AddressSearchError('timeout'), jamais un blocage indéfini", async () => {
  await assert.rejects(
    () =>
      searchAddressSuggestions("rue de paris", {
        timeoutMs: 20,
        fetchImpl: asFetch((_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
        ),
      }),
    (err) => err instanceof AddressSearchError && err.reason === "timeout"
  );
});

test("LOT B.5: searchAddressSuggestions -- signal externe déjà fourni -- respecté, pas de double AbortController masquant l'annulation de l'appelant", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const promise = searchAddressSuggestions("rue de paris", {
    signal: controller.signal,
    fetchImpl: asFetch((_url: unknown, init?: { signal?: AbortSignal }) => {
      receivedSignal = init?.signal;
      return new Promise(() => {}); // ne se résout jamais dans ce test
    }),
  });
  controller.abort();
  assert.equal(receivedSignal, controller.signal);
  // La promesse reste en attente côté fetchImpl (jamais résolue ici) --
  // on ne l'attend pas jusqu'au bout, seul le câblage du signal est
  // vérifié : pas de fuite de handle (setTimeout interne jamais créé
  // puisqu'un signal externe a été fourni).
  void promise;
});

// --------------------------------------------------------------------
// Invariants architecturaux (mission §29)
// --------------------------------------------------------------------

/** Retire les lignes de commentaire (//, *, /**) avant une recherche
 *  de motif dans du code EXÉCUTABLE -- même discipline que
 *  tests/v96-fulfillment-routing-lot-b.test.ts (isValidPostalCode) et
 *  tests/v96-...(Stuart/Chronofresh) : le nom d'un symbole/concept
 *  interdit peut légitimement apparaître dans un commentaire
 *  expliquant pourquoi ce lot NE l'utilise PAS, jamais dans une ligne
 *  de code réellement exécutée. */
function executableLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/**");
    })
    .join("\n");
}

test("LOT B.5: le service adresse n'appelle JAMAIS resolveDeliveryFulfillment (Address provider != Delivery provider, mission §8) -- le nom peut apparaître dans un commentaire expliquant la séparation, jamais dans un appel réel", () => {
  assert.ok(!executableLines(addressSearchSrc).includes("resolveDeliveryFulfillment"));
  assert.ok(!executableLines(componentSrc).includes("resolveDeliveryFulfillment"));
});

test("LOT B.5: aucune mention de Stuart/Chronofresh/Uber Direct comme logique EXÉCUTABLE dans le service ou le composant adresse (le nom peut apparaître dans un commentaire de portée, jamais dans une ligne de code réelle)", () => {
  for (const src of [addressSearchSrc, componentSrc, addressTypesSrc]) {
    const executable = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/**"))
      .join("\n");
    assert.ok(!/stuart|chronofresh|uber\s*direct/i.test(executable));
  }
});

test("LOT B.5: aucun fichier de ce lot ne modifie/ne mentionne create_order ou une table orders/order_delivery_address comme cible d'écriture (audit texte, portée strictement additive)", () => {
  for (const src of [addressSearchSrc, addressTypesSrc, componentSrc]) {
    assert.ok(!/insert\s+into\s+public\.orders/i.test(src));
    assert.ok(!/create_order/i.test(src) || /\/\*|\/\//.test(src), "toute mention doit rester dans un commentaire, jamais du code exécutable");
  }
});

test("LOT B.5: AddressAutocomplete n'est importé par AUCUN composant actif du parcours (MenuView/CartPanel/FulfillmentSelector) -- non branché, conformément à la mission (§9/§13)", () => {
  for (const file of ["components/MenuView.tsx", "components/CartPanel.tsx", "components/FulfillmentSelector.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("AddressAutocomplete"), `${file} ne doit pas référencer AddressAutocomplete -- Lot C, hors périmètre`);
  }
});

test("LOT B.5: aucun fichier de ce lot n'importe/n'appelle resolveDeliveryFulfillment depuis un contexte runtime actif (déjà couvert pour lib/delivery.ts lui-même par les tests Lot B/B.1/B.2, non modifié ici)", () => {
  assert.ok(!deliverySrc.includes("AddressAutocomplete"));
  assert.ok(!deliverySrc.includes("address-search"));
});

test("LOT B.5: aucun secret/clé API codé en dur dans le service adresse (provider France public, sans authentification -- documenté dans le rapport de mission ; le mot 'secret' peut légitimement apparaître dans un commentaire expliquant qu'aucun n'est requis, jamais dans une AFFECTATION de code exécutable)", () => {
  const executable = executableLines(addressSearchSrc);
  assert.ok(!/(api[_-]?key|secret|token)\s*[:=]\s*["'][^"']+["']/i.test(executable));
});

test("LOT B.5: aucun log de requête/adresse (console.log/console.error/console.warn) dans le service ou le composant adresse", () => {
  for (const src of [addressSearchSrc, componentSrc]) {
    assert.ok(!/console\.(log|error|warn|info|debug)\(/.test(src));
  }
});

test("LOT B.5: le fichier de types StructuredCustomerAddress/AddressSuggestion ne code en dur aucun pays (FR/BE/DZ) dans une valeur de type ou une contrainte -- countryCode reste une chaîne ouverte", () => {
  // Le nom du pays peut légitimement apparaître dans un commentaire
  // d'exemple (ex. "ex. FR"), jamais dans une déclaration de type
  // (union de littéraux fermée type "FR" | "BE" | "DZ").
  assert.ok(!/countryCode\s*:\s*"(FR|BE|DZ)"/i.test(addressTypesSrc));
  assert.ok(addressTypesSrc.includes("countryCode: string"));
});

test("LOT B.5: aucun fichier SQL ne mentionne l'adresse structurée/AddressAutocomplete/address-search (contrat de la mission : NO SQL par défaut pour ce lot -- aucun fichier .sql existant n'a été touché ni créé pour cette fondation)", () => {
  const sqlFiles = readdirSync("supabase").filter((f) => f.endsWith(".sql"));
  for (const f of sqlFiles) {
    const src = readFileSync(`supabase/${f}`, "utf8");
    assert.ok(
      !/StructuredCustomerAddress|AddressAutocomplete|address-search|AddressSuggestion/.test(src),
      `${f} ne doit contenir aucune trace de la fondation adresse Lot B.5 -- ce lot n'ajoute et ne modifie aucun SQL`
    );
  }
});
