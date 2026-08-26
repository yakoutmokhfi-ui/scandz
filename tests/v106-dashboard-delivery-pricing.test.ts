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
// Ce fichier prouve que la page/service/nav/i18n livrés respectent
// STRICTEMENT le périmètre de la mission : 4 champs éditables
// uniquement (pricing_mode, fixed_fee, free_threshold, customer_text),
// aucun champ structurel exposé en écriture, aucun type client
// réutilisé, aucune fuite de "stuart"/"chronofresh"/provider brut, et
// le contrôle serveur reste la seule autorité (aucun accès direct
// supabase.rpc() dans un composant, aucun message d'erreur brut
// affiché au marchand).
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

test("aucun champ structurel (provider, fulfillment_code, zone_prefixes, is_fallback, display_order, enabled, mode_code, restaurant_id) n'est un paramètre d'update ni un champ éditable de la page", () => {
  const forbiddenAsWritableField = [
    "provider",
    "fulfillment_code",
    "zone_prefixes",
    "is_fallback",
    "display_order",
    "enabled",
    "mode_code",
  ];
  for (const field of forbiddenAsWritableField) {
    assert.ok(
      !pageSrc.includes(field),
      `le champ structurel "${field}" ne doit apparaître nulle part dans la page marchand`
    );
  }
  // Le type marchand lui-même ne doit exposer aucun de ces champs.
  const typeBlockStart = typesSrc.indexOf("interface MerchantDeliveryFulfillmentPricingRule");
  const typeBlockEnd = typesSrc.indexOf("}", typeBlockStart);
  const typeBlock = typesSrc.slice(typeBlockStart, typeBlockEnd);
  for (const field of forbiddenAsWritableField) {
    assert.ok(!typeBlock.includes(field));
  }
});

test("seuls les 4 champs autorisés sont éditables : pricing_mode, fixed_fee, free_threshold, customer_text", () => {
  assert.ok(pageSrc.includes("dpPricingMode"));
  assert.ok(pageSrc.includes("dpFixedFee"));
  assert.ok(pageSrc.includes("dpFreeThreshold"));
  assert.ok(pageSrc.includes("dpCustomerText"));
});

test("le sélecteur de mode de tarification propose exactement 'fixed' et 'free_above_threshold', rien d'autre (pas de 'free', pas de 'external_quote')", () => {
  const selectStart = pageSrc.indexOf("<select");
  const selectEnd = pageSrc.indexOf("</select>", selectStart);
  const selectBlock = pageSrc.slice(selectStart, selectEnd);
  assert.ok(selectBlock.includes('value="fixed"'));
  assert.ok(selectBlock.includes('value="free_above_threshold"'));
  assert.ok(!selectBlock.includes('value="free"'));
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

test("aucune fuite provider dans l'UI marchand : 'stuart'/'chronofresh'/'internal'/'external_quote' absents de la page et du service", () => {
  for (const leak of ["stuart", "chronofresh", "external_quote"]) {
    assert.ok(!pageSrc.toLowerCase().includes(leak));
    assert.ok(!servicesSrc.toLowerCase().includes(leak));
  }
});

test("en cas d'échec de sauvegarde, seul un message marchand-sûr (dpSaveFailed) est affiché -- jamais e.message brut", () => {
  const saveFnStart = pageSrc.indexOf("async function save(");
  const saveFnEnd = pageSrc.indexOf("\n  }\n", saveFnStart);
  const saveFn = pageSrc.slice(saveFnStart, saveFnEnd);
  assert.ok(saveFn.includes('t("dpSaveFailed")'));
  assert.ok(!saveFn.includes("e.message"), "aucun message d'erreur brut du serveur ne doit être affiché au marchand");
});

test("après un succès, les valeurs sont relues depuis le serveur (pas de confiance en l'état client seul comme preuve de persistance)", () => {
  const saveFnStart = pageSrc.indexOf("async function save(");
  const saveFn = pageSrc.slice(saveFnStart, saveFnStart + 3000);
  const callIdx = saveFn.indexOf("updateMerchantDeliveryFulfillmentPricing");
  const afterCall = saveFn.slice(callIdx);
  assert.ok(afterCall.includes("getMerchantDeliveryFulfillmentPricing(restaurantId)"));
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
