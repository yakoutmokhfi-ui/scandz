import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveLangFromParam, translate, DICTS } from "../lib/i18n.ts";

// ====================================================================
// Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "FR/EN/AR
// i18n").
//
// CORRECTIF couvert ici : `app/track/[orderId]/page.tsx::resolveLang`
// ne pouvait auparavant renvoyer que "en" ou "fr"
// (`value === "en" ? "en" : "fr"`), rendant `?lang=ar` STRUCTURELLEMENT
// inatteignable alors même que le dictionnaire `ar` existe déjà avec
// une parité complète de clés (tests/v64-auth-whatsapp.test.ts).
// `resolveLangFromParam` (lib/i18n.ts) est désormais la SEULE autorité
// -- réutilisée par la page de suivi ET par les pages de retour de
// paiement (app/checkout/return/{ok,err}/page.tsx).
// ====================================================================

test("resolveLangFromParam : « ar » est désormais ATTEIGNABLE (bug corrigé -- l'ancienne implémentation le repliait silencieusement sur « fr »)", () => {
  assert.equal(resolveLangFromParam("ar"), "ar");
});

test("resolveLangFromParam : « en » reste atteignable (non-régression)", () => {
  assert.equal(resolveLangFromParam("en"), "en");
});

test("resolveLangFromParam : « fr » reste atteignable (non-régression)", () => {
  assert.equal(resolveLangFromParam("fr"), "fr");
});

test("resolveLangFromParam : valeur absente (undefined) -- repli français, jamais une erreur", () => {
  assert.equal(resolveLangFromParam(undefined), "fr");
});

test("resolveLangFromParam : valeur inconnue (« xx ») -- repli français, jamais une erreur ni une langue inventée", () => {
  assert.equal(resolveLangFromParam("xx"), "fr");
});

test("resolveLangFromParam : searchParams.lang sous forme de tableau (Next.js) -- seul le premier élément est considéré", () => {
  assert.equal(resolveLangFromParam(["ar", "en"]), "ar");
});

test("resolveLangFromParam : tableau vide -- repli français, jamais une erreur (value devient undefined)", () => {
  assert.equal(resolveLangFromParam([]), "fr");
});

test("resolveLangFromParam dérive EXACTEMENT de DICTS (aucune seconde liste dupliquée qui pourrait diverger) : toute clé de DICTS est atteignable", () => {
  for (const lang of Object.keys(DICTS)) {
    assert.equal(resolveLangFromParam(lang), lang);
  }
});

test("translate(« ar », « trackingPageTitle ») renvoie bien le texte arabe -- prouve que la page de suivi peut désormais RÉELLEMENT afficher l'arabe une fois la langue résolue", () => {
  assert.equal(translate("ar", "trackingPageTitle"), "تتبّع الطلب");
});

// ====================================================================
// CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 -- remédiation
// CCTF-V1-LANG-PROTOTYPE-MEMBERSHIP-01 (Cat Woman, audit indépendant,
// LOW). L'implémentation testait `value in DICTS`, qui parcourt la
// CHAÎNE DE PROTOTYPES entière (`Object.prototype`), pas seulement les
// propriétés PROPRES de `DICTS` -- acceptant donc à tort des clés
// héritées ("toString", "constructor", "__proto__", etc.) comme si
// elles étaient des langues réellement prises en charge. Corrigé par
// `Object.prototype.hasOwnProperty.call(DICTS, value)`. Les 5 tests
// ci-dessous sont EXACTEMENT ceux exigés par le mandat v1.1 (items
// "toString rejected"/"constructor rejected"/"__proto__ rejected"/
// "arbitrary unsupported value rejected"/"fr/en/ar accepted").
// ====================================================================

test("mandat v1.1 « toString rejected » : « toString » (clé héritée d'Object.prototype) est rejeté -- repli français, JAMAIS traité comme une langue valide", () => {
  assert.equal(resolveLangFromParam("toString"), "fr");
});

test("mandat v1.1 « constructor rejected » : « constructor » (clé héritée d'Object.prototype) est rejeté -- repli français", () => {
  assert.equal(resolveLangFromParam("constructor"), "fr");
});

test("mandat v1.1 « __proto__ rejected » : « __proto__ » est rejeté -- repli français, jamais interprété comme un accès au prototype ni comme une langue valide", () => {
  assert.equal(resolveLangFromParam("__proto__"), "fr");
});

test("mandat v1.1 « __proto__ rejected » : DICTS lui-même reste un objet ORDINAIRE après ce correctif -- son propre prototype n'a pas été altéré par un appel antérieur", () => {
  // Garde supplémentaire, au-delà de la seule valeur de retour : prouve
  // que la fonction ne mute JAMAIS `DICTS` ni son prototype, même
  // lorsqu'on lui passe littéralement "__proto__" comme entrée.
  assert.equal(Object.getPrototypeOf(DICTS), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(DICTS, "__proto__"), false);
});

test("mandat v1.1 « arbitrary unsupported value rejected » : « hasOwnProperty »/« valueOf »/« toLocaleString » (autres clés héritées courantes) sont tous rejetés -- repli français", () => {
  for (const key of ["hasOwnProperty", "valueOf", "toLocaleString", "isPrototypeOf", "propertyIsEnumerable"]) {
    assert.equal(resolveLangFromParam(key), "fr", `« ${key} » devrait retomber sur « fr », jamais être traité comme une langue`);
  }
});

test("mandat v1.1 « fr/en/ar accepted » : les 3 SEULES langues réellement prises en charge restent, elles, acceptées à l'identique après ce correctif (non-régression)", () => {
  assert.equal(resolveLangFromParam("fr"), "fr");
  assert.equal(resolveLangFromParam("en"), "en");
  assert.equal(resolveLangFromParam("ar"), "ar");
});

test("mandat v1.1 : valeur vide (chaîne vide) -- repli français, jamais une erreur", () => {
  assert.equal(resolveLangFromParam(""), "fr");
});
