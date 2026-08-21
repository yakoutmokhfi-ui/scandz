// Types alignés sur le schéma canonique (docs/DATABASE.md).
// Ne pas modifier sans validation Yakout + revue CTO.

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
}

export interface RestaurantConfig {
  restaurant_id: string;
  max_tables: number;
  currency: string;
  whatsapp_number: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  logo_url: string | null;
  /** Photo de couverture de la carte publique (V68). Colonne additive :
   *  absente/`null` pour tout établissement existant tant qu'il n'a
   *  pas été renseigné explicitement — jamais déduite de logo_url. */
  cover_url?: string | null;
  opening_hours: string | null;
  /** Langue du ticket destiné au personnel (V39) */
  staff_receipt_language?: string | null;
  /** Couleurs personnalisées (V69), format strict #RRGGBB. Colonnes
   *  additives : absentes/`null` pour tout établissement existant tant
   *  qu'un commerçant ne les a pas renseignées — le rendu retombe
   *  alors intégralement sur le thème Scanym choisi (lib/themes.ts),
   *  sans aucun changement visuel. */
  primary_color?: string | null;
  secondary_color?: string | null;
  accent_color?: string | null;
  /** Lien externe de localisation/itinéraire fourni par le commerçant
   *  (V69, corrigé V70 : nom de colonne indépendant du fournisseur,
   *  voir migration-v70-identity-corrections.sql). N'importe quel lien
   *  https public (Google Maps, un raccourcisseur, un futur fournisseur
   *  RNA…) : Scanym ne dépend structurellement d'aucun fournisseur de
   *  cartographie. Colonne additive/nullable : absente = pas de CTA
   *  "Itinéraire" sur la carte publique — corrige V70-06 (V71) :
   *  latitude/longitude ne sont plus utilisées pour fabriquer un lien
   *  Google implicite en repli ; elles restent des données neutres. */
  maps_url?: string | null;
}

export interface Translations {
  [lang: string]: { name?: string; description?: string; short_description?: string } | undefined;
}

export interface MenuCategory {
  id: string;
  restaurant_id: string;
  name: string;
  display_order: number;
  is_active: boolean;
  /** Description longue de catégorie (V67b), optionnelle. Colonne
   *  additive : absente/`null` pour toute catégorie existante tant
   *  qu'un commerçant ne l'a pas renseignée explicitement — jamais
   *  déduite ou migrée automatiquement depuis une autre donnée. */
  description?: string | null;
  /** Colonne optionnelle : absente tant que la migration n'est pas jouée */
  translations?: Translations;
  menu_items: MenuItem[];
}

export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  /** Description courte (V66), affichée directement sur la fiche/carte. */
  short_description: string | null;
  price: number;
  image_url: string | null;
  display_order: number;
  is_available: boolean;
  /** Renseigné quand le produit a été retiré de la carte (V31) */
  archived_at?: string | null;
  /** Colonne optionnelle : absente tant que la migration n'est pas jouée */
  translations?: Translations;
}

// Objet complet renvoyé par getRestaurantBySlug
export interface RestaurantFull extends Restaurant {
  config: RestaurantConfig;
  /** Catégories affichées au menu */
  categories: MenuCategory[];
  /** Catégories masquées (is_active = false) : réservoirs de choix */
  hiddenCategories: MenuCategory[];
}
