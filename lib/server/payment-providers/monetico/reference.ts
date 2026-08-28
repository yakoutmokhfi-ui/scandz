import "server-only";
import { createHash } from "node:crypto";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 *
 * Stratégie de correspondance déterministe et sûre entre une amorce
 * (seed) fournie par l'appelant et une référence Monetico courte
 * (mandat §16). Monetico documente `reference` comme 1 à 50 caractères
 * ASCII imprimables, avec 12 caractères recommandés (v2.0 §1.4.2.2,
 * p.12, confirmé). Ce lot choisit délibérément de ne JAMAIS exposer
 * l'identifiant interne brut (un UUID à 36 caractères, reconnaissable
 * comme une clé primaire interne) comme référence externe envoyée à un
 * tiers.
 *
 * Stratégie : SHA-256(seed) tronqué aux 12 premiers caractères
 * hexadécimaux -- déterministe (même amorce => même référence,
 * important pour l'idempotence d'une nouvelle tentative), non
 * réversible, strictement dans le jeu de caractères ASCII imprimable,
 * bien en-deçà de la limite de 50 caractères.
 *
 * La corrélation avec la tentative de paiement interne NE dépend PAS
 * d'une inversion de ce hachage : `initiate_payment_attempt` (PAYMENT
 * P1, déjà publié et audité) enregistre cette même valeur comme
 * `provider_reference` au moment de l'initiation -- c'est cette
 * colonne, côté base de données, qui permet à `confirm_payment_attempt`
 * de retrouver la tentative plus tard, exactement comme pour tout
 * autre prestataire déjà supporté par l'infrastructure générique.
 *
 * Le choix de CE QUE l'appelant utilise comme amorce (id de commande,
 * id de tentative dédié, etc.) appartient à une future orchestration
 * (P3-B) -- ce lot bibliothèque pur ne décide pas de ce choix, il
 * fournit seulement la fonction de dérivation elle-même.
 */
export function deriveMoneticoReference(seed: string): string {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new RangeError("deriveMoneticoReference: seed must be a non-empty string");
  }
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 12);
}
