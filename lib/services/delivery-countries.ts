/**
 * Scanym — DELIVERY COUNTRY SCOPE v1.
 *
 * Relais de l'unique contrat PUBLIC des pays de livraison :
 * `public.get_restaurant_public_delivery_countries`.
 *
 * Même patron que `getRestaurantPublicFieldRequirements` : une
 * projection publique, restreinte, consommée par le parcours client
 * anonyme. Aucune donnée personnelle, aucun secret -- uniquement du
 * référentiel.
 *
 * AUCUNE ÉCRITURE ici : l'activation d'un pays est réservée à
 * l'opérateur Scanym (décision CIO Q13) et passe par une RPC distincte
 * qui n'est pas exposée au parcours client.
 */
import { supabase } from "@/lib/supabase";
import type {
  AddressLineOrder,
  AddressProviderId,
  DeliveryCountryOption,
} from "@/lib/delivery-country";

/** Échec de lecture. Distinct d'une liste vide : « aucun pays
 *  configuré » et « impossible de savoir » ne se confondent pas. */
export class DeliveryCountriesReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryCountriesReadError";
  }
}

export async function getPublicDeliveryCountries(
  restaurantId: string
): Promise<DeliveryCountryOption[]> {
  const id = (restaurantId ?? "").trim();
  if (id === "") throw new DeliveryCountriesReadError("Établissement requis.");

  const { data, error } = await supabase.rpc("get_restaurant_public_delivery_countries", {
    p_restaurant_id: id,
  });

  if (error) throw new DeliveryCountriesReadError(error.message);
  if (data === null || data === undefined) {
    throw new DeliveryCountriesReadError("Réponse vide du contrat des pays de livraison.");
  }

  return (data as unknown[]).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      countryCode: String(r.country_code ?? "").toUpperCase(),
      countryName: String(r.country_name ?? r.country_code ?? ""),
      postalCodePattern: r.postal_code_pattern ? String(r.postal_code_pattern) : null,
      phonePattern: r.phone_pattern ? String(r.phone_pattern) : null,
      addressProvider: (r.address_provider === "ban_ign"
        ? "ban_ign"
        : "manual") as AddressProviderId,
      addressLineOrder: (r.address_line_order === "street_first"
        ? "street_first"
        : "number_first") as AddressLineOrder,
    };
  });
}
