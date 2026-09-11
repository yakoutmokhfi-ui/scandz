import "server-only";

/**
 * STUART LOT A — QUOTE / VALIDATE / ETA / SCHEDULING FOUNDATION v1.
 *
 * Authentification OAuth Stuart PARAMÉTRÉE PAR MARCHAND -- distincte,
 * DÉLIBÉRÉMENT, de `auth.ts` (DELIVERY STREAM C, authentification
 * PLATEFORME UNIQUE, variables d'environnement serveur
 * STUART_CLIENT_ID/STUART_CLIENT_SECRET, cache global à une seule
 * entrée). Ce module NE LIT JAMAIS les variables d'environnement
 * serveur Stuart globales et N'IMPORTE JAMAIS `auth.ts` ni
 * `environment.ts` -- preuve structurelle couverte par un test dédié
 * (voir `tests/v159-stuart-quote-validate-foundation.test.ts`), même
 * discipline que `credential-resolver.ts` (LOT A-0/STUART LOT A).
 *
 * POURQUOI NE PAS RÉUTILISER `auth.ts` : son cache
 * (`cachedToken`/`inFlightRequest`) est un SEUL état module-level,
 * partagé par TOUS les appelants -- correct pour une identité
 * PLATEFORME unique, mais DANGEREUX pour une identité PAR MARCHAND (un
 * jeton du Marchand A pourrait fuiter vers une requête du Marchand B
 * si le cache était réutilisé tel quel). Ce module N'IMPLÉMENTE DONC
 * AUCUN CACHE -- SIMPLIFICATION DÉLIBÉRÉE, documentée explicitement
 * comme telle dans le livrable final (section connue de ce lot) :
 * chaque appel à `getStuartAccessTokenForMerchant` déclenche une
 * NOUVELLE requête `/oauth/token`. Une future optimisation (cache par
 * marchand, scopé par `restaurantId`) reste HORS PÉRIMÈTRE de ce lot
 * (mandat : "QUOTE / VALIDATE service boundary" ne mentionne aucune
 * exigence de cache) -- ne pas fabriquer une politique de cache sans
 * mandat explicite.
 *
 * CONTRAT OAuth réutilisé -- PROUVÉ, identique à `auth.ts` (mêmes
 * citations documentaires déjà établies dans ce dépôt) :
 * `POST /oauth/token`, corps `application/x-www-form-urlencoded`
 * (`grant_type=client_credentials&client_id=...&client_secret=...&scope=api`),
 * réponse `{ access_token: string, token_type: "bearer", expires_in: number }`.
 *
 * `baseUrl` est TOUJOURS fourni par l'appelant (dérivé du `mode`
 * AUTORITATIF résolu par `credential-resolver.ts` via
 * `resolveStuartBaseUrlForEnvironment()`, `environment.ts`) -- ce
 * module ne résout JAMAIS lui-même un environnement.
 *
 * SÉCURITÉ : jamais de secret NEXT_PUBLIC_, jamais de journalisation
 * du `clientSecret` ni du jeton complet -- `import "server-only"`.
 */

export class StuartMerchantAuthError extends Error {
  constructor(message: string = "STUART_MERCHANT_AUTH_ERROR") {
    super(message);
    this.name = "StuartMerchantAuthError";
  }
}

const AUTH_PATH = "/oauth/token";

export interface StuartMerchantCredentialForAuth {
  clientId: string;
  clientSecret: string;
}

interface StuartMerchantTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Obtient un jeton d'accès Stuart pour LE credential marchand fourni,
 * contre l'URL de base fournie. AUCUN cache -- voir commentaire de
 * fichier ci-dessus. `fetchImpl` injectable (mandat : "Mocked HTTP
 * only" -- AUCUN appel réseau réel Stuart, Sandbox ou Production,
 * pendant ce lot).
 */
export async function getStuartAccessTokenForMerchant(
  credential: StuartMerchantCredentialForAuth,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${AUTH_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        scope: "api",
      }).toString(),
    });
  } catch {
    throw new StuartMerchantAuthError("STUART_MERCHANT_AUTH_UNAVAILABLE");
  }

  if (!response.ok) {
    throw new StuartMerchantAuthError(`STUART_MERCHANT_AUTH_FAILED_${response.status}`);
  }

  let parsed: StuartMerchantTokenResponse;
  try {
    parsed = (await response.json()) as StuartMerchantTokenResponse;
  } catch {
    throw new StuartMerchantAuthError("STUART_MERCHANT_AUTH_MALFORMED_RESPONSE");
  }

  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new StuartMerchantAuthError("STUART_MERCHANT_AUTH_MISSING_TOKEN");
  }
  if (typeof parsed.token_type !== "string" || parsed.token_type.toLowerCase() !== "bearer") {
    throw new StuartMerchantAuthError("STUART_MERCHANT_AUTH_UNEXPECTED_TOKEN_TYPE");
  }
  if (typeof parsed.expires_in !== "number" || parsed.expires_in <= 0) {
    throw new StuartMerchantAuthError("STUART_MERCHANT_AUTH_MISSING_EXPIRY");
  }

  return parsed.access_token;
}
