import "server-only";
import { translate, type Lang } from "@/lib/i18n";
import { formatPrice } from "@/lib/whatsapp";
import { buildCapabilityTrackingPath } from "@/lib/tracking/link";
import { resolveCanonicalPublicOrigin } from "@/lib/server/canonical-public-origin";

/**
 * N1-A — SCANYM-CONTROLLED ORDER_RECEIVED EMAIL TEMPLATE.
 *
 * Réutilise l'autorité i18n EXISTANTE (`translate`/`DICTS`, lib/i18n.ts)
 * -- jamais une seconde table de traduction. CUSTOMER TRACKING v3.1 :
 * le lien de suivi porte la capacité v3.1 RÉUTILISABLE de l'e-mail
 * (`buildCapabilityTrackingPath` + `resolveCanonicalPublicOrigin`, en
 * fragment uniquement) -- jamais le public_token legacy, dont l'échange
 * est one-shot.
 *
 * SÉCURITÉ HTML (mandat §"HTML SECURITY") : `escapeHtml` échappe TOUTE
 * valeur marchand/client avant insertion dans le HTML -- aucun HTML
 * arbitraire marchand, aucun gabarit éditable par le marchand. Seuls
 * `merchantSenderName` (saisi par le marchand via
 * set_merchant_notification_profile) et les valeurs de commande
 * (numériques/énumérées, donc déjà sûres) atteignent ce module ; toute
 * chaîne libre passe par `escapeHtml` avant insertion.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface OrderReceivedTemplateInput {
  locale: Lang;
  /** Nom d'expéditeur résolu côté serveur depuis
   *  `merchant_notification_profile` -- jamais une valeur fournie par
   *  le navigateur (mandat §"HTML SECURITY"/"MERCHANT EMAIL PROFILE"). */
  merchantSenderName: string;
  orderNumber: number;
  total: number;
  currency: string;
  serviceMode: string;
  orderId: string;
  /** CUSTOMER TRACKING v3.1 — capacité RÉUTILISABLE liée à `orderId`
   *  (issue_order_email_tracking_capability) ; jamais le public_token
   *  legacy, jamais journalisée. */
  trackingCapabilityId: string;
  trackingSecret: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function fulfillmentKey(serviceMode: string): string {
  switch (serviceMode) {
    case "table":
      return "emailOrderReceivedFulfillmentTable";
    case "delivery":
      return "emailOrderReceivedFulfillmentDelivery";
    case "pickup":
    default:
      return "emailOrderReceivedFulfillmentPickup";
  }
}

export function renderOrderReceivedEmail(input: OrderReceivedTemplateInput): RenderedEmail {
  const t = (key: string, vars?: Record<string, string | number>) => translate(input.locale, key, vars);

  const subject = t("emailOrderReceivedSubject", { merchant: input.merchantSenderName, n: input.orderNumber });
  const heading = t("emailOrderReceivedHeading");
  const intro = t("emailOrderReceivedIntro", { n: input.orderNumber });
  const fulfillment = t(fulfillmentKey(input.serviceMode));
  const orderNumberLine = t("orderNumber", { n: input.orderNumber });
  const totalLabel = t("confirmTotalLabel");
  const totalFormatted = formatPrice(input.total, input.currency);
  const cta = t("trackYourOrder");
  const thanks = t("confirmThanks", { name: input.merchantSenderName });
  const footer = t("emailOrderReceivedFooter");

  const trackingPath = buildCapabilityTrackingPath(
    input.orderId,
    input.trackingCapabilityId,
    input.trackingSecret
  );
  const trackingUrl = `${resolveCanonicalPublicOrigin()}${trackingPath}`;

  const html = [
    `<!doctype html>`,
    `<html lang="${escapeHtml(input.locale)}">`,
    `<body>`,
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p>${escapeHtml(orderNumberLine)}</p>`,
    `<p>${escapeHtml(fulfillment)}</p>`,
    `<p>${escapeHtml(totalLabel)} ${escapeHtml(totalFormatted)}</p>`,
    `<p><a href="${escapeHtml(trackingUrl)}">${escapeHtml(cta)}</a></p>`,
    `<p>${escapeHtml(thanks)}</p>`,
    `<p><small>${escapeHtml(footer)}</small></p>`,
    `</body>`,
    `</html>`,
  ].join("\n");

  const text = [
    heading,
    intro,
    orderNumberLine,
    fulfillment,
    `${totalLabel} ${totalFormatted}`,
    `${cta}: ${trackingUrl}`,
    thanks,
    footer,
  ].join("\n");

  return { subject, html, text };
}
