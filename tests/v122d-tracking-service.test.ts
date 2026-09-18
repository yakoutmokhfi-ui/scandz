import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 —
// lib/server/tracking-service.ts.
//
// Couvre le SEUL wrapper serveur autour des RPC de suivi (contrat
// ÉTENDU par CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 -- voir
// tests/v166-tracking-final-fiscal-summary.test.ts pour la couverture
// dédiée order_total/order_currency/invoice_requested ; VALID_ROW
// ci-dessous inclut ces 3 champs pour que CE fichier reste un mapping
// fidèle COMPLET, jamais partiel) : validation de forme AVANT tout
// appel réseau, mapping snake_case -> camelCase, taxonomie d'erreurs à
// deux catégories (mandat §25/§45).
//
// CUSTOMER TRACKING v3.1 : la lecture passe par
// get_order_tracking_by_capability(p_order_id, p_capability_id,
// p_secret) avec re-vérification applicative de bound_order_id ;
// l'échange legacy one-shot passe par
// upgrade_legacy_tracking_capability(p_order_id, p_public_token).
//
// Patron déjà établi par ce dépôt (tests/v110b-payment-p3a1-
// service.test.ts, tests/v112-payment-p3b0-service.test.ts) :
// `t.mock.method(client, "rpc", ...)` sur le CLIENT RÉEL construit par
// lib/supabase.ts (client anon PARTAGÉ -- tracking-service.ts appelle
// DÉLIBÉRÉMENT ce client, jamais service_role -- voir son commentaire
// de tête).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { getOrderTracking, upgradeLegacyTrackingCapability } = await import(
  "../lib/server/tracking-service.ts"
);
const { TrackingLinkInvalidError, TrackingServerUnavailableError } = await import(
  "../lib/server/tracking-errors.ts"
);

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORDER_ID = "99999999-9999-4999-8999-999999999999";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const CAP_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "ab".repeat(32);

const INPUT = { orderId: ORDER_ID, capabilityId: CAP_ID, secret: SECRET };

const VALID_ROW = {
  bound_order_id: ORDER_ID,
  order_status: "ready",
  service_mode: "pickup",
  order_number: 104,
  created_at: "2026-01-01T10:00:00Z",
  accepted_at: "2026-01-01T10:05:00Z",
  preparing_at: "2026-01-01T10:10:00Z",
  ready_at: "2026-01-01T10:20:00Z",
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
  // CUSTOMER CONFIRMATION + TRACKING FINAL v1.1.
  order_total: 24.9,
  order_currency: "EUR",
  invoice_requested: true,
};

// --------------------------------------------------------------------
// getOrderTracking (lecture par capacité v3.1)
// --------------------------------------------------------------------

test("getOrderTracking: appelle EXACTEMENT get_order_tracking_by_capability avec p_order_id/p_capability_id/p_secret, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: [VALID_ROW], error: null };
  });

  await getOrderTracking(INPUT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "get_order_tracking_by_capability");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_capability_id",
    "p_order_id",
    "p_secret",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_order_id, ORDER_ID);
  assert.equal(args.p_capability_id, CAP_ID);
  assert.equal(args.p_secret, SECRET);
});

test("getOrderTracking: ligne valide -- mapping camelCase complet et fidèle (bound_order_id non exposé)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [VALID_ROW], error: null }));

  const result = await getOrderTracking(INPUT);
  assert.deepEqual(result, {
    orderStatus: "ready",
    serviceMode: "pickup",
    orderNumber: 104,
    createdAt: "2026-01-01T10:00:00Z",
    acceptedAt: "2026-01-01T10:05:00Z",
    preparingAt: "2026-01-01T10:10:00Z",
    readyAt: "2026-01-01T10:20:00Z",
    completedAt: null,
    rejectedAt: null,
    cancelledAt: null,
    orderTotal: 24.9,
    orderCurrency: "EUR",
    invoiceRequested: true,
  });
});

test("v3.1 : bound_order_id d'une AUTRE commande -- TrackingLinkInvalidError, la ligne n'est jamais rendue (vérification applicative indépendante)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ ...VALID_ROW, bound_order_id: OTHER_ORDER_ID }],
    error: null,
  }));
  await assert.rejects(() => getOrderTracking(INPUT), TrackingLinkInvalidError);
});

test("v3.1 : bound_order_id absent/null -- TrackingLinkInvalidError (échec fermé)", async (t) => {
  const { bound_order_id: _omit, ...withoutBound } = VALID_ROW;
  t.mock.method(supabase, "rpc", async () => ({ data: [withoutBound], error: null }));
  await assert.rejects(() => getOrderTracking(INPUT), TrackingLinkInvalidError);

  t.mock.restoreAll();
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ ...VALID_ROW, bound_order_id: null }],
    error: null,
  }));
  await assert.rejects(() => getOrderTracking(INPUT), TrackingLinkInvalidError);
});

test("v3.1 : bound_order_id identique à la casse près -- accepté (UUID insensible à la casse)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [VALID_ROW], error: null }));
  const upper = ORDER_ID.toUpperCase();
  const result = await getOrderTracking({ ...INPUT, orderId: upper });
  assert.equal(result.orderStatus, "ready");
});

test("getOrderTracking: order_number en chaîne (bigint Postgrest) -- converti en number", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ ...VALID_ROW, order_number: "104" }],
    error: null,
  }));
  const result = await getOrderTracking(INPUT);
  assert.equal(result.orderNumber, 104);
  assert.equal(typeof result.orderNumber, "number");
});

test("getOrderTracking: entrée malformée (order_id, capability_id, secret) -- TrackingLinkInvalidError SANS aucun appel RPC", async (t) => {
  let called = false;
  t.mock.method(supabase, "rpc", async () => {
    called = true;
    return { data: [VALID_ROW], error: null };
  });
  const bad = [
    { ...INPUT, orderId: "not-a-uuid" },
    { ...INPUT, capabilityId: "" },
    { ...INPUT, secret: "" },
    { ...INPUT, secret: "AB".repeat(32) },
    { ...INPUT, secret: "ab".repeat(31) },
    { ...INPUT, secret: TOKEN },
  ];
  for (const input of bad) {
    await assert.rejects(() => getOrderTracking(input), TrackingLinkInvalidError);
  }
  assert.equal(called, false);
});

test("getOrderTracking: ensemble vide (capacité incorrecte) -- TrackingLinkInvalidError, MÊME erreur qu'une entrée malformée", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(() => getOrderTracking(INPUT), TrackingLinkInvalidError);
});

test("getOrderTracking: data null sans erreur -- traité comme ensemble vide, TrackingLinkInvalidError", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(() => getOrderTracking(INPUT), TrackingLinkInvalidError);
});

test("getOrderTracking: erreur Postgrest -- TrackingServerUnavailableError, catégorie DIFFÉRENTE d'un lien invalide", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "PGRST000", message: "boom", details: null, hint: null },
  }));
  await assert.rejects(() => getOrderTracking(INPUT), TrackingServerUnavailableError);
});

test("getOrderTracking: rpc() qui lève (panne réseau) -- TrackingServerUnavailableError", async (t) => {
  t.mock.method(supabase, "rpc", async () => {
    throw new Error("network unreachable");
  });
  await assert.rejects(() => getOrderTracking(INPUT), TrackingServerUnavailableError);
});

test("getOrderTracking: order_status hors ensemble canonique -- échec FERMÉ (TrackingServerUnavailableError), jamais affiché tel quel", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ ...VALID_ROW, order_status: "served" }],
    error: null,
  }));
  await assert.rejects(() => getOrderTracking(INPUT), TrackingServerUnavailableError);
});

test("getOrderTracking: erreur Postgrest -- console.error n'expose JAMAIS order_id/capability_id/secret", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "PGRST100", message: `leaked ${SECRET} ${CAP_ID}`, details: SECRET, hint: null },
  }));
  const logs: string[] = [];
  t.mock.method(console, "error", (msg: string) => {
    logs.push(msg);
  });
  await assert.rejects(() => getOrderTracking(INPUT));
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.equal(line.includes(SECRET), false, "le secret ne doit jamais apparaître dans les logs");
    assert.equal(line.includes(CAP_ID), false, "capability_id ne doit jamais apparaître dans les logs");
    assert.equal(line.includes(ORDER_ID), false, "order_id ne doit jamais apparaître dans les logs");
  }
});

test("getOrderTracking: data renvoyée comme objet unique (pas un tableau) -- géré comme une seule ligne", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: VALID_ROW, error: null }));
  const result = await getOrderTracking(INPUT);
  assert.equal(result.orderStatus, "ready");
});

test("v3.1 : la lecture n'utilise JAMAIS get_order_tracking (variante legacy public_token) ni une variante non liée à la commande", async (t) => {
  const names: string[] = [];
  const argKeys: string[][] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: object) => {
    names.push(name);
    argKeys.push(Object.keys(args));
    return { data: [VALID_ROW], error: null };
  });
  await getOrderTracking(INPUT);
  assert.deepEqual(names, ["get_order_tracking_by_capability"]);
  assert.ok(argKeys[0]!.includes("p_order_id"), "la lecture doit toujours être liée à la commande demandée");
  assert.equal(argKeys[0]!.includes("p_public_token"), false);
});

// --------------------------------------------------------------------
// upgradeLegacyTrackingCapability (échange one-shot v3.1)
// --------------------------------------------------------------------

test("upgrade: appelle EXACTEMENT upgrade_legacy_tracking_capability avec p_order_id/p_public_token et renvoie la capacité", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(supabase, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: [{ capability_id: CAP_ID, capability_secret: SECRET }], error: null };
  });
  const cap = await upgradeLegacyTrackingCapability({ orderId: ORDER_ID, publicToken: TOKEN });
  assert.deepEqual(cap, { capabilityId: CAP_ID, secret: SECRET });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "upgrade_legacy_tracking_capability");
  assert.deepEqual(calls[0]!.args, { p_order_id: ORDER_ID, p_public_token: TOKEN });
});

test("upgrade: rejeu / paire incorrecte (ensemble vide) -- TrackingLinkInvalidError, jamais une réémission", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () => upgradeLegacyTrackingCapability({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingLinkInvalidError
  );
  t.mock.restoreAll();
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));
  await assert.rejects(
    () => upgradeLegacyTrackingCapability({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingLinkInvalidError
  );
});

test("upgrade: entrée malformée -- TrackingLinkInvalidError SANS appel RPC", async (t) => {
  let called = false;
  t.mock.method(supabase, "rpc", async () => {
    called = true;
    return { data: [], error: null };
  });
  await assert.rejects(
    () => upgradeLegacyTrackingCapability({ orderId: "x", publicToken: TOKEN }),
    TrackingLinkInvalidError
  );
  await assert.rejects(
    () => upgradeLegacyTrackingCapability({ orderId: ORDER_ID, publicToken: "x" }),
    TrackingLinkInvalidError
  );
  assert.equal(called, false);
});

test("upgrade: erreur Postgrest / panne réseau -- TrackingServerUnavailableError", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: null,
    error: { code: "40001", message: "boom", details: null, hint: null },
  }));
  t.mock.method(console, "error", () => {});
  await assert.rejects(
    () => upgradeLegacyTrackingCapability({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingServerUnavailableError
  );
  t.mock.restoreAll();
  t.mock.method(supabase, "rpc", async () => {
    throw new Error("network");
  });
  await assert.rejects(
    () => upgradeLegacyTrackingCapability({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingServerUnavailableError
  );
});

test("upgrade: forme de capacité inattendue -- échec FERMÉ (TrackingServerUnavailableError), sans journaliser le secret", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (msg: string) => logs.push(msg));
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ capability_id: CAP_ID, capability_secret: "short-secret" }],
    error: null,
  }));
  await assert.rejects(
    () => upgradeLegacyTrackingCapability({ orderId: ORDER_ID, publicToken: TOKEN }),
    TrackingServerUnavailableError
  );
  for (const line of logs) {
    assert.equal(line.includes("short-secret"), false);
    assert.equal(line.includes(TOKEN), false);
    assert.equal(line.includes(ORDER_ID), false);
  }
});
