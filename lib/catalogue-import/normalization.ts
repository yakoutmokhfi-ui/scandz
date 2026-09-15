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
