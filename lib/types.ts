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
  opening_hours: string | null;
}

export interface MenuCategory {
  id: string;
  restaurant_id: string;
  name: string;
  display_order: number;
  is_active: boolean;
  menu_items: MenuItem[];
}

export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  display_order: number;
  is_available: boolean;
}

// Objet complet renvoyé par getRestaurantBySlug
export interface RestaurantFull extends Restaurant {
  config: RestaurantConfig;
  categories: MenuCategory[];
}
