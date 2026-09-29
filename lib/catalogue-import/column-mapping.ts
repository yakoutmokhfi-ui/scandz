/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Résolution de la ligne d'en-tête vers les colonnes attendues du
 * mandat. PURE (aucune dépendance externe).
 *
 * Colonnes attendues (mandat OB-3, "SUPPORTED INPUT"), dans l'ordre
 * documenté du format cible :
 *   Type, Nom, Catégorie parent, Sous-catégorie parent,
 *   Tags / Collections, Description courte, Description longue,
 *   Prix TTC (€), TVA (%), Poids (g), Photo fichier, Rétractable,
 *   Modes de vente.
 *
 * ONLINE WITHDRAWAL v1 -- « Rétractable » est une VRAIE colonne
 * d'aller-retour (jamais une colonne d'export purement informative,
 * comme « Disponible »/« Prix de référence (€/kg) ») : elle est
 * exportée ET relue à l'import. Optionnelle, valeurs « Oui »/« Non »
 * uniquement (voir coerceWithdrawalEligible, normalization.ts).
 *
 * XLSX / PRODUCT SERVICE MODES ROUND-TRIP v1 (issue #11, décision
 * CIO/Ravel) -- « Modes de vente » est elle aussi une VRAIE colonne
 * d'aller-retour, MÊME discipline exacte que « Rétractable » :
 * codes stables séparés par `;` (jamais les libellés FR affichés
 * côté client, voir coerceAllowedSaleModes, normalization.ts),
 * littéral « Tous » pour l'effacement EXPLICITE des restrictions.
 *
 * DÉCISION DOCUMENTÉE (IMPORT-CONTRACT.md) -- colonnes REQUISES vs
 * OPTIONNELLES : le mandat ne le précise pas explicitement ; la
 * décision retenue ici reflète EXACTEMENT ce que les RPC serveur
 * exigent déjà (create_product : p_name et p_price obligatoires,
 * p_category_id résolu depuis "Catégorie parent" obligatoire pour
 * pouvoir résoudre une catégorie) :
 *   REQUISES : Nom, Catégorie parent, Prix TTC (€)
 *   OPTIONNELLES : Type, Sous-catégorie parent, Tags / Collections,
 *   Description courte, Description longue, TVA (%), Poids (g),
 *   Photo fichier, Rétractable, Modes de vente.
 * Une colonne optionnelle absente du fichier ne bloque PAS l'import
 * (mandat "Do not invent semantics for ambiguous fields" -- une
 * colonne manquante n'est pas ambiguë, elle est simplement absente ;
 * chaque ligne aura cette valeur `null`, jamais une valeur inventée).
 */

export const IMPORT_COLUMNS = [
  "Type",
  "Nom",
  "Catégorie parent",
  "Sous-catégorie parent",
  "Tags / Collections",
  "Description courte",
  "Description longue",
  "Prix TTC (€)",
  "TVA (%)",
  "Poids (g)",
  "Photo fichier",
  // ONLINE WITHDRAWAL v1 -- ajoutée EN DERNIÈRE POSITION : tout
  // fichier antérieur à ce lot (qui ne la contient pas) reste importé
  // exactement comme avant, colonne simplement absente.
  "Rétractable",
  // XLSX / PRODUCT SERVICE MODES ROUND-TRIP v1 -- même discipline :
  // ajoutée APRÈS "Rétractable", en dernière position. Tout fichier
  // antérieur à ce lot reste importé exactement comme avant.
  "Modes de vente",
] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const REQUIRED_IMPORT_COLUMNS: readonly ImportColumn[] = ["Nom", "Catégorie parent", "Prix TTC (€)"];

/** Normalisation de l'en-tête pour la comparaison : trim + espaces
 *  internes réduits à un seul + insensible à la casse. Tolère les
 *  variantes bénignes ("Tags/Collections" sans espaces, "TVA(%)" sans
 *  espace avant la parenthèse) sans jamais deviner une colonne
 *  totalement différente -- la comparaison reste une égalité stricte
 *  après cette seule normalisation, jamais une correspondance floue/
 *  approximative (mandat "Do not invent semantics for ambiguous
 *  fields"). */
function normalizeHeader(raw: string): string {
  return raw
    .replace(/ /g, " ") // espace insécable -- fréquent en export tableur FR
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const NORMALIZED_TO_COLUMN: ReadonlyMap<string, ImportColumn> = new Map(
  IMPORT_COLUMNS.map((c) => [normalizeHeader(c), c])
);

// Variantes tolérées explicitement listées (jamais une correspondance
// floue générique) -- chacune documentée avec sa raison.
const HEADER_ALIASES: ReadonlyMap<string, ImportColumn> = new Map([
  ["tags/collections", "Tags / Collections"],
  ["tags", "Tags / Collections"],
  ["collections", "Tags / Collections"],
  ["prix ttc", "Prix TTC (€)"],
  ["prix ttc (eur)", "Prix TTC (€)"],
  ["tva", "TVA (%)"],
  ["poids", "Poids (g)"],
  ["categorie parent", "Catégorie parent"],
  ["sous categorie parent", "Sous-catégorie parent"],
  ["sous-categorie parent", "Sous-catégorie parent"],
  ["photo", "Photo fichier"],
  ["photo fichier", "Photo fichier"],
  // ONLINE WITHDRAWAL v1 -- seule variante tolérée : l'en-tête
  // canonique DÉSACCENTUÉ (« Retractable »), fréquent dans un tableur
  // configuré sans accents. Jamais une correspondance floue.
  ["retractable", "Rétractable"],
]);

/** Retire les accents pour la résolution des alias ci-dessus
 *  UNIQUEMENT (jamais pour la comparaison stricte des en-têtes
 *  canoniques ni pour la normalisation catégorie/sous-catégorie/
 *  produit, qui reste explicitement SANS retrait d'accent -- voir
 *  lib/catalogue-import/normalization.ts). */
function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export interface ColumnMap {
  /** index de colonne (0-based) pour chaque colonne reconnue,
   *  `undefined` si absente du fichier. */
  indexOf: Partial<Record<ImportColumn, number>>;
  missingRequired: ImportColumn[];
  /** En-têtes du fichier qui n'ont correspondu à AUCUNE colonne
   *  connue -- surfacé en INFO, jamais une erreur (un fichier peut
   *  légitimement contenir des colonnes supplémentaires ignorées). */
  unrecognizedHeaders: string[];
}

/** Résout la ligne d'en-tête -> ColumnMap. Ne devine JAMAIS une
 *  colonne ambiguë : une correspondance qui n'est ni exacte ni dans
 *  la liste d'alias explicite ci-dessus est simplement "non
 *  reconnue". */
export function resolveColumnMap(headerRow: string[]): ColumnMap {
  const indexOf: Partial<Record<ImportColumn, number>> = {};
  const unrecognizedHeaders: string[] = [];

  headerRow.forEach((raw, index) => {
    const normalized = normalizeHeader(raw);
    if (normalized === "") return;
    let column = NORMALIZED_TO_COLUMN.get(normalized);
    if (!column) {
      column = HEADER_ALIASES.get(foldAccents(normalized));
    }
    if (column) {
      // Première occurrence gagne (une colonne dupliquée dans
      // l'en-tête garde son premier index -- décision déterministe,
      // jamais la dernière valeur écrasant silencieusement).
      if (indexOf[column] === undefined) indexOf[column] = index;
    } else {
      unrecognizedHeaders.push(raw);
    }
  });

  const missingRequired = REQUIRED_IMPORT_COLUMNS.filter((c) => indexOf[c] === undefined);

  return { indexOf, missingRequired, unrecognizedHeaders };
}
