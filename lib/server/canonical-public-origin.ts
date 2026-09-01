import "server-only";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — CANONICAL PUBLIC ORIGIN
 * (ferme P3B-V4-RETURN-AUTHORITY-01, mandat §11).
 *
 * v3 dérivait `url_retour_ok`/`url_retour_err` de
 * `request.nextUrl.origin` -- l'en-tête `Host`/`X-Forwarded-Host` d'une
 * requête entrante N'EST PAS une autorité de confiance (un client peut
 * l'envoyer arbitrairement selon la configuration du proxy/reverse
 * proxy en amont) : un attaquant qui contrôlerait cet en-tête pourrait
 * potentiellement rediriger un paiement légitime vers un domaine de
 * phishing. Ce module introduit une autorité SERVEUR UNIQUE,
 * explicitement configurée, jamais dérivée d'une requête entrante.
 *
 * Variable d'environnement : `SCANYM_PUBLIC_ORIGIN` (convention nommée
 * explicitement par le mandat v4 §11 -- aucune convention de nommage
 * "origine publique" préexistante n'a été trouvée ailleurs dans ce
 * dépôt lors de la reconnaissance de ce lot).
 *
 * FAIL-CLOSED explicite (mandat §11) : absente, mal formée, contenant
 * des identifiants (`user:pass@`), une requête (`?...`) ou un fragment
 * (`#...`), ou un chemin autre que `/`/vide -> `CanonicalPublicOriginConfigurationError`,
 * jamais une valeur devinée ou un repli sur `request.nextUrl.origin`.
 *
 * SCHÉMA : `https:` exigé, SAUF exception `http://localhost`/
 * `http://127.0.0.1` (ergonomie de développement local uniquement --
 * jamais un domaine public en clair). Aucune configuration Production
 * n'est effectuée par ce lot (mandat §11 : "No Production env
 * configuration now") -- cette fonction lève simplement fail-closed
 * tant que la variable n'est pas définie, ce qui est l'état ATTENDU de
 * ce sandbox de développement (voir EVIDENCE/ du paquet livré : les
 * tests fournissent explicitement cette variable, jamais l'environnement
 * réel).
 */
export class CanonicalPublicOriginConfigurationError extends Error {
  constructor(message = "SCANYM_PUBLIC_ORIGIN_INVALID_OR_MISSING") {
    super(message);
    this.name = "CanonicalPublicOriginConfigurationError";
  }
}

const ENV_VAR = "SCANYM_PUBLIC_ORIGIN";

export function resolveCanonicalPublicOrigin(): string {
  const raw = process.env[ENV_VAR];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CanonicalPublicOriginConfigurationError();
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CanonicalPublicOriginConfigurationError();
  }

  if (url.username !== "" || url.password !== "") {
    throw new CanonicalPublicOriginConfigurationError();
  }
  if (url.search !== "" || url.hash !== "") {
    throw new CanonicalPublicOriginConfigurationError();
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new CanonicalPublicOriginConfigurationError();
  }

  const isLocalDevHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalDevHttp) {
    throw new CanonicalPublicOriginConfigurationError();
  }

  // `URL.origin` normalise déjà (pas de trailing slash superflu au-delà
  // du chemin racine, casse d'hôte normalisée) -- jamais une
  // reconstruction manuelle depuis les champs individuels.
  return url.origin;
}
