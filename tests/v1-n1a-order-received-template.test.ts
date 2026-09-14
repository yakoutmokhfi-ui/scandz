import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// N1-A — ORDER_RECEIVED EMAIL TEMPLATE.
// Mandat items : "FR template" / "EN template" / "AR template" /
// "tracking link uses existing secure mechanism" / "HTML SECURITY"
// (aucun HTML marchand arbitraire, tout est échappé).
// ====================================================================

process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";

const { renderOrderReceivedEmail } = await import("../lib/server/notifications/order-received-template.ts");
const { buildTrackingPath } = await import("../lib/tracking/link.ts");

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

function baseInput(overrides: Partial<Parameters<typeof renderOrderReceivedEmail>[0]> = {}) {
  return {
    locale: "fr" as const,
    merchantSenderName: "Au Lait Cru",
    orderNumber: 42,
    total: 24.9,
    currency: "EUR",
    serviceMode: "pickup",
    orderId: ORDER_ID,
    publicToken: TOKEN,
    ...overrides,
  };
}

test("FR : objet, corps et lien de suivi corrects", () => {
  const rendered = renderOrderReceivedEmail(baseInput());
  assert.match(rendered.subject, /Au Lait Cru/);
  assert.match(rendered.subject, /#42/);
  assert.match(rendered.html, /Commande reçue/);
  assert.match(rendered.html, /Commande n°42/);
  assert.match(rendered.html, /Montant total/);
  assert.match(rendered.html, /24,90/); // Intl.NumberFormat("fr-FR") group/decimal separators
  assert.match(rendered.text, /Commande reçue/);
  const expectedPath = buildTrackingPath(ORDER_ID, TOKEN);
  assert.ok(rendered.html.includes(`https://app.scanym.example${expectedPath}`));
  assert.ok(rendered.text.includes(`https://app.scanym.example${expectedPath}`));
});

test("EN : objet et corps en anglais", () => {
  const rendered = renderOrderReceivedEmail(baseInput({ locale: "en" }));
  assert.match(rendered.subject, /order received/);
  assert.match(rendered.html, /Order received/);
  assert.match(rendered.html, /Order #42/);
  assert.match(rendered.html, /Total amount/);
});

test("AR : objet et corps en arabe, lang=ar sur la balise html", () => {
  const rendered = renderOrderReceivedEmail(baseInput({ locale: "ar" }));
  assert.match(rendered.subject, /تم استلام الطلب/);
  assert.match(rendered.html, /<html lang="ar">/);
  assert.match(rendered.html, /تم استلام الطلب/);
});

test("fulfillment wording varie selon service_mode (table/pickup/delivery)", () => {
  const table = renderOrderReceivedEmail(baseInput({ serviceMode: "table" }));
  const pickup = renderOrderReceivedEmail(baseInput({ serviceMode: "pickup" }));
  const delivery = renderOrderReceivedEmail(baseInput({ serviceMode: "delivery" }));
  assert.notEqual(table.text, pickup.text);
  assert.notEqual(pickup.text, delivery.text);
  assert.match(delivery.html, /livrée/);
  assert.match(pickup.html, /retirer/);
});

test("HTML SECURITY : le nom d'expéditeur marchand est échappé, jamais interprété comme HTML", () => {
  const malicious = '<img src=x onerror=alert(1)>"Au Lait" & Cru';
  const rendered = renderOrderReceivedEmail(baseInput({ merchantSenderName: malicious }));
  assert.doesNotMatch(rendered.html, /<img/);
  assert.match(rendered.html, /&lt;img/);
  assert.match(rendered.html, /&amp;/);
  assert.match(rendered.html, /&quot;/);
});

test("tracking link reuse : utilise EXACTEMENT buildTrackingPath (jamais un second système de jeton)", () => {
  const rendered = renderOrderReceivedEmail(baseInput());
  const expectedPath = buildTrackingPath(ORDER_ID, TOKEN);
  // Le chemin de suivi apparaît tel quel -- même construction que
  // components/OrderConfirmation.tsx / app/track/[orderId]/page.tsx.
  assert.ok(rendered.html.includes(expectedPath));
});

test("le total 0 est rendu (jamais confondu avec absent) -- même convention que la page de suivi", () => {
  const rendered = renderOrderReceivedEmail(baseInput({ total: 0 }));
  assert.match(rendered.html, /Montant total/);
});
