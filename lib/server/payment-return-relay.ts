import "server-only";
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — RETURN RELAY TOKEN
 * (ferme P3B-V4-PUBLIC-TOKEN-URL-01 / P3B-V4-RETURN-AUTHORITY-01).
 *
 * `public_token` est une capacité de possession DURABLE (mission P1) --
 * il ne doit JAMAIS transiter dans une URL/un champ de formulaire
 * envoyé à Monetico (url_retour_ok/url_retour_err), ni apparaître en
 * clair dans un journal serveur/proxy (mandat v4 §12). Ce module
 * fournit une capacité de RELAIS opaque, à courte durée de vie, liée à
 * la commande, résistante à la falsification : AES-256-GCM (confiance
 * ET intégrité en une seule primitive -- toute altération d'un seul
 * octet du jeton fait échouer le déchiffrement, `decipher.final()`
 * lève) plutôt qu'un simple encodage réversible (mandat §12 : "Do not
 * simply Base64 the public_token").
 *
 * GÉNÉRIQUE, jamais spécifique à Monetico -- ce fichier ne connaît
 * aucun format de charge utile prestataire, aucun code-retour, aucun
 * MAC. Placé délibérément HORS de `payment-providers/monetico/` pour
 * cette raison (même discipline architecturale que le reste de
 * `lib/server/*`, vérifiée structurellement par les tests v110c/v111h).
 *
 * FORMAT DU JETON (opaque à Monetico ET au navigateur) :
 *   base64url( versionByte(1) || iv(12) || authTag(16) || ciphertext )
 * `versionByte` permet la ROTATION DE CLÉ (mandat §13) : chaque valeur
 * possible pointe vers une variable d'environnement DISTINCTE
 * (`PAYMENT_RETURN_RELAY_KEY_V{n}`), de sorte qu'une clé retirée de la
 * rotation ACTIVE reste néanmoins déchiffrable tant que sa variable
 * d'environnement existe encore (fenêtre de transition), et qu'une
 * version inconnue échoue fermé (mission §13 : "no fallback").
 *
 * CHARGE UTILE (chiffrée, jamais en clair) : `{ oid, pt, exp }` --
 * `orderId`/`publicToken`/expiration Unix (secondes). `orderId` est
 * ÉGALEMENT présent EN CLAIR dans la chaîne de requête de l'URL de
 * retour (mission v3, INCHANGÉ -- ce n'est PAS une capacité secrète,
 * contrairement à `publicToken`) : `verifyReturnRelayToken` EXIGE que
 * les deux correspondent, en temps constant -- défense explicite
 * contre "jeton copié vers une autre commande/un autre tenant" (mandat
 * §13 : "wrong order", "wrong environment", "token copied across
 * tenants").
 *
 * PAS DE LIAISON ok/err (mandat §14, invariant "browser return never
 * authoritative" étendu ici) : un jeton minté pour `/checkout/return/ok`
 * reste valide s'il est présenté à `/checkout/return/err` (et
 * réciproquement) -- SANS CONSÉQUENCE DE SÉCURITÉ, parce que le
 * résultat métier réel n'est JAMAIS dérivé de la route empruntée ni du
 * jeton lui-même, uniquement de `getOrderPaymentStatusSnapshot` (état
 * serveur autoritatif) une fois `orderId`/`publicToken` récupérés. Le
 * test "token copied from ok -> err" (mandat §13) vérifie précisément
 * cette propriété : le résultat affiché reste identique, gouverné par
 * l'état serveur, jamais par la route.
 *
 * PAS À USAGE UNIQUE (réplay non empêché structurellement) -- décision
 * DÉLIBÉRÉE : la seule action que ce jeton autorise est une LECTURE
 * (`getOrderPaymentStatusSnapshot`), intrinsèquement sans effet de
 * bord et idempotente ; borner la durée de vie (`exp`) est suffisant
 * pour cette classe d'usage, un modèle à usage unique ajouterait un
 * état serveur supplémentaire sans bénéfice de sécurité réel ici.
 */

export class ReturnRelayConfigurationError extends Error {
  constructor(message = "PAYMENT_RETURN_RELAY_KEY_UNAVAILABLE") {
    super(message);
    this.name = "ReturnRelayConfigurationError";
  }
}

export class ReturnRelayTokenInvalidError extends Error {
  constructor(message = "PAYMENT_RETURN_RELAY_TOKEN_INVALID") {
    super(message);
    this.name = "ReturnRelayTokenInvalidError";
  }
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_TOKEN_LENGTH = 4096;

function keyEnvVar(version: number): string {
  return `PAYMENT_RETURN_RELAY_KEY_V${version}`;
}

/** Fail-closed explicite -- clé absente, mal formée (pas exactement 64
 *  caractères hexadécimaux = 32 octets, AES-256), ou version hors
 *  bornes -> `ReturnRelayConfigurationError` (au montage) ou
 *  `ReturnRelayTokenInvalidError` (à la vérification, jamais une
 *  distinction observable exploitable -- voir `verifyReturnRelayToken`
 *  ci-dessous, mission §13 "missing key": "no fallback"). */
function resolveKey(version: number): Buffer {
  if (!Number.isInteger(version) || version < 1 || version > 255) {
    throw new ReturnRelayConfigurationError();
  }
  const raw = process.env[keyEnvVar(version)];
  if (typeof raw !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ReturnRelayConfigurationError();
  }
  return Buffer.from(raw, "hex");
}

function currentActiveKeyVersion(): number {
  const raw = process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION;
  const version = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(version) || version < 1 || version > 255) {
    throw new ReturnRelayConfigurationError();
  }
  return version;
}

interface ReturnRelayPayload {
  oid: string;
  pt: string;
  exp: number;
}

export interface CreateReturnRelayTokenInput {
  orderId: string;
  publicToken: string;
  ttlSeconds: number;
}

/**
 * Fail-closed AU MONTAGE (mandat préflight §6.19 : "return relay/token
 * can be generated safely" DOIT être vérifié AVANT toute création de
 * tentative de paiement) -- une clé absente/mal formée lève
 * IMMÉDIATEMENT `ReturnRelayConfigurationError`, jamais un jeton
 * dégradé ou une URL de retour absente silencieusement.
 */
export function createReturnRelayToken(input: CreateReturnRelayTokenInput): string {
  const version = currentActiveKeyVersion();
  const key = resolveKey(version);

  const payload: ReturnRelayPayload = {
    oid: input.orderId,
    pt: input.publicToken,
    exp: Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(input.ttlSeconds)),
  };

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const packed = Buffer.concat([Buffer.from([version]), iv, tag, ciphertext]);
  return packed.toString("base64url");
}

export interface VerifiedReturnRelay {
  orderId: string;
  publicToken: string;
}

/**
 * `expectedOrderId` DOIT être la valeur EN CLAIR déjà présente dans la
 * chaîne de requête (mission ci-dessus) -- comparaison en temps
 * constant, jamais `===` direct sur des chaînes potentiellement
 * contrôlées par l'attaquant (défense en profondeur, coût négligeable).
 *
 * TOUTE défaillance (base64 invalide, longueur incohérente, version de
 * clé inconnue/clé absente, balise d'authentification GCM invalide --
 * falsification --, JSON malformé, forme de charge utile inattendue,
 * expiration dépassée, `orderId` ne correspondant pas) lève
 * UNIFORMÉMENT `ReturnRelayTokenInvalidError` -- AUCUNE distinction
 * observable entre ces causes (même posture anti-fuite que le reste de
 * la couche paiement) : l'appelant (page de retour) doit traiter cela
 * comme "impossible de recouvrer le contexte serveur", jamais
 * différencier "jeton expiré" de "jeton falsifié" à l'utilisateur.
 */
export function verifyReturnRelayToken(
  token: unknown,
  expectedOrderId: string
): VerifiedReturnRelay {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new ReturnRelayTokenInvalidError();
  }

  let packed: Buffer;
  try {
    packed = Buffer.from(token, "base64url");
  } catch {
    throw new ReturnRelayTokenInvalidError();
  }

  if (packed.length < 1 + IV_LENGTH + TAG_LENGTH + 1) {
    throw new ReturnRelayTokenInvalidError();
  }

  const version = packed[0];
  const iv = packed.subarray(1, 1 + IV_LENGTH);
  const tag = packed.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(1 + IV_LENGTH + TAG_LENGTH);

  let key: Buffer;
  try {
    key = resolveKey(version);
  } catch {
    // Version de clé inconnue/retirée -- fail-closed, jamais un
    // repli implicite vers une autre version (mandat §13 "no
    // fallback").
    throw new ReturnRelayTokenInvalidError();
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Balise GCM invalide (falsification) ou IV/longueur incohérente.
    throw new ReturnRelayTokenInvalidError();
  }

  let payload: ReturnRelayPayload;
  try {
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as ReturnRelayPayload).oid !== "string" ||
      typeof (parsed as ReturnRelayPayload).pt !== "string" ||
      typeof (parsed as ReturnRelayPayload).exp !== "number" ||
      !Number.isFinite((parsed as ReturnRelayPayload).exp)
    ) {
      throw new Error("SHAPE");
    }
    payload = parsed as ReturnRelayPayload;
  } catch {
    throw new ReturnRelayTokenInvalidError();
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new ReturnRelayTokenInvalidError();
  }

  const expected = Buffer.from(expectedOrderId, "utf8");
  const actual = Buffer.from(payload.oid, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ReturnRelayTokenInvalidError();
  }

  return { orderId: payload.oid, publicToken: payload.pt };
}
