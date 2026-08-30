import "server-only";
import { createHash } from "node:crypto";

/**
 * PAYMENT P3-B5 v2 — DURABLE PROVIDER CALLBACK INBOX.
 *
 * MISE À JOUR v2 (ferme P3B5-FINGERPRINT-01) : la candidate v1 laissait
 * un appelant calculer `event_fingerprint` à partir de valeurs BRUTES,
 * indépendamment de toute normalisation SQL (espaces superflus,
 * `"10.0"` vs `"10.00"`, chaîne vide vs absente), ET acceptait un
 * fingerprint fourni tel quel par l'appelant sans lien prouvé avec les
 * champs réellement envoyés à la RPC. Cela permettait plusieurs
 * fingerprints différents pour un même évènement logique normalisé
 * (rejeu manqué) et une injection de fingerprint arbitraire.
 *
 * CORRECTION v2 : une SEULE autorité de canonicalisation
 * (`canonicalizePaymentProviderEventFields`) s'exécute AVANT tout
 * calcul de hachage. `computePaymentProviderEventFingerprint` n'accepte
 * plus que des champs DÉJÀ canoniques -- il est structurellement
 * impossible d'appeler cette fonction avec une valeur non normalisée
 * sans passer explicitement outre le typage. Le wrapper serveur
 * `recordPaymentProviderEvent` (lib/server/payment-service.ts) :
 *   1. canonicalise les champs bruts reçus ;
 *   2. calcule le fingerprint à partir de CES MÊMES valeurs
 *      canoniques ;
 *   3. envoie CES MÊMES valeurs canoniques (jamais les brutes) à
 *      `record_payment_provider_event`.
 * Aucun écart n'est donc plus possible entre ce qui est haché et ce
 * qui est stocké. Voir FINGERPRINT-CANONICALIZATION-MATRIX.txt pour la
 * table complète champ / règle d'entrée / valeur canonique / valeur
 * stockée / valeur de fingerprint, et P3B5-FINGERPRINT-01-CLOSURE-
 * REPORT.txt pour la preuve de fermeture.
 *
 * DÉCISION INCHANGÉE (mandat P3-B5 v2 section 20, acceptée
 * explicitement) : SHA-256 COMPLET, calculé ICI en TypeScript via
 * `node:crypto`, JAMAIS dans PostgreSQL/pgcrypto -- cette extension
 * n'est toujours pas prouvée active sur le projet Supabase réel. La
 * RPC continue de valider UNIQUEMENT la FORME du fingerprint reçu
 * (exactement 64 caractères hexadécimaux minuscules) -- acceptable ICI
 * car (a) seule cette fonction de canonicalisation, appelée
 * exclusivement par le wrapper serveur de confiance, produit jamais un
 * fingerprint envoyé à la RPC, (b) aucun autre chemin d'écriture
 * n'existe (RPC-only, service_role uniquement), et (c) l'alignement
 * exact canonique/stocké/fingerprint est prouvé par une matrice de
 * tests dédiée (voir tests/v117-payment-p3b5-service.test.ts).
 */

/**
 * Champs BRUTS tels qu'un futur adaptateur/orchestrateur (hors
 * périmètre de ce lot) les posséderait après avoir authentifié un
 * évènement prestataire -- PAS ENCORE canonicalisés. C'est le type
 * d'entrée public de `recordPaymentProviderEvent`.
 */
export interface RawPaymentProviderEventFields {
  providerCode: string;
  providerReference: string;
  providerEventType: string;
  providerEventCode?: string;
  /** Représentation textuelle d'un montant décimal (ex. "10", "10.0",
   *  "10.00"). Canonicalisée en exactement 2 décimales avant hachage
   *  ET avant envoi à la RPC -- voir `canonicalizePaymentProviderEventFields`. */
  amount?: string;
  currency?: string;
  authorizationReference?: string;
}

/**
 * Champs APRÈS canonicalisation -- EXACTEMENT les valeurs qui seront
 * (a) hachées pour produire `event_fingerprint`, et (b) envoyées à
 * `record_payment_provider_event`. Un champ optionnel absent, vide, ou
 * blanc après normalisation devient explicitement `null` -- jamais
 * `undefined` ni une chaîne vide -- pour qu'une seule représentation
 * canonique existe par valeur logique (mandat section 14, "one
 * representation").
 */
export interface CanonicalPaymentProviderEventFields {
  providerCode: string;
  providerReference: string;
  providerEventType: string;
  providerEventCode: string | null;
  amount: string | null;
  currency: string | null;
  authorizationReference: string | null;
}

/**
 * Levée UNIQUEMENT par `canonicalizePaymentProviderEventFields`
 * lorsqu'un champ ne peut être canonicalisé de façon non ambiguë (à ce
 * jour : uniquement `amount` mal formé). Erreur de validation locale,
 * levée AVANT tout appel réseau/RPC -- ne contient aucune donnée
 * secrète, seulement le nom du champ en cause (jamais la valeur brute
 * elle-même, par prudence).
 */
export class PaymentProviderEventCanonicalizationError extends Error {
  /** Nom du champ canonicalisé fautif (ex. "amount") -- jamais la
   *  valeur brute elle-même. Champ déclaré explicitement (pas une
   *  propriété de paramètre TypeScript) : le runtime de test de ce
   *  dépôt exécute le TypeScript en mode "strip-only"
   *  (`--experimental-strip-types`), qui ne supporte PAS les
   *  raccourcis `constructor(public readonly x: T)` -- voir
   *  node:internal/modules/typescript ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "PaymentProviderEventCanonicalizationError";
    this.field = field;
  }
}

/**
 * Un entier optionnellement suivi d'au plus 2 décimales, signe
 * optionnel -- exactement ce que `numeric(12,2)` peut représenter sans
 * perte ni arrondi implicite. Mandat section 15 : "reject values
 * requiring unintended rounding... do not silently round unsafe input."
 * N'exclut PAS les zéros non significatifs ("0010.00") ni le zéro
 * signé ("-0.00") -- ceux-ci sont syntaxiquement valides mais
 * sémantiquement équivalents à une forme plus courte ; c'est
 * `normalizeAmountExact` ci-dessous, PAS ce motif, qui les réduit à LA
 * représentation canonique unique (ferme P3B5-FINGERPRINT-01 v3).
 * AUCUNE notation exponentielle n'est acceptée (le motif ne contient
 * aucun "e"/"E") -- mandat v3 section 4, "no exponent notation unless
 * explicitly supported and normalized safely" : ce lot ne la supporte
 * pas du tout, donc elle est rejetée comme n'importe quelle syntaxe
 * invalide, jamais silencieusement acceptée.
 */
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * `numeric(12,2)` = 12 chiffres significatifs au total, 2 après la
 * virgule -- donc AU PLUS 10 chiffres avant la virgule. Vérifié
 * empiriquement contre une vraie base PostgreSQL 16 : 9999999999.99
 * est accepté, 99999999999.99 (11 chiffres entiers) lève "numeric
 * field overflow" (DETAIL: "must round to an absolute value less than
 * 10^10"). Mandat v3 section 4 : "enforce numeric(12,2)-compatible
 * scale/range" -- vérifié ICI, en amont de tout appel RPC, plutôt que
 * de laisser PostgreSQL le découvrir après un aller-retour réseau.
 */
const MAX_INTEGER_DIGITS_FOR_NUMERIC_12_2 = 10;

/**
 * Normalise EXACTEMENT (mandat v3 section 3 : "no floating-point
 * Number arithmetic that can introduce precision drift... use an
 * exact decimal/string-based normalization strategy") une chaîne de
 * montant déjà validée par AMOUNT_PATTERN vers LA représentation
 * canonique unique correspondant à la valeur `numeric(12,2)` que
 * PostgreSQL stockerait pour cette même valeur logique. AUCUNE
 * conversion via `Number`/`parseFloat` n'intervient nulle part --
 * uniquement des opérations de chaîne (slice/replace/padding) sur les
 * chiffres décimaux tels qu'écrits, donc aucune dérive de précision
 * flottante n'est possible même pour des valeurs proches des bornes de
 * numeric(12,2).
 *
 * Étapes (mandat v3 section 4, une par une) :
 *   1. Séparer le signe (le motif garantit qu'il n'y a qu'un seul "-"
 *      optionnel en tête, jamais ailleurs).
 *   2. Séparer partie entière / partie fractionnaire sur le point
 *      décimal restant (absent -> partie fractionnaire vide).
 *   3. Retirer les zéros non significatifs EN TÊTE de la partie
 *      entière ("0010" -> "10", "00010" -> "10") -- en conservant au
 *      moins un chiffre ("0" reste "0", jamais une chaîne vide).
 *   4. Compléter/tronquer la partie fractionnaire à EXACTEMENT 2
 *      chiffres (le motif garantit déjà qu'il y en a au plus 2, donc
 *      ceci ne fait que compléter avec des zéros de fin si 0 ou 1
 *      chiffre étaient fournis -- jamais un arrondi, une simple
 *      complétion positionnelle).
 *   5. Détecter la valeur zéro (partie entière "0" ET partie
 *      fractionnaire "00") et forcer la représentation canonique
 *      UNIQUE "0.00", SANS signe -- élimine le zéro négatif ("-0.00"
 *      -> "0.00") : mandat v3 section 4, "no negative zero".
 *   6. Sinon, réappliquer le signe (si présent) devant la partie
 *      entière normalisée -- une valeur non nulle CONSERVE son signe,
 *      "-10.00" reste distincte de "10.00" (mandat v3 section 4,
 *      "meaningfully distinct values must remain distinct").
 *   7. Rejeter (échec fermé) si la partie entière normalisée dépasse
 *      la plage numeric(12,2) (>10 chiffres) -- jamais un
 *      débordement silencieux découvert seulement à l'insertion SQL.
 */
function normalizeAmountExact(validated: string): string {
  const negative = validated.startsWith("-");
  const unsigned = negative ? validated.slice(1) : validated;
  const [rawIntegerPart, rawFractionPart = ""] = unsigned.split(".");

  let integerPart = rawIntegerPart.replace(/^0+(?=\d)/, "");
  if (integerPart.length === 0) {
    integerPart = "0";
  }
  if (integerPart.length > MAX_INTEGER_DIGITS_FOR_NUMERIC_12_2) {
    throw new PaymentProviderEventCanonicalizationError(
      "amount",
      `amount dépasse la plage numeric(12,2) (au plus ${MAX_INTEGER_DIGITS_FOR_NUMERIC_12_2} chiffres avant la virgule attendus)`
    );
  }

  const fractionPart = (rawFractionPart + "00").slice(0, 2);

  const isCanonicalZero = integerPart === "0" && fractionPart === "00";
  if (isCanonicalZero) {
    return "0.00";
  }

  return `${negative ? "-" : ""}${integerPart}.${fractionPart}`;
}

/** `undefined`, `null`, `""`, ou une chaîne blanche deviennent tous
 *  `null` -- une seule représentation canonique pour "champ absent"
 *  (mandat section 14). Sinon, la valeur est simplement recadrée
 *  (trim). */
function canonicalizeOptionalTrimmedField(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Canonicalise les champs BRUTS d'un évènement prestataire en la
 * représentation UNIQUE qui sera à la fois hachée et stockée. Doit
 * être appelée AVANT tout calcul de fingerprint et avant tout appel à
 * `record_payment_provider_event` -- `recordPaymentProviderEvent`
 * (lib/server/payment-service.ts) est le SEUL appelant prévu.
 *
 * RÈGLES EXACTES (voir FINGERPRINT-CANONICALIZATION-MATRIX.txt pour la
 * justification détaillée de chacune) :
 *   providerCode            trim uniquement, casse PRÉSERVÉE (même
 *                           convention que PAYMENT P1/P3-B0..B4 --
 *                           aucun de ces lots ne met en minuscule
 *                           provider_code).
 *   providerReference       trim uniquement, casse PRÉSERVÉE (référence
 *                           opaque émise par le prestataire -- aucune
 *                           transformation non prouvée sûre, mandat
 *                           section 13).
 *   providerEventType       trim uniquement, casse PRÉSERVÉE (même
 *                           convention que providerCode -- classification
 *                           générique ouverte, jamais une énumération
 *                           fermée).
 *   providerEventCode       trim, "" -> null.
 *   currency                trim PUIS uppercase, "" -> null (ISO 4217
 *                           est canoniquement majuscule -- AJOUT
 *                           délibéré v2, aucune distinction sémantique
 *                           perdue).
 *   authorizationReference  trim, "" -> null (valeur bancaire opaque --
 *                           casse PRÉSERVÉE, même rationale que
 *                           providerReference).
 *   amount                  normalisé de façon EXACTE (chaîne de
 *                           caractères uniquement, AUCUNE arithmétique
 *                           `Number`/`parseFloat`) vers la
 *                           représentation numeric(12,2) canonique :
 *                           zéros non significatifs retirés
 *                           ("0010.00"/"00010" -> "10.00"), complétée à
 *                           EXACTEMENT 2 décimales ("10"/"10.0" ->
 *                           "10.00"), zéro canonique UNIQUE SANS signe
 *                           ("-0.00"/"0"/"0.0" -> "0.00"). Rejette
 *                           (lève PaymentProviderEventCanonicalizationError)
 *                           toute valeur non numérique, nécessitant un
 *                           arrondi (plus de 2 décimales), ou hors
 *                           plage numeric(12,2) (plus de 10 chiffres
 *                           avant la virgule) -- JAMAIS un arrondi ni
 *                           un débordement silencieux (mandat section
 *                           15, mandat v3 section 3/4). Voir
 *                           `normalizeAmountExact` ci-dessus et
 *                           FINGERPRINT-CANONICALIZATION-MATRIX.txt.
 *
 * NE VALIDE PAS au-delà de ce qui est nécessaire à une canonicalisation
 * non ambiguë (ex. la paire amount/currency, le jeu de caractères de
 * provider_code) -- `record_payment_provider_event` reste l'autorité
 * fail-closed pour tout le reste, exactement comme avant.
 */
export function canonicalizePaymentProviderEventFields(
  raw: RawPaymentProviderEventFields
): CanonicalPaymentProviderEventFields {
  let canonicalAmount: string | null = null;
  if (raw.amount !== undefined && raw.amount !== null) {
    const trimmedAmount = raw.amount.trim();
    if (trimmedAmount.length === 0) {
      canonicalAmount = null;
    } else if (!AMOUNT_PATTERN.test(trimmedAmount)) {
      throw new PaymentProviderEventCanonicalizationError(
        "amount",
        "amount doit être un nombre décimal avec au plus 2 décimales (aucun arrondi implicite autorisé)"
      );
    } else {
      canonicalAmount = normalizeAmountExact(trimmedAmount);
    }
  }

  const canonicalCurrency = canonicalizeOptionalTrimmedField(raw.currency);

  return {
    providerCode: raw.providerCode.trim(),
    providerReference: raw.providerReference.trim(),
    providerEventType: raw.providerEventType.trim(),
    providerEventCode: canonicalizeOptionalTrimmedField(raw.providerEventCode),
    amount: canonicalAmount,
    currency: canonicalCurrency === null ? null : canonicalCurrency.toUpperCase(),
    authorizationReference: canonicalizeOptionalTrimmedField(raw.authorizationReference),
  };
}

/**
 * Retourne exactement 64 caractères hexadécimaux minuscules (SHA-256
 * non tronqué) -- la forme exacte validée par la contrainte CHECK
 * `event_fingerprint ~ '^[0-9a-f]{64}$'` côté base. N'accepte QUE des
 * champs déjà canoniques (`CanonicalPaymentProviderEventFields`) --
 * structurellement impossible de hacher une valeur brute non
 * normalisée sans contourner explicitement le typage.
 *
 * CANONICALISATION DE SÉRIALISATION (inchangée depuis v1) :
 * `JSON.stringify` d'un tableau ORDONNÉ de longueur fixe (7 éléments)
 * -- préféré à une concaténation par délimiteur pour éviter l'ambiguïté
 * classique ("AB"+"C" vs "A"+"BC") et pour distinguer structurellement
 * `null` (champ canonique absent) d'une chaîne vide (impossible ici
 * puisque la canonicalisation élimine déjà toute chaîne vide -- voir
 * `canonicalizeOptionalTrimmedField`).
 */
export function computePaymentProviderEventFingerprint(
  canonical: CanonicalPaymentProviderEventFields
): string {
  const canonicalArray: Array<string | null> = [
    canonical.providerCode,
    canonical.providerReference,
    canonical.providerEventType,
    canonical.providerEventCode,
    canonical.amount,
    canonical.currency,
    canonical.authorizationReference,
  ];
  const serialized = JSON.stringify(canonicalArray);

  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
