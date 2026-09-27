import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupCitiesForPostalCode,
  cityMatchesCandidates,
  normalizeCityForComparison,
  PostcodeLookupError,
} from "../lib/services/postcode-lookup.ts";
import { getCustomerErrors, EMPTY_CUSTOMER } from "../lib/customer.ts";
import { formatDeliveryCountryScopeMessage } from "../lib/delivery-country-scope-message.ts";
import { translate } from "../lib/i18n.ts";

// ====================================================================
// Scanym — ADDRESS UX v1 — tests unitaires PURS (aucun appel réseau
// réel : fetchImpl injecté, même discipline que
// tests/v98-b5-structured-address-foundation.test.ts pour l'autre
// provider d'adresse).
// ====================================================================

function fakeFetch(status: number, body: unknown) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
}

// --------------------------------------------------------------------
// lookupCitiesForPostalCode
// --------------------------------------------------------------------

test("[postcode-lookup] CP structurellement invalide : aucun appel réseau, tableau vide", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    throw new Error("ne doit jamais être appelé");
  }) as unknown as typeof fetch;
  const result = await lookupCitiesForPostalCode("1234", { fetchImpl });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("[postcode-lookup] un seul CP -> une seule commune", async () => {
  const fetchImpl = fakeFetch(200, [{ nom: "Colombes", code: "92025" }]) as unknown as typeof fetch;
  const result = await lookupCitiesForPostalCode("92700", { fetchImpl });
  assert.deepEqual(result, [{ code: "92025", name: "Colombes" }]);
});

test("[postcode-lookup] CP partagé par plusieurs communes -> toutes retournées", async () => {
  const fetchImpl = fakeFetch(200, [
    { nom: "Paris", code: "75056" },
    { nom: "Paris 1er Arrondissement", code: "75101" },
  ]) as unknown as typeof fetch;
  const result = await lookupCitiesForPostalCode("75001", { fetchImpl });
  assert.equal(result.length, 2);
});

test("[postcode-lookup] 404 (CP inconnu de la source) -> tableau vide, PAS une erreur", async () => {
  const fetchImpl = fakeFetch(404, {}) as unknown as typeof fetch;
  const result = await lookupCitiesForPostalCode("97400", { fetchImpl });
  assert.deepEqual(result, []);
});

test("[postcode-lookup] entrée malformée (champ manquant) ignorée, jamais une exception", async () => {
  const fetchImpl = fakeFetch(200, [
    { nom: "Colombes", code: "92025" },
    { nom: "", code: "92099" },
    { code: "92100" },
    "not-an-object",
  ]) as unknown as typeof fetch;
  const result = await lookupCitiesForPostalCode("92700", { fetchImpl });
  assert.deepEqual(result, [{ code: "92025", name: "Colombes" }]);
});

test("[postcode-lookup] panne HTTP (500) -> PostcodeLookupError, reason http-error", async () => {
  const fetchImpl = fakeFetch(500, {}) as unknown as typeof fetch;
  await assert.rejects(
    () => lookupCitiesForPostalCode("92700", { fetchImpl }),
    (err: unknown) => err instanceof PostcodeLookupError && err.reason === "http-error"
  );
});

test("[postcode-lookup] réponse non-JSON / forme inattendue -> PostcodeLookupError, reason malformed-response", async () => {
  const fetchImpl = fakeFetch(200, { not: "an-array" }) as unknown as typeof fetch;
  await assert.rejects(
    () => lookupCitiesForPostalCode("92700", { fetchImpl }),
    (err: unknown) => err instanceof PostcodeLookupError && err.reason === "malformed-response"
  );
});

test("[postcode-lookup] panne réseau -> PostcodeLookupError, reason network-error", async () => {
  const fetchImpl = (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => lookupCitiesForPostalCode("92700", { fetchImpl }),
    (err: unknown) => err instanceof PostcodeLookupError && err.reason === "network-error"
  );
});

// --------------------------------------------------------------------
// cityMatchesCandidates / normalizeCityForComparison
// --------------------------------------------------------------------

test("[postcode-lookup] comparaison insensible à la casse et aux accents", () => {
  assert.equal(normalizeCityForComparison("Épernay"), normalizeCityForComparison("epernay"));
  assert.equal(normalizeCityForComparison("Saint-Étienne"), normalizeCityForComparison("saint etienne"));
});

test("[postcode-lookup] cityMatchesCandidates : correspondance positive", () => {
  const candidates = [{ code: "1", name: "Colombes" }, { code: "2", name: "Nanterre" }];
  assert.equal(cityMatchesCandidates("colombes", candidates), true);
  assert.equal(cityMatchesCandidates("COLOMBES", candidates), true);
});

test("[postcode-lookup] cityMatchesCandidates : incohérence positivement détectée", () => {
  const candidates = [{ code: "1", name: "Colombes" }];
  assert.equal(cityMatchesCandidates("Marseille", candidates), false);
});

test("[postcode-lookup] cityMatchesCandidates : fail-open sans candidats (null/vide)", () => {
  assert.equal(cityMatchesCandidates("Marseille", null), true);
  assert.equal(cityMatchesCandidates("Marseille", []), true);
});

test("[postcode-lookup] cityMatchesCandidates : champ vide -> pas un cas d'incohérence (erreur 'requis' à part)", () => {
  assert.equal(cityMatchesCandidates("", [{ code: "1", name: "Colombes" }]), true);
});

// --------------------------------------------------------------------
// getCustomerErrors -- intégration de la vérification de cohérence
// CP/ville (ADDRESS UX v1, mission §4)
// --------------------------------------------------------------------

test("[getCustomerErrors] CP 92700 + ville « Marseille » tapée -> erreur bloquante à la soumission", () => {
  const customer = { ...EMPTY_CUSTOMER, postalCode: "92700", city: "Marseille", street: "1 rue Test" };
  const errors = getCustomerErrors(customer, ["city"], {
    cityCandidates: [{ code: "92025", name: "Colombes" }],
  });
  assert.equal(errors.city, "errCityPostalMismatch");
});

test("[getCustomerErrors] CP 92700 + ville « Colombes » -> aucune erreur de cohérence", () => {
  const customer = { ...EMPTY_CUSTOMER, postalCode: "92700", city: "Colombes", street: "1 rue Test" };
  const errors = getCustomerErrors(customer, ["city"], {
    cityCandidates: [{ code: "92025", name: "Colombes" }],
  });
  assert.equal(errors.city, undefined);
});

test("[getCustomerErrors] aucun candidat connu (CP hors périmètre de la source) -> fail-open, aucune erreur", () => {
  const customer = { ...EMPTY_CUSTOMER, postalCode: "97400", city: "Saint-Denis", street: "1 rue Test" };
  const errors = getCustomerErrors(customer, ["city"], { cityCandidates: null });
  assert.equal(errors.city, undefined);
});

test("[getCustomerErrors] comportement historique préservé quand cityCandidates est omis", () => {
  const customer = { ...EMPTY_CUSTOMER, postalCode: "92700", city: "Marseille", street: "1 rue Test" };
  const errors = getCustomerErrors(customer, ["city"]);
  assert.equal(errors.city, undefined, "aucun appelant historique ne doit régresser");
});

// --------------------------------------------------------------------
// formatDeliveryCountryScopeMessage
// --------------------------------------------------------------------

const t = (key: string, params?: Record<string, string | number>) => translate("fr", key, params);
const tEn = (key: string, params?: Record<string, string | number>) => translate("en", key, params);

test("[delivery-country-scope-message] 1 pays -> formulation « uniquement »", () => {
  const msg = formatDeliveryCountryScopeMessage(t, "fr", [{ countryName: "France" }]);
  assert.equal(msg, "Livraison disponible uniquement en France");
});

test("[delivery-country-scope-message] 2 pays -> liste jointe « et »", () => {
  const msg = formatDeliveryCountryScopeMessage(t, "fr", [
    { countryName: "France" },
    { countryName: "Italie" },
  ]);
  assert.equal(msg, "Livraison disponible en France et Italie");
});

test("[delivery-country-scope-message] 3 pays -> liste jointe avec virgules + « et »", () => {
  const msg = formatDeliveryCountryScopeMessage(t, "fr", [
    { countryName: "France" },
    { countryName: "Italie" },
    { countryName: "Belgique" },
  ]);
  assert.equal(msg, "Livraison disponible en France, Italie et Belgique");
});

test("[delivery-country-scope-message] anglais : « and »", () => {
  const msg = formatDeliveryCountryScopeMessage(tEn, "en", [
    { countryName: "France" },
    { countryName: "Italy" },
  ]);
  assert.equal(msg, "Delivery available in France and Italy");
});

test("[delivery-country-scope-message] aucun pays -> null (rien à afficher)", () => {
  assert.equal(formatDeliveryCountryScopeMessage(t, "fr", []), null);
});
