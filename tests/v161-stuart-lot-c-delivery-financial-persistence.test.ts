import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — STUART LOT C — DELIVERY FINANCIAL PERSISTENCE FOUNDATION v1.
// Couvre lib/server/delivery-financial-persistence.ts : l'enveloppe
// typée autour de la RPC service_role set_order_delivery_provider_
// financials. Patron déjà établi par ce dépôt
// (tests/v110b-payment-p3a1-service.test.ts) : t.mock.method(client,
// "rpc", ...) sur le client RÉEL construit par
// getServiceRoleSupabaseClient() (singleton paresseux partagé).
//
// Ce fichier ne teste PAS le calcul customerDeliveryFee/merchantSubsidy
// (déjà couvert exhaustivement par tests/v160-stuart-lot-b-delivery-
// pricing-policy.test.ts) -- seulement le CÂBLAGE : quels arguments
// partent vers la RPC, et que la RPC reste la SEULE autorité de
// persistance (mandat, "LOT C MUST NOT reimplement those
// calculations").
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "lotc-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { persistDeliveryProviderFinancials } = await import(
  "../lib/server/delivery-financial-persistence.ts"
);
const {
  DeliveryFinancialPersistenceRpcError,
  DeliveryFinancialPersistenceUnavailableError,
} = await import("../lib/server/delivery-financial-persistence-errors.ts");

test("persistDeliveryProviderFinancials: appelle EXACTEMENT set_order_delivery_provider_financials avec p_order_id/p_provider_cost/p_merchant_subsidy/p_currency, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return {
      data: [
        {
          order_id: "order-1",
          provider_cost: 8.4,
          delivery_merchant_subsidy: 3.4,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    };
  });

  const result = await persistDeliveryProviderFinancials({
    orderId: "order-1",
    policyResult: { providerCost: 8.4, merchantSubsidy: 3.4, currency: "EUR" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "set_order_delivery_provider_financials");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_currency",
    "p_merchant_subsidy",
    "p_order_id",
    "p_provider_cost",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, "order-1");
  assert.equal(args.p_provider_cost, 8.4);
  assert.equal(args.p_merchant_subsidy, 3.4);
  assert.equal(args.p_currency, "EUR");

  assert.deepEqual(result, {
    orderId: "order-1",
    providerCost: 8.4,
    merchantSubsidy: 3.4,
    updatedAt: "2026-01-01T00:00:00Z",
  });
});

test("persistDeliveryProviderFinancials: customerDeliveryFee n'existe même pas dans l'entrée -- ne peut structurellement pas être envoyé à la RPC (LOT C ne recalcule/ne retransmet jamais ce concept)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        order_id: "order-2",
        provider_cost: 5,
        delivery_merchant_subsidy: 0,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    error: null,
  }));

  const input = {
    orderId: "order-2",
    policyResult: { providerCost: 5, merchantSubsidy: 0, currency: "EUR" },
  };
  // Vérifie au niveau TYPE (compilation) : PersistDeliveryProviderFinancialsInput
  // n'accepte qu'un Pick<..., "providerCost" | "merchantSubsidy" | "currency">
  // -- customerDeliveryFee n'apparaît nulle part dans cette forme.
  assert.equal("customerDeliveryFee" in input.policyResult, false);

  await persistDeliveryProviderFinancials(input);
});

test("persistDeliveryProviderFinancials: une entrée artificielle (cast) portant orderTotal/deliveryFee n'est jamais transmise à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [
        {
          order_id: "order-3",
          provider_cost: 8.4,
          delivery_merchant_subsidy: 3.4,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    };
  });

  const maliciousInput = {
    orderId: "order-3",
    policyResult: { providerCost: 8.4, merchantSubsidy: 3.4, currency: "EUR" },
    // Champs qui n'existent PAS dans PersistDeliveryProviderFinancialsInput
    // -- simule un appelant compilé de façon laxiste / un cast `as any`.
    orderTotal: 999999,
    deliveryFee: 0.01,
  } as unknown as Parameters<typeof persistDeliveryProviderFinancials>[0];

  await persistDeliveryProviderFinancials(maliciousInput);

  assert.deepEqual(Object.keys(sentArgs!).sort(), [
    "p_currency",
    "p_merchant_subsidy",
    "p_order_id",
    "p_provider_cost",
  ]);
});

test("persistDeliveryProviderFinancials: erreur PostgREST (ex. snapshot déjà enregistré) -> DeliveryFinancialPersistenceRpcError générique, sqlstate interne conservé", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "42501", message: "SCANYM_DELIVERY_FINANCIALS: déjà enregistré (détail interne jamais exposé)" },
  }));

  await assert.rejects(
    () =>
      persistDeliveryProviderFinancials({
        orderId: "order-4",
        policyResult: { providerCost: 1, merchantSubsidy: 0, currency: "EUR" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof DeliveryFinancialPersistenceRpcError);
      assert.equal(err.sqlstate, "42501");
      assert.equal(err.message.includes("déjà enregistré"), false);
      assert.equal(err.message.includes("SCANYM_DELIVERY_FINANCIALS"), false);
      return true;
    }
  );
});

test("persistDeliveryProviderFinancials: ligne vide inattendue -> DeliveryFinancialPersistenceRpcError (pseudo-SQLSTATE), jamais un throw non typé", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));

  await assert.rejects(
    () =>
      persistDeliveryProviderFinancials({
        orderId: "order-5",
        policyResult: { providerCost: 1, merchantSubsidy: 0, currency: "EUR" },
      }),
    (err: unknown) => err instanceof DeliveryFinancialPersistenceRpcError
  );
});

test("persistDeliveryProviderFinancials: échec de transport (rpc() jette) -> DeliveryFinancialPersistenceUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("network down");
  });

  await assert.rejects(
    () =>
      persistDeliveryProviderFinancials({
        orderId: "order-6",
        policyResult: { providerCost: 1, merchantSubsidy: 0, currency: "EUR" },
      }),
    (err: unknown) => err instanceof DeliveryFinancialPersistenceUnavailableError
  );
});

test("persistDeliveryProviderFinancials: intégration avec le résultat réel de STUART LOT B (computeDeliveryPricingPolicy) -- providerCost/merchantSubsidy/currency transmis identiques, sans recalcul", async (t) => {
  const { computeDeliveryPricingPolicy } = await import("../lib/delivery-pricing-policy.ts");
  const policyResult = computeDeliveryPricingPolicy(
    {
      providerCost: 8.4,
      currency: "EUR",
      basketSubtotal: 29.99,
      merchantDeliveryPricingConfig: { pricingMode: "free_above_threshold", fixedFee: 5, freeThreshold: 30 },
    },
    "EUR"
  );
  assert.equal(policyResult.customerDeliveryFee, 5);
  assert.equal(policyResult.merchantSubsidy, 3.4);

  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return {
      data: [
        {
          order_id: "order-7",
          provider_cost: policyResult.providerCost,
          delivery_merchant_subsidy: policyResult.merchantSubsidy,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      error: null,
    };
  });

  await persistDeliveryProviderFinancials({ orderId: "order-7", policyResult });

  assert.equal(sentArgs!.p_provider_cost, 8.4);
  assert.equal(sentArgs!.p_merchant_subsidy, 3.4);
  assert.equal(sentArgs!.p_currency, "EUR");
});

// --------------------------------------------------------------
// [19-smoke] Isolation Payment/Monetico -- même discipline que STUART
// LOT B v1.1 (jamais de mention textuelle qui ferait un faux-positif
// sur une prose légitime -- uniquement des vérifications d'imports/
// symboles réellement couplés).
// --------------------------------------------------------------
test("[smoke] lib/server/delivery-financial-persistence.ts n'importe ni ne couple aucun module Payment/Monetico", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../lib/server/delivery-financial-persistence.ts", import.meta.url),
    "utf8"
  );
  assert.equal(/from\s+["']@\/lib\/server\/payment/i.test(src), false);
  assert.equal(/from\s+["'][^"']*monetico/i.test(src), false);
  assert.equal(src.includes("PaymentServerRpcError"), false);
  assert.equal(src.includes("initiate_payment_attempt"), false);
});

test("[smoke] le module de persistance financière LOT C n'appelle JAMAIS create_order (aucun couplage avec la création de commande, écriture strictement post-création) -- ne bannit pas la mention documentaire légitime du nom, seulement un appel .rpc(\"create_order\")", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../lib/server/delivery-financial-persistence.ts", import.meta.url),
    "utf8"
  );
  assert.equal(/\.rpc\(\s*["']create_order["']/.test(src), false);
});
