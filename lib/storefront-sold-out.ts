/**
 * Issue #200 -- produits en rupture dans la vitrine, réglage PAR commerçant.
 *
 * Trois états distincts, jamais confondus :
 *  - supprimé  : la ligne n'existe plus -> jamais affiché ;
 *  - archivé   : `archived_at` renseigné -> TOUJOURS exclu de la vitrine,
 *                quel que soit le réglage ;
 *  - indisponible (`is_available = false`) : exclu de la vitrine (comportement
 *                historique) SAUF si le commerçant a activé
 *                `show_unavailable_products` ; le produit est alors affiché
 *                « En rupture », sans aucun moyen de l'ajouter au panier.
 *
 * Défaut sûr : toute valeur absente (colonne pas encore appliquée), nulle
 * ou inattendue vaut `false` = comportement historique inchangé.
 */

/** true UNIQUEMENT pour le booléen `true` ; tout le reste (absent, null, "true", 1) => false. */
export function normalizeShowUnavailableProducts(value: unknown): boolean {
  return value === true;
}

/** Valeur historique : les produits indisponibles restent masqués. */
export const LEGACY_SHOW_UNAVAILABLE_PRODUCTS = false;

/** Un produit (ou une option) est en rupture quand `is_available` vaut explicitement `false`. */
export function isSoldOut(item: { is_available?: boolean | null }): boolean {
  return item.is_available === false;
}
