/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Lecteur XLSX minimal, PURE (aucun accès réseau, aucun Storage,
 * aucune dépendance DOM/navigateur -- testable dans `node --test`
 * sans jsdom, exactement comme lib/tracking/*.ts).
 *
 * DÉCISION DE SÉCURITÉ (mandat OB-3, section "FILE SAFETY" --
 * "Treat spreadsheet contents as DATA ONLY. No macro execution. No
 * formula execution.") :
 *
 *   Le paquet npm `xlsx` (SheetJS Community Edition, seule version
 *   publiée sur le registre npm, 0.18.5) porte DEUX vulnérabilités
 *   HIGH non corrigées sur le registre npm (`npm audit`, vérifié
 *   avant d'écrire ce fichier) :
 *     - Prototype Pollution (GHSA-4r6h-8v6p-xvw6)
 *     - ReDoS (GHSA-5pgg-2g8v-p4x9)
 *   Les versions corrigées existent UNIQUEMENT sur le CDN propre de
 *   SheetJS (cdn.sheetjs.com), inaccessible depuis cet environnement
 *   (bloqué par la liste blanche réseau du bac à sable, HTTP 403
 *   vérifié empiriquement). `exceljs` a été évalué en second (aucune
 *   vulnérabilité HIGH dans son propre code de lecture ; seule une
 *   dépendance transitive `uuid` MODERATE, non exercée par la lecture
 *   d'un fichier non fiable), mais reste une bibliothèque large,
 *   orientée Node, avec un historique d'intégration fragile dans un
 *   bundle navigateur Next.js.
 *
 *   Décision retenue : n'utiliser AUCUNE bibliothèque de lecture XLSX
 *   tierce. Un lecteur minimal, écrit ici, fait exactement le
 *   nécessaire et rien de plus :
 *     1. `fflate` (0.8.3, zéro dépendance, `npm audit` propre --
 *        vérifié) pour désarchiver le conteneur ZIP du fichier .xlsx.
 *     2. Extraction de balises `<v>`/`<t>` UNIQUEMENT via un scan de
 *        texte ciblé (jamais un moteur XML générique, jamais
 *        `DOMParser`) -- aucune balise `<f>` (formule) n'est jamais
 *        lue ni interprétée : son CONTENU est ignoré, seule sa
 *        présence est sautée. AUCUNE exécution de formule n'est donc
 *        possible PAR CONSTRUCTION (il n'existe, dans ce fichier,
 *        aucun code capable d'évaluer une expression).
 *     3. `xl/vbaProject.bin` (macros) n'est JAMAIS lu : seules les
 *        entrées ZIP nommées explicitement ci-dessous sont extraites
 *        ; toute autre entrée du zip est ignorée sans être ouverte.
 *        AUCUNE exécution de macro n'est donc possible PAR
 *        CONSTRUCTION.
 *
 *   Ce choix est documenté comme décision d'architecture réévaluable
 *   si SheetJS republie une version corrigée sur le registre npm.
 *
 * DÉCOMPRESSION BORNÉE (OB-3 v1.1 -- remédiation, mandat "XLSX
 * DECOMPRESSION SAFETY") :
 *
 *   Constat corrigé : la limite de 10 Mo ci-dessus ne porte que sur la
 *   taille COMPRESSÉE du fichier uploadé. Un appel naïf à
 *   `unzipSync(bytes)` désarchive et décompresse INTÉGRALEMENT tout le
 *   conteneur ZIP en mémoire avant que ce module ne choisisse les
 *   quelques entrées dont il a besoin -- une archive de quelques
 *   kilo-octets compressés peut légitimement déclarer, dans son
 *   répertoire central ZIP, une taille décompressée arbitrairement
 *   grande pour une entrée quelconque (bombe zip), et `unzipSync`
 *   alloue un tampon de sortie de EXACTEMENT cette taille déclarée
 *   (`new Uint8Array(originalSize)`, vérifié dans le code source de
 *   `fflate`) avant même de vérifier qu'elle correspond au contenu
 *   réel. L'ancienne affirmation de ce commentaire ("aucune entrée
 *   non liée n'est jamais ouverte/décompressée") était donc INEXACTE
 *   pour un appel `unzipSync(bytes)` sans filtre : toutes les entrées
 *   étaient décompressées, quelle que soit leur pertinence.
 *
 *   Correction apportée : `readXlsxWorkbook` n'appelle plus JAMAIS
 *   `unzipSync` sans l'option `filter`, en trois passes strictement
 *   bornées :
 *     1. Passe "manifeste" : `unzipSync(bytes, { filter: () => false })`
 *        -- le filtre renvoie systématiquement `false`, donc AUCUNE
 *        décompression n'a lieu (vérifié dans le code source de
 *        `fflate` : quand le filtre renvoie `false`, la branche qui
 *        appelle `inflateSync`/alloue un tampon n'est jamais atteinte).
 *        Cette passe lit uniquement le RÉPERTOIRE CENTRAL ZIP (nom,
 *        taille compressée, taille décompressée déclarée, méthode de
 *        compression, pour CHAQUE entrée) -- un coût borné par la
 *        taille totale du fichier déjà limitée à 10 Mo, jamais par le
 *        contenu décompressé d'une quelconque entrée.
 *     2. Passe "métadonnées" : seules `xl/workbook.xml` et
 *        `xl/_rels/workbook.xml.rels` sont autorisées par le filtre
 *        (et seulement après vérification, via le manifeste de la
 *        passe 1, que leur taille décompressée déclarée ne dépasse pas
 *        `MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES`) -- décompressées pour
 *        déterminer le chemin exact de la première feuille.
 *     3. Passe "contenu" : seules la feuille résolue à la passe 2 et
 *        `xl/sharedStrings.xml` (si présente) sont autorisées par le
 *        filtre, chacune vérifiée au préalable contre
 *        `MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES`, et leur somme (plus
 *        les métadonnées déjà comptées) contre
 *        `MAX_TOTAL_UNCOMPRESSED_BYTES` -- AVANT tout appel à
 *        `unzipSync` pour ces entrées.
 *
 *   Résultat : AUCUNE entrée ZIP -- pertinente ou non -- n'est JAMAIS
 *   décompressée sans que sa taille décompressée déclarée n'ait
 *   d'abord été vérifiée contre une borne explicite, et aucune entrée
 *   hors de la liste blanche des 4 chemins ci-dessus n'est JAMAIS
 *   décompressée, quelle que soit sa taille déclarée. Une archive
 *   dépassant une borne est rejetée AVANT désarchivage de l'entrée en
 *   cause, avec le code stable `ENTRY_TOO_LARGE`. Les macros
 *   (`xl/vbaProject.bin`) et tout autre contenu embarqué restent
 *   ignorés exactement comme avant (ni dans le manifeste ils ne sont
 *   jamais sélectionnés, ni a fortiori décompressés).
 *
 * ENTRÉES ZIP DUPLIQUÉES (OB-3 v1.3 -- remédiation, audit indépendant
 * Cat Stevens, BLOCKER 1) :
 *
 *   Constat corrigé : la spec ZIP n'interdit PAS deux entrées de
 *   répertoire central portant EXACTEMENT le même nom. La passe
 *   "manifeste" (v1.1) stockait ces métadonnées dans une `Map` indexée
 *   par nom : une seconde occurrence, de taille déclarée sûre,
 *   écrasait silencieusement les métadonnées (potentiellement
 *   surdimensionnées) de la première. `assertEntryDecompressionSafe`
 *   ne voyait alors QUE la dernière occurrence et laissait passer la
 *   vérification -- mais la passe "extraction" qui suit sélectionne
 *   ensuite par NOM via le filtre `unzipSync`, qui accepte TOUTES les
 *   occurrences d'un nom accepté, pas seulement la dernière : la
 *   PREMIÈRE occurrence (surdimensionnée) était donc quand même
 *   effectivement décompressée par `fflate` (son résultat étant
 *   seulement écrasé APRÈS coup dans l'objet de sortie par la seconde
 *   occurrence) -- exactement le contournement démontré par Cat
 *   Stevens avec un fichier de ~67 Ko compressés.
 *
 *   Correctif : la passe manifeste compte désormais aussi le nombre
 *   d'OCCURRENCES de chaque nom d'entrée (toujours sans jamais
 *   décompresser quoi que ce soit -- le filtre continue de renvoyer
 *   systématiquement `false`). Avant toute extraction d'un chemin
 *   pertinent (`xl/workbook.xml`, `xl/_rels/workbook.xml.rels`,
 *   `xl/sharedStrings.xml`, la feuille résolue), `readXlsxWorkbook`
 *   vérifie que ce chemin n'apparaît PAS plus d'une fois dans
 *   l'archive -- sinon l'archive est rejetée avec le code stable
 *   `DUPLICATE_ZIP_ENTRY`, AVANT toute tentative de désarchivage de
 *   l'une ou l'autre occurrence, quelles que soient leurs tailles
 *   déclarées respectives (jamais "le premier gagne", jamais "le
 *   dernier gagne", jamais une résolution silencieuse -- l'archive
 *   entière est rejetée comme ambiguë). Une entrée NON pertinente
 *   dupliquée (ex. une image) reste sans effet : elle n'est de toute
 *   façon jamais sélectionnée par le filtre d'extraction, dupliquée ou
 *   non.
 */

import { unzipSync } from "fflate";

/** Limite de taille COMPRESSÉE du fichier uploadé (mandat OB-3, "sane
 *  file-size limit"). 10 Mo -- un fichier catalogue.xlsx réaliste
 *  (quelques milliers de lignes, texte uniquement, aucune image
 *  embarquée) ne s'en approche jamais ; un fichier plus gros est
 *  rejeté AVANT toute désarchivage. NE BORNE PAS, à elle seule, la
 *  taille DÉCOMPRESSÉE d'une entrée quelconque -- voir les bornes
 *  dédiées ci-dessous (mandat OB-3 v1.1, "XLSX DECOMPRESSION SAFETY"). */
export const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Taille décompressée maximale tolérée pour `xl/workbook.xml` et
 *  `xl/_rels/workbook.xml.rels` -- ces deux fichiers ne listent que
 *  les métadonnées du classeur (noms de feuilles, relations) et
 *  restent toujours minuscules dans un export réel ; 2 Mo est déjà
 *  très généreux. */
export const MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;

/** Taille décompressée maximale tolérée pour la feuille de calcul
 *  résolue et pour `xl/sharedStrings.xml` -- les deux seules entrées
 *  pouvant légitimement contenir un volume de texte proportionnel au
 *  nombre de lignes du catalogue. 64 Mo de XML texte correspond à un
 *  catalogue de plusieurs centaines de milliers de lignes -- très
 *  largement au-delà de tout usage réaliste de cet import, tout en
 *  restant sans commune mesure avec ce qu'une bombe de décompression
 *  chercherait à produire. */
export const MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Plafond de la SOMME des tailles décompressées déclarées de toutes
 *  les entrées effectivement extraites pour une même lecture (les 2
 *  métadonnées + feuille + shared strings) -- défense en profondeur
 *  indépendante des bornes par entrée ci-dessus : même si chaque
 *  entrée prise isolément respecte sa propre borne, ce plafond limite
 *  la mémoire totale qu'une seule analyse peut consommer. */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

/** Signature binaire ZIP (les fichiers .xlsx sont des archives ZIP)
 *  -- jamais une confiance dans l'extension ou le type MIME déclaré
 *  par le navigateur, même discipline que
 *  lib/services/product-photo.ts (détection par octets magiques). */
const ZIP_LOCAL_FILE_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
/** Une archive ZIP vide est également valide avec cette signature. */
const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];

export type XlsxReadErrorCode =
  | "FILE_TOO_LARGE"
  | "NOT_A_ZIP_CONTAINER"
  | "MALFORMED_WORKBOOK"
  | "NO_WORKSHEET_FOUND"
  | "EMPTY_WORKSHEET"
  | "ENTRY_TOO_LARGE"
  | "DUPLICATE_ZIP_ENTRY";

export class XlsxReadError extends Error {
  readonly code: XlsxReadErrorCode;
  constructor(code: XlsxReadErrorCode, message: string) {
    super(message);
    this.name = "XlsxReadError";
    this.code = code;
  }
}

/** Une feuille lue : lignes de cellules, 1 ligne = 1 tableau de
 *  chaînes (cellules vides = chaîne vide ""), colonnes alignées sur
 *  la position réelle de la cellule dans la feuille (les cellules
 *  vides omises par Excel sont reconstituées comme "" -- jamais un
 *  décalage de colonne silencieux). `rowNumbers[i]` = numéro de ligne
 *  Excel (1-based, tel qu'affiché dans Excel) de `rows[i]`. */
export interface ParsedSheet {
  rows: string[][];
  rowNumbers: number[];
}

/** Détection ZIP par octets magiques, jamais une confiance dans
 *  l'extension/type MIME déclaré -- même discipline que
 *  lib/services/product-photo.ts. Exportée pour être réutilisée telle
 *  quelle par lib/services/catalogue-import.ts (routage xlsx/CSV),
 *  jamais dupliquée. */
export function checkZipSignature(bytes: Uint8Array): boolean {
  const matches = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  return matches(ZIP_LOCAL_FILE_SIGNATURE) || matches(ZIP_EMPTY_SIGNATURE);
}

/** Décode un Uint8Array en texte UTF-8. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Dé-échappe les entités XML standard (&amp; &lt; &gt; &quot; &apos;
 *  + références numériques &#NN; / &#xHH;) -- jamais plus, jamais
 *  d'interprétation de balises. */
export function unescapeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Convertit la partie lettres d'une référence de cellule ("C7" ->
 *  "C", "AA12" -> "AA") en index de colonne base-0 (A=0, Z=25, AA=26,
 *  ...). Retourne -1 si aucune lettre trouvée (référence malformée). */
export function columnLettersToIndex(cellRef: string): number {
  const match = /^([A-Za-z]+)/.exec(cellRef);
  if (!match) return -1;
  const letters = match[1].toUpperCase();
  let index = 0;
  for (const ch of letters) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Extrait la table des chaînes partagées (`xl/sharedStrings.xml`).
 * Chaque `<si>` peut contenir soit un `<t>` direct, soit un ou
 * plusieurs runs `<r><t>...</t></r>` (texte enrichi) -- concaténés
 * dans l'ordre. Retourne un tableau indexé (index = ordre
 * d'apparition, tel que référencé par `t="s"` dans les cellules).
 */
export function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRe.exec(xml))) {
    const siBody = siMatch[1];
    // Concatène TOUS les <t>...</t> présents dans ce <si> (qu'ils
    // soient directs ou dans des <r> -- même résultat texte final).
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    let text = "";
    let found = false;
    while ((tMatch = tRe.exec(siBody))) {
      text += unescapeXmlEntities(tMatch[1]);
      found = true;
    }
    strings.push(found ? text : "");
  }
  return strings;
}

/**
 * Extrait UNE feuille (`xl/worksheets/sheetN.xml`) en lignes de
 * cellules texte. `sharedStrings` : table déjà extraite (vide si le
 * classeur n'en a pas -- toutes les chaînes seraient alors inline).
 *
 * IMPORTANT (mandat "no formula execution") : toute balise `<f>...
 * </f>` rencontrée à l'intérieur d'une cellule est IGNORÉE -- son
 * contenu n'est jamais lu, jamais évalué. Seule la valeur mise en
 * cache dans `<v>` (ou le texte inline `<is><t>`) est utilisée,
 * exactement comme si la formule n'existait pas.
 */
export function parseWorksheet(xml: string, sharedStrings: string[]): ParsedSheet {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];

  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml))) {
    const rowAttrs = rowMatch[1];
    const rowBody = rowMatch[2];
    const rNumMatch = /\br="(\d+)"/.exec(rowAttrs);
    const rowNumber = rNumMatch ? parseInt(rNumMatch[1], 10) : rows.length + 1;

    const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    const cellsByIndex = new Map<number, string>();
    let maxIndex = -1;
    while ((cellMatch = cellRe.exec(rowBody))) {
      const cellAttrs = cellMatch[1];
      const cellBody = cellMatch[3] ?? "";
      const refMatch = /\br="([A-Za-z]+\d+)"/.exec(cellAttrs);
      const colIndex = refMatch ? columnLettersToIndex(refMatch[1]) : maxIndex + 1;
      const typeMatch = /\bt="([a-zA-Z]+)"/.exec(cellAttrs);
      const cellType = typeMatch ? typeMatch[1] : null;

      let value = "";
      if (cellType === "inlineStr") {
        const isMatch = /<is>([\s\S]*?)<\/is>/.exec(cellBody);
        if (isMatch) {
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let tMatch: RegExpExecArray | null;
          let text = "";
          while ((tMatch = tRe.exec(isMatch[1]))) text += unescapeXmlEntities(tMatch[1]);
          value = text;
        }
      } else {
        // <v> uniquement -- <f> (formule), s'il est présent, est
        // laissé de côté sans être lu ni évalué.
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(cellBody);
        const raw = vMatch ? unescapeXmlEntities(vMatch[1]) : "";
        if (cellType === "s") {
          const idx = parseInt(raw, 10);
          value = Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : "";
        } else if (cellType === "b") {
          value = raw === "1" ? "1" : raw === "0" ? "0" : raw;
        } else {
          value = raw;
        }
      }

      if (colIndex >= 0) {
        cellsByIndex.set(colIndex, value);
        if (colIndex > maxIndex) maxIndex = colIndex;
      }
    }

    const row: string[] = [];
    for (let i = 0; i <= maxIndex; i++) row.push(cellsByIndex.get(i) ?? "");
    rows.push(row);
    rowNumbers.push(rowNumber);
  }

  return { rows, rowNumbers };
}

/** Extrait la valeur d'un attribut XML donné dans le texte des
 *  attributs d'une balise (tout ce qui suit le nom de la balise et
 *  précède `>`), INDÉPENDAMMENT de sa position parmi les autres
 *  attributs. `(?:^|\s)` (plutôt qu'un simple `\b`) exige que le nom
 *  d'attribut soit précédé du début de chaîne ou d'un espace, pour ne
 *  jamais matcher la fin d'un autre nom d'attribut qui partagerait le
 *  même suffixe (ex. Target="..." ne doit jamais être confondu avec
 *  TargetMode="..." -- `\bTarget="` seul suffirait déjà ici puisque
 *  "TargetMode=" n'est jamais suivi de `="`, mais `(?:^|\s)` est une
 *  garde supplémentaire, sans coût). Retourne `null` si l'attribut est
 *  absent -- ne lève jamais. */
function extractXmlAttribute(attributeText: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
  const match = re.exec(attributeText);
  return match ? match[1] : null;
}

function findFirstSheetPath(zip: Record<string, Uint8Array>): string {
  const workbookXmlBytes = zip["xl/workbook.xml"];
  const relsBytes = zip["xl/_rels/workbook.xml.rels"];
  if (!workbookXmlBytes || !relsBytes) {
    throw new XlsxReadError("NO_WORKSHEET_FOUND", "xl/workbook.xml ou ses relations sont introuvables dans le classeur.");
  }
  const workbookXml = decodeUtf8(workbookXmlBytes);
  const relsXml = decodeUtf8(relsBytes);

  // Premier <sheet .../> déclaré dans workbook.xml, dans l'ordre du
  // document -- décision documentée (IMPORT-CONTRACT.md) : la
  // PREMIÈRE feuille du classeur est celle importée, les feuilles
  // suivantes (s'il y en a) sont ignorées.
  const sheetMatch = /<sheet\b[^>]*\br:id="([^"]+)"[^>]*\/?>/.exec(workbookXml);
  if (!sheetMatch) {
    throw new XlsxReadError("NO_WORKSHEET_FOUND", "Aucune feuille déclarée dans le classeur.");
  }
  const relId = sheetMatch[1];

  // v1 (robustesse ordre d'attributs) -- les attributs XML ne sont
  // PAS ordonnés : un classeur valide peut déclarer Target, puis
  // Type, puis Id, dans n'importe quel ordre. On repère chaque balise
  // <Relationship ...> une à une (`/g`), puis on extrait Id et Target
  // INDÉPENDAMMENT l'un de l'autre dans le texte de ses attributs --
  // jamais via un seul regex qui imposerait un ordre relatif entre
  // les deux. Voir l'en-tête de ce fichier / le rapport du lot pour
  // le défaut corrigé ici.
  const relTagRe = /<Relationship\b([^>]*)\/?>/g;
  let target: string | null = null;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relTagRe.exec(relsXml)) !== null) {
    const attributeText = relMatch[1];
    if (extractXmlAttribute(attributeText, "Id") !== relId) continue;
    target = extractXmlAttribute(attributeText, "Target");
    break;
  }
  if (!target) {
    throw new XlsxReadError("NO_WORKSHEET_FOUND", "Relation de feuille introuvable dans le classeur.");
  }
  if (target.startsWith("/")) target = target.slice(1);
  else target = `xl/${target}`;
  return target;
}

/** Une entrée du répertoire central ZIP, telle que rapportée par le
 *  filtre `unzipSync` -- lue SANS jamais décompresser quoi que ce
 *  soit (voir passe "manifeste" ci-dessous). `occurrences` compte le
 *  nombre de fois où ce NOM apparaît dans le répertoire central --
 *  strictement plus de 1 signale une entrée dupliquée (OB-3 v1.3,
 *  BLOCKER 1) ; les champs `size`/`originalSize`/`compression`
 *  reflètent alors une occurrence QUELCONQUE parmi les doublons
 *  (indéterminé lequel) -- sans conséquence, puisqu'une entrée
 *  pertinente dupliquée est rejetée avant tout examen de sa taille. */
interface ZipEntryInfo {
  size: number;
  originalSize: number;
  compression: number;
  occurrences: number;
}

/** Construit le manifeste complet du répertoire central ZIP -- nom,
 *  taille compressée, taille décompressée DÉCLARÉE, méthode de
 *  compression, ET nombre d'occurrences, pour CHAQUE entrée -- sans
 *  décompresser AUCUNE d'entre elles. Le filtre renvoie
 *  systématiquement `false`, ce qui fait que `unzipSync` n'atteint
 *  jamais son code de décompression (`inflateSync`) pour quelque
 *  entrée que ce soit ; seul le répertoire central (déjà borné par
 *  MAX_IMPORT_FILE_SIZE_BYTES) est parcouru, un enregistrement par
 *  entrée -- y compris pour un nom dupliqué, chaque occurrence
 *  incrémente `occurrences` sans jamais décompresser quoi que ce
 *  soit. Lève MALFORMED_WORKBOOK si le répertoire central lui-même
 *  est illisible. */
function buildZipManifest(bytes: Uint8Array): Map<string, ZipEntryInfo> {
  const manifest = new Map<string, ZipEntryInfo>();
  try {
    unzipSync(bytes, {
      filter: (file) => {
        const existing = manifest.get(file.name);
        if (existing) {
          existing.occurrences += 1;
        } else {
          manifest.set(file.name, { size: file.size, originalSize: file.originalSize, compression: file.compression, occurrences: 1 });
        }
        return false;
      },
    });
  } catch {
    throw new XlsxReadError("MALFORMED_WORKBOOK", "Répertoire central de l'archive ZIP illisible.");
  }
  return manifest;
}

/** Rejette une archive dont un CHEMIN PERTINENT apparaît plus d'une
 *  fois dans le répertoire central -- OB-3 v1.3, BLOCKER 1 (Cat
 *  Stevens). Jamais "le premier gagne", jamais "le dernier gagne",
 *  jamais une sélection silencieuse : l'archive entière est rejetée
 *  comme ambiguë, AVANT toute tentative de désarchivage de l'une ou
 *  l'autre occurrence, quelles que soient leurs tailles déclarées
 *  respectives. N'échoue PAS sur un chemin absent (0 occurrence) --
 *  c'est à l'appelant de décider comment traiter une absence. */
function assertNoDuplicateRelevantEntry(manifest: Map<string, ZipEntryInfo>, name: string): void {
  const info = manifest.get(name);
  if (info && info.occurrences > 1) {
    throw new XlsxReadError(
      "DUPLICATE_ZIP_ENTRY",
      `Entrée « ${name} » présente ${info.occurrences} fois dans l'archive -- rejetée avant tout désarchivage, aucune résolution automatique entre occurrences.`
    );
  }
}

/** Vérifie qu'une entrée déjà répertoriée dans le manifeste (passe 1)
 *  peut être décompressée sans danger : méthode de compression
 *  supportée (0 = stockée, 8 = deflate -- les seules que `fflate`
 *  sait décompresser), taille décompressée déclarée sous la borne par
 *  entrée fournie, et somme cumulée sous `MAX_TOTAL_UNCOMPRESSED_BYTES`.
 *  N'échoue PAS silencieusement sur une entrée absente : c'est
 *  l'appelant qui décide comment traiter une absence (mandat "clean
 *  failure messages" -- un code d'erreur distinct par cause). Incrémente
 *  `runningTotal.bytes` UNIQUEMENT si l'entrée est acceptée. */
function assertEntryDecompressionSafe(
  manifest: Map<string, ZipEntryInfo>,
  name: string,
  maxEntryBytes: number,
  runningTotal: { bytes: number }
): void {
  const info = manifest.get(name);
  if (!info) return;
  if (info.compression !== 0 && info.compression !== 8) {
    throw new XlsxReadError("MALFORMED_WORKBOOK", `Méthode de compression non prise en charge pour « ${name} ».`);
  }
  if (info.originalSize > maxEntryBytes) {
    throw new XlsxReadError(
      "ENTRY_TOO_LARGE",
      `Entrée « ${name} » trop volumineuse une fois décompressée (${info.originalSize} octets déclarés, limite ${maxEntryBytes} octets) -- rejetée avant désarchivage.`
    );
  }
  const total = runningTotal.bytes + info.originalSize;
  if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new XlsxReadError(
      "ENTRY_TOO_LARGE",
      `Volume total décompressé requis (${total} octets) dépasse la limite globale ${MAX_TOTAL_UNCOMPRESSED_BYTES} octets -- rejeté avant désarchivage de « ${name} ».`
    );
  }
  runningTotal.bytes = total;
}

/** Désarchive UNIQUEMENT les entrées explicitement nommées dans
 *  `names` -- toute autre entrée du ZIP, quelle que soit sa taille
 *  déclarée, n'est jamais atteinte par `inflateSync` (le filtre
 *  l'exclut avant toute décompression). Chaque entrée nommée doit
 *  déjà avoir été validée par `assertEntryDecompressionSafe` avant cet
 *  appel. */
function extractOnly(bytes: Uint8Array, names: ReadonlySet<string>): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, { filter: (file) => names.has(file.name) });
  } catch {
    throw new XlsxReadError("MALFORMED_WORKBOOK", "Le conteneur ZIP est corrompu ou illisible.");
  }
}

/**
 * Point d'entrée principal, PUR : ArrayBuffer -> ParsedSheet.
 * Lève `XlsxReadError` avec un code stable pour toute défaillance
 * (jamais une exception brute non typée exposée à l'appelant --
 * mandat "clean failure messages").
 *
 * DÉCOMPRESSION BORNÉE (mandat OB-3 v1.1) : voir le commentaire de
 * sécurité en tête de fichier. Trois passes strictement bornées,
 * jamais un `unzipSync(bytes)` sans filtre : manifeste (aucune
 * décompression) -> métadonnées (workbook.xml + rels, bornées) ->
 * contenu (feuille résolue + sharedStrings, bornées individuellement
 * ET cumulativement). Aucune entrée hors de ces 4 chemins n'est
 * jamais décompressée, quelle que soit sa taille déclarée.
 *
 * ENTRÉES DUPLIQUÉES (mandat OB-3 v1.3) : chacun de ces 4 chemins est
 * en plus vérifié NON DUPLIQUÉ dans le répertoire central AVANT
 * d'être extrait -- voir le commentaire de sécurité en tête de
 * fichier et `assertNoDuplicateRelevantEntry`.
 */
export function readXlsxWorkbook(buffer: ArrayBuffer): ParsedSheet {
  if (buffer.byteLength > MAX_IMPORT_FILE_SIZE_BYTES) {
    throw new XlsxReadError(
      "FILE_TOO_LARGE",
      `Fichier trop volumineux (${buffer.byteLength} octets, limite ${MAX_IMPORT_FILE_SIZE_BYTES} octets).`
    );
  }

  const bytes = new Uint8Array(buffer);
  if (!checkZipSignature(bytes)) {
    throw new XlsxReadError(
      "NOT_A_ZIP_CONTAINER",
      "Le fichier ne commence pas par une signature ZIP valide -- ce n'est pas un fichier .xlsx (jamais une confiance dans l'extension seule)."
    );
  }

  // Passe 1 -- manifeste : AUCUNE décompression, uniquement le
  // répertoire central (nom, tailles déclarées, méthode) de chaque
  // entrée, pertinente ou non.
  const manifest = buildZipManifest(bytes);

  // Passe 2 -- métadonnées : seules workbook.xml et ses relations
  // sont autorisées, et seulement après vérification de leur taille
  // décompressée déclarée.
  const runningTotal = { bytes: 0 };
  const WORKBOOK_XML = "xl/workbook.xml";
  const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
  // Duplicat rejeté AVANT toute vérification de taille -- une entrée
  // dupliquée ne peut pas être classée "sûre" sur la seule foi d'une
  // occurrence quelconque (OB-3 v1.3, BLOCKER 1).
  assertNoDuplicateRelevantEntry(manifest, WORKBOOK_XML);
  assertNoDuplicateRelevantEntry(manifest, WORKBOOK_RELS);
  assertEntryDecompressionSafe(manifest, WORKBOOK_XML, MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES, runningTotal);
  assertEntryDecompressionSafe(manifest, WORKBOOK_RELS, MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES, runningTotal);
  const metadataZip = extractOnly(bytes, new Set([WORKBOOK_XML, WORKBOOK_RELS]));

  let sheetPath: string;
  try {
    sheetPath = findFirstSheetPath(metadataZip);
  } catch (e) {
    if (e instanceof XlsxReadError) throw e;
    throw new XlsxReadError("MALFORMED_WORKBOOK", "Structure du classeur illisible (workbook.xml/rels).");
  }

  // Passe 3 -- contenu : seules la feuille résolue et
  // xl/sharedStrings.xml (si présente) sont autorisées, chacune
  // vérifiée individuellement ET contre le plafond cumulé -- et,
  // d'abord, chacune vérifiée non dupliquée (OB-3 v1.3, BLOCKER 1).
  assertNoDuplicateRelevantEntry(manifest, sheetPath);
  assertEntryDecompressionSafe(manifest, sheetPath, MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES, runningTotal);
  const SHARED_STRINGS = "xl/sharedStrings.xml";
  const hasSharedStrings = manifest.has(SHARED_STRINGS);
  if (hasSharedStrings) {
    assertNoDuplicateRelevantEntry(manifest, SHARED_STRINGS);
    assertEntryDecompressionSafe(manifest, SHARED_STRINGS, MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES, runningTotal);
  }
  const contentNames = new Set([sheetPath]);
  if (hasSharedStrings) contentNames.add(SHARED_STRINGS);
  const contentZip = extractOnly(bytes, contentNames);

  const sheetBytes = contentZip[sheetPath];
  if (!sheetBytes) {
    throw new XlsxReadError("NO_WORKSHEET_FOUND", `Feuille référencée introuvable dans l'archive : ${sheetPath}.`);
  }

  let sharedStrings: string[] = [];
  const sharedStringsBytes = contentZip[SHARED_STRINGS];
  if (sharedStringsBytes) {
    try {
      sharedStrings = parseSharedStrings(decodeUtf8(sharedStringsBytes));
    } catch {
      throw new XlsxReadError("MALFORMED_WORKBOOK", "Table des chaînes partagées illisible.");
    }
  }

  let parsed: ParsedSheet;
  try {
    parsed = parseWorksheet(decodeUtf8(sheetBytes), sharedStrings);
  } catch {
    throw new XlsxReadError("MALFORMED_WORKBOOK", "Contenu de la feuille illisible.");
  }

  if (parsed.rows.length === 0) {
    throw new XlsxReadError("EMPTY_WORKSHEET", "La feuille ne contient aucune ligne.");
  }

  return parsed;
}
