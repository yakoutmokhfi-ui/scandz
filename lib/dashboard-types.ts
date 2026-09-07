export type OrderStatus =
  | "new"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "rejected"
  | "cancelled";

export type ServiceMode = "table" | "pickup" | "delivery";

export interface MerchantRestaurant {
  restaurant_id: string;
  role: "owner" | "manager" | "staff";
  restaurants: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

export interface DashboardOrderItem {
  id: string;
  /** Instantané figé au moment de create_order -- RECEIPT / INVOICE
      TAX DETAIL v1.1 (ferme RITD-V1-NAME-HISTORY-01) : c'est l'UNIQUE
      source d'affichage du nom de produit/option pour une commande,
      dans TOUTES les langues du tableau de bord. Aucun champ de
      traduction catalogue courante n'est chargé ici -- en charger un
      réintroduirait la même classe de défaut (une vieille commande
      changerait d'affichage quand le catalogue change). */
  item_name: string;
  option_name: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface DashboardOrder {
  id: string;
  restaurant_id: string;
  order_number: number;
  status: OrderStatus;
  service_mode: ServiceMode;
  table_number: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  delivery_address: string | null;
  delivery_zone: string | null;
  customer_note: string | null;
  customer_language: string | null;
  subtotal: number;
  total: number;
  currency: string;
  created_at: string;
  updated_at: string;
  order_items: DashboardOrderItem[];
  /**
   * MERCHANT LEGAL & TAX PROFILE v1.1 -- instantané FIGÉ des réglages
   * fiscaux du marchand (public.receipt_settings), capturé par le
   * déclencheur BEFORE INSERT `snapshot_receipt_tax_settings` au
   * moment précis de la création de la commande -- jamais relu ni
   * recalculé ensuite. Ferme MLTP-V1-HISTORICAL-TAX-01 : sans cet
   * instantané, `lib/receipt.ts` recalculait la décomposition
   * HT/TVA/TTC depuis les réglages COURANTS, qui peuvent avoir changé
   * depuis (le marchand a pu modifier son taux/son option "prix TTC"
   * après coup) -- une réimpression affichait alors une décomposition
   * fiscale rétroactivement FAUSSE.
   *
   * `null` sur les 4 champs = commande antérieure à ce lot, ou
   * restaurant sans aucune ligne receipt_settings au moment de la
   * commande ("LEGACY ORDER -- FISCAL SNAPSHOT UNAVAILABLE", même
   * convention que order_items.weight_is_approximate_snapshot dans
   * RECEIPT / INVOICE TAX DETAIL v1.1) -- dans ce cas, lib/receipt.ts
   * n'affiche JAMAIS de décomposition HT/TVA/TTC fabriquée, seulement
   * le total autoritaire de la commande (repli sûr, mandat v1.1
   * section HISTORICAL TAX SAFETY, option B).
   */
  tax_settings_snapshot_default_tax_rate: number | null;
  tax_settings_snapshot_prices_include_tax: boolean | null;
  tax_settings_snapshot_tax_label: string | null;
  tax_settings_snapshot_show_tax_summary: boolean | null;
}

/**
 * Dashboard Delivery Pricing v1 — forme MARCHAND, volontairement
 * DISTINCTE de `PublicDeliveryFulfillmentRule` (lib/sale-modes-types.ts,
 * client-facing, lecture seule) pour ne pas coupler les deux
 * préoccupations : ce type est celui d'un formulaire d'ÉDITION, pas
 * d'un affichage client. Forme plate volontairement simple pour ce
 * v1 (mission : "No large discriminated-union framework required for
 * v1") — `pricingMode` reste la seule branche à lire pour savoir quel
 * champ afficher (`freeThreshold` uniquement si `pricingMode ===
 * "free_above_threshold"`), sans qu'aucun composant n'ait besoin de
 * connaître la structure interne de la base. Aucun champ structurel
 * (provider, fulfillment_code, zone_prefixes, is_fallback,
 * display_order, enabled, mode_code, restaurant_id) n'apparaît ici --
 * ce sont des données Scanym-managées, jamais exposées au marchand
 * par ce chemin (voir get_merchant_delivery_fulfillment_pricing).
 */
export interface MerchantDeliveryFulfillmentPricingRule {
  ruleId: string;
  /** Étiquette lisible composée côté serveur -- jamais le code brut
   *  de fulfillment ni le prestataire. */
  fulfillmentLabel: string;
  pricingMode: "fixed" | "free_above_threshold";
  fixedFee: number | null;
  freeThreshold: number | null;
  customerText: string | null;
}

/**
 * Dashboard Payment Module v1 (PAYMENT P2B-B) — forme MARCHAND SÛRE,
 * retournée EXCLUSIVEMENT par la RPC publiée
 * public.get_merchant_payment_provider_config(uuid) (PAYMENT P2B-A).
 * Ce type est un miroir VOLONTAIREMENT ÉTROIT du contrat de retour de
 * cette RPC (exactement 6 colonnes) -- il ne contient et ne contiendra
 * JAMAIS `id`, `restaurant_id`, `credentials_ref`, une référence Vault,
 * un secret, un mot de passe, une clé MAC, un identifiant TPE, ou tout
 * autre matériel de paiement : ces champs ne sont ni lus ni exposés
 * par ce chemin (P2B-A ne les retourne jamais et P2B-B n'ajoute aucun
 * autre appel). `mode`/`configurationStatus` restent typés `string`
 * (pas une union littérale stricte) volontairement : une future valeur
 * DB inconnue ne doit jamais faire planter le mapping ni le typage --
 * c'est la couche d'affichage (labels) qui gère un repli sûr pour une
 * valeur non reconnue, jamais ce type ni le service.
 */
export interface MerchantPaymentProviderConfig {
  providerCode: string;
  mode: string;
  configurationStatus: string;
  isEnabled: boolean;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
}

export interface ReceiptSettings {
  restaurant_id: string;
  business_name: string | null;
  legal_name: string | null;
  legal_address: string | null;
  phone: string | null;
  /** MERCHANT LEGAL & TAX PROFILE v1 -- ajouté (absent de V29). */
  email: string | null;
  tax_identifier: string | null;
  registration_number: string | null;
  paper_width_mm: 58 | 80;
  show_tax_summary: boolean;
  prices_include_tax: boolean;
  tax_label: string;
  default_tax_rate: number;
  footer_text: string | null;
  /**
   * MERCHANT LEGAL & TAX PROFILE v1 -- pays du restaurant
   * (`restaurants.country`, Lot D), lu ICI via une jointure PostgREST
   * en lecture seule (`getReceiptSettings`), UNIQUEMENT pour piloter
   * l'intitulé de champ affiché (voir lib/merchant-legal-tax-labels.ts).
   * Jamais écrit par `updateReceiptSettings` -- `restaurants.country`
   * reste un champ de l'établissement, hors périmètre de ce lot.
   */
  restaurant_country: string | null;
}
