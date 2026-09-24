import type { DashboardOrder, ReceiptSettings } from "@/lib/dashboard-types";
import { formatPrice } from "@/lib/whatsapp";
import { translate, type Lang } from "@/lib/i18n";
import { computeOrderFiscalSummary } from "@/lib/order-fiscal-summary";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function serviceLabel(order: DashboardOrder, lang: Lang): string {
  const t = (k: string, p?: Record<string, string | number>) => translate(lang, k, p);
  if (order.service_mode === "table")
    return t("rcTable", { n: order.table_number ?? "-" });
  if (order.service_mode === "pickup") return t("rcPickup");
  return t("rcDelivery");
}

// ============================================================
// TVA / HT / TTC COMPLETION v1 -- le calcul fiscal a été DÉPLACÉ.
// ============================================================
// Tout le moteur de décision + calcul (instantané fiscal marchand,
// groupes multi-taux, garde de complétude de la ventilation TVA
// livraison, conventions d'arrondi LOT C v1.3) vit désormais dans
// lib/order-fiscal-summary.ts, INCHANGÉ ligne pour ligne. Il était ici
// privé au moteur de rendu HTML, donc inaccessible au back-office et à
// la future facture -- ce qui imposait de le dupliquer pour les
// afficher ailleurs. Le ticket en est maintenant un CONSOMMATEUR parmi
// trois, et non plus le propriétaire (mandat §4).
//
// Le rendu ci-dessous est volontairement inchangé : un test "golden"
// compare le HTML produit avant et après ce déplacement, octet pour
// octet, sur douze cas fiscaux.
// ============================================================

export function buildReceiptHtml(params: {
  order: DashboardOrder;
  restaurantName: string;
  settings: ReceiptSettings | null;
}, lang: Lang = "fr"): string {
  const { order, restaurantName, settings } = params;
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
  const width = settings?.paper_width_mm ?? 58;

  // MERCHANT LEGAL & TAX PROFILE v1.1 -- ferme MLTP-V1-HISTORICAL-TAX-01.
  //
  // AVANT v1.1, ce bloc lisait TOUJOURS les réglages fiscaux COURANTS
  // (settings?.default_tax_rate / .prices_include_tax / .show_tax_summary
  // / .tax_label), quelle que soit la date de la commande. Tant que
  // receipt_settings était en lecture seule (v1, avant l'écriture
  // marchand), ce défaut était latent -- ces réglages ne changeaient
  // jamais. MERCHANT LEGAL & TAX PROFILE v1 les rend éditables par le
  // marchand : réimprimer une ANCIENNE commande après un changement de
  // taux/option affichait alors une décomposition HT/TVA/TTC
  // rétroactivement FAUSSE (constat bloquant de l'audit Work,
  // MLTP-V1-HISTORICAL-TAX-01).
  //
  // Stratégie retenue (option A -- instantané immuable, voir
  // supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql section 5 et
  // HISTORICAL-TAX-STRATEGY.md du package d'audit v1.1) : la
  // décomposition fiscale utilise EXCLUSIVEMENT l'instantané figé au
  // moment de la commande (order.tax_settings_snapshot_*, capturé par
  // un déclencheur BEFORE INSERT sur orders, jamais recalculé
  // ensuite) -- JAMAIS les réglages COURANTS du marchand pour ce
  // calcul. `menu_items.tax_rate` n'est délibérément PAS utilisé ici
  // (mandat : "Do NOT silently make menu_items.tax_rate authoritative
  // for old orders" -- ce calcul reste le taux PLAT par restaurant,
  // désormais figé par commande, jamais un taux par produit).
  //
  // Repli (option B, mandat : "for orders without sufficient
  // immutable tax data, suppress the tax breakdown and display only
  // the authoritative historical order total") : une commande sans
  // instantané (antérieure à ce lot, ou restaurant sans aucune ligne
  // receipt_settings au moment de la commande --
  // `tax_settings_snapshot_prices_include_tax === null`, même
  // convention de marqueur de complétude que
  // order_items.weight_is_approximate_snapshot dans RECEIPT / INVOICE
  // TAX DETAIL v1.1) n'affiche JAMAIS de décomposition HT/TVA/TTC
  // fabriquée -- uniquement le total autoritaire de la commande
  // (order.total, inchangé, toujours l'unique autorité financière).
  //
  // Les champs d'AFFICHAGE du profil marchand (business_name,
  // legal_name, legal_address, phone, tax_identifier,
  // registration_number, footer_text, paper_width_mm ci-dessus)
  // restent volontairement pilotés par les réglages COURANTS : ce sont
  // des informations d'identité/de présentation du commerce, pas un
  // calcul de taxe -- un commerçant qui change son adresse légale
  // affichée veut que TOUS ses tickets, y compris une réimpression
  // d'ancienne commande, reflètent l'adresse ACTUELLE. Seule la
  // décomposition fiscale (HT/TVA/TTC) est concernée par
  // MLTP-V1-HISTORICAL-TAX-01 et donc par ce figement.
  // Source UNIQUE des chiffres fiscaux (mandat §4) -- identique à
  // celle consommée par le back-office et par la future facture.
  const fiscal = computeOrderFiscalSummary(order, { fallbackTaxLabel: settings?.tax_label });
  const taxLabel = fiscal.taxLabel;
  const total = Number(order.total);

  // DELIVERY FEE / ORDER TOTAL RECONCILIATION v1.2 (décision CIO --
  // OPTION D) : quand la présentation commerciale est active, les
  // lignes produit sont affichées en HT, avec la répartition
  // déterministe calculée par le contrat fiscal partagé (jamais ici).
  // La somme des HT affichés égale EXACTEMENT « Sous-total produits
  // HT » -- toute l'arithmétique visible du ticket se vérifie donc à
  // la main. Sans présentation (retrait/table, livraison gratuite,
  // instantané incomplet) ou sans instantané de taux par ligne, la
  // ligne garde le montant réellement facturé, exactement comme avant.
  const lineNetById = new Map<string, number>(
    (fiscal.commercialPresentation?.productLines ?? []).map((line) => [line.itemId, line.net])
  );
  const itemRows = order.order_items
    .map((item) => {
      const displayedNet = lineNetById.get(String(item.id));
      const amount =
        displayedNet === undefined
          ? esc(formatPrice(Number(item.line_total), order.currency))
          : `${esc(formatPrice(displayedNet, order.currency))} HT`;
      return `
        <div class="item-row">
          <div><strong>${item.quantity} x ${esc(item.item_name)}</strong>${
            item.option_name ? `<div class="option">+ ${esc(item.option_name)}</div>` : ""
          }</div>
          <div>${amount}</div>
        </div>`;
    })
    .join("");

  // DELIVERY FEE / ORDER TOTAL RECONCILIATION v1 -- composition du
  // total sur le ticket, dans la MÊME convention que le back-office et
  // que le checkout client : deux lignes UNIQUEMENT quand un frais de
  // livraison réel s'applique (table/retrait/livraison gratuite :
  // ticket strictement INCHANGÉ). Les montants viennent du contrat
  // fiscal partagé -- `lib/receipt.ts` ne soustrait rien lui-même.
  //
  // v1.1 : ces deux lignes ne servent PLUS que de repli, quand la
  // présentation commerciale ci-dessous n'est pas disponible (aucune
  // décomposition fiable : instantané absent/incomplet, récapitulatif
  // TVA désactivé, marchand en prix hors taxes).
  const compositionRows =
    fiscal.deliveryFee > 0 && fiscal.compositionReconcilesWithTotal
      ? `
    <div class="total-row"><span>${esc(t("subtotalLabel"))}</span><span>${esc(formatPrice(fiscal.productsSubtotal, order.currency))}</span></div>
    <div class="total-row"><span>${esc(t("deliveryFeeLabel"))}</span><span>${esc(formatPrice(fiscal.deliveryFee, order.currency))}</span></div>`
      : "";

  // ============================================================
  // DELIVERY FEE / ORDER TOTAL RECONCILIATION v1.1 -- PRÉSENTATION
  // COMMERCIALE DU TICKET (décision produit CIO).
  // ============================================================
  // Invariant AFFICHÉ, cent pour cent :
  //
  //     PRODUITS HT
  //   + TVA PRODUITS (par taux réellement présent dans l'instantané)
  //   + LIVRAISON TTC
  //   = TOTAL TTC
  //
  // Le frais de livraison est montré comme UN SEUL montant TTC : sa
  // TVA est donc déjà dedans, et les lignes de TVA au-dessus ne
  // portent QUE la part produit -- jamais de double comptage visuel.
  // La ventilation TVA livraison persistée
  // (order_delivery_tax_allocations) n'est ni modifiée, ni recalculée,
  // ni supprimée : elle reste l'autorité interne, exposée telle quelle
  // par le résumé fiscal complet (`fiscal.rates`).
  //
  // Ce bloc ne CALCULE rien : tout vient de
  // `computeOrderFiscalSummary(...).commercialPresentation`. Aucun
  // taux n'est codé en dur, la convention d'arrondi existante est
  // réutilisée telle quelle, et un taux à 0 % suit la convention
  // d'affichage déjà établie (aucune ligne "TVA 0 %" explicite, sa
  // base contribuant normalement au HT).
  const presentation = fiscal.commercialPresentation;
  const presentationRows = presentation
    ? `
    <div class="total-row"><span>Sous-total produits HT</span><span>${esc(formatPrice(presentation.productNet, order.currency))}</span></div>
    ${presentation.productRates
      .filter((r) => r.rate > 0)
      .map(
        (r) =>
          `<div class="total-row"><span>${esc(taxLabel)} produits ${r.rate}%</span><span>${esc(formatPrice(r.tax, order.currency))}</span></div>`
      )
      .join("")}
    ${
      presentation.deliveryGrossTtc > 0
        ? `<div class="total-row"><span>${esc(t("deliveryFeeLabel"))} TTC</span><span>${esc(formatPrice(presentation.deliveryGrossTtc, order.currency))}</span></div>`
        : ""
    }
    <div class="total-row grand-total"><span>Total TTC</span><span>${esc(formatPrice(presentation.finalGrossTtc, order.currency))}</span></div>`
    : "";

  const customer = [
    order.customer_name,
    order.customer_phone,
    order.delivery_address,
  ]
    .filter(Boolean)
    .map((line) => `<div>${esc(String(line))}</div>`)
    .join("");

  // PRINTED MERCHANT RECEIPT / VAT + LEGAL INFO FIX v1 -- ferme un
  // écart confirmé : `settings.email` est chargé par
  // getReceiptSettings() (lib/services/dashboard.ts) et saisi par le
  // marchand dans la MÊME section "informations légales" du formulaire
  // de réglages (app/dashboard/settings/page.tsx, aux côtés de
  // legal_name/legal_address/phone/tax_identifier/registration_number
  // -- tous déjà rendus ci-dessous) depuis MERCHANT LEGAL & TAX
  // PROFILE v1 ("ajouté, absent de V29", voir lib/dashboard-types.ts)
  // -- mais n'était encore JAMAIS rendu sur le ticket imprimé
  // lui-même. Traitement CONDITIONNEL identique aux champs voisins
  // (rendu uniquement si configuré, jamais inventé), positionné
  // naturellement à côté du téléphone dans le HTML ci-dessous.
  return `<!doctype html>
<html lang="${esc(order.customer_language || "fr")}" dir="auto">
<head>
<meta charset="utf-8" />
<title>${esc(t("rcOrder", { n: order.order_number }))}</title>
<style>
  @page { size: ${width}mm auto; margin: 3mm; }
  * { box-sizing: border-box; }
  body { width: ${width - 6}mm; margin: 0; font-family: Arial, "Noto Sans Arabic", sans-serif; color: #111; font-size: 11px; }
  h1 { margin: 0; font-size: 16px; text-align: center; }
  .center { text-align: center; }
  .muted { color: #444; }
  .rule { border-top: 1px dashed #111; margin: 8px 0; }
  .item-row, .total-row { display: flex; justify-content: space-between; gap: 8px; margin: 6px 0; }
  .item-row > div:first-child { flex: 1; }
  .option { padding-inline-start: 10px; font-size: 10px; }
  .grand-total { font-size: 14px; font-weight: 700; }
  .footer { margin-top: 10px; text-align: center; white-space: pre-wrap; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <h1>${esc(settings?.business_name || restaurantName)}</h1>
  ${settings?.legal_name ? `<div class="center">${esc(settings.legal_name)}</div>` : ""}
  ${settings?.legal_address ? `<div class="center muted">${esc(settings.legal_address)}</div>` : ""}
  ${settings?.phone ? `<div class="center muted">${esc(settings.phone)}</div>` : ""}
  ${settings?.email ? `<div class="center muted">${esc(settings.email)}</div>` : ""}
  ${settings?.tax_identifier ? `<div class="center muted">${esc(settings.tax_label)}: ${esc(settings.tax_identifier)}</div>` : ""}
  ${settings?.registration_number ? `<div class="center muted">N°: ${esc(settings.registration_number)}</div>` : ""}
  <div class="rule"></div>
  <div><strong>${esc(t("rcOrder", { n: order.order_number }))}</strong></div>
  <div>${esc(new Date(order.created_at).toLocaleString("fr-FR"))}</div>
  <div><strong>${esc(serviceLabel(order, lang))}</strong></div>
  ${customer}
  ${order.customer_note ? `<div>Note: ${esc(order.customer_note)}</div>` : ""}
  <div class="rule"></div>
  ${itemRows}
  <div class="rule"></div>
  ${presentation ? presentationRows : `${compositionRows}
  ${fiscal.mode === "mixed-rate" ? `
    <div class="total-row"><span>Total HT</span><span>${esc(formatPrice(fiscal.totalNet, order.currency))}</span></div>
    ${fiscal.rates
      .filter((g) => g.rate > 0)
      .map(
        (g) =>
          `<div class="total-row"><span>${esc(taxLabel)} ${g.rate}%</span><span>${esc(formatPrice(g.tax, order.currency))}</span></div>`
      )
      .join("")}
    <div class="total-row grand-total"><span>Total TTC</span><span>${esc(formatPrice(total, order.currency))}</span></div>
  ` : fiscal.mode === "flat-rate" ? `
    <div class="total-row"><span>Total HT</span><span>${esc(formatPrice(fiscal.totalNet, order.currency))}</span></div>
    <div class="total-row"><span>${esc(taxLabel)} ${fiscal.rate}%</span><span>${esc(formatPrice(fiscal.totalTax, order.currency))}</span></div>
    <div class="total-row grand-total"><span>Total TTC</span><span>${esc(formatPrice(fiscal.totalGross, order.currency))}</span></div>
  ` : `
    <div class="total-row grand-total"><span>${esc(t("rcTotal"))}</span><span>${esc(formatPrice(total, order.currency))}</span></div>
  `}`}
  ${settings?.footer_text ? `<div class="footer">${esc(settings.footer_text)}</div>` : ""}
  <script>window.addEventListener('load', () => { window.print(); });</script>
</body>
</html>`;
}

export function printReceipt(params: {
  order: DashboardOrder;
  restaurantName: string;
  settings: ReceiptSettings | null;
}, lang: Lang = "fr"): void {
  const popup = window.open("", "_blank", "width=420,height=720");
  if (!popup) throw new Error("Le navigateur a bloque la fenetre d'impression.");
  popup.document.open();
  popup.document.write(buildReceiptHtml(params, lang));
  popup.document.close();
}
