import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "i211-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

// ====================================================================
// ISSUE #211 — e-mail de confirmation COMPLET : articles, options, quantités, montants, jour/créneau,
// rétractation. Tests SYNTHÉTIQUES : `client.rpc` et `client.from` sont interceptés, `fetch` est interdit,
// le fournisseur est le FakeEmailProvider. Aucun e-mail réel, aucune commande réelle, aucun réseau.
//
//   A. lecture défensive du snapshot (order-received-detail.ts)
//   B. gabarit : HTML ET texte, échappement, FR/EN/AR/NL, RTL, rétractation distincte
//   C. worker de bout en bout : snapshot -> e-mail, sans lecture du catalogue, isolation, rejeu
//   D. textes plateforme : aucune promesse circulaire « un e-mail va vous être envoyé »
// ====================================================================

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { parseOrderReceivedDetail, coherentBreakdown, ORDER_DETAIL_MAX_ITEMS } = await import(
  "../lib/server/notifications/order-received-detail.ts"
);
const { renderOrderReceivedEmail, formatCivilDate, formatFulfillmentSchedule } = await import(
  "../lib/server/notifications/order-received-template.ts"
);
const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
const { translate, DICTS } = await import("../lib/i18n.ts");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_TOKEN = "22222222-2222-4222-8222-222222222222";
const CAP_ID = "33333333-3333-4333-8333-333333333333";
const CAP_SECRET = "ab".repeat(32);
const TRACKING_URL = `https://app.scanym.example/track/${ORDER_ID}#c1.${CAP_ID}.${CAP_SECRET}`;

function forbidNetwork(t: any) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("NETWORK_FORBIDDEN_IN_211_TESTS");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

// Lignes telles que `create_order_received_notification` les fige (valeurs HISTORIQUES de order_items).
const ITEMS = [
  { item_name: "Comté 24 mois", option_name: "Tranche 200 g", quantity: 2, unit_price: 12.5, line_total: 25 },
  { item_name: "Fromage <b>frais</b> & \"maison\"", option_name: null, quantity: 1, unit_price: 4.2, line_total: 4.2 },
];

const SCHEDULE_WINDOW = {
  mode_code: "pickup", scheduled_date: "2026-11-05", selected_time: null,
  window_starts_at: "16:00", window_ends_at: "20:00", timezone: "Europe/Paris",
  date_selection_mode: "customer_choice", slot_selection_mode: "fixed_window", origin: "customer",
};

const baseSnapshot = (extra: Record<string, unknown> = {}) => ({
  order_number: 42, total: 29.2, currency: "EUR", service_mode: "pickup",
  public_token: LEGACY_TOKEN, created_at: "2026-11-03T09:59:00Z", order_status: "new",
  merchant_name: "Au Lait Cru", withdrawal_eligible: false,
  merchant_address: "12 rue du Marché, 75000 Paris",
  order_email_detail_v1: true, items: ITEMS, subtotal: 29.2, delivery_fee: 0,
  schedule: SCHEDULE_WINDOW, fulfillment_date: "2026-11-05", fulfillment_slot: "16:00–20:00",
  ...extra,
});

const baseInput = {
  locale: "fr" as const, merchantSenderName: "Au Lait Cru", merchantName: "Au Lait Cru",
  orderNumber: 42, total: 29.2, currency: "EUR", serviceMode: "pickup",
  orderId: ORDER_ID, trackingCapabilityId: CAP_ID, trackingSecret: CAP_SECRET,
  statusText: "", deliveryAddress: null,
};

const detailOf = (snap: Record<string, unknown>) => parseOrderReceivedDetail(snap, String(snap.service_mode));

// --------------------------------------------------------------------
// A. Lecture défensive
// --------------------------------------------------------------------

test("[211-A1] snapshot complet : lignes historiques, montants, jour/fenêtre/fuseau ; la clé interne de créneau n'est jamais lue", () => {
  const d = detailOf(baseSnapshot({ schedule: { ...SCHEDULE_WINDOW, slot_key: "evening-16-20" } }));
  assert.equal(d.items!.length, 2);
  assert.deepEqual(d.items![0], { name: "Comté 24 mois", option: "Tranche 200 g", quantity: 2, unitPrice: 12.5, lineTotal: 25 });
  assert.equal(d.items![1]!.option, null);
  assert.equal(d.subtotal, 29.2);
  assert.equal(d.deliveryFee, 0);
  assert.deepEqual(d.schedule, { date: "2026-11-05", time: "16:00–20:00", timezone: "Europe/Paris" });
  assert.equal(JSON.stringify(d).includes("evening-16-20"), false, "slot_key ne traverse pas la lecture");
});

test("[211-A2] ancien snapshot (aucune clé #211) : aucun récapitulatif, aucune valeur inventée", () => {
  const old = { order_number: 1, total: 10, currency: "EUR", service_mode: "pickup", public_token: LEGACY_TOKEN };
  assert.deepEqual(detailOf(old), { items: null, subtotal: null, deliveryFee: null, schedule: null, merchantAddress: null, scheduleAuthoritative: false });
});

test("[211-A2b] AUD214-02 : le snapshot est « autoritaire » pour le planning dès que le marqueur OU la clé schedule (même null) est présent ; jamais pour une ligne antérieure", () => {
  const old = { order_number: 1, total: 10, currency: "EUR", service_mode: "pickup", public_token: LEGACY_TOKEN, fulfillment_date: "2026-11-05" };
  assert.equal(detailOf(old).scheduleAuthoritative, false, "ligne antérieure : repli #172 conservé");
  assert.equal(detailOf({ ...old, order_email_detail_v1: true }).scheduleAuthoritative, true, "marqueur");
  assert.equal(detailOf({ ...old, schedule: null }).scheduleAuthoritative, true, "clé schedule null (table / pas de planning)");
  assert.equal(detailOf({ ...old, schedule: { scheduled_date: "2026-02-30" } }).scheduleAuthoritative, true, "planning rejeté : reste autoritaire");
  assert.equal(detailOf({ ...old, schedule: { scheduled_date: "2026-02-30" } }).schedule, null);
  assert.equal(detailOf({ ...old, order_email_detail_v1: "true" }).scheduleAuthoritative, false, "marqueur non booléen : ignoré");
});

test("[211-A3] lignes mal formées : TOUT ou RIEN (jamais un panier amputé présenté comme complet) ; bornes", () => {
  const bad: unknown[] = [
    "pas un tableau", [], [null], [{ ...ITEMS[0], quantity: 0 }], [{ ...ITEMS[0], quantity: 1.5 }],
    [{ ...ITEMS[0], item_name: "  " }], [{ ...ITEMS[0], unit_price: -1 }], [{ ...ITEMS[0], line_total: "x" }],
    [ITEMS[0], { ...ITEMS[1], quantity: "2" }],
    Array.from({ length: ORDER_DETAIL_MAX_ITEMS + 1 }, () => ITEMS[0]),
  ];
  for (const items of bad) assert.equal(detailOf(baseSnapshot({ items })).items, null, JSON.stringify(items)?.slice(0, 60));
  assert.equal(detailOf(baseSnapshot({ items: Array.from({ length: ORDER_DETAIL_MAX_ITEMS }, () => ITEMS[0]) })).items!.length, ORDER_DETAIL_MAX_ITEMS);
  // Un numeric sérialisé en chaîne décimale stricte est accepté ; une autre forme non.
  assert.equal(detailOf(baseSnapshot({ items: [{ ...ITEMS[0], unit_price: "12.50", line_total: "25.00" }] })).items![0]!.lineTotal, 25);
});

test("[211-A4] planning : jour seul sans heure inventée ; table/chambre sans planning ; mode contradictoire, date impossible, fuseau douteux", () => {
  const dateOnly = { ...SCHEDULE_WINDOW, selected_time: null, window_starts_at: null, window_ends_at: null };
  assert.deepEqual(detailOf(baseSnapshot({ schedule: dateOnly })).schedule, { date: "2026-11-05", time: null, timezone: "Europe/Paris" });
  const free = { ...SCHEDULE_WINDOW, selected_time: "12:30", window_starts_at: null, window_ends_at: null };
  assert.equal(detailOf(baseSnapshot({ schedule: free })).schedule!.time, "12:30");
  assert.equal(detailOf(baseSnapshot({ service_mode: "table", schedule: SCHEDULE_WINDOW })).schedule, null);
  assert.equal(detailOf(baseSnapshot({ service_mode: "room_service", schedule: SCHEDULE_WINDOW })).schedule, null);
  assert.equal(detailOf(baseSnapshot({ schedule: { ...SCHEDULE_WINDOW, mode_code: "delivery" } })).schedule, null, "planning d'un autre mode");
  assert.equal(detailOf(baseSnapshot({ schedule: { ...SCHEDULE_WINDOW, scheduled_date: "2026-02-31" } })).schedule, null);
  assert.equal(detailOf(baseSnapshot({ schedule: { ...SCHEDULE_WINDOW, scheduled_date: "05/11/2026" } })).schedule, null);
  assert.equal(detailOf(baseSnapshot({ schedule: { ...SCHEDULE_WINDOW, timezone: "Europe/Paris<script>" } })).schedule!.timezone, null);
  // Heures hors format : ignorées (jamais recopiées telles quelles).
  assert.equal(detailOf(baseSnapshot({ schedule: { ...SCHEDULE_WINDOW, selected_time: "25:99", window_starts_at: "9h", window_ends_at: "11h" } })).schedule!.time, null);
});

test("[211-A5] détail des montants : seulement s'il est cohérent avec les lignes ET le total autoritaire", () => {
  const items = detailOf(baseSnapshot()).items;
  assert.deepEqual(coherentBreakdown(items, 29.2, 0, 29.2), { subtotal: 29.2, deliveryFee: 0 });
  assert.deepEqual(coherentBreakdown(items, 29.2, 3.5, 32.7), { subtotal: 29.2, deliveryFee: 3.5 });
  assert.equal(coherentBreakdown(items, 29.2, 3.5, 30), null, "sous-total + frais != total");
  assert.equal(coherentBreakdown(items, 30, 0, 30), null, "sous-total != somme des lignes");
  assert.equal(coherentBreakdown(items, null, 0, 29.2), null);
  assert.equal(coherentBreakdown(null, 29.2, 0, 29.2), null);
});

// --------------------------------------------------------------------
// B. Gabarit
// --------------------------------------------------------------------

test("[211-B1] FR : articles, options, quantités, prix, total, jour et créneau (fenêtre + fuseau) en HTML ET en texte", () => {
  const d = detailOf(baseSnapshot());
  const mail = renderOrderReceivedEmail({
    ...baseInput, items: d.items, subtotal: d.subtotal, deliveryFee: d.deliveryFee, schedule: d.schedule,
    merchantAddress: d.merchantAddress,
  });
  for (const body of [mail.text, mail.html]) {
    assert.ok(body.includes("Comté 24 mois"));
    assert.ok(body.includes("Tranche 200 g"));
    assert.ok(/2\s×\sComté/.test(body), body);
    assert.ok(body.includes("jeudi 5 novembre 2026"), body);
    assert.ok(body.includes("16:00–20:00 (Europe/Paris)"), body);
    assert.ok(body.includes("Jour de retrait :"));
    assert.ok(body.includes("Créneau de retrait :"));
    assert.ok(body.includes("12 rue du Marché"));
    assert.ok(/29,20\s€/.test(body), body);
  }
  // Retrait sans frais : pas de ligne sous-total/frais redondante.
  assert.equal(mail.text.includes("Sous-total"), false);
  assert.equal(mail.text.includes("Frais de livraison"), false);
  assert.ok(mail.text.includes(`Montant total : `));
});

test("[211-B2] livraison : sous-total + frais + total, adresse de livraison ; jour seul (Chronofresh) sans créneau inventé", () => {
  const snap = baseSnapshot({
    service_mode: "delivery", total: 32.7, delivery_fee: 3.5,
    schedule: { ...SCHEDULE_WINDOW, mode_code: "delivery", window_starts_at: null, window_ends_at: null },
    delivery_address: "1 avenue Test, 75001 Paris",
  });
  const d = detailOf(snap);
  const mail = renderOrderReceivedEmail({
    ...baseInput, serviceMode: "delivery", total: 32.7, deliveryAddress: "1 avenue Test, 75001 Paris",
    items: d.items, subtotal: d.subtotal, deliveryFee: d.deliveryFee, schedule: d.schedule, merchantAddress: d.merchantAddress,
  });
  assert.ok(/Sous-total : 29,20\s€/.test(mail.text), mail.text);
  assert.ok(/Frais de livraison : 3,50\s€/.test(mail.text), mail.text);
  assert.ok(/Montant total : 32,70\s€/.test(mail.text), mail.text);
  assert.ok(mail.text.includes("Jour de livraison : jeudi 5 novembre 2026"));
  assert.equal(mail.text.includes("Créneau de livraison"), false, "aucune heure inventée pour un jour seul");
  assert.ok(mail.text.includes("Adresse de livraison : 1 avenue Test"));
  assert.equal(mail.text.includes("Adresse du commerçant"), false, "l'adresse du commerçant n'est pas l'adresse utile en livraison");
});

test("[211-B3] table : ni jour/créneau ni adresse, même si un planning est fourni ; articles et total présents", () => {
  const d = detailOf(baseSnapshot({ service_mode: "table" }));
  const mail = renderOrderReceivedEmail({
    ...baseInput, serviceMode: "table", items: d.items, schedule: SCHEDULE_WINDOW as never, merchantAddress: "12 rue du Marché",
    subtotal: d.subtotal, deliveryFee: d.deliveryFee,
  });
  assert.equal(/Jour de|Créneau|Adresse/.test(mail.text), false, mail.text);
  assert.ok(mail.text.includes("Comté 24 mois"));
});

test("[211-B4] toute chaîne marchande/client est ÉCHAPPÉE en HTML et reste littérale en texte ; pas de double substitution", () => {
  const d = detailOf(baseSnapshot({ items: [
    ...ITEMS,
    { item_name: "{unit} {total}", option_name: "{option}", quantity: 3, unit_price: 1, line_total: 3 },
  ], total: 32.2, subtotal: 32.2 }));
  const mail = renderOrderReceivedEmail({ ...baseInput, total: 32.2, items: d.items, subtotal: d.subtotal, deliveryFee: 0, schedule: d.schedule });
  assert.equal(mail.html.includes("<b>frais</b>"), false);
  assert.ok(mail.html.includes("Fromage &lt;b&gt;frais&lt;/b&gt; &amp; &quot;maison&quot;"), mail.html);
  assert.ok(mail.text.includes("Fromage <b>frais</b> & \"maison\""));
  assert.ok(mail.text.includes("3 × {unit} {total} — "), "le nom {unit} {total} n'est pas re-développé");
  assert.ok(mail.text.includes("Option : {option}"));
});

test("[211-B5] FR/EN/AR/NL : libellés présents dans la langue, jamais de clé brute ni de repli français pour NL", () => {
  const keys = [
    "emailOrderReceivedSubject", "emailOrderReceivedHeading", "emailOrderReceivedIntro", "emailOrderReceivedFulfillmentTable",
    "emailOrderReceivedFulfillmentPickup", "emailOrderReceivedFulfillmentDelivery", "emailOrderReceivedFooter",
    "emailOrderReceivedMerchantLabel", "emailOrderReceivedDeliveryAddressLabel", "emailOrderReceivedSlotLabelPickup",
    "emailOrderReceivedSlotLabelDelivery", "emailOrderReceivedDayLabelPickup", "emailOrderReceivedDayLabelDelivery",
    "emailOrderReceivedItemsHeading", "emailOrderReceivedItemLine", "emailOrderReceivedItemOption",
    "emailOrderReceivedSubtotalLabel", "emailOrderReceivedDeliveryFeeLabel", "emailOrderReceivedMerchantAddressLabel",
    "emailOrderReceivedWithdrawalNote", "confirmTotalLabel", "confirmThanks", "orderNumber", "trackYourOrder",
    "confirmWithdrawalCta",
    ...["new", "accepted", "preparing", "ready", "completed", "rejected", "cancelled"].map((s) => `trackingStatusExplain_${s}`),
  ];
  for (const locale of ["fr", "en", "ar", "nl"] as const) {
    for (const key of keys) {
      const text = (DICTS[locale] as Record<string, string>)[key];
      assert.equal(typeof text, "string", `${locale}/${key} défini dans SON dictionnaire (pas de repli)`);
      assert.notEqual(text, key);
    }
  }
  for (const key of keys) {
    for (const placeholder of ["{qty}", "{name}", "{unit}", "{total}", "{option}"]) {
      const inFr = (DICTS.fr as Record<string, string>)[key]!.includes(placeholder);
      for (const locale of ["en", "ar", "nl"] as const) {
        assert.equal((DICTS[locale] as Record<string, string>)[key]!.includes(placeholder), inFr, `${locale}/${key} ${placeholder}`);
      }
    }
  }
  const d = detailOf(baseSnapshot());
  const fr = renderOrderReceivedEmail({ ...baseInput, items: d.items, schedule: d.schedule }).text;
  const nl = renderOrderReceivedEmail({ ...baseInput, locale: "nl", items: d.items, schedule: d.schedule, subtotal: d.subtotal, deliveryFee: d.deliveryFee, withdrawalEligible: true });
  assert.ok(nl.text.includes("Bestelling ontvangen"), nl.text);
  assert.ok(nl.text.includes("Uw bestelling:"));
  assert.ok(nl.text.includes("Afhaaldag: donderdag 5 november 2026"), nl.text);
  assert.ok(nl.text.includes("Afhaaltijdvak: 16:00–20:00 (Europe/Paris)"));
  assert.ok(nl.text.includes("Herroeping aanvragen: " + TRACKING_URL));
  for (const frenchOnly of ["Commande", "Votre commande", "Montant total", "Jour de retrait", "Créneau", "rétractation"]) {
    assert.equal(nl.text.includes(frenchOnly), false, `NL sans « ${frenchOnly} » (repli français)`);
    assert.equal(nl.html.includes(frenchOnly), false);
  }
  assert.ok(fr.includes("Votre commande :"));
  const en = renderOrderReceivedEmail({ ...baseInput, locale: "en", items: d.items, schedule: d.schedule });
  assert.ok(en.text.includes("Pickup day: Thursday, 5 November 2026"), en.text);
  assert.ok(en.text.includes("Pickup time slot: 16:00–20:00 (Europe/Paris)"));
});

test("[211-B6] arabe : <html lang=\"ar\"> inchangé + <body dir=rtl>, lignes de texte marquées droite-à-gauche, montants/heures/noms isolés, chiffres latins", () => {
  const d = detailOf(baseSnapshot());
  const mail = renderOrderReceivedEmail({
    ...baseInput, locale: "ar", items: d.items, subtotal: d.subtotal, deliveryFee: d.deliveryFee, schedule: d.schedule, withdrawalEligible: true,
  });
  assert.ok(mail.html.includes('<html lang="ar">\n<body dir="rtl">'), mail.html.slice(0, 120));
  for (const line of mail.text.split("\n").filter((l) => l !== "")) assert.ok(line.startsWith("‏"), JSON.stringify(line));
  assert.ok(mail.text.includes("⁦" + "16:00–20:00" + "⁩"), "heure isolée (LTR)");
  assert.ok(mail.text.includes("⁦Europe/Paris⁩"));
  assert.ok(mail.text.includes("⁨Comté 24 mois⁩"), "nom latin isolé dans la phrase arabe");
  assert.ok(/⁦.*29[,.]20.*⁩/.test(mail.text), "montant isolé");
  assert.ok(/5\s\S+\s2026/.test(formatCivilDate("ar", "2026-11-05")!), "chiffres latins pour la date arabe");
  assert.equal(/[٠-٩]/.test(mail.text), false, "aucun chiffre arabo-indien");
  // Les autres langues n'ont NI dir ni marque.
  const fr = renderOrderReceivedEmail({ ...baseInput, items: d.items });
  assert.equal(fr.html.includes("dir="), false);
  assert.equal(/[‏⁦⁨⁩]/.test(fr.text), false);
});

test("[211-B7] rétractation : action SÉPARÉE « Demander une rétractation » si éligible (même cible serveur), absente sinon ; aucune promesse", () => {
  const eligible = renderOrderReceivedEmail({ ...baseInput, withdrawalEligible: true });
  const label = translate("fr", "confirmWithdrawalCta");
  assert.equal(label, "Demander une rétractation");
  assert.ok(eligible.text.includes(`${label}: ${TRACKING_URL}`));
  assert.ok(eligible.html.includes(`<a href="${TRACKING_URL}">${label}</a>`));
  assert.ok(eligible.html.includes(`<a href="${TRACKING_URL}">${translate("fr", "trackYourOrder")}</a>`), "le lien de suivi reste présent");
  assert.ok(eligible.text.includes(translate("fr", "emailOrderReceivedWithdrawalNote")));
  assert.ok(/ni promesse de remboursement/.test(eligible.text));
  assert.equal((eligible.text.match(/https:\/\/\S+/g) ?? []).length, 2, "deux liens : suivi et rétractation, même cible");
  assert.equal(eligible.text.includes(LEGACY_TOKEN), false);
  for (const locale of ["en", "ar", "nl"] as const) {
    const m = renderOrderReceivedEmail({ ...baseInput, locale, withdrawalEligible: true });
    assert.ok(m.text.includes(`${translate(locale, "confirmWithdrawalCta")}: ${TRACKING_URL}`), locale);
  }
  const ineligible = renderOrderReceivedEmail({ ...baseInput, withdrawalEligible: false });
  assert.equal(ineligible.text.includes(label), false);
  assert.equal(ineligible.text.includes(translate("fr", "emailOrderReceivedWithdrawalNote")), false);
  assert.equal((ineligible.text.match(/https:\/\/\S+/g) ?? []).length, 1);
  // Aucun délai ni droit énoncé dans l'e-mail.
  assert.equal(/\b14\b|jours|L221/.test(eligible.text), false);
});

test("[211-B8] sans récapitulatif (ancienne ligne) : rendu identique à l'état d'avant, aucune ligne vide", () => {
  const plain = renderOrderReceivedEmail(baseInput);
  const withNulls = renderOrderReceivedEmail({ ...baseInput, items: null, subtotal: null, deliveryFee: null, schedule: null, merchantAddress: null });
  assert.deepEqual(withNulls, plain);
  assert.equal(plain.text.includes("Votre commande :"), false);
  assert.equal(/\n\n/.test(plain.text), false);
});

// --------------------------------------------------------------------
// C. Worker de bout en bout
// --------------------------------------------------------------------

interface Row {
  outboxId: string; restaurantId: string; orderId: string; locale: string; payload: Record<string, unknown>; sender: string;
}

function installWorkerRpc(t: any, rows: Row[]) {
  const claimToken = randomUUID();
  const completed: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let claimedOnce = false;
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    switch (name) {
      case "claim_new_order_notifications": {
        if (claimedOnce) return { data: [], error: null };
        claimedOnce = true;
        return {
          data: rows.map((r) => ({
            outbox_id: r.outboxId, restaurant_id: r.restaurantId, order_id: r.orderId,
            notification_type: "order_received", recipient_email: "client@example.test", locale: r.locale,
            payload_snapshot: r.payload, attempt_count: 0, claim_token: claimToken,
            sender_name: r.sender, sender_email: "contact@example.test", reply_to: null,
          })),
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
  // Le worker ne doit lire AUCUNE table (catalogue, commandes, planning) : tout vient du snapshot.
  const tables: string[] = [];
  t.mock.method(client, "from", (table: string) => {
    tables.push(table);
    throw new Error(`LECTURE_DE_TABLE_INTERDITE:${table}`);
  });
  return { completed, calls, tables };
}

const row = (payload: Record<string, unknown>, locale = "fr", over: Partial<Row> = {}): Row => ({
  outboxId: randomUUID(), restaurantId: randomUUID(), orderId: ORDER_ID, locale, payload, sender: "Au Lait Cru", ...over,
});

test("[211-C1] commande synthétique via le VRAI worker : articles + option + quantités + montants + jour/créneau en HTML ET texte, sans lecture de table", async (t) => {
  forbidNetwork(t);
  const { completed, calls, tables } = installWorkerRpc(t, [row(baseSnapshot({ withdrawal_eligible: true }))]);
  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);
  assert.equal(result.sent, 1);
  const mail = provider.sent[0]!;
  for (const body of [mail.text, mail.html!]) {
    assert.ok(body.includes("Comté 24 mois") && body.includes("Tranche 200 g"));
    assert.ok(body.includes("jeudi 5 novembre 2026") && body.includes("16:00–20:00 (Europe/Paris)"));
  }
  assert.ok(mail.text.includes(`${translate("fr", "confirmWithdrawalCta")}: ${TRACKING_URL}`));
  assert.equal(mail.text.includes(LEGACY_TOKEN), false);
  assert.equal(mail.text.includes("evening-16-20"), false);
  assert.deepEqual(tables, [], "aucune table lue par le worker");
  assert.deepEqual(calls.sort(), ["claim_new_order_notifications", "complete_notification_attempt", "issue_order_email_tracking_capability"]);
  assert.equal(completed[0]!.p_result, "success");
});

test("[211-C2] valeurs HISTORIQUES : le snapshot fait foi même si le produit a été renommé/repricé/archivé après la commande", async (t) => {
  forbidNetwork(t);
  // Le « catalogue » a changé depuis : il n'est de toute façon jamais lu (client.from interdit ci-dessus).
  installWorkerRpc(t, [row(baseSnapshot())]);
  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  assert.ok(/12,50\s€ l'unité/.test(provider.sent[0]!.text), provider.sent[0]!.text);
  assert.ok(/25,00\s€/.test(provider.sent[0]!.text));
});

test("[211-C3] locales de la file : en / ar / nl rendus dans leur langue ; locale inconnue -> français", async (t) => {
  forbidNetwork(t);
  for (const [locale, marker] of [["en", "Your order:"], ["ar", "طلبك:"], ["nl", "Uw bestelling:"], ["xx", "Votre commande :"]] as const) {
    installWorkerRpc(t, [row(baseSnapshot(), locale)]);
    const provider = new FakeEmailProvider();
    await processPendingNotifications(provider);
    assert.ok(provider.sent[0]!.text.includes(marker), `${locale}: ${provider.sent[0]!.text}`);
    t.mock.restoreAll();
  }
});

test("[211-C4] isolation : deux restaurants dans le même lot -> chaque e-mail ne porte QUE ses lignes et son adresse", async (t) => {
  forbidNetwork(t);
  const a = baseSnapshot({ items: [{ item_name: "Produit A", option_name: null, quantity: 1, unit_price: 10, line_total: 10 }], total: 10, subtotal: 10, merchant_address: "Adresse A" });
  const b = baseSnapshot({ items: [{ item_name: "Produit B", option_name: null, quantity: 4, unit_price: 5, line_total: 20 }], total: 20, subtotal: 20, merchant_address: "Adresse B" });
  installWorkerRpc(t, [row(a), row(b)]);
  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  assert.equal(provider.sent.length, 2);
  const [first, second] = provider.sent as [any, any];
  assert.ok(first.text.includes("Produit A") && first.text.includes("Adresse A"));
  assert.equal(/Produit B|Adresse B/.test(first.text), false);
  assert.ok(second.text.includes("Produit B") && second.text.includes("Adresse B"));
  assert.equal(/Produit A|Adresse A/.test(second.text), false);
});

test("[211-C5] snapshot ancien ou récapitulatif mal formé : l'e-mail PART quand même, sans récapitulatif (jamais un échec d'envoi)", async (t) => {
  forbidNetwork(t);
  installWorkerRpc(t, [
    row({ order_number: 7, total: 10, currency: "EUR", service_mode: "pickup", public_token: LEGACY_TOKEN }),
    row(baseSnapshot({ items: [{ item_name: "", quantity: -1 }], schedule: { scheduled_date: "nope" } })),
  ]);
  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);
  assert.equal(result.sent, 2);
  for (const m of provider.sent) {
    assert.equal(m.text.includes("Votre commande :"), false);
    assert.equal(m.text.includes("Jour de retrait"), false);
    // AUD214-02 : le planning rejeté ne revient pas par les clés « à plat » (fulfillment_date = 2026-11-05 dans baseSnapshot).
    assert.equal(/novembre|16:00/.test(m.text + (m.html ?? "")), false, m.text);
    assert.ok(m.text.includes(`: ${TRACKING_URL}`));
  }
});

test("[211-C6] rejeu : un échec réessayable n'envoie QU'une fois ; même clé d'idempotence ; le second passage rend le MÊME contenu", async (t) => {
  forbidNetwork(t);
  const r = row(baseSnapshot());
  const calls: string[] = [];
  let claims = 0;
  const completed: Array<Record<string, unknown>> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "claim_new_order_notifications") {
      claims += 1;
      return claims > 2 ? { data: [], error: null } : { data: [{
        outbox_id: r.outboxId, restaurant_id: r.restaurantId, order_id: ORDER_ID, notification_type: "order_received",
        recipient_email: "client@example.test", locale: "fr", payload_snapshot: r.payload, attempt_count: claims - 1,
        claim_token: randomUUID(), sender_name: "Au Lait Cru", sender_email: "contact@example.test", reply_to: null,
      }], error: null };
    }
    if (name === "issue_order_email_tracking_capability") return { data: [{ capability_id: CAP_ID, capability_secret: CAP_SECRET }], error: null };
    if (name === "complete_notification_attempt") { completed.push(args); return { data: null, error: null }; }
    throw new Error(`RPC inattendue : ${name}`);
  });
  const provider = new FakeEmailProvider((_m, attempt) => attempt === 1 ? { ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" } : { ok: true, providerMessageId: "ok" });
  await processPendingNotifications(provider);
  await processPendingNotifications(provider);
  await processPendingNotifications(provider);
  assert.equal(provider.sent.length, 2, "une tentative échouée + une réussie, jamais plus");
  assert.equal(provider.sent[0]!.idempotencyKey, provider.sent[1]!.idempotencyKey);
  assert.equal(provider.sent[0]!.text, provider.sent[1]!.text);
  assert.deepEqual(completed.map((c) => c.p_result), ["retryable_failure", "success"]);
});

test("[211-C7] variables marchandes {fulfillment_date}/{fulfillment_slot} : valeurs persistées, date dans la langue du client, jour seul => créneau vide", async (t) => {
  forbidNetwork(t);
  const body = "Retrait le {fulfillment_date} ({fulfillment_slot}).";
  installWorkerRpc(t, [
    row(baseSnapshot({ body_template: body })),
    row(baseSnapshot({ body_template: body, schedule: { ...SCHEDULE_WINDOW, window_starts_at: null, window_ends_at: null }, fulfillment_slot: null })),
  ]);
  const provider = new FakeEmailProvider();
  await processPendingNotifications(provider);
  assert.ok(provider.sent[0]!.text.includes("Retrait le jeudi 5 novembre 2026 (16:00–20:00)."), provider.sent[0]!.text);
  assert.ok(provider.sent[1]!.text.includes("Retrait le jeudi 5 novembre 2026 ()."), provider.sent[1]!.text);
});

// --------------------------------------------------------------------
// AUD214-02 : un planning REJETÉ ne doit jamais réapparaître (ni via le repli antérieur, ni via les variables
// marchandes) — « 30 février » ne devient jamais « 2 mars ».
// --------------------------------------------------------------------

const REJECTED_SCHEDULES: Array<[string, Record<string, unknown>, string]> = [
  ["30-fevrier", { ...SCHEDULE_WINDOW, scheduled_date: "2026-02-30" }, "2026-02-30"],
  ["31-avril", { ...SCHEDULE_WINDOW, scheduled_date: "2026-04-31" }, "2026-04-31"],
  ["mois-13", { ...SCHEDULE_WINDOW, scheduled_date: "2026-13-01" }, "2026-13-01"],
  ["29-fevrier-non-bissextile", { ...SCHEDULE_WINDOW, scheduled_date: "2027-02-29" }, "2027-02-29"],
  ["forme-non-iso", { ...SCHEDULE_WINDOW, scheduled_date: "2026-2-3" }, "2026-2-3"],
  ["mode-contradictoire", { ...SCHEDULE_WINDOW, mode_code: "delivery" }, "2026-11-05"],
  ["objet-absent-de-date", { ...SCHEDULE_WINDOW, scheduled_date: null }, "2026-11-05"],
];

test("[211-C8] AUD214-02 via le VRAI worker : un planning rejeté n'est ni affiché, ni réinterprété par le repli antérieur, ni injecté dans les variables marchandes (avec ET sans marqueur)", async (t) => {
  forbidNetwork(t);
  const body = "Retrait : [{fulfillment_date}] [{fulfillment_slot}]";
  const cases: Array<{ label: string; payload: Record<string, unknown> }> = [];
  for (const [label, schedule, legacyDate] of REJECTED_SCHEDULES) {
    // Les clés « à plat » reprennent la date (impossible ou non) : c'est ce que le repli antérieur formaterait.
    cases.push({ label: `${label}/marqueur`, payload: baseSnapshot({ body_template: body, schedule, fulfillment_date: legacyDate, fulfillment_slot: "16:00\u201320:00" }) });
    const { order_email_detail_v1: _omit, ...noMarker } = baseSnapshot({ body_template: body, schedule, fulfillment_date: legacyDate, fulfillment_slot: "16:00\u201320:00" }) as Record<string, unknown>;
    cases.push({ label: `${label}/sans-marqueur`, payload: noMarker });
  }
  installWorkerRpc(t, cases.map((c) => row(c.payload)));
  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);
  assert.equal(result.sent, cases.length);
  cases.forEach((c, i) => {
    const mail = provider.sent[i]!;
    for (const [kind, text] of [["texte", mail.text], ["html", mail.html!]] as const) {
      assert.equal(/\bmars\b|2026-02-30|2026-04-31|2026-13-01|2027-02-29|2026-2-3/i.test(text), false, `${c.label} (${kind}) : date impossible réapparue\n${text.slice(0, 600)}`);
      const labels = ["emailOrderReceivedDayLabelPickup", "emailOrderReceivedSlotLabelPickup", "emailOrderReceivedDayLabelDelivery", "emailOrderReceivedSlotLabelDelivery"].map((k) => translate("fr", k));
      assert.equal(labels.some((l) => text.includes(l)) || /5 novembre|16:00/.test(text), false, `${c.label} (${kind}) : ligne de jour/créneau rendue\n${text.slice(0, 600)}`);
    }
    assert.equal(mail.text.includes("Retrait : [] []"), true, `${c.label} : variables marchandes vides\n${mail.text}`);
  });
});

test("[211-C9] AUD214-02 gabarit seul : le repli antérieur ne réinterprète JAMAIS une date impossible (30 février) ; une date valide garde son rendu", () => {
  assert.equal(formatFulfillmentSchedule("fr", "2026-02-30", null), null, "impossible -> rien, pas « 2 mars »");
  assert.equal(formatFulfillmentSchedule("fr", "2026-02-30", "16:00"), null, "date impossible : le créneau seul ne survit pas à une date rejetée");
  assert.equal(formatFulfillmentSchedule("fr", "2026-04-31", null), null);
  assert.equal(formatFulfillmentSchedule("fr", "2026-11-05", "16:00"), "jeudi 5 novembre 2026, 16:00", "valide : inchangé");
  assert.equal(formatFulfillmentSchedule("fr", "demain matin", null), "demain matin", "forme libre non ISO : contrat antérieur inchangé");
  const mail = renderOrderReceivedEmail({ ...baseInput, fulfillmentDate: "2026-02-30", fulfillmentSlot: "16:00", schedule: null });
  assert.equal(/mars|2026-02-30|16:00/.test(mail.text + mail.html), false);
});

// --------------------------------------------------------------------
// D. Textes plateforme
// --------------------------------------------------------------------

test("[211-D1] aucun texte PLATEFORME de l'e-mail n'annonce « un e-mail va vous être envoyé » (circulaire, dans un e-mail déjà reçu)", () => {
  const circular: Record<string, RegExp[]> = {
    fr: [/vous recevrez (un|une) (e-?mail|courriel|message|confirmation)/i, /un e-?mail (vous )?(sera|va)/i, /par e-?mail/i],
    en: [/you will (receive|get) an? (e-?mail|message|confirmation)/i, /an e-?mail will be (sent|delivered)/i, /by e-?mail/i],
    ar: [/ستتلقى\s+(رسالة|بريد)/, /سيصلك\s+(بريد|رسالة)/],
    nl: [/u ontvangt (een|nog een) e-?mail/i, /een e-?mail wordt (nog )?verzonden/i, /per e-?mail/i],
  };
  const keys = [
    "emailOrderReceivedHeading", "emailOrderReceivedIntro", "emailOrderReceivedFooter", "emailOrderReceivedWithdrawalNote",
    "emailOrderReceivedFulfillmentTable", "emailOrderReceivedFulfillmentPickup", "emailOrderReceivedFulfillmentDelivery",
    ...["new", "accepted", "preparing", "ready", "completed", "rejected", "cancelled"].map((s) => `trackingStatusExplain_${s}`),
  ];
  for (const locale of ["fr", "en", "ar", "nl"] as const) {
    for (const key of keys) {
      const text = translate(locale, key, { n: 1 });
      for (const re of circular[locale]!) {
        // « Cet e-mail est envoyé automatiquement » (pied de page) décrit CE message, il n'en annonce pas un autre.
        if (key === "emailOrderReceivedFooter") continue;
        assert.equal(re.test(text), false, `${locale}/${key}: ${text}`);
      }
    }
  }
});
