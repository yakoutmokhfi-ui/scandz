import "server-only";
import type {
  BuildMoneticoRequestInput,
  MoneticoPaymentRequestFields,
} from "@/lib/server/payment-providers/monetico/types";
import type {
  MoneticoBillingContext,
  MoneticoShippingContext,
} from "@/lib/server/payment-providers/monetico/billing-mapping";
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
/** v2.0 §1.4.2.2, p.12-17, confirmé : le PROTOCOLE Monetico lui-même
 *  accepte "DE EN ES FR IT JA NL PT SV" (9 langues). PAYMENT STREAM B
 *  — MONETICO FINALIZATION (ferme MONETICO-LANGUAGE-01, gap vérifié
 *  par comparaison contre le document réel fourni pour Emmanuel) :
 *  la fiche paramètres RÉELLE de son contrat Monetico Online Starter
 *  ne confirme QUE "Français / Anglais" pour la page de paiement --
 *  jamais les 9 langues du protocole générique. AVANT ce correctif,
 *  cette liste acceptait les 9 valeurs du PROTOCOLE, alors que
 *  `language` est un champ contrôlé par le NAVIGATEUR (voir
 *  app/api/payments/monetico/checkout/route.ts, `body.language`) --
 *  un client aurait pu demander "DE"/"JA"/etc., valeur ACCEPTÉE par ce
 *  code mais NON supportée par le contrat Starter réel du marchand
 *  pilote, avec un rendu Monetico imprévisible en aval.
 *
 *  Comportement MINIMAL et SÛR retenu (mandat "choose the minimum
 *  safe behavior : strict supported mapping") : liste restreinte aux
 *  DEUX valeurs RÉELLEMENT couvertes par le contrat Starter vérifié.
 *  AUCUNE conversion silencieuse -- une valeur hors de cette liste
 *  échoue fermé (MONETICO_UNSUPPORTED_LANGUAGE, comportement déjà
 *  existant, INCHANGÉ), exactement comme pour toute autre valeur déjà
 *  invalide. Élargir cette liste pour un futur marchand Premium exige
 *  une décision d'architecture dédiée (configuration par marchand),
 *  explicitement HORS PÉRIMÈTRE de ce stream à marchand unique -- voir
 *  MONETICO-GAP-MATRIX.md, MONETICO-LANGUAGE-01. */
const DEFAULT_LANGUAGE = "FR";
const SUPPORTED_LANGUAGES = new Set(["FR", "EN"]);
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
 * INTÉRIEUR (objets billing/shipping/shoppingCart/client, Annexe 9.5)
 * a depuis été vérifié indépendamment (rapport "Monetico Annexe 9.5
 * verification", PAYMENT P3-B6) pour les seuls sous-objets
 * `billing`/`shipping` -- `shoppingCart`/`client` restent HORS
 * PÉRIMÈTRE (mandat P3-B6 §15) et ne sont JAMAIS ajoutés ici.
 *
 * RÉTROCOMPATIBILITÉ STRICTE (mandat P3-B6 §18, non-régression MAC) :
 * `billing`/`shipping` omis (aucun argument fourni) produit EXACTEMENT
 * le même JSON qu'avant ce lot (`{correlationId}` ou `{}`) -- aucun
 * test PAYMENT P3-A2 existant ne peut donc être affecté. `billing`
 * n'est ajouté que si fourni ; `shipping` de même, et INDÉPENDAMMENT
 * de `billing` (mandat §14 : la décision d'inclure `shipping`
 * n'implique jamais l'inclusion de `billing`, et réciproquement -- ce
 * fichier ne couple pas les deux). Le contenu de ces deux objets est
 * déjà entièrement mappé/validé par
 * `billing-mapping.ts::mapToMoneticoBilling`/`mapToMoneticoShipping`
 * AVANT d'atteindre cette fonction -- aucune validation, aucun mapping
 * de champ, n'est dupliqué ici.
 */
function buildContexteCommande(
  orderCorrelationId: string | undefined,
  billing?: MoneticoBillingContext,
  shipping?: MoneticoShippingContext
): string {
  const payload: {
    correlationId?: string;
    billing?: MoneticoBillingContext;
    shipping?: MoneticoShippingContext;
  } = {};
  if (orderCorrelationId) payload.correlationId = orderCorrelationId;
  if (billing) payload.billing = billing;
  if (shipping) payload.shipping = shipping;
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64");
}

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 — ferme
 * P3BV41-PREFLIGHT-01 : extrait la validation/canonicalisation de
 * `language` en fonction PURE, indépendamment appelable AVANT toute
 * mutation P1 (`initiatePaymentAttempt`). AUCUN changement de
 * comportement pour un appelant existant -- `buildMoneticoPaymentRequest`
 * ci-dessous délègue désormais à cette même fonction plutôt que de
 * dupliquer la logique (source de vérité UNIQUE, même liste
 * `SUPPORTED_LANGUAGES`/`DEFAULT_LANGUAGE`, v2.0 §1.4.2.2 p.12-17).
 * Valeur non fournie -> `DEFAULT_LANGUAGE` ("FR"), jamais un échec --
 * seule une valeur EXPLICITEMENT fournie et NON supportée échoue
 * fermé (`MoneticoProtocolError("MONETICO_UNSUPPORTED_LANGUAGE")`).
 */
export function canonicalizeMoneticoLanguage(language?: string): string {
  const canonical = (language ?? DEFAULT_LANGUAGE).toUpperCase();
  if (!SUPPORTED_LANGUAGES.has(canonical)) {
    throw new MoneticoProtocolError("MONETICO_UNSUPPORTED_LANGUAGE");
  }
  return canonical;
}

export function buildMoneticoPaymentRequest(
  input: BuildMoneticoRequestInput,
  now: Date = new Date()
): MoneticoPaymentRequestFields {
  // Revalide (jamais coûteux -- Set.has, mandat §6 "assembly from
  // already validated values" reste respecté : un appelant qui a déjà
  // canonicalisé via `canonicalizeMoneticoLanguage` obtient
  // exactement la même valeur en retour, ce n'est jamais un second
  // point de FAILLIBILITÉ nouveau, seulement une garde défensive
  // -- voir payment-checkout-runtime.ts, qui appelle désormais cette
  // fonction AVANT P1 et propage la valeur déjà canonicalisée ici).
  const language = canonicalizeMoneticoLanguage(input.language);

  // PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 -- chemin de REPRISE
  // (voir le commentaire de `BuildMoneticoRequestInput.reference` dans
  // types.ts) : `reference` fournie directement PREND STRICTEMENT
  // PRIORITÉ sur `referenceSeed`. Omise (tout appelant existant),
  // comportement BYTE-IDENTIQUE à avant ce lot.
  let reference: string;
  if (typeof input.reference === "string" && input.reference.length > 0) {
    reference = input.reference;
  } else if (typeof input.referenceSeed === "string" && input.referenceSeed.length > 0) {
    reference = deriveMoneticoReference(input.referenceSeed);
  } else {
    throw new MoneticoProtocolError("MONETICO_MISSING_REFERENCE_SOURCE");
  }
  const montant = formatMontant(input.amount, input.currency);
  const date = formatDate(now);
  const contexte_commande = buildContexteCommande(
    input.orderCorrelationId,
    input.billingContext,
    input.shippingContext
  );

  // Jeu de champs "reconnus" pour la signature sortante de CE lot --
  // les 8 champs obligatoires confirmés, PLUS url_retour_ok/
  // url_retour_err (PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3, ferme
  // V2-07) UNIQUEMENT s'ils sont fournis (voir canonicalization.ts :
  // le jeu "reconnu" pour la signature MAC est exactement l'ensemble
  // des clés de cet objet -- ajouter ces deux champs ICI, avant le
  // calcul du MAC, est ce qui les fait correctement entrer dans la
  // signature, exactement comme billing/shipping le font déjà via
  // contexte_commande). RÉTROCOMPATIBILITÉ STRICTE (mandat P3-B6 §18,
  // reprise à l'identique) : ni fourni -> objet BYTE-IDENTIQUE à avant
  // ce lot, MAC inchangé pour toute requête n'utilisant pas ces champs.
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
  if (typeof input.urlRetourOk === "string" && input.urlRetourOk.length > 0) {
    unsigned.url_retour_ok = input.urlRetourOk;
  }
  if (typeof input.urlRetourErr === "string" && input.urlRetourErr.length > 0) {
    unsigned.url_retour_err = input.urlRetourErr;
  }

  const keyBuffer = transformSecurityKey(input.credential.securityKey);
  const mac = computeMac(unsigned, keyBuffer);

  const fields: MoneticoPaymentRequestFields = {
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
  if (unsigned.url_retour_ok !== undefined) fields.url_retour_ok = unsigned.url_retour_ok;
  if (unsigned.url_retour_err !== undefined) fields.url_retour_err = unsigned.url_retour_err;
  return fields;
}
