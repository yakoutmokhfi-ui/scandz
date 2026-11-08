import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "synthetic-return-navigation-test-key";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??= "ab".repeat(32);
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION = "1";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const { getPublicSupabaseClient } = await import("../lib/server/supabase-public.ts");
const { createReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");
const { resolvePaymentReturnStatus } = await import("../app/checkout/return/shared.ts");
const { getPaymentReturnMerchantPath } = await import("../lib/server/payment-return-merchant.ts");
const client = getServiceRoleSupabaseClient();
const publicClient = getPublicSupabaseClient();
const orderId = "11111111-1111-4111-8111-111111111111";
const publicToken = "22222222-2222-4222-8222-222222222222";
const restaurantId = "33333333-3333-4333-8333-333333333333";
const capabilityId = "44444444-4444-4444-8444-444444444444";
const secret = "12".repeat(32);
const relay = () => createReturnRelayToken({ orderId, publicToken, ttlSeconds: 600 });

function backend(t: TestContext, slug: string, paymentStatus = "paid", missingMerchant = false) {
  const calls: string[] = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    assert.equal(args.p_order_id, orderId);
    if (name === "issue_order_return_tracking_capability") {
      return { data: [{ capability_id: capabilityId, capability_secret: secret }], error: null };
    }
    assert.equal(args.p_public_token, publicToken, "chaque lecture de contexte conserve la preuve de possession");
    if (name === "get_order_payment_status_snapshot") {
      return { data: [{ payment_status: paymentStatus, provider_code: "monetico", has_observed_refusal: false, last_refusal_at: null }], error: null };
    }
    if (name === "get_order_payment_context") {
      return { data: [{ restaurant_id: restaurantId, payment_status: paymentStatus }], error: null };
    }
    throw Error("RPC non autorisée dans la fixture");
  });
  // Production : service_role a EXECUTE sur les RPC, mais pas SELECT sur
  // restaurants. L'ancien correctif ignorait cette séparation des droits.
  t.mock.method(client, "from", (() => {
    throw new Error("42501: permission denied for table restaurants");
  }) as any);
  t.mock.method(publicClient, "from", ((table: string) => {
    assert.equal(table, "restaurants");
    calls.push(table);
    return { select(columns: string) {
      assert.equal(columns, "slug");
      return { eq(key: string, value: string) {
        assert.equal(key, "id");
        assert.equal(value, restaurantId, "le marchand provient de la commande et non de l'URL navigateur");
        return { async single() { return { data: missingMerchant ? null : { slug }, error: null }; } };
      } };
    } };
  }) as any);
  return calls;
}

test("retour payé : boutique de la commande vérifiée et lien de suivi réutilisable", async (t) => {
  const calls = backend(t, "au-lait-cru");
  const result = await resolvePaymentReturnStatus({ orderId, token: relay(), slug: "autre-boutique", returnUrl: "https://attacker.example" });
  assert.deepEqual(result, { kind: "paid", merchantPath: "https://shop.scanym.com/au-lait-cru", trackingPath: `/track/${orderId}#c1.${capabilityId}.${secret}` });
  assert.deepEqual(calls, ["get_order_payment_status_snapshot", "get_order_payment_context", "restaurants", "issue_order_return_tracking_capability"]);
});

test("autre marchand : destination propre à son slug, aucun nom de boutique fixé dans le composant", async (t) => {
  backend(t, "boutique-b", "pending");
  const result = await resolvePaymentReturnStatus({ orderId, token: relay() });
  assert.equal(result.kind, "pending", "une navigation n'invente jamais un paiement confirmé");
  assert.equal(result.merchantPath, "/r/boutique-b");
});

test("lecture du marchand indisponible : paiement et suivi restent utilisables", async (t) => {
  backend(t, "boutique-b", "paid", true);
  const result = await resolvePaymentReturnStatus({ orderId, token: relay() });
  assert.equal(result.kind, "paid");
  assert.equal(result.merchantPath, undefined);
  assert.equal(result.trackingPath, `/track/${orderId}#c1.${capabilityId}.${secret}`);
});

test("relais invalide : aucune lecture ni destination de marchand", async (t) => {
  const calls = backend(t, "boutique-b");
  assert.deepEqual(await resolvePaymentReturnStatus({ orderId, token: "invalid", slug: "au-lait-cru" }), { kind: "unavailable" });
  assert.deepEqual(calls, []);
});

test("preuve malformée : le lecteur marchand ne touche pas à la base", async (t) => {
  const calls = backend(t, "boutique-b");
  assert.equal(await getPaymentReturnMerchantPath({ orderId, publicToken: "invalid" }), null);
  assert.deepEqual(calls, []);
});

test("lecture publique : aucune session, aucun renouvellement ni détection de jeton URL", () => {
  const auth = publicClient.auth as unknown as Record<string, unknown>;
  assert.equal(auth.persistSession, false);
  assert.equal(auth.autoRefreshToken, false);
  assert.equal(auth.detectSessionInUrl, false);
});

test("contexte refusé : aucune lecture publique de boutique", async (t) => {
  const calls = backend(t, "boutique-b");
  t.mock.method(client, "rpc", async () => ({ data: null, error: { code: "42501" } }));
  assert.equal(await getPaymentReturnMerchantPath({ orderId, publicToken }), null);
  assert.deepEqual(calls, []);
});

test("boutique cachée ou lecture publique refusée : repli sans modifier le paiement", async (t) => {
  backend(t, "boutique-b");
  t.mock.method(publicClient, "from", (() => ({
    select: () => ({ eq: () => ({ single: async () => ({
      data: null, error: { code: "42501" },
    }) }) }),
  })) as any);
  const result = await resolvePaymentReturnStatus({ orderId, token: relay() });
  assert.equal(result.kind, "paid");
  assert.equal(result.merchantPath, undefined);
  assert.equal(result.trackingPath, `/track/${orderId}#c1.${capabilityId}.${secret}`);
});
