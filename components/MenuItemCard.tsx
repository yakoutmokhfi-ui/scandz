import type { MenuItem } from "@/lib/types";
import { formatPrice } from "@/lib/whatsapp";
import QuantityControl from "@/components/QuantityControl";

/**
 * Carte produit compacte horizontale (décision UX CTO) :
 * photo à gauche (~112 px), informations à droite, bouton
 * "Ajouter" en bas à droite. Sans photo, les informations
 * occupent toute la largeur.
 */
export default function MenuItemCard({
  item,
  currency,
  quantity,
  requiresChoice,
  onAdd,
  onRemove,
}: {
  item: MenuItem;
  currency: string;
  quantity: number;
  requiresChoice: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  return (
    <article className="flex gap-3 rounded-2xl bg-white p-3 shadow-sm">
      {item.image_url && (
        <img
          src={item.image_url}
          alt={item.name}
          className="h-28 w-28 shrink-0 rounded-xl object-cover"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="font-semibold leading-snug">{item.name}</h3>
        {item.description && (
          <p className="mt-0.5 line-clamp-2 text-sm text-espresso/60">
            {item.description}
          </p>
        )}

        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <span className="font-bold text-caramel-dark">
            {formatPrice(item.price, currency)}
          </span>

          {requiresChoice ? (
            /* Article avec choix : le bouton ouvre toujours la modal,
               les quantités par variante se gèrent dans le panier. */
            <div className="flex items-center gap-2">
              {quantity > 0 && (
                <span className="rounded-full bg-crema px-2.5 py-1 text-sm font-semibold">
                  ×{quantity}
                </span>
              )}
              <button
                onClick={onAdd}
                className="rounded-full bg-caramel px-4 py-1.5 text-sm font-semibold text-white active:bg-caramel-dark"
              >
                Ajouter
              </button>
            </div>
          ) : (
            <QuantityControl
              quantity={quantity}
              onChange={(delta) => (delta > 0 ? onAdd() : onRemove())}
            />
          )}
        </div>
      </div>
    </article>
  );
}
