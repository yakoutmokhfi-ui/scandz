/**
 * Scanym — DELIVERY COUNTRY SCOPE v1.
 *
 * DÉCIDER, SANS RIEN CODER EN DUR.
 *
 * La règle « ce marchand livre dans tel pays » vit dans des DONNÉES
 * (L2 : restaurant_delivery_countries). Ce module ne fait que traduire
 * ces données en décisions d'écran. Il ne connaît aucun établissement,
 * aucun code pays, aucun format postal : on peut le lire de bout en
 * bout sans deviner quel marchand est en production.
 *
 * Fonctions PURES : aucun réseau, aucun DOM, aucun état. Elles sont
 * donc prouvables directement, sans rendu.
 *
 * L'autorité réelle reste le serveur (`create_order` revérifie le pays
 * contre L2, par établissement). Ce module sert l'ergonomie ; il ne
 * protège rien.
 */

/** Une option de pays telle que le serveur la projette (L2 ⋈ L1). */
export interface DeliveryCountryOption {
  countryCode: string;
  countryName: string;
  /** Motif de validation du code postal POUR CE PAYS. `null` = aucun. */
  postalCodePattern: string | null;
  /** Motif de validation du téléphone POUR CE PAYS. `null` = aucun. */
  phonePattern: string | null;
  /** Fournisseur d'autocomplétion, ou `manual` quand il n'y en a pas. */
  addressProvider: AddressProviderId;
  /** Ordre d'écriture de la ligne de rue (FR : n° puis rue ; BE : l'inverse). */
  addressLineOrder: AddressLineOrder;
}

export type AddressProviderId = "manual" | "ban_ign";
export type AddressLineOrder = "number_first" | "street_first";

/**
 * Résolution du pays de livraison (décision CIO Q15).
 *
 *   0 pays  -> livraison indisponible, fail-closed ;
 *   1 pays  -> résolu automatiquement, AUCUN sélecteur rendu ;
 *   n pays  -> choix EXPLICITE du client exigé.
 *
 * « Never infer a multi-country destination from postal code alone » :
 * c'est pourquoi `pending` ne porte aucune valeur par défaut. Deviner
 * « 1000 est belge » serait faux dès qu'un pays partage un format avec
 * un autre -- et le format ne dit rien du pays.
 */
export type DeliveryCountryResolution =
  | { kind: "unavailable" }
  | { kind: "resolved"; country: DeliveryCountryOption; selectable: false }
  | { kind: "pending"; options: DeliveryCountryOption[] }
  | { kind: "selected"; country: DeliveryCountryOption; selectable: true };

export function resolveDeliveryCountry(
  options: ReadonlyArray<DeliveryCountryOption>,
  selectedCode: string | null = null
): DeliveryCountryResolution {
  if (options.length === 0) return { kind: "unavailable" };

  if (options.length === 1) {
    // Un seul pays : il est RÉSOLU, jamais proposé. Rendre un
    // sélecteur à une seule valeur donnerait l'illusion d'un choix
    // qui n'existe pas -- et exposerait un pays que le marchand ne
    // sert pas si la liste venait à changer côté client.
    return { kind: "resolved", country: options[0], selectable: false };
  }

  const picked = selectedCode
    ? options.find((o) => o.countryCode === selectedCode.trim().toUpperCase())
    : undefined;
  if (!picked) return { kind: "pending", options: [...options] };
  return { kind: "selected", country: picked, selectable: true };
}

/** Le pays effectivement retenu, ou `null` tant qu'aucun ne l'est. */
export function effectiveCountry(
  resolution: DeliveryCountryResolution
): DeliveryCountryOption | null {
  if (resolution.kind === "resolved" || resolution.kind === "selected") {
    return resolution.country;
  }
  return null;
}

/**
 * Un motif venu du serveur est appliqué ici. Il n'est JAMAIS codé en
 * dur : `^\d{5}$` n'apparaît nulle part dans ce module.
 *
 * Un motif illisible (corrompu, ou d'une syntaxe que le navigateur
 * refuse) ne doit pas bloquer le client : on laisse alors passer, et
 * le serveur -- seule autorité -- tranchera. Refuser une saisie parce
 * que NOTRE configuration est cassée serait punir le client de notre
 * défaut.
 */
export function matchesPattern(pattern: string | null, value: string): boolean {
  const candidate = (value ?? "").trim();
  if (!pattern) return candidate !== "";
  try {
    return new RegExp(pattern).test(candidate);
  } catch {
    return true;
  }
}

/** Validation du code postal SELON LE PAYS résolu. */
export function isValidPostalCodeFor(
  country: DeliveryCountryOption | null,
  value: string
): boolean {
  if (!country) return false;
  return matchesPattern(country.postalCodePattern, value);
}

/** Validation du téléphone SELON LE PAYS résolu. */
export function isValidPhoneFor(
  country: DeliveryCountryOption | null,
  value: string
): boolean {
  if (!country) return false;
  return matchesPattern(country.phonePattern, (value ?? "").replace(/[\s.\-]/g, ""));
}

import { DICTS } from "@/lib/i18n";

/**
 * DELIVERY COUNTRY SCOPE v1.1 -- message d'erreur de FORMAT du code
 * postal, SELON LE PAYS résolu.
 *
 * La clé est DÉRIVÉE du code pays (`errPostalCode_<code>`) et n'est
 * retenue que si le dictionnaire de référence la définit réellement
 * (propriété PROPRE, jamais la chaîne de prototypes). Tout autre pays
 * reçoit le message générique `errPostalCodeCountry`. Aucun pays n'est
 * nommé ici : ajouter un libellé pour un pays est une donnée i18n, pas
 * une ligne de code.
 */
export function postalCodeErrorKeyFor(country: DeliveryCountryOption | null): string | null {
  if (!country) return null;
  const key = `errPostalCode_${country.countryCode.trim().toUpperCase()}`;
  return Object.prototype.hasOwnProperty.call(DICTS.fr, key) ? key : "errPostalCodeCountry";
}

/**
 * DELIVERY COUNTRY SCOPE v1.1 (DCS-COUNTRY-UI-02) -- entrée de
 * validation client DÉRIVÉE du pays résolu.
 *
 * Fonction PURE, à recalculer à CHAQUE rendu : ses trois valeurs sont
 * des dépendances explicites de la validation du formulaire, de sorte
 * qu'un changement de pays (FR -> BE, BE -> FR) revalide
 * immédiatement le code postal déjà saisi.
 *
 * Hors livraison : aucun motif, rien à exiger.
 * En livraison SANS pays résolu (chargement, aucun pays, choix
 * multi-pays non fait) : `countryMissing = true`. Aucun motif d'un
 * AUTRE pays n'est appliqué à la place, et la soumission est bloquée
 * (fail-closed) ; le serveur reste l'autorité.
 */
export interface CountryValidationInput {
  postalCodePattern: string | null;
  phonePattern: string | null;
  countryMissing: boolean;
  /** v1.1 -- clé i18n du message de format postal pour CE pays. */
  postalCodeErrorKey: string | null;
}

export function countryValidationInput(
  isDelivery: boolean,
  country: DeliveryCountryOption | null
): CountryValidationInput {
  if (!isDelivery) {
    return { postalCodePattern: null, phonePattern: null, countryMissing: false, postalCodeErrorKey: null };
  }
  if (!country) {
    return { postalCodePattern: null, phonePattern: null, countryMissing: true, postalCodeErrorKey: null };
  }
  return {
    postalCodePattern: country.postalCodePattern,
    phonePattern: country.phonePattern,
    countryMissing: false,
    postalCodeErrorKey: postalCodeErrorKeyFor(country),
  };
}

/**
 * Le fournisseur d'adresse est DÉRIVÉ du pays résolu -- jamais choisi
 * par le client, jamais deviné.
 *
 * Sans pays résolu : `manual`. Et c'est la règle importante : un pays
 * sans fournisseur retombe sur la saisie manuelle, JAMAIS sur le
 * fournisseur d'un AUTRE pays.
 *
 * Ce n'est pas une précaution théorique. Le 2026-09-24, interrogé sur
 * « Rue de la Loi 16 Bruxelles », le fournisseur français BAN/IGN a
 * retourné trois rues FRANÇAISES (Nantes, Angers, Sèvremoine) : une
 * réponse fausse et plausible, jamais une erreur. Un repli inter-pays
 * ne produirait donc pas « aucun résultat » mais une mauvaise adresse
 * d'apparence normale.
 */
export function selectAddressProvider(
  country: DeliveryCountryOption | null
): AddressProviderId {
  return country?.addressProvider ?? "manual";
}

/** L'autocomplétion n'est proposée que si un vrai fournisseur existe. */
export function supportsAutocomplete(country: DeliveryCountryOption | null): boolean {
  return selectAddressProvider(country) !== "manual";
}
