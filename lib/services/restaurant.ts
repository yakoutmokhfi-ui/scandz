import { supabase } from "@/lib/supabase";
import type { RestaurantFull, MenuCategory, RestaurantActiveLanguage } from "@/lib/types";

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
      ),
      restaurant_active_languages (
        language_code, display_order,
        supported_languages ( code, label, dir )
      )
    `
    )
    .eq("slug", slug)
    .eq("is_active", true)
    // Corrige la décision produit tranchée après l'audit Work (Lot D) :
    // un établissement dont le cycle de vie n'est pas 'active'
    // (onboarding, suspended, inactive) n'est JAMAIS accessible
    // publiquement, même en connaissant son slug exact. is_active
    // (bascule manuelle préexistante) et status (cycle de vie Lot D)
    // sont deux mécanismes distincts, TOUS DEUX requis : is_active
    // reste la bascule d'urgence déjà utilisée, status protège
    // spécifiquement les établissements en cours d'intégration.
    .eq("status", "active")
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

  // LOT 1A — langues actives, ordonnées. Chaque ligne jointe porte à
  // la fois la position (restaurant_active_languages.display_order)
  // et le libellé/sens d'écriture (supported_languages, catalogue
  // Scanym) -- deux tables distinctes, jamais confondues (voir
  // lib/types.ts). Repli défensif sur ['fr'] si, par anomalie, aucune
  // ligne n'existe (ne devrait jamais arriver après LOT 1A : chaque
  // établissement a au moins sa langue source insérée).
  type RawActiveLanguageRow = {
    display_order: number;
    supported_languages: { code: string; label: string; dir: "ltr" | "rtl" } | { code: string; label: string; dir: "ltr" | "rtl" }[] | null;
  };
  const rawActiveLanguages = (data.restaurant_active_languages ?? []) as RawActiveLanguageRow[];
  const activeLanguages: RestaurantActiveLanguage[] = rawActiveLanguages
    .map((row) => {
      const sl = Array.isArray(row.supported_languages) ? row.supported_languages[0] : row.supported_languages;
      if (!sl) return null;
      return { code: sl.code, label: sl.label, dir: sl.dir, display_order: row.display_order };
    })
    .filter((x): x is RestaurantActiveLanguage => x !== null)
    .sort((a, b) => a.display_order - b.display_order);

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
    activeLanguages: activeLanguages.length > 0 ? activeLanguages : [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
  };
}
