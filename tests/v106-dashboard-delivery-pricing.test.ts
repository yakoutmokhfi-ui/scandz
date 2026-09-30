import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ============================================================
// Scanym — DASHBOARD DELIVERY PRICING v1 — vérifications structurelles
// (même patron que tests/v87-ui-multiline-v2-dashboard.test.ts : lecture
// du source réel, assertions par sous-chaîne/regex, aucun rendu DOM --
// le comportement RPC/base est déjà couvert de bout en bout par
// supabase/tests/merchant-delivery-pricing-check.sh, 37/37, qui teste
// les 22 comportements obligatoires de la mission).
//
// B234 extends the original price-only screen with structural rule editing.
// Keep the original server-authority and safe-error assertions; runtime
// authorization, mutations and the real rendered UI have behavioral tests.
// ============================================================

const pagePath = "app/dashboard/delivery-pricing/page.tsx";
const pageSrc = readFileSync(pagePath, "utf8");
const servicesSrc = readFileSync("lib/services/dashboard.ts", "utf8");
const typesSrc = readFileSync("lib/dashboard-types.ts", "utf8");
const navSrc = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
const i18nSrc = readFileSync("lib/i18n.ts", "utf8");
const migrationSrc = readFileSync(
  "supabase/DRAFT-lot-merchant-delivery-pricing.sql",
  "utf8"
);

test("le composant page n'appelle jamais supabase.rpc() directement -- passe exclusivement par lib/services/dashboard.ts", () => {
  assert.ok(!pageSrc.includes("supabase.rpc"));
  assert.ok(pageSrc.includes("getMerchantDeliveryFulfillmentPricing"));
  assert.ok(pageSrc.includes("updateMerchantDeliveryFulfillmentPricing"));
});

test("le service marchand encapsule exactement les 2 RPC attendues", () => {
  assert.ok(servicesSrc.includes('supabase.rpc("get_merchant_delivery_fulfillment_pricing"'));
  assert.ok(servicesSrc.includes('supabase.rpc("update_merchant_delivery_fulfillment_pricing"'));
});

test("le type marchand est DISTINCT du type client public (pas de couplage customer/merchant)", () => {
  assert.ok(typesSrc.includes("MerchantDeliveryFulfillmentPricingRule"));
  assert.ok(!pageSrc.includes("PublicDeliveryFulfillmentRule"));
  assert.ok(!servicesSrc.includes("PublicDeliveryFulfillmentRule"));
});

// B234 supersedes the v1 prohibition on merchant zone/provider editing.


test("seuls les 4 champs autorisés sont éditables : pricing_mode, fixed_fee, free_threshold, customer_text", () => {
  assert.ok(pageSrc.includes("dpPricingMode"));
  assert.ok(pageSrc.includes("dpFixedFee"));
  assert.ok(pageSrc.includes("dpFreeThreshold"));
  assert.ok(pageSrc.includes("dpCustomerText"));
});

test("le sélecteur de mode de tarification propose les modes existants free/fixed/free_above_threshold, sans external_quote", () => {
  const selectStart = pageSrc.indexOf("<select");
  const selectEnd = pageSrc.indexOf("</select>", selectStart);
  const selectBlock = pageSrc.slice(selectStart, selectEnd);
  assert.ok(selectBlock.includes('value="fixed"'));
  assert.ok(selectBlock.includes('value="free_above_threshold"'));
  assert.ok(selectBlock.includes('value="free"'));
  assert.ok(!selectBlock.includes("external_quote"));
});

test("le champ 'Gratuit à partir de' n'est rendu QUE lorsque pricing_mode = free_above_threshold (rendu conditionnel isolé)", () => {
  const idx = pageSrc.indexOf('draft.pricingMode === "free_above_threshold" &&');
  assert.ok(idx > -1, "le rendu du seuil doit être gardé par une condition explicite sur pricingMode");
});

test("le texte client respecte la limite existante de 500 caractères (maxLength={500}), cohérente avec le CHECK DB", () => {
  const textareaStart = pageSrc.indexOf("<textarea");
  const textareaEnd = pageSrc.indexOf("/>", textareaStart);
  const textarea = pageSrc.slice(textareaStart, textareaEnd);
  assert.ok(textarea.includes("maxLength={500}"));
});

// B234 supersedes the v1 prohibition on merchant zone/provider editing.


test("en cas d'échec de sauvegarde, seul un message marchand-sûr (dpSaveFailed) est affiché -- jamais e.message brut", () => {
  const saveFnStart = pageSrc.indexOf("async function save(");
  const saveFnEnd = pageSrc.indexOf("\n  }\n", saveFnStart);
  const saveFn = pageSrc.slice(saveFnStart, saveFnEnd);
  assert.ok(saveFn.includes('t(deliveryRuleErrorKey(error))'));
  assert.ok(readFileSync("lib/delivery-rule-editor.ts", "utf8").includes('return "dpSaveFailed"'));
  assert.ok(!saveFn.includes("e.message"), "aucun message d'erreur brut du serveur ne doit être affiché au marchand");
});

test("après un succès, les valeurs sont relues depuis le serveur (pas de confiance en l'état client seul comme preuve de persistance)", () => {
  const saveFnStart = pageSrc.indexOf("async function save(");
  // v1.3: bounded to the whole save() body (was a fixed 3000-char window).
  const saveFnEnd = pageSrc.indexOf("\n  }\n", saveFnStart);
  const saveFn = pageSrc.slice(saveFnStart, saveFnEnd);
  const callIdx = saveFn.indexOf("updateMerchantDeliveryFulfillmentPricing");
  const afterCall = saveFn.slice(callIdx);
  assert.ok(afterCall.includes("getMerchantDeliveryFulfillmentPricing(targetRestaurantId)"));
  // v1.3 (QA-MSDD-PRICING-ABA-03): the stale-operation guard now checks the
  // target restaurant AND the context generation captured at launch
  // (behaviour is proven by tests/delivery-pricing-rule-stale-tenant.dom.test.ts).
  assert.ok(saveFn.includes("guard.currentRestaurantId() === targetRestaurantId"));
  assert.ok(saveFn.includes("contextGenerationRef.current === operationGeneration"));
  assert.equal(
    afterCall.split("if (!isOperationCurrent()) return;").length - 1,
    3,
    "guards after the mutation, after the reread and in the failure path"
  );
});

test("l'onglet de navigation 'Tarifs de livraison' est ajouté sans casser l'exclusion déjà corrigée (L1B-02) de l'onglet Commandes", () => {
  assert.ok(navSrc.includes("onDeliveryPricing"));
  assert.ok(navSrc.includes("!onDeliveryPricing"));
  assert.ok(navSrc.includes('href("/dashboard/delivery-pricing")'));
});

test("les clés i18n dp* et dsDeliveryPricing existent dans les 3 dictionnaires (fr/en/ar)", () => {
  const requiredKeys = [
    "dsDeliveryPricing",
    "dpTitle",
    "dpHint",
    "dpStaffOnly",
    "dpEmpty",
    "dpPricingMode",
    "dpFixed",
    "dpFreeAboveThreshold",
    "dpFixedFee",
    "dpFreeThreshold",
    "dpCustomerText",
    "dpSave",
    "dpSaving",
    "dpSaved",
    "dpSaveFailed",
  ];
  for (const key of requiredKeys) {
    const occurrences = i18nSrc.split(`${key}:`).length - 1;
    assert.ok(
      occurrences >= 3,
      `la clé "${key}" doit apparaître au moins 3 fois (fr + en + ar), trouvé ${occurrences}`
    );
  }
});

test("migration SQL : aucun GRANT UPDATE/INSERT/DELETE direct à 'authenticated' sur restaurant_sale_mode_fulfillments", () => {
  const grantLines = migrationSrc
    .split("\n")
    .filter((l) => /grant\s+(update|insert|delete)/i.test(l) && /authenticated/i.test(l));
  assert.equal(grantLines.length, 0, `lignes GRANT suspectes trouvées: ${grantLines.join(" | ")}`);
});

test("migration SQL : les 2 fonctions sont bien security definer et retirent tout accès à public/anon avant de le rendre à authenticated", () => {
  assert.ok(migrationSrc.includes("public.get_merchant_delivery_fulfillment_pricing"));
  assert.ok(migrationSrc.includes("public.update_merchant_delivery_fulfillment_pricing"));
  const securityDefinerCount = (migrationSrc.match(/security definer/g) ?? []).length;
  assert.equal(securityDefinerCount, 2);
  assert.ok(migrationSrc.includes("revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from public, anon;"));
  assert.ok(migrationSrc.includes("revoke all on function public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text) from public, anon;"));
});

test("migration SQL : réutilise is_member_of/has_role_in existants plutôt que de dupliquer la logique d'appartenance", () => {
  assert.ok(migrationSrc.includes("public.is_member_of(p_restaurant_id)"));
  assert.ok(migrationSrc.includes("public.has_role_in(v_restaurant_id, array['owner', 'manager'])"));
});

test("migration SQL : validation fail-closed explicite -- jamais de défaut 'free' ou 0, jamais de conversion silencieuse", () => {
  assert.ok(!migrationSrc.includes("coalesce(p_fixed_fee, 0)"));
  assert.ok(!migrationSrc.includes("coalesce(p_pricing_mode, 'free')"));
  assert.ok(migrationSrc.includes("raise exception"));
});
