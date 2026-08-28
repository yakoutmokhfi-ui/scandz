import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { buildCanonicalString } from "@/lib/server/payment-providers/monetico/canonicalization";
import { MoneticoProtocolError } from "@/lib/server/payment-providers/monetico/errors";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 * ALGORITHME MAC : HMAC-SHA1 (RFC 2104) -- indépendamment confirmé,
 * v2.0 §1.3, p.9-10.
 *
 * Utilise exclusivement `node:crypto` (mandat §29/§30) -- aucune
 * dépendance tierce de cryptographie ajoutée. Runtime Node explicite,
 * jamais Edge (`node:crypto` n'est pas disponible sous Edge).
 */

const HEX_KEY_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Transformation documentée et indépendamment confirmée (v2.0 §1.3,
 * p.9) : la clé de sécurité externe (40 caractères hexadécimaux) doit
 * être convertie en sa représentation opérationnelle de 20 octets
 * avant utilisation dans HMAC-SHA1 -- c'est-à-dire un simple décodage
 * hexadécimal -> binaire, PAS un hachage ni une dérivation
 * supplémentaire. Aucune autre transformation n'est documentée dans la
 * plage du document atteinte par l'agent, et aucune n'est donc
 * inventée ici.
 */
export function transformSecurityKey(hexKey: string): Buffer {
  const normalized = typeof hexKey === "string" ? hexKey.toLowerCase() : "";
  if (!HEX_KEY_PATTERN.test(normalized)) {
    throw new MoneticoProtocolError("MONETICO_INVALID_SECURITY_KEY_FORMAT");
  }
  return Buffer.from(normalized, "hex");
}

/**
 * Calcule le MAC hexadécimal (minuscules, 40 caractères) pour un jeu
 * de champs donné. `fields` doit déjà exclure le champ MAC lui-même --
 * cette fonction ne le retire jamais implicitement, pour rester un
 * utilitaire pur sans connaissance du nom du champ MAC.
 */
export function computeMac(fields: Record<string, string>, keyBuffer: Buffer): string {
  const canonical = buildCanonicalString(fields);
  const hmac = createHmac("sha1", keyBuffer);
  hmac.update(canonical, "utf8");
  return hmac.digest("hex");
}

/**
 * Vérifie un MAC reçu contre les champs fournis, en comparaison à
 * temps constant (mandat §29 -- `crypto.timingSafeEqual`) une fois les
 * deux chaînes hexadécimales normalisées à la même casse/longueur.
 * Ne journalise et ne relance JAMAIS le MAC attendu ni le MAC reçu.
 */
export function verifyMac(
  fields: Record<string, string>,
  keyBuffer: Buffer,
  providedMac: string
): boolean {
  if (typeof providedMac !== "string") return false;
  const providedNormalized = providedMac.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(providedNormalized)) return false;

  const expected = computeMac(fields, keyBuffer);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(providedNormalized, "utf8");

  // timingSafeEqual exige des tampons de même longueur -- garanti ici
  // puisque les deux chaînes sont déjà validées comme 40 caractères
  // hexadécimaux, mais vérifié explicitement pour ne jamais lui
  // passer des tampons de tailles différentes.
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
