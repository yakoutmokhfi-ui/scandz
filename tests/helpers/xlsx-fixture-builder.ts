/**
 * Scanym — OB-3 CATALOGUE IMPORT — TEST HELPER (jamais du code de
 * production). Construit un classeur .xlsx MINIMAL mais valide, ligne
 * par ligne, à partir de valeurs JS simples -- utilisé UNIQUEMENT par
 * les tests de lib/catalogue-import/xlsx-reader.ts, pour éviter de
 * committer des fichiers binaires .xlsx dans le dépôt (le patch de ce
 * lot reste ainsi 100% texte, entièrement auditable).
 *
 * Construit avec `fflate.zipSync` -- la même bibliothèque que le
 * lecteur lui-même, ce qui prouve un aller-retour symétrique
 * (write -> read) plutôt qu'une dépendance à un fichier .xlsx externe
 * dont la provenance ne serait pas vérifiable dans ce dépôt.
 */

import { zipSync, strToU8 } from "fflate";

export type FixtureCell = string | number | null;

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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

export interface BuildXlsxOptions {
  /** Si vrai, insère une balise <f> (formule) à côté de la valeur en
   *  cache sur la toute première cellule numérique rencontrée -- sert
   *  à prouver que le lecteur ne lit JAMAIS son contenu (mandat "no
   *  formula execution"). */
  includeFormulaOnFirstNumericCell?: boolean;
  /** Ajoute une entrée xl/vbaProject.bin factice dans l'archive --
   *  prouve que le lecteur ne l'ouvre JAMAIS (mandat "no macro
   *  execution"). */
  includeFakeVbaProject?: boolean;
  /** Entrées ZIP additionnelles arbitraires (chemin -> contenu réel,
   *  petit) -- sert à fabriquer des fixtures "entrée non pertinente
   *  présente dans l'archive" (OB-3 v1.1, "XLSX DECOMPRESSION SAFETY"),
   *  ensuite éventuellement passées à
   *  `patchCentralDirectoryDeclaredSize` pour leur donner une taille
   *  décompressée DÉCLARÉE arbitrairement grande sans que leur contenu
   *  réel ne change. */
  extraFiles?: Record<string, string>;
  /** XLSX RELATIONSHIP ATTRIBUTE-ORDER ROBUSTNESS v1 -- remplace
   *  intégralement le contenu par défaut de
   *  `xl/_rels/workbook.xml.rels` par ce texte XML brut, tel quel --
   *  sert UNIQUEMENT à fabriquer des fixtures de régression pour
   *  l'ordre des attributs `<Relationship>` (Id/Target dans un ordre
   *  différent, relation non pertinente précédant la bonne, Target
   *  manquant, XML malformé) sans toucher au reste du classeur. Le
   *  contenu par défaut (Id puis Type puis Target, `rId1`/`rId2`)
   *  reste inchangé quand cette option est omise. */
  workbookRelsXmlOverride?: string;
}

/** Construit un classeur .xlsx valide (un seul onglet) à partir d'une
 *  grille de cellules. Chaîne = valeur texte (table de chaînes
 *  partagées), nombre = cellule numérique, `null` = cellule omise. */
export function buildXlsxWorkbook(rows: FixtureCell[][], options: BuildXlsxOptions = {}): ArrayBuffer {
  const sharedStrings: string[] = [];
  const sharedStringIndex = new Map<string, number>();
  const internString = (s: string): number => {
    const existing = sharedStringIndex.get(s);
    if (existing !== undefined) return existing;
    const idx = sharedStrings.length;
    sharedStrings.push(s);
    sharedStringIndex.set(s, idx);
    return idx;
  };

  let formulaInserted = false;
  const rowsXml = rows
    .map((row, rowIdx) => {
      const rowNumber = rowIdx + 1;
      const cellsXml = row
        .map((cell, colIdx) => {
          if (cell === null) return "";
          const ref = `${columnLetter(colIdx)}${rowNumber}`;
          if (typeof cell === "number") {
            if (options.includeFormulaOnFirstNumericCell && !formulaInserted) {
              formulaInserted = true;
              // Formule volontairement absurde si elle était évaluée
              // (diviserait par zéro) -- le lecteur ne doit JAMAIS
              // s'en soucier, seule <v> compte.
              return `<c r="${ref}"><f>1/0</f><v>${cell}</v></c>`;
            }
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          const idx = internString(cell);
          return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
        })
        .join("");
      return `<row r="${rowNumber}">${cellsXml}</row>`;
    })
    .join("");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowsXml}</sheetData>
</worksheet>`;

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join("\n")}
</sst>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Feuil1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRelsXml =
    options.workbookRelsXmlOverride ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypesXml),
    "_rels/.rels": strToU8(rootRelsXml),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRelsXml),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    "xl/sharedStrings.xml": strToU8(sharedStringsXml),
  };

  if (options.includeFakeVbaProject) {
    // Contenu binaire arbitraire non-OLE valide -- si le lecteur
    // l'ouvrait/l'interprétait de quelque façon que ce soit, il
    // lèverait une exception ; son absence d'effet PROUVE qu'il n'est
    // jamais lu (voir tests/lot-ob3-xlsx-reader-security.test.ts).
    files["xl/vbaProject.bin"] = strToU8("NOT_A_REAL_VBA_PROJECT_JUST_A_MARKER");
  }

  if (options.extraFiles) {
    for (const [path, content] of Object.entries(options.extraFiles)) {
      files[path] = strToU8(content);
    }
  }

  const zipped = zipSync(files, { level: 0 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

/** Construit un classeur .xlsx à partir d'un en-tête + lignes de
 *  données (toutes des chaînes, format le plus courant pour un
 *  import). */
export function buildImportXlsx(header: string[], dataRows: FixtureCell[][], options: BuildXlsxOptions = {}): ArrayBuffer {
  return buildXlsxWorkbook([header, ...dataRows], options);
}

// ============================================================
// OB-3 v1.1 -- "XLSX DECOMPRESSION SAFETY" -- fabrication de
// fixtures dont le RÉPERTOIRE CENTRAL ZIP déclare une taille
// décompressée mensongère, sans changer le contenu réel de
// l'entrée. Sert UNIQUEMENT à prouver que
// lib/catalogue-import/xlsx-reader.ts rejette une entrée sur la foi
// de sa taille décompressée DÉCLARÉE, avant toute désarchivage --
// jamais du code de production.
//
// Offsets conformes à la spec PKZIP APPNOTE.TXT section 4.3.12
// (en-tête de répertoire central) -- exactement les mêmes que ceux
// utilisés par `fflate` en interne (fonction `zh`, vérifiée dans
// node_modules/fflate avant d'écrire ce code) : signature (4) +
// verMadeBy (2) + verNeeded (2) + flags (2) + méthode (2) + heure (2)
// + date (2) + crc32 (4) + tailleCompressée (4, @20) +
// tailleDécompressée (4, @24) + longueurNom (2, @28) +
// longueurExtra (2, @30) + longueurCommentaire (2, @32) + ... + nom
// (@46, longueurNom octets).
// ============================================================

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(view: DataView, length: number): number {
  for (let i = length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new Error("EOCD ZIP introuvable (fixture de test corrompue -- vérifier buildXlsxWorkbook).");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Renvoie une COPIE du classeur avec la taille décompressée déclarée
 * (répertoire central ZIP) de l'entrée `entryName` remplacée par
 * `newDeclaredUncompressedSize` -- le contenu RÉEL de l'entrée (ses
 * octets compressés) n'est jamais modifié. Reproduit exactement le
 * vecteur d'attaque documenté dans xlsx-reader.ts : un répertoire
 * central qui ment sur la taille décompressée d'une entrée pour
 * forcer une allocation disproportionnée.
 */
export function patchCentralDirectoryDeclaredSize(
  buffer: ArrayBuffer,
  entryName: string,
  newDeclaredUncompressedSize: number
): ArrayBuffer {
  const out = buffer.slice(0);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  const eocd = findEndOfCentralDirectory(view, bytes.length);
  const count = view.getUint16(eocd + 8, true);
  let offset = view.getUint32(eocd + 16, true);
  const nameBytes = strToU8(entryName);

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Entrée de répertoire central ZIP inattendue (fixture de test corrompue).");
    }
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const candidateName = bytes.subarray(offset + 46, offset + 46 + filenameLength);
    if (bytesEqual(candidateName, nameBytes)) {
      view.setUint32(offset + 24, newDeclaredUncompressedSize, true);
      return out;
    }
    offset += 46 + filenameLength + extraLength + commentLength;
  }
  throw new Error(`Entrée « ${entryName} » introuvable dans le répertoire central (fixture de test).`);
}

// ============================================================
// OB-3 v1.3 -- "ZIP DUPLICATE ENTRY" (BLOCKER 1, audit indépendant
// Cat Stevens) -- fabrication d'une archive contenant une VRAIE entrée
// de répertoire central DUPLIQUÉE (même nom apparaissant deux fois),
// reproduisant l'archive de démonstration de Cat Stevens. Impossible à
// produire via `fflate.zipSync({...})` (une clé d'objet JS ne peut
// apparaître qu'une seule fois) -- construit donc directement au
// niveau octet, en s'appuyant sur les mêmes offsets PKZIP que
// `patchCentralDirectoryDeclaredSize` ci-dessus. Jamais du code de
// production.
// ============================================================

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

/** CRC-32 standard (table calculée à la volée) -- correction réaliste
 *  bien que le lecteur testé ne la vérifie jamais (la passe manifeste
 *  ne décompresse rien) : évite qu'un bug du correctif fasse échouer
 *  un test sur une erreur de parsing ZIP non pertinente plutôt que sur
 *  l'assertion réellement testée. */
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

/**
 * Renvoie une COPIE de l'archive avec une DEUXIÈME entrée de
 * répertoire central portant EXACTEMENT le même nom (`entryName`)
 * qu'une entrée déjà présente -- un vrai doublon, deux enregistrements
 * de répertoire central distincts référençant le même chemin, chacun
 * pointant vers son propre en-tête de fichier local et ses propres
 * données réelles (`duplicateContent`, méthode 0 = stockée, jamais
 * compressée -- inutile ici puisque la passe manifeste ne décompresse
 * jamais rien).
 *
 * Le répertoire central D'ORIGINE n'est JAMAIS déplacé ni modifié
 * (tous ses offsets restent valides) : le nouvel en-tête local + ses
 * données sont insérés juste après les données locales d'origine
 * (avant l'ancien répertoire central), un nouvel enregistrement de
 * répertoire central est ajouté à la suite de l'ancien, et l'EOCD est
 * réécrit (nombre d'entrées, taille et offset du répertoire central)
 * pour refléter l'archive augmentée.
 *
 * `declaredUncompressedSizeOverride`, si fourni, remplace la taille
 * décompressée DÉCLARÉE du doublon dans son enregistrement de
 * répertoire central -- permet de fabriquer un doublon qui MENT sur sa
 * taille (scénario "premier sûr + second surdimensionné", mandat OB-3
 * v1.3 test adversarial n°2) sans changer la taille réelle des octets
 * physiquement écrits.
 */
export function injectDuplicateCentralDirectoryEntry(
  buffer: ArrayBuffer,
  entryName: string,
  duplicateContent: string,
  declaredUncompressedSizeOverride?: number
): ArrayBuffer {
  const original = new Uint8Array(buffer);
  const originalView = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(originalView, original.length);
  const cdSize = originalView.getUint32(eocd + 12, true);
  const cdOffset = originalView.getUint32(eocd + 16, true);
  const totalEntries = originalView.getUint16(eocd + 10, true);

  const nameBytes = strToU8(entryName);
  const dataBytes = strToU8(duplicateContent);
  const crc = crc32(dataBytes);
  const declaredSize = declaredUncompressedSizeOverride ?? dataBytes.length;

  // -- Nouvel en-tête de fichier local (méthode 0 = stockée) + données --
  const localHeader = new Uint8Array(30 + nameBytes.length);
  const localView = new DataView(localHeader.buffer);
  localView.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
  localView.setUint16(4, 20, true); // version nécessaire
  localView.setUint16(6, 0, true); // indicateurs
  localView.setUint16(8, 0, true); // méthode : 0 = stockée
  localView.setUint16(10, 0, true); // heure de modification
  localView.setUint16(12, 0x21, true); // date de modification
  localView.setUint32(14, crc, true);
  localView.setUint32(18, dataBytes.length, true); // taille compressée réelle
  localView.setUint32(22, dataBytes.length, true); // taille décompressée (en-tête local -- non utilisée par le lecteur, qui se fie exclusivement au répertoire central)
  localView.setUint16(26, nameBytes.length, true);
  localView.setUint16(28, 0, true); // longueur champ extra
  localHeader.set(nameBytes, 30);

  const newLocalEntry = new Uint8Array(localHeader.length + dataBytes.length);
  newLocalEntry.set(localHeader, 0);
  newLocalEntry.set(dataBytes, localHeader.length);

  const newLocalOffset = cdOffset; // juste après les données locales d'origine, qui ne bougent pas

  // -- Nouvel enregistrement de répertoire central pour le doublon --
  const centralRecord = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(centralRecord.buffer);
  centralView.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
  centralView.setUint16(4, 20, true); // version faite par
  centralView.setUint16(6, 20, true); // version nécessaire
  centralView.setUint16(8, 0, true); // indicateurs
  centralView.setUint16(10, 0, true); // méthode : 0 = stockée
  centralView.setUint16(12, 0, true); // heure de modification
  centralView.setUint16(14, 0x21, true); // date de modification
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, dataBytes.length, true); // taille compressée réelle
  centralView.setUint32(24, declaredSize, true); // taille décompressée DÉCLARÉE (potentiellement mensongère)
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint16(30, 0, true); // longueur champ extra
  centralView.setUint16(32, 0, true); // longueur commentaire
  centralView.setUint16(34, 0, true); // numéro de disque de début
  centralView.setUint16(36, 0, true); // attributs internes
  centralView.setUint32(38, 0, true); // attributs externes
  centralView.setUint32(42, newLocalOffset, true);
  centralRecord.set(nameBytes, 46);

  // -- Assemblage : données locales d'origine (inchangées) + nouvelle
  // entrée locale + répertoire central d'origine (inchangé, offsets
  // toujours valides) + nouvel enregistrement + EOCD réécrit. --
  const originalLocalData = original.subarray(0, cdOffset);
  const originalCentralDir = original.subarray(cdOffset, cdOffset + cdSize);

  const newLocalDataLength = originalLocalData.length + newLocalEntry.length;
  const newCdOffset = newLocalDataLength;
  const newCdSize = cdSize + centralRecord.length;
  const newTotalEntries = totalEntries + 1;

  const out = new Uint8Array(newLocalDataLength + newCdSize + 22);
  out.set(originalLocalData, 0);
  out.set(newLocalEntry, originalLocalData.length);
  out.set(originalCentralDir, newLocalDataLength);
  out.set(centralRecord, newLocalDataLength + originalCentralDir.length);

  const eocdStart = newLocalDataLength + newCdSize;
  const outView = new DataView(out.buffer);
  outView.setUint32(eocdStart, EOCD_SIGNATURE, true);
  outView.setUint16(eocdStart + 4, 0, true); // numéro de ce disque
  outView.setUint16(eocdStart + 6, 0, true); // disque de début du répertoire central
  outView.setUint16(eocdStart + 8, newTotalEntries, true);
  outView.setUint16(eocdStart + 10, newTotalEntries, true);
  outView.setUint32(eocdStart + 12, newCdSize, true);
  outView.setUint32(eocdStart + 16, newCdOffset, true);
  outView.setUint16(eocdStart + 20, 0, true); // longueur commentaire

  return out.buffer;
}
