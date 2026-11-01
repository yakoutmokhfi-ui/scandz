"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n-context";
import { PRODUCT_SEARCH_MAX_QUERY_LENGTH } from "@/lib/product-search";

/**
 * RECHERCHE DE PRODUITS (issue #169, PR #201) -- champ de saisie de la vitrine.
 *
 * Composant de PRÉSENTATION : il ne connaît ni le catalogue ni le panier, il
 * affiche la saisie et la réinitialise. Le filtrage vit dans lib/product-search.ts
 * et l'état dans MenuView.
 *
 * Accessibilité : région `role="search"`, libellé réel (masqué visuellement mais lu
 * par les lecteurs d'écran), bouton d'effacement nommé, Échap efface, annonce
 * polie du nombre de résultats (`role="status"`) rendue par le parent. `dir="auto"`
 * suit le sens d'écriture de ce que le client tape (arabe ou latin) quel que soit
 * le sens de la page.
 */
export default function ProductSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const inputId = useId();

  return (
    <div role="search" data-product-search="true" className="px-4">
      <label htmlFor={inputId} className="sr-only">
        {t("productSearchLabel")}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type="search"
          dir="auto"
          value={value}
          maxLength={PRODUCT_SEARCH_MAX_QUERY_LENGTH}
          placeholder={t("productSearchPlaceholder")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value !== "") {
              event.preventDefault();
              onChange("");
            }
          }}
          className="w-full appearance-none rounded-full border border-espresso/20 bg-white py-2.5 ps-4 pe-11 text-base text-stone-900 placeholder:text-stone-500 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/40 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
        />
        {value !== "" && (
          <button
            type="button"
            data-product-search-clear="true"
            aria-label={t("productSearchClear")}
            onClick={() => onChange("")}
            className="absolute inset-y-0 end-1 my-auto flex h-9 w-9 items-center justify-center rounded-full text-lg text-stone-600 hover:bg-stone-100"
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
    </div>
  );
}
