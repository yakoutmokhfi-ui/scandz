import { supabase } from "@/lib/supabase";
import type {
  DashboardOrder,
  MerchantRestaurant,
  OrderStatus,
  ReceiptSettings,
} from "@/lib/dashboard-types";
import {
  isShortDescriptionTooLongError,
  isDescriptionTooLongError,
  isCategoryDuplicateNameError,
  isCategoryDescriptionTooLongError,
  ShortDescriptionTooLongError,
  DescriptionTooLongError,
  CategoryDuplicateNameError,
  CategoryDescriptionTooLongError,
} from "@/lib/services/catalogue-error";

export {
  ShortDescriptionTooLongError,
  DescriptionTooLongError,
  CategoryDuplicateNameError,
  CategoryDescriptionTooLongError,
} from "@/lib/services/catalogue-error";

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

type Translations = Record<
  string,
  { name?: string; description?: string; short_description?: string }
>;

/** Catégorie du catalogue commerçant, avec ou sans produits. */
export interface CatalogueCategory {
  category_id: string;
  category_name: string;
  category_translations: Translations | null;
  category_display_order: number;
  /** true si au moins un produit référence cette catégorie comme source d'options. */
  category_is_option_source: boolean;
  /** Description longue de catégorie (V67b), optionnelle. */
  category_description: string | null;
  products: CatalogueProduct[];
}

export interface CatalogueProduct {
  product_id: string;
  category_id: string;
  category_name: string;
  category_translations: Translations | null;
  name: string;
  /** Description courte (V66), affichée directement — max 100 caractères. */
  short_description: string | null;
  /** Description longue (existant), affichée via le bouton (i) — max 500 caractères. */
  description: string | null;
  translations: Translations | null;
  price: number;
  is_available: boolean;
  archived_at: string | null;
  display_order: number;
  is_option_source: boolean;
  /** Photo produit (V67), Supabase Storage ou ancienne image statique. `null` si aucune photo. */
  image_url: string | null;
}

/**
 * Lit le catalogue et le regroupe par catégorie.
 *
 * get_merchant_catalogue (V66) renvoie désormais une ligne par
 * catégorie même sans aucun produit (LEFT JOIN) : sans cela, une
 * catégorie tout juste créée resterait invisible tant qu'aucun
 * produit n'y est ajouté. Ce regroupement filtre les colonnes produit
 * nulles pour construire `products`, tout en conservant la catégorie
 * elle-même dans le résultat.
 */
export async function getMerchantCatalogue(
  restaurantId: string,
  archived = false
): Promise<CatalogueCategory[]> {
  const { data, error } = await supabase.rpc("get_merchant_catalogue", {
    p_restaurant_id: restaurantId,
    p_archived: archived,
  });
  if (error) throw new Error(error.message);

  type Row = {
    product_id: string | null;
    category_id: string;
    category_name: string;
    category_translations: Translations | null;
    category_display_order: number;
    category_is_option_source: boolean;
    category_description: string | null;
    name: string | null;
    short_description: string | null;
    description: string | null;
    translations: Translations | null;
    price: number | null;
    is_available: boolean | null;
    archived_at: string | null;
    display_order: number | null;
    is_option_source: boolean | null;
    image_url: string | null;
  };

  const rows = (data ?? []) as Row[];
  const categories: CatalogueCategory[] = [];
  for (const r of rows) {
    let cat = categories.find((c) => c.category_id === r.category_id);
    if (!cat) {
      cat = {
        category_id: r.category_id,
        category_name: r.category_name,
        category_translations: r.category_translations,
        category_display_order: r.category_display_order,
        category_is_option_source: r.category_is_option_source,
        category_description: r.category_description,
        products: [],
      };
      categories.push(cat);
    }
    // Catégorie vide : la ligne LEFT JOIN n'a pas de produit associé.
    if (r.product_id === null) continue;
    cat.products.push({
      product_id: r.product_id,
      category_id: r.category_id,
      category_name: r.category_name,
      category_translations: r.category_translations,
      name: r.name as string,
      short_description: r.short_description,
      description: r.description,
      translations: r.translations,
      price: r.price as number,
      is_available: r.is_available as boolean,
      archived_at: r.archived_at,
      display_order: r.display_order as number,
      is_option_source: r.is_option_source as boolean,
      image_url: r.image_url,
    });
  }
  return categories;
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
  price: number,
  shortDescription: string | null = null
): Promise<void> {
  const { error } = await supabase.rpc("update_product", {
    p_product_id: productId,
    p_name: name,
    p_description: description,
    p_price: price,
    p_short_description: shortDescription,
  });
  if (error) {
    if (isShortDescriptionTooLongError(error)) throw new ShortDescriptionTooLongError();
    if (isDescriptionTooLongError(error)) throw new DescriptionTooLongError();
    throw new Error(error.message);
  }
}

export async function createProduct(
  categoryId: string,
  name: string,
  description: string | null,
  price: number,
  shortDescription: string | null = null
): Promise<string> {
  const { data, error } = await supabase.rpc("create_product", {
    p_category_id: categoryId,
    p_name: name,
    p_description: description,
    p_price: price,
    p_short_description: shortDescription,
  });
  if (error) {
    if (isShortDescriptionTooLongError(error)) throw new ShortDescriptionTooLongError();
    if (isDescriptionTooLongError(error)) throw new DescriptionTooLongError();
    throw new Error(error.message);
  }
  return data as string;
}

/**
 * Crée une catégorie. Toujours active à la création : le serveur
 * impose is_active = true, aucun paramètre ne permet de créer
 * directement une catégorie technique inactive depuis cet écran.
 */
export async function createCategory(
  restaurantId: string,
  name: string,
  displayOrder: number | null = null
): Promise<string> {
  const { data, error } = await supabase.rpc("create_category", {
    p_restaurant_id: restaurantId,
    p_name: name,
    p_display_order: displayOrder,
  });
  if (error) {
    if (isCategoryDuplicateNameError(error)) throw new CategoryDuplicateNameError();
    throw new Error(error.message);
  }
  return data as string;
}

/**
 * Modifie le nom, l'ordre d'affichage et la description longue
 * d'une catégorie. Ne touche jamais son état actif/inactif.
 *
 * `description` reste optionnel et ne réinterprète jamais une donnée
 * existante : appeler cette fonction sans description explicite
 * (`undefined`/non fourni) l'efface (RPC : `null`) — c'est un choix
 * du commerçant à chaque appel, jamais une migration automatique.
 */
export async function updateCategory(
  categoryId: string,
  name: string,
  displayOrder: number,
  description: string | null = null
): Promise<void> {
  const { error } = await supabase.rpc("update_category", {
    p_category_id: categoryId,
    p_name: name,
    p_display_order: displayOrder,
    p_description: description,
  });
  if (error) {
    if (isCategoryDuplicateNameError(error)) throw new CategoryDuplicateNameError();
    if (isCategoryDescriptionTooLongError(error)) throw new CategoryDescriptionTooLongError();
    throw new Error(error.message);
  }
}

/**
 * Modifie l'ordre d'affichage d'un produit au sein de sa catégorie
 * (V67b). RPC dédiée (même patron que setProductAvailability/
 * setProductPhoto) — owner/manager uniquement : réordonner le
 * catalogue est une décision de merchandising, pas un geste
 * opérationnel ouvert à staff.
 */
export async function setProductOrder(
  productId: string,
  displayOrder: number
): Promise<void> {
  const { error } = await supabase.rpc("set_product_order", {
    p_product_id: productId,
    p_display_order: displayOrder,
  });
  if (error) throw new Error(error.message);
}

/**
 * Photo produit (V67). `imageUrl = null` retire la photo. Ne parle
 * jamais directement à Storage — c'est le rôle exclusif de
 * lib/services/product-photo.ts, qui appelle cette fonction une fois
 * l'upload/la suppression Storage effectué(e).
 */
export async function setProductPhoto(
  productId: string,
  imageUrl: string | null
): Promise<void> {
  const { error } = await supabase.rpc("set_product_photo", {
    p_product_id: productId,
    p_image_url: imageUrl,
  });
  if (error) throw new Error(error.message);
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
  /** Identité visuelle (V68) — voir lib/services/establishment-assets.ts. */
  logo_url: string | null;
  cover_url: string | null;
  /** Couleurs personnalisées + lien de localisation/itinéraire (V69,
   *  corrigé V70 : nom de colonne indépendant du fournisseur). */
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  maps_url: string | null;
  /** LOT 1A — identité, apparence, réseaux sociaux, langue source. */
  display_name: string | null;
  intro_text: string | null;
  announcement_text: string | null;
  announcement_active: boolean;
  bg_color: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  facebook_url: string | null;
  source_language: string;
}

export async function getRestaurantSettings(
  restaurantId: string
): Promise<RestaurantSettingsRow> {
  const { data, error } = await supabase
    .from("restaurant_configs")
    .select(
      "staff_receipt_language, address, opening_hours, currency, whatsapp_number, logo_url, cover_url, primary_color, secondary_color, accent_color, maps_url, display_name, intro_text, announcement_text, announcement_active, bg_color, instagram_url, tiktok_url, facebook_url, source_language"
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
      logo_url: null,
      cover_url: null,
      primary_color: null,
      secondary_color: null,
      accent_color: null,
      maps_url: null,
      display_name: null,
      intro_text: null,
      announcement_text: null,
      announcement_active: false,
      bg_color: null,
      instagram_url: null,
      tiktok_url: null,
      facebook_url: null,
      source_language: "fr",
    }
  );
}

// ------------------------------------------------------------------
// Identité visuelle de l'établissement (V68) — logo & cover. Écriture
// exclusivement via ces deux RPC (set_restaurant_logo/_cover,
// restaurant_configs a toute écriture directe révoquée pour
// anon/authenticated depuis migration-v39-settings.sql), chacune
// réservée owner/manager du restaurant ou opérateur Scanym
// (assert_restaurant_asset_role, migration-v68-establishment-assets.sql).
// p_url = null retire l'asset (reset explicite de la colonne à NULL).
// ------------------------------------------------------------------

export async function setRestaurantLogo(
  restaurantId: string,
  url: string | null
): Promise<void> {
  const { error } = await supabase.rpc("set_restaurant_logo", {
    p_restaurant_id: restaurantId,
    p_url: url,
  });
  if (error) throw new Error(error.message);
}

export async function setRestaurantCover(
  restaurantId: string,
  url: string | null
): Promise<void> {
  const { error } = await supabase.rpc("set_restaurant_cover", {
    p_restaurant_id: restaurantId,
    p_url: url,
  });
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------------
// Couleurs personnalisées & lien de localisation/itinéraire (V69,
// corrigé V70). Écriture exclusivement via ces deux RPC, réservées
// owner/manager du restaurant OU opérateur Scanym (F-01, migration-v70 :
// mêmes assert_restaurant_asset_role que set_restaurant_logo/_cover,
// pour que le Super Admin puisse consulter/modifier ces réglages
// exactement comme le logo et la cover, sans logique dupliquée).
// Validation stricte (#RRGGBB / URL https) côté serveur ET côté UI
// (lib/color-contrast.ts, lib/maps-url.ts) — le message d'erreur RPC
// reste la source de vérité en cas de contournement de la validation
// client.
// ------------------------------------------------------------------

export async function updateRestaurantColors(
  restaurantId: string,
  primaryColor: string | null,
  secondaryColor: string | null,
  accentColor: string | null
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_colors", {
    p_restaurant_id: restaurantId,
    p_primary_color: primaryColor,
    p_secondary_color: secondaryColor,
    p_accent_color: accentColor,
  });
  if (error) throw new Error(error.message);
}

export async function updateRestaurantMapsUrl(
  restaurantId: string,
  mapsUrl: string | null
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_maps_url", {
    p_restaurant_id: restaurantId,
    p_maps_url: mapsUrl,
  });
  if (error) throw new Error(error.message);
}

/** LOT 1A — nom affiché, introduction, message temporaire. */
export async function updateRestaurantIdentity(
  restaurantId: string,
  displayName: string | null,
  introText: string | null,
  announcementText: string | null,
  announcementActive: boolean
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_identity", {
    p_restaurant_id: restaurantId,
    p_display_name: displayName,
    p_intro_text: introText,
    p_announcement_text: announcementText,
    p_announcement_active: announcementActive,
  });
  if (error) throw new Error(error.message);
}

/** LOT 1A — couleur de fond personnalisée. */
export async function updateRestaurantBgColor(
  restaurantId: string,
  bgColor: string | null
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_bg_color", {
    p_restaurant_id: restaurantId,
    p_bg_color: bgColor,
  });
  if (error) throw new Error(error.message);
}

/** LOT 1A — réseaux sociaux, validés serveur (HTTPS strict, domaine
 *  exact) par update_restaurant_social_links. */
export async function updateRestaurantSocialLinks(
  restaurantId: string,
  instagramUrl: string | null,
  tiktokUrl: string | null,
  facebookUrl: string | null
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_social_links", {
    p_restaurant_id: restaurantId,
    p_instagram_url: instagramUrl,
    p_tiktok_url: tiktokUrl,
    p_facebook_url: facebookUrl,
  });
  if (error) throw new Error(error.message);
}

/** LOT 1A — remplace ATOMIQUEMENT les langues actives, dans l'ordre
 *  fourni (display_order = position dans le tableau). Refuse si la
 *  langue source n'y figure pas, si une langue n'appartient pas au
 *  catalogue supported_languages, ou en cas de doublon. */
export async function updateRestaurantLanguages(
  restaurantId: string,
  languageCodes: string[]
): Promise<void> {
  const { error } = await supabase.rpc("update_restaurant_languages", {
    p_restaurant_id: restaurantId,
    p_language_codes: languageCodes,
  });
  if (error) throw new Error(error.message);
}

/** LOT 1A — catalogue complet des langues supportées par Scanym
 *  (distinct des langues ACTIVES d'un établissement précis). */
export async function getSupportedLanguages(): Promise<
  Array<{ code: string; label: string; dir: "ltr" | "rtl" }>
> {
  const { data, error } = await supabase
    .from("supported_languages")
    .select("code, label, dir")
    .order("display_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ code: string; label: string; dir: "ltr" | "rtl" }>;
}

/** LOT 1A — langues actives de CET établissement, ordonnées. Utilisé
 *  par le Dashboard pour peupler l'éditeur de langues ; la carte
 *  publique lit directement restaurant_active_languages (lecture
 *  publique, voir app/r/[slug]). */
export async function getRestaurantActiveLanguages(
  restaurantId: string
): Promise<Array<{ code: string; label: string; dir: "ltr" | "rtl"; display_order: number }>> {
  const { data, error } = await supabase.rpc("get_restaurant_active_languages", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ code: string; label: string; dir: "ltr" | "rtl"; display_order: number }>;
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
