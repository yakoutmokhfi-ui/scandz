/**
 * CUSTOMER TEXT LENGTH v1 — borne de LONGUEUR du texte client d'une
 * RÈGLE de livraison (`restaurant_sale_mode_fulfillments.customer_text`),
 * portée de 500 à 1000 caractères.
 *
 * SEULE autorité côté client : le `maxLength` du champ de saisie ET la
 * validation avant envoi la lisent ici, jamais deux nombres écrits en
 * dur qui pourraient diverger. MIROIR EXACT du CHECK SQL de cette même
 * colonne (supabase/DRAFT-lot-delivery-customer-text-1000-v1.sql) et
 * du CHECK du cliché de commande (`odfs_customer_text_length`), qui
 * doit rester cohérent avec sa source : une règle de 1000 caractères
 * doit pouvoir être enregistrée DANS une commande.
 *
 * Jamais une troncature. Au-delà de cette borne, la saisie est refusée
 * (message marchand), et le serveur la refuserait de toute façon.
 *
 * HORS PÉRIMÈTRE, volontairement inchangé : le texte générique de MODE
 * (`restaurant_sale_modes.customer_text`, zone « Information par mode »
 * du même écran) reste borné à 500 — sa colonne porte son propre CHECK,
 * non modifié par ce lot, et la borne MCC s'y aligne par commentaire.
 */
export const DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH = 1000;

/** Input normalization preserves token order: the resolver uses the first match. */
export function parseZoneInput(input: string): string[] {
  return [...new Set(input.split(/[,;\n\r]+/).map((v) => v.trim()).filter(Boolean))];
}

export function deliveryRuleErrorKey(error: unknown): string {
  const e = error as { message?: string; details?: string } | null;
  const text = `${e?.message ?? ""} ${e?.details ?? ""}`;
  if (/B5_INVALID_DISCOUNT|rsmf_discount_policy_valid/.test(text)) return "dpInvalidDiscount";
  if (/B234_CONFIRM_LEGACY_REQUIRED/.test(text)) return "dpLegacyChanged";
  if (/ZV-(COVERED|UNREACHABLE|DUPLICATE-ACROSS)/.test(text)) return "dpZoneOverlap";
  if (/ZV-(FORM|TOO-LONG)/.test(text)) return "dpZoneFormat";
  if (/ZV-(EMPTY|NO-DEFAULT-NO-ZONES)/.test(text)) return "dpZoneRequired";
  if (/one_fallback|MULTIPLE-DEFAULTS/.test(text)) return "dpOneFallback";
  if (/POSTAL_SHAPE_UNSUPPORTED/.test(text)) return "dpShapeUnsupported";
  if (/INVALID_PRICE/.test(text)) return "dpInvalidFee";
  if (/DELIVERY_MODE_REQUIRED/.test(text)) return "dpModeRequired";
  if (/INVALID_PAYLOAD|check constraint|not-null/.test(text)) return "dpInvalidRule";
  return "dpSaveFailed";
}
