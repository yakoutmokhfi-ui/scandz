import "server-only";
import { createHash } from "node:crypto";

/**
 * DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.1
 * (STUART-CLIENT-REFERENCE-01 reste explicitement OPEN dans ce lot --
 * ferme STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 en choisissant
 * l'Option A du mandat de remédiation : reformulation honnête plutôt
 * qu'une garantie non tenue).
 *
 * CORRECTIF v1.1 -- retour d'audit Work indépendant : la v1 décrivait
 * cette fonction comme fournissant une "protection anti-collision"
 * suffisante à elle seule. C'ÉTAIT INEXACT -- un hachage déterministe,
 * aussi large soit son espace, reste PROBABILISTE, jamais une
 * GARANTIE d'unicité. Ce lot ne construit AUCUNE couche d'allocation
 * persistante (SQL/table de corrélation) -- explicitement hors
 * périmètre de cette remédiation (mandat §11, "foundation only").
 *
 * Cette fonction est donc renommée et reformulée en générateur de
 * référence CANDIDATE -- jamais présentée comme une garantie
 * d'unicité active. `STUART-CLIENT-REFERENCE-01` reste explicitement
 * `OPEN / REQUIRES PERSISTENT ALLOCATION` -- voir
 * STUART-OFFICIAL-DOC-GAP-MATRIX.md. Toute orchestration réelle de
 * création de job Stuart DOIT être précédée d'une vérification
 * d'unicité PERSISTANTE (contrainte d'unicité en base de données sur
 * la table de corrélation dédiée, non encore implémentée) avant
 * d'utiliser cette référence candidate comme `client_reference` réel
 * -- INTERDICTION EXPLICITE d'orchestrer une création de job réelle
 * sur la seule base de cette fonction.
 *
 * PREUVE DOCUMENTAIRE OFFICIELLE EXACTE (setup-for-success) :
 *   "Ensure the 'client_reference' is unique for any active delivery
 *    on your Stuart account. Keep your order identifier simple to
 *    read with no more than ten characters, and avoid starting with
 *    a special character. Track your orders through this
 *    'client_reference' when using webhooks."
 *
 * ALGORITHME (INCHANGÉ depuis v1, seule la QUALIFICATION change) :
 *   SHA-256(order_id) -> 10 premiers caractères hexadécimaux,
 *   MAJUSCULES.
 *
 * PROPRIÉTÉS RÉELLEMENT GARANTIES par cette fonction, et SEULEMENT
 * celles-ci :
 * - DÉTERMINISTE : la même commande produit toujours la même
 *   référence candidate.
 * - COURTE : exactement 10 caractères, conforme à la limite
 *   officielle recommandée.
 * - JAMAIS un caractère spécial en tête (chiffres hexadécimaux
 *   uniquement, par construction).
 * - STABLE : ne dépend que de `order_id` (UUID v4, PAYMENT P1),
 *   jamais de `order_number` seul (collision garantie entre
 *   marchands multi-tenant sinon).
 *
 * PROPRIÉTÉ EXPLICITEMENT **NON** GARANTIE :
 * - Unicité RÉELLE parmi les livraisons Stuart actuellement actives
 *   sur le compte Stuart. Le risque de collision reste
 *   PROBABILISTIQUEMENT très faible à l'échelle d'un marchand pilote
 *   unique (40 bits d'espace), mais "très faible" n'est PAS "garanti"
 *   -- cette nuance est le cœur du correctif de ce lot.
 */
export function deriveStuartClientReferenceCandidate(orderId: string): string {
  const hash = createHash("sha256").update(orderId, "utf8").digest("hex");
  return hash.slice(0, 10).toUpperCase();
}
