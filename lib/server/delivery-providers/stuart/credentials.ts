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
 * `STUART_CLIENT_SECRET` (identifiants OAuth client-credentials) au
 * niveau global — ce sont les DEUX seules valeurs dont un adaptateur
 * Stuart a besoin pour s'authentifier par marchand ; ce lot n'en
 * invente aucune autre (mandat : "Do NOT add unsupported Stuart
 * fields").
 *
 * CORRECTIF STUART LOT A (mandat, "FIRST — CLOSE A-0 LOW FINDING") :
 * `mode` a été RETIRÉ de ce payload et de `ALLOWED_KEYS` ci-dessous.
 * L'A-0 LOW finding (Cat Stevens) signalait une divergence possible
 * entre `delivery_provider_configs.mode` (colonne SQL, déjà
 * authoritative pour `set_/clear_delivery_provider_credentials`) et un
 * `mode` optionnel autrefois accepté ICI, dans le payload credential
 * lui-même — DEUX sources de vérité possibles pour la même donnée.
 * Direction retenue (mandat, "Preferred direction") :
 * `delivery_provider_configs.mode` devient l'UNIQUE source de vérité ;
 * le payload credential ne contient plus JAMAIS `mode` — toute
 * tentative de le fournir est REJETÉE DE FAÇON DÉTERMINISTE (même
 * discipline stricte que tout autre champ inattendu, voir
 * `ALLOWED_KEYS`/`STUART_CREDENTIAL_UNEXPECTED_FIELD` ci-dessous),
 * jamais silencieusement ignorée — aucune divergence de configuration
 * n'est donc plus structurellement possible. Le mode AUTORITATIF pour
 * un usage runtime est désormais lu séparément, via
 * `getDeliveryProviderConfigStatus()` (lib/server/delivery-provider-
 * service.ts, STUART LOT A) — voir `credential-resolver.ts`.
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
}

export class StuartCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StuartCredentialError";
  }
}

const CLIENT_ID_MAX_LENGTH = 512;
const CLIENT_SECRET_MAX_LENGTH = 512;

/** Seules ces DEUX propriétés sont acceptées — toute propriété
 *  supplémentaire inattendue est REJETÉE (même discipline que
 *  monetico/credentials.ts), pour empêcher qu'un champ additionnel non
 *  prévu ne soit silencieusement ignoré ou ne finisse par fuiter plus
 *  loin dans le pipeline. `mode` retiré ici délibérément (STUART LOT A,
 *  fermeture du A-0 LOW finding) — un payload contenant `mode` est
 *  désormais rejeté par la même voie que tout autre champ inattendu. */
const ALLOWED_KEYS = new Set(["clientId", "clientSecret"]);

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

  return { clientId, clientSecret };
}

/**
 * Sérialise un credential marchand en la même convention de stockage
 * (chaîne JSON, clés exactes `ALLOWED_KEYS`) attendue par
 * `parseStuartMerchantCredential`. Utilisée par le futur point d'appel
 * Admin/Operator (hors périmètre de ce lot) avant d'appeler
 * `setDeliveryProviderCredentials` — fournie ici pour garantir que la
 * seule fabrique de ce format vit à côté de son seul parseur, jamais
 * dupliquée ailleurs. Ne sérialise plus `mode` (STUART LOT A, fermeture
 * du A-0 LOW finding) — voir le commentaire d'en-tête du fichier.
 */
export function serializeStuartMerchantCredential(payload: StuartMerchantCredentialPayload): string {
  return JSON.stringify({
    clientId: payload.clientId,
    clientSecret: payload.clientSecret,
  });
}
