"use client";

import type { RestaurantFull } from "@/lib/types";
import { formatPrice, type OrderContext } from "@/lib/whatsapp";
import { formatAddress } from "@/lib/customer";
import { useI18n } from "@/lib/i18n-context";
import type { Translator } from "@/lib/i18n";
import Ltr from "@/components/Bidi";
import { isWhatsappEnabled } from "@/lib/customer-contact";

function contextSummary(ctx: OrderContext | null, t: Translator): string[] {
  if (!ctx) return [];
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
        t("confirmPickupTime"),
      ];
    case "delivery":
      return [
        t("confirmDelivery", { zone: ctx.zoneLabel }),
        `📍 ${formatAddress(ctx.customer)}`,
        `📞 ${ctx.customer.phone}`,
        t("confirmDeliveryTime"),
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
  onBackToMenu: () => void;
  onNewOrder: () => void;
}) {
  const { t } = useI18n();
  const isTable = context?.mode === "table";
  // CUSTOMER CONTACT + LIVE TRACKING v1 -- WhatsApp optionnel : aucune
  // mention WhatsApp si le commerçant ne l'utilise pas.
  const whatsappEnabled = isWhatsappEnabled(restaurant.config);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-crema px-6 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
          <span className="text-4xl text-green-600">✓</span>
        </div>

        <h1 className="mt-6 text-2xl font-bold">
          {t("confirmTitle")}
        </h1>
        <p className="mt-2 text-sm text-ink-on-bg-muted">
          {whatsappEnabled
            ? t("confirmSubtitle", { name: restaurant.name })
            : t("confirmSubtitleNoWhatsapp", { name: restaurant.name })}
        </p>

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

        {/* CUSTOMER TRACKING EXPERIENCE v2 (mandat §20) : le lien
            porte le jeton en FRAGMENT (`#public_token`) -- un <a>
            ordinaire le gère nativement comme n'importe quel lien avec
            ancre : au clic, le navigateur navigue vers l'URL complète
            SANS jamais envoyer le fragment au serveur. Aucun
            changement de mécanique de rendu n'est nécessaire ici par
            rapport à un lien classique. PAS `next/link` : ce composant
            "use client" est bundlé isolément par les tests DOM esbuild
            de ce dépôt, qui n'externalisent QUE react/react-dom --
            jamais next/link ni ses dépendances internes. */}
        {/* CUSTOMER CONTACT + LIVE TRACKING v1 : le suivi devient
            l'ACTION PRINCIPALE post-commande (bouton plein, cible
            tactile >= 44px, placé avant tout autre contenu actionnable),
            visible sans défilement et indépendant de WhatsApp. */}
        {trackingPath !== null && (
          <a
            href={trackingPath}
            data-order-confirmation-tracking=""
            className="mt-5 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-caramel py-3.5 text-center font-bold text-caramel-ink shadow-sm"
          >
            {t("trackYourOrder")}
          </a>
        )}

        {/* Corrige UIFIX-V3-01 (contre-audit Work, 4e tour) : ce
            conteneur englobe des descendants (text-ink-on-bg,
            text-ink-on-bg-muted) calculés contre --sc-bg, alors qu'il
            restait sur un fond littéral figé. bg-crema (= var(--sc-bg)) réaligne
            le fond réellement affiché sur la même source. */}
        <div className="mt-6 space-y-2 rounded-2xl bg-crema p-4 text-left text-sm shadow-sm">
          {contextSummary(context, t).map((line) => (
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
        </div>

        <p className="mt-6 text-sm italic text-accent-dark-on-bg">
          {t("confirmThanks", { name: restaurant.name })}
          <br />
          {t("confirmEnjoy")}
        </p>

        <div className="mt-8 space-y-3">
          <button
            onClick={onBackToMenu}
            className={
              trackingPath !== null
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
