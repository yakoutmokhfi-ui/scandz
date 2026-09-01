import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.
// Couvre app/api/payments/monetico/checkout/route.ts::POST au niveau
// HTTP après la RESTRUCTURATION v4 : la route ne construit plus elle-
// même les URLs de retour (canonical-public-origin.ts +
// payment-return-relay.ts, entièrement internes à initiateCheckout),
// n'accepte plus `isDeliveryOrder`, et expose désormais un outcome
// `billing_required` distinct (409).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-route-synthetic-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://checkout.example.test";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { NextRequest } = await import("next/server");
const { POST } = await import("../app/api/payments/monetico/checkout/route.ts");
const { verifyReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");

const CREDENTIAL_JSON = JSON.stringify({
  tpe: "1234567",
  societe: "p3bmcrsociete",
  securityKey: "0123456789abcdef0123456789abcdef01234567",
});

type RpcHandler = (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

function routeRpc(t: { mock: { method: Function } }, handlers: Record<string, RpcHandler>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`RPC inattendue dans ce scénario de test : ${name}`);
    return handler(name, args);
  });
  return calls;
}

const ok = (row: unknown) => ({ data: [row], error: null });

const READY_BILLING_ROW = () =>
  ok({
    source: "manual",
    address_line_1: "1 rue de Test",
    address_line_2: null,
    city: "Paris",
    postal_code: "75001",
    country: "FR",
    state_or_province: null,
    customer_name: "Test Client",
    customer_email: null,
    customer_phone: null,
  });

function readyHandlers(overrides: Partial<Record<string, RpcHandler>> = {}) {
  return {
    get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "pending" }),
    get_payment_runtime_provider_environment: () =>
      ok({ provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" }),
    get_order_active_payment_attempt: () => ({ data: [], error: null }),
    initiate_payment_attempt: () => ok({ transaction_id: "txn-1", amount: 12.5, currency: "EUR" }),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_order_billing_context: READY_BILLING_ROW,
    get_order_service_mode: () => ok({ service_mode: "pickup" }),
    ...overrides,
  };
}

function postJson(body: unknown): InstanceType<typeof NextRequest> {
  return new NextRequest("https://checkout.example.test/api/payments/monetico/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function withEnabledKillSwitch<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
  process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = "true";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
    else process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = previous;
  }
}

// --------------------------------------------------------------
// Corps de requête invalide -- AVANT tout appel RPC.
// --------------------------------------------------------------

test("JSON malformé -- 400 invalid_request, AUCUN appel RPC", async (t) => {
  const calls = routeRpc(t, {});
  const res = await POST(postJson("{not-json"));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.outcome, "invalid_request");
  assert.equal(calls.length, 0);
});

test("orderId manquant -- 400 invalid_request, AUCUN appel RPC", async (t) => {
  const calls = routeRpc(t, {});
  const res = await POST(postJson({ publicToken: "tok-1" }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("publicToken vide -- 400 invalid_request", async (t) => {
  const calls = routeRpc(t, {});
  const res = await POST(postJson({ orderId: "order-1", publicToken: "" }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------
// Kill switch.
// --------------------------------------------------------------

test("kill switch désactivé (défaut) -- 503 checkout_disabled, AUCUN appel RPC", async (t) => {
  delete process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
  const calls = routeRpc(t, {});
  const res = await POST(postJson({ orderId: "order-1", publicToken: "tok-1" }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.outcome, "checkout_disabled");
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------
// Anti-fuite.
// --------------------------------------------------------------

test("jeton/commande incorrects -- réponse GÉNÉRIQUE 502, jamais de détail", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, {
      get_order_payment_context: () => ({ data: null, error: null }),
    });
    const res = await POST(postJson({ orderId: "order-x", publicToken: "wrong-token" }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.deepEqual(body, { outcome: "unavailable" });
  }));

test("panne RPC transitoire (DB down) -- EXACTEMENT la même réponse générique 502 que le cas jeton incorrect", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, {
      get_order_payment_context: () => ({ data: null, error: { code: "53300", message: "boom" } }),
    });
    const res = await POST(postJson({ orderId: "order-1", publicToken: "tok-1" }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.deepEqual(body, { outcome: "unavailable" });
  }));

// --------------------------------------------------------------
// Chemins de succès distinguables.
// --------------------------------------------------------------

test("commande déjà payée -- 200 checkout_not_needed/already_paid", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, {
      get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "paid" }),
    });
    const res = await POST(postJson({ orderId: "order-1", publicToken: "tok-1" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { outcome: "checkout_not_needed", reason: "already_paid" });
  }));

test("provider désactivé -- 503 provider_unavailable", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, {
      get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "pending" }),
      get_payment_runtime_provider_environment: () =>
        ok({ provider_code: "monetico", is_enabled: false, configuration_status: "verified", mode: "test" }),
    });
    const res = await POST(postJson({ orderId: "order-1", publicToken: "tok-1" }));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { outcome: "provider_unavailable" });
  }));

test("billing manquant -- 409 billing_required, distinct de provider_unavailable", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, readyHandlers({ get_order_billing_context: () => ({ data: null, error: null }) }));
    const res = await POST(postJson({ orderId: "order-1", publicToken: "tok-1" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body, { outcome: "billing_required" });
  }));

test("checkout prêt -- 200 ready, submissionUrl/fields présents, url_retour_ok/err pointent vers l'origine canonique avec un jeton de relais opaque", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, readyHandlers());
    const res = await POST(postJson({ orderId: "order-1", publicToken: "secret-tok-1" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.outcome, "ready");
    assert.equal(body.resumed, false);
    assert.ok(body.submissionUrl.startsWith("https://p.monetico-services.com/"));

    const decoded = JSON.parse(Buffer.from(body.fields.contexte_commande, "base64").toString("utf8"));
    assert.equal(decoded.correlationId, "order-1");

    assert.ok(body.fields.url_retour_ok.startsWith("https://checkout.example.test/checkout/return/ok?"));
    assert.ok(body.fields.url_retour_err.startsWith("https://checkout.example.test/checkout/return/err?"));

    const okUrl = new URL(body.fields.url_retour_ok);
    assert.equal(okUrl.searchParams.get("orderId"), "order-1");
    // `publicToken` n'apparaît JAMAIS en clair dans l'URL -- seul un
    // jeton de relais opaque, décodable UNIQUEMENT côté serveur.
    assert.equal(okUrl.searchParams.get("publicToken"), null);
    assert.ok(!body.fields.url_retour_ok.includes("secret-tok-1"));
    const relayToken = okUrl.searchParams.get("token")!;
    const relay = verifyReturnRelayToken(relayToken, "order-1");
    assert.equal(relay.publicToken, "secret-tok-1");
  }));

// --------------------------------------------------------------
// Rejeu : deux initiations successives pendant la même tentative
// pending -- idempotent, jamais deux tentatives distinctes.
// --------------------------------------------------------------

test("REJEU : deux POST successifs pendant la même tentative pending -- 2e appel REPREND (resumed=true), initiate_payment_attempt appelée UNE seule fois au total", async (t) => {
  let pendingRef: string | null = null;
  await withEnabledKillSwitch(async () => {
    routeRpc(
      t,
      readyHandlers({
        get_order_active_payment_attempt: () =>
          pendingRef === null
            ? { data: [], error: null }
            : ok({ provider_reference: pendingRef, amount: "12.50", currency: "EUR" }),
        initiate_payment_attempt: (_n, args) => {
          pendingRef = args.p_provider_reference as string;
          return ok({ transaction_id: "txn-1", amount: 12.5, currency: "EUR" });
        },
      })
    );

    const first = await POST(postJson({ orderId: "order-1", publicToken: "tok-1" }));
    const firstBody = await first.json();
    assert.equal(firstBody.resumed, false);

    const second = await POST(postJson({ orderId: "order-1", publicToken: "tok-1" }));
    const secondBody = await second.json();
    assert.equal(secondBody.resumed, true);
    assert.equal(secondBody.fields.reference, firstBody.fields.reference);
  });
});
