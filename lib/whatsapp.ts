import type { RestaurantFull, MenuItem } from "@/lib/types";
import type { CustomerInfo } from "@/lib/customer";
import { formatAddress } from "@/lib/customer";
import { translate, type Lang } from "@/lib/i18n";
import { tName } from "@/lib/menu-i18n";
import { normalizeOrderNote } from "@/lib/order-note";

export interface CartLine {
  item: MenuItem;
  quantity: number;
  /**
   * Option retenue, conservée comme référence (et non comme texte)
   * pour être rendue dans la langue du lecteur : celle du client
   * dans le panier, celle du personnel dans le message de commande.
   */
  option?: MenuItem;
  /** Type d'option, pour choisir le bon libellé traduit */
  optionKind?: "flavor" | "pastry";
}

/** Comment le client récupère sa commande. */
export type OrderContext =
  | { mode: "table"; tableNumber: number }
  | { mode: "pickup"; customer: CustomerInfo }
  | { mode: "delivery"; zoneLabel: string; customer: CustomerInfo };

export function formatPrice(price: number, currency: string): string {
  if (currency === "EUR") {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
    }).format(price);
  }
  // Le dinar s'écrit "DA" dans l'usage courant, pas "DZD".
  if (currency === "DZD") {
    return `${Math.round(price).toLocaleString("fr-FR")} DA`;
  }
  return `${price.toLocaleString("fr-FR")} ${currency}`;
}

// ------------------------------------------------------------------
// Numéro WhatsApp (V64) — normalisation et validation partagées entre
// l'interface (validation immédiate, avant tout appel RPC) et le SQL
// (revalidation défensive dans update_restaurant_whatsapp). Les deux
// implémentent la même règle : indicatif international obligatoire.
// ------------------------------------------------------------------

/**
 * Nettoie une saisie WhatsApp : seuls les espaces et les tirets sont
 * retirés (séparateurs de lisibilité légitimes, ex. "+213 550-00-00-00").
 *
 * Ne retire JAMAIS silencieusement une lettre ou une parenthèse : un
 * numéro qui en contient doit être rejeté par isValidWhatsappNumber,
 * pas "réparé" à l'aveugle. C'est délibéré : "+213ABC666510901" ne
 * doit jamais devenir un numéro valide simplement parce que les
 * lettres ont disparu au nettoyage, et "+213 (0) 550…" ne doit plus
 * être traité comme un format accepté — le zéro entre parenthèses
 * dénote un préfixe de tri national qui ne fait pas partie du numéro
 * international et ne doit pas être deviné/conservé automatiquement.
 * Le format attendu est "+213 550…", sans parenthèses.
 */
export function normalizeWhatsappNumber(raw: string): string {
  return raw.trim().replace(/[ \-]/g, "");
}

/**
 * Indicatif international ('+') obligatoire, puis 8 à 15 chiffres
 * uniquement, sans zéro immédiatement après l'indicatif. Toute lettre,
 * parenthèse ou autre caractère fait échouer la validation : ils ne
 * sont pas retirés par normalizeWhatsappNumber avant ce test.
 * Proche du format E.164, sans validation stricte par pays (pas de
 * liste d'indicatifs).
 */
const WHATSAPP_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export function isValidWhatsappNumber(raw: string): boolean {
  return WHATSAPP_PATTERN.test(normalizeWhatsappNumber(raw));
}

/** Ligne d'en-tête du message décrivant le mode de récupération. */
function contextLines(ctx: OrderContext, lang: Lang): string[] {
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
  switch (ctx.mode) {
    case "table":
      return [t("waTable", { n: ctx.tableNumber })];
    case "pickup":
      return [
        t("waPickup"),
        ctx.customer.name ? `🙋 ${ctx.customer.name}` : "",
        ctx.customer.phone ? `📞 ${ctx.customer.phone}` : "",
        ctx.customer.email ? `✉️ ${ctx.customer.email}` : "",
      ].filter(Boolean);
    case "delivery":
      return [
        t("waDelivery", { zone: ctx.zoneLabel }),
        `📍 ${formatAddress(ctx.customer)}`,
        ctx.customer.name ? `🙋 ${ctx.customer.name}` : "",
        ctx.customer.phone ? `📞 ${ctx.customer.phone}` : "",
        ctx.customer.email ? `✉️ ${ctx.customer.email}` : "",
      ].filter(Boolean);
  }
}

/**
 * Construit le lien wa.me contenant le message de commande.
 *
 * Le message reste TOUJOURS en français, quelle que soit la langue
 * choisie par le client : c'est le personnel du restaurant qui le
 * lit, et les noms de produits doivent correspondre à ceux de la
 * carte en cuisine.
 * Le numéro est nettoyé pour ne garder que les chiffres
 * (format attendu par WhatsApp : indicatif pays sans "+").
 */
export function buildWhatsAppUrl(
  restaurant: RestaurantFull,
  lines: CartLine[],
  ctx: OrderContext,
  staffLang: Lang = "fr",
  orderNumber?: number,
  note?: string | null
): string {
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(staffLang, k, p);
  const { currency, whatsapp_number, source_language } = restaurant.config;
  const sourceLanguage: Lang = source_language ?? "fr";

  const total = lines.reduce((sum, l) => sum + l.item.price * l.quantity, 0);

  const orderLines = lines
    .map((l) => {
      // Nom du produit dans la langue du personnel, pas dans celle
      // du client : le ticket doit correspondre à la carte en cuisine.
      const name = tName(l.item, staffLang, sourceLanguage);
      const note = l.option
        ? ` (${t(l.optionKind === "flavor" ? "optFlavor" : "optPastry")} : ${tName(
            l.option,
            staffLang,
            sourceLanguage
          )})`
        : "";
      return `• ${l.quantity}x ${name}${note} — ${formatPrice(
        l.item.price * l.quantity,
        currency
      )}`;
    })
    .join("\n");

  // Note générale (V65) : uniquement si non vide après normalisation.
  // Toujours en français dans le message (voir remarque ci-dessus sur
  // la langue du personnel) — c'est le texte saisi par le client, il
  // n'est pas traduit, seul le libellé "waNote" l'est.
  const { value: noteValue, isEmpty: noteEmpty } = normalizeOrderNote(note);

  const message = [
    orderNumber !== undefined
      ? t("waHeaderNumbered", { n: orderNumber, name: restaurant.name })
      : t("waHeader", { name: restaurant.name }),
    ...contextLines(ctx, staffLang),
    "",
    orderLines,
    ...(noteEmpty ? [] : ["", t("waNote", { note: noteValue })]),
    "",
    t("waTotal", { amount: formatPrice(total, currency) }),
  ].join("\n");

  const digits = whatsapp_number.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
