import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "i172-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

// ====================================================================
// ISSUE #172 — continuité du suivi après paiement + e-mail de confirmation.
//
// Tests SYNTHÉTIQUES : `client.rpc` est remplacé, `fetch` est interdit.
// Aucun e-mail réel, aucune commande réelle, aucun paiement, aucun réseau.
//
//   A. page de retour : lien de suivi RÉUTILISABLE, repli legacy, aucun lien
//      réutilisable pour un paiement refusé/annulé, compteur e-mail intact.
//   B. gabarit : lien de rétractation explicite, créneau, absence propre.
//   C. worker de bout en bout (FakeEmailProvider) : contenu de l'e-mail,
//      aucun envoi en double.
// ====================================================================

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { createReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");
const { resolvePaymentReturnStatus } = await import("../app/checkout/return/shared.ts");
const { parseTrackingFragment } = await import("../lib/tracking/link.ts");
const { renderOrderReceivedEmail, formatFulfillmentSchedule } = await import(
  "../lib/server/notifications/order-received-template.ts"
);
const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
const { translate } = await import("../lib/i18n.ts");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_TOKEN = "22222222-2222-4222-8222-222222222222";
const CAP_ID = "33333333-3333-4333-8333-333333333333";
const CAP_SECRET = "ab".repeat(32);

const relay = () => createReturnRelayToken({ orderId: ORDER_ID, publicToken: LEGACY_TOKEN, ttlSeconds: 600 });

function forbidNetwork(t: any) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("NETWORK_FORBIDDEN_IN_172_TESTS");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

/** Faux serveur : statut de paiement + comportement de l'émission de retour. */
function installReturnRpc(
  t: any,
  paymentStatus: string,
  issue: () => { data: unknown; error: unknown } | Promise<never> = () => ({
    data: [{ capability_id: CAP_ID, capability_secret: CAP_SECRET }],
    error: null,
  })
) {
  const calls: string[] = [];
  t.mock.method(client, "rpc", async (name: string) => {
    calls.push(name);
    if (name === "get_order_payment_status_snapshot") {
      return {
        data: [{ payment_status: paymentStatus, provider_code: "monetico", has_observed_refusal: false, last_refusal_at: null }],
        error: null,
      };
    }
    if (name === "issue_order_return_tracking_capability") return issue();
    throw new Error(`RPC inattendue : ${name}`);
  });
  return calls;
}

// --------------------------------------------------------------------
// A. Page de retour
// --------------------------------------------------------------------

test("[172-RET-1] paid : lien de suivi RÉUTILISABLE (#c1.), jamais le jeton legacy", async (t) => {
  forbidNetwork(t);
  installReturnRpc(t, "paid");
  const r = await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: relay() });
  assert.equal(r.kind, "paid");
  const path = (r as { trackingPath: string }).trackingPath;
  assert.equal(path, `/track/${ORDER_ID}#c1.${CAP_ID}.${CAP_SECRET}`);
  assert.equal(path.includes(LEGACY_TOKEN), false, "le jeton legacy (à usage unique) n'est plus exposé");
  const fragment = parseTrackingFragment(path.split("#")[1]!);
  assert.deepEqual(fragment, { kind: "capability", capabilityId: CAP_ID, secret: CAP_SECRET });
});

test("[172-RET-2] succès / en cours / paiement exigé / sans paiement : tous portent le lien réutilisable, avec la BONNE commande", async (t) => {
  forbidNetwork(t);
  const expected: Record<string, string> = {
    paid: "paid", pending: "pending", required: "pending", not_required: "not_required",
  };
  for (const [status, kind] of Object.entries(expected)) {
    installReturnRpc(t, status);
    const r = (await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: relay() })) as { kind: string; trackingPath: string };
    assert.equal(r.kind, kind, status);
    assert.ok(r.trackingPath.startsWith(`/track/${ORDER_ID}#c1.`), status);
    t.mock.restoreAll();
  }
});

test("[172-RET-3] refus / annulation : AUCUN lien réutilisable n'est émis (lien legacy, aucun appel d'émission)", async (t) => {
  forbidNetwork(t);
  for (const status of ["failed", "cancelled"]) {
    const calls = installReturnRpc(t, status);
    const r = (await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: relay() })) as { kind: string; trackingPath: string };
    assert.equal(r.kind, "failed_or_cancelled");
    assert.equal(r.trackingPath, `/track/${ORDER_ID}#${LEGACY_TOKEN}`);
    assert.equal(calls.includes("issue_order_return_tracking_capability"), false, status);
    t.mock.restoreAll();
  }
});

test("[172-RET-4] repli legacy si l'émission échoue : SQL non appliqué, erreur, exception, vide, forme inattendue", async (t) => {
  forbidNetwork(t);
  const failures: Array<[string, () => any]> = [
    ["erreur Postgrest (fonction absente)", () => ({ data: null, error: { code: "42883", message: "function does not exist" } })],
    ["exception réseau", () => Promise.reject(new Error("boom"))],
    ["plafond atteint (ensemble vide)", () => ({ data: [], error: null })],
    ["null", () => ({ data: null, error: null })],
    ["identifiant mal formé", () => ({ data: [{ capability_id: "nope", capability_secret: CAP_SECRET }], error: null })],
    ["secret mal formé", () => ({ data: [{ capability_id: CAP_ID, capability_secret: "court" }], error: null })],
  ];
  for (const [label, issue] of failures) {
    installReturnRpc(t, "paid", issue);
    const r = (await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: relay() })) as { kind: string; trackingPath: string };
    assert.equal(r.kind, "paid", label);
    assert.equal(r.trackingPath, `/track/${ORDER_ID}#${LEGACY_TOKEN}`, label);
    t.mock.restoreAll();
  }
});

test("[172-RET-5] la page de retour n'utilise JAMAIS le compteur e-mail (sinon l'e-mail de confirmation pourrait ne jamais partir)", async (t) => {
  forbidNetwork(t);
  const calls = installReturnRpc(t, "paid");
  for (let i = 0; i < 20; i++) await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: relay() });
  assert.equal(calls.includes("issue_order_email_tracking_capability"), false);
  assert.equal(calls.filter((c) => c === "issue_order_return_tracking_capability").length, 20);
});

test("[172-RET-6] jeton de relais invalide : 'unavailable', AUCUN appel serveur (posture anti-fuite inchangée)", async (t) => {
  forbidNetwork(t);
  const calls = installReturnRpc(t, "paid");
  assert.deepEqual(await resolvePaymentReturnStatus({ orderId: ORDER_ID, token: "garbage" }), { kind: "unavailable" });
  assert.deepEqual(await resolvePaymentReturnStatus({ orderId: "autre-commande", token: relay() }), { kind: "unavailable" });
  assert.deepEqual(calls, []);
});

// --------------------------------------------------------------------
// B. Gabarit
// --------------------------------------------------------------------

const baseInput = {
  locale: "fr" as const,
  merchantSenderName: "Au Lait Cru",
  merchantName: "Au Lait Cru",
  orderNumber: 42,
  total: 23.5,
  currency: "EUR",
  serviceMode: "pickup",
  orderId: ORDER_ID,
  trackingCapabilityId: CAP_ID,
  trackingSecret: CAP_SECRET,
  statusText: "",
  deliveryAddress: null,
};
const TRACKING_URL = `https://app.scanym.example/track/${ORDER_ID}#c1.${CAP_ID}.${CAP_SECRET}`;

test("[172-MAIL-1] sans créneau ni éligibilité : e-mail identique à un rendu sans ces champs (aucune ligne vide)", () => {
  const before = renderOrderReceivedEmail(baseInput);
  const withNulls = renderOrderReceivedEmail({ ...baseInput, fulfillmentDate: null, fulfillmentSlot: "  ", withdrawalEligible: false });
  assert.deepEqual(withNulls, before);
  assert.equal(before.text.includes("Créneau"), false);
  assert.equal(before.text.includes(translate("fr", "withdrawalEntryAction")), false);
});

test("[172-MAIL-2] éligible à la rétractation : second lien explicite, MÊME cible que le suivi, libellé existant, FR/EN/AR", () => {
  for (const locale of ["fr", "en", "ar"] as const) {
    const label = translate(locale, "withdrawalEntryAction");
    assert.notEqual(label, "withdrawalEntryAction", `libellé ${locale} présent`);
    const mail = renderOrderReceivedEmail({ ...baseInput, locale, withdrawalEligible: true });
    assert.ok(mail.text.includes(`${label}: ${TRACKING_URL}`), `texte ${locale}`);
    assert.ok(mail.html.includes(`<a href="${TRACKING_URL}">${label}</a>`), `html ${locale}`);
    // Un seul lien de suivi + un lien de rétractation : deux cibles identiques, rien d'autre.
    assert.equal((mail.text.match(/https:\/\/\S+/g) ?? []).length, 2);
    assert.equal(mail.text.includes(LEGACY_TOKEN), false);
  }
});

test("[172-MAIL-3] créneau : ligne rendue seulement s'il existe ; libellé retrait/livraison ; date sans décalage de fuseau", () => {
  const pickup = renderOrderReceivedEmail({ ...baseInput, fulfillmentDate: "2026-11-03", fulfillmentSlot: "10:00-12:00" });
  assert.ok(pickup.text.includes("Créneau de retrait : "), pickup.text);
  assert.ok(/3 novembre 2026/.test(pickup.text), pickup.text);
  assert.ok(pickup.text.includes("10:00-12:00"));

  const delivery = renderOrderReceivedEmail({ ...baseInput, serviceMode: "delivery", fulfillmentDate: "2026-11-03", fulfillmentSlot: null });
  assert.ok(delivery.text.includes("Créneau de livraison : "));

  const en = renderOrderReceivedEmail({ ...baseInput, locale: "en", fulfillmentDate: "2026-11-03", fulfillmentSlot: "10:00-12:00" });
  assert.ok(en.text.includes("Pickup time slot: "));
  assert.ok(/3 November 2026/.test(en.text), en.text);

  for (const key of ["emailOrderReceivedSlotLabelPickup", "emailOrderReceivedSlotLabelDelivery"]) {
    for (const locale of ["fr", "en", "ar"]) assert.notEqual(translate(locale, key), key, `${locale}/${key}`);
  }
});

test("[172-MAIL-4] formatFulfillmentSchedule : rien -> null ; forme inconnue rendue telle quelle (jamais réinterprétée) ; HTML échappé", () => {
  assert.equal(formatFulfillmentSchedule("fr", null, null), null);
  assert.equal(formatFulfillmentSchedule("fr", "", "  "), null);
  assert.equal(formatFulfillmentSchedule("fr", "demain matin", null), "demain matin");
  assert.equal(formatFulfillmentSchedule("fr", null, "10:00-12:00"), "10:00-12:00");
  const mail = renderOrderReceivedEmail({ ...baseInput, fulfillmentDate: null, fulfillmentSlot: `<img src=x onerror=alert(1)>` });
  assert.equal(mail.html.includes("<img"), false);
  assert.ok(mail.html.includes("&lt;img"));
});

// --------------------------------------------------------------------
// C. Worker de bout en bout (FakeEmailProvider uniquement)
// --------------------------------------------------------------------

function installWorkerRpc(t: any, payload: Record<string, unknown>) {
  const outboxId = randomUUID();
  const claimToken = randomUUID();
  const completed: Array<Record<string, unknown>> = [];
  let claimedOnce = false;
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "claim_pending_notifications": {
        if (claimedOnce) return { data: [], error: null };
        claimedOnce = true;
        return {
          data: [{
            outbox_id: outboxId, restaurant_id: randomUUID(), order_id: ORDER_ID,
            notification_type: "order_received", recipient_email: "client@example.test", locale: "fr",
            payload_snapshot: payload, attempt_count: 0, claim_token: claimToken,
            sender_name: "Au Lait Cru", sender_email: "contact@example.test", reply_to: null,
          }],
          error: null,
        };
      }
      case "issue_order_email_tracking_capability":
        return { data: [{ capability_id: CAP_ID, capability_secret: CAP_SECRET }], error: null };
      case "complete_notification_attempt":
        completed.push(args);
        return { data: null, error: null };
      default:
        throw new Error(`RPC inattendue : ${name}`);
    }
  });
  return { completed, outboxId };
}

const snapshot = (extra: Record<string, unknown> = {}) => ({
  order_number: 42, total: 23.5, currency: "EUR", service_mode: "pickup",
  public_token: randomUUID(), created_at: "2026-10-28T09:59:00Z", order_status: "new",
  merchant_name: "Au Lait Cru", withdrawal_eligible: false, ...extra,
});

test("[172-WORKER-1] snapshot avec créneau + éligibilité : l'e-mail contient le créneau et le lien de rétractation ; un seul envoi", async (t) => {
  forbidNetwork(t);
  const { completed } = installWorkerRpc(t, snapshot({
    withdrawal_eligible: true, fulfillment_date: "2026-11-03", fulfillment_slot: "10:00-12:00",
  }));
  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);
  assert.equal(result.sent, 1);
  assert.equal(provider.sent.length, 1);
  const mail = provider.sent[0]!;
  assert.ok(mail.text.includes("Créneau de retrait : "));
  assert.ok(mail.text.includes(`${translate("fr", "withdrawalEntryAction")}: ${TRACKING_URL}`));
  assert.equal(mail.text.includes(LEGACY_TOKEN), false);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.p_result, "success");
});

test("[172-WORKER-2] snapshot SANS créneau (état de `main`) et non éligible : e-mail sans créneau ni lien de rétractation -- rien d'inventé", async (t) => {
  forbidNetwork(t);
  installWorkerRpc(t, snapshot());
  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  const mail = provider.sent[0]!;
  assert.equal(mail.text.includes("Créneau"), false);
  assert.equal(mail.text.includes(translate("fr", "withdrawalEntryAction")), false);
  assert.ok(mail.text.includes(`: ${TRACKING_URL}`), "le lien de suivi réutilisable reste présent");
});

test("[172-WORKER-3] rejeu : une fois réclamée, la notification n'est plus renvoyée (pas de double envoi)", async (t) => {
  forbidNetwork(t);
  installWorkerRpc(t, snapshot());
  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  await processPendingNotifications(provider);
  assert.equal(provider.sent.length, 1);
});
