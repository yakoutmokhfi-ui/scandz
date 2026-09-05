import { supabase } from "@/lib/supabase";
import type { RestaurantFull, MenuCategory, MenuSubcategory, RestaurantActiveLanguage } from "@/lib/types";
import { compareMenuItemsForPublicDisplay } from "@/lib/catalogue-subcategory-grouping";

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
        menu_subcategories ( id, category_id, name, display_order ),
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
  //
  // CATALOGUE / SUBCATEGORIES v1 -- menu_items reste un tableau PLAT
  // par catégorie (aucun changement de forme pour MenuView/le panier/
  // la résolution d'options, tous keyés par item.id) ; seul l'ORDRE et
  // les champs `subcategory_name`/`subcategory_display_order` résolus
  // changent.
  //
  // v1.1 -- remédiation CAT-SUB-V1-PUBLIC-GROUPING-01 (audit Work) :
  // le tri utilise désormais compareMenuItemsForPublicDisplay (lib/
  // catalogue-subcategory-grouping.ts), un ORDRE TOTAL déterministe qui
  // ne départage jamais 2 sous-catégories DIFFÉRENTES par un champ
  // produit -- l'ancien comparateur ad hoc ci-dessous retombait sur le
  // display_order du PRODUIT quand 2 sous-catégories partageaient le
  // même display_order, entrelaçant leurs produits (ex. A1, B2, A3, B4)
  // au lieu de garder chaque sous-catégorie contiguë. Pour un
  // commerçant sans sous-catégorie, ce tri redevient exactement le tri
  // historique par display_order (voir tests/v139-catalogue-public-
  // grouping-order.test.ts).
  const prepared: MenuCategory[] = (data.menu_categories ?? [])
    .sort((a: MenuCategory, b: MenuCategory) => a.display_order - b.display_order)
    .map((c: MenuCategory) => {
      const subcategoriesById = new Map<string, MenuSubcategory>(
        (c.menu_subcategories ?? []).map((s) => [s.id, s])
      );
      const menu_items = (c.menu_items ?? [])
        // Un produit archivé quitte la carte publique ; un produit
        // simplement indisponible aussi, mais il reste restaurable
        // d'un geste par le commerçant.
        .filter((i) => i.is_available && !i.archived_at)
        .map((i) => {
          const sub = i.subcategory_id ? subcategoriesById.get(i.subcategory_id) : undefined;
          return {
            ...i,
            subcategory_name: sub?.name ?? null,
            subcategory_display_order: sub?.display_order ?? null,
          };
        })
        .sort(compareMenuItemsForPublicDisplay);
      return { ...c, menu_items };
    })
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
