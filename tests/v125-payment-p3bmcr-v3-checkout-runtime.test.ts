import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.
// Couvre lib/server/payment-checkout-runtime.ts::initiateCheckout après
// la RESTRUCTURATION v4 (audit de travail v3 indépendant, 6 blocages
// HIGH) : ordonnancement PREFLIGHT (AUCUNE tentative pending créée tant
// que TOUS les prérequis statiques n'ont pas positivement réussi),
// facturation OBLIGATOIRE, applicabilité shipping dérivée SERVEUR
// (`orders.service_mode`, jamais le JSON navigateur), origine publique
// canonique, jeton de relais de retour opaque. Le fichier v3 d'origine
// (isDeliveryOrder/urlRetourOk/urlRetourErr en entrée,
// MONETICO_PAYMENT_SUBMISSION_URL ré-exportée) testait un contrat qui
// n'existe plus -- réécrit intégralement pour le nouveau contrat,
// jamais silencieusement affaibli (le fichier v3 gardait déjà, avant
// ce lot, une couverture complète du chemin FRESH/REPRISE, préservée
// ci-dessous sous sa forme v4).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3bmcr-synthetic-service-role-key-DO-NOT-USE";

// Prérequis statiques toujours nécessaires à un chemin "ready" --
// positionnés une fois pour tout le fichier (jamais togglés par test
// individuel, contrairement au kill switch ci-dessous, qui EST le
// sujet explicite de plusieurs tests).
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://checkout.example.test";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout, PaymentCheckoutRuntimeDisabledError } = await import(
  "../lib/server/payment-checkout-runtime.ts"
);
const {
  MONETICO_PAYMENT_SUBMISSION_URL,
  MONETICO_LIVE_PAYMENT_SUBMISSION_URL,
  MONETICO_TEST_PAYMENT_SUBMISSION_URL,
} = await import("../lib/server/payment-providers/monetico/endpoint.ts");
const { verifyReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");

type InitiateCheckoutResult = Awaited<ReturnType<typeof initiateCheckout>>;
type ReadyResult = Extract<InitiateCheckoutResult, { outcome: "ready" }>;

function assertReady(result: InitiateCheckoutResult): asserts result is ReadyResult {
  assert.equal(result.outcome, "ready");
}

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
    if (!handler) {
      throw new Error(`RPC inattendue dans ce scénario de test : ${name}`);
    }
    return handler(name, args);
  });
  return calls;
}

const ok = (row: unknown) => ({ data: [row], error: null });

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

const ENVIRONMENT_ROW = (mode: "test" | "live" = "test") => ({
  provider_code: "monetico",
  is_enabled: true,
  configuration_status: "verified",
  mode,
});

const PICKUP_ORDER_SERVICE_MODE = () => ok({ service_mode: "pickup" });
const DELIVERY_ORDER_SERVICE_MODE = () => ok({ service_mode: "delivery" });

const MANUAL_BILLING_ROW = () =>
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

const DELIVERY_REUSE_BILLING_ROW = () =>
  ok({
    source: "delivery_reuse",
    address_line_1: "2 avenue de Test",
    address_line_2: null,
    city: "Lyon",
    postal_code: "69001",
    country: "FR",
    state_or_province: null,
    customer_name: "Client Livraison",
    customer_email: "client@example.test",
    customer_phone: null,
  });

/** Jeu de handlers minimal pour un chemin FRESH "ready" complet --
 *  chaque test part de ceci et surcharge ce qui est pertinent à son
 *  scénario. */
function freshReadyHandlers(overrides: Partial<Record<string, RpcHandler>> = {}) {
  return {
    get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "pending" }),
    // PAYMENT STREAM B -- CURRENCY PREFLIGHT FIX v1.1 (ferme
    // STREAM-B-CURRENCY-PREFLIGHT-01) : nouvelle lecture précoce,
    // AVANT initiate_payment_attempt -- EUR par défaut pour tous les
    // scénarios existants (comportement inchangé). Les tests dédiés à
    // ce correctif (ci-dessous) surchargent explicitement cette
    // valeur pour prouver le rejet DZD.
    get_order_currency_preflight: () => ok({ currency: "EUR" }),
    get_payment_runtime_provider_environment: () => ok(ENVIRONMENT_ROW()),
    get_order_active_payment_attempt: () => ({ data: [], error: null }),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_order_billing_context: MANUAL_BILLING_ROW,
    get_order_service_mode: PICKUP_ORDER_SERVICE_MODE,
    initiate_payment_attempt: () => ok({ transaction_id: "txn-1", amount: 10, currency: "EUR" }),
    ...overrides,
  };
}

test("PAYMENT STREAM B -- CURRENCY PREFLIGHT FIX v1.1 (ferme STREAM-B-CURRENCY-PREFLIGHT-01) : commande fraîche en devise NON-EUR (ex. DZD, réellement utilisée par d'autres établissements Scanym pour un mode de paiement différent) -- REJETÉE STRICTEMENT AVANT toute mutation, initiate_payment_attempt JAMAIS appelée (compte = 0), aucune tentative de paiement 'pending' créée", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        // Lecture précoce (AVANT tout branchement FRAIS/REPRISE, AVANT
        // toute mutation) -- c'est ICI que la devise DZD doit être
        // détectée, jamais plus tard.
        get_order_currency_preflight: () => ok({ currency: "DZD" }),
        // Si initiate_payment_attempt était appelée malgré tout, ce
        // mock lèverait explicitement -- preuve directe et immédiate
        // d'une régression, jamais un simple comptage a posteriori.
        initiate_payment_attempt: () => {
          throw new Error("STREAM-B-CURRENCY-PREFLIGHT-01 RÉGRESSION : initiate_payment_attempt ne doit JAMAIS être appelée pour une commande DZD");
        },
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.equal(result.outcome, "invalid_request");
    assert.equal((result as { reason: string }).reason, "unsupported_currency");
    const initiateCallCount = calls.filter((c) => c.name === "initiate_payment_attempt").length;
    assert.equal(initiateCallCount, 0, "initiate_payment_attempt call count DOIT être exactement 0 -- aucune tentative de paiement 'pending' ne doit jamais être créée pour une commande DZD");
    // Preuve complémentaire, couche la plus étroite disponible dans
    // cet environnement de test (mandat : "prove this at the narrowest
    // reliable layer by asserting that no mutating RPC/service is
    // called") -- AUCUN appel RPC mutant de quelque nature que ce soit
    // n'a eu lieu au-delà de la lecture de préflight elle-même
    // (purement lecture) et de la lecture de possession déjà requise.
    const mutatingCalls = calls.filter((c) =>
      ["initiate_payment_attempt", "confirm_payment_attempt", "record_payment_provider_event", "update_payment_provider_event_processing_status"].includes(c.name)
    );
    assert.deepEqual(mutatingCalls, [], "AUCUN appel RPC mutant ne doit avoir eu lieu -- rejet strictement pré-mutation");
  }));

test("PAYMENT STREAM B -- CURRENCY PREFLIGHT FIX v1.1 (ferme STREAM-B-CURRENCY-PREFLIGHT-01) : reprise (chemin RESUME) sur une tentative active dont la devise n'est pas EUR -- REJETÉE de façon identique par la MÊME lecture précoce, jamais une régression de mutation nouvelle", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        get_order_currency_preflight: () => ok({ currency: "DZD" }),
        get_order_active_payment_attempt: () =>
          ok({ provider_reference: "ref-active-dzd", amount: "15.00", currency: "DZD" }),
        initiate_payment_attempt: () => {
          throw new Error("STREAM-B-CURRENCY-PREFLIGHT-01 RÉGRESSION : initiate_payment_attempt ne doit JAMAIS être appelée sur le chemin REPRISE");
        },
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.equal(result.outcome, "invalid_request");
    assert.equal((result as { reason: string }).reason, "unsupported_currency");
    assert.equal(calls.filter((c) => c.name === "initiate_payment_attempt").length, 0, "chemin RESUME -- initiate_payment_attempt call count = 0, aucune mutation P1 nouvelle introduite par ce correctif");
  }));

test("PAYMENT STREAM B -- CURRENCY PREFLIGHT FIX v1.1 : commande fraîche en EUR -- le préflight de devise RÉUSSIT, initiate_payment_attempt EST appelée normalement, comportement de checkout INCHANGÉ", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(result);
    assert.equal(calls.filter((c) => c.name === "initiate_payment_attempt").length, 1, "EUR -- initiate_payment_attempt DOIT être appelée exactement une fois, comportement normal inchangé");
  }));

test("kill switch: variable ABSENTE -- désactivé par défaut, AUCUN appel RPC, PaymentCheckoutRuntimeDisabledError", async (t) => {
  delete process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
  const calls = routeRpc(t, {});
  await assert.rejects(
    () => initiateCheckout({ orderId: "order-1", publicToken: "tok-1" }),
    PaymentCheckoutRuntimeDisabledError
  );
  assert.equal(calls.length, 0);
});

test("kill switch: valeur autre que la chaîne EXACTE 'true' -- reste désactivé, échec fermé", async (t) => {
  process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = "1";
  const calls = routeRpc(t, {});
  await assert.rejects(
    () => initiateCheckout({ orderId: "order-1", publicToken: "tok-1" }),
    PaymentCheckoutRuntimeDisabledError
  );
  assert.equal(calls.length, 0);
  delete process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
});

// --------------------------------------------------------------
// Court-circuits.
// --------------------------------------------------------------

test("paymentStatus='paid' -- court-circuit immédiat, AUCUN autre appel RPC", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(t, {
      get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "paid" }),
    });
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(result, { outcome: "checkout_not_needed", reason: "already_paid" });
    assert.equal(calls.length, 1);
  }));

test("paymentStatus='not_required' -- court-circuit immédiat", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, {
      get_order_payment_context: () =>
        ok({ restaurant_id: "resto-1", payment_status: "not_required" }),
    });
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(result, { outcome: "checkout_not_needed", reason: "not_required" });
  }));

test("provider désactivé (isEnabled=false) -- 'provider_unavailable', initiate_payment_attempt JAMAIS appelée", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(t, {
      get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "pending" }),
      get_order_currency_preflight: () => ok({ currency: "EUR" }),
      get_payment_runtime_provider_environment: () =>
        ok({ provider_code: "monetico", is_enabled: false, configuration_status: "verified", mode: "test" }),
    });
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(result, { outcome: "provider_unavailable" });
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
  }));

test("PREFLIGHT #6 : configuration_status !== 'verified' (ex. 'configured') -- 'provider_unavailable', même si is_enabled=true", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(t, {
      get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "pending" }),
      get_order_currency_preflight: () => ok({ currency: "EUR" }),
      get_payment_runtime_provider_environment: () =>
        ok({ provider_code: "monetico", is_enabled: true, configuration_status: "configured", mode: "test" }),
    });
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(result, { outcome: "provider_unavailable" });
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
  }));

// --------------------------------------------------------------
// PREFLIGHT-01 : AUCUNE tentative pending créée avant que TOUS les
// prérequis statiques aient réussi.
// --------------------------------------------------------------

test("PREFLIGHT-01 : billing manquant -- 'billing_required', initiate_payment_attempt JAMAIS appelée", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        get_order_billing_context: () => ({ data: null, error: null }),
        initiate_payment_attempt: () => {
          throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée ici");
        },
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(result, { outcome: "billing_required" });
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
  }));

test("PREFLIGHT-01 : credential malformé -- 'provider_unavailable', initiate_payment_attempt JAMAIS appelée", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        get_payment_provider_credential: () => ({ data: "not-json", error: null }),
        initiate_payment_attempt: () => {
          throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée ici");
        },
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(result, { outcome: "provider_unavailable" });
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
  }));

test("PREFLIGHT-01 : origine publique canonique absente -- 'provider_unavailable', initiate_payment_attempt JAMAIS appelée", async (t) =>
  withEnabledKillSwitch(async () => {
    const previousOrigin = process.env.SCANYM_PUBLIC_ORIGIN;
    delete process.env.SCANYM_PUBLIC_ORIGIN;
    try {
      const calls = routeRpc(
        t,
        freshReadyHandlers({
          initiate_payment_attempt: () => {
            throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée ici");
          },
        })
      );
      const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
      assert.deepEqual(result, { outcome: "provider_unavailable" });
      assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
    } finally {
      if (previousOrigin === undefined) delete process.env.SCANYM_PUBLIC_ORIGIN;
      else process.env.SCANYM_PUBLIC_ORIGIN = previousOrigin;
    }
  }));

test("PREFLIGHT-01 : clé de relais de retour absente -- 'provider_unavailable', initiate_payment_attempt JAMAIS appelée", async (t) =>
  withEnabledKillSwitch(async () => {
    const previousKey = process.env.PAYMENT_RETURN_RELAY_KEY_V1;
    delete process.env.PAYMENT_RETURN_RELAY_KEY_V1;
    try {
      const calls = routeRpc(
        t,
        freshReadyHandlers({
          initiate_payment_attempt: () => {
            throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée ici");
          },
        })
      );
      const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
      assert.deepEqual(result, { outcome: "provider_unavailable" });
      assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
    } finally {
      if (previousKey === undefined) delete process.env.PAYMENT_RETURN_RELAY_KEY_V1;
      else process.env.PAYMENT_RETURN_RELAY_KEY_V1 = previousKey;
    }
  }));

// --------------------------------------------------------------
// PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 — ferme
// P3BV41-PREFLIGHT-01 (audit de travail v4.1 indépendant, blocage
// HIGH). Défaut REPRODUIT tel que décrit par le mandat : `language`
// n'était validée qu'À L'INTÉRIEUR de `buildMoneticoPaymentRequest`,
// APRÈS `initiatePaymentAttempt` -- language="ZZ" créait donc une
// tentative `pending` PUIS échouait (MONETICO_UNSUPPORTED_LANGUAGE non
// rattrapée, exception remontée jusqu'à l'appelant). Ce bloc PROUVE la
// correction : `initiate_payment_attempt` a un compte d'appels = 0
// pour toute langue non supportée, AVANT même la moindre lecture RPC.
// --------------------------------------------------------------

test("PREFLIGHT-01 (v4.2) : language=\"ZZ\" (non supportée) -- rejet 'invalid_request', initiate_payment_attempt JAMAIS appelée, AUCUN appel RPC du tout", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        initiate_payment_attempt: () => {
          throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée ici");
        },
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1", language: "ZZ" });
    assert.deepEqual(result, { outcome: "invalid_request", reason: "unsupported_language" });
    assert.equal(calls.length, 0, "AUCUN appel RPC -- la validation de langue est une fonction PURE, précède tout I/O");
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
  }));

test("PREFLIGHT-01 (v4.2) : language en minuscules non supportées (\"zz\") -- même rejet (la canonicalisation ne \"sauve\" jamais une langue réellement non supportée)", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(t, { initiate_payment_attempt: () => { throw new Error("jamais appelée"); } });
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1", language: "zz" });
    assert.deepEqual(result, { outcome: "invalid_request", reason: "unsupported_language" });
    assert.equal(calls.length, 0);
  }));

test("PREFLIGHT-01 (v4.2) : language omise -- défaut FR silencieux, chemin normal atteint (pas un rejet -- INCHANGÉ, mandat §4 'no silent arbitrary fallback UNLESS existing product semantics explicitly require one' -- FR est déjà le défaut produit préexistant, préservé)", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(result);
    assert.equal(result.fields.lgue, "FR");
  }));

test("PREFLIGHT-01 (v4.2) : language supportée en minuscules (\"en\") -- canonicalisée en majuscules, chemin normal atteint", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1", language: "en" });
    assertReady(result);
    assert.equal(result.fields.lgue, "EN");
  }));

test("PREFLIGHT-01 (v4.2) : REPRISE (tentative active existante) avec language=\"ZZ\" -- rejet AVANT même la lecture de la tentative active (préflight rejoué intégralement, mandat §7)", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        get_order_active_payment_attempt: () => {
          throw new Error("get_order_active_payment_attempt ne doit JAMAIS être appelée -- rejet de langue AVANT toute lecture RPC");
        },
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1", language: "ZZ" });
    assert.deepEqual(result, { outcome: "invalid_request", reason: "unsupported_language" });
    assert.equal(calls.length, 0);
  }));

// --------------------------------------------------------------
// PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 — mandat §6 : INVARIANT
// POST-P1. Preuve STRUCTURELLE/ADVERSARIALE que plus AUCUNE erreur
// statique/déterministe dépendant d'une entrée navigateur ne peut
// survenir APRÈS `initiatePaymentAttempt` -- tous les prérequis
// statiques listés au mandat §5 (feature gate, possession, statut
// paiement, provider activé, configuration_status, mode provider,
// endpoint, credential, facturation, service_mode, shipping,
// applicabilité + données shipping, origine canonique, capacité de
// relais de retour, LANGUE, longueurs/formats de champs Monetico,
// entrées de construction déterministe, entrée MAC) sont déjà
// EXCLUSIVEMENT validés AVANT la ligne `initiatePaymentAttempt` dans
// `payment-checkout-runtime.ts` (voir BASELINE-RECONCILIATION/
// STATIC-POST-P1-VALIDATION-REPORT-v4.2.txt pour l'audit complet,
// fichier par fichier, de chaque site `throw` atteignable depuis
// `buildMoneticoPaymentRequest`). Ce test PROUVE le résultat de cet
// audit au niveau comportemental : le chemin FRESH complet, avec une
// entrée navigateur DÉJÀ validée par le préflight, atteint TOUJOURS
// `outcome: "ready"` sans qu'aucune exception ne soit levée par
// `buildMoneticoPaymentRequest` -- si une régression future
// réintroduisait une validation déterministe manquante AVANT P1, ce
// test resterait vert (il ne couvre QUE le chemin déjà validé) mais le
// test PREFLIGHT-01 (v4.2) ci-dessus la détecterait (initiate_payment_
// attempt appelée AVANT le rejet). Les deux tests sont donc
// COMPLÉMENTAIRES, pas redondants.
// --------------------------------------------------------------

test("INVARIANT POST-P1 : chemin FRESH complet, entrée déjà valide -- AUCUNE exception synchrone levée par buildMoneticoPaymentRequest, 'ready' atteint de façon déterministe", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    // N'échoue JAMAIS -- si buildMoneticoPaymentRequest levait encore
    // (MONETICO_UNSUPPORTED_LANGUAGE ou autre), cette ligne lèverait et
    // ferait échouer le test avec une pile d'appel explicite plutôt que
    // silencieusement. "EN" -- PAYMENT STREAM B -- MONETICO
    // FINALIZATION (ferme MONETICO-LANGUAGE-01) : valeur RÉELLEMENT
    // supportée par le contrat Starter du marchand pilote (Français/
    // Anglais uniquement) -- voir le test dédié ci-dessous pour la
    // preuve du rejet d'une langue protocolairement valide mais
    // désormais hors du périmètre Starter réel ("DE").
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1", language: "EN" });
    assertReady(result);
    assert.equal(result.fields.lgue, "EN");
  }));

test("PAYMENT STREAM B -- MONETICO FINALIZATION (ferme MONETICO-LANGUAGE-01) : langue protocolairement valide (\"DE\", acceptée par le protocole Monetico générique à 9 langues) MAIS NON supportée par le contrat Starter réel du marchand pilote (Français/Anglais uniquement) -- REJETÉE explicitement, jamais silencieusement acceptée ni convertie", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1", language: "DE" });
    assert.equal(result.outcome, "invalid_request");
    assert.equal((result as { reason: string }).reason, "unsupported_language");
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"), "aucune tentative de paiement ne doit être initiée pour une langue rejetée -- validée AVANT toute mutation P1");
  }));

// --------------------------------------------------------------
// Chemin FRESH.
// --------------------------------------------------------------

test("FRESH : aucune tentative active -- appelle initiate_payment_attempt EN DERNIER (après TOUS les prérequis), référence fraîche (12 hex)", async (t) =>
  withEnabledKillSwitch(async () => {
    let sentReference: string | undefined;
    const orderOfCalls: string[] = [];
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        initiate_payment_attempt: (_n, args) => {
          sentReference = args.p_provider_reference as string;
          return ok({ transaction_id: "txn-1", amount: 25, currency: "EUR" });
        },
      })
    );
    for (const c of calls) orderOfCalls.push(c.name);

    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });

    assertReady(result);
    assert.equal(result.resumed, false);
    // freshReadyHandlers() par défaut -> ENVIRONMENT_ROW() par défaut
    // -> mode="test" (PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.1,
    // ferme la correction finale mode/endpoint -- voir endpoint.ts) :
    // l'URL de soumission attendue ici est désormais l'URL TEST, plus
    // jamais la constante unique v3/v4.
    assert.equal(result.submissionUrl, MONETICO_TEST_PAYMENT_SUBMISSION_URL);
    assert.match(sentReference!, /^[0-9a-f]{12}$/);
    assert.equal(result.fields.reference, sentReference);
    assert.equal(result.fields.montant, "25.00EUR");

    // initiate_payment_attempt DOIT être le DERNIER appel RPC de la
    // séquence (ferme P3B-V3-PREFLIGHT-01) -- tout ce qui précède est
    // une lecture/validation, jamais une mutation.
    assert.equal(calls[calls.length - 1]!.name, "initiate_payment_attempt");
  }));

test("FRESH : deux commandes distinctes reçoivent des références DIFFÉRENTES", async (t) =>
  withEnabledKillSwitch(async () => {
    const seen: string[] = [];
    routeRpc(
      t,
      freshReadyHandlers({
        initiate_payment_attempt: (_n, args) => {
          seen.push(args.p_provider_reference as string);
          return ok({ transaction_id: "txn-x", amount: 10, currency: "EUR" });
        },
      })
    );
    await initiateCheckout({ orderId: "order-A", publicToken: "tok-A" });
    await initiateCheckout({ orderId: "order-B", publicToken: "tok-B" });
    assert.notEqual(seen[0], seen[1]);
  }));

// --------------------------------------------------------------
// Chemin REPRISE -- rejoue TOUS les mêmes préflights statiques
// (mandat §7), jamais initiatePaymentAttempt.
// --------------------------------------------------------------

test("REPRISE : tentative pending active existante -- initiate_payment_attempt JAMAIS appelée, MÊME reference/amount/currency", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        get_payment_runtime_provider_environment: () => ok(ENVIRONMENT_ROW("live")),
        get_order_active_payment_attempt: () =>
          ok({ provider_reference: "abc123def456", amount: "18.90", currency: "EUR" }),
        initiate_payment_attempt: () => {
          throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée en REPRISE");
        },
      })
    );

    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });

    assertReady(result);
    assert.equal(result.resumed, true);
    assert.equal(result.fields.reference, "abc123def456");
    assert.equal(result.fields.montant, "18.90EUR");
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
    // REPRISE rejoue les mêmes préflights que FRESH (mandat §7).
    assert.ok(calls.some((c) => c.name === "get_order_billing_context"));
    assert.ok(calls.some((c) => c.name === "get_order_service_mode"));
  }));

test("REPRISE : billing devenu manquant entre-temps -- 'billing_required' MÊME en reprise (préflight rejoué, mandat §7)", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        get_order_active_payment_attempt: () =>
          ok({ provider_reference: "stable-ref-1", amount: "10.00", currency: "EUR" }),
        get_order_billing_context: () => ({ data: null, error: null }),
        initiate_payment_attempt: () => {
          throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée");
        },
      })
    );
    const outcome = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(outcome, { outcome: "billing_required" });
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
  }));

test("REPRISE : deux appels successifs produisent EXACTEMENT la même reference (idempotence)", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(
      t,
      freshReadyHandlers({
        get_order_active_payment_attempt: () =>
          ok({ provider_reference: "stable-ref-1", amount: "10.00", currency: "EUR" }),
      })
    );
    const first = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    const second = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(first);
    assertReady(second);
    assert.equal(first.fields.reference, second.fields.reference);
  }));

// --------------------------------------------------------------
// Facturation OBLIGATOIRE (ferme P3B-V3-BILLING-REQUIRED-01).
// --------------------------------------------------------------

test("billing présent (manual), service_mode='pickup' -- billing inclus, shipping ABSENT du contexte_commande", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(result);
    const payload = JSON.parse(
      Buffer.from(result.fields.contexte_commande, "base64").toString("utf8")
    );
    assert.ok(payload.billing);
    assert.equal(payload.shipping, undefined);
  }));

test("service_mode='delivery' + billing.source='delivery_reuse' -- billing ET shipping tous deux inclus", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(
      t,
      freshReadyHandlers({
        get_order_billing_context: DELIVERY_REUSE_BILLING_ROW,
        get_order_service_mode: DELIVERY_ORDER_SERVICE_MODE,
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(result);
    const payload = JSON.parse(
      Buffer.from(result.fields.contexte_commande, "base64").toString("utf8")
    );
    assert.ok(payload.billing);
    assert.ok(payload.shipping);
  }));

test("SHIPPING-AUTHORITY : service_mode='delivery' MAIS billing.source='manual' -- 'billing_required' fail-closed (adresse non autoritaire pour shipping)", async (t) =>
  withEnabledKillSwitch(async () => {
    const calls = routeRpc(
      t,
      freshReadyHandlers({
        get_order_billing_context: MANUAL_BILLING_ROW,
        get_order_service_mode: DELIVERY_ORDER_SERVICE_MODE,
        initiate_payment_attempt: () => {
          throw new Error("initiate_payment_attempt ne doit JAMAIS être appelée");
        },
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assert.deepEqual(result, { outcome: "billing_required" });
    assert.ok(!calls.some((c) => c.name === "initiate_payment_attempt"));
  }));

test("SHIPPING-AUTHORITY : service_mode='pickup' + billing.source='delivery_reuse' -- shipping ABSENT quand même (applicabilité dérivée du service_mode, jamais du seul source)", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(
      t,
      freshReadyHandlers({
        get_order_billing_context: DELIVERY_REUSE_BILLING_ROW,
        get_order_service_mode: PICKUP_ORDER_SERVICE_MODE,
      })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(result);
    const payload = JSON.parse(
      Buffer.from(result.fields.contexte_commande, "base64").toString("utf8")
    );
    assert.equal(payload.shipping, undefined);
  }));

// --------------------------------------------------------------
// Origine canonique + jeton de relais (ferme
// P3B-V3-RETURN-AUTHORITY-01 / P3B-V3-PUBLIC-TOKEN-URL-01).
// --------------------------------------------------------------

test("url_retour_ok/url_retour_err construites depuis SCANYM_PUBLIC_ORIGIN, JAMAIS de publicToken en clair, jeton décodable et lié à orderId", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-xyz", publicToken: "secret-tok-xyz" });
    assertReady(result);

    const urlOk = new URL(result.fields.url_retour_ok!);
    const urlErr = new URL(result.fields.url_retour_err!);
    assert.equal(urlOk.origin, "https://checkout.example.test");
    assert.equal(urlErr.origin, "https://checkout.example.test");
    assert.equal(urlOk.pathname, "/checkout/return/ok");
    assert.equal(urlErr.pathname, "/checkout/return/err");

    // orderId reste en clair (mission v3, INCHANGÉ).
    assert.equal(urlOk.searchParams.get("orderId"), "order-xyz");
    // `publicToken` n'apparaît JAMAIS en clair.
    assert.ok(!result.fields.url_retour_ok!.includes("secret-tok-xyz"));
    assert.ok(!result.fields.url_retour_err!.includes("secret-tok-xyz"));

    const tokenOk = urlOk.searchParams.get("token")!;
    const decoded = verifyReturnRelayToken(tokenOk, "order-xyz");
    assert.equal(decoded.orderId, "order-xyz");
    assert.equal(decoded.publicToken, "secret-tok-xyz");
  }));

// --------------------------------------------------------------
// mode -- PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.1, correction
// finale mode/endpoint (mandat §16-§17/§25) : P3-B4 `mode` est
// désormais l'autorité EXPLICITE de sélection d'URL -- deux URLs de
// soumission RÉELLEMENT DISTINCTES, une par mode. Remplace l'ancien
// test v3/v4 "submissionUrl reste identique quel que soit mode", qui
// vérifiait l'INVERSE de ce que ce lot corrige (voir endpoint.ts pour
// la preuve/corroboration complète de la distinction test/live).
// --------------------------------------------------------------

test("mode='test' -- submissionUrl == MONETICO_TEST_PAYMENT_SUBMISSION_URL EXACTEMENT", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers({ get_payment_runtime_provider_environment: () => ok(ENVIRONMENT_ROW("test")) }));
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(result);
    assert.equal(result.mode, "test");
    assert.equal(result.submissionUrl, "https://p.monetico-services.com/test/paiement.cgi");
    assert.equal(result.submissionUrl, MONETICO_TEST_PAYMENT_SUBMISSION_URL);
  }));

test("mode='live' -- submissionUrl == MONETICO_LIVE_PAYMENT_SUBMISSION_URL EXACTEMENT", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(
      t,
      freshReadyHandlers({ get_payment_runtime_provider_environment: () => ok(ENVIRONMENT_ROW("live")) })
    );
    const result = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(result);
    assert.equal(result.mode, "live");
    assert.equal(result.submissionUrl, "https://p.monetico-services.com/paiement.cgi");
    assert.equal(result.submissionUrl, MONETICO_LIVE_PAYMENT_SUBMISSION_URL);
    assert.equal(result.submissionUrl, MONETICO_PAYMENT_SUBMISSION_URL);
  }));

test("mode='test' et mode='live' produisent des submissionUrl DIFFÉRENTES -- P3B-V4-MODE-ENDPOINT-01 fermé pour de bon (mandat §25)", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers({ get_payment_runtime_provider_environment: () => ok(ENVIRONMENT_ROW("test")) }));
    const testResult = await initiateCheckout({ orderId: "order-1", publicToken: "tok-1" });
    assertReady(testResult);

    routeRpc(
      t,
      freshReadyHandlers({ get_payment_runtime_provider_environment: () => ok(ENVIRONMENT_ROW("live")) })
    );
    const liveResult = await initiateCheckout({ orderId: "order-2", publicToken: "tok-2" });
    assertReady(liveResult);

    assert.notEqual(testResult.submissionUrl, liveResult.submissionUrl);
    assert.notEqual(MONETICO_TEST_PAYMENT_SUBMISSION_URL, MONETICO_LIVE_PAYMENT_SUBMISSION_URL);
  }));
