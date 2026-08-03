"use client";

import { createContext, useContext } from "react";
import { translate, type Lang, type Translator } from "@/lib/i18n";

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  t: Translator;
}

const I18nContext = createContext<I18nValue>({
  lang: "fr",
  dir: "ltr",
  t: (key, params) => translate("fr", key, params),
});

export function I18nProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: React.ReactNode;
}) {
  const value: I18nValue = {
    lang,
    dir: lang === "ar" ? "rtl" : "ltr",
    t: (key, params) => translate(lang, key, params),
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
