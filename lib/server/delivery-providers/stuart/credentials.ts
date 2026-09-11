import "server-only";

/**
 * LOT A-0 — MERCHANT STUART CREDENTIAL FOUNDATION v1.
 *
 * Analyse et validation STRICTE du credential Stuart PAR MARCHAND, lu
 * via `getDeliveryProviderCredential()` (lib/server/delivery-provider-
 * service.ts). Ce module n'accède JAMAIS à Vault directement, n'appelle
 * jamais `vault.decrypted_secrets`. La chaîne brute est une charge
 * JSON définie par CE lot — `p_secret text` côté SQL n'impose aucune
 * structure, donc rien ici ne "devine" le protocole Stuart lui-même,
 * seulement la convention de stockage choisie par cette application
 * (même patron que `lib/server/payment-providers/monetico/
 * credentials.ts`, domaine séparé).
 *
 * Champs retenus — déterminés à partir des preuves déjà réunies en
 * discovery (STUART-PRICING-SCHEDULING-DISCOVERY-v1.md,
 * STUART-ACCOUNT-MODEL-ADDENDUM-v1.md) : `lib/server/delivery-
 * providers/stuart/auth.ts` lit aujourd'hui `STUART_CLIENT_ID`/
 * `STUART_CLIENT_SECRET` (identifiants OAuth client-credentials) et
 * `STUART_ENV` (sandbox/production) au niveau global — ce sont les
 * TROIS seules valeurs dont un adaptateur Stuart a besoin pour
 * fonctionner par marchand ; ce lot n'en invente aucune autre
 * (mandat : "Do NOT add unsupported Stuart fields").
 *
 * Ne journalise JAMAIS le contenu analysé, sous quelque forme que ce
 * soit — ni en cas de succès, ni en cas d'échec.
 */

export interface StuartMerchantCredentialPayload {
  /** Identifiant client OAuth Stuart de CE marchand (équivalent
   *  marchand-scopé de STUART_CLIENT_ID). */
  clientId: string;
  /** Secret client OAuth Stuart de CE marchand (équivalent
   *  marchand-scopé de STUART_CLIENT_SECRET). */
  clientSecret: string;
  /** sandbox/production — mode d'exécution Stuart de CE marchand,
   *  indépendant des autres marchands. Optionnel dans le payload JSON
   *  (par défaut 'sandbox' si absent) — le mode AUTORITATIF reste
   *  toutefois `delivery_provider_configs.mode` (colonne SQL dédiée,
   *  déjà validée par set_delivery_provider_credentials) ; ce champ
   *  n'est ici qu'une redondance de confort pour un appelant qui ne
   *  relirait que le secret déchiffré sans la ligne de config. */
  mode?: "sandbox" | "production";
}

export class StuartCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StuartCredentialError";
  }
}

const CLIENT_ID_MAX_LENGTH = 512;
const CLIENT_SECRET_MAX_LENGTH = 512;

/** Seules ces trois propriétés sont acceptées — toute propriété
 *  supplémentaire inattendue est REJETÉE (même discipline que
 *  monetico/credentials.ts), pour empêcher qu'un champ additionnel non
 *  prévu ne soit silencieusement ignoré ou ne finisse par fuiter plus
 *  loin dans le pipeline. */
const ALLOWED_KEYS = new Set(["clientId", "clientSecret", "mode"]);

export function parseStuartMerchantCredential(raw: string): StuartMerchantCredentialPayload {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new StuartCredentialError("STUART_CREDENTIAL_EMPTY");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StuartCredentialError("STUART_CREDENTIAL_MALFORMED_JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StuartCredentialError("STUART_CREDENTIAL_INVALID_SHAPE");
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new StuartCredentialError("STUART_CREDENTIAL_UNEXPECTED_FIELD");
    }
  }

  const clientId = obj.clientId;
  const clientSecret = obj.clientSecret;
  const mode = obj.mode;

  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new StuartCredentialError("STUART_CREDENTIAL_MISSING_CLIENT_ID");
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new StuartCredentialError("STUART_CREDENTIAL_MISSING_CLIENT_SECRET");
  }
  if (clientId.length > CLIENT_ID_MAX_LENGTH) {
    throw new StuartCredentialError("STUART_CREDENTIAL_INVALID_CLIENT_ID");
  }
  if (clientSecret.length > CLIENT_SECRET_MAX_LENGTH) {
    throw new StuartCredentialError("STUART_CREDENTIAL_INVALID_CLIENT_SECRET");
  }

  if (mode !== undefined && mode !== "sandbox" && mode !== "production") {
    throw new StuartCredentialError("STUART_CREDENTIAL_INVALID_MODE");
  }

  return {
    clientId,
    clientSecret,
    ...(mode !== undefined ? { mode } : {}),
  };
}

/**
 * Sérialise un credential marchand en la même convention de stockage
 * (chaîne JSON, clés exactes `ALLOWED_KEYS`) attendue par
 * `parseStuartMerchantCredential`. Utilisée par le futur point d'appel
 * Admin/Operator (hors périmètre de ce lot) avant d'appeler
 * `setDeliveryProviderCredentials` — fournie ici pour garantir que la
 * seule fabrique de ce format vit à côté de son seul parseur, jamais
 * dupliquée ailleurs.
 */
export function serializeStuartMerchantCredential(payload: StuartMerchantCredentialPayload): string {
  const out: Record<string, string> = {
    clientId: payload.clientId,
    clientSecret: payload.clientSecret,
  };
  if (payload.mode !== undefined) {
    out.mode = payload.mode;
  }
  return JSON.stringify(out);
}
