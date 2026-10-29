"use client";

import { useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n-context";

/**
 * OPTION « MISE SOUS VIDE » -- case facultative, décochée par défaut.
 *
 * Rendue UNIQUEMENT par CartPanel quand le panier contient au moins un article
 * d'une catégorie éligible (voir lib/vacuum-packing.ts). Le bouton « i » est un
 * vrai <button> : atteignable au clavier, nom accessible dédié, état
 * `aria-expanded` relié à l'explication par `aria-controls`; Échap la referme et
 * rend le focus au bouton. L'explication est un texte dans la page (pas une
 * infobulle au survol), donc lisible au lecteur d'écran et au toucher.
 */
export default function VacuumPackingOption({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const checkId = `${uid}-check`;
  const infoId = `${uid}-info`;
  const [open, setOpen] = useState(false);
  const infoButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      data-vacuum-packing-option=""
      className="mt-4"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          infoButtonRef.current?.focus();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <input
          id={checkId}
          type="checkbox"
          data-vacuum-packing-checkbox=""
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={open ? infoId : undefined}
          className="mt-1 h-5 w-5 shrink-0 accent-green-700"
        />
        <label htmlFor={checkId} className="min-w-0 flex-1 py-0.5 text-sm font-medium">
          {t("vacuumPackingLabel")}
        </label>
        <button
          type="button"
          ref={infoButtonRef}
          data-vacuum-packing-info-button=""
          aria-expanded={open}
          aria-controls={infoId}
          aria-label={t("vacuumPackingInfoButton")}
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-espresso/30 text-sm font-bold italic"
        >
          <span aria-hidden="true">i</span>
        </button>
      </div>
      <p
        id={infoId}
        data-vacuum-packing-info=""
        hidden={!open}
        className="mt-2 rounded-xl bg-crema p-3 text-sm text-stone-900"
      >
        {t("vacuumPackingInfo")}
      </p>
    </div>
  );
}
