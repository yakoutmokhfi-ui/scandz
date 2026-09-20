/**
 * CUSTOMER MENU / SUBCATEGORY FILTER NAVIGATION v1.
 *
 * Barre de FILTRE en pilules pour les sous-catégories de la catégorie
 * ACTIVE -- jamais un second niveau de section. Mandat, littéral : "A
 * subcategory must NEVER render as an independent top-level catalogue
 * section. [...] Subcategories are FILTERS (pill/tab bar) inside that
 * category."
 *
 * Reçoit directement les groupes déjà produits par
 * groupMenuItemsBySubcategory() (lib/catalogue-subcategory-grouping.ts)
 * -- déjà : (a) filtrés aux seuls groupes contenant au moins un produit
 * visible, (b) ordonnés selon compareMenuItemsForPublicDisplay (donc
 * display_order des sous-catégories, jamais un tri alphabétique tant
 * qu'un ordre explicite existe). Ce composant ne recalcule AUCUN ordre
 * ni AUCUN filtre de disponibilité -- pure présentation + sélection.
 *
 * "Tous" est purement visuel : premier pseudo-onglet, jamais dérivé
 * d'une sous-catégorie réelle, jamais persisté. selectedId === null
 * représente "Tous".
 *
 * CUSTOMER MENU / SUBCATEGORY FILTER v1.1 -- remédiation ONE-SUBCATEGORY
 * CASE. Règle corrigée (mandat, littéral : "The filter bar must be
 * hidden ONLY when there are ZERO real subcategories [...] Do not
 * special-case 'one subcategory covering all products'"). L'UI
 * complète est TOUJOURS "Tous" + les sous-catégories réelles -- "Tous"
 * n'est jamais compté seul comme un "choix réel" au sens du précédent
 * LanguageSelector.tsx (celui-ci compare des options RÉELLES entre
 * elles ; ici la question n'est jamais "Tous vs 1 sous-catégorie" mais
 * "existe-t-il au moins UNE sous-catégorie réelle sous cette
 * catégorie"). Masqué UNIQUEMENT si `options` est vide (aucune
 * sous-catégorie réelle) -- y compris quand cette unique sous-catégorie
 * couvre l'intégralité des produits de la catégorie : le mandat exige
 * qu'elle apparaisse quand même, pour que les sous-catégories
 * s'affichent toujours directement sous leur catégorie parente.
 *
 * CUSTOMER MENU / SUBCATEGORY FILTER WRAP v1 -- remplace le défilement
 * horizontal (`overflow-x-auto` + `min-w-full`, qui laissait les
 * dernières pilules hors écran sur mobile tant que l'utilisateur ne
 * faisait pas défiler) par un empilement en LIGNES MULTIPLES
 * (`flex flex-wrap`) : chaque pilule qui ne tient plus sur la ligne
 * courante passe naturellement à la ligne suivante, dans le flux normal
 * de la page -- jamais de défilement requis pour découvrir une option,
 * jamais de pilule masquée. Le nombre de pilules par ligne n'est jamais
 * figé : il découle uniquement de la largeur disponible (mandat,
 * littéral : "The number of pills per line must be determined naturally
 * by available width"). Sur un écran assez large pour que toutes les
 * pilules tiennent, elles restent sur une seule ligne -- `flex-wrap`
 * ne force aucun retour à la ligne artificiel quand il n'est pas
 * nécessaire.
 *
 * `shrink-0` est retiré : dans un conteneur `flex-wrap`, il n'empêchait
 * déjà pas un retour à la ligne (le wrap se déclenche indépendamment de
 * la valeur de shrink), mais sa présence était trompeuse dans le
 * contexte de l'ancien layout à défilement -- retiré pour ne laisser
 * aucune classe héritée de ce layout. `whitespace-nowrap` est CONSERVÉ
 * sur le texte de chaque pilule : il ne cause plus aucun débordement ni
 * découpage maintenant que le conteneur enveloppe la pilule ENTIÈRE
 * (jamais son texte) à la ligne suivante -- un libellé long (ex.
 * "Fromage à la truffe") reste lisible sur une seule ligne à
 * l'intérieur de sa propre pilule, comme n'importe quel composant
 * "pill/tag" standard.
 *
 * LOT 02 -- STICKY SUBCATEGORIES. `sticky` (calculé par l'appelant via
 * shouldStickSubcategoryFilter) : la barre reste collée en haut du
 * viewport pendant le défilement de la catégorie active, sur un fond
 * opaque (bg-crema SANS modificateur d'opacité : crema est une couleur
 * var(--sc-bg), pour laquelle Tailwind 3 ne génère aucune règle
 * "bg-crema/NN"), sous tous les calques existants (z-20 < CategoryNav z-30 <
 * barre panier z-40 < modales z-50 / top layer <dialog>). Son bloc
 * contenant est la <section> de la catégorie active : elle cesse de
 * coller dès que la section quitte l'écran. `sticky` absent/false :
 * rendu STRICTEMENT identique au rendu historique.
 *
 * Choisir une pilule appelle UNIQUEMENT onSelect : aucun défilement
 * forcé de la page (décision CIO, cycle 4).
 *
 * MOBILE CATEGORY FILTERS / TAG NAVIGATION v1 : ce même bloc accueille
 * les sous-catégories et les tags P1 contextuels. Sur mobile, il revient
 * à la ligne sans défilement horizontal et reste borné à environ trois
 * rangées compactes ; si une catégorie possède exceptionnellement plus
 * d'options, le secours est vertical. À partir de sm, la borne disparaît.
 */
import type { Ref } from "react";
import type { SubcategoryFilterOption } from "@/lib/catalogue-subcategory-grouping";
import type { CustomerCollection } from "@/lib/customer-collections";

export type { SubcategoryFilterOption };

const NOOP = () => {};

export default function SubcategoryFilter({
  options,
  activeId,
  tagOptions = [],
  activeTagId = null,
  onSelect,
  onTagSelect = NOOP,
  onClear,
  allLabel,
  sticky = false,
  navRef,
}: {
  /** Une entrée par groupe de sous-catégorie RÉELLE (subcategoryId non
   *  nul) présent dans la catégorie active, déjà dans l'ordre
   *  d'affichage public. Ne doit jamais inclure le groupe "direct"
   *  (subcategoryId === null) -- celui-ci est représenté par "Tous",
   *  pas par une pilule dédiée. */
  options: SubcategoryFilterOption[];
  /** null = "Tous" (aucun filtre de sous-catégorie appliqué). */
  activeId: string | null;
  /** Tags P1 publiés ayant au moins un produit dans la catégorie active. */
  tagOptions?: ReadonlyArray<CustomerCollection>;
  /** null = aucun filtre de tag. */
  activeTagId?: string | null;
  onSelect: (id: string | null) => void;
  onTagSelect?: (id: string | null) => void;
  /** "Tous" réinitialise ensemble sous-catégorie et tag. */
  onClear?: () => void;
  /** Libellé localisé de "Tous" (lib/i18n.ts: subcategoryFilterAll). */
  allLabel: string;
  /** LOT 02 -- barre collée pendant le défilement (catalogue long). */
  sticky?: boolean;
  /** Référence vers le <nav> (mesure de son bord inférieur par
   *  l'appelant, voir MenuView). */
  navRef?: Ref<HTMLElement>;
}) {
  // Masqué uniquement si la catégorie n'a ni sous-catégorie réelle ni
  // tag public contextuel. Une seule option réelle suffit toujours.
  if (options.length === 0 && tagOptions.length === 0) {
    return null;
  }

  return (
    <nav
      ref={navRef}
      aria-label={allLabel}
      data-category-secondary-filters="true"
      data-subcategory-filter-sticky={sticky ? "true" : undefined}
      className={
        sticky
          ? "sticky top-0 z-20 -mx-4 mt-3 border-b border-espresso/10 bg-crema px-4 pb-3 pt-3"
          : "mt-3 border-b border-espresso/10 pb-3"
      }
    >
      {/* SUBCATEGORY FILTER WRAP v1 -- flex-wrap remplace le défilement
          horizontal : chaque pilule qui ne tient plus sur la ligne
          courante passe à la ligne suivante, jamais hors du flux normal
          de la page. Aucune hauteur fixe n'est imposée à ce conteneur
          -- le nombre de lignes nécessaires reste entièrement determiné
          par le nombre de pilules et la largeur disponible. LOT 02 : en
          mode sticky, une seule ligne défilable sur mobile (< sm). */}
      <ul
        className={
          sticky
            ? "flex max-h-32 flex-wrap gap-1.5 overflow-x-visible overflow-y-auto py-1 sm:max-h-none sm:gap-2 sm:overflow-y-visible"
            : "flex max-h-32 flex-wrap gap-1.5 overflow-x-visible overflow-y-auto sm:max-h-none sm:gap-2 sm:overflow-y-visible"
        }
      >
        <li key="__all__">
          <button
            type="button"
            onClick={() => (onClear ? onClear() : onSelect(null))}
            aria-pressed={activeId === null && activeTagId === null}
            data-subcategory-filter-option="__all__"
            className={
              "min-h-9 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel sm:min-h-10 sm:px-3.5 sm:py-2 sm:text-sm " +
              (activeId === null && activeTagId === null
                ? "bg-caramel text-caramel-ink shadow-sm"
                : "bg-crema text-ink-on-bg-muted shadow-sm")
            }
          >
            {allLabel}
          </button>
        </li>
        {options.map((option) => {
          const isActive = option.id === activeId;
          return (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => onSelect(option.id)}
                aria-pressed={isActive}
                data-subcategory-filter-option={option.id}
                className={
                  "min-h-9 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel sm:min-h-10 sm:px-3.5 sm:py-2 sm:text-sm " +
                  (isActive
                    ? "bg-caramel text-caramel-ink shadow-sm"
                    : "bg-crema text-ink-on-bg-muted shadow-sm")
                }
              >
                {option.name}
              </button>
            </li>
          );
        })}
        {tagOptions.map((tag) => {
          const isActive = tag.id === activeTagId;
          return (
            <li key={`tag:${tag.id}`}>
              <button
                type="button"
                onClick={() => onTagSelect(tag.id)}
                aria-pressed={isActive}
                data-category-tag-option="true"
                dir="auto"
                className={
                  "min-h-9 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel sm:min-h-10 sm:px-3.5 sm:py-2 sm:text-sm " +
                  (isActive
                    ? "border-espresso bg-espresso text-ink-text shadow-sm"
                    : "border-espresso/20 bg-crema text-ink-on-bg-muted")
                }
              >
                {tag.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
