import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

// ====================================================================
// CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — contenu de l'e-mail de
// confirmation.
//
// Deux niveaux, jamais confondus :
//   - le GABARIT (pur) : ce qu'il rend à partir d'entrées déjà résolues ;
//   - le WORKER (bout en bout, provider FAUX) : comment il DÉRIVE ces
//     entrées du payload_snapshot déterministe, y compris pour une ligne
//     outbox enfilée AVANT ce lot.
//
// Aucun envoi réseau : FakeEmailProvider uniquement, exactement comme
// tests/v169 et tests/v170 (le provider réel reste non résolu).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "cfte-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const { renderOrderReceivedEmail } = await import(
  "../lib/server/notifications/order-received-template.ts"
);
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const adminClient = getServiceRoleSupabaseClient();
const { processPendingNotifications } = await import(
  "../lib/server/notifications/notification-worker.ts"
);
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
const { resolveTransactionalEmailProvider } = await import(
  "../lib/server/notifications/email-provider-resolution.ts"
);
const { translate } = await import("../lib/i18n.ts");
const { resolveStatusText, statusExplanationKey } = await import("../lib/tracking/status-text.ts");
const { CANONICAL_ORDER_STATUSES } = await import("../lib/tracking/status.ts");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CAP_ID = "22222222-2222-4222-8222-222222222222";
const SECRET = "ab".repeat(32);

function templateInput(overrides: Record<string, unknown> = {}) {
  return {
    locale: "fr" as const,
    merchantSenderName: "Commandes Au Lait Cru",
    merchantName: "Au Lait Cru",
    orderNumber: 42,
    total: 24.9,
    currency: "EUR",
    serviceMode: "pickup",
    statusText: translate("fr", statusExplanationKey("new")),
    deliveryAddress: null as string | null,
    orderId: ORDER_ID,
    trackingCapabilityId: CAP_ID,
    trackingSecret: SECRET,
    ...overrides,
  };
}

// ====================================================================
// 1. Gabarit — contenu obligatoire.
// ====================================================================

test("1a. l'e-mail porte le nom du commerçant, le numéro, le mode, le texte de statut, le total et le lien de suivi", () => {
  const r = renderOrderReceivedEmail(templateInput());
  for (const body of [r.html, r.text]) {
    assert.ok(body.includes("Au Lait Cru"), "nom du commerçant");
    assert.ok(body.includes("Commande n°42"), "numéro de commande");
    assert.ok(body.includes("retirer"), "mode de service (retrait)");
    assert.ok(body.includes(translate("fr", statusExplanationKey("new"))), "texte de statut");
    assert.ok(body.includes("Montant total"), "libellé du total");
    assert.ok(body.includes("24,90"), "montant");
    assert.ok(body.includes(`https://app.scanym.example/track/${ORDER_ID}`), "lien de suivi");
  }
});

test("1b. l'adresse de livraison n'apparaît QUE lorsqu'elle existe", () => {
  const pickup = renderOrderReceivedEmail(templateInput());
  assert.equal(
    pickup.text.includes(translate("fr", "emailOrderReceivedDeliveryAddressLabel")),
    false,
    "aucun libellé d'adresse en retrait"
  );

  const delivery = renderOrderReceivedEmail(
    templateInput({ serviceMode: "delivery", deliveryAddress: "12 rue des Lilas, 75001 Paris" })
  );
  for (const body of [delivery.html, delivery.text]) {
    assert.ok(body.includes(translate("fr", "emailOrderReceivedDeliveryAddressLabel")));
    assert.ok(body.includes("12 rue des Lilas, 75001 Paris"));
  }
});

test("1c. une adresse vide/blanche est OMISE proprement, jamais rendue comme une ligne vide", () => {
  for (const empty of ["", "   ", null]) {
    const r = renderOrderReceivedEmail(
      templateInput({ serviceMode: "delivery", deliveryAddress: empty })
    );
    assert.equal(
      r.text.includes(translate("fr", "emailOrderReceivedDeliveryAddressLabel")),
      false,
      `adresse ${JSON.stringify(empty)} : aucune ligne ne doit être rendue`
    );
  }
});

test("1d. le lien de suivi RÉUTILISABLE reste en FRAGMENT -- aucun secret dans le chemin ou la query", () => {
  const r = renderOrderReceivedEmail(templateInput());
  const url = new URL(r.text.match(/https:\/\/\S+/)![0]);
  assert.equal(url.pathname, `/track/${ORDER_ID}`);
  assert.equal(url.search, "", "aucune query");
  assert.equal(url.pathname.includes(SECRET), false);
  assert.ok(url.hash.includes(SECRET), "le secret ne voyage que dans le fragment");
});

test("1e. le texte de statut d'un commerçant est ÉCHAPPÉ avant insertion HTML", () => {
  const hostile = `<script>alert("x")</script>& "guillemets" 'apostrophes'`;
  const r = renderOrderReceivedEmail(templateInput({ statusText: hostile }));
  assert.equal(r.html.includes("<script>"), false, "aucun HTML marchand arbitraire");
  assert.ok(r.html.includes("&lt;script&gt;"));
  assert.ok(r.html.includes("&amp;"));
  assert.ok(r.html.includes("&quot;"));
  assert.ok(r.html.includes("&#39;"));
  // La version texte, elle, porte la valeur brute (aucun HTML à échapper).
  assert.ok(r.text.includes(hostile));
});

test("1f. le nom du commerçant et l'adresse sont également échappés", () => {
  const r = renderOrderReceivedEmail(
    templateInput({
      merchantName: `A<b>B`,
      serviceMode: "delivery",
      deliveryAddress: `1 rue <i>X</i>`,
    })
  );
  assert.equal(r.html.includes("<b>"), false);
  assert.equal(r.html.includes("<i>"), false);
  assert.ok(r.html.includes("A&lt;b&gt;B"));
});

test("1g. les trois langues rendent un texte de statut réellement traduit", () => {
  for (const lang of ["fr", "en", "ar"] as const) {
    const expected = translate(lang, statusExplanationKey("new"));
    const r = renderOrderReceivedEmail(templateInput({ locale: lang, statusText: expected }));
    assert.ok(r.text.includes(expected), `${lang} : texte de statut absent`);
    assert.ok(r.html.includes(`<html lang="${lang}">`));
  }
});

// ====================================================================
// 2. Worker — dérivation depuis le payload_snapshot.
// ====================================================================

function claimRow(payloadExtra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    outbox_id: randomUUID(),
    restaurant_id: randomUUID(),
    order_id: ORDER_ID,
    notification_type: "order_received",
    recipient_email: "client@example.com",
    locale: "fr",
    payload_snapshot: {
      order_number: 7,
      total: 19.9,
      currency: "EUR",
      service_mode: "pickup",
      public_token: randomUUID(),
      created_at: "2026-09-22T10:00:00Z",
      ...payloadExtra,
    },
    attempt_count: 0,
    claim_token: randomUUID(),
    sender_name: "Commandes Au Lait Cru",
    sender_email: "commandes@aulaitcru.example",
    reply_to: null,
    ...overrides,
  };
}

function installWorkerBackend(t: any, rows: Array<Record<string, unknown>>) {
  const completed: Array<Record<string, unknown>> = [];
  t.mock.method(adminClient, "rpc", async (name: string, args: Record<string, any>) => {
    if (name === "claim_pending_notifications") return { data: rows.splice(0), error: null };
    if (name === "complete_notification_attempt") {
      completed.push(args);
      return { data: null, error: null };
    }
    if (name === "issue_order_email_tracking_capability") {
      return {
        data: [{ capability_id: CAP_ID, capability_secret: randomBytes(32).toString("hex") }],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return completed;
}

async function sendOne(t: any, rows: Array<Record<string, unknown>>) {
  const completed = installWorkerBackend(t, rows);
  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);
  return { result, provider, completed };
}

test("2a. le worker insère le texte de statut SURCHARGÉ figé dans le snapshot", async (t) => {
  const OVERRIDE = "Nos fromagers préparent votre plateau avec soin.";
  const { result, provider } = await sendOne(t, [
    claimRow({ order_status: "new", status_text_override: OVERRIDE, merchant_name: "Au Lait Cru" }),
  ]);
  assert.equal(result.sent, 1);
  const msg = provider.sent[0]!;
  assert.ok(msg.text.includes(OVERRIDE), "la surcharge marchande doit apparaître");
  assert.equal(
    msg.text.includes(translate("fr", statusExplanationKey("new"))),
    false,
    "le texte de base ne doit pas être rendu EN PLUS de la surcharge"
  );
  assert.ok(msg.text.includes("Au Lait Cru"), "nom du commerçant issu du snapshot");
});

test("2b. surcharge VIDE/blanche -> repli sur le texte de BASE (jamais un e-mail sans explication)", async (t) => {
  for (const empty of ["", "   ", null]) {
    const { provider } = await sendOne(t, [
      claimRow({ order_status: "new", status_text_override: empty }),
    ]);
    assert.ok(
      provider.sent[0]!.text.includes(translate("fr", statusExplanationKey("new"))),
      `surcharge ${JSON.stringify(empty)} : repli base attendu`
    );
    t.mock.restoreAll();
  }
});

test("2c. l'adresse de livraison du snapshot est rendue ; aucune adresse hors livraison", async (t) => {
  const { provider } = await sendOne(t, [
    claimRow({
      service_mode: "delivery",
      order_status: "new",
      delivery_address: "12 rue des Lilas, 75001 Paris",
    }),
  ]);
  assert.ok(provider.sent[0]!.text.includes("12 rue des Lilas, 75001 Paris"));
  t.mock.restoreAll();

  const { provider: pickup } = await sendOne(t, [claimRow({ order_status: "new" })]);
  assert.equal(
    pickup.sent[0]!.text.includes(translate("fr", "emailOrderReceivedDeliveryAddressLabel")),
    false
  );
});

test("2d. COMPATIBILITÉ ASCENDANTE : une ligne enfilée AVANT ce lot est rendue sans échec ni reprise", async (t) => {
  // Snapshot strictement N1-A : ni statut, ni surcharge, ni adresse, ni
  // nom de commerçant.
  const { result, provider, completed } = await sendOne(t, [claimRow()]);
  assert.equal(result.sent, 1);
  assert.equal(result.retriedRetryable, 0);
  assert.equal(result.failedTerminal, 0);
  assert.equal(completed[0]!.p_result, "success");

  const msg = provider.sent[0]!;
  // Repli : texte de base du statut `new` (le seul qu'un événement
  // ORDER_RECEIVED puisse avoir eu), nom d'expéditeur, aucune adresse.
  assert.ok(msg.text.includes(translate("fr", statusExplanationKey("new"))));
  assert.ok(msg.text.includes("Commandes Au Lait Cru"));
  assert.equal(
    msg.text.includes(translate("fr", "emailOrderReceivedDeliveryAddressLabel")),
    false
  );
});

test("2e. un statut NON canonique dans le snapshot ne produit jamais un statut inventé", async (t) => {
  for (const bogus of ["out_for_delivery", "delivered", "", 42, null]) {
    const { result, provider } = await sendOne(t, [claimRow({ order_status: bogus })]);
    assert.equal(result.sent, 1, `statut ${JSON.stringify(bogus)} : l'e-mail doit partir quand même`);
    const body = provider.sent[0]!.text;
    assert.ok(body.includes(translate("fr", statusExplanationKey("new"))), "repli sur `new`");
    assert.equal(/out for delivery|livreur|en route/i.test(body), false, "aucun état livreur inventé");
    t.mock.restoreAll();
  }
});

test("2f. la locale du snapshot pilote le texte de statut de base", async (t) => {
  for (const locale of ["fr", "en", "ar"] as const) {
    const { provider } = await sendOne(t, [claimRow({ order_status: "new" }, { locale })]);
    assert.ok(
      provider.sent[0]!.text.includes(translate(locale, statusExplanationKey("new"))),
      `locale ${locale}`
    );
    t.mock.restoreAll();
  }
});

test("2g. le texte de statut rendu est EXACTEMENT celui de l'autorité partagée avec la page de suivi", async (t) => {
  // Aucune seconde implémentation : pour chacun des 7 statuts, le
  // résultat attendu est celui de `resolveStatusText`.
  for (const status of CANONICAL_ORDER_STATUSES) {
    const { provider } = await sendOne(t, [claimRow({ order_status: status })]);
    const expected = resolveStatusText(status, {}, (k) => translate("fr", k)).text;
    assert.ok(provider.sent[0]!.text.includes(expected), `statut ${status}`);
    t.mock.restoreAll();
  }
});

// ====================================================================
// 3. Aucun envoi réel dans ce candidat.
// ====================================================================

test("3. le provider réel reste NON résolu -- aucun envoi réseau possible", () => {
  assert.equal(resolveTransactionalEmailProvider(), null);
});
