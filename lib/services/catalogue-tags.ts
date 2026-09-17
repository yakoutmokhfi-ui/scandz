/**
 * Scanym — CATALOGUE — COLLECTIONS / TAGS FOUNDATION v1.
 * Couche service IMPURE (RPC Supabase) des tags/collections.
 *
 * Ne réimplémente AUCUNE règle métier : chaque fonction est un appel
 * direct à la RPC SECURITY DEFINER correspondante, qui porte seule
 * l'autorisation (marchand owner/manager OU opérateur Scanym) et
 * l'isolation tenant. Aucune de ces fonctions ne décide qui a le
 * droit de faire quoi -- le serveur tranche, exactement comme pour
 * create_category / archive_product / reset_merchant_catalogue.
 *
 * TAG vs COLLECTION : une seule entité. Un tag devient une collection
 * quand `visibleOnCustomerMenu` passe à true. Il n'existe pas deux
 * taxonomies à synchroniser.
 */
import { supabase } from "@/lib/supabase";

/** Levée quand un tag de même nom normalisé existe déjà et est actif
 *  pour ce restaurant (SQLSTATE 23505 / SCANYM_TAG_DUPLICATE_NAME).
 *  Traitée par l'importateur comme un signal de CONVERGENCE, jamais
 *  comme une anomalie -- même patron que CategoryDuplicateNameError. */
export class TagDuplicateNameError extends Error {
  constructor() {
    super("Un tag portant ce nom existe déjà pour cet établissement.");
    this.name = "TagDuplicateNameError";
  }
}

/** Vue BACKOFFICE d'un tag (marchand/opérateur). */
export interface RestaurantTag {
  id: string;
  name: string;
  normalizedKey: string;
  visibleOnCustomerMenu: boolean;
  displayOrder: number;
  /** Produits non archivés portant ce tag -- informatif, jamais une
   *  autorisation ni un filtre. */
  productCount: number;
}

/** Contrat de lecture CLIENT (décision CTO §4). Une entrée par
 *  collection VISIBLE, ordonnée, avec ses produits AGRÉGÉS : jamais
 *  une ligne par produit × tag. */
export interface RestaurantCollection {
  id: string;
  label: string;
  displayOrder: number;
  menuItemIds: string[];
}

interface TagRow {
  id: string;
  name: string;
  normalized_key: string;
  visible_on_customer_menu: boolean;
  display_order: number;
  product_count: number;
}

interface CollectionRow {
  id: string;
  label: string;
  display_order: number;
  menu_item_ids: string[] | null;
}

function isDuplicateTagName(message: string): boolean {
  return message.includes("SCANYM_TAG_DUPLICATE_NAME");
}

/** Tous les tags ACTIFS du tenant, avec leur configuration de
 *  collection. Réservé au backoffice (marchand/opérateur). */
export async function getRestaurantTags(restaurantId: string): Promise<RestaurantTag[]> {
  const { data, error } = await supabase.rpc("get_restaurant_tags", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as TagRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    normalizedKey: r.normalized_key,
    visibleOnCustomerMenu: r.visible_on_customer_menu,
    displayOrder: r.display_order,
    productCount: r.product_count,
  }));
}

/** Création manuelle d'un tag (backoffice). Un tag ainsi créé n'est
 *  JAMAIS publié comme collection : la publication est une décision
 *  marchand distincte (updateTagCollectionSettings). */
export async function createTag(restaurantId: string, name: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_tag", {
    p_restaurant_id: restaurantId,
    p_name: name,
  });
  if (error) {
    if (isDuplicateTagName(error.message)) throw new TagDuplicateNameError();
    throw new Error(error.message);
  }
  return data as string;
}

/**
 * Associe des tags à un produit -- LE point d'entrée de l'importateur.
 *
 * Le serveur résout-ou-crée les tags canoniques du tenant PROPRIÉTAIRE
 * DU PRODUIT (jamais un restaurant_id fourni par l'appelant) puis
 * associe de façon idempotente, le tout dans une seule transaction.
 * Retourne le nombre d'associations RÉELLEMENT ajoutées : 0 signifie
 * « déjà à jour », jamais un échec.
 *
 * STRICTEMENT ADDITIF : n'enlève jamais une association existante --
 * un tag posé à la main en backoffice survit à tous les réimports.
 */
export async function addProductTags(
  menuItemId: string,
  tagNames: string[]
): Promise<number> {
  const { data, error } = await supabase.rpc("add_product_tags", {
    p_menu_item_id: menuItemId,
    p_tag_names: tagNames,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

/**
 * Publie / dépublie / ordonne une collection (backoffice).
 *
 * Dépublier ne supprime RIEN : ni le tag, ni ses associations produit,
 * ni la moindre catégorie/sous-catégorie/produit (décision CTO §6).
 * `displayOrder` omis = ordre actuel conservé.
 */
export async function updateTagCollectionSettings(
  tagId: string,
  visibleOnCustomerMenu: boolean,
  displayOrder?: number
): Promise<void> {
  const { error } = await supabase.rpc("update_tag_collection_settings", {
    p_tag_id: tagId,
    p_visible_on_customer_menu: visibleOnCustomerMenu,
    p_display_order: displayOrder ?? null,
  });
  if (error) throw new Error(error.message);
}

/**
 * Contrat de lecture tenant-safe destiné au futur menu client
 * (consommation UI : périmètre Claude Monet, aucun fichier client
 * touché par ce lot).
 *
 * Retourne uniquement les collections VISIBLES d'un établissement
 * publié, ordonnées, avec les identifiants produits nécessaires au
 * filtrage. Le filtrage de sécurité est intégralement serveur.
 */
export async function getRestaurantCollections(
  restaurantId: string
): Promise<RestaurantCollection[]> {
  const { data, error } = await supabase.rpc("get_restaurant_collections", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as CollectionRow[]).map((r) => ({
    id: r.id,
    label: r.label,
    displayOrder: r.display_order,
    menuItemIds: r.menu_item_ids ?? [],
  }));
}

/* ====================================================================
 * CATALOGUE MANAGEMENT UX v1 — deux ajouts au MÊME service, sur le
 * MÊME modèle (menu_tags / menu_item_tags). Aucun second modèle de
 * tags n'est introduit.
 * ==================================================================== */

/** Carte produit -> tags, vue BACKOFFICE. */
export interface ProductTags {
  menuItemId: string;
  tagIds: string[];
  tagNames: string[];
}

interface ProductTagsRow {
  menu_item_id: string;
  tag_ids: string[] | null;
  tag_names: string[] | null;
}

/**
 * Tous les tags de tous les produits du tenant, pour le backoffice.
 *
 * Distinct de `getRestaurantCollections`, qui est le contrat CLIENT :
 * celui-ci n'expose que les collections PUBLIÉES d'un établissement
 * publié, et seulement ses produits disponibles et non archivés. Le
 * marchand, lui, doit voir TOUS ses tags (publiés ou non) sur TOUS ses
 * produits -- sans quoi il ne peut ni les afficher ni filtrer dessus.
 *
 * Une ligne par produit, tags agrégés : aucune multiplication
 * produit × tag.
 */
export async function getRestaurantProductTags(restaurantId: string): Promise<ProductTags[]> {
  const { data, error } = await supabase.rpc("get_restaurant_product_tags", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ProductTagsRow[]).map((r) => ({
    menuItemId: r.menu_item_id,
    tagIds: r.tag_ids ?? [],
    tagNames: r.tag_names ?? [],
  }));
}

/**
 * Retire UNE association produit <-> tag.
 *
 * Ne supprime JAMAIS le tag lui-même : il reste disponible pour le
 * tenant et pour ses autres produits. Idempotente -- retirer une
 * association déjà absente retourne 0 sans erreur, donc un double clic
 * ou un retry réseau ne produit aucun échec visible. Retourne le
 * nombre d'associations réellement retirées (0 ou 1).
 */
export async function removeProductTag(menuItemId: string, tagId: string): Promise<number> {
  const { data, error } = await supabase.rpc("remove_product_tag", {
    p_menu_item_id: menuItemId,
    p_tag_id: tagId,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}
