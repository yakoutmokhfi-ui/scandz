// SCANYM — MOBILE STICKY + DELIVERY DELAY NOTICE v1.1
// Hardening A: delivery notice SOURCE CLARITY.
//
// The pre-order delivery timing notice must come ONLY from the merchant's
// CUSTOMER NOTICE TEXT (`customer_text` of the matched fulfillment rule,
// then the generic delivery-mode text). A geographic / zone label
// ("Paris", "Bruxelles", "Zone 1", "10 km") stored in the generic
// `DeliveryStatus.zone.label` field must NEVER become a timing notice,
// even if a caller mis-declares which delivery engine is active.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveDeliveryCustomerNotice } from "../lib/delivery-customer-notice.ts";
import {
  deliveryStatusFromFulfillmentResult,
  getDeliveryStatusFromPublicInfo,
  resolveActiveDeliveryStatus,
  resolveDeliveryFulfillment,
  type DeliveryStatus,
} from "../lib/delivery.ts";
import type { PublicDeliveryFulfillmentRule, SaleMode } from "../lib/sale-modes-types.ts";

const GEOGRAPHIC_LABELS = ["Paris", "Bruxelles", "Zone 1", "10 km"];

const deliveryMode: SaleMode = {
  code: "delivery",
  label: "Livraison",
  category: "fulfillment",
  customerText: null,
  pricingMode: "free",
  fixedFee: null,
  freeThreshold: null,
  delayValue: null,
  delayUnit: null,
};

function rule(overrides: Partial<PublicDeliveryFulfillmentRule>): PublicDeliveryFulfillmentRule {
  return {
    fulfillmentCode: "stuart",
    zonePrefixes: ["75"],
    isFallback: false,
    minItems: null,
    customerText: null,
    displayOrder: 1,
    pricingMode: "free",
    fixedFee: null,
    freeThreshold: null,
    ...overrides,
  };
}

test("legacy engine: a geographic area label is NEVER a timing notice, even if the caller wrongly claims fulfillment rules are active", () => {
  for (const areaLabel of GEOGRAPHIC_LABELS) {
    const legacy = getDeliveryStatusFromPublicInfo({ zonePrefixes: ["75"], minItems: 0, areaLabel }, "75011", 3);
    assert.equal(legacy.eligible, true, "precondition: eligible legacy delivery");
    assert.equal(legacy.zone?.label, areaLabel, "precondition: legacy zone.label is the geographic area label");
    assert.equal(legacy.customerNotice, undefined, "legacy engine never populates customerNotice");
    for (const usesFulfillmentRules of [false, true]) {
      assert.equal(
        resolveDeliveryCustomerNotice("delivery", [deliveryMode], legacy, usesFulfillmentRules),
        null,
        `"${areaLabel}" must not become a notice (usesFulfillmentRules=${usesFulfillmentRules})`
      );
    }
  }
});

test("legacy engine with a generic mode text: the generic text is shown, never the area label", () => {
  for (const areaLabel of GEOGRAPHIC_LABELS) {
    const legacy = getDeliveryStatusFromPublicInfo({ zonePrefixes: ["75"], minItems: 0, areaLabel }, "75011", 3);
    const notice = resolveDeliveryCustomerNotice(
      "delivery",
      [{ ...deliveryMode, customerText: "Livraison sous 24 à 48 h ouvrées." }],
      legacy,
      true
    );
    assert.equal(notice?.message, "Livraison sous 24 à 48 h ouvrées.");
    assert.equal(notice?.message.includes(areaLabel), false);
  }
});

test("a status carrying a text only in zone.label is not a notice source (zone.label is never read)", () => {
  const forged: DeliveryStatus = { eligible: true, zone: { code: "75", label: "Livré demain avant 12 h" } };
  assert.equal(resolveDeliveryCustomerNotice("delivery", [deliveryMode], forged, true), null);
});

test("fulfillment engine: the matched rule's customer_text becomes the explicit customerNotice and the notice", () => {
  const status = deliveryStatusFromFulfillmentResult(
    resolveDeliveryFulfillment([rule({ customerText: "Livraison Chronofresh sous 48 h." })], "75011", 1, 30)
  );
  assert.equal(status.customerNotice, "Livraison Chronofresh sous 48 h.");
  assert.deepEqual(resolveDeliveryCustomerNotice("delivery", [deliveryMode], status, true), {
    modeCode: "delivery",
    modeLabel: "Livraison",
    message: "Livraison Chronofresh sous 48 h.",
  });
});

test("fulfillment engine: distinct providers keep distinct configured texts (Stuart vs Chronofresh)", () => {
  const rules = [
    rule({ fulfillmentCode: "stuart", zonePrefixes: ["75"], customerText: "Coursier Stuart sous 2 h.", displayOrder: 1 }),
    rule({ fulfillmentCode: "chronofresh", zonePrefixes: ["13"], customerText: "Expédition réfrigérée sous 48 h.", displayOrder: 2 }),
  ];
  const paris = deliveryStatusFromFulfillmentResult(resolveDeliveryFulfillment(rules, "75011", 1, 30));
  const marseille = deliveryStatusFromFulfillmentResult(resolveDeliveryFulfillment(rules, "13001", 1, 30));
  assert.equal(resolveDeliveryCustomerNotice("delivery", [deliveryMode], paris, true)?.message, "Coursier Stuart sous 2 h.");
  assert.equal(resolveDeliveryCustomerNotice("delivery", [deliveryMode], marseille, true)?.message, "Expédition réfrigérée sous 48 h.");
});

test("fulfillment engine: rule without text falls back to the generic delivery text; no text at all keeps the historical direct flow", () => {
  const status = deliveryStatusFromFulfillmentResult(resolveDeliveryFulfillment([rule({})], "75011", 1, 30));
  assert.equal(status.customerNotice, null);
  assert.equal(
    resolveDeliveryCustomerNotice("delivery", [{ ...deliveryMode, customerText: "Délai générique." }], status, true)?.message,
    "Délai générique."
  );
  assert.equal(resolveDeliveryCustomerNotice("delivery", [deliveryMode], status, true), null);
});

test("below-minimum fulfillment status keeps the rule text; blocked statuses expose none", () => {
  const belowMin = deliveryStatusFromFulfillmentResult(
    resolveDeliveryFulfillment([rule({ minItems: 5, customerText: "Tournée du mardi." })], "75011", 1, 30)
  );
  assert.equal(belowMin.block, "below-min");
  assert.equal(belowMin.customerNotice, "Tournée du mardi.");
  const outOfZone = deliveryStatusFromFulfillmentResult(
    resolveDeliveryFulfillment([rule({ customerText: "Tournée du mardi." })], "99999", 1, 30)
  );
  assert.equal(outOfZone.customerNotice, undefined);
});

test("runtime equivalence: for the fulfillment engine customerNotice equals the historical zone.label value (no behaviour change)", () => {
  for (const text of ["Texte A", null]) {
    const s = deliveryStatusFromFulfillmentResult(resolveDeliveryFulfillment([rule({ customerText: text })], "75011", 1, 30));
    assert.equal(s.customerNotice, s.zone?.label);
  }
});

test("active-engine bridge: legacy routing never yields customerNotice; fulfillment routing always carries it explicitly", () => {
  const legacy = resolveActiveDeliveryStatus(
    { status: "loaded", rules: [] },
    { zonePrefixes: ["75"], minItems: 0, areaLabel: "Paris" },
    "75011",
    1,
    30
  );
  assert.equal(legacy.status.zone?.label, "Paris");
  assert.equal("customerNotice" in legacy.status, false);
  const fulfillment = resolveActiveDeliveryStatus(
    { status: "loaded", rules: [rule({ customerText: "Sous 48 h." })] },
    { zonePrefixes: ["75"], minItems: 0, areaLabel: "Paris" },
    "75011",
    1,
    30
  );
  assert.equal(fulfillment.status.customerNotice, "Sous 48 h.");
});

test("structural: the notice resolver never reads zone / label / areaLabel from the delivery status (comments excluded)", () => {
  const src = readFileSync("lib/delivery-customer-notice.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.equal(/\.zone\b/.test(src), false, "must not read deliveryStatus.zone");
  assert.equal(/areaLabel/.test(src), false, "must not read areaLabel");
  assert.equal(/zone\?\.label|zone\.label/.test(src), false, "must not read zone.label");
  assert.ok(/deliveryStatus\.customerNotice/.test(src), "must read the explicit customerNotice field");
});

test("structural: only the fulfillment adapter populates customerNotice in lib/delivery.ts", () => {
  const src = readFileSync("lib/delivery.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const declarations = [...code.matchAll(/customerNotice\?\s*:/g)].length;
  const writes = [...code.matchAll(/customerNotice\s*:/g)].length;
  const writesFromRuleText = [...code.matchAll(/customerNotice:\s*result\.customerText\s*\?\?\s*null/g)].length;
  // 1 optional declaration in DeliveryStatus + exactly 2 writes, both in
  // deliveryStatusFromFulfillmentResult, both from the rule customer_text.
  assert.equal(declarations, 1);
  assert.equal(writes, 2);
  assert.equal(writesFromRuleText, 2);
});
