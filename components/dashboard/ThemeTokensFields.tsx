"use client";

import { isValidHexColor } from "@/lib/color-contrast";
import {
  THEME_SURFACES,
  THEME_TOKEN_KEYS,
  validateThemeTokens,
  type ThemeTokenKey,
} from "@/lib/theme-tokens";

/** État du formulaire : une chaîne par jeton (vide = non configuré). */
export type ThemeTokenInputs = Record<ThemeTokenKey, string>;

export function emptyThemeTokenInputs(): ThemeTokenInputs {
  return Object.fromEntries(THEME_TOKEN_KEYS.map((k) => [k, ""])) as ThemeTokenInputs;
}

/**
 * THEME & CONTENT SETTINGS v1 — champs « couleurs des panneaux et
 * fenêtres » de la page Réglages.
 *
 * Composant CONTRÔLÉ et sans effet : il n'enregistre rien (l'enregistrement
 * passe par le flux unique de la page Réglages, comme les autres
 * groupes). Il affiche, pour chaque paire fond/texte, un aperçu et le
 * message d'erreur précis calculé par `validateThemeTokens` -- la MÊME
 * fonction que celle qui fait foi à l'enregistrement, donc l'écran ne
 * peut pas annoncer « valide » ce que l'enregistrement refuserait.
 *
 * Aucun champ libre : uniquement un sélecteur de couleur et un champ
 * `#RRGGBB` -- jamais de CSS, de HTML ni d'URL.
 */
export default function ThemeTokensFields({
  inputs,
  onChange,
  disabled,
  t,
}: {
  inputs: ThemeTokenInputs;
  onChange: (next: ThemeTokenInputs) => void;
  disabled: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const trimmed = Object.fromEntries(
    THEME_TOKEN_KEYS.map((k) => [k, inputs[k].trim()])
  ) as ThemeTokenInputs;
  const verdict = validateThemeTokens(trimmed);
  const errorsByKey = new Map<string, string>();
  if (!verdict.ok) {
    for (const e of verdict.errors) {
      errorsByKey.set(
        e.key,
        e.code === "PAIR_INCOMPLETE"
          ? t("stThemeTokPairIncomplete")
          : e.code === "LOW_CONTRAST"
            ? t("stThemeTokLowContrast")
            : t("stColorInvalid")
      );
    }
  }
  const anySet = THEME_TOKEN_KEYS.some((k) => trimmed[k] !== "");

  const renderField = (key: ThemeTokenKey) => {
    const value = inputs[key];
    const v = value.trim();
    const valid = v === "" || isValidHexColor(v);
    const error = errorsByKey.get(key);
    return (
      <div key={key} className="mt-3" data-theme-token-field={key}>
        <label className="block text-xs font-semibold text-stone-600" htmlFor={`theme-token-${key}`}>
          {t(`stThemeTok_${key}`)}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="color"
            value={valid && v !== "" ? v : "#ffffff"}
            disabled={disabled}
            onChange={(e) => onChange({ ...inputs, [key]: e.target.value })}
            aria-label={t(`stThemeTok_${key}`)}
            className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-stone-300 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <input
            id={`theme-token-${key}`}
            value={value}
            onChange={(e) => onChange({ ...inputs, [key]: e.target.value })}
            disabled={disabled}
            maxLength={7}
            placeholder="#RRGGBB"
            dir="ltr"
            className={
              "w-28 rounded-xl border p-2 text-sm disabled:bg-stone-50 " +
              (valid && !error ? "border-stone-300" : "border-amber-500 bg-amber-50")
            }
          />
        </div>
        {error && <p className="mt-1 text-xs font-semibold text-amber-700">{error}</p>}
      </div>
    );
  };

  return (
    <div data-settings-theme-tokens="">
      <p className="mt-1 text-sm text-stone-500">{t("stThemeTokensHint")}</p>
      {THEME_SURFACES.map(({ surface, bg, text }) => (
        <div key={surface} className="mt-4 rounded-xl border border-stone-200 p-3" data-theme-token-surface={surface}>
          {renderField(bg)}
          {renderField(text)}
          {isValidHexColor(trimmed[bg]) && isValidHexColor(trimmed[text]) && (
            <span
              aria-hidden="true"
              className="mt-3 inline-block rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-bold"
              style={{ backgroundColor: trimmed[bg], color: trimmed[text] }}
            >
              Aa
            </span>
          )}
        </div>
      ))}
      {renderField("surface_border")}
      <button
        type="button"
        disabled={disabled || !anySet}
        onClick={() => onChange(emptyThemeTokenInputs())}
        className="mt-4 rounded-xl border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
        data-theme-tokens-reset=""
      >
        {t("stThemeTokReset")}
      </button>
    </div>
  );
}
