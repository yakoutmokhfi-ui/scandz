/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Lecteur CSV, PURE (aucune dépendance externe, aucun DOM). Format
 * secondaire (mandat : "CSV may be supported if straightforward, but
 * XLSX is the priority") -- couvre le sous-ensemble RFC 4180
 * (guillemets, guillemets échappés `""`, séparateurs `,` ou `;`)
 * suffisant pour un export tableur usuel. Aucune tentative
 * d'interprétation de formule (un CSV n'en contient jamais nativement
 * -- une cellule commençant par `=` reste un TEXTE littéral, jamais
 * évalué).
 *
 * CSV MAL FORMÉ (OB-3 v1.3 -- remédiation, audit indépendant Cat
 * Stevens, BLOCKER 2) : un fichier se terminant en plein milieu d'un
 * champ entre guillemets (ex. `"Produit";"Cat";"10` sans guillemet
 * fermant -- que ce soit sur une seule ligne ou qu'un `\n` interne au
 * champ non fermé ait été rencontré avant la fin du fichier, les deux
 * cas laissent le parseur dans le même état terminal invalide) était
 * auparavant accepté silencieusement : `parseCsvText` sortait de sa
 * boucle principale avec `inQuotes === true` et la branche "dernière
 * ligne sans retour final" poussait `field` tel quel comme une valeur
 * normale, produisant une ligne d'apparence valide à partir d'une
 * entrée structurellement invalide. Le correctif ajoute une vérification
 * de l'état terminal du parseur juste après la boucle principale : si
 * `inQuotes` est encore vrai en fin d'entrée, le fichier est rejeté de
 * façon déterministe via `MALFORMED_CSV`, avant toute construction de
 * ligne. Aucun autre comportement n'est modifié : guillemets fermés
 * normalement, guillemets échappés (`""`), champs multi-lignes
 * correctement fermés, détection du séparateur, et gestion UTF-8/BOM
 * restent strictement identiques à la version précédente.
 */

export type CsvReadErrorCode = "FILE_TOO_LARGE" | "EMPTY_FILE" | "MALFORMED_CSV";

export class CsvReadError extends Error {
  readonly code: CsvReadErrorCode;
  constructor(code: CsvReadErrorCode, message: string) {
    super(message);
    this.name = "CsvReadError";
    this.code = code;
  }
}

import { MAX_IMPORT_FILE_SIZE_BYTES } from "@/lib/catalogue-import/xlsx-reader";

/** Détecte le séparateur (`,` ou `;`) à partir de la première ligne
 *  non vide -- compte les occurrences de chacun HORS zones entre
 *  guillemets, retient le plus fréquent (`;` par défaut en cas
 *  d'égalité, convention tableur francophone). */
function detectDelimiter(sample: string): "," | ";" {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === ",") commas++;
      else if (ch === ";") semicolons++;
      else if (ch === "\n") break;
    }
  }
  return semicolons >= commas ? ";" : ",";
}

/** Parse le texte CSV complet en lignes de cellules texte. Gère les
 *  retours à la ligne À L'INTÉRIEUR d'un champ entre guillemets (ex.
 *  une description longue multi-ligne).
 *
 *  Rejette (OB-3 v1.3, BLOCKER 2) tout fichier dont l'état terminal du
 *  parseur est invalide -- au minimum un champ entre guillemets resté
 *  ouvert jusqu'à la fin de l'entrée, qu'il s'agisse d'un guillemet
 *  fermant manquant sur la dernière ligne ou d'un champ multi-ligne
 *  jamais refermé -- plutôt que d'accepter silencieusement la valeur
 *  partiellement accumulée comme une cellule normale. */
export function parseCsvText(text: string): string[][] {
  // Retire un BOM UTF-8 éventuel (Excel l'ajoute systématiquement à
  // l'export CSV) -- sinon la première colonne de l'en-tête serait
  // mal reconnue ("﻿Type" au lieu de "Type").
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(clean.slice(0, 2000));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = clean.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // État terminal invalide (OB-3 v1.3, BLOCKER 2) : un champ entre
  // guillemets encore ouvert à la fin de l'entrée signifie un
  // guillemet fermant manquant -- que ce soit sur la dernière ligne
  // (`"Produit";"Cat";"10` sans fermeture) ou un champ multi-ligne
  // jamais refermé (même état, un `\n` interne n'a jamais réinitialisé
  // `inQuotes`). Rejet déterministe AVANT toute construction de ligne
  // -- ne jamais normaliser silencieusement `field` en valeur valide.
  if (inQuotes) {
    throw new CsvReadError(
      "MALFORMED_CSV",
      "Champ entre guillemets non terminé (guillemet fermant manquant avant la fin du fichier)."
    );
  }
  // Dernière ligne sans retour final.
  if (field !== "" || row.length > 0) pushRow();

  // Élimine les lignes strictement vides en fin de fichier (une seule
  // cellule vide, aucune donnée) -- artefact courant d'export tableur.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
    else break;
  }

  return rows;
}

/** Point d'entrée principal, PUR : texte brut déjà décodé -> lignes. */
export function readCsvWorkbook(text: string, byteLength: number): string[][] {
  if (byteLength > MAX_IMPORT_FILE_SIZE_BYTES) {
    throw new CsvReadError(
      "FILE_TOO_LARGE",
      `Fichier trop volumineux (${byteLength} octets, limite ${MAX_IMPORT_FILE_SIZE_BYTES} octets).`
    );
  }
  const rows = parseCsvText(text);
  if (rows.length === 0) {
    throw new CsvReadError("EMPTY_FILE", "Le fichier CSV ne contient aucune ligne.");
  }
  return rows;
}
