"use client";

import { LANGUAGES, type Lang } from "@/lib/i18n";

export default function LanguageSelector({
  active,
  onChange,
}: {
  active: Lang;
  onChange: (lang: Lang) => void;
}) {
  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full bg-espresso/50 p-1 backdrop-blur">
      {LANGUAGES.map((lang) => (
        <button
          key={lang.code}
          onClick={() => onChange(lang.code)}
          aria-pressed={active === lang.code}
          lang={lang.code}
          className={
            "rounded-full px-2.5 py-1 text-xs font-semibold transition-colors " +
            (active === lang.code ? "bg-crema text-espresso" : "text-crema/80")
          }
        >
          {lang.label}
        </button>
      ))}
    </div>
  );
}
