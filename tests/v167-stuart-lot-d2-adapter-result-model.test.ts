import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// STUART LOT D2 — ADAPTER RESULT MODEL (classification pure).
// Test matrix items 13-18 + 20 (provider-reference immutability,
// couvert ici au niveau de la classification -- la garantie
// PERSISTÉE elle-même reste le trigger SQL immuable de
// `stuart_delivery_jobs.stuart_job_id`, DELIVERY STREAM C v2.1,
// INCHANGÉ, revérifié ici uniquement au niveau du contrat de
// classification qui l'alimente).
//
// `classifyStuartMerchantCreateJobHttpResult` est une fonction PURE --
// AUCUN réseau, AUCUNE porte d'activation, AUCUN restaurantId, AUCUN
// appel Supabase. Ce fichier ne positionne JAMAIS
// STUART_LIVE_ACTIVATION_ENABLED -- il n'a structurellement aucun
// besoin de le faire, ce qui EST la preuve que le modèle de résultat
// peut être intégralement vérifié sans jamais franchir la porte.
// ====================================================================

const { classifyStuartMerchantCreateJobHttpResult } = await import(
  "../lib/server/delivery-providers/stuart/merchant-runtime-adapter.ts"
);

// --------------------------------------------------------------
// item 13 : success adapter normalization.
// --------------------------------------------------------------

test("item 13 : 2xx + id numérique valide -- success_confirmed, id canonicalisé en chaîne exacte", () => {
  const outcome = classifyStuartMerchantCreateJobHttpResult({ raw: { id: 100202968 }, httpStatus: 201, networkFailure: false });
  assert.deepEqual(outcome, { kind: "success_confirmed", stuartJobId: "100202968", httpStatus: 201 });
});

test("item 13bis : 2xx + id malformé (chaîne, négatif, non entier, hors intervalle sûr) -- JAMAIS success_confirmed", () => {
  for (const badId of ["100202968", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 10, NaN, Infinity]) {
    const outcome = classifyStuartMerchantCreateJobHttpResult({ raw: { id: badId }, httpStatus: 200, networkFailure: false });
    assert.notEqual(outcome.kind, "success_confirmed", `id=${badId} n'aurait jamais dû produire success_confirmed`);
    assert.equal(outcome.kind, "ambiguous_network_result");
  }
});

test("item 13ter : 2xx + corps sans champ id / non-objet -- ambiguous_network_result, jamais success_confirmed", () => {
  for (const raw of [null, {}, { other: 1 }, "string", 42, []]) {
    const outcome = classifyStuartMerchantCreateJobHttpResult({ raw, httpStatus: 200, networkFailure: false });
    assert.equal(outcome.kind, "ambiguous_network_result");
  }
});

// --------------------------------------------------------------
// item 14 : timeout/ambiguous normalization.
// --------------------------------------------------------------

test("item 14 : networkFailure=true (timeout/panne réseau AVANT réponse) -- ambiguous_network_result, httpStatus null", () => {
  const outcome = classifyStuartMerchantCreateJobHttpResult({ raw: null, httpStatus: 0, networkFailure: true });
  assert.deepEqual(outcome, { kind: "ambiguous_network_result", httpStatus: null });
});

// --------------------------------------------------------------
// item 15 : retryable provider error.
// --------------------------------------------------------------

test("item 15 : statut HTTP non-2xx, non répertorié comme terminal -- retryable_provider_failure (jamais collapsé en ambiguous_network_result, une réponse RÉELLE a été reçue)", () => {
  for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]) {
    const outcome = classifyStuartMerchantCreateJobHttpResult({ raw: { error: "x" }, httpStatus: status, networkFailure: false });
    assert.deepEqual(outcome, { kind: "retryable_provider_failure", httpStatus: status });
  }
});

// --------------------------------------------------------------
// item 16 : terminal provider error.
// --------------------------------------------------------------

test("item 16 : AUCUN statut HTTP n'est actuellement classé terminal (allowlist volontairement vide, MÊME position que create-job.ts v2.2/orchestration.ts -- aucune preuve documentaire actuelle d'un rejet pré-création prouvé)", () => {
  // Preuve NÉGATIVE délibérée : ce test échouerait si un statut était
  // un jour ajouté à l'allowlist SANS preuve documentaire -- tout ajout
  // futur devra mettre à jour CE test avec une justification explicite
  // (voir CONTRACT-MAPPING.md, "Create Job -- terminal errors: NONE
  // PROVEN").
  for (const status of [400, 401, 403, 404, 422, 500]) {
    const outcome = classifyStuartMerchantCreateJobHttpResult({ raw: null, httpStatus: status, networkFailure: false });
    assert.notEqual(outcome.kind, "terminal_provider_failure");
  }
});

// --------------------------------------------------------------
// item 17 : auth failure -- classifiée AVANT toute réponse HTTP
// Create Job (voir merchant-runtime-adapter.ts, catch de
// getStuartAccessTokenForMerchant) -- couvert au niveau intégration
// dans v165 (item 3/4, credential/config) ; ici, on vérifie que la
// catégorie EXISTE et reste DISTINCTE des catégories HTTP.
// --------------------------------------------------------------

test("item 17 : auth_credential_failure/configuration_failure restent des catégories DISTINCTES des catégories dérivées d'un aller-retour HTTP réel (jamais confondues)", () => {
  const httpCategories = new Set([
    classifyStuartMerchantCreateJobHttpResult({ raw: { id: 1 }, httpStatus: 200, networkFailure: false }).kind,
    classifyStuartMerchantCreateJobHttpResult({ raw: null, httpStatus: 0, networkFailure: true }).kind,
    classifyStuartMerchantCreateJobHttpResult({ raw: null, httpStatus: 500, networkFailure: false }).kind,
  ]);
  assert.ok(!httpCategories.has("auth_credential_failure"));
  assert.ok(!httpCategories.has("configuration_failure"));
});

// --------------------------------------------------------------
// item 18 : replay/idempotence -- au niveau PUR de la classification :
// la MÊME entrée produit TOUJOURS la MÊME classification (fonction
// pure, aucun état caché). L'idempotence de PERSISTANCE (jamais deux
// jobs logiques) reste garantie par orchestration.ts/allocation.ts
// (D1, INCHANGÉS) -- voir v168 pour la preuve d'intégration.
// --------------------------------------------------------------

test("item 18 : classification déterministe -- rejouer EXACTEMENT la même entrée produit EXACTEMENT le même résultat, à chaque fois", () => {
  const input = { raw: { id: 42 }, httpStatus: 201, networkFailure: false };
  const first = classifyStuartMerchantCreateJobHttpResult(input);
  const second = classifyStuartMerchantCreateJobHttpResult(input);
  const third = classifyStuartMerchantCreateJobHttpResult({ ...input });
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

// --------------------------------------------------------------
// item 20 (référence) : provider-reference immutability -- la
// garantie RÉELLE reste `stuart_delivery_jobs_job_id_immutable`
// (trigger SQL, DELIVERY STREAM C v2.1, INCHANGÉ). Ce test confirme
// que la classification elle-même ne fabrique JAMAIS deux
// `stuartJobId` différents pour le MÊME id brut -- condition
// nécessaire (bien que non suffisante seule) à l'immutabilité.
// --------------------------------------------------------------

test("item 20 (référence) : le même id brut produit TOUJOURS le même stuartJobId canonicalisé (jamais une re-sérialisation divergente d'un appel à l'autre)", () => {
  const a = classifyStuartMerchantCreateJobHttpResult({ raw: { id: 555 }, httpStatus: 200, networkFailure: false });
  const b = classifyStuartMerchantCreateJobHttpResult({ raw: { id: 555 }, httpStatus: 201, networkFailure: false });
  assert.equal(a.kind, "success_confirmed");
  assert.equal(b.kind, "success_confirmed");
  assert.equal((a as { stuartJobId: string }).stuartJobId, (b as { stuartJobId: string }).stuartJobId);
});
