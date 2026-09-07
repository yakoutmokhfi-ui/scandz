/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Bornes de prix, PURE, mirroir EXACT de la contrainte serveur dans
 * `create_product`/`update_product` (voir
 * supabase/DRAFT-lot-catalogue-operator-authorization-v1.sql,
 * "if p_price is null or p_price < 0 or p_price > 9999999"). Aucun
 * autre module client de ce dépôt n'exposait cette borne -- elle est
 * définie ICI comme unique source de vérité côté import, jamais
 * dupliquée en dur ailleurs.
 *
 * Cette validation reste un CONFORT de retour immédiat (mandat OB-3,
 * "REUSE CURRENT BACKEND" -- même discipline que
 * lib/catalogue-fiscal.ts) : l'autorité définitive au moment d'un
 * futur commit (OB-4) reste TOUJOURS la contrainte serveur, jamais ce
 * module.
 */

export const PRODUCT_PRICE_MIN = 0;
export const PRODUCT_PRICE_MAX = 9999999;

export function isValidProductPrice(price: number): boolean {
  return Number.isFinite(price) && price >= PRODUCT_PRICE_MIN && price <= PRODUCT_PRICE_MAX;
}
