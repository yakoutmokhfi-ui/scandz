/**
 * Scanym — TRANSLATIONS MANAGEMENT v2.
 * Import de traductions depuis un classeur Excel. PUR : ce module ne
 * fait AUCUNE écriture et n'accède à AUCUN réseau -- il LIT, VALIDE et
 * produit un APERÇU. L'écriture n'a lieu qu'après confirmation
 * explicite du commerçant, ligne par ligne, via la RPC existante
 * `write_translation` (voir lib/services/translations-import.ts) :
 * aucune RPC d'import en masse n'est introduite, donc AUCUNE
 * validation serveur n'est contournée.
 *
 * ------------------------------------------------------------------
 * DEUX PHASES (mandat §12) -- non négociable
 * ------------------------------------------------------------------
 *   Phase 1 : `buildTranslationImportPreview` -- lecture + validation
 *             + aperçu. AUCUNE mutation.
 *   Phase 2 : l'écran n'écrit QUE les lignes classées `applicable`, et
 *             seulement après un clic de confirmation explicite.
 *
 * ------------------------------------------------------------------
 * CONCURRENCE / SOURCE PÉRIMÉE (mandat §13) -- politique RETENUE
 * ------------------------------------------------------------------
 * - `source_hash` du fichier différent du hash source ACTUEL :
 *   la ligne est classée `stale_source` et N'EST JAMAIS ÉCRITE. Le
 *   texte source a changé depuis l'export : écrire la traduction
 *   telle quelle (a fortiori en « validée ») affirmerait une
 *   correspondance qui n'existe plus. Le commerçant doit ré-exporter.
 * - Ligne qui écraserait une traduction DÉJÀ VALIDÉE :
 *   REFUSÉE PAR DÉFAUT, classée `overwrites_validated` et affichée
 *   explicitement dans l'aperçu. Elle ne devient applicable QUE si le
 *   commerçant coche explicitement l'option d'écrasement
 *   (`allowOverwriteValidated`) -- deuxième consentement, distinct de
 *   la confirmation d'import.
 * - Aucune de ces deux décisions n'est silencieuse : chaque ligne
 *   rejetée est comptée et listée avec son numéro de ligne Excel.
 */
import { readXlsxWorkbook } from "@/lib/catalogue-import/xlsx-reader";
import { getTranslationStatus } from "@/lib/translation-resolver";
import {
  isTranslatableField,
  type TranslationEntityType,
  type TranslationRow,
} from "@/lib/translations-management/rows";
import { TRANSLATION_EXPORT_COLUMNS } from "@/lib/translations-management/export";

/** Colonnes REQUISES dans le fichier importé -- exactement celles que
 *  l'export produit (aller-retour direct, jamais un second format). */
export const REQUIRED_IMPORT_COLUMNS = [
  "entity_type",
  "entity_id",
  "field",
  "target_language",
  "translation",
] as const;

export type ImportRowVerdict =
  | "applicable"
  | "unknown_entity"
  | "unsupported_entity_type"
  | "invalid_field"
  | "wrong_language"
  | "source_language"
  | "stale_source"
  | "duplicate"
  | "invalid_status"
  | "empty_translation"
  | "overwrites_validated";

/** Un verdict autre que `applicable` n'est JAMAIS écrit. */
export interface TranslationImportRow {
  /** Numéro de ligne tel qu'affiché dans Excel (1-based). */
  excelRow: number;
  entityType: string;
  entityId: string;
  field: string;
  targetLanguage: string;
  translation: string;
  status: "to_review" | "validated";
  sourceHash: string | null;
  verdict: ImportRowVerdict;
  /** Contexte lisible de l'entité reconnue (jamais utilisé pour
   *  l'identifier). */
  label: string | null;
}

export interface TranslationImportPreview {
  totalRows: number;
  recognizedRows: number;
  applicableRows: number;
  rows: TranslationImportRow[];
  counts: Record<ImportRowVerdict, number>;
  /** Erreur de STRUCTURE du fichier (colonnes manquantes, feuille
   *  vide…) : dans ce cas `rows` est vide et rien n'est applicable. */
  fileError: string | null;
}

export interface TranslationImportContext {
  /** Lignes traduisibles RÉELLES de l'établissement courant (SEULE
   *  référence d'existence ET d'appartenance : une entité d'un autre
   *  commerçant est structurellement absente de cette liste, donc
   *  classée `unknown_entity`). */
  rows: ReadonlyArray<TranslationRow>;
  /** Langue source de l'établissement -- écriture interdite. */
  sourceLanguage: string;
  /** Langues ACTIVES de l'établissement (codes). */
  activeLanguages: ReadonlyArray<string>;
  /** Langue cible attendue : une ligne visant une autre langue est
   *  refusée (`wrong_language`) même si cette langue est active --
   *  l'import travaille sur UNE langue à la fois, comme l'export. */
  targetLanguage: string;
  allowOverwriteValidated?: boolean;
}

function emptyCounts(): Record<ImportRowVerdict, number> {
  return {
    applicable: 0,
    unknown_entity: 0,
    unsupported_entity_type: 0,
    invalid_field: 0,
    wrong_language: 0,
    source_language: 0,
    stale_source: 0,
    duplicate: 0,
    invalid_status: 0,
    empty_translation: 0,
    overwrites_validated: 0,
  };
}

function headerIndex(header: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((raw, i) => {
    const key = raw.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
}

/** Lecture BRUTE du classeur -- séparée de la validation pour rester
 *  testable sans fichier binaire. */
export function parseTranslationWorkbook(buffer: ArrayBuffer): {
  header: string[];
  rows: string[][];
  rowNumbers: number[];
} {
  const sheet = readXlsxWorkbook(buffer);
  const [header = [], ...rest] = sheet.rows;
  return { header, rows: rest, rowNumbers: sheet.rowNumbers.slice(1) };
}

/**
 * PHASE 1 -- validation complète, aucune écriture.
 *
 * Toutes les lignes du fichier sont conservées dans l'aperçu avec leur
 * verdict : une ligne rejetée est VISIBLE, jamais silencieusement
 * ignorée.
 */
export function buildTranslationImportPreview(
  parsed: { header: readonly string[]; rows: ReadonlyArray<ReadonlyArray<string>>; rowNumbers: ReadonlyArray<number> },
  context: TranslationImportContext
): TranslationImportPreview {
  const counts = emptyCounts();
  const index = headerIndex(parsed.header);

  const missing = REQUIRED_IMPORT_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    return {
      totalRows: parsed.rows.length,
      recognizedRows: 0,
      applicableRows: 0,
      rows: [],
      counts,
      fileError: `Colonnes obligatoires absentes : ${missing.join(", ")}. Le fichier attendu est celui produit par « Exporter les traductions » (colonnes : ${TRANSLATION_EXPORT_COLUMNS.join(", ")}).`,
    };
  }

  // Index des lignes RÉELLES par (type, id, champ) -- l'appartenance au
  // bon établissement est garantie par construction (voir contexte).
  const byKey = new Map<string, TranslationRow>();
  for (const row of context.rows) {
    byKey.set(`${row.entityType}\u0000${row.entityId}\u0000${row.field}`, row);
  }

  const seen = new Set<string>();
  const out: TranslationImportRow[] = [];

  const cell = (row: ReadonlyArray<string>, column: string): string =>
    (row[index.get(column) ?? -1] ?? "").trim();

  parsed.rows.forEach((raw, i) => {
    const entityType = cell(raw, "entity_type");
    const entityId = cell(raw, "entity_id");
    const field = cell(raw, "field");
    const targetLanguage = cell(raw, "target_language");
    const translation = (raw[index.get("translation") ?? -1] ?? "").trim();
    const statusRaw = index.has("status") ? cell(raw, "status") : "";
    const sourceHash = index.has("source_hash") ? cell(raw, "source_hash") : "";
    const excelRow = parsed.rowNumbers[i] ?? i + 2;

    // Une ligne entièrement vide (fin de fichier Excel) n'est pas une
    // erreur : elle n'est simplement pas une ligne d'import.
    if (!entityType && !entityId && !field && !translation) return;

    const key = `${entityType}\u0000${entityId}\u0000${field}\u0000${targetLanguage}`;
    const entity = byKey.get(`${entityType}\u0000${entityId}\u0000${field}`);

    // STATUT IMPORTÉ -- règle explicite :
    //   - `validated` est la SEULE valeur qui demande une validation ;
    //   - `to_review`, ainsi que les statuts DÉRIVÉS que notre propre
    //     export écrit pour information (`missing`, `stale`) et une
    //     cellule vide, valent « à relire » -- le choix prudent, pour
    //     qu'un fichier exporté puis complété se réimporte sans piège ;
    //   - toute autre valeur est REFUSÉE (jamais devinée).
    // « stale » n'est jamais écrit en base : c'est un statut dérivé en
    // lecture, ici seulement toléré EN ENTRÉE de fichier.
    const TO_REVIEW_EQUIVALENTS = ["", "to_review", "missing", "stale"];
    let status: "to_review" | "validated" = "to_review";
    let verdict: ImportRowVerdict = "applicable";

    if (statusRaw === "validated") {
      status = "validated";
    } else if (!TO_REVIEW_EQUIVALENTS.includes(statusRaw)) {
      verdict = "invalid_status";
    }

    const knownTypes: TranslationEntityType[] = [
      "restaurant",
      "category",
      "subcategory",
      "item",
      "customer_notice",
    ];
    if (verdict === "applicable" && !knownTypes.includes(entityType as TranslationEntityType)) {
      verdict = "unsupported_entity_type";
    } else if (verdict === "applicable" && !isTranslatableField(entityType, field)) {
      verdict = "invalid_field";
    } else if (verdict === "applicable" && targetLanguage === context.sourceLanguage) {
      // Écriture dans la langue source : interdite côté serveur, donc
      // refusée ici AVANT tout appel (jamais un aller-retour inutile,
      // jamais un contrôle qui remplacerait celui du serveur).
      verdict = "source_language";
    } else if (
      verdict === "applicable" &&
      (targetLanguage !== context.targetLanguage || !context.activeLanguages.includes(targetLanguage))
    ) {
      verdict = "wrong_language";
    } else if (verdict === "applicable" && !entity) {
      // Entité inconnue OU appartenant à un autre établissement : même
      // verdict, car l'écran ne doit jamais révéler l'existence d'une
      // entité d'un autre locataire.
      verdict = "unknown_entity";
    } else if (verdict === "applicable" && translation === "") {
      verdict = "empty_translation";
    } else if (verdict === "applicable" && seen.has(key)) {
      verdict = "duplicate";
    } else if (
      verdict === "applicable" &&
      entity &&
      (entity.sourceHash ?? "") !== "" &&
      sourceHash !== "" &&
      sourceHash !== entity.sourceHash
    ) {
      verdict = "stale_source";
    } else if (verdict === "applicable" && entity) {
      const current = getTranslationStatus(
        entity.sourceHash,
        entity.translations,
        targetLanguage,
        field
      );
      const stored = entity.translations?.[targetLanguage]?.[field] ?? "";
      if (current === "validated" && stored !== translation && !context.allowOverwriteValidated) {
        verdict = "overwrites_validated";
      }
    }

    if (verdict === "applicable") seen.add(key);
    counts[verdict] += 1;
    out.push({
      excelRow,
      entityType,
      entityId,
      field,
      targetLanguage,
      translation,
      status,
      sourceHash: sourceHash || null,
      verdict,
      label: entity ? entity.entityLabel : null,
    });
  });

  return {
    totalRows: out.length,
    recognizedRows: out.filter((r) => r.verdict !== "unknown_entity" && r.verdict !== "unsupported_entity_type").length,
    applicableRows: counts.applicable,
    rows: out,
    counts,
    fileError: null,
  };
}

/** Lignes réellement écrites en phase 2 -- UNIQUEMENT `applicable`. */
export function applicableImportRows(
  preview: TranslationImportPreview
): TranslationImportRow[] {
  return preview.rows.filter((row) => row.verdict === "applicable");
}

export const IMPORT_VERDICT_LABELS: Record<ImportRowVerdict, string> = {
  applicable: "Sera importée",
  unknown_entity: "Élément inconnu pour cet établissement",
  unsupported_entity_type: "Type d'élément non pris en charge",
  invalid_field: "Champ non traduisible pour ce type d'élément",
  wrong_language: "Langue différente de la langue à importer, ou langue inactive",
  source_language: "Écriture dans la langue source (interdite)",
  stale_source: "Texte source modifié depuis l'export (ré-exporter)",
  duplicate: "Ligne en double dans le fichier",
  invalid_status: "Statut invalide (attendu : to_review, validated, missing ou stale)",
  empty_translation: "Traduction vide",
  overwrites_validated: "Écraserait une traduction déjà validée",
};
