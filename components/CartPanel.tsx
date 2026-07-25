import type { RestaurantFull } from "@/lib/types";
import { formatPrice, type CartLine } from "@/lib/whatsapp";
import QuantityControl from "@/components/QuantityControl";
import TableSelector from "@/components/TableSelector";

interface CartEntry extends CartLine {
  key: string;
}

export default function CartPanel({
  restaurant,
  lines,
  totalPrice,
  tableNumber,
  whatsappUrl,
  onChangeQuantity,
  onSelectTable,
  onOrderSent,
  onClose,
}: {
  restaurant: RestaurantFull;
  lines: CartEntry[];
  totalPrice: number;
  tableNumber: number | null;
  whatsappUrl: string | null;
  onChangeQuantity: (key: string, delta: number) => void;
  onSelectTable: (table: number) => void;
  onOrderSent: () => void;
  onClose: () => void;
}) {
  const { currency, max_tables } = restaurant.config;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-espresso/50">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-2xl bg-crema">
        <div className="flex items-center justify-between border-b border-espresso/10 px-4 py-3">
          <h2 className="text-lg font-bold">Votre commande</h2>
          <button
            onClick={onClose}
            aria-label="Fermer le panier"
            className="rounded-full px-3 py-1 text-sm font-medium text-espresso/60"
          >
            Fermer ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-espresso/60">
              Votre panier est vide. Ajoutez des articles depuis le menu.
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map(({ key, item, quantity, note }) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-xl bg-white p-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug">{item.name}</p>
                    {note && (
                      <p className="text-xs text-espresso/60">{note}</p>
                    )}
                    <p className="mt-0.5 text-sm text-caramel-dark">
                      {formatPrice(item.price * quantity, currency)}
                    </p>
                  </div>
                  <QuantityControl
                    quantity={quantity}
                    onChange={(delta) => onChangeQuantity(key, delta)}
                  />
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            <TableSelector
              maxTables={max_tables}
              selected={tableNumber}
              onSelect={onSelectTable}
            />
          )}
        </div>

        {lines.length > 0 && (
          <div className="border-t border-espresso/10 px-4 py-4">
            <div className="mb-3 flex items-center justify-between font-bold">
              <span>Total</span>
              <span>{formatPrice(totalPrice, currency)}</span>
            </div>
            {whatsappUrl ? (
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onOrderSent}
                className="block rounded-xl bg-[#25D366] py-3.5 text-center font-bold text-white"
              >
                Envoyer la commande sur WhatsApp
              </a>
            ) : (
              <p className="rounded-xl bg-espresso/5 py-3.5 text-center text-sm font-medium text-espresso/60">
                Choisissez votre numéro de table pour envoyer la commande
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
