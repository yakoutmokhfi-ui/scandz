/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Normalisation déterministe des valeurs de ligne. PURE (aucune
 * dépendance externe hormis lib/catalogue-text.ts, déjà pur).
 */

import { normalizeText } from "@/lib/catalogue-text";

/**
 * Clé de correspondance catégorie/sous-catégorie/produit --
 * EXACTEMENT la même règle que l'index unique partiel en base
 * (`lower(btrim(name, E' \t\n\r\f' || chr(11)))`, voir
 * supabase/migration-v66-categories-descriptions.sql et
 * supabase/DRAFT-lot-catalogue-subcategories-backoffice-v1.sql) :
 * insensible à la casse, bordures d'espace retirées, **AUCUN retrait
 * d'accent** ("Café" et "Cafe" restent des clés DIFFÉRENTES,
 * exactement comme en base). Réutilisée ici pour le produit
 * également (mandat OB-3 : "restaurant + category + normalized
 * product name") -- décision documentée (IMPORT-CONTRACT.md) : bien
 * qu'aucune contrainte unique en base ne porte sur le nom de produit,
 * la MÊME règle de casse est appliquée pour rester cohérente avec le
 * seul précédent normatif existant dans ce dépôt.
 */
export function normalizedKey(raw: string): string {
  const { value } = normalizeText(raw, Number.POSITIVE_INFINITY);
  return value.toLowerCase();
}

/**
 * Coercion numérique tolérante au format français : accepte le point
 * OU la virgule comme séparateur décimal, ignore les espaces
 * (y compris insécables) et un symbole "€" final éventuel. Retourne
 * `null` si la valeur, une fois nettoyée, n'est pas un nombre fini
 * (jamais une valeur inventée par défaut) -- distinct de la chaîne
 * vide, qui retourne `undefined` (case "absente", pas "invalide").
 */
export function coerceNumeric(raw: string): number | null | undefined {
  // Retire les espaces ASCII ET insécables (séparateur de milliers
  // fréquent en export tableur FR, ex. "1 234,50 €" avec espace
  // insécable avant "€") avant de tester la valeur vide.
  const SPACE_CHARS = /[\u0020\u00a0]/g;
  const trimmed = raw.replace(SPACE_CHARS, "").trim();
  if (trimmed === "") return undefined;
  const cleaned = trimmed
    .replace(/€/g, "")
    .replace(/%/g, "")
    .replace(SPACE_CHARS, "")
    .trim()
    .replace(",", ".");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coercion entière stricte pour "Poids (g)" -- un poids doit être un
 * nombre entier de grammes (mandat : "invalid/non-positive weight").
 * Une valeur décimale (ex. "150,5") est traitée comme INVALIDE
 * plutôt qu'arrondie silencieusement -- jamais une conversion qui
 * modifierait la donnée source sans que l'opérateur ne le voie.
 */
export function coerceInteger(raw: string): number | null | undefined {
  const n = coerceNumeric(raw);
  if (n === undefined) return undefined;
  if (n === null) return null;
  return Number.isInteger(n) ? n : null;
}

/**
 * ONLINE WITHDRAWAL v1 — colonne « Rétractable » (classification
 * marchande de rétractabilité, voir CatalogueProduct.withdrawal_eligible).
 *
 * TROIS résultats DISTINCTS, exactement la même convention que
 * `coerceNumeric` ci-dessus (jamais un quatrième état implicite) :
 *
 *   `undefined` — colonne ABSENTE du fichier, ou cellule VIDE.
 *                 Sémantique métier : « inchangé » pour un produit
 *                 existant, « Non » (false) pour un produit créé.
 *                 Cette décision est prise par preview.ts, jamais ici
 *                 (ce module ne connaît pas le catalogue existant).
 *   `true`/`false` — valeur explicite « Oui » / « Non ».
 *   `null`      — valeur NON VIDE et NON RECONNUE : INVALIDE. Elle
 *                 remonte un diagnostic BLOQUANT par ligne
 *                 (validation.ts, SCANYM_IMPORT_INVALID_WITHDRAWAL_
 *                 ELIGIBLE) et ne devient JAMAIS silencieusement
 *                 `false` -- FAIL CLOSED : une valeur qu'on ne
 *                 comprend pas n'est pas une valeur qu'on applique.
 *
 * Correspondance ROBUSTE mais FINIE (même discipline que
 * ROW_TYPE_ALIASES ci-dessous / HEADER_ALIASES, column-mapping.ts) :
 * espaces de bordure retirés, espaces internes réduits, casse ignorée,
 * accents français normaux retirés. La valeur EXACTE produite par
 * l'export marchand (« Oui » / « Non », voir
 * lib/catalogue-management/export.ts) est donc relue telle quelle --
 * l'aller-retour export -> réimport est direct.
 */
export function coerceWithdrawalEligible(raw: string | undefined): boolean | null | undefined {
  if (raw === undefined) return undefined;
  const { value, isEmpty } = normalizeText(raw, Number.POSITIVE_INFINITY);
  if (isEmpty) return undefined;
  const mapped = WITHDRAWAL_ELIGIBLE_ALIASES.get(foldRowTypeValue(value));
  return mapped === undefined ? null : mapped;
}

const WITHDRAWAL_ELIGIBLE_ALIASES: ReadonlyMap<string, boolean> = new Map([
  ["oui", true],
  ["non", false],
]);

/**
 * XLSX / PRODUCT SERVICE MODES ROUND-TRIP v1 -- codes stables acceptés
 * dans la colonne « Modes de vente », EXACTEMENT ceux de
 * `sale_mode_catalog.code` (supabase/migration-v82-lot2a-sale-modes.sql).
 * Décision CIO/Ravel (issue #11) : jamais les libellés FR affichés
 * côté client (ex. `sale_mode_catalog.label` "Retrait" pour `pickup`
 * collisionne avec `lib/i18n.ts` "À emporter") -- format d'échange
 * volontairement DÉCOUPLÉ de toute traduction, v1 n'accepte AUCUN
 * alias de libellé.
 */
export const SALE_MODE_CODES: readonly string[] = [
  "table",
  "pickup",
  "click_collect",
  "room_service",
  "delivery",
];
const SALE_MODE_CODE_SET: ReadonlySet<string> = new Set(SALE_MODE_CODES);

/** Valeur littérale explicite de remise à ALL (mandat CIO/Ravel : « Le
 *  littéral `Tous` est l'instruction explicite d'effacer les
 *  restrictions et de remettre le produit à tous les modes de vente
 *  disponibles »). Comparaison insensible à la casse/accents/espaces,
 *  même discipline que ROW_TYPE_ALIASES. */
const ALL_SALE_MODES_LITERAL = "tous";

/**
 * Résultat de la coercion de la cellule « Modes de vente ». QUATRE
 * états DISTINCTS, jamais superposés (exigence CIO/Ravel explicite :
 * « do not overload null to mean both Tous/ALL and invalid » -- une
 * valeur mal formée ne doit jamais pouvoir devenir ALL par accident) :
 *
 *   - `unset`   -- colonne absente OU cellule vide : AUCUNE information
 *                  donnée par le fichier. Résolu par preview.ts selon
 *                  CREATE/UPDATE (jamais ici, ce module ne connaît pas
 *                  le catalogue existant) -- UPDATE -> restriction
 *                  ACTUELLE inchangée, CREATE -> ALL (défaut serveur).
 *   - `all`     -- littéral « Tous » : instruction EXPLICITE de
 *                  remettre à ALL (jamais confondu avec `unset`, même
 *                  si le résultat final côté CREATE est identique --
 *                  la distinction compte pour UPDATE : `unset` PRÉSERVE
 *                  l'existant, `all` l'EFFACE explicitement).
 *   - `codes`   -- ensemble de codes reconnus, valides, dédupliqués
 *                  (ordre de première apparition dans la cellule --
 *                  l'ordre CANONIQUE d'export est décidé séparément,
 *                  voir SALE_MODE_CODES).
 *   - `invalid` -- au moins un jeton non reconnu dans une cellule non
 *                  vide qui n'est pas le littéral « Tous ». BLOQUANT
 *                  (validation.ts, SCANYM_IMPORT_INVALID_SALE_MODE) --
 *                  jamais un repli silencieux vers `unset` ou `all`,
 *                  et un seul jeton invalide bloque TOUTE la cellule
 *                  (mandat CIO/Ravel : « do not silently ignore one
 *                  invalid token inside an otherwise valid list »).
 */
export type CoercedAllowedSaleModes =
  | { kind: "unset" }
  | { kind: "all" }
  | { kind: "codes"; codes: string[] }
  | { kind: "invalid" };

/**
 * Découpe et valide la cellule « Modes de vente ». Séparateur `;`
 * EXCLUSIVEMENT (mandat CIO/Ravel : « canonical stable codes, separated
 * by " ; " » -- format d'échange strict, jamais le double séparateur
 * virgule/point-virgule toléré pour « Tags / Collections », qui est
 * lui un champ informatif, pas un contrat d'écriture).
 */
export function coerceAllowedSaleModes(raw: string | undefined): CoercedAllowedSaleModes {
  if (raw === undefined) return { kind: "unset" };
  const { value, isEmpty } = normalizeText(raw, Number.POSITIVE_INFINITY);
  if (isEmpty) return { kind: "unset" };
  if (foldRowTypeValue(value) === ALL_SALE_MODES_LITERAL) return { kind: "all" };

  const tokens = value
    .split(";")
    .map((t) => normalizeText(t, Number.POSITIVE_INFINITY).value)
    .filter((t) => t !== "");
  // Cellule non vide mais ne contenant, après découpage, aucun jeton
  // exploitable (ex. simplement ";" ou ";;") -- jamais ALL, jamais un
  // ensemble de codes fantôme : traité comme `unset`, le repli le plus
  // sûr (préserve l'existant en UPDATE plutôt que d'inventer un état).
  if (tokens.length === 0) return { kind: "unset" };

  const seen = new Set<string>();
  const codes: string[] = [];
  for (const token of tokens) {
    const code = foldRowTypeValue(token);
    if (!SALE_MODE_CODE_SET.has(code)) return { kind: "invalid" };
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return { kind: "codes", codes };
}

/**
 * TYPE — CATEGORY / SUBCATEGORY ROW SUPPORT v1 (remplace la sémantique
 * OB-3 d'origine, ci-dessous documentée pour mémoire historique).
 *
 * ANCIENNE SÉMANTIQUE (OB-3, RETIRÉE PAR CE LOT -- c'était le bug) :
 * TOUTE valeur non vide de "Type" (y compris "Produit") était classée
 * UNSUPPORTED_DECISION_REQUIRED -- une classification purement
 * informative, JAMAIS utilisée pour faire varier la validation d'une
 * ligne. Conséquence directe : une ligne structurelle "Catégorie" ou
 * "Sous-catégorie" était validée EXACTEMENT comme un produit (Prix
 * TTC/TVA exigés), d'où les diagnostics erronés "Prix manquant"/"TVA
 * absente" sur des lignes qui ne sont pas des produits.
 *
 * NOUVELLE SÉMANTIQUE (ce lot) : "Type" est désormais AUTORITAIRE --
 * il détermine quel schéma de validation la ligne doit satisfaire
 * (mandat, "ROW-TYPE-AWARE VALIDATION" / "The authoritative import
 * parser / validation layer must understand the row type"). Trois
 * valeurs reconnues, chacune mappée à un ensemble d'alias EXPLICITE
 * et FINI (jamais une correspondance floue/heuristique -- même
 * discipline que HEADER_ALIASES, column-mapping.ts) :
 *   "Catégorie"       -> CATEGORY
 *   "Sous-catégorie"  -> SUBCATEGORY
 *   "Produit"         -> PRODUCT
 * Colonne absente ou cellule vide -> PRODUCT (comportement historique
 * préservé à l'identique : TOUTE ligne d'un fichier antérieur à ce
 * lot, qui ne renseignait jamais "Type", continue d'être traitée
 * exactement comme avant -- mandat item M, "Existing catalogue import
 * regression tests remain green" / column-mapping.ts, "Type" reste
 * une colonne OPTIONNELLE, décision inchangée par ce lot).
 * Toute autre valeur non vide -> UNKNOWN (mandat : "Do not silently
 * interpret unknown Type values. Unknown Type: BLOCK the row with a
 * clear diagnostic.") -- rawValue conservé pour le diagnostic.
 */
export type RowTypeClassification =
  | { kind: "CATEGORY" }
  | { kind: "SUBCATEGORY" }
  | { kind: "PRODUCT" }
  | { kind: "UNKNOWN"; rawValue: string };

/**
 * Repliement pour la SEULE comparaison de la valeur "Type" -- espaces
 * de bordure et espaces internes normalisés à un seul, casse ignorée,
 * accents français normaux retirés (mandat : "Matching must be robust
 * to: surrounding whitespace; case differences; normal French
 * accents."). JAMAIS utilisé pour `normalizedKey` (clé catégorie/
 * sous-catégorie/produit, qui reste délibérément SANS retrait d'accent
 * -- voir `normalizedKey` ci-dessus, RÈGLE INCHANGÉE par ce lot) : ce
 * repliement est strictement local à la reconnaissance du MOT-CLÉ
 * "Type", jamais des noms métier eux-mêmes. Même technique que
 * `foldAccents` (column-mapping.ts, résolution des alias d'en-tête),
 * dupliquée ici plutôt que partagée -- module normalization.ts
 * délibérément sans dépendance vers column-mapping.ts (sens inverse
 * existant : column-mapping.ts ne dépend pas non plus de ce module).
 */
function foldRowTypeValue(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Alias explicites, finis, documentés -- jamais une correspondance
// floue générique (même discipline que HEADER_ALIASES,
// column-mapping.ts). "sous categorie" (espace) ET "sous-categorie"
// (trait d'union) sont TOUS DEUX tolérés : même tolérance EXACTE déjà
// accordée à l'en-tête de colonne homonyme ("Sous-catégorie parent",
// voir HEADER_ALIASES) -- rester cohérent avec un précédent déjà
// établi dans ce même fichier de mandat, jamais une invention isolée.
const ROW_TYPE_ALIASES: ReadonlyMap<string, "CATEGORY" | "SUBCATEGORY" | "PRODUCT"> = new Map([
  ["categorie", "CATEGORY"],
  ["sous-categorie", "SUBCATEGORY"],
  ["sous categorie", "SUBCATEGORY"],
  ["produit", "PRODUCT"],
]);

export function classifyRowType(raw: string | undefined): RowTypeClassification {
  const { value, isEmpty } = normalizeText(raw ?? "", Number.POSITIVE_INFINITY);
  if (isEmpty) return { kind: "PRODUCT" };
  const mapped = ROW_TYPE_ALIASES.get(foldRowTypeValue(value));
  if (mapped) return { kind: mapped };
  return { kind: "UNKNOWN", rawValue: value };
}

/** Découpe "Tags / Collections" en valeurs individuelles -- séparateur
 *  virgule OU point-virgule, chaque valeur trim/dédupliquée
 *  (comparaison insensible à la casse), valeurs vides ignorées.
 *  Mandat : "Current published backend does not support tags/
 *  collections... Parse the column and surface: UNSUPPORTED IN
 *  CURRENT BACKEND" -- le découpage est fait pour AFFICHAGE
 *  informatif uniquement, jamais pour créer un schéma. */
export function splitTagsColumn(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const parts = raw
    .split(/[,;]/)
    .map((p) => normalizeText(p, Number.POSITIVE_INFINITY).value)
    .filter((p) => p !== "");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}
