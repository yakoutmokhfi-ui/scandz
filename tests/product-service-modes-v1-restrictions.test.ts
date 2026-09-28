import { test } from "node:test";
import assert from "node:assert/strict";
import {
  frontendRestrictedModes,
  serviceModeNameKey,
  blockingItemsByMode,
} from "../lib/service-mode-restrictions.ts";
import type { MenuItem } from "../lib/types.ts";

// ====================================================================
// PRODUCT SERVICE MODES v1 -- tests DÉDIÉS (service) pour les
// utilitaires purs partagés lib/service-mode-restrictions.ts.
//
// Demandé explicitement par le GO CIO/Ravel (issue #11, "dedicated
// DOM/service tests"). Couvre :
//   - frontendRestrictedModes : sémantique ALL-par-absence, filtrage
//     des codes non reconnus par le frontend, jamais un tableau vide
//     confondu avec "ALL".
//   - serviceModeNameKey : mapping i18n, "table" -> "modeTable" seul
//     cas spécial.
//   - blockingItemsByMode : dédoublonnage, ordre d'apparition, jamais
//     un item sans restriction (ou restriction reconnue couvrant le
//     mode) ne bloque quoi que ce soit -- indépendant de
//     withdrawal_eligible (aucune lecture de cet attribut ici, exigé
//     par le CIO -- prouvé en le faisant volontairement varier dans un
//     scénario ci-dessous sans effet sur le résultat).
//
// Style pur (node:test, aucun DOM/esbuild) -- même patron que
// tests/v84-lot2b1.test.ts pour lib/sale-modes-public.ts.
// ====================================================================

function item(over: Partial<MenuItem> = {}): MenuItem {
  return {
    id: "item-1",
    category_id: "cat-1",
    name: "Article",
    description: null,
    short_description: null,
    price: 4,
    image_url: null,
    display_order: 1,
    is_available: true,
    ...over,
  } as MenuItem;
}

// --------------------------------------------------------------------
// frontendRestrictedModes
// --------------------------------------------------------------------

test("frontendRestrictedModes : allowed_sale_modes absent (undefined) -> null (ALL, aucune restriction)", () => {
  assert.equal(frontendRestrictedModes(item({ allowed_sale_modes: undefined })), null);
});

test("frontendRestrictedModes : allowed_sale_modes = null -> null (ALL, aucune restriction)", () => {
  assert.equal(frontendRestrictedModes(item({ allowed_sale_modes: null })), null);
});

test("frontendRestrictedModes : allowed_sale_modes = [] -> null (jamais confondu avec une restriction à rien)", () => {
  assert.equal(frontendRestrictedModes(item({ allowed_sale_modes: [] })), null);
});

test("frontendRestrictedModes : un seul mode connu restreint -> ce mode seul, dans un tableau", () => {
  assert.deepEqual(frontendRestrictedModes(item({ allowed_sale_modes: ["pickup"] })), ["pickup"]);
});

test("frontendRestrictedModes : plusieurs modes connus restreints -> tous, dans l'ordre fourni", () => {
  assert.deepEqual(
    frontendRestrictedModes(item({ allowed_sale_modes: ["delivery", "table"] })),
    ["delivery", "table"]
  );
});

// CORRECTIF (audit indépendant CHATEAUBRIAND, issue #11) : une
// restriction explicite et non vide dont AUCUN code n'est
// frontend-connu N'EST PLUS jamais traitée comme "Tous" (`null`) --
// c'était le désaccord client/serveur confirmé par l'audit :
// `create_order` (serveur) rejette bien cet article pour
// table/pickup/delivery (voir DRAFT-lot-product-service-modes-v1.sql),
// donc le client doit désormais refléter EXACTEMENT le même refus.
// `[]` (distinct de `null`) signifie "restreint, à aucun mode
// frontend-connu" -- voir blockingItemsByMode ci-dessous pour la
// conséquence sur le blocage panier.
test("frontendRestrictedModes : code(s) non reconnu(s) par le frontend seul(s) -> [] (restriction réelle, PAS 'Tous' -- accord client/serveur)", () => {
  assert.deepEqual(
    frontendRestrictedModes(item({ allowed_sale_modes: ["some-future-mode"] })),
    []
  );
});

test("frontendRestrictedModes : restreint à 'room_service' seul (mode serveur réel, non rendu par le frontend) -> [] (jamais 'Tous')", () => {
  assert.deepEqual(
    frontendRestrictedModes(item({ allowed_sale_modes: ["room_service"] })),
    []
  );
});

test("frontendRestrictedModes : restreint à 'click_collect' seul (mode serveur réel, non rendu par le frontend) -> [] (jamais 'Tous')", () => {
  assert.deepEqual(
    frontendRestrictedModes(item({ allowed_sale_modes: ["click_collect"] })),
    []
  );
});

test("frontendRestrictedModes : mélange de PLUSIEURS codes non reconnus (room_service + click_collect) -> [] (jamais 'Tous')", () => {
  assert.deepEqual(
    frontendRestrictedModes(item({ allowed_sale_modes: ["room_service", "click_collect"] })),
    []
  );
});

test("frontendRestrictedModes : mélange connu + inconnu -> seuls les codes connus sont retenus (comportement pickup/delivery existant inchangé)", () => {
  assert.deepEqual(
    frontendRestrictedModes(item({ allowed_sale_modes: ["pickup", "some-future-mode"] })),
    ["pickup"]
  );
});

test("frontendRestrictedModes : mélange connu + room_service -> seul le code connu ('delivery') est retenu", () => {
  assert.deepEqual(
    frontendRestrictedModes(item({ allowed_sale_modes: ["delivery", "room_service"] })),
    ["delivery"]
  );
});

test("frontendRestrictedModes : totalement indépendant de withdrawal_eligible (aucun couplage, exigence CIO)", () => {
  const restricted = item({ allowed_sale_modes: ["pickup"], withdrawal_eligible: true } as Partial<MenuItem>);
  const notRestricted = item({ allowed_sale_modes: ["pickup"], withdrawal_eligible: false } as Partial<MenuItem>);
  assert.deepEqual(frontendRestrictedModes(restricted), ["pickup"]);
  assert.deepEqual(frontendRestrictedModes(notRestricted), ["pickup"]);
});

test("frontendRestrictedModes : indépendant de withdrawal_eligible également pour une restriction à un code non reconnu (room_service) -- même résultat [] quelle que soit la valeur", () => {
  const eligible = item({ allowed_sale_modes: ["room_service"], withdrawal_eligible: true } as Partial<MenuItem>);
  const notEligible = item({ allowed_sale_modes: ["room_service"], withdrawal_eligible: false } as Partial<MenuItem>);
  assert.deepEqual(frontendRestrictedModes(eligible), []);
  assert.deepEqual(frontendRestrictedModes(notEligible), []);
});

// --------------------------------------------------------------------
// serviceModeNameKey
// --------------------------------------------------------------------

test("serviceModeNameKey : 'table' -> 'modeTable' (seul cas spécial, même convention que la rangée howToReceive)", () => {
  assert.equal(serviceModeNameKey("table"), "modeTable");
});

test("serviceModeNameKey : 'pickup'/'delivery' -> retournés tels quels (clé i18n = code du mode)", () => {
  assert.equal(serviceModeNameKey("pickup"), "pickup");
  assert.equal(serviceModeNameKey("delivery"), "delivery");
});

// --------------------------------------------------------------------
// blockingItemsByMode
// --------------------------------------------------------------------

test("blockingItemsByMode : panier vide -> aucun mode bloqué (objet vide)", () => {
  assert.deepEqual(blockingItemsByMode([]), {});
});

test("blockingItemsByMode : aucun item du panier n'a de restriction -> aucun mode bloqué", () => {
  const cart = [item({ id: "a" }), item({ id: "b" })];
  assert.deepEqual(blockingItemsByMode(cart), {});
});

test("blockingItemsByMode : un item restreint à 'pickup' bloque 'table' et 'delivery', jamais 'pickup'", () => {
  const blockerItem = item({ id: "a", name: "Coffret retrait seul", allowed_sale_modes: ["pickup"] });
  const result = blockingItemsByMode([blockerItem]);
  assert.deepEqual(Object.keys(result).sort(), ["delivery", "table"]);
  assert.deepEqual(result.table, [blockerItem]);
  assert.deepEqual(result.delivery, [blockerItem]);
  assert.equal(result.pickup, undefined);
});

test("blockingItemsByMode : un item sans restriction dans le panier ne bloque JAMAIS rien, même mélangé à un item restreint", () => {
  const free = item({ id: "free", allowed_sale_modes: null });
  const restricted = item({ id: "restricted", allowed_sale_modes: ["delivery"] });
  const result = blockingItemsByMode([free, restricted]);
  // "delivery" est couvert par restricted -> jamais bloqué ; table/pickup
  // bloqués par restricted seul (free ne bloque jamais rien).
  assert.deepEqual(result.table, [restricted]);
  assert.deepEqual(result.pickup, [restricted]);
  assert.equal(result.delivery, undefined);
});

test("blockingItemsByMode : plusieurs items bloquant le MÊME mode sont tous listés, dans leur ordre d'apparition dans le panier", () => {
  const a = item({ id: "a", name: "A", allowed_sale_modes: ["pickup"] });
  const b = item({ id: "b", name: "B", allowed_sale_modes: ["pickup", "table"] });
  const result = blockingItemsByMode([a, b]);
  // "delivery" bloqué par a ET b (ni l'un ni l'autre ne le couvre).
  assert.deepEqual(result.delivery, [a, b]);
  // "table" bloqué par a seul (b le couvre).
  assert.deepEqual(result.table, [a]);
  assert.equal(result.pickup, undefined);
});

test("blockingItemsByMode : le même produit présent plusieurs fois (lignes distinctes de même id) n'apparaît qu'UNE fois par mode bloqué (dédoublonné par id)", () => {
  const a1 = item({ id: "a", name: "A" as const, allowed_sale_modes: ["pickup"] });
  const a2 = item({ id: "a", name: "A" as const, allowed_sale_modes: ["pickup"] });
  const result = blockingItemsByMode([a1, a2]);
  assert.equal(result.table?.length, 1);
  assert.equal(result.delivery?.length, 1);
});

test("blockingItemsByMode : un item dont la restriction couvre TOUS les modes frontend connus -- panier utilisable pour tous, aucun mode bloqué", () => {
  const allModes = item({ id: "a", allowed_sale_modes: ["table", "pickup", "delivery"] });
  assert.deepEqual(blockingItemsByMode([allModes]), {});
});

// CORRECTIF (audit indépendant CHATEAUBRIAND, issue #11) : c'était le
// finding confirmé -- un item dont TOUTE la restriction serveur est
// un code non reconnu par le frontend (ex. "kiosk-v2", ou un vrai
// mode serveur pas encore rendu comme room_service/click_collect)
// bloquait AUPARAVANT `{}` (aucun mode bloqué), alors que
// `create_order` (serveur) rejette cet article pour
// table/pickup/delivery : désaccord client/serveur confirmé. Corrigé
// -- bloque désormais les TROIS modes frontend-connus, exactement
// comme le ferait le serveur (accord client/serveur rétabli).
test("blockingItemsByMode : un item dont TOUTE la restriction est un code non reconnu par le frontend -- bloque les 3 modes frontend-connus (accord client/serveur, PAS traité comme ALL)", () => {
  const unknownOnly = item({ id: "a", name: "Article kiosque only", allowed_sale_modes: ["kiosk-v2"] });
  const result = blockingItemsByMode([unknownOnly]);
  assert.deepEqual(Object.keys(result).sort(), ["delivery", "pickup", "table"]);
  assert.deepEqual(result.table, [unknownOnly]);
  assert.deepEqual(result.pickup, [unknownOnly]);
  assert.deepEqual(result.delivery, [unknownOnly]);
});

test("blockingItemsByMode : restreint à 'room_service' seul (mode serveur réel) -- bloque les 3 modes frontend-connus, exactement comme create_order le ferait", () => {
  const roomServiceOnly = item({ id: "a", allowed_sale_modes: ["room_service"] });
  const result = blockingItemsByMode([roomServiceOnly]);
  assert.deepEqual(Object.keys(result).sort(), ["delivery", "pickup", "table"]);
});

test("blockingItemsByMode : restreint à 'click_collect' seul (mode serveur réel) -- bloque les 3 modes frontend-connus, exactement comme create_order le ferait", () => {
  const clickCollectOnly = item({ id: "a", allowed_sale_modes: ["click_collect"] });
  const result = blockingItemsByMode([clickCollectOnly]);
  assert.deepEqual(Object.keys(result).sort(), ["delivery", "pickup", "table"]);
});

test("blockingItemsByMode : mélange connu + inconnu ('pickup' + 'room_service') -- seul 'pickup' reste utilisable, table/delivery bloqués (comportement pickup/delivery existant inchangé, extension non reconnue ignorée sans jamais élargir vers ALL)", () => {
  const mixed = item({ id: "a", name: "Article mixte", allowed_sale_modes: ["pickup", "room_service"] });
  const result = blockingItemsByMode([mixed]);
  assert.deepEqual(Object.keys(result).sort(), ["delivery", "table"]);
  assert.deepEqual(result.table, [mixed]);
  assert.deepEqual(result.delivery, [mixed]);
  assert.equal(result.pickup, undefined);
});

test("blockingItemsByMode : indépendant de withdrawal_eligible sur les items du panier (aucun couplage, exigence CIO)", () => {
  const restricted = item({ id: "a", allowed_sale_modes: ["pickup"], withdrawal_eligible: true } as Partial<MenuItem>);
  const result = blockingItemsByMode([restricted]);
  assert.deepEqual(result.table, [restricted]);
  assert.deepEqual(result.delivery, [restricted]);
});

test("blockingItemsByMode : indépendant de withdrawal_eligible également pour une restriction à un code non reconnu (room_service) -- même blocage des 3 modes quelle que soit la valeur", () => {
  const eligible = item({ id: "a", allowed_sale_modes: ["room_service"], withdrawal_eligible: true } as Partial<MenuItem>);
  const notEligible = item({ id: "b", allowed_sale_modes: ["room_service"], withdrawal_eligible: false } as Partial<MenuItem>);
  const resultEligible = blockingItemsByMode([eligible]);
  const resultNotEligible = blockingItemsByMode([notEligible]);
  assert.deepEqual(Object.keys(resultEligible).sort(), ["delivery", "pickup", "table"]);
  assert.deepEqual(Object.keys(resultNotEligible).sort(), ["delivery", "pickup", "table"]);
});
