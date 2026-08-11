import type { MerchantRestaurant } from "@/lib/dashboard-types";

/**
 * URL du menu public de l'établissement courant, dérivée de
 * `mappings` — jamais codée en dur. `null` tant que l'établissement
 * courant n'a pas de slug exploitable (mapping absent, `restaurants`
 * null, slug vide/blanc) : appelant responsable de ne rien afficher
 * dans ce cas plutôt que de générer `/r/undefined` ou `/r/null`.
 *
 * Le slug normalisé (bordures nettoyées) est encodé via
 * `encodeURIComponent()` avant insertion dans l'URL : défense en
 * profondeur, les slugs actuels (illico-presto, sanaa-cookies)
 * n'exigent rien de plus, mais rien ne garantit qu'un futur slug
 * reste toujours strictement alphanumérique-tiret.
 */
export function publicMenuHref(
  restaurantId: string,
  mappings: MerchantRestaurant[]
): string | null {
  const slug = mappings.find(
    (m) => m.restaurant_id === restaurantId
  )?.restaurants?.slug;
  if (typeof slug !== "string") return null;
  const normalizedSlug = slug.trim();
  if (!normalizedSlug) return null;
  return `/r/${encodeURIComponent(normalizedSlug)}`;
}
