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
  /**
   * MERCHANT CUSTOMER COMMUNICATIONS v1 — SUJET marchand DÉJÀ RÉSOLU ET
   * DÉJÀ SUBSTITUÉ (surcharge `email_confirmation_subject` passée par
   * `resolveAndRenderCommunicationText`). Ce gabarit ne connaît ni la
   * liste blanche de variables ni le catalogue d'emplacements : il
   * reçoit une chaîne, l'échappe et l'affiche -- exactement le même
   * contrat que `statusText`.
   *
   * `null`/`undefined`/vide : le sujet PLATEFORME `emailOrderReceivedSubject`
   * est employé, inchangé. C'est la compatibilité arrière exacte
   * (mandat §G) : aucune configuration => formulation actuelle.
   */
  merchantSubject?: string | null;
  /**
   * MERCHANT CUSTOMER COMMUNICATIONS v1 — CORPS marchand déjà résolu et
   * substitué (surcharge `email_confirmation_body`).
   *
   * Il REMPLACE le seul paragraphe d'INTRODUCTION
   * (`emailOrderReceivedIntro`), et RIEN d'autre : le récapitulatif
   * (nom du commerçant, numéro, mode, montant, adresse), le lien de
   * suivi et le pied de page restent DÉTENUS PAR LA PLATEFORME.
   *
   * C'est le modèle de rendu sûr déjà en place dans ce dépôt
   * (lib/legal/render.ts) : une valeur marchande est glissée dans une
   * structure plateforme, jamais substituée à la structure. Laisser un
   * commerçant remplacer tout le corps lui permettrait de supprimer le
   * montant ou le lien de suivi d'un e-mail transactionnel -- ce que ce
   * lot refuse.
   */
  merchantBody?: string | null;
  /**
   * ISSUE #172 — date et créneau de retrait/livraison, tels que FIGÉS dans
   * le snapshot (`fulfillment_date` / `fulfillment_slot`). Absents (`null`/
   * vides) tant que la commande ne porte pas de créneau : la ligne est alors
   * ABSENTE du message -- jamais rendue vide, jamais une date inventée.
   */
  fulfillmentDate?: string | null;
  fulfillmentSlot?: string | null;
  /**
   * ISSUE #172 — éligibilité à la rétractation LUE dans le snapshot
   * (`withdrawal_eligible`, instantané par ligne pris à la commande). Vrai :
   * un second lien explicite, MÊME cible que le lien de suivi (la page de
   * suivi porte l'écran de rétractation existant), avec le libellé déjà
   * employé par cet écran. Aucune règle, délai ni condition n'est écrit dans
   * l'e-mail.
   */
  withdrawalEligible?: boolean;
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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function intlLocale(locale: string): string {
  switch (locale) {
    case "en":
      return "en-GB";
    case "ar":
      return "ar";
    default:
      return "fr-FR";
  }
}

/**
 * ISSUE #172 — texte d'affichage « date, créneau » à partir de valeurs déjà
 * FIGÉES sur la commande. Une date `YYYY-MM-DD` est mise en forme à midi UTC
 * (jamais d'heure locale qui décalerait le jour) ; toute autre forme est
 * rendue telle quelle plutôt que réinterprétée. Rien -> `null`.
 */
export function formatFulfillmentSchedule(
  locale: string,
  date: string | null | undefined,
  slot: string | null | undefined
): string | null {
  const d = date?.trim() || "";
  const s = slot?.trim() || "";
  let datePart = d;
  if (DATE_ONLY.test(d)) {
    const parsed = new Date(`${d}T12:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      datePart = new Intl.DateTimeFormat(intlLocale(locale), {
        dateStyle: "full",
        timeZone: "UTC",
      }).format(parsed);
    }
  }
  const parts = [datePart, s].filter((part) => part !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

export function renderOrderReceivedEmail(input: OrderReceivedTemplateInput): RenderedEmail {
  const t = (key: string, vars?: Record<string, string | number>) => translate(input.locale, key, vars);

  // MERCHANT CUSTOMER COMMUNICATIONS v1 — surcharge marchande d'abord,
  // texte plateforme ensuite ; aucun troisième repli. `trim()` : une
  // surcharge réduite à des blancs n'est PAS une surcharge (même règle
  // que `normalizeCommunicationText`), elle ne doit pas produire un
  // sujet vide.
  const merchantSubject = input.merchantSubject?.trim() || null;
  const merchantBody = input.merchantBody?.trim() || null;

  const subject =
    merchantSubject ??
    t("emailOrderReceivedSubject", { merchant: input.merchantSenderName, n: input.orderNumber });
  const heading = t("emailOrderReceivedHeading");
  const intro = merchantBody ?? t("emailOrderReceivedIntro", { n: input.orderNumber });
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

  // ISSUE #172 — créneau (uniquement si figé sur la commande) et lien de
  // rétractation explicite (uniquement si l'instantané l'autorise).
  const scheduleText = formatFulfillmentSchedule(
    input.locale,
    input.fulfillmentDate,
    input.fulfillmentSlot
  );
  const scheduleLabel = t(
    input.serviceMode === "delivery"
      ? "emailOrderReceivedSlotLabelDelivery"
      : "emailOrderReceivedSlotLabelPickup"
  );
  const withdrawalLabel = t("withdrawalEntryAction");

  const html = [
    `<!doctype html>`,
    `<html lang="${escapeHtml(input.locale)}">`,
    `<body>`,
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p>${escapeHtml(merchantLabel)} ${escapeHtml(input.merchantName)}</p>`,
    `<p>${escapeHtml(orderNumberLine)}</p>`,
    `<p>${escapeHtml(fulfillment)}</p>`,
    ...(scheduleText ? [`<p>${escapeHtml(scheduleLabel)} ${escapeHtml(scheduleText)}</p>`] : []),
    ...(statusText ? [`<p>${escapeHtml(statusText)}</p>`] : []),
    `<p>${escapeHtml(totalLabel)} ${escapeHtml(totalFormatted)}</p>`,
    ...(deliveryAddress
      ? [`<p>${escapeHtml(deliveryAddressLabel)} ${escapeHtml(deliveryAddress)}</p>`]
      : []),
    `<p><a href="${escapeHtml(trackingUrl)}">${escapeHtml(cta)}</a></p>`,
    ...(input.withdrawalEligible === true
      ? [`<p><a href="${escapeHtml(trackingUrl)}">${escapeHtml(withdrawalLabel)}</a></p>`]
      : []),
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
    ...(scheduleText ? [`${scheduleLabel} ${scheduleText}`] : []),
    ...(statusText ? [statusText] : []),
    `${totalLabel} ${totalFormatted}`,
    ...(deliveryAddress ? [`${deliveryAddressLabel} ${deliveryAddress}`] : []),
    `${cta}: ${trackingUrl}`,
    ...(input.withdrawalEligible === true ? [`${withdrawalLabel}: ${trackingUrl}`] : []),
    thanks,
    footer,
  ].join("\n");

  return { subject, html, text };
}
