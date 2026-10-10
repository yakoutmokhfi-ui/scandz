/**
 * Scanym — CATALOGUE PRODUCT REORDER v1.
 * Service d'écriture de l'ordre des produits (Monter / Descendre).
 *
 * UNIQUE point d'appel de la RPC `move_product_order`
 * (supabase/DRAFT-lot-catalogue-product-reorder-v1.sql). Module dédié,
 * volontairement séparé de lib/services/dashboard.ts : ce lot n'ajoute
 * aucun export à ce dernier.
 *
 * AUTORITÉ : entièrement côté serveur. La RPC dérive l'établissement
 * du produit ciblé (assert_product_role : owner/manager, ou opérateur
 * Scanym) -- aucun identifiant d'établissement n'est transmis, et rien
 * de ce que ce module envoie ne permet de viser le produit d'un autre
 * marchand : un identifiant étranger dans `expectedScope` fait échouer
 * l'appel entier (SCANYM_PRODUCT_ORDER_STALE), sans aucune écriture.
 *
 * FRAÎCHEUR (remédiation CPR-AUDIT-01) : ce module transmet la vue
 * affichée SANS LA TRANSFORMER -- pour chaque produit du périmètre,
 * les valeurs `{ id, display_order, name }` reçues du serveur. C'est
 * le serveur, sous verrou, qui décide si cette vue est encore l'état
 * stocké. Aucune empreinte n'est calculée ici : rien, côté client, ne
 * peut donc diverger de la sérialisation du serveur.
 *
 * Aucune écriture directe sur `menu_items` : le client n'en a pas le
 * droit (RLS, aucun GRANT) et ce module ne s'y essaie pas.
 */
import { supabase } from "@/lib/supabase";
import type { ProductMoveDirection, ProductOrderScopeEntry } from "@/lib/catalogue-product-order";

/** Mêmes constantes EXACTES que les `raise exception ... message = '...'`
 *  de move_product_order. Classification stricte sur le COUPLE
 *  SQLSTATE + message (même discipline que lib/services/
 *  catalogue-error.ts), jamais sur le code seul. */
export const PRODUCT_ORDER_STALE_CODE = "SCANYM_PRODUCT_ORDER_STALE";
export const PRODUCT_ORDER_STALE_SQLSTATE = "P0001";
export const PRODUCT_ORDER_BOUNDARY_CODE = "SCANYM_PRODUCT_ORDER_BOUNDARY";
export const PRODUCT_ORDER_BOUNDARY_SQLSTATE = "22023";

/**
 * La vue affichée n'est plus l'état de la base (autre onglet, autre
 * utilisateur, produit créé, archivé, déplacé, renommé ou renuméroté
 * entre-temps). Rien n'a été écrit : l'écran doit recharger le
 * catalogue avant tout nouvel essai.
 */
export class ProductOrderStaleError extends Error {
  constructor() {
    super(PRODUCT_ORDER_STALE_CODE);
    this.name = "ProductOrderStaleError";
  }
}

/** Le premier produit ne monte pas, le dernier ne descend pas. Rien
 *  n'a été écrit. */
export class ProductOrderBoundaryError extends Error {
  constructor() {
    super(PRODUCT_ORDER_BOUNDARY_CODE);
    this.name = "ProductOrderBoundaryError";
  }
}

/** Classe une erreur RPC de move_product_order. Pure, exportée pour
 *  être testée sans Supabase. */
export function classifyProductOrderError(error: {
  code?: string | null;
  message?: string | null;
}): Error {
  const message = error.message ?? "";
  if (error.code === PRODUCT_ORDER_STALE_SQLSTATE && message.includes(PRODUCT_ORDER_STALE_CODE)) {
    return new ProductOrderStaleError();
  }
  if (error.code === PRODUCT_ORDER_BOUNDARY_SQLSTATE && message.includes(PRODUCT_ORDER_BOUNDARY_CODE)) {
    return new ProductOrderBoundaryError();
  }
  return new Error(message);
}

/**
 * Déplace un produit d'UNE position dans son périmètre (sa
 * sous-catégorie, sinon les produits directs de sa catégorie).
 *
 * @param productId     produit à déplacer
 * @param direction     "up" (vers le début) ou "down" (vers la fin)
 * @param expectedScope vue AFFICHÉE avant le déplacement : tous les
 *                      produits non archivés du périmètre, dans l'ordre
 *                      affiché, avec les valeurs reçues du serveur
 *                      (`ProductOrderScope.expected`)
 * @returns la nouvelle position du produit (1 = premier)
 */
export async function moveProductOrder(
  productId: string,
  direction: ProductMoveDirection,
  expectedScope: ReadonlyArray<ProductOrderScopeEntry>
): Promise<number> {
  const { data, error } = await supabase.rpc("move_product_order", {
    p_product_id: productId,
    p_direction: direction,
    // Recopie des TROIS champs du contrat, dans l'ordre reçu : aucune
    // autre propriété de l'objet appelant ne part sur le réseau.
    p_expected_scope: expectedScope.map((entry) => ({
      id: entry.id,
      display_order: entry.display_order,
      name: entry.name,
    })),
  });
  if (error) throw classifyProductOrderError(error);
  return Number(data);
}
