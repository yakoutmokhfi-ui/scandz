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
  /** LOT 1A — nom affiché de l'établissement sur la carte publique.
   *  NULL = repli sur Restaurant.name (comportement V79 inchangé).
   *  Jamais traduit (décision CIO) : identique dans toutes les langues. */
  display_name?: string | null;
  /** LOT 1A — texte de présentation multiligne, langue source
   *  uniquement. Traductions : Sous-lot B, pas encore livré. */
  intro_text?: string | null;
  /** LOT 1A — message temporaire/actualité, langue source uniquement.
   *  Voir announcement_active pour l'état affiché/masqué. */
  announcement_text?: string | null;
  /** LOT 1A — bascule affiché/masqué du message temporaire,
   *  indépendante du contenu : le texte n'est jamais supprimé/recréé. */
  announcement_active?: boolean;
  /** LOT 1A — couleur de fond personnalisée, #RRGGBB. NULL = fond du
   *  thème par défaut (lib/themes.ts), rendu V79 strictement inchangé. */
  bg_color?: string | null;
  /** LOT 1A — réseaux sociaux, un champ par réseau. Validés serveur
   *  (HTTPS strict, domaine exact) par update_restaurant_social_links.
   *  NULL = icône non affichée sur la carte publique. */
  instagram_url?: string | null;
  tiktok_url?: string | null;
  facebook_url?: string | null;
  /** LOT 1A — langue source du contenu de cet établissement. Colonne
   *  héritée de Lot D (migration-lotd-establishment-creation.sql),
   *  dont la contrainte figée fr/en/ar est remplacée par une
   *  référence au catalogue supported_languages. FR par défaut :
   *  comportement V79 inchangé. Changement après création : Sous-lot
   *  C, pas encore livré. */
  source_language?: string;
  /** LOT 1B — traductions de intro_text/announcement_text, même
   *  format/mécanisme que menu_categories/menu_items.translations. */
  translations?: Translations;
  /** LOT 1B — hash canonique, colonnes GÉNÉRÉES par PostgreSQL. */
  intro_text_hash?: string;
  announcement_text_hash?: string;
}

/** LOT 1A — une langue du catalogue Scanym (supported_languages),
 *  distincte des langues ACTIVES d'un établissement donné (voir
 *  RestaurantActiveLanguage) — ne jamais confondre les deux. */
export interface SupportedLanguage {
  code: string;
  label: string;
  dir: "ltr" | "rtl";
  display_order: number;
}

/** LOT 1A — une langue active pour CET établissement précis, dans
 *  l'ordre d'affichage choisi par le commerçant. */
export interface RestaurantActiveLanguage {
  code: string;
  label: string;
  dir: "ltr" | "rtl";
  display_order: number;
}

/**
 * Corrige L1A-04 (contre-audit Work, tour 1A.1) : logique pure de
 * réordonnancement des langues actives, extraite pour être testable
 * indépendamment du rendu Dashboard (voir tests/v80-lot1a1-language-order.test.ts).
 * Échange la position de `code` avec son voisin immédiat selon
 * `direction` (-1 = monter, +1 = descendre) ; no-op si le mouvement
 * sortirait du tableau. Ne modifie jamais le tableau reçu (retourne
 * une copie).
 */
export function moveLanguageInList(
  codes: readonly string[],
  code: string,
  direction: -1 | 1
): string[] {
  const index = codes.indexOf(code);
  const newIndex = index + direction;
  if (index < 0 || newIndex < 0 || newIndex >= codes.length) {
    return [...codes];
  }
  const next = [...codes];
  [next[index], next[newIndex]] = [next[newIndex], next[index]];
  return next;
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
  /** LOT 1B — hash canonique de name/description, colonnes GÉNÉRÉES
   *  par PostgreSQL (jamais recalculées côté client). Comparer ces
   *  valeurs à translations[lang].<field>_source_hash détermine la
   *  fraîcheur d'une traduction (voir lib/translation-resolver.ts). */
  name_hash?: string;
  description_hash?: string;
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
  /** LOT 1B — hash canonique, colonnes GÉNÉRÉES par PostgreSQL. */
  name_hash?: string;
  short_description_hash?: string;
  description_hash?: string;
  /** CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.1 — voir
   *  lib/catalogue-fiscal.ts pour le modèle complet. Modèle SIMPLIFIÉ
   *  portion-à-prix-fixe : `price` reste l'unique autorité de prix
   *  (inchangée), le poids est purement informationnel/logistique et
   *  ne participe JAMAIS à un calcul de prix. Optionnelles : colonnes
   *  absentes tant que la migration n'est pas jouée (même convention
   *  que `translations` ci-dessus). */
  tax_rate?: number | null;
  unit_weight_grams?: number | null;
  weight_is_approximate?: boolean;
  /** Colonne GÉNÉRÉE côté base (price / unit_weight_grams) —
   *  métadonnée de référence uniquement, jamais une autorité. */
  reference_price_per_kg?: number | null;
}

// Objet complet renvoyé par getRestaurantBySlug
export interface RestaurantFull extends Restaurant {
  config: RestaurantConfig;
  /** Catégories affichées au menu */
  categories: MenuCategory[];
  /** Catégories masquées (is_active = false) : réservoirs de choix */
  hiddenCategories: MenuCategory[];
  /** LOT 1A — langues actives de cet établissement, ordonnées
   *  (display_order). Jamais vide en pratique (au moins la langue
   *  source) ; un tableau vide est traité comme repli sur ['fr'] par
   *  le composant (voir LanguageSelector). */
  activeLanguages: RestaurantActiveLanguage[];
}
