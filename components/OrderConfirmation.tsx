"use client";

import type { RestaurantFull } from "@/lib/types";
import { formatPrice, type OrderContext } from "@/lib/whatsapp";
import { formatAddress } from "@/lib/customer";
import { useI18n } from "@/lib/i18n-context";
import type { Translator } from "@/lib/i18n";
import Ltr from "@/components/Bidi";
import { isWhatsappEnabled } from "@/lib/customer-contact";
import type { CommunicationTextOverrides } from "@/lib/communications/text-keys";
import { resolveCommunicationText } from "@/lib/communications/resolve";

/**
 * MERCHANT CUSTOMER COMMUNICATIONS v1 — récapitulatif de contexte.
 *
 * Les trois lignes de DÉLAI (« nous vous confirmons… ») deviennent
 * configurables par le commerçant : ce sont elles qui portaient les
 * seules promesses de temps faites au client, et elles étaient figées
 * dans le dictionnaire plateforme.
 *
 * Les lignes FACTUELLES (table, téléphone, adresse) ne le sont PAS : ce
 * sont des données de la commande, pas un discours commercial. Les
 * rendre configurables permettrait à une surcharge de masquer l'adresse
 * de livraison réellement enregistrée.
 *
 * `delivery` emploie `confirmation_delivery_local` et JAMAIS
 * `confirmation_delivery_carrier` : la vitrine ignore DÉLIBÉRÉMENT le
 * `provider` d'une règle de livraison (les projections publiques
 * get_restaurant_public_* ne l'exposent pas), donc elle ne peut pas
 * distinguer une livraison locale d'un acheminement transporteur. Ce lot
 * ne relâche pas cette frontière pour un simple choix de formulation :
 * la formulation transporteur vit dans l'e-mail carrier_handoff, où le
 * serveur connaît `orders.provider_code`.
 */
function contextSummary(
  ctx: OrderContext | null,
  t: Translator,
  texts: CommunicationTextOverrides | null | undefined
): string[] {
  if (!ctx) return [];
  const timing = (key: "confirmation_pickup" | "confirmation_delivery_local", base: string) =>
    resolveCommunicationText(key, texts, (k) => t(k), null).text ?? base;

  switch (ctx.mode) {
    case "table":
      return [
        t("confirmTable", { n: ctx.tableNumber }),
        t("confirmPrepTime"),
      ];
    case "pickup":
      return [
        t("confirmPickup"),
        `📞 ${ctx.customer.phone}`,
        timing("confirmation_pickup", t("confirmPickupTime")),
      ];
    case "delivery":
      return [
        t("confirmDelivery", { zone: ctx.zoneLabel }),
        `📍 ${formatAddress(ctx.customer)}`,
        `📞 ${ctx.customer.phone}`,
        timing("confirmation_delivery_local", t("confirmDeliveryTime")),
      ];
  }
}

export default function OrderConfirmation({
  restaurant,
  context,
  orderNumber,
  trackingPath,
  totalAmount,
  invoiceRequested,
  communicationTexts,
  withdrawalEligible,
  onBackToMenu,
  onNewOrder,
}: {
  restaurant: RestaurantFull;
  context: OrderContext | null;
  orderNumber: number | null;
  /**
   * CUSTOMER TRACKING EXPERIENCE v2 (mandat §20) — chemin de suivi
   * client, construit UNE SEULE FOIS par l'appelant (components/
   * MenuView.tsx::handleSendOrder, via
   * lib/tracking/link.ts::buildTrackingPath) à partir de l'order_id/
   * public_token RÉELS renvoyés par `create_order` -- jamais
   * reconstruit ni régénéré ici. Porte le jeton en FRAGMENT d'URL
   * (`/track/<order_id>#<public_token>`, jamais en segment de chemin
   * ni en chaîne de requête -- mandat §6/§7). `null` si la commande
   * n'a pas été créée avec succès (mandat §20, "No tracking link if
   * order creation failed").
   *
   * ─── MCC-V1-CONTRACT-CHANGE-01 (MERCHANT CUSTOMER COMMUNICATIONS v1,
   * mandat §B, littéral : « Scanym must no longer REQUIRE a
   * customer-facing "Track my order" CTA after purchase ») ───
   *
   * Ce chemin n'est PLUS rendu comme bouton « Suivre ma commande ». Il
   * est CONSERVÉ comme prop parce qu'il reste la cible du seul appel à
   * l'action désormais autorisé sur cet écran : la demande de
   * rétractation, dont le formulaire vit sur la page de suivi. Le
   * supprimer aurait obligé à publier un SECOND chemin vers la même
   * page, avec deux jetons à garder cohérents.
   */
  trackingPath: string | null;
  /**
   * CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "total amount
   * visibility") — montant TOTAL AUTORITATIF de la commande, tel que
   * renvoyé par `create_order` (lib/services/orders.ts::CreatedOrder
   * ::total ; jamais recalculé côté client -- même source que
   * SADFP-V2-01 pour le message WhatsApp). `undefined`/`null` :
   * n'affiche aucune ligne de montant (repli défensif, jamais un
   * "0" ou un montant inventé) -- ce prop est optionnel afin de ne
   * jamais casser un appelant existant qui ne le fournit pas encore.
   */
  totalAmount?: number | null;
  /**
   * CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "invoice-request
   * indicator") — `true` UNIQUEMENT lorsque l'appelant a atteint cet
   * écran APRÈS une demande de facture explicitement CONFIRMÉE
   * (persistée avec succès) -- `completeOrderFlow` n'est jamais appelé
   * tant que l'issue de la demande de facture n'est pas connue (voir
   * components/MenuView.tsx). `false`/`undefined` : aucune facture
   * demandée -- aucun indicateur affiché, jamais un état par défaut
   * "facture en cours".
   */
  invoiceRequested?: boolean;
  /**
   * MERCHANT CUSTOMER COMMUNICATIONS v1 — surcharges de texte du
   * commerçant, telles que renvoyées par la projection PUBLIQUE
   * `get_restaurant_public_communication_texts` et déjà filtrées par
   * `overridesFromPublicProjection`.
   *
   * `undefined`/`null`/objet vide : TOUTES les formulations restent
   * exactement celles d'avant ce lot (mandat §G). Ce prop est optionnel
   * pour que tout appelant existant continue de compiler et de rendre à
   * l'identique.
   */
  communicationTexts?: CommunicationTextOverrides | null;
  /**
   * MERCHANT CUSTOMER COMMUNICATIONS v1 (mandat §B, littéral :
   * « withdrawal CTA only when at least one line is withdrawal-eligible »)
   * — `true` UNIQUEMENT lorsque le serveur a PROUVÉ qu'au moins une
   * ligne de cette commande porte
   * `order_items.withdrawal_eligible_at_order_time is true` (RPC
   * `order_has_withdrawal_eligible_line`, via
   * app/api/checkout/withdrawal-eligibility).
   *
   * FERMÉ AU REPOS : `undefined`, `false`, une réponse d'API en échec ou
   * un instantané NULL ne montrent AUCUN appel à l'action. L'absence de
   * preuve ne vaut pas preuve -- proposer une rétractation sur une
   * commande non rétractable serait une promesse juridique fausse.
   *
   * Ce lot NE CALCULE NI NE MODIFIE aucune règle d'éligibilité : il
   * transporte un booléen déjà établi par l'instantané SQL existant.
   */
  withdrawalEligible?: boolean;
  onBackToMenu: () => void;
  onNewOrder: () => void;
}) {
  const { t } = useI18n();
  const isTable = context?.mode === "table";
  // CUSTOMER CONTACT + LIVE TRACKING v1 -- WhatsApp optionnel : aucune
  // mention WhatsApp si le commerçant ne l'utilise pas.
  const whatsappEnabled = isWhatsappEnabled(restaurant.config);

  // MERCHANT CUSTOMER COMMUNICATIONS v1 — titre et corps de succès.
  //
  // Le CORPS passe par `explicitBase` et non par une clé du catalogue :
  // sa base est CONDITIONNELLE (WhatsApp activé ou non) et la condition
  // n'est connue qu'ici. Une clé unique effacerait silencieusement la
  // variante sans WhatsApp -- voir MCC-V1-DEFAULT-ABSENT-01 (b).
  const successTitle =
    resolveCommunicationText("order_success_title", communicationTexts, (k) => t(k)).text ??
    t("confirmTitle");
  const successBody = resolveCommunicationText(
    "order_success_body",
    communicationTexts,
    (k) => t(k),
    whatsappEnabled
      ? t("confirmSubtitle", { name: restaurant.name })
      : t("confirmSubtitleNoWhatsapp", { name: restaurant.name })
  ).text;

  // Avertissements ADDITIFS sur CET écran : rendus UNIQUEMENT lorsque le
  // commerçant les a saisis.
  //
  // `source === "merchant_override"` et non simplement `text !== null` :
  // `slot_warning` POSSÈDE un texte de base plateforme
  // (`deliveryTimingNoticeNotesHint`), mais ce texte a déjà sa place --
  // la boîte de dialogue de délai AVANT validation
  // (components/DeliveryTimingNoticeDialog.tsx). Le répéter ici
  // ajouterait, pour TOUS les commerçants, un paragraphe que l'écran
  // n'affichait pas avant ce lot : une régression de compatibilité
  // arrière (mandat §G) déguisée en fonctionnalité. La base reste donc
  // au seul endroit où elle existait, et cet écran ne montre que la
  // surcharge.
  const slotWarningResolved = resolveCommunicationText(
    "slot_warning",
    communicationTexts,
    (k) => t(k)
  );
  const slotWarning =
    slotWarningResolved.source === "merchant_override" ? slotWarningResolved.text : null;
  const sanitaryWarningResolved = resolveCommunicationText(
    "sanitary_warning",
    communicationTexts,
    (k) => t(k),
    null
  );
  const sanitaryWarning =
    sanitaryWarningResolved.source === "merchant_override"
      ? sanitaryWarningResolved.text
      : null;

  // MCC-V1-CONTRACT-CHANGE-01 : plus aucun bouton « Suivre ma
  // commande ». Le SEUL appel à l'action conservé est la rétractation,
  // et uniquement sur preuve serveur.
  const showWithdrawalCta = withdrawalEligible === true && trackingPath !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-crema px-6 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
          <span className="text-4xl text-green-600">✓</span>
        </div>

        <h1 className="mt-6 text-2xl font-bold" data-order-confirmation-title="">
          {successTitle}
        </h1>
        {successBody !== null && (
          <p className="mt-2 text-sm text-ink-on-bg-muted" data-order-confirmation-body="">
            {successBody}
          </p>
        )}

        {orderNumber !== null && (
          <p className="mt-4 inline-block rounded-full bg-caramel px-4 py-1.5 text-sm font-bold text-caramel-ink">
            {t("orderNumber", { n: orderNumber })}
          </p>
        )}

        {/* CUSTOMER CONFIRMATION + TRACKING FINAL v1 : montant total
            AUTORITATIF (order.total, jamais recalculé ici). Absent
            (undefined/null) : aucune ligne rendue -- jamais un montant
            par défaut. Libellé et montant restent deux fragments
            SÉPARÉS (jamais interpolés dans une seule phrase traduite)
            et `Ltr` isole l'affichage du prix en RTL (arabe) -- même
            convention que components/CartPanel.tsx. */}
        {totalAmount !== null && totalAmount !== undefined && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-ink-on-bg-muted">
            <span>{t("confirmTotalLabel")}</span>
            <Ltr>{formatPrice(totalAmount, restaurant.config.currency)}</Ltr>
          </p>
        )}

        {/* MERCHANT CUSTOMER COMMUNICATIONS v1 — appel à l'action
            RÉTRACTATION, et lui seul (MCC-V1-CONTRACT-CHANGE-01 :
            l'écran ne porte plus de bouton « Suivre ma commande »).
            Rendu UNIQUEMENT sur preuve serveur d'au moins une ligne
            rétractable. Comme l'ancien lien de suivi : un <a> ordinaire
            (le fragment n'est jamais envoyé au serveur), jamais
            `next/link` -- ce composant "use client" est bundlé isolément
            par les tests DOM esbuild de ce dépôt, qui n'externalisent
            QUE react/react-dom. */}
        {showWithdrawalCta && (
          <a
            href={trackingPath}
            data-order-confirmation-withdrawal=""
            className="mt-5 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-caramel py-3.5 text-center font-bold text-caramel-ink shadow-sm"
          >
            {t("confirmWithdrawalCta")}
          </a>
        )}

        {/* Corrige UIFIX-V3-01 (contre-audit Work, 4e tour) : ce
            conteneur englobe des descendants (text-ink-on-bg,
            text-ink-on-bg-muted) calculés contre --sc-bg, alors qu'il
            restait sur un fond littéral figé. bg-crema (= var(--sc-bg)) réaligne
            le fond réellement affiché sur la même source. */}
        <div
          className="mt-6 space-y-2 rounded-2xl bg-crema p-4 text-left text-sm shadow-sm"
          data-order-confirmation-recap=""
        >
          {contextSummary(context, t, communicationTexts).map((line) => (
            <p key={line} className="text-ink-on-bg">
              {line}
            </p>
          ))}
          <p className="text-ink-on-bg-muted">
            {t("confirmStaff")}
          </p>
          {isTable && (
            <p className="text-ink-on-bg-muted">
              {t("confirmServed")}
            </p>
          )}
          {/* CUSTOMER CONFIRMATION + TRACKING FINAL v1 : n'apparaît que
              lorsque la demande de facture a été explicitement
              CONFIRMÉE (persistée avec succès) avant cet écran --
              `completeOrderFlow` (components/MenuView.tsx) n'est
              jamais atteint tant que l'issue reste inconnue ou en
              échec. Jamais un état "facture en cours" par défaut. */}
          {invoiceRequested && (
            <p className="text-ink-on-bg-muted">
              {t("confirmInvoiceRequested")}
            </p>
          )}
          {/* MERCHANT CUSTOMER COMMUNICATIONS v1 — avertissements du
              commerçant. Rendus en NŒUD TEXTE React (jamais
              dangerouslySetInnerHTML) : un `<script>` saisi par un
              commerçant s'affiche donc comme du texte, il ne devient
              jamais du balisage. `whitespace-pre-wrap break-words`
              préserve les retours à la ligne saisis sans jamais
              permettre de mise en forme -- même convention que
              components/DeliveryTimingNoticeDialog.tsx. */}
          {slotWarning !== null && (
            <p
              className="whitespace-pre-wrap break-words text-ink-on-bg-muted"
              data-order-confirmation-slot-warning=""
            >
              {slotWarning}
            </p>
          )}
          {sanitaryWarning !== null && (
            <p
              className="whitespace-pre-wrap break-words text-ink-on-bg-muted"
              data-order-confirmation-sanitary-warning=""
            >
              {sanitaryWarning}
            </p>
          )}
        </div>

        <p className="mt-6 text-sm italic text-accent-dark-on-bg">
          {t("confirmThanks", { name: restaurant.name })}
          <br />
          {t("confirmEnjoy")}
        </p>

        <div className="mt-8 space-y-3">
          {/* « Retour au menu » est l'action PRINCIPALE (bouton plein)
              dès qu'aucun appel à l'action de rétractation ne la précède
              -- ce qui est désormais le cas général, puisque le bouton
              de suivi a disparu (MCC-V1-CONTRACT-CHANGE-01). */}
          <button
            onClick={onBackToMenu}
            data-order-confirmation-back-to-menu=""
            className={
              showWithdrawalCta
                ? "w-full rounded-xl border border-caramel py-3.5 font-bold text-accent-dark-on-bg"
                : "w-full rounded-xl bg-caramel py-3.5 font-bold text-caramel-ink"
            }
          >
            {t("backToMenu")}
          </button>
          <button
            onClick={onNewOrder}
            className="w-full rounded-xl border border-caramel py-3.5 font-bold text-accent-dark-on-bg"
          >
            {t("newOrder")}
          </button>
        </div>
      </div>
    </div>
  );
}
