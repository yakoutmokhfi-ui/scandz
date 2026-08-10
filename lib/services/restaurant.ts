import { supabase } from "@/lib/supabase";
import type { RestaurantFull, MenuCategory } from "@/lib/types";

/**
 * Service unique d'accès aux données du restaurant.
 * Règle d'architecture : le frontend ne dialogue jamais directement
 * avec Supabase, tout passe par ce service.
 *
 * NOTE : menu_items est lié DEUX FOIS à menu_categories, par
 * category_id et par option_source_category_id (ajoutée pour les
 * options). Le nom de la contrainte doit donc être précisé, sans
 * quoi Supabase répond « more than one relationship was found ».
 */
export async function getRestaurantBySlug(
  slug: string
): Promise<RestaurantFull | null> {
  const { data, error } = await supabase
    .from("restaurants")
    .select(
      `
      id, name, slug, is_active, created_at,
      restaurant_configs ( * ),
      menu_categories (
        *,
        menu_items!menu_items_category_id_fkey ( * )
      )
    `
    )
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("getRestaurantBySlug:", error.message);
    return null;
  }
  if (!data || !data.restaurant_configs) {
    return null;
  }

  // Filtrage et tri côté service pour garder des composants
  // de présentation purs.
  const prepared: MenuCategory[] = (data.menu_categories ?? [])
    .sort((a: MenuCategory, b: MenuCategory) => a.display_order - b.display_order)
    .map((c: MenuCategory) => ({
      ...c,
      menu_items: (c.menu_items ?? [])
        // Un produit archivé quitte la carte publique ; un produit
        // simplement indisponible aussi, mais il reste restaurable
        // d'un geste par le commerçant.
        .filter((i) => i.is_available && !i.archived_at)
        .sort((a, b) => a.display_order - b.display_order),
    }))
    .filter((c: MenuCategory) => c.menu_items.length > 0);

  // Une catégorie inactive n'apparaît pas au menu, mais reste
  // disponible comme réservoir de choix (goûts, pâtisseries…).
  const categories = prepared.filter((c) => c.is_active);
  const hiddenCategories = prepared.filter((c) => !c.is_active);

  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    is_active: data.is_active,
    created_at: data.created_at,
    config: Array.isArray(data.restaurant_configs)
      ? data.restaurant_configs[0]
      : data.restaurant_configs,
    categories,
    hiddenCategories,
  };
}
