"use client";

import { createContext, useContext } from "react";
import { translate, dirOf, type Lang, type Translator } from "@/lib/i18n";

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  /** LOT 1B — langue source de CET établissement, nécessaire à la
   *  résolution générique des contenus traduits (lib/translation-resolver.ts) :
   *  jamais déduite ni codée en dur, toujours transmise explicitement. */
  sourceLanguage: Lang;
  t: Translator;
}

const I18nContext = createContext<I18nValue>({
  lang: "fr",
  dir: "ltr",
  sourceLanguage: "fr",
  t: (key, params) => translate("fr", key, params),
});

export function I18nProvider({
  lang,
  sourceLanguage,
  activeLanguages,
  children,
}: {
  lang: Lang;
  /** LOT 1B — repli "fr" uniquement pour les appelants qui ne
   *  fournissent pas encore cette prop (aucune régression pour un
   *  usage existant) ; les nouveaux appels doivent la transmettre
   *  explicitement (voir MenuView.tsx). */
  sourceLanguage?: Lang;
  /** Corrige la seconde occurrence de "lang === 'ar'" codée en dur
   *  trouvée dans ce fichier (jamais retouchée lors de L1A-03,
   *  puisque `dir` n'était alors consommé nulle part) -- dérive
   *  désormais la direction du catalogue transmis, comme dirOf()
   *  ailleurs, jamais une règle réinventée ici. Tableau vide = repli
   *  sur ltr (comportement défensif de dirOf() lui-même). */
  activeLanguages?: ReadonlyArray<{ code: string; dir: "ltr" | "rtl" }>;
  children: React.ReactNode;
}) {
  const value: I18nValue = {
    lang,
    dir: dirOf(lang, activeLanguages ?? []),
    sourceLanguage: sourceLanguage ?? "fr",
    t: (key, params) => translate(lang, key, params),
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
