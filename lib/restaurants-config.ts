import type { MenuItem, RestaurantFull } from "@/lib/types";

/**
 * Réglages par établissement qui ne tiennent pas encore dans le
 * modèle de données.
 *
 * ⚠️ DETTE TECHNIQUE ASSUMÉE — à soumettre au CTO.
 * Ces réglages devraient vivre en base. Ils sont ici pour livrer le
 * deuxième pilote sans modifier le schéma sans validation.
 * Évolution proposée pour la V1 :
 *   • restaurant_configs.service_mode      ('table' | 'fulfillment')
 *   • restaurant_configs.delivery_zones    (JSONB)
 *   • table option_groups + option_choices (choix de goût, de taille…)
 * Tant que ce fichier existe, ajouter un client impose un déploiement.
 */

export type ServiceMode = "table" | "fulfillment";

export interface DeliveryZone {
  code: string;
  label: string;
}

export interface OptionGroup {
  /** Titre affiché dans la fenêtre de choix */
  title: string;
  /** Nom (ou fragment) de la catégorie contenant les choix possibles */
  sourceCategory: string;
  /** Paliers de quantité proposés en un geste (facultatif) */
  quantityPresets?: number[];
}

export interface RestaurantSettings {
  serviceMode: ServiceMode;
  /**
   * Présentation des options : "modal" ouvre une fenêtre (adapté aux
   * cartes longues), "inline" affiche les goûts sur la carte produit
   * (adapté aux cartes très courtes).
   */
  optionsDisplay?: "modal" | "inline";
  /** Téléphone affiché sur la fiche (pas de colonne dédiée en base) */
  phone?: string;
  /** Retrait sur place proposé (mode fulfillment uniquement) */
  pickup?: boolean;
  /** Zones livrées (mode fulfillment uniquement) */
  deliveryZones?: DeliveryZone[];
  /** Nombre d'articles minimum pour bénéficier de la livraison */
  deliveryMinItems?: number;
  /** Libellé court de la zone couverte, pour les messages client */
  deliveryAreaLabel?: string;
  /** Produits imposant un choix avant ajout au panier, par nom exact */
  optionGroups?: Record<string, OptionGroup>;
}

const SETTINGS: Record<string, RestaurantSettings> = {
  "illico-presto": {
    serviceMode: "table",
    phone: "+213 41 55 12 34",
    optionGroups: {
      "Formule Prestigio": {
        title: "Choisissez votre pâtisserie",
        sourceCategory: "Pâtisseries",
      },
    },
  },
  "sanaa-cookies": {
    serviceMode: "fulfillment",
    optionsDisplay: "inline",
    phone: "06 60 27 31 54",
    pickup: true,
    // Toute l'Île-de-France. Le libellé par département est repris
    // dans le message WhatsApp pour situer la course.
    deliveryZones: [
      { code: "75", label: "Paris (75)" },
      { code: "77", label: "Seine-et-Marne (77)" },
      { code: "78", label: "Yvelines (78)" },
      { code: "91", label: "Essonne (91)" },
      { code: "92", label: "Hauts-de-Seine (92)" },
      { code: "93", label: "Seine-Saint-Denis (93)" },
      { code: "94", label: "Val-de-Marne (94)" },
      { code: "95", label: "Val-d'Oise (95)" },
    ],
    deliveryAreaLabel: "Île-de-France",
    deliveryMinItems: 10, // livraison offerte dès 10 gâteaux
    optionGroups: {
      Cookie: {
        title: "Choisissez votre goût",
        sourceCategory: "Goûts cookies",
        quantityPresets: [1, 3, 6, 10],
      },
      "Fondant au chocolat": {
        title: "Choisissez votre goût",
        sourceCategory: "Goûts fondants",
        quantityPresets: [1, 3, 6, 10],
      },
    },
  },
};

const DEFAULT_SETTINGS: RestaurantSettings = { serviceMode: "table" };

export function getSettings(slug: string): RestaurantSettings {
  return SETTINGS[slug] ?? DEFAULT_SETTINGS;
}

export function getOptionGroup(slug: string, item: MenuItem): OptionGroup | null {
  return getSettings(slug).optionGroups?.[item.name] ?? null;
}

/**
 * Choix proposés dans la fenêtre : lus dans la catégorie source, qu'elle
 * soit affichée au menu (pâtisseries d'Illico) ou masquée (goûts Sanaa).
 */
export function getChoices(
  restaurant: RestaurantFull,
  group: OptionGroup
): MenuItem[] {
  const category = [...restaurant.categories, ...restaurant.hiddenCategories].find(
    (c) => c.name.includes(group.sourceCategory)
  );
  return category?.menu_items ?? [];
}
