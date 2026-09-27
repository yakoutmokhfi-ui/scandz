/**
 * Scanym — ADDRESS UX v1 : résolution code postal -> ville (France).
 *
 * Même discipline que `lib/services/address-search.ts` (LOT B.5) :
 * couche UNIQUE de mapping/appel réseau pour cette source, aucun
 * composant React n'appelle `fetch` directement ni ne connaît la forme
 * brute de la réponse ; `fetchImpl`/`timeoutMs` injectables pour les
 * tests (aucun appel réseau réel dans la suite) ; zéro résultat n'est
 * PAS une erreur (CP inconnu de la source -- repli fail-soft sur la
 * saisie libre, jamais un blocage) ; une vraie panne (réseau/HTTP/
 * parsing) lève `PostcodeLookupError`, laissée à l'appelant.
 *
 * PROVIDER — `geo.api.gouv.fr` (Etalab/DINUM, ouvert, sans clé),
 * endpoint `/communes?codePostal=...` : c'est la source officielle
 * française commune <-> code postal, distincte de l'API Géoplateforme
 * IGN déjà utilisée pour la recherche de rue (`address-search.ts`) --
 * ce fichier ne réutilise PAS ce second endpoint (il ne répond pas à
 * "liste des communes pour ce CP", voir l'analyse fonctionnelle livrée
 * sur l'issue #11), mais reprend EXACTEMENT le même patron de code
 * (défensif, testable, fail-soft) pour rester cohérent avec le reste
 * du projet.
 *
 * SCOPÉ FRANCE UNIQUEMENT (mission ADDRESS UX v1, §6 -- "pas de
 * fournisseur inter-pays") : appelé UNIQUEMENT quand le pays résolu
 * est FR, jamais comme repli implicite pour un autre pays.
 */
export type PostcodeLookupFailureReason =
  | "timeout"
  | "network-error"
  | "http-error"
  | "malformed-response";

export class PostcodeLookupError extends Error {
  readonly reason: PostcodeLookupFailureReason;
  constructor(reason: PostcodeLookupFailureReason, options?: { cause?: unknown }) {
    super(`PostcodeLookupError: ${reason}`);
    this.name = "PostcodeLookupError";
    this.reason = reason;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface PostcodeCity {
  /** Code INSEE de la commune -- jamais utilisé comme identifiant
   *  d'affichage, seulement pour dédupliquer des homonymes. */
  code: string;
  /** Nom de la commune, tel que retourné par la source -- jamais
   *  reformaté ni ré-accentué ici. */
  name: string;
}

const COMMUNES_ENDPOINT = "https://geo.api.gouv.fr/communes";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Mapping DÉFENSIF d'une entrée brute -- même discipline que
 * `mapGeoplateformeFeatureToSuggestion` (address-search.ts) : un champ
 * requis manquant ou d'un type inattendu fait ignorer l'entrée,
 * jamais une exception ni une valeur inventée.
 */
function mapCommuneEntry(entry: unknown): PostcodeCity | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const code = typeof e.code === "string" ? e.code.trim() : "";
  const name = typeof e.nom === "string" ? e.nom.trim() : "";
  if (code === "" || name === "") return null;
  return { code, name };
}

/**
 * Résout les communes valides pour un code postal FRANÇAIS 5 chiffres.
 *
 * - N'effectue AUCUN appel réseau pour un code postal structurellement
 *   invalide (l'appelant doit déjà avoir vérifié le format, comme pour
 *   `searchAddressSuggestions`/`MIN_QUERY_LENGTH`) -- défense en
 *   profondeur : un CP malformé retourne `[]` sans requête.
 * - Liste vide -- CP inconnu de la source (DOM/TOM partiellement
 *   couverts, CP obsolète, etc.) : PAS une erreur, l'appelant retombe
 *   sur la saisie libre (fail-soft, mission ADDRESS UX v1 §2).
 * - Panne réelle (réseau/HTTP/parsing) : `PostcodeLookupError`,
 *   laissée à l'appelant -- qui doit alors retomber sur la saisie
 *   libre exactement comme pour `AddressSearchError`, jamais bloquer
 *   la saisie du client pour un défaut d'un service tiers.
 */
export async function lookupCitiesForPostalCode(
  postalCode: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<PostcodeCity[]> {
  const trimmed = postalCode.trim();
  if (!/^\d{5}$/.test(trimmed)) return [];

  const fetchImpl = options.fetchImpl ?? fetch;
  const internalController = options.signal ? null : new AbortController();
  const signal = options.signal ?? internalController!.signal;
  const timeoutHandle = internalController
    ? setTimeout(() => internalController.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : null;

  try {
    const url = new URL(COMMUNES_ENDPOINT);
    url.searchParams.set("codePostal", trimmed);
    url.searchParams.set("fields", "nom,code");
    url.searchParams.set("format", "json");

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new PostcodeLookupError("timeout", { cause: err });
      }
      throw new PostcodeLookupError("network-error", { cause: err });
    }

    if (!response.ok) {
      // geo.api.gouv.fr répond 404 pour un CP totalement hors format --
      // déjà écarté ci-dessus par la regex, mais un 404 peut aussi
      // survenir pour un CP structurellement valide sans commune connue
      // selon les versions de l'API -- traité comme "aucune commune
      // trouvée" (fail-soft), jamais comme une panne bloquante.
      if (response.status === 404) return [];
      throw new PostcodeLookupError("http-error");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new PostcodeLookupError("malformed-response", { cause: err });
    }

    if (!Array.isArray(payload)) {
      throw new PostcodeLookupError("malformed-response");
    }

    const cities: PostcodeCity[] = [];
    const seen = new Set<string>();
    for (const entry of payload) {
      const mapped = mapCommuneEntry(entry);
      if (mapped && !seen.has(mapped.code)) {
        seen.add(mapped.code);
        cities.push(mapped);
      }
    }
    return cities;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Comparaison ville/CP insensible à la casse et aux accents (mission
 *  ADDRESS UX v1 §4 -- "comparaison insensible à la casse/accents"). */
export function normalizeCityForComparison(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-\s']+/g, " ");
}

/** `true` si `city` correspond à l'une des communes candidates -- ou
 *  si `candidates` est vide/`null` (rien à comparer : fail-open,
 *  jamais un blocage sur une absence de donnée, mission §4). */
export function cityMatchesCandidates(
  city: string,
  candidates: ReadonlyArray<PostcodeCity> | null | undefined
): boolean {
  if (!candidates || candidates.length === 0) return true;
  if (city.trim() === "") return true; // champ vide : erreur "requis", pas "incohérent"
  const normalized = normalizeCityForComparison(city);
  return candidates.some((c) => normalizeCityForComparison(c.name) === normalized);
}
