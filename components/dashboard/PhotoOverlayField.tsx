"use client";

import {
  STOREFRONT_PHOTO_OVERLAY_VALUES,
  photoOverlayLayerResolved,
  type StorefrontPhotoOverlay,
} from "@/lib/storefront-photo-overlay";

/** Photo de substitution de l'aperçu quand l'établissement n'a pas (encore) de cover. */
const PREVIEW_FALLBACK_PHOTO = "linear-gradient(135deg, #F6D9A8 0%, #E9A15B 45%, #B86B3A 100%)";

/**
 * STOREFRONT PHOTO OVERLAY v1 — réglage « Assombrissement de la photo de
 * couverture » de la page Réglages.
 *
 * Composant CONTRÔLÉ et sans effet : il n'enregistre rien (l'enregistrement
 * passe par le flux unique de la page Réglages, comme les autres groupes).
 * Jeu FERMÉ de trois valeurs, jamais de saisie libre. Aperçu : la photo de
 * couverture de l'établissement (ou un dégradé neutre à défaut) avec le
 * MÊME voile que la vitrine (lib/storefront-photo-overlay.ts), teinté par
 * la couleur « ink » connue de la page (secondary_color) ou, à défaut, la
 * teinte historique -- l'aperçu est indicatif si le thème a une autre
 * teinte, et le dit.
 */
export default function PhotoOverlayField({
  value,
  onChange,
  disabled,
  coverUrl,
  ink,
  t,
}: {
  value: StorefrontPhotoOverlay;
  onChange: (next: StorefrontPhotoOverlay) => void;
  disabled: boolean;
  coverUrl: string | null;
  ink: string | null;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const layer = photoOverlayLayerResolved(value, ink);
  const photo = coverUrl ? `url('${coverUrl}')` : PREVIEW_FALLBACK_PHOTO;
  return (
    <div data-settings-photo-overlay-field="">
      <p className="mt-1 text-xs text-stone-500">{t("stPhotoOverlayHint")}</p>
      {disabled && <p className="mt-2 text-xs text-stone-500" data-photo-overlay-disabled-note="">{t("stPhotoOverlayUnavailable")}</p>}

      <fieldset className="mt-3" disabled={disabled}>
        <legend className="sr-only">{t("stPhotoOverlayTitle")}</legend>
        <div className="space-y-2">
          {STOREFRONT_PHOTO_OVERLAY_VALUES.map((mode) => (
            <label key={mode} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-800 has-[:checked]:border-stone-800">
              <input
                type="radio"
                name="storefront-photo-overlay"
                value={mode}
                checked={value === mode}
                disabled={disabled}
                onChange={() => onChange(mode)}
                data-photo-overlay-option={mode}
              />
              <span>{t(`stPhotoOverlay_${mode}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="mt-3 text-xs font-semibold text-stone-600">{t("stPhotoOverlayPreview")}</p>
      <div
        className="mt-1 h-24 w-full rounded-xl border border-stone-200"
        data-photo-overlay-preview={value}
        role="img"
        aria-label={`${t("stPhotoOverlayPreview")} — ${t(`stPhotoOverlay_${value}`)}`}
        style={{
          backgroundImage: layer ? `${layer}, ${photo}` : photo,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <p className="mt-1 text-[11px] text-stone-500">{t("stPhotoOverlayPreviewNote")}</p>
    </div>
  );
}
