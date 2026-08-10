import { supabase } from "@/lib/supabase";
import type {
  DashboardOrder,
  MerchantRestaurant,
  OrderStatus,
  ReceiptSettings,
} from "@/lib/dashboard-types";

export async function getMerchantRestaurants(): Promise<MerchantRestaurant[]> {
  const { data, error } = await supabase
    .from("restaurant_users")
    .select("restaurant_id, role, restaurants(id, name, slug)")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as MerchantRestaurant[];
}

export async function getDashboardOrders(
  restaurantId: string,
  includeCompleted = false
): Promise<DashboardOrder[]> {
  let query = supabase
    .from("orders")
    .select(
      `
      id, restaurant_id, order_number, status, service_mode, table_number,
      customer_name, customer_phone, customer_email,
      delivery_address, delivery_zone, customer_note, customer_language,
      subtotal, total, currency, created_at, updated_at,
      order_items (
        id, item_name, option_name, quantity, unit_price, line_total,
        menu_item_id, option_item_id,
        menu_items!order_items_menu_item_id_fkey ( translations ),
        option:menu_items!order_items_option_item_id_fkey ( translations )
      )
    `
    )
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false })
    .limit(includeCompleted ? 100 : 50);

  if (!includeCompleted) {
    query = query.not("status", "in", '(completed,rejected,cancelled)');
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as DashboardOrder[];
}

export async function updateOrderStatus(
  orderId: string,
  nextStatus: OrderStatus
): Promise<void> {
  const { error } = await supabase.rpc("update_order_status", {
    p_order_id: orderId,
    p_new_status: nextStatus,
  });
  if (error) throw new Error(error.message);
}

export async function getReceiptSettings(
  restaurantId: string
): Promise<ReceiptSettings | null> {
  const { data, error } = await supabase
    .from("receipt_settings")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as ReceiptSettings | null;
}

// ------------------------------------------------------------------
// Catalogue commerçant (V31)
//
// Aucune écriture directe sur menu_items : toutes les opérations
// passent par des fonctions qui vérifient l'identité, le
// rattachement à l'établissement et le rôle.
// ------------------------------------------------------------------

type Translations = Record<string, { name?: string; description?: string }>;

export interface CatalogueProduct {
  product_id: string;
  category_id: string;
  category_name: string;
  category_translations: Translations | null;
  name: string;
  description: string | null;
  translations: Translations | null;
  price: number;
  is_available: boolean;
  archived_at: string | null;
  display_order: number;
  is_option_source: boolean;
}

export async function getMerchantCatalogue(
  restaurantId: string,
  archived = false
): Promise<CatalogueProduct[]> {
  const { data, error } = await supabase.rpc("get_merchant_catalogue", {
    p_restaurant_id: restaurantId,
    p_archived: archived,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as CatalogueProduct[];
}

export async function setProductAvailability(
  productId: string,
  isAvailable: boolean
): Promise<void> {
  const { error } = await supabase.rpc("set_product_availability", {
    p_product_id: productId,
    p_is_available: isAvailable,
  });
  if (error) throw new Error(error.message);
}

export async function updateProduct(
  productId: string,
  name: string,
  description: string | null,
  price: number
): Promise<void> {
  const { error } = await supabase.rpc("update_product", {
    p_product_id: productId,
    p_name: name,
    p_description: description,
    p_price: price,
  });
  if (error) throw new Error(error.message);
}

export async function createProduct(
  categoryId: string,
  name: string,
  description: string | null,
  price: number
): Promise<string> {
  const { data, error } = await supabase.rpc("create_product", {
    p_category_id: categoryId,
    p_name: name,
    p_description: description,
    p_price: price,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function archiveProduct(productId: string): Promise<void> {
  const { error } = await supabase.rpc("archive_product", {
    p_product_id: productId,
  });
  if (error) throw new Error(error.message);
}

export async function restoreProduct(productId: string): Promise<void> {
  const { error } = await supabase.rpc("restore_product", {
    p_product_id: productId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Devise de l'établissement.
 *
 * Lue dans restaurant_configs plutôt que d'être supposée : Illico est
 * en DZD, Sanaa en EUR, et un futur client pourra être ailleurs.
 * La table est en lecture publique, aucune fonction dédiée n'est
 * nécessaire — et la migration reste inchangée.
 */
export async function getRestaurantCurrency(
  restaurantId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("restaurant_configs")
    .select("currency")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.currency ?? "DZD";
}

// ------------------------------------------------------------------
// Paramètres de l'établissement (V39)
// ------------------------------------------------------------------

export interface RestaurantSettingsRow {
  staff_receipt_language: string;
  address: string | null;
  opening_hours: string | null;
  currency: string;
  whatsapp_number: string;
}

export async function getRestaurantSettings(
  restaurantId: string
): Promise<RestaurantSettingsRow> {
  const { data, error } = await supabase
    .from("restaurant_configs")
    .select(
      "staff_receipt_language, address, opening_hours, currency, whatsapp_number"
    )
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (
    data ?? {
      staff_receipt_language: "fr",
      address: null,
      opening_hours: null,
      currency: "DZD",
      whatsapp_number: "",
    }
  );
}

export async function updateRestaurantSettings(
  restaurantId: string,
  staffLanguage: string,
  address: string | null,
  openingHours: string | null
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_settings", {
    p_restaurant_id: restaurantId,
    p_staff_language: staffLanguage,
    p_address: address,
    p_opening_hours: openingHours,
  });
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------------
// Numéro WhatsApp (V64) — réservé owner/manager, contrôlé côté SQL
// par update_restaurant_whatsapp (voir migration-v64-*.sql).
// ------------------------------------------------------------------

export async function updateRestaurantWhatsapp(
  restaurantId: string,
  whatsappNumber: string
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_whatsapp", {
    p_restaurant_id: restaurantId,
    p_whatsapp_number: whatsappNumber,
  });
  if (error) throw new Error(error.message);
}
