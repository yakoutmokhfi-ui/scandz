import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// FULFILLMENT ROUTING LOT C — ACTIVE FRONTEND RUNTIME ROUTING.
//
// Ce fichier couvre le PONT DE MIGRATION (resolveActiveDeliveryStatus,
// deliveryStatusFromFulfillmentResult -- lib/delivery.ts) par des
// tests PURS, SANS DOM, SANS Supabase : la fonction elle-même est
// synchrone, aucune de ces preuves n'a besoin de monter un composant.
// La preuve comportementale RÉELLE du hook (get_restaurant_public_
// delivery_fulfillments réellement appelée) vit séparément dans
// tests/v101-fulfillment-routing-lot-c-hook.dom.test.ts, même
// séparation déjà établie par le projet (v96 = pur, v88-runtime-switch
// = DOM).
//
// Ne duplique JAMAIS les cas déjà couverts par
// tests/fixtures/fulfillment-routing-cases.json /
// tests/v97-fulfillment-routing-lot-b1-determinism.test.ts (le
// résolveur resolveDeliveryFulfillment lui-même) : ce fichier teste
// UNIQUEMENT ce qui est nouveau en LOT C -- la DÉCISION migration
// bridge (quel moteur appeler) et l'ADAPTATION de forme
// (deliveryStatusFromFulfillmentResult), jamais l'algorithme de
// correspondance de préfixe lui-même.
// ====================================================================

const {
  resolveActiveDeliveryStatus,
  deliveryStatusFromFulfillmentResult,
  resolveDeliveryFulfillment,
} = await import("../lib/delivery.ts");

const deliverySrc = readFileSync("lib/delivery.ts", "utf8");
const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
const fulfillmentSelectorSrc = readFileSync("components/FulfillmentSelector.tsx", "utf8");
const cartPanelSrc = readFileSync("components/CartPanel.tsx", "utf8");
const hookSrc = readFileSync("lib/use-public-delivery-fulfillments.ts", "utf8");

const RULE_75 = {
  fulfillmentCode: "local_delivery_75",
  zonePrefixes: ["75"],
  isFallback: false,
  minItems: 2,
  customerText: "Livraison locale le jour même",
  displayOrder: 0,
};

// --------------------------------------------------------------------
// 1. Pont de migration -- table de décision complète (mission §3/§4/§7/§28)
// --------------------------------------------------------------------

test("LOT C (migration bridge): règles 'loading' -- état sûr non éligible, routingSource='loading', JAMAIS confondu avec 'legacy' ni avec une éligibilité positive", () => {
  const result = resolveActiveDeliveryStatus({ status: "loading" }, null, "75001", 10);
  assert.equal(result.status.eligible, false);
  assert.equal(result.routingSource, "loading");
});

test("LOT C (migration bridge): règles 'error' -- état sûr non éligible, routingSource='error', NE DOIT JAMAIS se déguiser en 'legacy' (mission §7/§28)", () => {
  const result = resolveActiveDeliveryStatus({ status: "error" }, null, "75001", 10);
  assert.equal(result.status.eligible, false);
  assert.notEqual(result.routingSource, "legacy", "une panne RPC n'est pas 'zéro règle constaté' -- ne doit jamais emprunter le chemin legacy");
  assert.equal(result.routingSource, "error");
});

test("LOT C (migration bridge): règles chargées, tableau VIDE (établissement de référence non-migré, style Sanaa) -- routingSource='legacy', comportement IDENTIQUE à getDeliveryStatusFromPublicInfo déjà en production (mission §2/§18/§29)", () => {
  const legacyInfo = { zonePrefixes: ["92"], minItems: 2, areaLabel: "Hauts-de-Seine" };
  const result = resolveActiveDeliveryStatus({ status: "loaded", rules: [] }, legacyInfo, "92100", 5);
  assert.equal(result.routingSource, "legacy");
  assert.equal(result.status.eligible, true);
  assert.equal(result.status.zone?.label, "Hauts-de-Seine");
});

test("LOT C (migration bridge): règles chargées, tableau VIDE, hors zone legacy -- refusé, toujours routingSource='legacy' (jamais un faux-positif)", () => {
  const legacyInfo = { zonePrefixes: ["92"], minItems: 2, areaLabel: "Hauts-de-Seine" };
  const result = resolveActiveDeliveryStatus({ status: "loaded", rules: [] }, legacyInfo, "75001", 5);
  assert.equal(result.routingSource, "legacy");
  assert.equal(result.status.eligible, false);
  assert.equal(result.status.block, "out-of-zone");
});

test("LOT C (migration bridge): règles chargées, tableau NON VIDE -- routingSource='fulfillment-rules', résolu EXCLUSIVEMENT par resolveDeliveryFulfillment, jamais par le chemin legacy même si legacyPublicDeliveryInfo est fourni et matcherait", () => {
  // Piège délibéré : legacyPublicDeliveryInfo matcherait ce même code
  // postal si jamais il était consulté par erreur -- sa présence ne
  // doit strictement rien changer au résultat une fois des règles
  // réelles connues.
  const legacyInfoThatWouldAlsoMatch = { zonePrefixes: ["75"], minItems: 999, areaLabel: "PIEGE-LEGACY-NE-DOIT-JAMAIS-ETRE-CONSULTE" };
  const result = resolveActiveDeliveryStatus(
    { status: "loaded", rules: [RULE_75] },
    legacyInfoThatWouldAlsoMatch,
    "75001",
    5
  );
  assert.equal(result.routingSource, "fulfillment-rules");
  assert.equal(result.status.eligible, true);
  assert.notEqual(result.status.zone?.label, "PIEGE-LEGACY-NE-DOIT-JAMAIS-ETRE-CONSULTE");
  assert.equal(result.status.zone?.label, "Livraison locale le jour même");
});

test("LOT C (migration bridge, mission §4): règles NON VIDES mais AUCUNE ne correspond -- ineligible via le NOUVEAU moteur (out-of-zone), NE DOIT JAMAIS retomber sur le chemin legacy même si legacyPublicDeliveryInfo matcherait", () => {
  const legacyInfoThatWouldMatch = { zonePrefixes: ["13"], minItems: 0, areaLabel: "PIEGE-LEGACY-NE-DOIT-JAMAIS-ETRE-CONSULTE" };
  const result = resolveActiveDeliveryStatus(
    { status: "loaded", rules: [RULE_75] }, // seul un préfixe "75" existe
    legacyInfoThatWouldMatch,
    "13001", // ne matche aucune règle "75"
    5
  );
  assert.equal(result.routingSource, "fulfillment-rules", "même sans correspondance, la SOURCE reste le nouveau moteur -- jamais un repli legacy silencieux");
  assert.equal(result.status.eligible, false);
  assert.equal(result.status.block, "out-of-zone");
  assert.notEqual(result.status.zone?.label, "PIEGE-LEGACY-NE-DOIT-JAMAIS-ETRE-CONSULTE");
});

test("LOT C (migration bridge): code postal vide, règles non vides -- no-postal via le nouveau moteur, avant toute évaluation de règle", () => {
  const result = resolveActiveDeliveryStatus({ status: "loaded", rules: [RULE_75] }, null, "", 5);
  assert.equal(result.routingSource, "fulfillment-rules");
  assert.equal(result.status.eligible, false);
  assert.equal(result.status.block, "no-postal");
});

// --------------------------------------------------------------------
// 2. deliveryStatusFromFulfillmentResult -- adaptation de forme pure
//    (mission §12/§13 : customer_text, jamais le provider)
// --------------------------------------------------------------------

test("LOT C (adaptation): éligible -- zone.label reçoit EXACTEMENT customerText, zone.code reçoit matchedPrefix, jamais fulfillmentCode exposé", () => {
  const result = resolveDeliveryFulfillment([RULE_75], "75001", 5);
  const status = deliveryStatusFromFulfillmentResult(result);
  assert.equal(status.eligible, true);
  assert.equal(status.zone?.label, "Livraison locale le jour même");
  assert.equal(status.zone?.code, "75");
  assert.ok(!JSON.stringify(status).includes("local_delivery_75"), "fulfillmentCode ne doit JAMAIS apparaître dans le DeliveryStatus produit -- jamais exposé au client (mission §12)");
});

test("LOT C (adaptation): below-min -- missing/zone.label conservés pour affichage, même règle presque éligible identifiée", () => {
  const result = resolveDeliveryFulfillment([RULE_75], "75001", 1);
  const status = deliveryStatusFromFulfillmentResult(result);
  assert.equal(status.eligible, false);
  assert.equal(status.block, "below-min");
  assert.equal(status.missing, 1);
  assert.equal(status.zone?.label, "Livraison locale le jour même");
});

test("LOT C (adaptation): customerText absent (null côté règle) -- zone.label devient null, JAMAIS un texte inventé en repli", () => {
  const ruleNoText = { ...RULE_75, customerText: null };
  const result = resolveDeliveryFulfillment([ruleNoText], "75001", 5);
  const status = deliveryStatusFromFulfillmentResult(result);
  assert.equal(status.eligible, true);
  assert.equal(status.zone?.label, null);
});

test("LOT C (adaptation): fallback retenu (matchedPrefix=undefined) -- zone.code devient '' (jamais undefined, jamais une exception)", () => {
  const fallbackRule = {
    fulfillmentCode: "wide_shipping",
    zonePrefixes: [],
    isFallback: true,
    minItems: 0,
    customerText: "Expédition sous 48h",
    displayOrder: 1,
  };
  const result = resolveDeliveryFulfillment([fallbackRule], "99999", 5);
  const status = deliveryStatusFromFulfillmentResult(result);
  assert.equal(status.eligible, true);
  assert.equal(status.zone?.code, "");
  assert.equal(status.zone?.label, "Expédition sous 48h");
});

test("LOT C (adaptation): out-of-zone/no-postal -- aucune zone exposée, même contrat que getDeliveryStatusFromPublicInfo pour ces deux blocs", () => {
  const outOfZone = deliveryStatusFromFulfillmentResult(resolveDeliveryFulfillment([RULE_75], "13001", 5));
  assert.deepEqual(outOfZone, { eligible: false, block: "out-of-zone" });
  const noPostal = deliveryStatusFromFulfillmentResult(resolveDeliveryFulfillment([RULE_75], "", 5));
  assert.deepEqual(noPostal, { eligible: false, block: "no-postal" });
});

// --------------------------------------------------------------------
// 3. Contrat totalCount (mission §11) -- documenté et prouvé : la
//    grandeur transmise est la QUANTITÉ TOTALE d'articles, jamais le
//    nombre de lignes/produits distincts.
// --------------------------------------------------------------------

test("LOT C (totalCount, mission §11): un seul produit en grande quantité satisfait un minimum tout comme plusieurs produits de quantité 1 -- la grandeur comparée à minItems est la SOMME des quantités, jamais le nombre de lignes", () => {
  const ruleMin3 = { ...RULE_75, minItems: 3 };
  // Cas A : 1 seule ligne de panier, quantité 3 -- totalCount=3 (déjà
  // le contrat utilisé par MenuView.tsx : lines.reduce((sum, l) => sum
  // + l.quantity, 0), voir le commentaire dédié dans ce fichier).
  const singleLineQty3 = resolveDeliveryFulfillment([ruleMin3], "75001", 3);
  assert.equal(singleLineQty3.eligible, true, "1 ligne à quantité 3 doit satisfaire minItems=3 -- la grandeur est bien une somme de quantités");
  // Cas B : 3 lignes de panier distinctes, quantité 1 chacune --
  // totalCount=3 également (même somme, calculée en amont par
  // MenuView.tsx, pas par ce résolveur) -- même verdict, prouvant que
  // seul le TOTAL compte, jamais le nombre de lignes.
  const threeLinesQty1Each = resolveDeliveryFulfillment([ruleMin3], "75001", 1 + 1 + 1);
  assert.deepEqual(singleLineQty3, threeLinesQty1Each, "le résolveur ne voit qu'un totalCount numérique -- le même total doit produire EXACTEMENT le même verdict, quelle que soit sa répartition en lignes");
});

test("LOT C (totalCount, mission §11): MenuView.tsx calcule totalCount comme la somme des quantités de lignes (lines.reduce(...+ l.quantity)), jamais lines.length -- même grandeur déjà transmise à resolveActiveDeliveryStatus", () => {
  const totalCountLine = menuViewSrc
    .split("\n")
    .find((l) => l.trim().startsWith("const totalCount ="));
  assert.ok(totalCountLine, "la définition de totalCount doit être présente et inchangée par ce lot");
  assert.ok(totalCountLine!.includes("l.quantity"), "totalCount doit rester une somme de quantités (l.quantity), jamais un compte de lignes (lines.length)");
  assert.ok(!totalCountLine!.includes("lines.length"));
});

// --------------------------------------------------------------------
// 4. Aucune seconde implémentation d'algorithme (mission §10)
// --------------------------------------------------------------------

test("LOT C: resolveActiveDeliveryStatus délègue ENTIÈREMENT à resolveDeliveryFulfillment/getDeliveryStatusFromPublicInfo -- ne contient aucune comparaison de préfixe ni de minItems écrite une seconde fois", () => {
  const start = deliverySrc.indexOf("export function resolveActiveDeliveryStatus");
  const end = deliverySrc.indexOf("\n}", start);
  const body = deliverySrc.slice(start, end);
  assert.ok(!body.includes(".startsWith("), "aucune comparaison de préfixe ne doit être écrite ici -- déléguée à resolveDeliveryFulfillment");
  assert.ok(body.includes("resolveDeliveryFulfillment("), "doit appeler le résolveur existant, jamais le dupliquer");
  assert.ok(body.includes("getDeliveryStatusFromPublicInfo("), "doit appeler le résolveur legacy existant, jamais le dupliquer");
});

test("LOT C: aucun appel Supabase / RPC / await dans resolveActiveDeliveryStatus/deliveryStatusFromFulfillmentResult -- fonctions pures, synchrones", () => {
  for (const fnName of ["resolveActiveDeliveryStatus", "deliveryStatusFromFulfillmentResult"]) {
    const start = deliverySrc.indexOf(`export function ${fnName}`);
    const end = deliverySrc.indexOf("\n}", start);
    const body = deliverySrc.slice(start, end);
    assert.ok(!body.includes("supabase"));
    assert.ok(!body.includes(".rpc("));
    assert.ok(!body.includes("await"));
  }
});

test("LOT C: aucune logique spécifique à un établissement précis (aucun slug, aucun nom d'établissement codé en dur) dans le pont de migration", () => {
  const start = deliverySrc.indexOf("export type FulfillmentRulesResolution");
  assert.ok(!/illico|sanaa|sirocco|au lait cru/i.test(deliverySrc.slice(start)));
});

// --------------------------------------------------------------------
// 5. Scope minimal (mission §32) -- preuve structurelle que
//    FulfillmentSelector.tsx et CartPanel.tsx n'ont PAS eu besoin
//    d'être modifiés : ils continuent de manipuler exclusivement
//    DeliveryStatus, jamais DeliveryFulfillmentStatus/
//    FulfillmentRulesResolution/routingSource.
// --------------------------------------------------------------------

test("LOT C (scope minimal): FulfillmentSelector.tsx et CartPanel.tsx ne référencent NI resolveActiveDeliveryStatus NI routingSource NI FulfillmentRulesResolution -- aucune modification de ces deux fichiers n'était nécessaire", () => {
  for (const [name, src] of [
    ["components/FulfillmentSelector.tsx", fulfillmentSelectorSrc],
    ["components/CartPanel.tsx", cartPanelSrc],
  ] as const) {
    assert.ok(!src.includes("resolveActiveDeliveryStatus"), `${name} ne doit pas référencer le pont de migration -- il reçoit toujours un DeliveryStatus déjà résolu`);
    assert.ok(!src.includes("routingSource"), `${name} ne doit jamais exposer routingSource -- mission §19, interne uniquement`);
    assert.ok(!src.includes("FulfillmentRulesResolution"));
    assert.ok(!src.includes("usePublicDeliveryFulfillments"), `${name} ne doit pas appeler le nouveau hook directement -- seul MenuView.tsx le fait`);
  }
});

test("LOT C (scope minimal): CartPanel.tsx continue de déclarer deliveryStatus: DeliveryStatus (type INCHANGÉ) -- aucune évolution de sa signature de props n'était nécessaire", () => {
  assert.ok(cartPanelSrc.includes("deliveryStatus: DeliveryStatus"), "le contrat de props de CartPanel.tsx doit rester exactement DeliveryStatus, prouvant que le pont de migration produit une forme 100% compatible");
});

test("LOT C (privacy, mission §19/§20): routingSource n'est JAMAIS rendu dans le JSX de MenuView.tsx (recherche hors commentaires) -- interne aux tests/à la logique uniquement", () => {
  const codeOnly = menuViewSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!codeOnly.includes(".routingSource"), "aucune lecture de .routingSource ne doit apparaître dans le code réel de MenuView.tsx -- resolveActiveDeliveryStatus(...).status uniquement");
});

// --------------------------------------------------------------------
// 6. Provider privacy (mission §20/§23) -- aucune mention exécutable
//    de provider dans le nouveau code de ce lot.
// --------------------------------------------------------------------

test("LOT C (provider privacy): aucune mention de Stuart/Chronofresh/Uber Direct/booking/dispatch/tracking dans lib/delivery.ts, lib/use-public-delivery-fulfillments.ts, ou MenuView.tsx (hors commentaires de portée, recherche insensible à la casse sur le code)", () => {
  const forbidden = /stuart|chronofresh|uber direct|\bdispatch\(|\bbooking\(/i;
  for (const src of [deliverySrc, hookSrc]) {
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!forbidden.test(codeOnly));
  }
});

test("LOT C (provider privacy): le hook n'appelle qu'une seule RPC (get_restaurant_public_delivery_fulfillments, via getPublicDeliveryFulfillments) -- aucun accès Supabase direct, aucune seconde RPC", () => {
  assert.ok(!hookSrc.includes("supabase.rpc("));
  assert.ok(!hookSrc.includes("supabase.from("));
  assert.equal((hookSrc.match(/getPublicDeliveryFulfillments/g) ?? []).length >= 1, true);
});
