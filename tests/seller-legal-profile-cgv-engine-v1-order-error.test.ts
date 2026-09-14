import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCgvAcceptanceRequiredError,
  isCgvNotPublishedError,
  CgvAcceptanceRequiredError,
  CGV_ACCEPTANCE_REQUIRED_CODE,
} from "../lib/services/order-error.ts";

// ====================================================================
// SELLER LEGAL PROFILE + CGV ENGINE v1 -- classification des erreurs
// create_order CGV_ACCEPTANCE_REQUIRED / CGV_REQUIRED_BUT_NOT_PUBLISHED.
// Même discipline que isOrderNoteTooLongError (tests/v65-order-note.test.ts) :
// code ET message exigés ensemble, jamais le SQLSTATE générique seul.
// ====================================================================

test("isCgvAcceptanceRequiredError: reconnaît le couple exact code=P0001 + message=CGV_ACCEPTANCE_REQUIRED", () => {
  assert.equal(isCgvAcceptanceRequiredError({ code: "P0001", message: "CGV_ACCEPTANCE_REQUIRED" }), true);
});

test("isCgvAcceptanceRequiredError: rejette un P0001 générique sans rapport (ne doit PAS être requalifié)", () => {
  assert.equal(isCgvAcceptanceRequiredError({ code: "P0001", message: "Commande vide" }), false);
});

test("isCgvAcceptanceRequiredError: rejette le bon message avec un autre code", () => {
  assert.equal(isCgvAcceptanceRequiredError({ code: "22023", message: "CGV_ACCEPTANCE_REQUIRED" }), false);
});

test("isCgvAcceptanceRequiredError: erreur absente/nulle -> non reconnue", () => {
  assert.equal(isCgvAcceptanceRequiredError(null), false);
  assert.equal(isCgvAcceptanceRequiredError(undefined), false);
});

test("isCgvNotPublishedError: reconnaît le couple exact code=P0001 + message=CGV_REQUIRED_BUT_NOT_PUBLISHED", () => {
  assert.equal(isCgvNotPublishedError({ code: "P0001", message: "CGV_REQUIRED_BUT_NOT_PUBLISHED" }), true);
});

test("isCgvNotPublishedError: rejette un P0001 générique sans rapport", () => {
  assert.equal(isCgvNotPublishedError({ code: "P0001", message: "Article indisponible" }), false);
});

test("CgvAcceptanceRequiredError: expose le code stable comme message d'erreur", () => {
  const e = new CgvAcceptanceRequiredError();
  assert.equal(e.message, CGV_ACCEPTANCE_REQUIRED_CODE);
  assert.equal(e.name, "CgvAcceptanceRequiredError");
});
