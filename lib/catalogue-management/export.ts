/**
 * Scanym — CATALOGUE MANAGEMENT UX v1.
 * Export du catalogue marchand en .xlsx. PURE : aucun accès réseau,
 * aucune écriture disque, aucun état -- la fonction produit des
 * octets, l'écran se charge de les proposer au téléchargement.
 *
 * ------------------------------------------------------------------
 * COMPATIBILITÉ IMPORT / EXPORT (mandat §12)
 * ------------------------------------------------------------------
 * Les 14 premières colonnes sont EXACTEMENT `IMPORT_COLUMNS`, dans
 * l'ordre exact du format d'import -- réutilisées depuis
 * lib/catalogue-import/column-mapping.ts, jamais recopiées à la main,
 * de sorte qu'elles ne peuvent pas diverger silencieusement si le
 * format d'import évolue.
 *
 * Le cycle « exporter -> le marchand modifie -> réimporter » est donc
 * direct, et prouvé par un test d'aller-retour RÉEL : le classeur
 * produit ici est relu par `readXlsxWorkbook`, le lecteur d'import de
 * production, jamais par un parseur de test.
 *
 * ONLINE WITHDRAWAL v1 -- « Rétractable » fait partie de ces colonnes
 * d'import : c'est une VRAIE colonne d'ALLER-RETOUR (exportée « Oui »/
 * « Non », relue et RÉELLEMENT appliquée à la réimportation), à ne pas
 * confondre avec la colonne purement informative ci-dessous.
 *
 * XLSX / PRODUCT SERVICE MODES ROUND-TRIP v1 -- « Modes de vente » est
 * elle aussi une VRAIE colonne d'ALLER-RETOUR, même statut que
 * « Rétractable » : `p.allowed_sale_modes === null` (ALL, aucune
 * restriction) est exporté comme le littéral « Tous », jamais une
 * cellule vide (une cellule vide signifierait « inchangé » à la
 * réimportation -- exporter « Tous » explicitement est ce qui rend le
 * cycle exporter -> effacer une restriction -> réimporter réellement
 * possible). Un ensemble de codes est exporté en ORDRE CANONIQUE
 * (SALE_MODE_CODES), jamais l'ordre renvoyé par le serveur -- pour
 * qu'un produit non modifié par le marchand réimporte en SKIP, pas en
 * UPDATE (voir valuesEqualExisting, preview.ts).
 *
 * « Disponible » est une colonne d'aller-retour optionnelle : Oui/Non
 * est appliqué à l'import ; une cellule vide préserve l'état existant
 * ou le défaut serveur de création. Sa position dans l'export reste
 * inchangée. Seul « Prix de référence (€/kg) », généré en base, reste
 * export-only et produit un diagnostic INFO de colonne ignorée.
 *
 * `Photo fichier` est exportée VIDE : le nom de fichier d'origine
 * n'est pas conservé en base (seule une URL publique l'est), et
 * inventer un nom exposerait le marchand à un réimport qui
 * échouerait. Une colonne vide est honnête ; une colonne fausse ne le
 * serait pas.
 *
 * AUCUN identifiant interne n'est exporté (mandat §11) : ni
 * product_id, ni category_id, ni subcategory_id, ni tag_id, ni
 * restaurant_id. Le fichier ne contient que des données marchandes
 * lisibles.
 */
import { zipSync, strToU8 } from "fflate";
import { IMPORT_COLUMNS } from "@/lib/catalogue-import/column-mapping";
import { canonicalizeSaleModeCodes } from "@/lib/catalogue-import/normalization";
import type { FlatProduct } from "@/lib/catalogue-management/filtering";

/** Formate `allowed_sale_modes` pour la cellule « Modes de vente » --
 *  littéral « Tous » si `null` (ALL), sinon les codes présents dans
 *  `raw`, réordonnés en ordre CANONIQUE et joints par ` ; ` (même
 *  séparateur que coerceAllowedSaleModes attend en réimport).
 *
 *  AUDIT LOT 3 (issue #11, comment 5883893142, BLOCKER B) -- correctif :
 *  `canonicalizeSaleModeCodes` (lib/catalogue-import/normalization.ts)
 *  REMPLACE l'ancien filtrage `SALE_MODE_CODES.filter(...)`, qui
 *  supprimait silencieusement tout code hors du référentiel d'entrée
 *  v1 (ex. un code futur d'un catalogue de modes de vente extensible).
 *  Un tel code est désormais exporté TEL QUEL (représentation SANS
 *  PERTE -- le format texte n'a aucune limite de vocabulaire), classé
 *  après les codes canoniques et trié alphabétiquement entre eux pour
 *  un résultat déterministe. Que ce code ne soit pas RÉ-IMPORTABLE via
 *  la colonne « Modes de vente » (le vocabulaire D'ENTRÉE v1 reste
 *  strict, voir coerceAllowedSaleModes) est SANS RAPPORT avec l'export
 *  : cette fonction restitue fidèlement ce qui est EN BASE, elle ne
 *  garantit jamais la ré-importabilité de chaque valeur possible. */
function formatAllowedSaleModes(raw: string[] | null): string {
  if (raw === null) return "Tous";
  return canonicalizeSaleModeCodes(raw).join(" ; ");
}

/** Colonnes supplémentaires, APRÈS les colonnes d'import. */
export const EXPORT_EXTRA_COLUMNS = ["Prix de référence (€/kg)"] as const;

export const EXPORT_COLUMNS: readonly string[] = [...IMPORT_COLUMNS, ...EXPORT_EXTRA_COLUMNS];

export type ExportCell = string | number | null;

/**
 * Construit les lignes d'export (hors en-tête) pour les produits
 * donnés, dans l'ordre reçu -- l'écran passe soit le catalogue entier,
 * soit exactement la liste filtrée affichée, et l'export reflète donc
 * toujours ce que le marchand voit.
 */
export function buildExportRows(products: ReadonlyArray<FlatProduct>): ExportCell[][] {
  return products.map((fp) => {
    const p = fp.product;
    return [
      "Produit",
      p.name,
      fp.categoryName,
      fp.subcategoryName ?? "",
      fp.tagNames.join(" ; "),
      p.short_description ?? "",
      p.description ?? "",
      p.price,
      p.tax_rate ?? "",
      p.unit_weight_grams ?? "",
      "", // Photo fichier -- voir en-tête de ce fichier.
      // ONLINE WITHDRAWAL v1 -- « Rétractable » : EXACTEMENT « Oui » ou
      // « Non », jamais une cellule vide (une cellule vide signifierait
      // « inchangé » à la réimportation, ce qui rendrait l'export
      // inexploitable pour BASCULER une valeur) et jamais un booléen
      // brut (`true`/`false` ne serait pas relu par l'import).
      p.withdrawal_eligible ? "Oui" : "Non",
      // XLSX / PRODUCT SERVICE MODES ROUND-TRIP v1 -- voir
      // formatAllowedSaleModes ci-dessus et le commentaire d'en-tête
      // de ce fichier.
      formatAllowedSaleModes(p.allowed_sale_modes),
      p.is_available ? "Oui" : "Non",
      p.reference_price_per_kg ?? "",
    ];
  });
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(ref: string, value: ExportCell): string {
  if (value === null || value === "") return `<c r="${ref}"/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  // `inlineStr` plutôt qu'une table de chaînes partagées : aucune
  // table à maintenir, et le lecteur d'import de production gère
  // nativement ce type (voir parseWorksheet).
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

/**
 * Sérialise un classeur .xlsx minimal mais valide.
 *
 * Construit avec `fflate.zipSync` -- la MÊME bibliothèque que le
 * lecteur d'import (`lib/catalogue-import/xlsx-reader.ts`), déjà une
 * dépendance de production. Aucune bibliothèque tableur
 * supplémentaire n'est introduite pour ce lot.
 */
export function buildCatalogueXlsx(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<ExportCell>>,
  sheetName = "Catalogue"
): Uint8Array {
  const allRows: ReadonlyArray<ReadonlyArray<ExportCell>> = [header, ...rows];

  const sheetRows = allRows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => cellXml(`${columnLetter(c)}${r + 1}`, cell as ExportCell))
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows}</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
  });
}

/** Classeur complet prêt à télécharger pour les produits donnés. */
export function buildCatalogueExport(products: ReadonlyArray<FlatProduct>): Uint8Array {
  return buildCatalogueXlsx(EXPORT_COLUMNS, buildExportRows(products));
}

/** Nom de fichier horodaté, distinguant explicitement un export
 *  complet d'un export du résultat filtré -- le marchand retrouve
 *  ainsi sans ambiguïté ce qu'il a téléchargé. */
export function catalogueExportFileName(
  scope: "complet" | "filtre",
  now: Date = new Date()
): string {
  const d = now.toISOString().slice(0, 10);
  return scope === "complet" ? `catalogue-complet-${d}.xlsx` : `catalogue-resultats-${d}.xlsx`;
}
