import type {
  AddressSearchOptions,
  AddressSuggestion,
  StructuredCustomerAddress,
} from "@/lib/address-types";

/**
 * FULFILLMENT ROUTING LOT B.5 — Service d'adresse structurée.
 *
 * Couche UNIQUE de mapping/appel réseau (mission §6/§9) : AUCUN
 * composant React ne doit appeler `fetch` directement ni connaître la
 * forme brute d'une réponse de provider — voir
 * components/AddressAutocomplete.tsx, qui n'importe que
 * `searchAddressSuggestions` et manipule exclusivement des
 * `AddressSuggestion`/`StructuredCustomerAddress` (lib/address-types.ts).
 *
 * ADDRESS PROVIDER ≠ DELIVERY PROVIDER (mission §8, rappel explicite) :
 * ce fichier ne sélectionne, n'appelle et ne mentionne AUCUN
 * transporteur (Stuart/Chronofresh/Uber Direct/coursier propre). Il
 * ne fait que rechercher/normaliser une adresse. Le futur resolveur
 * fulfillment (lib/delivery.ts, resolveDeliveryFulfillment) reste seul
 * responsable du routing, à partir de `structuredAddress.postalCode`
 * (Lot C, non branché ici).
 *
 * PROVIDER FRANCE INITIAL — statut de la recherche (mission §7/§32,
 * voir le rapport de mission pour le détail complet et les sources) :
 *   - Identifié avec une confiance raisonnable via des sources
 *     officielles/quasi-officielles (data.gouv.fr, guides.data.gouv.fr) :
 *     l'ancienne API BAN (api-adresse.data.gouv.fr, DINUM) a été
 *     TRANSFÉRÉE À L'IGN (Géoplateforme) fin 2023/2024 — l'ancien
 *     endpoint n'est donc PAS supposé être le bon choix en 2026,
 *     exactement l'avertissement de la mission. Endpoint actuel
 *     confirmé par deux sources cohérentes :
 *     `https://data.geopf.fr/geocodage/search`.
 *   - Accès ouvert, sans authentification, ~50 req/s/IP (source :
 *     fiche officielle data.gouv.fr du service).
 *   - Format de réponse : GeoJSON FeatureCollection, contrat BAN
 *     historique (properties.postcode/city/citycode/label/name,
 *     geometry.coordinates=[lon,lat]) — LE SEUL point de rupture de
 *     compatibilité documenté par la migration IGN concerne le
 *     géocodage CSV en masse (non utilisé ici), pas la recherche
 *     ponctuelle utilisée par ce fichier.
 *   - NON vérifié en direct dans ce sandbox : un appel réel à
 *     l'endpoint (le bac à sable n'a pas d'accès réseau sortant vers
 *     des hôtes tiers arbitraires) et la liste exhaustive des champs
 *     de `properties` via une spec OpenAPI/Swagger en direct (les
 *     tentatives de récupération de la documentation live ont échoué
 *     dans cet environnement). Le mapping ci-dessous est donc
 *     DÉFENSIF PAR CONSTRUCTION : un champ requis manquant ou d'un
 *     type inattendu fait ignorer la suggestion (jamais une exception,
 *     jamais une valeur inventée) — voir mapGeoplateformeFeatureToSuggestion.
 *   - Aucune clé/secret requis par ce provider (accès public) : l'appel
 *     peut donc rester côté navigateur, conformément à la règle
 *     sécurité de la mission (§16 : "Si provider public sans secret :
 *     documenter. Si secret requis : appel côté serveur uniquement.").
 *   - RECOMMANDATION avant activation Lot C : effectuer un test fumée
 *     contre l'endpoint réel (réseau sortant, CORS) depuis un
 *     environnement disposant d'un accès Internet complet, pour
 *     confirmer les noms de champs exacts avant toute mise en
 *     production — ce lot ne le fait pas et ne prétend pas l'avoir
 *     fait.
 */

const FRANCE_GEOPLATEFORME_SEARCH_ENDPOINT = "https://data.geopf.fr/geocodage/search";
const DEFAULT_RESULT_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 5000;
/** En-deçà de cette longueur (après trim), aucune requête réseau n'est déclenchée. */
export const MIN_QUERY_LENGTH = 3;

export type AddressSearchFailureReason =
  | "timeout"
  | "network-error"
  | "http-error"
  | "malformed-response";

/**
 * Erreur typée distincte d'un simple "aucun résultat" — permet à
 * l'appelant (composant/service) de distinguer "le provider est
 * indisponible, propose la saisie manuelle" (mission §10) d'un
 * "aucune adresse ne correspond à cette recherche" (tableau vide,
 * jamais une exception pour ce cas-là).
 */
export class AddressSearchError extends Error {
  readonly reason: AddressSearchFailureReason;
  constructor(reason: AddressSearchFailureReason, options?: { cause?: unknown }) {
    super(`AddressSearchError: ${reason}`);
    this.name = "AddressSearchError";
    this.reason = reason;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Mapping DÉFENSIF d'un feature GeoJSON brut (provider France,
 * Géoplateforme IGN) vers le contrat Scanym `AddressSuggestion`.
 *
 * Pure, sans effet de bord, jamais de `throw` sur un champ manquant
 * ou d'un type inattendu : retourne `null` (la suggestion est
 * ignorée par l'appelant, voir searchAddressSuggestions) plutôt que
 * de propager une exception ou d'inventer une valeur par défaut pour
 * un champ requis absent — les précédents findings d'audit Work
 * (Lot B, FRB-B-01/FRB-B-02) portaient précisément sur ce type de
 * divergence de contrat nullable ; ce lot applique la même discipline
 * dès la fondation adresse.
 *
 * `countryCode` est codé en dur à "FR" ICI SEULEMENT (ce mapping est
 * spécifique au provider France) — jamais dans lib/address-types.ts
 * ni dans normalizeAddressSuggestion/manualAddressToStructured
 * ci-dessous, qui restent génériques (mission §5).
 */
export function mapGeoplateformeFeatureToSuggestion(feature: unknown): AddressSuggestion | null {
  if (typeof feature !== "object" || feature === null) return null;
  const properties = (feature as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return null;
  const p = properties as Record<string, unknown>;

  const postalCode = typeof p.postcode === "string" ? p.postcode.trim() : "";
  const city = typeof p.city === "string" ? p.city.trim() : "";
  const label = typeof p.label === "string" ? p.label.trim() : "";
  // "name" (numéro + rue) est préférable à "label" (qui inclut déjà
  // code postal + ville) pour addressLine -- mais reste optionnel :
  // à défaut, on retombe sur label plutôt que d'exclure la suggestion
  // pour un champ secondaire manquant.
  const addressLine =
    typeof p.name === "string" && p.name.trim() !== "" ? p.name.trim() : label;

  // postalCode, city, et un libellé exploitable (label OU addressLine)
  // sont considérés requis -- c'est exactement ce que le contrat
  // StructuredCustomerAddress attend en sortie (mission §11/§12 :
  // "postalCode" doit être fiable, jamais une chaîne vide silencieuse).
  if (postalCode === "" || city === "" || (label === "" && addressLine === "")) {
    return null;
  }

  const id =
    typeof p.id === "string" && p.id.trim() !== ""
      ? p.id.trim()
      : typeof p.banId === "string" && p.banId.trim() !== ""
        ? p.banId.trim()
        : `${postalCode}-${addressLine || label}`;

  const geometry = (feature as { geometry?: unknown }).geometry;
  let longitude: number | null = null;
  let latitude: number | null = null;
  if (typeof geometry === "object" && geometry !== null) {
    const coordinates = (geometry as { coordinates?: unknown }).coordinates;
    if (
      Array.isArray(coordinates) &&
      coordinates.length === 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number" &&
      Number.isFinite(coordinates[0]) &&
      Number.isFinite(coordinates[1])
    ) {
      longitude = coordinates[0];
      latitude = coordinates[1];
    }
  }

  return {
    id,
    label: label || addressLine,
    addressLine: addressLine || label,
    postalCode,
    city,
    countryCode: "FR",
    latitude,
    longitude,
  };
}

/**
 * Recherche des suggestions d'adresse structurées.
 *
 * - Aucune requête réseau en-deçà de MIN_QUERY_LENGTH caractères
 *   (après trim) — mission §9 "résultats limités raisonnablement" /
 *   §15 "éviter une requête à chaque frappe non maîtrisée".
 * - `fetchImpl`/`timeoutMs` injectables : permet aux tests (voir
 *   tests/v98-b5-structured-address-foundation.test.ts) de simuler
 *   succès/erreur réseau/réponse malformée/timeout SANS jamais
 *   effectuer un vrai appel réseau — pas de donnée client réelle dans
 *   les tests (mission §26, données synthétiques uniquement).
 * - Timeout et annulation (`options.signal`) gérés via AbortController
 *   -- si un `signal` externe est fourni (ex. démontage du composant),
 *   il est respecté ; sinon un timeout interne (`timeoutMs`,
 *   DEFAULT_TIMEOUT_MS par défaut) protège contre un provider qui ne
 *   répond jamais.
 * - Zéro résultat -- retourne `[]`, jamais une AddressSearchError
 *   (ce n'est pas un échec du provider, mission §10 distingue les deux
 *   cas). Une vraie panne (réseau/HTTP/parsing) lève AddressSearchError
 *   -- l'appelant (composant) peut alors proposer la saisie manuelle.
 * - Aucun log de la requête ni de la réponse (mission §16 : "aucune
 *   adresse loggée inutilement" -- la requête utilisateur EST une
 *   donnée personnelle en devenir).
 */
export async function searchAddressSuggestions(
  query: string,
  options: AddressSearchOptions & { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<AddressSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;

  const internalController = options.signal ? null : new AbortController();
  const signal = options.signal ?? internalController!.signal;
  const timeoutHandle = internalController
    ? setTimeout(() => internalController.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : null;

  try {
    const url = new URL(FRANCE_GEOPLATEFORME_SEARCH_ENDPOINT);
    url.searchParams.set("q", trimmed);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("autocomplete", "1");
    url.searchParams.set("index", "address");

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AddressSearchError("timeout", { cause: err });
      }
      throw new AddressSearchError("network-error", { cause: err });
    }

    if (!response.ok) {
      throw new AddressSearchError("http-error");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new AddressSearchError("malformed-response", { cause: err });
    }

    const features =
      typeof payload === "object" && payload !== null
        ? (payload as { features?: unknown }).features
        : undefined;
    if (!Array.isArray(features)) {
      throw new AddressSearchError("malformed-response");
    }

    const suggestions: AddressSuggestion[] = [];
    for (const feature of features) {
      const mapped = mapGeoplateformeFeatureToSuggestion(feature);
      if (mapped) suggestions.push(mapped);
    }
    return suggestions.slice(0, limit);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Normalise une suggestion sélectionnée vers le contrat client
 * canonique `StructuredCustomerAddress` — GÉNÉRIQUE (aucune référence
 * à un provider ni à un pays précis ici).
 */
export function normalizeAddressSuggestion(
  suggestion: AddressSuggestion
): StructuredCustomerAddress {
  return {
    addressLine: suggestion.addressLine.trim(),
    postalCode: suggestion.postalCode.trim(),
    city: suggestion.city.trim(),
    countryCode: suggestion.countryCode.trim().toUpperCase(),
    label: suggestion.label ? suggestion.label.trim() : null,
    latitude: suggestion.latitude ?? null,
    longitude: suggestion.longitude ?? null,
  };
}

/**
 * Fallback saisie manuelle (mission §10/§11) — produit le MÊME
 * contrat `StructuredCustomerAddress` qu'une suggestion sélectionnée
 * via l'API, pour que Lot C/Lot D n'aient jamais à distinguer les deux
 * origines. Ne fait AUCUNE validation de format (générique, même
 * discipline que resolveDeliveryFulfillment/lib/delivery.ts LOT B.1 :
 * pas de contrôle 5-chiffres France-specific ici -- la validation de
 * champ requis reste celle déjà existante, lib/customer.ts,
 * inchangée par ce lot).
 */
export function manualAddressToStructured(input: {
  addressLine: string;
  postalCode: string;
  city: string;
  countryCode: string;
}): StructuredCustomerAddress {
  return {
    addressLine: input.addressLine.trim(),
    postalCode: input.postalCode.trim(),
    city: input.city.trim(),
    countryCode: input.countryCode.trim().toUpperCase(),
    label: null,
    latitude: null,
    longitude: null,
  };
}
