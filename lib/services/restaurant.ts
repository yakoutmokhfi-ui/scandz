import { supabase } from "@/lib/supabase";
import type { RestaurantFull, MenuCategory } from "@/lib/types";

/**
 * Service unique d'accès aux données du restaurant.
 * Règle d'architecture : le frontend ne dialogue jamais directement
 * avec Supabase, tout passe par ce service.
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
        id, restaurant_id, name, display_order, is_active,
        menu_items ( * )
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
  const categories: MenuCategory[] = (data.menu_categories ?? [])
    .filter((c: MenuCategory) => c.is_active)
    .sort((a: MenuCategory, b: MenuCategory) => a.display_order - b.display_order)
    .map((c: MenuCategory) => ({
      ...c,
      menu_items: (c.menu_items ?? [])
        .filter((i) => i.is_available)
        .sort((a, b) => a.display_order - b.display_order),
    }))
    .filter((c: MenuCategory) => c.menu_items.length > 0);

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
  };
}
