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
 * TYPE — mandat OB-3 : "Do not guess. If 'Type' cannot be
 * deterministically mapped to the current Scanym model, surface it
 * as a documented unsupported/decision-required field."
 *
 * Le modèle Scanym actuel (menu_items, plat) ne connaît qu'UNE seule
 * nature de ligne catalogue : un produit simple, à prix fixe, sans
 * modèle de composition/menu/formule (voir lib/catalogue-fiscal.ts,
 * "SCANYM v1 NE SUPPORTE PAS..."). Aucune valeur de "Type" ne peut
 * donc être mappée avec certitude vers une distinction qui n'existe
 * PAS dans le schéma actuel -- TOUTE valeur, y compris "Produit" ou
 * "Plat", est donc classée UNSUPPORTED/DECISION_REQUIRED par ce lot,
 * jamais silencieusement acceptée ni rejetée : elle est SURFACÉE à
 * l'opérateur (mandat), sans jamais bloquer la ligne pour autant
 * (aucun champ `menu_items` ne dépend de "Type" aujourd'hui -- une
 * ligne reste important-able sans lui, "Type" n'étant qu'informatif
 * tant qu'aucune décision produit n'a tranché sa sémantique).
 */
export type TypeClassification =
  | { kind: "ABSENT" }
  | { kind: "UNSUPPORTED_DECISION_REQUIRED"; rawValue: string };

export function classifyType(raw: string | undefined): TypeClassification {
  if (raw === undefined) return { kind: "ABSENT" };
  const { value, isEmpty } = normalizeText(raw, Number.POSITIVE_INFINITY);
  if (isEmpty) return { kind: "ABSENT" };
  return { kind: "UNSUPPORTED_DECISION_REQUIRED", rawValue: value };
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
