import type { RestaurantSettings, DeliveryZone } from "@/lib/restaurants-config";
import type { PublicDeliveryInfo } from "@/lib/sale-modes-types";
import { isValidPostalCode } from "@/lib/customer";

// Ré-exportée : DeliveryZone devient le modèle COMMUN aux deux
// résolveurs de ce fichier (corrige L2B2-01) -- consommateurs et
// tests peuvent l'importer directement depuis lib/delivery.ts, sans
// remonter à restaurants-config.ts pour ce type générique.
export type { DeliveryZone };

export type DeliveryBlock = "below-min" | "no-postal" | "out-of-zone";

export interface DeliveryStatus {
  eligible: boolean;
  zone?: DeliveryZone;
  block?: DeliveryBlock;
  /** Nombre d'articles restant à ajouter pour la livraison */
  missing?: number;
}

/**
 * Détermine si la livraison est proposée, à partir du montant du panier
 * et du code postal saisi par le client.
 *
 * ⚠️ LOT 2B.2 -- CHEMIN LEGACY CONSERVÉ TEL QUEL, INTENTIONNELLEMENT.
 * Décision CIO explicite : le seul appelant réel de cette fonction est
 * MenuView.tsx (interdit de modification dans ce sous-lot), qui
 * l'utilise de façon SYNCHRONE dans un useMemo(). La rendre
 * asynchrone (nécessaire pour consommer get_restaurant_public_delivery_info,
 * un appel Supabase) exigerait de restructurer MenuView.tsx
 * (état/effet pour la récupération), explicitement hors périmètre.
 * L'import de RestaurantSettings/restaurants-config.ts est donc
 * TEMPORAIREMENT conservé UNIQUEMENT pour cette fonction -- ce n'est
 * PAS la suppression finale de cette dépendance, qui aura lieu lors
 * de la bascule réelle de MenuView.tsx (sous-lot séparé, non
 * commencé ici). Voir getDeliveryStatusFromPublicInfo ci-dessous pour
 * la nouvelle fonction pure, déjà prête pour cette bascule future.
 */
export function getDeliveryStatus(
  settings: RestaurantSettings,
  postalCode: string,
  totalCount: number
): DeliveryStatus {
  // La zone est contrôlée en premier : hors secteur, aucun montant ne
  // rendrait la livraison possible, il ne faut donc pas parler de seuil.
  const code = postalCode.trim();
  if (!isValidPostalCode(code)) return { eligible: false, block: "no-postal" };

  const zone = (settings.deliveryZones ?? []).find((z) => code.startsWith(z.code));
  if (!zone) return { eligible: false, block: "out-of-zone" };

  const min = settings.deliveryMinItems ?? 0;
  if (totalCount < min) {
    return { eligible: false, block: "below-min", missing: min - totalCount, zone };
  }

  return { eligible: true, zone };
}

/**
 * Zone de livraison générique reconnue à partir des informations
 * publiques LOT 2B.1 -- réutilise DIRECTEMENT DeliveryZone (ci-dessus,
 * import), jamais un type parallèle. Corrige L2B2-01 (contre-audit
 * Work) : PublicDeliveryZone/PublicDeliveryStatus, introduits dans le
 * tour précédent, sont supprimés -- ils dupliquaient un concept
 * métier identique (le résultat d'une recherche de zone de livraison)
 * sans raison de coexister. DeliveryZone.label a été élargi à
 * `string | null` (voir restaurants-config.ts) précisément pour
 * pouvoir servir aux DEUX résolveurs.
 */

/**
 * Détermine si la livraison est proposée, à partir des informations
 * publiques déjà résolues par LOT 2B.1
 * (get_restaurant_public_delivery_info, via lib/sale-modes-public.ts)
 * et du code postal/montant du panier saisis par le client.
 *
 * Fonction PURE, SYNCHRONE, SANS accès Supabase, sans logique
 * spécifique à un établissement précis -- reçoit uniquement des
 * données déjà résolues par l'appelant (jamais un appel réseau
 * interne). Le SEUL import lié à restaurants-config.ts qu'elle
 * partage avec getDeliveryStatus est le type DeliveryZone/DeliveryStatus
 * eux-mêmes (un import de TYPE uniquement, jamais RestaurantSettings
 * ni aucune donnée de configuration établissement) -- nécessaire pour
 * unifier le modèle de résultat des deux résolveurs, comme exigé.
 *
 * areaLabel = null : jamais de texte inventé en repli ("Unknown",
 * "Zone", etc.) -- transmis tel quel dans zone.label, dont le type
 * autorise désormais explicitement `null`.
 *
 * LEGACY CALL PATH STILL ACTIVE -- MIGRATION PREPARED, NOT SWITCHED :
 * cette fonction est prête à être appelée dès que MenuView.tsx sera
 * migré (sous-lot séparé) pour fournir un PublicDeliveryInfo déjà
 * récupéré de façon asynchrone, au lieu de RestaurantSettings.
 * getDeliveryStatus() ci-dessus reste le chemin RÉELLEMENT actif en
 * runtime tant que cette bascule n'a pas eu lieu.
 */
export function getDeliveryStatusFromPublicInfo(
  deliveryInfo: PublicDeliveryInfo | null,
  postalCode: string,
  totalCount: number
): DeliveryStatus {
  const code = postalCode.trim();
  if (!isValidPostalCode(code)) return { eligible: false, block: "no-postal" };

  // info = null : livraison non disponible pour cet établissement
  // (mode delivery non activé/configuré, ou établissement non actif)
  // -- traité comme "hors zone", cohérent avec le contrat existant
  // (aucune zone ne peut jamais correspondre).
  if (!deliveryInfo) return { eligible: false, block: "out-of-zone" };

  // zonePrefixes = [] : aucune zone desservie, même traitement.
  const matchedPrefix = deliveryInfo.zonePrefixes.find((prefix) => code.startsWith(prefix));
  if (!matchedPrefix) return { eligible: false, block: "out-of-zone" };

  const zone: DeliveryZone = { code: matchedPrefix, label: deliveryInfo.areaLabel };

  // minItems = 0 : aucun minimum, toute quantité positive est éligible.
  const min = deliveryInfo.minItems ?? 0;
  if (totalCount < min) {
    return { eligible: false, block: "below-min", missing: min - totalCount, zone };
  }

  return { eligible: true, zone };
}
