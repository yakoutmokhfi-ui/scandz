import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 — lib/tracking/link.ts.
//
// Couvre mandat §7 (lien d'entrée en FRAGMENT, jamais chemin/requête)
// et §30.A/§30.B (jeton absent du chemin ET de la chaîne de requête,
// preuve directe sur la sortie de cette fonction pure -- ferme le
// blocage de publication CTE-V1-TOKEN-LOG-01).
// ====================================================================

const { buildTrackingPath, buildCleanTrackingPath } = await import("../lib/tracking/link.ts");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

test("buildTrackingPath: le jeton apparaît EXCLUSIVEMENT après '#' (fragment), jamais avant", () => {
  const path = buildTrackingPath(ORDER_ID, TOKEN);
  assert.equal(path, `/track/${ORDER_ID}#${TOKEN}`);
  const hashIndex = path.indexOf("#");
  assert.ok(hashIndex > -1, "un fragment doit être présent");
  const beforeHash = path.slice(0, hashIndex);
  const afterHash = path.slice(hashIndex + 1);
  assert.equal(beforeHash.includes(TOKEN), false, "le jeton ne doit JAMAIS apparaître avant '#'");
  assert.equal(afterHash, TOKEN);
});

test("mandat §30.A : le jeton est ABSENT du pathname (tel qu'un navigateur/serveur le calculerait via URL())", () => {
  const path = buildTrackingPath(ORDER_ID, TOKEN);
  const url = new URL(path, "https://example.com");
  assert.equal(url.pathname, `/track/${ORDER_ID}`);
  assert.equal(url.pathname.includes(TOKEN), false);
});

test("mandat §30.B : le jeton est ABSENT de la chaîne de requête (search/searchParams)", () => {
  const path = buildTrackingPath(ORDER_ID, TOKEN);
  const url = new URL(path, "https://example.com");
  assert.equal(url.search, "");
  assert.equal([...url.searchParams.keys()].length, 0);
});

test("buildTrackingPath: le fragment lui-même reste accessible côté navigateur via url.hash", () => {
  const path = buildTrackingPath(ORDER_ID, TOKEN);
  const url = new URL(path, "https://example.com");
  assert.equal(url.hash, `#${TOKEN}`);
});

test("buildTrackingPath: encode les caractères spéciaux éventuels (défense en profondeur, même si un UUID n'en contient jamais)", () => {
  const path = buildTrackingPath("order id/with space", "token#with#hash");
  assert.equal(path.includes(" "), false);
  // Le premier '#' rencontré dans le chemin ENCODÉ doit être celui,
  // unique, séparant le chemin du fragment -- tout '#' présent dans le
  // jeton source doit avoir été encodé en %23 avant d'atteindre cette
  // position, jamais laissé tel quel (qui introduirait un second
  // séparateur de fragment ambigu).
  const firstHash = path.indexOf("#");
  const rest = path.slice(firstHash + 1);
  assert.equal(rest.includes("#"), false, "aucun second '#' ne doit apparaître après le séparateur de fragment");
});

test("buildCleanTrackingPath: chemin SANS AUCUN jeton, ni fragment ni requête", () => {
  const clean = buildCleanTrackingPath(ORDER_ID);
  assert.equal(clean, `/track/${ORDER_ID}`);
  assert.equal(clean.includes("#"), false);
  assert.equal(clean.includes("?"), false);
  assert.equal(clean.includes(TOKEN), false);
});

test("buildCleanTrackingPath: ne prend PAS de paramètre de jeton -- ne peut structurellement pas en produire un (mandat §7/§20)", () => {
  // Vérifie l'arité de la fonction elle-même : un seul paramètre
  // formel (orderId), jamais un second paramètre jeton qu'un appelant
  // pourrait accidentellement fournir.
  assert.equal(buildCleanTrackingPath.length, 1);
});

test("buildTrackingPath et buildCleanTrackingPath : même segment de chemin pour la même commande (le fragment est la SEULE différence)", () => {
  const withToken = buildTrackingPath(ORDER_ID, TOKEN);
  const clean = buildCleanTrackingPath(ORDER_ID);
  const withTokenPathOnly = withToken.split("#")[0];
  assert.equal(withTokenPathOnly, clean);
});
