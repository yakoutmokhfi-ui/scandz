/** Input normalization preserves token order: the resolver uses the first match. */
export function parseZoneInput(input: string): string[] {
  return [...new Set(input.split(/[,;\n\r]+/).map((v) => v.trim()).filter(Boolean))];
}

export function deliveryRuleErrorKey(error: unknown): string {
  const e = error as { message?: string; details?: string } | null;
  const text = `${e?.message ?? ""} ${e?.details ?? ""}`;
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
