"use client";

import type { Lang } from "@/lib/i18n";

export interface SelectableLanguage {
  code: string;
  label: string;
}

export default function LanguageSelector({
  active,
  onChange,
  languages = [],
}: {
  active: Lang;
  onChange: (lang: Lang) => void;
  /** LOT 1A — langues actives de CET établissement, déjà triées par
   *  display_order (voir lib/services/restaurant.ts). Remplace la
   *  constante globale LANGUAGES : chaque établissement choisit ses
   *  propres langues, jamais une liste identique pour tous. Défaut
   *  défensif [] : un appelant qui omettrait cette prop (ne devrait
   *  jamais arriver en production, getRestaurantBySlug garantit
   *  toujours au moins ['fr']) voit simplement le sélecteur masqué,
   *  jamais un plantage. */
  languages?: SelectableLanguage[];
}) {
  // Corrige l'exigence explicite du Lot 1A : une seule langue active
  // -> pas de sélecteur affiché (rien à choisir), jamais un élément
  // d'interface inutile.
  if (languages.length <= 1) {
    return null;
  }

  return (
    // Corrige V72-02 (contre-audit Work, 3e tour) : fond ENTIÈREMENT
    // OPAQUE (plus de "/50"), positionné sur la photo de bannière.
    // La lisibilité ne doit pas dépendre de la luminosité de la photo
    // téléchargée -- un fond translucide sur photo n'offre AUCUNE
    // garantie de contraste calculable (le contenu de la photo est
    // arbitraire), quelle que soit la couleur de texte choisie
    // derrière. Un fond opaque rend --sc-ink-text (déjà calculée avec
    // précision) réellement garantie, indépendamment de l'image.
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full bg-espresso p-1">
      {languages.map((lang) => (
        <button
          key={lang.code}
          onClick={() => onChange(lang.code)}
          aria-pressed={active === lang.code}
          lang={lang.code}
          className={
            "rounded-full px-2.5 py-1 text-xs font-semibold transition-colors " +
            // Corrige V74-01 (contre-audit Work, 5e tour) : l'état
            // INACTIF utilisait text-ink-text/80 -- une opacité
            // Tailwind appliquée à --sc-ink-text (déjà calculée pour
            // un contraste optimal contre le fond désormais opaque)
            // la fait retomber vers ce même fond en la mélangeant
            // partiellement avec lui, dégradant la garantie de
            // contraste. Reproduit empiriquement avec
            // secondary_color=#777777 : ratio effectif ≈ 3,97:1,
            // sous le seuil WCAG AA (4,5:1) requis pour ce petit
            // texte (text-xs). Repéré dans RestaurantHeader.tsx et
            // RestaurantInfoBar.tsx lors du tour précédent (V73-02),
            // mais omis ici par erreur -- même correctif : texte à
            // pleine opacité, l'état actif (déjà validé, inchangé)
            // continue de distinguer visuellement la langue
            // sélectionnée via bg-crema/text-ink-on-bg.
            (active === lang.code ? "bg-crema text-ink-on-bg" : "text-ink-text")
          }
        >
          {lang.label}
        </button>
      ))}
    </div>
  );
}
