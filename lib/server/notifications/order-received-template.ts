import "server-only";
import { translate, type Lang } from "@/lib/i18n";
import { formatPrice } from "@/lib/whatsapp";
import { buildCapabilityTrackingPath } from "@/lib/tracking/link";
import { resolveCanonicalPublicOrigin } from "@/lib/server/canonical-public-origin";
import {
  coherentBreakdown,
  isValidCivilDate,
  type OrderDetailItem,
  type OrderDetailSchedule,
} from "@/lib/server/notifications/order-received-detail";

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
   * ISSUE #172 / #211 — éligibilité à la rétractation LUE dans le snapshot
   * (`withdrawal_eligible`, instantané par ligne pris à la commande). Vrai :
   * une action SÉPARÉE « Demander une rétractation » (libellé de l'écran de
   * confirmation) vers la MÊME cible serveur que le suivi — la page de suivi
   * reste l'unique autorité (lignes éligibles de l'instantané, quantités
   * restantes, capacité non expirée). L'e-mail ne promet ni droit, ni
   * remboursement, et n'écrit aucun délai.
   */
  withdrawalEligible?: boolean;
  /**
   * ORDER EMAIL DETAIL v1 (#211) — récapitulatif figé dans le snapshot
   * (voir order-received-detail.ts). Tous OPTIONNELS : absents, l'e-mail est
   * rendu comme avant ce lot (aucune ligne vide, aucune valeur inventée).
   * `items` : lignes HISTORIQUES de la commande ; `subtotal`/`deliveryFee` :
   * affichés seulement s'ils sont cohérents avec les lignes et le total
   * autoritaire ; `schedule` : jour/créneau persistés ; `merchantAddress` :
   * adresse du commerçant (retrait).
   */
  items?: ReadonlyArray<OrderDetailItem> | null;
  subtotal?: number | null;
  deliveryFee?: number | null;
  schedule?: OrderDetailSchedule | null;
  merchantAddress?: string | null;
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
      // Chiffres latins : les montants (fr-FR) et les heures « HH:MM » de l'e-mail le sont aussi ; un seul
      // système de chiffres dans le même message, et un rendu indépendant de la version d'ICU.
      return "ar-u-nu-latn";
    case "nl":
      return "nl-NL";
    default:
      return "fr-FR";
  }
}

/** Date civile « YYYY-MM-DD » → texte long, formaté à partir de ses composantes (midi UTC, fuseau UTC) :
 *  jamais de décalage d'un jour selon le fuseau du serveur. Forme invalide → `null` (rien d'affiché). */
export function formatCivilDate(locale: string, isoDate: string): string | null {
  if (!isValidCivilDate(isoDate)) return null;
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "full", timeZone: "UTC" }).format(
    new Date(`${isoDate}T12:00:00Z`)
  );
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
    // Date civile IMPOSSIBLE (30 février, 31 avril, mois 13…) : REJETÉE, jamais réinterprétée — `new Date()` la
    // ferait glisser silencieusement au 2 mars. Rien n'est affiché, pas même le créneau qui l'accompagnait.
    const formatted = formatCivilDate(locale, d);
    if (formatted === null) return null;
    datePart = formatted;
  }
  const parts = [datePart, s].filter((part) => part !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Substitution en UNE passe de `{clé}` : une valeur qui contiendrait elle-même `{autre}` n'est jamais
 *  re-développée (un nom de produit « {unit} » reste un nom de produit). */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole
  );
}

/** Un bloc de l'e-mail, rendu à l'identique en HTML (échappé) et en texte : les deux parties ne peuvent pas
 *  diverger sur le contenu. */
interface Block {
  html: string;
  text: string;
}

export function renderOrderReceivedEmail(input: OrderReceivedTemplateInput): RenderedEmail {
  const t = (key: string, vars?: Record<string, string | number>) => translate(input.locale, key, vars);

  // ORDER EMAIL DETAIL v1 — arabe : sens de lecture droite-à-gauche, et isolation bidirectionnelle des
  // fragments à sens propre (montants, heures, fuseau, noms de produits) pour que ni les chiffres ni un nom
  // latin ne soient réordonnés au milieu d'une phrase arabe. Caractères Unicode d'isolation (valides tels
  // quels en HTML comme en texte) ; aucune autre langue n'est modifiée.
  const rtl = input.locale === "ar";
  const iso = (value: string, dir: "ltr" | "auto" = "auto"): string =>
    rtl ? `${dir === "ltr" ? "⁦" : "⁨"}${value}⁩` : value;
  const price = (amount: number) => iso(formatPrice(amount, input.currency), "ltr");

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

  const blocks: Block[] = [];
  const para = (text: string) => blocks.push({ html: `<p>${escapeHtml(text)}</p>`, text });

  // Mode de service : seuls retrait et livraison portent un jour/créneau et une adresse « utile ».
  const isDelivery = input.serviceMode === "delivery";
  const isPickup = input.serviceMode === "pickup";
  const plannable = isDelivery || isPickup;

  para(heading);
  para(intro);
  para(`${merchantLabel} ${input.merchantName}`);
  para(orderNumberLine);
  para(fulfillment);

  // ISSUE #172 / #211 — jour et créneau RETENUS, tels que persistés. Jamais d'heure inventée : jour seul
  // (Chronofresh, date sans créneau) => une seule ligne. Aucune ligne pour la table / la chambre.
  const slotLabel = t(isDelivery ? "emailOrderReceivedSlotLabelDelivery" : "emailOrderReceivedSlotLabelPickup");
  const scheduleDay = plannable && input.schedule ? formatCivilDate(input.locale, input.schedule.date) : null;
  if (scheduleDay !== null && input.schedule) {
    para(`${t(isDelivery ? "emailOrderReceivedDayLabelDelivery" : "emailOrderReceivedDayLabelPickup")} ${scheduleDay}`);
    if (input.schedule.time) {
      const zone = input.schedule.timezone ? ` (${iso(input.schedule.timezone, "ltr")})` : "";
      para(`${slotLabel} ${iso(input.schedule.time, "ltr")}${zone}`);
    }
  } else if (plannable && !input.schedule) {
    // Repli ANTÉRIEUR à #211 (clés `fulfillment_date` / `fulfillment_slot` seules) : comportement inchangé.
    const legacy = formatFulfillmentSchedule(input.locale, input.fulfillmentDate, input.fulfillmentSlot);
    if (legacy) para(`${slotLabel} ${legacy}`);
  }

  // Adresse utile selon le mode : livraison -> adresse de livraison persistée ; retrait -> adresse du
  // commerçant (aucune adresse de retrait distincte n'est modélisée) ; table -> aucune.
  if (deliveryAddress) {
    para(`${deliveryAddressLabel} ${deliveryAddress}`);
  } else if (isPickup && input.merchantAddress?.trim()) {
    para(`${t("emailOrderReceivedMerchantAddressLabel")} ${input.merchantAddress.trim()}`);
  }

  if (statusText) para(statusText);

  // ORDER EMAIL DETAIL v1 — articles, options, quantités et montants HISTORIQUES de la commande.
  const items = input.items && input.items.length > 0 ? input.items : null;
  if (items) {
    const lineTemplate = t("emailOrderReceivedItemLine");
    const optionTemplate = t("emailOrderReceivedItemOption");
    const entries = items.map((item) => ({
      line: fill(lineTemplate, {
        qty: iso(String(item.quantity), "ltr"),
        name: iso(item.name),
        unit: price(item.unitPrice),
        total: price(item.lineTotal),
      }),
      option: item.option ? fill(optionTemplate, { option: iso(item.option) }) : null,
    }));
    blocks.push({
      html: [
        `<p>${escapeHtml(t("emailOrderReceivedItemsHeading"))}</p>`,
        `<ul>`,
        ...entries.map(
          (e) => `<li>${escapeHtml(e.line)}${e.option ? `<br><small>${escapeHtml(e.option)}</small>` : ""}</li>`
        ),
        `</ul>`,
      ].join("\n"),
      text: [
        t("emailOrderReceivedItemsHeading"),
        ...entries.flatMap((e) => [`- ${e.line}`, ...(e.option ? [`  ${e.option}`] : [])]),
      ].join("\n"),
    });
  }

  // Sous-total et frais : seulement s'ils sont COHÉRENTS avec les lignes et le total autoritaire.
  const breakdown = coherentBreakdown(items, input.subtotal ?? null, input.deliveryFee ?? null, input.total);
  if (breakdown && (isDelivery || breakdown.deliveryFee > 0)) {
    para(`${t("emailOrderReceivedSubtotalLabel")} ${price(breakdown.subtotal)}`);
    para(`${t("emailOrderReceivedDeliveryFeeLabel")} ${price(breakdown.deliveryFee)}`);
  }
  para(`${totalLabel} ${price(input.total)}`);

  blocks.push({
    html: `<p><a href="${escapeHtml(trackingUrl)}">${escapeHtml(cta)}</a></p>`,
    text: `${cta}: ${trackingUrl}`,
  });

  // Rétractation : action SÉPARÉE, uniquement si l'instantané de commande l'autorise. Même cible serveur que
  // le suivi (la page reste l'unique autorité) ; la mention de portée évite qu'un lien vaille promesse.
  if (input.withdrawalEligible === true) {
    const withdrawalCta = t("confirmWithdrawalCta");
    para(t("emailOrderReceivedWithdrawalNote"));
    blocks.push({
      html: `<p><a href="${escapeHtml(trackingUrl)}">${escapeHtml(withdrawalCta)}</a></p>`,
      text: `${withdrawalCta}: ${trackingUrl}`,
    });
  }

  para(thanks);
  blocks.push({ html: `<p><small>${escapeHtml(footer)}</small></p>`, text: footer });

  const dirAttr = rtl ? ` dir="rtl"` : "";
  const html = [
    `<!doctype html>`,
    // `<html lang>` reste celui du contrat antérieur ; le sens de lecture est porté par <body> (arabe seulement).
    `<html lang="${escapeHtml(input.locale)}">`,
    `<body${dirAttr}>`,
    ...blocks.map((b) => b.html),
    `</body>`,
    `</html>`,
  ].join("\n");

  // Texte : en arabe, chaque ligne commence par la marque droite-à-gauche (sens de base explicite pour les
  // clients qui n'interprètent pas dir=).
  const text = blocks
    .map((b) => b.text)
    .join("\n")
    .split("\n")
    .map((line) => (rtl && line !== "" ? `‏${line}` : line))
    .join("\n");

  return { subject, html, text };
}
