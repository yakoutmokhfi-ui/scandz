/**
 * Scanym — CATALOGUE PRODUCT REORDER v1.
 * Logique PURE du réordonnancement des produits (Monter / Descendre) :
 * aucun accès réseau, aucune écriture, aucun état, aucune mutation des
 * données reçues.
 *
 * ------------------------------------------------------------------
 * PÉRIMÈTRE D'ORDRE (mandat « FUNCTIONAL RULE »)
 * ------------------------------------------------------------------
 *   1. le produit appartient à une sous-catégorie -> il se réordonne
 *      parmi les produits de CETTE sous-catégorie ;
 *   2. sinon -> parmi les produits rattachés DIRECTEMENT à sa
 *      catégorie.
 * Ce sont exactement les deux paniers que construit déjà
 * `getMerchantCatalogue` (`CatalogueSubcategory.products` /
 * `CatalogueCategory.products`) et le groupe que la carte client
 * affiche d'un bloc. Un déplacement ne change JAMAIS de panier : ce lot
 * change un ORDRE, pas une taxonomie.
 *
 * ------------------------------------------------------------------
 * UN SEUL COMPARATEUR
 * ------------------------------------------------------------------
 * L'ordre « persisté » d'un périmètre est celui de la carte client :
 * `compareProductsWithinDisplayGroup` (display_order, nom normalisé,
 * id), le comparateur que `compareMenuItemsForPublicDisplay` applique
 * lui-même. Le back-office affiche cet ordre, et c'est CETTE vue
 * affichée qu'il transmet au serveur (`p_expected_scope` de
 * `move_product_order`). Pour un catalogue historique dont plusieurs
 * produits partagent le même display_order, le premier déplacement
 * matérialise donc exactement l'ordre que le client voyait déjà, plus
 * le seul échange demandé.
 *
 * ------------------------------------------------------------------
 * FRAÎCHEUR DE LA VUE (remédiation CPR-AUDIT-01)
 * ------------------------------------------------------------------
 * La vue transmise n'est pas une simple liste d'identifiants : c'est,
 * pour chaque produit du périmètre et dans l'ordre affiché, le triplet
 * `{ id, display_order, name }` -- TOUS les champs dont dépend l'ordre
 * visible (appartenance, display_order, et les deux champs de
 * départage du comparateur : nom, id). Ces valeurs sont celles que le
 * serveur a fournies avec le catalogue ; ce module les recopie telles
 * quelles, sans les normaliser, les hacher ni les recalculer. Le
 * serveur les compare sous verrou à l'état stocké et refuse le
 * moindre écart (`SCANYM_PRODUCT_ORDER_STALE`) : une vue périmée ne
 * peut plus imposer son ordre, même entre ex æquo.
 *
 * ------------------------------------------------------------------
 * MÊME RÉSULTAT QUE LE SERVEUR
 * ------------------------------------------------------------------
 * `applyProductMove` reproduit localement ce que la RPC écrit quand
 * elle accepte un déplacement : les deux voisins sont échangés et le
 * périmètre est renuméroté en positions denses 1..N. L'écran peut ainsi
 * refléter le déplacement sans recharger tout le catalogue (donc sans
 * faire disparaître la liste ni perdre le focus clavier) ; un
 * rechargement ultérieur redonne le même ordre.
 */
import type { CatalogueCategory, CatalogueProduct } from "@/lib/services/dashboard";
import { compareProductsWithinDisplayGroup } from "@/lib/catalogue-subcategory-grouping";
import { CATALOGUE_ORDER_SORT, type CatalogueFilters } from "@/lib/catalogue-management/filtering";

export type ProductMoveDirection = "up" | "down";

/** Champs d'un produit dont dépend son ordre. */
type OrderedProduct = Pick<CatalogueProduct, "product_id" | "name" | "display_order">;

/**
 * Produits d'UN périmètre, dans l'ordre PERSISTÉ -- celui de la carte
 * client. Retourne un nouveau tableau ; ne mute jamais celui reçu.
 */
export function orderProductsForCatalogue<T extends OrderedProduct>(products: ReadonlyArray<T>): T[] {
  return [...products].sort((a, b) =>
    compareProductsWithinDisplayGroup(
      { id: a.product_id, name: a.name, display_order: a.display_order },
      { id: b.product_id, name: b.name, display_order: b.display_order }
    )
  );
}

/**
 * Un produit du périmètre tel que le serveur l'a fourni : les TROIS
 * champs dont dépend l'ordre visible. Mêmes noms de clés que ceux lus
 * par `move_product_order` dans `p_expected_scope`.
 */
export interface ProductOrderScopeEntry {
  id: string;
  display_order: number;
  name: string;
}

/** Périmètre d'ordre d'un produit, et son contenu dans l'ordre persisté. */
export interface ProductOrderScope {
  categoryId: string;
  /** `null` = produits rattachés directement à la catégorie. */
  subcategoryId: string | null;
  /** Identifiants des produits NON ARCHIVÉS du périmètre, dans l'ordre
   *  persisté. */
  orderedIds: string[];
  /** La même liste, dans le même ordre, avec pour chaque produit les
   *  valeurs reçues du serveur (`display_order`, `name`). C'est la
   *  valeur à transmettre telle quelle comme `p_expected_scope` : la
   *  preuve de fraîcheur de la vue. */
  expected: ProductOrderScopeEntry[];
}

function scopeProducts(products: ReadonlyArray<CatalogueProduct>): CatalogueProduct[] {
  return orderProductsForCatalogue(products.filter((p) => !p.archived_at));
}

function scopeIds(products: ReadonlyArray<CatalogueProduct>): string[] {
  return scopeProducts(products).map((p) => p.product_id);
}

/** Recopie STRICTE des valeurs reçues du serveur : aucune
 *  normalisation, aucun recalcul. */
function scopeEntries(products: ReadonlyArray<CatalogueProduct>): ProductOrderScopeEntry[] {
  return scopeProducts(products).map((p) => ({
    id: p.product_id,
    display_order: p.display_order,
    name: p.name,
  }));
}

/**
 * Retrouve le périmètre d'ordre du produit donné. `null` si le produit
 * est absent du catalogue chargé ou archivé (un produit archivé n'a pas
 * de position sur la carte, il ne se réordonne pas).
 */
export function findProductOrderScope(
  categories: ReadonlyArray<CatalogueCategory>,
  productId: string
): ProductOrderScope | null {
  for (const category of categories) {
    if ((category.products ?? []).some((p) => p.product_id === productId && !p.archived_at)) {
      return {
        categoryId: category.category_id,
        subcategoryId: null,
        orderedIds: scopeIds(category.products ?? []),
        expected: scopeEntries(category.products ?? []),
      };
    }
    for (const sub of category.subcategories ?? []) {
      if ((sub.products ?? []).some((p) => p.product_id === productId && !p.archived_at)) {
        return {
          categoryId: category.category_id,
          subcategoryId: sub.subcategory_id,
          orderedIds: scopeIds(sub.products ?? []),
          expected: scopeEntries(sub.products ?? []),
        };
      }
    }
  }
  return null;
}

/** Position d'un produit dans son périmètre d'ordre. */
export interface ProductOrderPosition {
  /** 1 = premier du périmètre. */
  position: number;
  /** Nombre de produits non archivés du périmètre. */
  total: number;
}

/**
 * Position de CHAQUE produit non archivé du catalogue dans son propre
 * périmètre, calculée une fois par rendu (plutôt qu'une recherche de
 * périmètre par ligne affichée). C'est ce qui décide si Monter ou
 * Descendre est proposé : `position === 1` ne monte pas,
 * `position === total` ne descend pas.
 */
export function productOrderPositions(
  categories: ReadonlyArray<CatalogueCategory>
): Map<string, ProductOrderPosition> {
  const positions = new Map<string, ProductOrderPosition>();
  const register = (products: ReadonlyArray<CatalogueProduct>) => {
    const ids = scopeIds(products);
    ids.forEach((id, index) => positions.set(id, { position: index + 1, total: ids.length }));
  };
  for (const category of categories) {
    register(category.products ?? []);
    for (const sub of category.subcategories ?? []) register(sub.products ?? []);
  }
  return positions;
}

/**
 * Le déplacement est-il possible ? Le PREMIER produit d'un périmètre ne
 * monte pas, le DERNIER ne descend pas, un produit absent ne bouge pas.
 */
export function canMoveProduct(
  orderedIds: ReadonlyArray<string>,
  productId: string,
  direction: ProductMoveDirection
): boolean {
  const index = orderedIds.indexOf(productId);
  if (index < 0) return false;
  return direction === "up" ? index > 0 : index < orderedIds.length - 1;
}

/**
 * Nouvel ordre après échange du produit avec son voisin immédiat.
 * `null` si le déplacement est impossible (borne, produit absent).
 * Ne mute jamais la liste reçue.
 */
export function moveProductInOrder(
  orderedIds: ReadonlyArray<string>,
  productId: string,
  direction: ProductMoveDirection
): string[] | null {
  if (!canMoveProduct(orderedIds, productId, direction)) return null;
  const index = orderedIds.indexOf(productId);
  const target = direction === "up" ? index - 1 : index + 1;
  const next = [...orderedIds];
  next[index] = orderedIds[target];
  next[target] = orderedIds[index];
  return next;
}

/** Résultat local d'un déplacement accepté. */
export interface AppliedProductMove {
  categories: CatalogueCategory[];
  /** Nouvelle position du produit dans son périmètre (1 = premier). */
  position: number;
  /** Nombre de produits non archivés du périmètre. */
  total: number;
}

/**
 * Applique LOCALEMENT un déplacement, exactement comme
 * `move_product_order` l'écrit en base : échange des deux voisins,
 * puis display_order = position (1..N) pour chaque produit non archivé
 * du périmètre. Le panier est rendu dans son nouvel ordre.
 *
 * Seul le périmètre du produit est reconstruit ; les autres catégories
 * et sous-catégories sont reprises PAR RÉFÉRENCE, intactes. Rien n'est
 * muté. `null` si le déplacement est impossible.
 */
export function applyProductMove(
  categories: ReadonlyArray<CatalogueCategory>,
  productId: string,
  direction: ProductMoveDirection
): AppliedProductMove | null {
  const scope = findProductOrderScope(categories, productId);
  if (!scope) return null;
  const nextIds = moveProductInOrder(scope.orderedIds, productId, direction);
  if (!nextIds) return null;

  const positionById = new Map(nextIds.map((id, index) => [id, index + 1]));

  const rebuild = (products: ReadonlyArray<CatalogueProduct>): CatalogueProduct[] => {
    const moved = products
      .filter((p) => positionById.has(p.product_id))
      .map((p) => {
        const position = positionById.get(p.product_id) as number;
        return p.display_order === position ? p : { ...p, display_order: position };
      })
      .sort((a, b) => a.display_order - b.display_order);
    // Un produit archivé n'appartient pas au périmètre réordonné : il
    // est conservé tel quel, après les produits de la carte.
    const untouched = products.filter((p) => !positionById.has(p.product_id));
    return [...moved, ...untouched];
  };

  const nextCategories = categories.map((category) => {
    if (category.category_id !== scope.categoryId) return category;
    if (scope.subcategoryId === null) {
      return { ...category, products: rebuild(category.products ?? []) };
    }
    return {
      ...category,
      subcategories: (category.subcategories ?? []).map((sub) =>
        sub.subcategory_id === scope.subcategoryId ? { ...sub, products: rebuild(sub.products ?? []) } : sub
      ),
    };
  });

  return {
    categories: nextCategories,
    position: positionById.get(productId) as number,
    total: nextIds.length,
  };
}

/**
 * L'écran affiche-t-il CHAQUE périmètre en entier, dans l'ordre
 * persisté ? C'est la condition pour proposer Monter / Descendre : le
 * voisin avec lequel un produit s'échange doit être celui que le
 * marchand voit juste au-dessus ou juste en dessous.
 *
 *   - tri « ordre de la carte » ;
 *   - aucun critère qui masque des produits À L'INTÉRIEUR d'un
 *     périmètre : recherche, tag, disponibilité, rétractable.
 *
 * Les filtres catégorie / sous-catégorie restent permis : ils masquent
 * des périmètres ENTIERS, jamais une partie d'un périmètre.
 */
export function isReorderableView(filters: CatalogueFilters): boolean {
  return (
    filters.sort === CATALOGUE_ORDER_SORT &&
    filters.search.trim() === "" &&
    filters.tagId === null &&
    filters.available === null &&
    filters.withdrawalEligible === null
  );
}
