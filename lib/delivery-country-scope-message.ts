/**
 * Scanym — ADDRESS UX v1, CIO ADDENDUM : visibilité du périmètre pays
 * de livraison.
 *
 * Fonction PURE (aucun réseau, aucun DOM) : construit le message
 * proéminent "Livraison disponible ... en {pays}" affiché AU DÉBUT du
 * bloc adresse de livraison, à partir de la liste RÉELLE des pays de
 * livraison configurés pour l'établissement (L2,
 * `get_restaurant_public_delivery_countries` / `getPublicDeliveryCountries`),
 * jamais d'un nom de marchand ni d'un pays codé en dur.
 *
 * Supporte 1..N pays : 1 pays -> formulation "uniquement" (clé
 * `deliveryCountryScopeSingle`) ; 2+ pays -> liste jointe localement
 * correcte ("France et Italie" / "France, Italy and Belgium" /
 * "فرنسا وإيطاليا"), via `Intl.ListFormat` -- jamais une concaténation
 * "," + "et" codée en dur à la main, qui se tromperait en arabe ou
 * avec 3+ éléments.
 */
import type { DeliveryCountryOption } from "@/lib/delivery-country";
import type { Lang, Translator } from "@/lib/i18n";

/** Locale BCP-47 passée à `Intl.ListFormat`, dérivée de la langue
 *  Scanym. Toute langue non explicitement mappée retombe sur "fr" --
 *  jamais une supposition silencieuse sur un futur code de langue. */
const LIST_FORMAT_LOCALE: Record<string, string> = { fr: "fr", en: "en", ar: "ar" };

/**
 * `null` si aucun pays n'est configuré (rien à afficher -- le reste du
 * parcours livraison est de toute façon fail-closed dans ce cas,
 * `deliveryCountryUnavailable` prend déjà le relais ailleurs).
 */
export function formatDeliveryCountryScopeMessage(
  t: Translator,
  lang: Lang,
  countries: ReadonlyArray<Pick<DeliveryCountryOption, "countryName">>
): string | null {
  const names = countries
    .map((c) => c.countryName.trim())
    .filter((name) => name !== "");
  if (names.length === 0) return null;

  if (names.length === 1) {
    return t("deliveryCountryScopeSingle", { country: names[0] });
  }

  const locale = LIST_FORMAT_LOCALE[lang] ?? "fr";
  let joined: string;
  try {
    joined = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    // `Intl.ListFormat` indisponible ou motif non supporté (environnement
    // ancien) : repli simple, jamais un plantage pour un message
    // purement informatif.
    joined = names.join(", ");
  }
  return t("deliveryCountryScopeMultiple", { countries: joined });
}
