import type { MenuCategory } from "@/lib/types";

/**
 * Barre de catégories sticky. Les pastilles passent à la ligne
 * (flex-wrap) et se centrent : sur mobile elles occupent deux
 * rangées sans troncature ni défilement caché ; sur écran large,
 * elles tiennent sur une seule ligne s'il y a la place.
 * Le comportement de filtrage est inchangé.
 */
export default function CategoryNav({
  categories,
  activeId,
  onSelect,
}: {
  categories: MenuCategory[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="sticky top-0 z-30 border-b border-espresso/10 bg-crema/95 backdrop-blur">
      <div className="flex flex-wrap justify-center gap-2 px-4 py-3">
        {categories.map((category) => {
          const isActive = category.id === activeId;
          return (
            <button
              key={category.id}
              onClick={() => onSelect(category.id)}
              aria-pressed={isActive}
              className={
                "whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors " +
                (isActive
                  ? "bg-caramel text-white shadow-sm"
                  : "bg-white text-espresso/80 shadow-sm")
              }
            >
              {category.name}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
