/**
 * MERCHANT LEGAL & TAX PROFILE v1 — mapping pays -> intitulé de champ,
 * pour l'affichage UNIQUEMENT (jamais un nouveau modèle de données).
 *
 * Contexte (reconnaissance SCANYM — REUSE-FIRST CODE RECONNAISSANCE,
 * feature 5) : `receipt_settings.tax_identifier` et
 * `.registration_number` restent volontairement GÉNÉRIQUES en base
 * (aucune colonne "scheme"/pays n'existe ni n'est ajoutée par ce
 * lot) -- "Do NOT build a large jurisdiction engine in this lot."
 * Le SEUL rôle de ce module est de choisir un LIBELLÉ d'affichage
 * adapté au pays du restaurant (`restaurants.country`, déjà
 * existant depuis Lot D, déjà FK'd contre
 * `scanym_supported_countries`) -- jamais de valider, transformer ou
 * contraindre la VALEUR elle-même, qui reste un texte libre.
 *
 * Portée volontairement minimale : un mapping explicite pour la
 * France (seul pays actuellement peuplé dans
 * scanym_supported_countries pour lequel ce mandat donne un intitulé
 * précis) et la Belgique (donnée en exemple par le mandat, incluse
 * ici pour être immédiatement correcte le jour où `BE` rejoint
 * `scanym_supported_countries` -- aucune dépendance vers cette table
 * n'est nécessaire ici, ce module ne fait AUCUN appel réseau/DB).
 * Tout autre pays (DZ, TN, MA aujourd'hui, ou un pays inconnu/absent)
 * reçoit un intitulé générique, jamais une supposition du type
 * "SIRET" ("Do NOT assume SIRET is universal", mandat).
 *
 * Ces intitulés sont des TERMES ADMINISTRATIFS/juridiques propres à
 * une juridiction (SIREN/SIRET, BCE) -- ils ne sont volontairement
 * PAS traduits par lib/i18n.ts (fr/en/ar) : un intitulé comme "SIREN /
 * SIRET" désigne un numéro français précis, quelle que soit la langue
 * d'affichage du tableau de bord, exactement comme "IBAN" ou "VAT"
 * ne se traduisent pas terme à terme selon la langue de l'utilisateur.
 * Seul le libellé GÉNÉRIQUE de repli est un texte simple, neutre,
 * volontairement compréhensible sans traduction dédiée.
 */

export interface LegalTaxFieldLabels {
  /** Intitulé pour receipt_settings.registration_number. */
  registrationNumberLabel: string;
  /** Intitulé pour receipt_settings.tax_identifier. */
  taxIdentifierLabel: string;
}

const GENERIC_LABELS: LegalTaxFieldLabels = {
  registrationNumberLabel: "Registration number",
  taxIdentifierLabel: "Tax / VAT number",
};

/**
 * Mapping explicite par code pays ISO 3166-1 alpha-2 (même format que
 * `restaurants.country` / `scanym_supported_countries.code`).
 * N'AJOUTER UNE ENTRÉE ICI que pour un intitulé RÉELLEMENT documenté
 * par un mandat produit -- sinon, laisser le repli générique
 * ci-dessus s'appliquer (jamais d'intitulé inventé).
 */
const COUNTRY_LABELS: Record<string, LegalTaxFieldLabels> = {
  FR: {
    registrationNumberLabel: "SIREN / SIRET",
    taxIdentifierLabel: "Numéro de TVA intracommunautaire",
  },
  BE: {
    registrationNumberLabel: "Numéro d'entreprise (BCE)",
    taxIdentifierLabel: "Numéro de TVA",
  },
};

/**
 * Retourne les intitulés de champ adaptés au pays donné, avec repli
 * générique explicite pour tout pays absent du mapping ci-dessus
 * (y compris `null`/`undefined`/chaîne vide -- établissement sans
 * pays renseigné, cas historique légitime, jamais une erreur).
 */
export function getLegalTaxFieldLabels(
  countryCode: string | null | undefined
): LegalTaxFieldLabels {
  if (!countryCode) return GENERIC_LABELS;
  const normalized = countryCode.trim().toUpperCase();
  return COUNTRY_LABELS[normalized] ?? GENERIC_LABELS;
}
