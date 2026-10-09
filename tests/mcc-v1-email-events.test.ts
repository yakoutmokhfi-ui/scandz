import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

// ====================================================================
// Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — ÉVÉNEMENTS E-MAIL.
//
// Couvre les catégories exigées par le mandat :
//   [6] e-mail de confirmation de commande (tous les modes),
//   [7] variables de retrait, [8] variables de livraison,
//   [9] remise au transporteur (type Chronofresh),
//   [10] e-mail facultatif DÉSACTIVÉ,
//   [13] aucun doublon d'envoi à la reprise (idempotence),
//   [1] isolation multi-locataires de l'identité d'expédition.
//
// AUCUN ENVOI RÉSEAU : `FakeEmailProvider` uniquement, exactement comme
// tests/v169, tests/v170 et tests/cfte-v1-confirmation-email.ts (le
// provider réel reste non résolu dans ce dépôt).
//
// AUCUN APPEL FOURNISSEUR DE LIVRAISON : ni Stuart, ni Chronofresh.
// Un dernier test le PROUVE en inspectant le code source des modules de
// ce lot, plutôt que de se contenter de l'affirmer.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mcc-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const adminClient = getServiceRoleSupabaseClient();
const { processPendingNotifications } = await import(
  "../lib/server/notifications/notification-worker.ts"
);
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
const { buildNotificationIdempotencyKey } = await import(
  "../lib/server/notifications/email-provider.ts"
);
const { renderCommunicationEventEmail } = await import(
  "../lib/server/notifications/communication-event-template.ts"
);
const { buildCommunicationTemplateValues } = await import(
  "../lib/server/notifications/communication-template-values.ts"
);
const { translate } = await import("../lib/i18n.ts");
const { COMMUNICATION_EVENT_CODES, COMMUNICATION_EVENT_BODY_TEXT_KEY } = await import(
  "../lib/communications/events.ts"
);
// Jamais un littéral monétaire écrit à la main : `formatPrice` est
// l'unique autorité de mise en forme du dépôt (et elle emploie une
// espace insécable, qu'un littéral de test reproduirait mal).
const { formatPrice } = await import("../lib/whatsapp.ts");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CAP_ID = "22222222-2222-4222-8222-222222222222";
const RID_A = "a1111111-1111-4111-8111-111111111111";
const RID_B = "b2222222-2222-4222-8222-222222222222";

// --- Harnais ----------------------------------------------------------

function claimRow(
  notificationType: string,
  payloadExtra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
) {
  return {
    outbox_id: randomUUID(),
    restaurant_id: RID_A,
    order_id: ORDER_ID,
    notification_type: notificationType,
    recipient_email: "client@example.com",
    locale: "fr",
    payload_snapshot: {
      order_number: 7,
      total: 19.9,
      currency: "EUR",
      service_mode: "pickup",
      public_token: randomUUID(),
      created_at: "2026-09-22T10:00:00Z",
      merchant_name: "Epicerie Alpha",
      ...payloadExtra,
    },
    attempt_count: 0,
    claim_token: randomUUID(),
    sender_name: "Commandes Alpha",
    sender_email: "commandes@alpha.example",
    reply_to: null,
    ...overrides,
  };
}

interface Backend {
  readonly completed: Array<Record<string, unknown>>;
  readonly rpcNames: string[];
  capabilityIssuances: number;
}

function installWorkerBackend(
  t: { mock: { method: Function } },
  rows: Array<Record<string, unknown>>,
  opts: { capability?: "ok" | "null" } = {}
): Backend {
  const backend: Backend = { completed: [], rpcNames: [], capabilityIssuances: 0 };
  t.mock.method(adminClient, "rpc", async (name: string, args: Record<string, unknown>) => {
    backend.rpcNames.push(name);
    if (name === "claim_pending_notifications") return { data: rows.splice(0), error: null };
    if (name === "complete_notification_attempt") {
      backend.completed.push(args);
      return { data: null, error: null };
    }
    if (name === "issue_order_email_tracking_capability") {
      backend.capabilityIssuances += 1;
      if (opts.capability === "null") return { data: [], error: null };
      return {
        data: [{ capability_id: CAP_ID, capability_secret: randomBytes(32).toString("hex") }],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return backend;
}

async function run(
  t: { mock: { method: Function } },
  rows: Array<Record<string, unknown>>,
  opts: { capability?: "ok" | "null"; behavior?: ConstructorParameters<typeof FakeEmailProvider>[0] } = {}
) {
  const backend = installWorkerBackend(t, rows, opts);
  const provider = new FakeEmailProvider(opts.behavior);
  const result = await processPendingNotifications(provider);
  return { result, provider, backend };
}

// ====================================================================
// [6] E-MAIL DE CONFIRMATION — tous les modes, surcharge marchande.
// ====================================================================

test("[CONFIRM-1] sans surcharge, l'e-mail de confirmation garde EXACTEMENT le sujet et l'intro plateforme", async (t) => {
  const { result, provider } = await run(t, [claimRow("order_received")]);
  assert.equal(result.sent, 1);
  const msg = provider.sent[0]!;
  assert.equal(msg.subject, translate("fr", "emailOrderReceivedSubject", { merchant: "Commandes Alpha", n: 7 }));
  assert.ok(msg.text.includes(translate("fr", "emailOrderReceivedIntro", { n: 7 })));
});

test("[CONFIRM-2] un sujet et un corps marchands FIGÉS dans le snapshot remplacent les textes plateforme", async (t) => {
  const { result, provider } = await run(t, [
    claimRow("order_received", {
      subject_template: "{merchant_name} : votre commande {order_reference}",
      body_template: "Merci ! Nous préparons la commande {order_reference} ({order_total}).",
    }),
  ]);
  assert.equal(result.sent, 1);
  const msg = provider.sent[0]!;
  assert.equal(msg.subject, "Epicerie Alpha : votre commande 7");
  assert.ok(
    msg.text.includes(`Merci ! Nous préparons la commande 7 (${formatPrice(19.9, "EUR")}).`)
  );
  // L'intro plateforme a bien été REMPLACÉE, pas ajoutée.
  assert.equal(msg.text.includes(translate("fr", "emailOrderReceivedIntro", { n: 7 })), false);
});

test("[CONFIRM-3] le récapitulatif reste DÉTENU PAR LA PLATEFORME : un corps marchand ne peut pas supprimer le total ni le lien de suivi", async (t) => {
  const { provider } = await run(t, [
    claimRow("order_received", { body_template: "Bonjour." }),
  ]);
  const msg = provider.sent[0]!;
  assert.ok(msg.text.includes(translate("fr", "confirmTotalLabel")), "libellé du total conservé");
  assert.ok(msg.text.includes(formatPrice(19.9, "EUR")), "montant conservé");
  assert.ok(msg.text.includes(`https://app.scanym.example/track/${ORDER_ID}`), "lien de suivi conservé");
  assert.ok(msg.text.includes(translate("fr", "orderNumber", { n: 7 })), "numéro de commande conservé");
});

test("[CONFIRM-4] tous les modes d'exécution passent : table, pickup, delivery", async (t) => {
  for (const [mode, probe] of [
    ["table", "emailOrderReceivedFulfillmentTable"],
    ["pickup", "emailOrderReceivedFulfillmentPickup"],
    ["delivery", "emailOrderReceivedFulfillmentDelivery"],
  ] as const) {
    const { result, provider } = await run(t, [
      claimRow("order_received", {
        service_mode: mode,
        delivery_address: mode === "delivery" ? "12 rue des Lilas, 75001 Paris" : null,
      }),
    ]);
    assert.equal(result.sent, 1, mode);
    assert.ok(provider.sent[0]!.text.includes(translate("fr", probe)), mode);
  }
});

// ====================================================================
// [7] VARIABLES DE RETRAIT — [8] VARIABLES DE LIVRAISON.
// ====================================================================

test("[PICKUP-VARS] un gabarit de retrait reçoit mode, coordonnées et accusé de facture", () => {
  const values = buildCommunicationTemplateValues({
    locale: "fr",
    payload: {
      order_number: 7,
      total: 19.9,
      currency: "EUR",
      service_mode: "pickup",
      merchant_name: "Epicerie Alpha",
      merchant_address: "3 place du Marché, 75011 Paris",
      merchant_email: "contact@alpha.test",
      merchant_phone: "+33 1 23 45 67 89",
      invoice_requested: true,
      withdrawal_eligible: false,
    },
    withdrawalLink: null,
  });
  assert.equal(values.fulfillment_type, "pickup");
  assert.equal(values.merchant_name, "Epicerie Alpha");
  assert.equal(values.merchant_address, "3 place du Marché, 75011 Paris");
  assert.equal(values.merchant_email, "contact@alpha.test");
  assert.equal(values.merchant_phone, "+33 1 23 45 67 89");
  assert.equal(values.order_reference, "7");
  assert.equal(values.order_total, formatPrice(19.9, "EUR"));
  assert.equal(values.invoice_requested, translate("fr", "commFlagYes"));
  assert.equal(values.withdrawal_eligible, translate("fr", "commFlagNo"));
  // AUCUN modèle de créneau n'existe : ces deux variables restent vides,
  // jamais une date inventée.
  assert.equal(values.fulfillment_date, "");
  assert.equal(values.fulfillment_slot, "");
  assert.equal(values.withdrawal_link, "");
});

test("[DELIVERY-VARS] un gabarit de livraison reçoit le mode livraison et le nom du transporteur", () => {
  const values = buildCommunicationTemplateValues({
    locale: "fr",
    payload: {
      order_number: 9,
      total: 42,
      currency: "EUR",
      service_mode: "delivery",
      merchant_name: "Epicerie Alpha",
      provider_code: "chronofresh",
      fulfillment_code: "froid-national",
      withdrawal_eligible: true,
    },
    withdrawalLink: "https://app.scanym.example/track/x#c1.a.b",
  });
  assert.equal(values.fulfillment_type, "delivery");
  // `provider_code` d'abord (le plus précis), `fulfillment_code` en repli.
  assert.equal(values.carrier_name, "chronofresh");
  assert.equal(values.withdrawal_eligible, translate("fr", "commFlagYes"));
  assert.equal(values.withdrawal_link, "https://app.scanym.example/track/x#c1.a.b");

  const fallback = buildCommunicationTemplateValues({
    locale: "fr",
    payload: { currency: "EUR", fulfillment_code: "froid-national" },
    withdrawalLink: null,
  });
  assert.equal(fallback.carrier_name, "froid-national");
});

test("[DELIVERY-VARS-2] l'adresse de livraison du snapshot atteint bien l'e-mail de livraison", async (t) => {
  const { provider } = await run(t, [
    claimRow("order_received", {
      service_mode: "delivery",
      delivery_address: "12 rue des Lilas, 75001 Paris",
    }),
  ]);
  assert.ok(provider.sent[0]!.text.includes("12 rue des Lilas, 75001 Paris"));
});

// ====================================================================
// [9] REMISE AU TRANSPORTEUR (type Chronofresh).
// ====================================================================

test("[CARRIER-1] l'événement carrier_handoff est RENDU et ENVOYÉ par le MÊME worker", async (t) => {
  const { result, provider, backend } = await run(t, [
    claimRow("carrier_handoff", {
      service_mode: "delivery",
      provider_code: "chronofresh",
      delivery_address: "12 rue des Lilas, 75001 Paris",
    }),
  ]);
  assert.equal(result.sent, 1);
  assert.equal(result.failedTerminal, 0);
  const msg = provider.sent[0]!;
  assert.equal(msg.subject, translate("fr", "emailCarrierHandoffSubject", { merchant: "Commandes Alpha", n: 7 }));
  assert.ok(msg.text.includes(translate("fr", "emailCarrierHandoffHeading")));
  assert.ok(msg.text.includes(translate("fr", "emailCarrierLabel")));
  assert.ok(msg.text.includes("chronofresh"), "libellé du transporteur issu de la configuration");
  // AUCUNE capacité de suivi consommée : un événement additionnel ne
  // doit pas être indélivrable à cause d'un lien de suivi.
  assert.equal(backend.capabilityIssuances, 0);
  assert.equal(backend.rpcNames.includes("issue_order_email_tracking_capability"), false);
});

test("[CARRIER-2] les trois événements du catalogue ont chacun leur PROPRE formulation -- aucun n'emprunte celle d'un autre", async (t) => {
  const subjects = new Set<string>();
  const headings = new Set<string>();
  for (const event of COMMUNICATION_EVENT_CODES) {
    const { result, provider } = await run(t, [claimRow(event)]);
    assert.equal(result.sent, 1, event);
    subjects.add(provider.sent[0]!.subject);
    headings.add(provider.sent[0]!.text.split("\n")[0]!);
  }
  assert.equal(subjects.size, 3, "trois sujets DISTINCTS");
  assert.equal(headings.size, 3, "trois titres DISTINCTS");
});

test("[CARRIER-3] une ligne de transporteur ABSENTE est omise proprement, jamais rendue vide", async (t) => {
  const { provider } = await run(t, [claimRow("carrier_handoff")]);
  assert.equal(
    provider.sent[0]!.text.includes(translate("fr", "emailCarrierLabel")),
    false
  );
});

test("[CARRIER-4] un corps marchand hostile est ÉCHAPPÉ dans le HTML et intact dans le texte", () => {
  const hostile = `<script>alert("x")</script>& "guillemets" 'apostrophes'`;
  const rendered = renderCommunicationEventEmail({
    event: "carrier_handoff",
    locale: "fr",
    merchantSenderName: "Commandes Alpha",
    merchantName: "Epicerie Alpha",
    orderNumber: 7,
    total: 19.9,
    currency: "EUR",
    deliveryAddress: null,
    carrierName: null,
    merchantBody: hostile,
  });
  assert.equal(rendered.html.includes("<script>alert("), false, "aucun script non échappé");
  assert.ok(rendered.html.includes("&lt;script&gt;"), "balise échappée");
  assert.ok(rendered.html.includes("&quot;"), "guillemets échappés");
  assert.ok(rendered.html.includes("&#39;"), "apostrophes échappées");
  assert.ok(rendered.text.includes(hostile), "la variante TEXTE porte la chaîne brute, sans double échappement");
});

// ====================================================================
// [10] E-MAIL FACULTATIF DÉSACTIVÉ.
//
// L'interrupteur est appliqué À L'ENFILEMENT (SQL) : une ligne est
// créée en 'skipped_disabled' et n'est donc JAMAIS réclamée par le
// worker. Ce que ce test prouve côté application : un lot vide ne
// produit aucun envoi, aucune capacité, aucun appel réseau -- et le
// SQL lui-même est prouvé par supabase/tests/merchant-customer-
// communications-v1-check.sh (section [5]).
// ====================================================================

test("[DISABLED-1] un événement non activé n'est jamais réclamé : aucun envoi, aucune capacité, aucun appel provider", async (t) => {
  const { result, provider, backend } = await run(t, []);
  assert.deepEqual(result, { claimed: 0, sent: 0, retriedRetryable: 0, failedTerminal: 0 });
  assert.equal(provider.callCountForAssertions, 0);
  assert.equal(backend.capabilityIssuances, 0);
  assert.deepEqual(backend.rpcNames, ["claim_pending_notifications"]);
});

test("[DISABLED-2] les 8 types placeholders N1-A restent SANS émission active -- comportement inchangé", async (t) => {
  for (const type of [
    "order_accepted",
    "order_preparing",
    "order_ready",
    "order_delivered",
    "order_cancelled",
    "order_rejected",
    "delivery_failed",
    "refund_issued",
  ]) {
    const { result, provider, backend } = await run(t, [claimRow(type)]);
    assert.equal(result.sent, 0, type);
    assert.equal(result.failedTerminal, 1, type);
    assert.equal(provider.callCountForAssertions, 0, type);
    assert.equal(backend.capabilityIssuances, 0, type);
    assert.equal(backend.completed[0]!.p_result, "terminal_failure", type);
    assert.equal(backend.completed[0]!.p_error_class, "TEMPLATE_RENDER_ERROR", type);
  }
});

// ====================================================================
// [13] AUCUN DOUBLON D'ENVOI À LA REPRISE — idempotence.
// ====================================================================

test("[IDEMPOTENCY-1] la clé d'idempotence d'un événement additionnel est dérivée du SEUL outbox_id", async (t) => {
  const row = claimRow("carrier_handoff");
  const outboxId = row.outbox_id as string;
  const { provider } = await run(t, [row]);
  assert.equal(
    provider.sent[0]!.idempotencyKey,
    buildNotificationIdempotencyKey(outboxId)
  );
  assert.equal(provider.sent[0]!.idempotencyKey, `scanym:notification:${outboxId}`);
});

test("[IDEMPOTENCY-2] deux tentatives de la MÊME ligne (reprise) portent la MÊME clé -- un provider déduplique donc", async (t) => {
  const outboxId = randomUUID();
  const first = await run(t, [
    claimRow("carrier_handoff", {}, { outbox_id: outboxId, attempt_count: 0 }),
  ]);
  const second = await run(t, [
    claimRow("carrier_handoff", {}, { outbox_id: outboxId, attempt_count: 1, claim_token: randomUUID() }),
  ]);
  assert.equal(first.provider.sent[0]!.idempotencyKey, second.provider.sent[0]!.idempotencyKey);
  // La clé ne varie NI avec attempt_count NI avec claim_token.
  assert.equal(first.provider.sent[0]!.idempotencyKey, `scanym:notification:${outboxId}`);
  // Et chaque tentative est bien finalisée une seule fois.
  assert.equal(first.backend.completed.length, 1);
  assert.equal(second.backend.completed.length, 1);
});

test("[IDEMPOTENCY-3] un échec réessayable finalise en 'retryable_failure' et n'envoie QU'UNE fois", async (t) => {
  const { result, provider, backend } = await run(
    t,
    [claimRow("carrier_handoff")],
    { behavior: () => ({ ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" }) }
  );
  assert.equal(result.sent, 0);
  assert.equal(result.retriedRetryable, 1);
  assert.equal(provider.callCountForAssertions, 1, "un seul appel provider, jamais une boucle interne");
  assert.equal(backend.completed.length, 1);
  assert.equal(backend.completed[0]!.p_result, "retryable_failure");
  assert.equal(backend.completed[0]!.p_error_class, "PROVIDER_TIMEOUT");
});

test("[IDEMPOTENCY-4] une classe d'erreur hors taxonomie fermée est NORMALISÉE avant persistance", async (t) => {
  const { backend } = await run(
    t,
    [claimRow("carrier_handoff")],
    {
      behavior: () => ({
        ok: false,
        retryable: false,
        errorClass: "Bearer sk-SECRET-TOKEN-DO-NOT-PERSIST",
      }),
    }
  );
  assert.equal(backend.completed[0]!.p_error_class, "UNKNOWN_PROVIDER_ERROR");
  assert.equal(
    JSON.stringify(backend.completed[0]).includes("sk-SECRET-TOKEN"),
    false,
    "la chaîne d'origine ne doit JAMAIS être persistée"
  );
});

// ====================================================================
// [1] ISOLATION MULTI-LOCATAIRES — l'identité d'expédition suit la LIGNE.
// ====================================================================

test("[TENANT-1] deux lignes de deux locataires conservent CHACUNE son expéditeur et son nom de commerçant", async (t) => {
  const { result, provider } = await run(t, [
    claimRow("carrier_handoff", { merchant_name: "Epicerie Alpha" }, {
      restaurant_id: RID_A,
      sender_name: "Commandes Alpha",
      sender_email: "commandes@alpha.example",
      recipient_email: "client-a@example.com",
    }),
    claimRow("carrier_handoff", { merchant_name: "Primeur Beta" }, {
      restaurant_id: RID_B,
      sender_name: "Commandes Beta",
      sender_email: "commandes@beta.example",
      recipient_email: "client-b@example.com",
      order_id: "33333333-3333-4333-8333-333333333333",
    }),
  ]);
  assert.equal(result.sent, 2);
  const [a, b] = provider.sent;
  assert.equal(a!.from, "commandes@alpha.example");
  assert.equal(a!.to, "client-a@example.com");
  assert.ok(a!.text.includes("Epicerie Alpha"));
  assert.equal(a!.text.includes("Primeur Beta"), false, "aucune fuite de B vers A");
  assert.equal(b!.from, "commandes@beta.example");
  assert.equal(b!.to, "client-b@example.com");
  assert.ok(b!.text.includes("Primeur Beta"));
  assert.equal(b!.text.includes("Epicerie Alpha"), false, "aucune fuite de A vers B");
});

test("[TENANT-2] un gabarit marchand d'un locataire ne peut pas atteindre la ligne d'un autre", async (t) => {
  const { provider } = await run(t, [
    claimRow("carrier_handoff", { event_body_template: "CORPS ALPHA {order_reference}" }, {
      restaurant_id: RID_A,
      sender_name: "Commandes Alpha",
    }),
    claimRow("carrier_handoff", {}, {
      restaurant_id: RID_B,
      sender_name: "Commandes Beta",
      order_id: "33333333-3333-4333-8333-333333333333",
    }),
  ]);
  assert.ok(provider.sent[0]!.text.includes("CORPS ALPHA 7"));
  // B n'a aucun gabarit : il reçoit la formulation PLATEFORME, jamais
  // celle de A.
  assert.ok(
    provider.sent[1]!.text.includes(translate("fr", "emailCarrierHandoffIntro", { n: 7 }))
  );
  assert.equal(provider.sent[1]!.text.includes("CORPS ALPHA"), false);
  // Et le SUJET d'un événement additionnel reste PLATEFORME des deux
  // côtés : aucune clé de sujet propre à l'événement n'existe, et ce lot
  // n'en invente pas.
  for (const [i, sender] of [[0, "Commandes Alpha"], [1, "Commandes Beta"]] as const) {
    assert.equal(
      provider.sent[i]!.subject,
      translate("fr", "emailCarrierHandoffSubject", { merchant: sender, n: 7 })
    );
  }
});

test("[TENANT-3] une identité d'expédition absente est un échec TERMINAL, jamais un envoi avec une valeur devinée", async (t) => {
  const { result, provider, backend } = await run(t, [
    claimRow("carrier_handoff", {}, { sender_email: null, sender_name: null }),
  ]);
  assert.equal(result.sent, 0);
  assert.equal(result.failedTerminal, 1);
  assert.equal(provider.callCountForAssertions, 0);
  assert.equal(backend.completed[0]!.p_error_class, "SENDER_IDENTITY_UNRESOLVED");
});

// ====================================================================
// §EVENT-TEMPLATE — CARTOGRAPHIE ÉVÉNEMENT -> GABARIT (v1.1)
//
// Ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01 (audit indépendant
// OpenAI/Codex, blocker 2) : la formulation d'accusé de rétractation du
// commerçant était PERSISTÉE PUIS IGNORÉE, et les trois événements se
// partageaient silencieusement la formulation de l'e-mail de
// CONFIRMATION DE COMMANDE.
//
// Les cinq contrôles EXIGÉS par le mandat de remédiation, plus un
// contrôle négatif et un contrôle de totalité.
// ====================================================================

test("[EVENT-TEMPLATE-1] withdrawal_request_received CONSOMME son propre gabarit", async (t) => {
  const { result, provider } = await run(t, [
    claimRow("withdrawal_request_received", {
      event_body_template: "Votre demande pour la commande {order_reference} est enregistree.",
    }),
  ]);
  assert.equal(result.sent, 1);
  const msg = provider.sent[0]!;
  assert.ok(
    msg.text.includes("Votre demande pour la commande 7 est enregistree."),
    "le gabarit de rétractation doit apparaître dans le corps"
  );
  // Et il REMPLACE l'intro plateforme, il ne s'y ajoute pas.
  assert.equal(
    msg.text.includes(translate("fr", "emailWithdrawalRequestIntro", { n: 7 })),
    false
  );
  // Le sujet reste PLATEFORME : aucune clé de sujet de rétractation
  // n'existe au catalogue, et ce lot n'invente aucune formulation.
  assert.equal(
    msg.subject,
    translate("fr", "emailWithdrawalRequestSubject", { merchant: "Commandes Alpha", n: 7 })
  );
});

test("[EVENT-TEMPLATE-2] changer le gabarit APRÈS l'enfilement ne change pas le message en file", async (t) => {
  // L'instantané est l'unique source du worker. On le prouve
  // COMPORTEMENTALEMENT : le worker ne lit AUCUNE table de
  // configuration -- la seule RPC qu'il émet pour un événement
  // additionnel est la réclamation puis la finalisation.
  const { provider, backend } = await run(t, [
    claimRow("withdrawal_request_received", {
      event_body_template: "GABARIT AU MOMENT DE L'ENFILEMENT",
    }),
  ]);
  assert.ok(provider.sent[0]!.text.includes("GABARIT AU MOMENT DE L'ENFILEMENT"));
  assert.deepEqual(
    backend.rpcNames,
    ["claim_pending_notifications", "complete_notification_attempt"],
    "aucune lecture de merchant_communication_text au moment de l'envoi"
  );
  // Le pendant SQL -- modifier la ligne marchande puis relire
  // l'instantané déjà enfilé -- est prouvé par
  // supabase/tests/merchant-customer-communications-v1-check.sh, §[14].
});

test("[EVENT-TEMPLATE-3] l'e-mail de confirmation de commande n'emploie JAMAIS le gabarit de rétractation", async (t) => {
  const { provider } = await run(t, [
    claimRow("order_received", {
      // Un instantané order_received ne porte PAS event_body_template ;
      // on en pose un quand même, hostile, pour prouver qu'il est ignoré.
      event_body_template: "ACCUSE DE RETRACTATION QUI NE DOIT PAS SORTIR",
      body_template: "Merci pour la commande {order_reference}.",
    }),
  ]);
  const msg = provider.sent[0]!;
  assert.ok(msg.text.includes("Merci pour la commande 7."));
  assert.equal(
    msg.text.includes("ACCUSE DE RETRACTATION QUI NE DOIT PAS SORTIR"),
    false,
    "order_received ne doit lire que body_template"
  );
});

test("[EVENT-TEMPLATE-4] carrier_handoff et local_delivery_handoff n'emploient PAS le gabarit de rétractation", async (t) => {
  for (const event of ["carrier_handoff", "local_delivery_handoff"] as const) {
    const { provider } = await run(t, [
      claimRow(event, {
        event_body_template: `CORPS PROPRE A ${event}`,
        // Clés d'un AUTRE domaine, posées hostilement : aucune ne doit
        // ressortir.
        body_template: "CORPS DE CONFIRMATION DE COMMANDE",
        subject_template: "SUJET DE CONFIRMATION DE COMMANDE",
        withdrawal_template: "ACCUSE DE RETRACTATION",
      }),
    ]);
    const msg = provider.sent[0]!;
    assert.ok(msg.text.includes(`CORPS PROPRE A ${event}`), event);
    for (const forbidden of [
      "CORPS DE CONFIRMATION DE COMMANDE",
      "SUJET DE CONFIRMATION DE COMMANDE",
      "ACCUSE DE RETRACTATION",
    ]) {
      assert.equal(msg.text.includes(forbidden), false, `${event} ne doit pas porter « ${forbidden} »`);
      assert.equal(msg.subject.includes(forbidden), false, `${event} : sujet`);
    }
  }
});

test("[EVENT-TEMPLATE-5] un commerçant SANS surcharge garde la formulation plateforme de CHAQUE événement", async (t) => {
  for (const event of COMMUNICATION_EVENT_CODES) {
    const { result, provider } = await run(t, [claimRow(event)]);
    assert.equal(result.sent, 1, event);
    const msg = provider.sent[0]!;
    const introKey = {
      carrier_handoff: "emailCarrierHandoffIntro",
      local_delivery_handoff: "emailLocalDeliveryHandoffIntro",
      withdrawal_request_received: "emailWithdrawalRequestIntro",
    }[event];
    assert.ok(
      msg.text.includes(translate("fr", introKey, { n: 7 })),
      `${event} : intro plateforme attendue`
    );
    // Et le corps ne contient AUCUN jeton non substitué.
    assert.equal(/\{[a-z0-9_]+\}/.test(msg.text), false, `${event} : aucun jeton résiduel`);
  }
});

test("[EVENT-TEMPLATE-6] un instantané de la version v1 (body_template, withdrawal_template, sans event_body_template) retombe sur la PLATEFORME, jamais sur un emprunt", async (t) => {
  // Compatibilité arrière explicite : une ligne enfilée avant la
  // remédiation ne doit NI échouer, NI emprunter la formulation de
  // l'e-mail de confirmation de commande.
  const { result, provider } = await run(t, [
    claimRow("withdrawal_request_received", {
      body_template: "CORPS DE CONFIRMATION DE COMMANDE (v1)",
      withdrawal_template: "ACCUSE v1 JAMAIS LU PAR v1",
    }),
  ]);
  assert.equal(result.sent, 1);
  const msg = provider.sent[0]!;
  assert.ok(msg.text.includes(translate("fr", "emailWithdrawalRequestIntro", { n: 7 })));
  assert.equal(msg.text.includes("CORPS DE CONFIRMATION DE COMMANDE (v1)"), false);
  assert.equal(msg.text.includes("ACCUSE v1 JAMAIS LU PAR v1"), false);
});

test("[EVENT-TEMPLATE-7] la cartographie est TOTALE, distincte, et n'emprunte pas les clés de l'e-mail de confirmation", () => {
  const targets = COMMUNICATION_EVENT_CODES.map((e) => COMMUNICATION_EVENT_BODY_TEXT_KEY[e]);
  assert.equal(targets.length, COMMUNICATION_EVENT_CODES.length, "totale");
  assert.equal(new Set(targets).size, targets.length, "un gabarit DISTINCT par événement");
  for (const t of targets) {
    assert.equal(
      t === "email_confirmation_subject" || t === "email_confirmation_body",
      false,
      `${t} appartient à l'e-mail de confirmation de commande, pas à un événement`
    );
  }
  assert.deepEqual(COMMUNICATION_EVENT_BODY_TEXT_KEY, {
    carrier_handoff: "confirmation_delivery_carrier",
    local_delivery_handoff: "confirmation_delivery_local",
    withdrawal_request_received: "confirmation_withdrawal_request",
  });
});

// ====================================================================
// AUCUN APPEL FOURNISSEUR DE LIVRAISON — prouvé sur le code source.
// ====================================================================

test("[NO-PROVIDER-CALL] aucun module de ce lot ne mentionne Stuart/Chronofresh en code exécutable", async () => {
  const { readFileSync } = await import("node:fs");
  // Retire les commentaires de ligne et de bloc : la DOCUMENTATION peut
  // légitimement nommer un transporteur (« type Chronofresh »), le CODE
  // non. Même méthode que le garde NO-HARDCODE du lot précédent.
  const executableCode = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const files = [
    "lib/communications/text-keys.ts",
    "lib/communications/template-variables.ts",
    "lib/communications/events.ts",
    "lib/communications/resolve.ts",
    "lib/services/merchant-communications.ts",
    "lib/server/notifications/communication-event-template.ts",
    "lib/server/notifications/communication-template-values.ts",
    "lib/server/withdrawal-eligibility-service.ts",
    "app/api/checkout/withdrawal-eligibility/route.ts",
  ];
  for (const file of files) {
    const code = executableCode(readFileSync(file, "utf8"));
    for (const forbidden of ["stuart", "chronofresh"]) {
      assert.equal(
        code.toLowerCase().includes(forbidden),
        false,
        `${file} ne doit pas mentionner « ${forbidden} » en code exécutable`
      );
    }
    assert.equal(code.includes("delivery-providers"), false, `${file} n'importe aucun provider`);
  }
});
