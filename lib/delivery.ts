import type { RestaurantSettings, DeliveryZone } from "@/lib/restaurants-config";
import { isValidPostalCode } from "@/lib/customer";

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
