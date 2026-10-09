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
 * marchand : un identifiant étranger dans `expectedOrder` fait échouer
 * l'appel entier (SCANYM_PRODUCT_ORDER_STALE), sans aucune écriture.
 *
 * Aucune écriture directe sur `menu_items` : le client n'en a pas le
 * droit (RLS, aucun GRANT) et ce module ne s'y essaie pas.
 */
import { supabase } from "@/lib/supabase";
import type { ProductMoveDirection } from "@/lib/catalogue-product-order";

/** Mêmes constantes EXACTES que les `raise exception ... message = '...'`
 *  de move_product_order. Classification stricte sur le COUPLE
 *  SQLSTATE + message (même discipline que lib/services/
 *  catalogue-error.ts), jamais sur le code seul. */
export const PRODUCT_ORDER_STALE_CODE = "SCANYM_PRODUCT_ORDER_STALE";
export const PRODUCT_ORDER_STALE_SQLSTATE = "P0001";
export const PRODUCT_ORDER_BOUNDARY_CODE = "SCANYM_PRODUCT_ORDER_BOUNDARY";
export const PRODUCT_ORDER_BOUNDARY_SQLSTATE = "22023";

/**
 * L'ordre affiché n'est plus celui de la base (autre onglet, autre
 * utilisateur, produit créé, archivé ou déplacé entre-temps). Rien n'a
 * été écrit : l'écran doit recharger le catalogue avant tout nouvel
 * essai.
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
 * @param expectedOrder identifiants de tous les produits non archivés
 *                      du périmètre, dans l'ordre AFFICHÉ avant le
 *                      déplacement (`ProductOrderScope.orderedIds`)
 * @returns la nouvelle position du produit (1 = premier)
 */
export async function moveProductOrder(
  productId: string,
  direction: ProductMoveDirection,
  expectedOrder: ReadonlyArray<string>
): Promise<number> {
  const { data, error } = await supabase.rpc("move_product_order", {
    p_product_id: productId,
    p_direction: direction,
    p_expected_order: [...expectedOrder],
  });
  if (error) throw classifyProductOrderError(error);
  return Number(data);
}
