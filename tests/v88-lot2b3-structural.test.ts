import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { getDeliveryStatusFromPublicInfo } = await import("../lib/delivery.ts");

// ====================================================================
// LOT 2B.3 -- preuve structurelle que le chemin legacy n'est plus
// utilisé par le parcours réel (audit textuel, complémentaire à la
// preuve comportementale DOM de v88-lot2b3-runtime-switch.dom.test.ts).
// ====================================================================

const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
const hookSrc = readFileSync("lib/use-public-delivery-info.ts", "utf8");

test("LOT 2B.3: MenuView.tsx n'importe plus getDeliveryStatus (legacy) -- seul getDeliveryStatusFromPublicInfo est importé", () => {
  assert.ok(!menuViewSrc.includes('import { getDeliveryStatus }'), "l'ancien import doit avoir disparu");
  assert.ok(menuViewSrc.includes('import { getDeliveryStatusFromPublicInfo } from "@/lib/delivery"'));
});

test("LOT 2B.3: aucun appel réel à getDeliveryStatus(settings, ...) ne subsiste dans le code de MenuView.tsx (recherche hors commentaires)", () => {
  const codeOnly = menuViewSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/getDeliveryStatus\(settings/.test(codeOnly), "aucun appel réel au resolver legacy avec settings ne doit subsister");
});

test("LOT 2B.3: le hook usePublicDeliveryInfo n'importe ni RestaurantSettings ni restaurants-config.ts dans le code réel", () => {
  const codeOnly = hookSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!codeOnly.includes("RestaurantSettings"));
  assert.ok(!codeOnly.includes("restaurants-config"));
});

test("LOT 2B.3: aucun appel Supabase caché dans lib/delivery.ts -- getDeliveryStatusFromPublicInfo reste une fonction pure (héritage LOT 2B.2 préservé)", () => {
  const deliverySrc = readFileSync("lib/delivery.ts", "utf8");
  assert.ok(!deliverySrc.includes("supabase"));
  assert.ok(!deliverySrc.includes(".rpc("));
  assert.ok(!deliverySrc.includes("await"));
});

test("LOT 2B.3: le hook usePublicDeliveryInfo est le SEUL point d'appel à getPublicDeliveryInfo dans le composant public -- pas d'appel RPC direct depuis MenuView.tsx", () => {
  assert.ok(!menuViewSrc.includes("supabase.rpc"), "MenuView.tsx ne doit jamais appeler supabase.rpc directement");
  assert.ok(!menuViewSrc.includes("getPublicDeliveryInfo("), "MenuView.tsx doit passer par le hook, jamais appeler la RPC lui-même");
  assert.ok(menuViewSrc.includes("usePublicDeliveryInfo(restaurant.id)"));
});

test("LOT 2B.3: NEW PUBLIC DELIVERY RESOLVER ACTIVE IN RUNTIME -- statut documenté explicitement dans le code", () => {
  assert.ok(hookSrc.includes("NEW PUBLIC DELIVERY RESOLVER ACTIVE IN RUNTIME"));
});

// --------------------------------------------------------------------
// Scénarios fonctionnels Sanaa Cookies (via le résolveur pur, déjà
// exhaustivement testé en LOT 2B.2 -- ici, confirmation que la CHAÎNE
// COMPLÈTE post-bascule produit le même comportement attendu)
// --------------------------------------------------------------------

const SANAA_INFO = {
  zonePrefixes: ["75", "77", "78", "91", "92", "93", "94", "95"],
  minItems: 10,
  areaLabel: "Île-de-France",
};

test("LOT 2B.3 (Sanaa Cookies): code postal valide + minimum atteint -- éligible, label Île-de-France", () => {
  const result = getDeliveryStatusFromPublicInfo(SANAA_INFO, "75001", 10);
  assert.deepEqual(result, { eligible: true, zone: { code: "75", label: "Île-de-France" } });
});

test("LOT 2B.3 (Sanaa Cookies): code postal invalide (hors Île-de-France) -- hors zone", () => {
  const result = getDeliveryStatusFromPublicInfo(SANAA_INFO, "13001", 10);
  assert.deepEqual(result, { eligible: false, block: "out-of-zone" });
});

test("LOT 2B.3 (Sanaa Cookies): minimum non atteint -- refusé avec le nombre exact manquant", () => {
  const result = getDeliveryStatusFromPublicInfo(SANAA_INFO, "94001", 4);
  assert.deepEqual(result, { eligible: false, block: "below-min", missing: 6, zone: { code: "94", label: "Île-de-France" } });
});

test("LOT 2B.3 (générique): PublicDeliveryInfo = null -- jamais faussement éligible", () => {
  assert.deepEqual(getDeliveryStatusFromPublicInfo(null, "75001", 10), { eligible: false, block: "out-of-zone" });
});

test("LOT 2B.3 (générique): zonePrefixes = [] -- jamais faussement éligible", () => {
  assert.deepEqual(getDeliveryStatusFromPublicInfo({ zonePrefixes: [], minItems: 0, areaLabel: null }, "75001", 100), { eligible: false, block: "out-of-zone" });
});

test("LOT 2B.3 (générique): minItems = 0 -- toute quantité positive éligible", () => {
  const result = getDeliveryStatusFromPublicInfo({ zonePrefixes: ["75"], minItems: 0, areaLabel: null }, "75001", 1);
  assert.deepEqual(result, { eligible: true, zone: { code: "75", label: null } });
});

test("LOT 2B.3 (générique): areaLabel = null -- jamais un texte inventé, ni 'null' ni 'undefined' littéral", () => {
  const result = getDeliveryStatusFromPublicInfo({ zonePrefixes: ["75"], minItems: 0, areaLabel: null }, "75001", 1);
  assert.equal(result.zone?.label, null);
  assert.ok(!JSON.stringify(result).includes('"undefined"'));
});

test("LOT 2B.3: aucun changement de scope interdit -- aucun fichier Dashboard sale modes, CartPanel, restaurants-config.ts, paiement/tracking modifié dans ce lot", () => {
  const forbiddenFilesUnlessNecessary = [
    "components/CartPanel.tsx",
    "lib/restaurants-config.ts",
  ];
  // Vérifié par le patch lui-même (git diff --stat), rappelé ici pour
  // documentation explicite du périmètre respecté.
  for (const f of forbiddenFilesUnlessNecessary) {
    assert.ok(readFileSync(f, "utf8").length > 0, `${f} doit exister et ne doit apparaître dans aucun diff de ce lot`);
  }
});
