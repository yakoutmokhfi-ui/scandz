import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { isPlausibleUuid } from "@/lib/tracking/uuid";

/**
 * CUSTOMER TRACKING EXPERIENCE v2 — session de PRÉSENTATION temporaire
 * (mandat §9/§10).
 *
 * DISTINCTION EXPLICITE (mandat §9) :
 *   - AUTORITÉ MÉTIER DE POSSESSION : `order_id` + `public_token`,
 *     inchangée, c'est TOUJOURS elle qui est vérifiée par la RPC
 *     publiée `get_order_tracking` avant qu'une session ne soit
 *     jamais créée (voir app/api/track/exchange/route.ts).
 *   - SESSION DE PRÉSENTATION : ce module. Un mécanisme À COURTE DURÉE
 *     DE VIE, établi UNIQUEMENT après une preuve de possession réussie,
 *     dont le seul but est d'éviter qu'une lecture répétée (auto-
 *     rafraîchissement) n'expose ou ne retransmette le jeton porteur.
 *     Ce n'est PAS une seconde autorité durable : elle ne peut jamais
 *     être créée sans la preuve de possession d'origine, et son
 *     contenu est entièrement dérivé de cette preuve (jamais un
 *     nouveau secret indépendant émis côté serveur).
 *
 * STATELESS PAR CONSTRUCTION (mandat §10/§29, "Tracking v2 should
 * preferably have NO new SQL") : AUCUNE table, AUCUN état côté base de
 * données. Le jeton de session est un blob chiffré+authentifié
 * (AES-256-GCM, node:crypto natif -- aucune nouvelle dépendance npm)
 * porté par un cookie HttpOnly ; le serveur peut le vérifier sans
 * consulter quoi que ce soit d'autre qu'un secret d'environnement.
 *
 * Ce module NE JOURNALISE JAMAIS son entrée/sortie (mandat §12) :
 * `verifyTrackingSessionToken` retourne `null` pour TOUTE défaillance
 * (jeton expiré, altéré, mal formé, secret manquant en amont d'appel,
 * commande ne correspondant pas) -- jamais une erreur distincte, jamais
 * un `console.error` contenant le jeton ou son contenu déchiffré.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/** Durée de vie BORNÉE de la session (mandat §10, "bounded expiry") --
 *  assez généreuse pour couvrir un cycle de vie de commande normal
 *  (préparation puis retrait/service/livraison) sans que le client
 *  n'ait besoin de rouvrir son lien d'origine en cours de route ; si
 *  elle expire malgré tout, le comportement générique d'invalidité
 *  (mandat §11) s'applique -- jamais une seconde autorité de secours. */
const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 heures

/** Nom de cookie FIXE, sans donnée client dedans (mandat §10, "no
 *  customer PII in cookie") -- l'isolation par commande est assurée
 *  par le PATH du cookie (voir route.ts) ET, en défense en profondeur,
 *  par la vérification explicite `payload.orderId === expectedOrderId`
 *  ci-dessous (mandat §11), indépendante de tout comportement de
 *  portée de cookie. */
export const TRACKING_SESSION_COOKIE_NAME = "st_session";
export const TRACKING_SESSION_MAX_AGE_SECONDS = SESSION_TTL_SECONDS;

/** Erreur de CONFIGURATION serveur (secret absent/mal formé) --
 *  distincte à dessein d'un jeton de session invalide : ce n'est
 *  jamais une information client-safe, elle ne doit jamais atteindre
 *  une réponse HTTP ni un message customer-facing (voir route.ts, qui
 *  la traite comme une panne d'infrastructure générique). */
export class TrackingSessionConfigError extends Error {
  constructor(message = "TRACKING_SESSION_CONFIG_ERROR") {
    super(message);
    this.name = "TrackingSessionConfigError";
  }
}

function getSessionKey(): Buffer {
  const raw = process.env.TRACKING_SESSION_SECRET;
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    // Jamais la valeur elle-même dans le message -- juste le fait
    // qu'elle est absente/mal formée (secret potentiel, même vide).
    throw new TrackingSessionConfigError();
  }
  return Buffer.from(raw, "hex");
}

interface TrackingSessionPayload {
  orderId: string;
  publicToken: string;
  /** Expiration en epoch millisecondes (mandat §10, "bounded
   *  expiry") -- jamais un jeton sans expiration. */
  exp: number;
}

/**
 * Émet un jeton de session opaque à partir d'une preuve de possession
 * DÉJÀ VÉRIFIÉE par l'appelant (route.ts n'appelle ceci qu'après un
 * appel RÉUSSI à `get_order_tracking`). Ce module lui-même ne
 * re-vérifie PAS la possession -- ce n'est pas son rôle, voir
 * TRACKING-AUTHORITY-REPORT.txt pour la séparation des responsabilités.
 */
export function createTrackingSessionToken(orderId: string, publicToken: string): string {
  const key = getSessionKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const payload: TrackingSessionPayload = {
    orderId,
    publicToken,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

/**
 * Vérifie un jeton de session et retourne la preuve de possession
 * qu'il porte SI ET SEULEMENT SI :
 *   - le jeton se déchiffre et s'authentifie correctement (AES-GCM,
 *     donc toute altération/troncature/jeton pour une autre installation
 *     -- clé différente -- échoue ici) ;
 *   - il n'est pas expiré (mandat §10) ;
 *   - son contenu reste un couple UUID plausible (défense en
 *     profondeur -- ne devrait jamais être faux pour un jeton émis par
 *     ce module, mais jamais supposé) ;
 *   - `payload.orderId` correspond EXACTEMENT à `expectedOrderId`
 *     (mandat §11, ISOLATION SESSION/COMMANDE : "A session established
 *     for Order A must not read Order B" -- vérifié ICI, indépendamment
 *     de tout comportement de portée de cookie côté navigateur).
 *
 * Retourne `null` pour TOUTE autre issue -- jamais une exception, JAMAIS
 * un détail sur LAQUELLE de ces conditions a échoué (mandat §13,
 * "expired/invalid session -> generic invalid/unavailable behavior").
 */
export function verifyTrackingSessionToken(
  token: string,
  expectedOrderId: string
): { orderId: string; publicToken: string } | null {
  try {
    const key = getSessionKey();
    const raw = Buffer.from(token, "base64url");
    const minLength = IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES;
    if (raw.length <= minLength) return null;

    const iv = raw.subarray(0, IV_LENGTH_BYTES);
    const authTag = raw.subarray(IV_LENGTH_BYTES, minLength);
    const ciphertext = raw.subarray(minLength);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const payload = JSON.parse(plaintext.toString("utf8")) as Partial<TrackingSessionPayload>;

    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    if (typeof payload.orderId !== "string" || typeof payload.publicToken !== "string") return null;
    if (!isPlausibleUuid(payload.orderId) || !isPlausibleUuid(payload.publicToken)) return null;
    if (payload.orderId !== expectedOrderId) return null;

    return { orderId: payload.orderId, publicToken: payload.publicToken };
  } catch {
    // Jeton altéré/tronqué/mal encodé/JSON invalide, OU secret de
    // configuration absent (TrackingSessionConfigError, capturée ici
    // aussi -- une session invérifiable doit dégrader vers "aucune
    // session", jamais faire planter le rendu de la page). Jamais de
    // journalisation du jeton ni du contenu déchiffré.
    return null;
  }
}
