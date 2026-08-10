/**
 * Matrice des rôles du catalogue (miroir des contrôles SQL).
 *
 * L'autorisation réelle est appliquée en base par les fonctions
 * sécurisées ; ces helpers ne servent qu'à masquer les actions
 * inaccessibles dans l'interface.
 */
export type MerchantRole = "owner" | "manager" | "staff";

/** Prix, libellés, création, archivage. */
export function canEditProducts(role: string | undefined): boolean {
  return role === "owner" || role === "manager";
}

/** Signaler une rupture : geste opérationnel ouvert à tous. */
export function canToggleAvailability(role: string | undefined): boolean {
  return role === "owner" || role === "manager" || role === "staff";
}
