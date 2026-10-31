"use client";

/**
 * Issue #200 — réglage « Produits en rupture » de la page Réglages.
 *
 * Composant CONTRÔLÉ et sans effet : il n'enregistre rien (l'enregistrement
 * passe par le flux unique de la page Réglages, comme les autres groupes).
 * Une seule case à cocher, étiquette visible reliée au champ.
 */
export default function SoldOutVisibilityField({
  value,
  onChange,
  disabled,
  t,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  return (
    <div data-settings-sold-out-field="">
      <p className="mt-1 text-xs text-stone-500" id="sold-out-visibility-hint">{t("stSoldOutHint")}</p>
      {disabled && (
        <p className="mt-2 text-xs text-stone-500" data-sold-out-disabled-note="">{t("stSoldOutUnavailable")}</p>
      )}
      <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-800 has-[:checked]:border-stone-800">
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby="sold-out-visibility-hint"
          data-sold-out-option=""
        />
        <span>{t("stSoldOutLabel")}</span>
      </label>
    </div>
  );
}
