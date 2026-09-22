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
  /**
   * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — nom du COMMERÇANT
   * (`restaurants.name`, figé dans le payload_snapshot au moment de
   * l'enfilement). Distinct de `merchantSenderName`, qui est l'identité
   * d'EXPÉDITION résolue depuis `merchant_notification_profile` : les
   * deux peuvent légitimement différer, ce lot ne les confond jamais.
   */
  merchantName: string;
  /**
   * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — texte explicatif DÉJÀ
   * RÉSOLU (surcharge marchande ou texte de base) par l'unique autorité
   * `resolveStatusText` (lib/tracking/status-text.ts). Ce gabarit ne
   * refait AUCUN arbitrage surcharge/base et ne connaît aucun statut :
   * il reçoit une chaîne, l'échappe et l'affiche.
   */
  statusText: string;
  /**
   * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — adresse de livraison, telle
   * que persistée sur la commande. `null` dans TOUS les autres modes :
   * la ligne est alors absente du message, jamais rendue vide et jamais
   * reconstruite à partir d'autre chose.
   */
  deliveryAddress: string | null;
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

  // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — nom du commerçant, texte de
  // statut et adresse de livraison. Toutes trois sont des valeurs
  // reçues (jamais résolues ici) et TOUTES passent par `escapeHtml`
  // avant insertion, exactement comme `merchantSenderName` : une
  // surcharge de texte est saisie librement par le commerçant, elle
  // n'est donc jamais insérée telle quelle dans le HTML.
  const merchantLabel = t("emailOrderReceivedMerchantLabel");
  const statusText = input.statusText.trim();
  const deliveryAddress = input.deliveryAddress?.trim() || null;
  const deliveryAddressLabel = t("emailOrderReceivedDeliveryAddressLabel");

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
    `<p>${escapeHtml(merchantLabel)} ${escapeHtml(input.merchantName)}</p>`,
    `<p>${escapeHtml(orderNumberLine)}</p>`,
    `<p>${escapeHtml(fulfillment)}</p>`,
    ...(statusText ? [`<p>${escapeHtml(statusText)}</p>`] : []),
    `<p>${escapeHtml(totalLabel)} ${escapeHtml(totalFormatted)}</p>`,
    ...(deliveryAddress
      ? [`<p>${escapeHtml(deliveryAddressLabel)} ${escapeHtml(deliveryAddress)}</p>`]
      : []),
    `<p><a href="${escapeHtml(trackingUrl)}">${escapeHtml(cta)}</a></p>`,
    `<p>${escapeHtml(thanks)}</p>`,
    `<p><small>${escapeHtml(footer)}</small></p>`,
    `</body>`,
    `</html>`,
  ].join("\n");

  const text = [
    heading,
    intro,
    `${merchantLabel} ${input.merchantName}`,
    orderNumberLine,
    fulfillment,
    ...(statusText ? [statusText] : []),
    `${totalLabel} ${totalFormatted}`,
    ...(deliveryAddress ? [`${deliveryAddressLabel} ${deliveryAddress}`] : []),
    `${cta}: ${trackingUrl}`,
    thanks,
    footer,
  ].join("\n");

  return { subject, html, text };
}
