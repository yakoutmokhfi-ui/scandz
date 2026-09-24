"use client";

import type { DashboardOrder, OrderStatus, ReceiptSettings } from "@/lib/dashboard-types";
import { printReceipt } from "@/lib/receipt";
import { translate, type Lang } from "@/lib/i18n";
import { formatElapsedMinutesFr } from "@/lib/format-elapsed-time";
import { formatPrice } from "@/lib/whatsapp";
import { computeOrderFiscalSummary } from "@/lib/order-fiscal-summary";

/** Libellés dans la langue réglée par le gérant, comme le ticket. */
export const STATUS_KEY: Record<OrderStatus, string> = {
  new: "dsNew",
  accepted: "dsAccepted",
  preparing: "dsPreparing",
  ready: "dsReady",
  completed: "dsCompleted",
  rejected: "dsRejected",
  cancelled: "dsCancelled",
};

const nextActions: Partial<Record<OrderStatus, { status: OrderStatus; key: string }[]>> = {
  new: [
    { status: "accepted", key: "dsAccept" },
    { status: "rejected", key: "dsRefuse" },
    { status: "cancelled", key: "dsCancel" },
  ],
  accepted: [
    { status: "preparing", key: "dsPrepare" },
    { status: "cancelled", key: "dsCancel" },
  ],
  preparing: [
    { status: "ready", key: "dsMarkReady" },
    { status: "cancelled", key: "dsCancel" },
  ],
  ready: [{ status: "completed", key: "dsComplete" }],
};

/**
 * Nom du produit -- TOUJOURS l'instantané figé à la commande
 * (order_items.item_name), quelle que soit la langue d'affichage du
 * gérant.
 *
 * RECEIPT / INVOICE TAX DETAIL v1.1 -- ferme
 * RITD-V1-NAME-HISTORY-01 (audit Work v1, MEDIUM, release-blocking) :
 * la version précédente retombait sur menu_items.translations[lang]
 * (l'état COURANT du catalogue) dès que lang !== "fr", ce qui violait
 * l'invariant central du lot ("AN OLD ORDER MUST NEVER CHANGE WHEN
 * THE CATALOGUE CHANGES") -- un renommage ou une traduction ajoutée/
 * modifiée APRÈS la commande changeait l'affichage d'une VIEILLE
 * commande. Corrigé en lisant EXCLUSIVEMENT l'instantané
 * order_items.item_name/option_name, jamais une traduction catalogue
 * courante, dans TOUTES les langues -- y compris quand cet instantané
 * est en français alors que le gérant consulte le tableau de bord en
 * anglais/arabe : il est préférable d'afficher le nom original que de
 * traduire un nom qui n'existait pas au moment de la commande (mandat
 * v1.1 §5, "do not invent historical translations that were never
 * snapshotted"). Aucune architecture de snapshot de traduction n'est
 * ajoutée -- correctif minimal, comportement déjà correct de
 * lib/receipt.ts (le ticket imprimé) désormais reproduit ici.
 */
function itemName(item: DashboardOrder["order_items"][number]) {
  return item.item_name;
}

function optionName(item: DashboardOrder["order_items"][number]) {
  return item.option_name;
}

function service(order: DashboardOrder, lang: Lang) {
  const t = (k: string, p?: Record<string, string | number>) => translate(lang, k, p);
  if (order.service_mode === "table")
    return t("dsTable", { n: order.table_number ?? "-" });
  if (order.service_mode === "pickup") return t("dsPickup");
  return t("dsDelivery");
}

export default function OrderCard({
  order,
  restaurantName,
  receiptSettings,
  receiptSettingsReady = true,
  printRestaurantId,
  onStatus,
  busy,
  staffLanguage,}: {
  order: DashboardOrder;
  restaurantName: string;
  receiptSettings: ReceiptSettings | null;
  /**
   * PRINTED MERCHANT RECEIPT / VAT + LEGAL INFO FIX v1 -- `true`
   * uniquement une fois qu'une réponse (positive OU "aucune ligne
   * receipt_settings", les deux légitimes) est arrivée pour le
   * restaurant COURANT depuis app/dashboard/page.tsx.
   * `receiptSettings` seul ne suffit PAS à le déduire : `null` peut
   * aussi bien signifier "chargement encore en cours" que "aucune
   * ligne pour cet établissement" (voir commentaire jumeau dans
   * app/dashboard/page.tsx). Par défaut `true` -- ne change RIEN pour
   * un appelant qui ne connaît pas encore ce concept (ex. les tests
   * DOM existants qui rendent OrderCard isolément, hors du cycle de
   * chargement réel de la page tableau de bord).
   */
  receiptSettingsReady?: boolean;
  /**
   * RECEIPT v1.1 -- remédiation RECEIPT-V1-ORDER-SETTINGS-RACE-01.
   *
   * Établissement pour lequel TOUT l'état d'impression est cohérent
   * (restaurant sélectionné == provenance des commandes == provenance
   * des réglages, réglages prêts) -- voir `printRestaurantId` dans
   * app/dashboard/page.tsx. `null` = rien n'est imprimable.
   *
   * Cette carte y ajoute la vérification qui lui est propre :
   * `order.restaurant_id === printRestaurantId`. Une commande d'un
   * AUTRE établissement reste donc non imprimable même si la porte
   * globale était ouverte -- c'est la garantie demandée au §3.D du
   * mandat ("order.restaurant_id === current restaurantId"), et elle
   * ne dépend d'aucun état d'UI.
   *
   * `undefined` (prop omise) = appelant historique qui ne connaît pas
   * encore ce concept : la vérification d'appartenance est alors
   * inapplicable et seule `receiptSettingsReady` gouverne, exactement
   * comme en v1. Le seul appelant réel (app/dashboard/page.tsx) la
   * fournit toujours ; les tests DOM préexistants d'autres lots, qui
   * rendent OrderCard isolément pour des sujets sans rapport, ne sont
   * donc pas affectés.
   */
  printRestaurantId?: string | null;
  onStatus: (orderId: string, status: OrderStatus) => Promise<void>;
  busy: boolean;
  staffLanguage?: string;}) {
  const lang = (staffLanguage ?? "fr") as Lang;
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
  const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(order.created_at).getTime()) / 60000));
  /**
   * CORRECTIF (BACKOFFICE TICKET AGE / ELAPSED TIME DISPLAY v1) :
   * un ticket ancien affichait auparavant un nombre brut de minutes,
   * illisible au-delà de quelques dizaines (ex. "16958 min"). Portée
   * STRICTEMENT DISPLAY ONLY -- `ageMinutes` lui-même, le tri, et le
   * statut restent INCHANGÉS.
   *
   * CORRECTIF v1.2 (INVALID TIMESTAMP UI FALLBACK) : le garde de
   * finitude est désormais appliqué AVANT la branche linguistique --
   * une valeur `created_at` invalide/manquante en amont (produisant
   * `ageMinutes` non fini) affiche "—" dans TOUTES les langues,
   * jamais uniquement en français. Auparavant, seul le français
   * (via `formatElapsedMinutesFr`, corrigé en v1.1) était protégé --
   * les autres langues auraient pu interpoler littéralement "NaN"/
   * "Infinity" dans le gabarit `dsMinutes`.
   *
   * Le formatage j/h/min détaillé reste FRANÇAIS UNIQUEMENT (mandat,
   * littéral) -- pour une valeur FINIE dans les autres langues,
   * l'ancien comportement ("{n} min" / "{n} د" via dsMinutes) reste
   * intégralement préservé, aucune traduction modifiée, aucun
   * élargissement de portée non demandé par ce lot.
   */
  const ageDisplay = !Number.isFinite(ageMinutes)
    ? "—"
    : lang === "fr"
      ? formatElapsedMinutesFr(ageMinutes)
      : t("dsMinutes", { n: ageMinutes });

  /**
   * RECEIPT v1.1 -- condition UNIQUE d'autorisation d'impression,
   * partagée par l'attribut `disabled` du bouton ET par la garde
   * défensive de `handlePrint()` : les deux ne peuvent donc jamais
   * diverger.
   *
   * `printRestaurantId === undefined` (prop non fournie par un
   * appelant historique) neutralise la seule vérification
   * d'appartenance -- voir la documentation de la prop ci-dessus.
   */
  /**
   * TVA / HT / TTC COMPLETION v1 (§4, §6) -- résumé fiscal de la
   * commande, issu du CONTRAT UNIQUE partagé avec le ticket imprimé et,
   * demain, la facture. Aucun calcul n'est refait ici : le composant
   * n'affiche que ce que `computeOrderFiscalSummary` retourne, donc
   * back-office et ticket ne peuvent pas diverger.
   *
   * Pas de repli sur les réglages courants pour le libellé : dans le
   * back-office la commande est la seule source affichée, et une
   * commande sans instantané fiscal tombe de toute façon dans le mode
   * `unavailable` (aucune TVA fabriquée -- mandat §3).
   */
  const fiscal = computeOrderFiscalSummary(order);

  const ownershipSatisfied =
    printRestaurantId === undefined ||
    (printRestaurantId !== null && order.restaurant_id === printRestaurantId);
  const canPrint = receiptSettingsReady && ownershipSatisfied;

  function handlePrint() {
    // Garde DÉFENSIVE, en plus de la désactivation visuelle du bouton
    // ci-dessous (voir <button onClick={handlePrint}>) -- le bouton
    // désactivé empêche déjà normalement cet appel, mais cette
    // fonction ne présume jamais que son seul appelant est ce bouton
    // précis (mandat, littéral : "guarantee the print handler
    // receives a complete settings object"). Sans cette garde, un
    // clic pendant la fenêtre de chargement produirait un ticket SANS
    // AUCUNE information légale (lib/receipt.ts lit
    // legal_name/legal_address/phone/email/tax_identifier/
    // registration_number/footer_text UNIQUEMENT depuis `settings`,
    // sans repli).
    //
    // RECEIPT v1.1 : cette garde couvre desormais AUSSI l'appartenance
    // de la commande au restaurant selectionne (RECEIPT-V1-ORDER-
    // SETTINGS-RACE-01) -- imprimer une commande du restaurant A avec
    // les mentions legales du restaurant B doit rester impossible meme
    // si l'attribut `disabled` du bouton etait retire cote DOM.
    if (!canPrint) return;
    try {
      printReceipt(
        { order, restaurantName, settings: receiptSettings },
        // Langue choisie par le gérant dans ses réglages
        lang
      );
    } catch (error) {
      alert(error instanceof Error ? error.message : t("dsPrintFailed"));
    }
  }

  return (
    <article
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`rounded-2xl border bg-white p-4 shadow-sm ${order.status === "new" ? "border-amber-500 ring-2 ring-amber-100" : "border-stone-200"}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-black text-stone-900">
            {t("dsOrderTitle", { n: order.order_number })}
          </p>
          <p className="text-sm font-semibold text-amber-700">
            {service(order, lang)} · {ageDisplay}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-700">
            {t(STATUS_KEY[order.status])}
          </span>
          {order.order_invoice_request && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
              {t("dsInvoiceRequested")}
            </span>
          )}
        </div>
      </header>

      <div className="mt-4 space-y-3 border-y border-dashed border-stone-200 py-4">
        {order.order_items.map((item) => (
          <div key={item.id} className="flex justify-between gap-3 text-sm">
            <div>
              <span className="font-bold">
                {item.quantity} × {itemName(item)}
              </span>
              {item.option_name && (
                <p className="text-stone-500">+ {optionName(item)}</p>
              )}
            </div>
            <span className="whitespace-nowrap font-semibold">{formatPrice(Number(item.line_total), order.currency)}</span>
          </div>
        ))}
      </div>

      {(order.customer_name || order.customer_phone || order.delivery_address || order.customer_note) && (
        <div className="mt-3 rounded-xl bg-stone-50 p-3 text-sm text-stone-700">
          {order.customer_name && <p>{order.customer_name}</p>}
          {order.customer_phone && <p>{order.customer_phone}</p>}
          {order.delivery_address && <p>{order.delivery_address}</p>}
          {order.customer_note && <p className="mt-1 italic">Note : {order.customer_note}</p>}
        </div>
      )}

      {/*
       * INVOICE BACKOFFICE VISIBILITY + BILLING ADDRESS v1 (Claude
       * Monet) -- affiche la demande de facture QUAND ELLE EXISTE,
       * telle que saisie au checkout. Aucune colonne de statut de
       * génération/envoi n'est introduite ni affichée ici (mandat,
       * littéral : "Do NOT display 'Facture générée'/'Envoyée'").
       */}
      {order.order_invoice_request && (
        <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-stone-700">
          <p className="font-bold text-amber-900">
            {order.order_invoice_request.invoice_type === "company"
              ? t("invTypeCompany")
              : t("invTypeIndividual")}
          </p>
          {order.order_invoice_request.company_legal_name && (
            <p>
              {t("invCompanyLegalName")} : {order.order_invoice_request.company_legal_name}
            </p>
          )}
          {order.order_invoice_request.vat_number && (
            <p>
              {t("dsInvoiceVatNumber")} : {order.order_invoice_request.vat_number}
            </p>
          )}
          {order.order_invoice_request.contact_name && (
            <p>
              {t("invContactName")} : {order.order_invoice_request.contact_name}
            </p>
          )}
          {order.order_invoice_request.contact_email && (
            <p>
              {t("invContactEmail")} : {order.order_invoice_request.contact_email}
            </p>
          )}
          <p>
            {order.order_invoice_request.address_line_1}
            {order.order_invoice_request.address_line_2
              ? `, ${order.order_invoice_request.address_line_2}`
              : ""}
          </p>
          <p>
            {order.order_invoice_request.postal_code} {order.order_invoice_request.city}
            {", "}
            {order.order_invoice_request.country}
          </p>
        </div>
      )}

      {/*
        * §6 -- récapitulatif fiscal compact. Le gérant ne doit déduire
        * aucune valeur : HT, TVA et TTC sont affichés explicitement, et
        * le détail par taux apparaît dès qu'il y a plusieurs taux.
        * Aucune refonte de la page commande (mandat §6).
        */}
      <div
        data-fiscal-mode={fiscal.mode}
        className="mt-4 rounded-xl bg-stone-50 p-3 text-sm text-stone-700"
      >
        {/*
         * DELIVERY FEE / ORDER TOTAL RECONCILIATION v1 -- COMPOSITION du
         * total, affichée AVANT la décomposition fiscale.
         *
         * Le frais de livraison est DÉJÀ inclus dans `order.total`
         * (contrainte CHECK `orders_total_equals_subtotal_plus_delivery_fee`,
         * et `create_order` qui écrit `total = subtotal + delivery_fee`) --
         * il n'était simplement JAMAIS itemisé ici, d'où l'écart
         * inexpliqué entre la somme des lignes produit et le montant
         * final constaté par le marchand. Aucun montant n'est recalculé :
         * les deux valeurs viennent du contrat fiscal partagé
         * (computeOrderFiscalSummary), lui-même alimenté exclusivement par
         * les instantanés persistés `orders.subtotal`/`orders.total`.
         *
         * Convention d'affichage IDENTIQUE au checkout client
         * (components/CartPanel.tsx) -- jamais une nouvelle convention :
         * les deux lignes n'apparaissent QUE si un frais de livraison
         * réel s'applique. Table, retrait et livraison gratuite gardent
         * donc exactement l'affichage d'avant ce lot (aucun frais
         * fabriqué à 0,00 €).
         *
         * `compositionReconcilesWithTotal === false` (marchand en prix
         * HORS TAXES) : rien n'est affiché non plus -- voir la
         * documentation du contrat, aucune répartition TTC de la part
         * livraison n'est persistée et aucune n'est inventée ici.
         */}
        {fiscal.deliveryFee > 0 && fiscal.compositionReconcilesWithTotal && (
          <div
            data-order-composition="delivery"
            className="mb-2 border-b border-stone-200 pb-2"
          >
            <div className="flex justify-between gap-3">
              <span>{t("subtotalLabel")}</span>
              <span data-composition="products-subtotal" className="whitespace-nowrap font-semibold">
                {formatPrice(fiscal.productsSubtotal, order.currency)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>{t("deliveryFeeLabel")}</span>
              <span data-composition="delivery-fee" className="whitespace-nowrap font-semibold">
                {formatPrice(fiscal.deliveryFee, order.currency)}
              </span>
            </div>
          </div>
        )}
        {fiscal.mode === "unavailable" ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-stone-500">{t("dsVatUnavailable")}</span>
            <span data-fiscal="total-ttc" className="whitespace-nowrap font-black">
              {formatPrice(fiscal.totalGross, order.currency)}
            </span>
          </div>
        ) : (
          <>
            {fiscal.rates.filter((r) => r.rate > 0).length > 1 && (
              <div className="mb-2 border-b border-stone-200 pb-2">
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">
                  {t("dsVatDetail")}
                </p>
                {fiscal.rates
                  .filter((r) => r.rate > 0)
                  .map((r) => (
                    <div key={r.rate} data-fiscal-rate={r.rate} className="flex justify-between gap-3 text-xs">
                      <span className="font-semibold">{r.rate}%</span>
                      <span className="whitespace-nowrap text-stone-500">
                        {t("dsVatBase")} {formatPrice(r.net, order.currency)}
                      </span>
                      <span data-fiscal="rate-tax" className="whitespace-nowrap">
                        {t("dsVat")} {formatPrice(r.tax, order.currency)}
                      </span>
                      <span className="whitespace-nowrap font-semibold">
                        {formatPrice(r.gross, order.currency)}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            <div className="flex justify-between gap-3">
              <span>{t("dsTotalHt")}</span>
              <span data-fiscal="total-ht" className="whitespace-nowrap font-semibold">
                {formatPrice(fiscal.totalNet, order.currency)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>
                {t("dsVat")}
                {fiscal.mode === "flat-rate" ? ` ${fiscal.rate}%` : ""}
              </span>
              <span data-fiscal="total-vat" className="whitespace-nowrap font-semibold">
                {formatPrice(fiscal.totalTax, order.currency)}
              </span>
            </div>
            <div className="mt-1 flex justify-between gap-3 border-t border-stone-200 pt-1">
              <span className="font-bold">{t("dsTotalTtc")}</span>
              <span data-fiscal="total-ttc" className="whitespace-nowrap font-black">
                {formatPrice(fiscal.totalGross, order.currency)}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-lg font-black">{formatPrice(Number(order.total), order.currency)}</span>
        <button
          onClick={handlePrint}
          disabled={!canPrint}
          aria-disabled={!canPrint}
          title={!canPrint ? t("dsPrintSettingsLoading") : undefined}
          data-receipt-settings-ready={receiptSettingsReady}
          data-print-allowed={canPrint}
          className="rounded-xl border border-stone-300 px-3 py-2 text-sm font-bold text-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("dsPrint")}
        </button>
      </div>

      {(nextActions[order.status]?.length ?? 0) > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {nextActions[order.status]?.map((action) => (
            <button
              key={action.status}
              disabled={busy}
              onClick={() => onStatus(order.id, action.status)}
              className={`rounded-xl px-3 py-2.5 text-sm font-bold disabled:opacity-50 ${
                action.status === "accepted" || action.status === "preparing" || action.status === "ready" || action.status === "completed"
                  ? "bg-stone-900 text-white"
                  : "bg-red-50 text-red-700"
              }`}
            >
              {t(action.key)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
