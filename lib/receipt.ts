import type { DashboardOrder, ReceiptSettings } from "@/lib/dashboard-types";
import { formatPrice } from "@/lib/whatsapp";
import { translate, type Lang } from "@/lib/i18n";

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
  const hasTaxSnapshot = order.tax_settings_snapshot_prices_include_tax !== null
    && order.tax_settings_snapshot_prices_include_tax !== undefined;
  const rate = hasTaxSnapshot ? Number(order.tax_settings_snapshot_default_tax_rate ?? 0) : 0;
  const pricesIncludeTax = hasTaxSnapshot
    ? Boolean(order.tax_settings_snapshot_prices_include_tax)
    : false;
  const taxLabel = hasTaxSnapshot
    ? (order.tax_settings_snapshot_tax_label || "TVA")
    : (settings?.tax_label || "TVA");
  const showTax = hasTaxSnapshot
    && Boolean(order.tax_settings_snapshot_show_tax_summary && rate > 0);
  const total = Number(order.total);
  const taxAmount = showTax
    ? pricesIncludeTax
      ? total - total / (1 + rate / 100)
      : total * (rate / 100)
    : 0;
  const excludingTax = pricesIncludeTax ? total - taxAmount : total;
  const includingTax = pricesIncludeTax ? total : total + taxAmount;

  const itemRows = order.order_items
    .map(
      (item) => `
        <div class="item-row">
          <div><strong>${item.quantity} x ${esc(item.item_name)}</strong>${
            item.option_name ? `<div class="option">+ ${esc(item.option_name)}</div>` : ""
          }</div>
          <div>${esc(formatPrice(Number(item.line_total), order.currency))}</div>
        </div>`
    )
    .join("");

  const customer = [
    order.customer_name,
    order.customer_phone,
    order.delivery_address,
  ]
    .filter(Boolean)
    .map((line) => `<div>${esc(String(line))}</div>`)
    .join("");

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
  ${showTax ? `
    <div class="total-row"><span>Total HT</span><span>${esc(formatPrice(excludingTax, order.currency))}</span></div>
    <div class="total-row"><span>${esc(taxLabel)} ${rate}%</span><span>${esc(formatPrice(taxAmount, order.currency))}</span></div>
    <div class="total-row grand-total"><span>Total TTC</span><span>${esc(formatPrice(includingTax, order.currency))}</span></div>
  ` : `
    <div class="total-row grand-total"><span>${esc(t("rcTotal"))}</span><span>${esc(formatPrice(total, order.currency))}</span></div>
  `}
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
