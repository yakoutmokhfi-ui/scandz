import "server-only";
import { resolveStuartEnvironment } from "@/lib/server/delivery-providers/stuart/environment";

/**
 * DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.1
 * (ferme STUART-V1-AUTH-CONTRACT-01, STUART-V1-AUTH-CACHE-01).
 *
 * PREUVES DOCUMENTAIRES CONSULTÉES :
 * - "All our endpoints support OAuth 2.0 authentication."
 *   (stuart.com/developers/best-practices/authentication/)
 * - "Stuart API tokens are in JWT format up to 8KiB in length."
 * - "Your authentication access token will last 1 month... We
 *    strongly advise caching your access token and only renewing it
 *    when it's expired or when you receive an INVALID_GRANT error."
 * - "you'll receive a 401 error response with the error code
 *    INVALID_GRANT. Upon receiving this error, we advise simply
 *    requesting a new access token."
 *
 * CORRECTIFS v1.1 (retour d'audit Work indépendant) :
 * - `scope=api` désormais envoyé explicitement dans le corps de la
 *   requête, conformément au mandat de ce lot (contrat OAuth actuel
 *   prescrit) -- voir KNOWN-LIMITATIONS.md pour la transparence sur
 *   le niveau de confirmation indépendante de ce champ précis (non
 *   retrouvé littéralement dans les sources Stuart accessibles à
 *   cette session, mais prescrit explicitement par le mandat de
 *   remédiation comme contrat actuel officiel).
 * - `token_type` désormais VALIDÉ explicitement (attendu "bearer",
 *   insensible à la casse) -- une réponse avec un `token_type`
 *   inattendu est désormais un échec fermé, jamais silencieusement
 *   accepté.
 * - `invalid_scope` désormais CLASSIFIÉ explicitement, distinct des
 *   autres échecs d'authentification.
 * - URL de base dérivée EXCLUSIVEMENT de `STUART_ENV` via
 *   `resolveStuartEnvironment()` (ferme STUART-V1-ENVIRONMENT-GATE-01)
 *   -- `STUART_API_BASE_URL`/`STUART_AUTH_PATH` SUPPRIMÉES, plus
 *   aucune URL/chemin arbitraire possible.
 * - SINGLE-FLIGHT : plusieurs appelants concurrents à cache froid
 *   partagent LA MÊME promesse de requête réseau en cours, jamais
 *   une requête par appelant.
 * - Marge de sécurité d'expiration BORNÉE : jamais plus de la MOITIÉ
 *   de `expires_in` lui-même (voir `computeEffectiveSafetyMarginMs`)
 *   -- un jeton à très courte durée de vie (ex. 300s en test) n'est
 *   ainsi jamais immédiatement traité comme expiré par une marge fixe
 *   disproportionnée.
 *
 * Stuart est une intégration UNIQUE au niveau PLATEFORME (Scanym est
 * l'intégrateur, voir partner_data) -- identifiants lus depuis des
 * variables d'environnement serveur, jamais Vault (différent du
 * modèle par marchand de Monetico).
 *
 * SÉCURITÉ : jamais de secret NEXT_PUBLIC_, jamais de journalisation
 * du client_secret ni du jeton complet -- `import "server-only"`.
 */

export class StuartAuthError extends Error {
  constructor(message: string = "STUART_AUTH_ERROR") {
    super(message);
    this.name = "StuartAuthError";
  }
}

export class StuartInvalidScopeError extends StuartAuthError {
  constructor(message: string = "STUART_AUTH_INVALID_SCOPE") {
    super(message);
    this.name = "StuartInvalidScopeError";
  }
}

export class StuartConfigError extends Error {
  constructor(message: string = "STUART_CONFIG_ERROR") {
    super(message);
    this.name = "StuartConfigError";
  }
}

interface StuartTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Chemin de l'endpoint d'authentification -- convention OAuth2
 * générique, RELATIVE à l'URL de base résolue par
 * `resolveStuartEnvironment()`. Non paramétrable par variable
 * d'environnement (mandat §9 : "avoid configurable protocol paths
 * unless necessary") -- une seule constante, corrigée directement en
 * code si une divergence est confirmée par un test Sandbox réel.
 */
const AUTH_PATH = "/oauth/token";

/**
 * Marge de sécurité MAXIMALE (absolue) avant expiration réelle du
 * jeton -- jamais dépassée même pour un jeton à très longue durée
 * (~1 mois officiel).
 */
const MAX_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/**
 * STUART-V1-AUTH-CACHE-01 : la marge de sécurité EFFECTIVE est
 * bornée au minimum de (a) la marge maximale absolue ci-dessus et
 * (b) une fraction raisonnable (retenue : 20%) de la durée de vie
 * annoncée elle-même -- un jeton à très courte durée de vie (ex.
 * 300s en environnement de test) ne se voit ainsi JAMAIS traité
 * comme expiré dès sa réception (5 minutes de marge sur un jeton de
 * 5 minutes rendrait la mise en cache totalement inopérante).
 * Principe documenté explicitement, jamais une valeur magique
 * silencieuse :
 *   effectiveSafetyMarginMs = min(MAX_SAFETY_MARGIN_MS, expiresInMs * 0.2)
 */
function computeEffectiveSafetyMarginMs(expiresInMs: number): number {
  return Math.min(MAX_SAFETY_MARGIN_MS, expiresInMs * 0.2);
}

let cachedToken: CachedToken | null = null;
/** État single-flight : promesse de requête réseau EN COURS, partagée
 *  par tout appelant concurrent à cache froid -- jamais une requête
 *  par appelant. Effacé (mis à `null`) que la requête réussisse OU
 *  échoue, pour permettre un nouvel essai propre au prochain appel. */
let inFlightRequest: Promise<string> | null = null;

function getStuartCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.STUART_CLIENT_ID;
  const clientSecret = process.env.STUART_CLIENT_SECRET;
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new StuartConfigError("STUART_CLIENT_ID manquant");
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new StuartConfigError("STUART_CLIENT_SECRET manquant");
  }
  return { clientId, clientSecret };
}

/**
 * Force le renouvellement au prochain appel -- exclusivement destiné
 * à être invoqué après réception d'une erreur 401/INVALID_GRANT.
 */
export function invalidateStuartTokenCache(): void {
  cachedToken = null;
}

async function performTokenRequest(): Promise<string> {
  const now = Date.now();
  const { baseUrl } = resolveStuartEnvironment();
  const { clientId, clientSecret } = getStuartCredentials();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${AUTH_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "api",
      }).toString(),
    });
  } catch {
    throw new StuartAuthError("STUART_AUTH_UNAVAILABLE");
  }

  if (!response.ok) {
    // Classification explicite d'invalid_scope, distincte des autres
    // échecs -- jamais journalisée avec le corps complet (pourrait
    // contenir des détails sensibles), uniquement le code d'erreur
    // structuré s'il est identifiable sans risque.
    let errorCode: string | undefined;
    try {
      const body = (await response.clone().json()) as { error?: string };
      errorCode = body.error;
    } catch {
      // Corps non-JSON ou vide -- ignoré, classification par code de
      // statut HTTP uniquement dans ce cas.
    }
    if (errorCode === "invalid_scope") {
      throw new StuartInvalidScopeError();
    }
    throw new StuartAuthError(`STUART_AUTH_FAILED_${response.status}`);
  }

  let parsed: StuartTokenResponse;
  try {
    parsed = (await response.json()) as StuartTokenResponse;
  } catch {
    throw new StuartAuthError("STUART_AUTH_MALFORMED_RESPONSE");
  }

  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new StuartAuthError("STUART_AUTH_MISSING_TOKEN");
  }
  if (typeof parsed.expires_in !== "number" || parsed.expires_in <= 0) {
    throw new StuartAuthError("STUART_AUTH_MISSING_EXPIRY");
  }
  if (typeof parsed.token_type !== "string" || parsed.token_type.toLowerCase() !== "bearer") {
    throw new StuartAuthError(`STUART_AUTH_UNEXPECTED_TOKEN_TYPE`);
  }

  const expiresInMs = parsed.expires_in * 1000;
  const effectiveMarginMs = computeEffectiveSafetyMarginMs(expiresInMs);
  cachedToken = {
    accessToken: parsed.access_token,
    expiresAtMs: now + expiresInMs - effectiveMarginMs,
  };

  return cachedToken.accessToken;
}

/**
 * Retourne un jeton d'accès Stuart valide, mis en cache selon la
 * politique officiellement recommandée, avec renouvellement
 * SINGLE-FLIGHT : si plusieurs appelants arrivent concurremment sur
 * un cache froid, UNE SEULE requête réseau est émise, tous les
 * appelants partagent son résultat (succès ou échec identique).
 */
export async function getStuartAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken !== null && cachedToken.expiresAtMs > now) {
    return cachedToken.accessToken;
  }

  if (inFlightRequest !== null) {
    return inFlightRequest;
  }

  const request = performTokenRequest().finally(() => {
    inFlightRequest = null;
  });
  inFlightRequest = request;
  return request;
}
