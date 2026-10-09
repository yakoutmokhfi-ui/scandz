import "server-only";
import { translate, type Lang } from "@/lib/i18n";
import { formatPrice } from "@/lib/whatsapp";
import type { RenderedEmail } from "@/lib/server/notifications/order-received-template";
import type { CommunicationEventCode } from "@/lib/communications/events";

/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — gabarit des TROIS
 * événements e-mail additionnels (carrier_handoff,
 * local_delivery_handoff, withdrawal_request_received).
 *
 * ──────────────────────────────────────────────────────────────────────
 * CE N'EST PAS UN SECOND SYSTÈME DE NOTIFICATION.
 *
 * Ce module est l'ÉQUIVALENT STRICT de order-received-template.ts pour
 * trois types de plus : même interface de sortie (`RenderedEmail`,
 * importée et non redéclarée), même autorité i18n (`translate`/`DICTS`,
 * jamais une seconde table de traduction), même discipline
 * d'échappement, même assemblage `<p>`. Il est appelé par le MÊME worker,
 * qui réclame dans la MÊME file, avec la MÊME clé d'idempotence et la
 * MÊME taxonomie d'erreurs. Rien de la mécanique d'envoi n'est dupliqué.
 *
 * Ce qui change par rapport à order-received-template.ts, et seulement
 * cela : AUCUNE capacité de suivi n'est émise ni requise. Un événement
 * additionnel doit pouvoir partir même si l'émission de capacité est
 * indisponible -- faire dépendre un e-mail « remise au transporteur »
 * d'un lien de suivi le rendrait indélivrable pour une raison étrangère
 * à son objet.
 * ──────────────────────────────────────────────────────────────────────
 *
 * AUCUN APPEL FOURNISSEUR (mandat, littéral : « Do not invent provider
 * API calls. Do not call Stuart or Chronofresh ») : `carrierName` est un
 * LIBELLÉ D'AFFICHAGE issu de la configuration du commerçant
 * (`orders.fulfillment_code` / `orders.provider_code`, déjà figés sur la
 * commande), jamais une information lue chez un transporteur. Ce module
 * ne fait aucun appel réseau d'aucune sorte.
 */

/**
 * Copie PRIVÉE, volontairement byte-à-byte identique à celle de
 * order-received-template.ts (5 remplacements, même ordre).
 *
 * Ce dépôt en porte déjà deux exemplaires privés (ici le troisième) :
 * order-received-template.ts et lib/legal/render.ts, ce dernier avec une
 * quarantaine de sites d'appel. Les unifier dans un module partagé est
 * un refactoring qui toucherait le moteur CGV, donc HORS PÉRIMÈTRE de ce
 * lot (mandat : « Do not mix with visual theme redesign » / ne pas
 * élargir). La dette est RECONNUE et consignée dans le rapport de lot,
 * pas dissimulée -- et un test structurel vérifie que les trois copies
 * restent équivalentes.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface EventCopyKeys {
  readonly subject: string;
  readonly heading: string;
  readonly intro: string;
}

/**
 * Textes de BASE PLATEFORME par événement. Table FERMÉE, indexée par le
 * type d'événement : aucun `default:` qui emprunterait silencieusement
 * la formulation d'un autre événement.
 */
const EVENT_COPY: Record<CommunicationEventCode, EventCopyKeys> = {
  carrier_handoff: {
    subject: "emailCarrierHandoffSubject",
    heading: "emailCarrierHandoffHeading",
    intro: "emailCarrierHandoffIntro",
  },
  local_delivery_handoff: {
    subject: "emailLocalDeliveryHandoffSubject",
    heading: "emailLocalDeliveryHandoffHeading",
    intro: "emailLocalDeliveryHandoffIntro",
  },
  withdrawal_request_received: {
    subject: "emailWithdrawalRequestSubject",
    heading: "emailWithdrawalRequestHeading",
    intro: "emailWithdrawalRequestIntro",
  },
};

export interface CommunicationEventTemplateInput {
  readonly event: CommunicationEventCode;
  readonly locale: Lang;
  /** Identité d'EXPÉDITION, résolue côté serveur depuis
   *  merchant_notification_profile par claim_pending_notifications --
   *  jamais une valeur fournie par le navigateur. */
  readonly merchantSenderName: string;
  /** Nom du COMMERÇANT (`restaurants.name`), figé dans le snapshot.
   *  Distinct de l'identité d'expédition : les deux peuvent
   *  légitimement différer, ce module ne les confond jamais. */
  readonly merchantName: string;
  readonly orderNumber: number;
  readonly total: number;
  readonly currency: string;
  readonly deliveryAddress: string | null;
  /** Libellé d'affichage du transporteur, issu de la configuration du
   *  commerçant. `null` : la ligne est ABSENTE du message, jamais rendue
   *  vide ni devinée. */
  readonly carrierName: string | null;
  /**
   * SUJET marchand DÉJÀ RÉSOLU ET DÉJÀ SUBSTITUÉ (même contrat que
   * `OrderReceivedTemplateInput.merchantSubject`) : ce module ne connaît
   * ni la liste blanche de variables ni le catalogue d'emplacements.
   * Vide/`null` : sujet plateforme.
   */
  readonly merchantSubject?: string | null;
  /**
   * CORPS marchand déjà résolu et substitué. Il remplace le seul
   * paragraphe d'INTRODUCTION ; le récapitulatif et le pied de page
   * restent détenus par la plateforme -- un commerçant ne peut pas
   * supprimer le montant d'un e-mail transactionnel.
   */
  readonly merchantBody?: string | null;
}

export function renderCommunicationEventEmail(
  input: CommunicationEventTemplateInput
): RenderedEmail {
  const t = (key: string, vars?: Record<string, string | number>) =>
    translate(input.locale, key, vars);

  const copy = EVENT_COPY[input.event];

  // Surcharge marchande d'abord, texte plateforme ensuite ; aucun
  // troisième repli. Une surcharge réduite à des blancs n'est PAS une
  // surcharge (même règle que `normalizeCommunicationText`).
  const merchantSubject = input.merchantSubject?.trim() || null;
  const merchantBody = input.merchantBody?.trim() || null;

  const subject =
    merchantSubject ??
    t(copy.subject, { merchant: input.merchantSenderName, n: input.orderNumber });
  const heading = t(copy.heading);
  const intro = merchantBody ?? t(copy.intro, { n: input.orderNumber });

  const merchantLabel = t("emailOrderReceivedMerchantLabel");
  const orderNumberLine = t("orderNumber", { n: input.orderNumber });
  const totalLabel = t("confirmTotalLabel");
  const totalFormatted = formatPrice(input.total, input.currency);
  const deliveryAddressLabel = t("emailOrderReceivedDeliveryAddressLabel");
  const carrierLabel = t("emailCarrierLabel");
  const thanks = t("confirmThanks", { name: input.merchantSenderName });
  const footer = t("emailOrderReceivedFooter");

  const deliveryAddress = input.deliveryAddress?.trim() || null;
  const carrierName = input.carrierName?.trim() || null;

  // TOUTE valeur libre passe par `escapeHtml`, y compris `intro`
  // lorsqu'il vient d'une surcharge marchande : c'est précisément le
  // cas où un `<script>` pourrait être saisi, et il ressort en texte.
  const html = [
    `<!doctype html>`,
    `<html lang="${escapeHtml(input.locale)}">`,
    `<body>`,
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p>${escapeHtml(merchantLabel)} ${escapeHtml(input.merchantName)}</p>`,
    `<p>${escapeHtml(orderNumberLine)}</p>`,
    ...(carrierName ? [`<p>${escapeHtml(carrierLabel)} ${escapeHtml(carrierName)}</p>`] : []),
    `<p>${escapeHtml(totalLabel)} ${escapeHtml(totalFormatted)}</p>`,
    ...(deliveryAddress
      ? [`<p>${escapeHtml(deliveryAddressLabel)} ${escapeHtml(deliveryAddress)}</p>`]
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
    ...(carrierName ? [`${carrierLabel} ${carrierName}`] : []),
    `${totalLabel} ${totalFormatted}`,
    ...(deliveryAddress ? [`${deliveryAddressLabel} ${deliveryAddress}`] : []),
    thanks,
    footer,
  ].join("\n");

  return { subject, html, text };
}
