/**
 * P1 CUSTOMER COLLECTIONS BY TAGS -- navigation « Collections » de la
 * carte publique.
 *
 * Vue SUPPLÉMENTAIRE uniquement : choisir une collection n'appelle que
 * `onSelect(id)`, choisir « Tout le catalogue » `onSelect(null)`. Aucune
 * donnée catalogue/panier n'est lue ni modifiée ici.
 *
 * Mobile : UNE seule ligne défilable horizontalement (flex-nowrap +
 * overflow-x-auto), hauteur bornée à une pilule quel que soit le nombre
 * de collections. Accessibilité : <nav> nommée, vrais <button>,
 * état actif via aria-pressed, focus clavier visible.
 *
 * Masquée si aucune collection publiée non vide n'existe.
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
  allLabel,
}: {
  collections: ReadonlyArray<CustomerCollection>;
  /** null = catalogue normal (aucune collection sélectionnée). */
  activeId: string | null;
  onSelect: (id: string | null) => void;
  /** Nom accessible de la navigation (lib/i18n.ts: collectionsNavLabel). */
  navLabel: string;
  /** Libellé du retour au catalogue normal (lib/i18n.ts: collectionsShowAll). */
  allLabel: string;
}) {
  if (collections.length === 0) return null;

  return (
    <nav aria-label={navLabel} data-customer-collections-nav="true" className="mt-3 px-4">
      <ul
        data-customer-collections-row="true"
        className="scrollbar-none flex flex-nowrap gap-2 overflow-x-auto overscroll-x-contain py-1"
      >
        <li className="shrink-0">
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-pressed={activeId === null}
            data-customer-collection-option="__catalogue__"
            className={
              PILL +
              (activeId === null ? "bg-caramel text-caramel-ink" : "bg-crema text-ink-on-bg-muted")
            }
          >
            {allLabel}
          </button>
        </li>
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
