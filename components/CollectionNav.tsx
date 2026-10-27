/**
 * P1 CUSTOMER COLLECTIONS BY TAGS -- navigation « Collections » de la
 * carte publique.
 *
 * Vue SUPPLÉMENTAIRE uniquement : choisir une collection n'appelle que
 * `onSelect(id)`. Aucune donnée catalogue/panier n'est lue ni modifiée
 * ici.
 *
 * NAVIGATION CATALOGUE MICRO-LOT (issue #11, arbitrage CIO/Ravel
 * `issuecomment-5875680103`) : la pilule de retour « Tout le
 * catalogue » (`onSelect(null)`) a été RETIRÉE — le seul chemin de
 * sortie du mode collection est désormais de choisir une catégorie
 * dans CategoryNav (voir MenuView.tsx::changeActiveCategory), qui
 * ouvre cette catégorie dans son état par défaut plutôt que de
 * restaurer une sélection antérieure. Décision produit explicite,
 * pas un oubli : aucun mécanisme de remplacement n'est introduit.
 *
 * Mobile : UNE seule ligne défilable horizontalement (flex-nowrap +
 * overflow-x-auto), hauteur bornée à une pilule quel que soit le nombre
 * de collections. Accessibilité : <nav> nommée, vrais <button>,
 * état actif via aria-pressed, focus clavier visible.
 *
 * Masquée si aucune collection publiée non vide n'existe.
 *
 * Pas de marge supérieure propre (contrairement à une version
 * antérieure de ce composant) : le lot navigation catalogue a rendu
 * ce composant tantôt premier, tantôt second dans le flux de
 * MenuView.tsx selon l'ordre attendu -- c'est désormais SYSTÉMATIQUEMENT
 * l'appelant qui possède l'espacement vertical (même convention que
 * CategoryNav, qui n'a jamais eu de marge propre), jamais ce composant
 * lui-même.
 */
import type { CustomerCollection } from "@/lib/customer-collections";

const PILL =
  "whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-semibold shadow-sm transition-colors " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel ";

export default function CollectionNav({
  collections,
  activeId,
  onSelect,
  navLabel,
}: {
  collections: ReadonlyArray<CustomerCollection>;
  /** null = catalogue normal (aucune collection sélectionnée). */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Nom accessible de la navigation (lib/i18n.ts: collectionsNavLabel). */
  navLabel: string;
}) {
  if (collections.length === 0) return null;

  return (
    <nav aria-label={navLabel} data-customer-collections-nav="true" className="px-4">
      {/* UX LOT 2026-10 (PR #166, retour de vérification en production) :
          la rangée est CENTRÉE quand elle tient dans la largeur
          (`w-fit` + `mx-auto` : la liste prend la largeur de son contenu
          et se centre) et redevient une rangée défilante classique dès
          qu'elle déborde (`max-w-full` + `overflow-x-auto` : première
          pastille visible à gauche, jamais tronquée -- `justify-center`
          seul aurait masqué le début d'une rangée débordante). Mesuré en
          Chromium réel (scripts/ux-real-browser-check.mjs). */}
      <ul
        data-customer-collections-row="true"
        className="scrollbar-none mx-auto flex w-fit max-w-full flex-nowrap gap-2 overflow-x-auto overscroll-x-contain py-1"
      >
        {collections.map((collection) => {
          const isActive = collection.id === activeId;
          return (
            <li key={collection.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(collection.id)}
                aria-pressed={isActive}
                data-customer-collection-option="collection"
                dir="auto"
                className={
                  PILL + (isActive ? "bg-caramel text-caramel-ink" : "bg-crema text-ink-on-bg-muted")
                }
              >
                {collection.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
