import "server-only";
import type {
  BuildMoneticoRequestInput,
  MoneticoPaymentRequestFields,
} from "@/lib/server/payment-providers/monetico/types";
import {
  transformSecurityKey,
  computeMac,
} from "@/lib/server/payment-providers/monetico/mac";
import { deriveMoneticoReference } from "@/lib/server/payment-providers/monetico/reference";
import { MoneticoProtocolError } from "@/lib/server/payment-providers/monetico/errors";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 * CONSTRUCTION DE LA REQUÊTE DE PAIEMENT SORTANTE (interface "Aller").
 *
 * §14 AUTORITÉ MONTANT/DEVISE : `amount`/`currency` DOIVENT provenir du
 * résultat de `initiatePaymentAttempt()` (PAYMENT P1/P3-A1, déjà
 * publié) -- cette fonction ne les recalcule jamais et n'a aucune
 * connaissance d'une requête HTTP ou d'une entrée navigateur (aucune
 * route publique n'existe dans ce lot -- mandat §32 -- donc rien ici
 * ne peut de toute façon être atteint directement par une entrée
 * client). Voir tests/v111d-payment-p3a2-request.test.ts pour la
 * démonstration intégrée : le flux testé est exactement
 * `initiatePaymentAttempt()` (mocké) -> `buildMoneticoPaymentRequest()`,
 * et une vérification structurelle confirme qu'aucun fichier de ce
 * dossier ne lit jamais `req.body`/`searchParams`/toute source de
 * requête HTTP.
 */

/** "Uniquement la valeur « 3.0 »" -- v2.0 §1.4.2.2, p.12, confirmé. */
const VERSION = "3.0";
const DEFAULT_LANGUAGE = "FR";
/** v2.0 §1.4.2.2, p.12-17, confirmé : "DE EN ES FR IT JA NL PT SV". */
const SUPPORTED_LANGUAGES = new Set(["DE", "EN", "ES", "FR", "IT", "JA", "NL", "PT", "SV"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** "[0-9]+(\.[0-9]{1,2})?[A-Z]{3}", ex. "95.25EUR" -- v2.0 §1.4.2.2,
 *  p.12, confirmé. `toFixed(2)` produit toujours exactement 2
 *  décimales, un sous-ensemble valide du format documenté (qui accepte
 *  1 ou 2 décimales, ou aucune). */
function formatMontant(amount: number, currency: string): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new MoneticoProtocolError("MONETICO_INVALID_AMOUNT");
  }
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new MoneticoProtocolError("MONETICO_INVALID_CURRENCY");
  }
  return `${amount.toFixed(2)}${currency}`;
}

/**
 * "JJ/MM/AAAA:HH:MM:SS" -- v2.0 §1.4.2.2, p.12, confirmé. Aucun fuseau
 * horaire n'est spécifié par la plage du document atteinte par
 * l'agent -- choix explicite et documenté de CE lot (mandat §17,
 * "Document timezone choice") : horodatage en UTC, jamais dépendant
 * silencieusement du fuseau local du process serveur (qui peut varier
 * selon la région d'hébergement).
 */
function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}:${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * "Données au format JSON - UTF-8 encodées en base 64" -- v2.0
 * §1.4.2.2, p.14, confirmé pour l'encodage EXTÉRIEUR. Le schéma
 * INTÉRIEUR détaillé (objets billing/shipping/shoppingCart/client,
 * Annexe 9.5, p.94-108) n'a pas pu être atteint par l'agent -- voir le
 * rapport, section CONTEXTE_COMMANDE. Ce lot n'implémente donc AUCUN
 * de ces sous-objets et se limite au "minimum safe metadata needed for
 * correlation" explicitement autorisé par le mandat (§18) : un unique
 * identifiant de corrélation non secret, optionnel.
 */
function buildContexteCommande(orderCorrelationId: string | undefined): string {
  const payload = orderCorrelationId ? { correlationId: orderCorrelationId } : {};
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64");
}

export function buildMoneticoPaymentRequest(
  input: BuildMoneticoRequestInput,
  now: Date = new Date()
): MoneticoPaymentRequestFields {
  const language = (input.language ?? DEFAULT_LANGUAGE).toUpperCase();
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw new MoneticoProtocolError("MONETICO_UNSUPPORTED_LANGUAGE");
  }

  const reference = deriveMoneticoReference(input.referenceSeed);
  const montant = formatMontant(input.amount, input.currency);
  const date = formatDate(now);
  const contexte_commande = buildContexteCommande(input.orderCorrelationId);

  // Jeu de champs "reconnus" pour la signature sortante de CE lot v1
  // (voir canonicalization.ts pour la portée exacte de cette notion) --
  // exactement les 8 champs obligatoires confirmés, jamais un champ
  // optionnel non implémenté ici.
  const unsigned: Record<string, string> = {
    version: VERSION,
    TPE: input.credential.tpe,
    date,
    montant,
    reference,
    lgue: language,
    contexte_commande,
    societe: input.credential.societe,
  };

  const keyBuffer = transformSecurityKey(input.credential.securityKey);
  const mac = computeMac(unsigned, keyBuffer);

  return {
    version: unsigned.version,
    TPE: unsigned.TPE,
    date: unsigned.date,
    montant: unsigned.montant,
    reference: unsigned.reference,
    lgue: unsigned.lgue,
    contexte_commande: unsigned.contexte_commande,
    societe: unsigned.societe,
    MAC: mac,
  };
}
