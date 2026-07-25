"use client";

import { useState } from "react";

const LANGUAGES = [
  { code: "fr", label: "🇫🇷 FR" },
  { code: "en", label: "🇬🇧 EN" },
  { code: "ar", label: "🇩🇿 العربية" },
] as const;

/**
 * Sélecteur de langue (maquette). La sélection est mémorisée mais
 * le contenu reste en français pour le MVP : le branchement i18n
 * (dictionnaires + RTL pour l'arabe) est prévu post-MVP.
 */
export default function LanguageSelector() {
  const [active, setActive] = useState<string>("fr");

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full bg-espresso/50 p-1 backdrop-blur">
      {LANGUAGES.map((lang) => (
        <button
          key={lang.code}
          onClick={() => setActive(lang.code)}
          aria-pressed={active === lang.code}
          className={
            "rounded-full px-2.5 py-1 text-xs font-semibold transition-colors " +
            (active === lang.code
              ? "bg-crema text-espresso"
              : "text-crema/80")
          }
        >
          {lang.label}
        </button>
      ))}
    </div>
  );
}
