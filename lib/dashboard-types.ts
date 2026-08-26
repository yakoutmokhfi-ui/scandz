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
  item_name: string;
  option_name: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
  /** Traductions du produit et de l'option, pour afficher le ticket
      dans la langue du gérant plutôt que dans celle figée à la
      commande. */
  menu_items?: { translations?: Record<string, { name?: string }> | null } | null;
  option?: { translations?: Record<string, { name?: string }> | null } | null;
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

export interface ReceiptSettings {
  restaurant_id: string;
  business_name: string | null;
  legal_name: string | null;
  legal_address: string | null;
  phone: string | null;
  tax_identifier: string | null;
  registration_number: string | null;
  paper_width_mm: 58 | 80;
  show_tax_summary: boolean;
  prices_include_tax: boolean;
  tax_label: string;
  default_tax_rate: number;
  footer_text: string | null;
}
