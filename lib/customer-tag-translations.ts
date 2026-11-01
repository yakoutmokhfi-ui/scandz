/** Public, already validated tag translations indexed by stable tag ID. */
export type CustomerTagTranslations = Record<string, Record<string, string>>;

export function translatedTagLabel(
  id: string,
  source: string,
  language: string,
  sourceLanguage: string,
  translations: CustomerTagTranslations | undefined,
): string {
  if (language === sourceLanguage) return source;
  const value = translations?.[id]?.[language];
  return typeof value === "string" && value.trim() ? value : source;
}
