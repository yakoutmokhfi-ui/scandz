/**
 * Utilitaires purs pour le formulaire de création d'établissement
 * (Lot D). Toute validation ici est un CONFORT pour l'opérateur
 * (retour immédiat) — la validation AUTORITATIVE reste côté serveur
 * dans create_establishment (migration-lotd-establishment-creation.sql),
 * jamais dupliquée en silence : les règles ci-dessous reflètent
 * exactement les mêmes regex que le SQL, pas des règles inventées à
 * part.
 */

/** Miroir exact de `^[a-z0-9]+(-[a-z0-9]+)*$` côté SQL. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Miroir exact de la regex e-mail côté SQL. */
export const OWNER_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

const ACCENT_MAP: Record<string, string> = {
  à: "a", â: "a", ä: "a", á: "a", ã: "a",
  ç: "c",
  è: "e", é: "e", ê: "e", ë: "e",
  î: "i", ï: "i", í: "i", ì: "i",
  ô: "o", ö: "o", ó: "o", õ: "o",
  ù: "u", û: "u", ü: "u", ú: "u",
  ñ: "n",
  œ: "oe", æ: "ae",
};

/**
 * Suggère un slug à partir d'un nom d'établissement. Toujours
 * proposée à l'opérateur pour relecture/modification avant envoi —
 * jamais appliquée silencieusement à sa place (aucune surprise sur
 * l'URL publique finale). Le résultat respecte toujours SLUG_PATTERN
 * quand l'entrée contient au moins un caractère alphanumérique.
 */
export function suggestSlug(name: string): string {
  const lowered = name.toLowerCase();
  const deaccented = lowered.replace(/[à-ÿœæ]/g, (ch) => ACCENT_MAP[ch] ?? ch);
  return deaccented
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function isValidOwnerEmail(email: string): boolean {
  return OWNER_EMAIL_PATTERN.test(email.trim());
}

export const COMMERCE_TYPES = [
  "restaurant",
  "cafe",
  "cheese_shop",
  "bakery",
  "pastry_shop",
  "hotel",
  "bar",
  "other",
] as const;

export const LANGUAGES = ["fr", "en", "ar"] as const;

/**
 * Allowlist métier des pays/devises supportés par Scanym (Lot D,
 * corrige B-05 après audit Work). Doit rester STRICTEMENT
 * synchronisée avec le contenu réel de
 * public.scanym_supported_countries / scanym_supported_currencies —
 * un test dédié (tests/lotd-establishment-creation.test.ts) vérifie
 * cette synchronisation en lisant directement le fichier de
 * migration. Étendre cette liste nécessite de mettre à jour LES DEUX
 * côtés (SQL et ici), jamais un seul.
 *
 * Aucun couplage pays → devise : les deux listes sont indépendantes,
 * un établissement peut choisir n'importe quelle combinaison valide.
 */
export const SUPPORTED_COUNTRIES = [
  { code: "DZ", name: "Algérie" },
  { code: "FR", name: "France" },
  { code: "TN", name: "Tunisie" },
  { code: "MA", name: "Maroc" },
] as const;

export const SUPPORTED_CURRENCIES = [
  { code: "DZD", name: "Dinar algérien" },
  { code: "EUR", name: "Euro" },
  { code: "TND", name: "Dinar tunisien" },
  { code: "MAD", name: "Dirham marocain" },
  { code: "USD", name: "Dollar américain" },
] as const;

export function isSupportedCountry(code: string): boolean {
  return SUPPORTED_COUNTRIES.some((c) => c.code === code.toUpperCase());
}

export function isSupportedCurrency(code: string): boolean {
  return SUPPORTED_CURRENCIES.some((c) => c.code === code.toUpperCase());
}
