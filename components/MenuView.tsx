"use client";

import { useMemo, useState } from "react";
import type { RestaurantFull, MenuItem } from "@/lib/types";
import { buildWhatsAppUrl, formatPrice, type CartLine } from "@/lib/whatsapp";
import { requiresPastryChoice, getPastryChoices } from "@/lib/options";
import RestaurantHeader from "@/components/RestaurantHeader";
import RestaurantInfoCard from "@/components/RestaurantInfoCard";
import CategoryNav from "@/components/CategoryNav";
import MenuItemCard from "@/components/MenuItemCard";
import CartPanel from "@/components/CartPanel";
import PastryModal from "@/components/PastryModal";
import OrderConfirmation from "@/components/OrderConfirmation";

interface CartEntry extends CartLine {
  key: string;
}

/**
 * Composant client racine : détient l'état du panier, de la
 * catégorie active, du numéro de table, de la modal de choix et de
 * l'écran de confirmation. Le panier est une liste de lignes
 * identifiées par item.id (+ note éventuelle), ce qui permet deux
 * Formules Prestigio avec des pâtisseries différentes.
 */
export default function MenuView({
  restaurant,
}: {
  restaurant: RestaurantFull;
}) {
  const [cart, setCart] = useState<Record<string, CartEntry>>({});
  const [tableNumber, setTableNumber] = useState<number | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [choiceItem, setChoiceItem] = useState<MenuItem | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string>(
    restaurant.categories[0]?.id ?? ""
  );
  const [confirmedTable, setConfirmedTable] = useState<number | null>(null);
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);

  const pastries = useMemo(() => getPastryChoices(restaurant), [restaurant]);

  const activeCategory = restaurant.categories.find(
    (c) => c.id === activeCategoryId
  );

  const lines: CartEntry[] = useMemo(
    () => Object.values(cart).filter((l) => l.quantity > 0),
    [cart]
  );

  const totalCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const totalPrice = lines.reduce(
    (sum, l) => sum + l.item.price * l.quantity,
    0
  );

  function changeQuantity(key: string, delta: number, item?: MenuItem, note?: string) {
    setCart((prev) => {
      const next = { ...prev };
      const existing = next[key];
      const quantity = (existing?.quantity ?? 0) + delta;
      if (quantity <= 0) {
        delete next[key];
      } else {
        next[key] = {
          key,
          item: existing?.item ?? item!,
          note: existing?.note ?? note,
          quantity,
        };
      }
      return next;
    });
  }

  /** Clic "Ajouter" sur une carte du menu. */
  function handleAdd(item: MenuItem) {
    if (requiresPastryChoice(item)) {
      setChoiceItem(item);
    } else {
      changeQuantity(item.id, 1, item);
    }
  }

  /** Confirmation de la pâtisserie dans la modal. */
  function handlePastryConfirm(pastry: MenuItem) {
    if (!choiceItem) return;
    const note = `Pâtisserie : ${pastry.name}`;
    changeQuantity(`${choiceItem.id}::${pastry.name}`, 1, choiceItem, note);
    setChoiceItem(null);
  }

  /** Quantité affichée sur une carte (toutes variantes confondues). */
  function quantityFor(item: MenuItem): number {
    return lines
      .filter((l) => l.item.id === item.id)
      .reduce((sum, l) => sum + l.quantity, 0);
  }

  /**
   * Appelé au clic sur "Envoyer la commande sur WhatsApp" : WhatsApp
   * s'ouvre dans un nouvel onglet, on affiche la confirmation et on
   * vide le panier.
   */
  function handleOrderSent() {
    setConfirmedTable(tableNumber);
    setIsCartOpen(false);
    setIsConfirmationOpen(true);
    setCart({});
    setTableNumber(null);
  }

  function closeConfirmation() {
    setIsConfirmationOpen(false);
    setActiveCategoryId(restaurant.categories[0]?.id ?? "");
  }

  const whatsappUrl =
    lines.length > 0 && tableNumber !== null
      ? buildWhatsAppUrl(restaurant, lines, tableNumber)
      : null;

  return (
    <div className="mx-auto min-h-screen max-w-lg pb-28">
      <RestaurantHeader restaurant={restaurant} />

      <RestaurantInfoCard restaurant={restaurant} />

      <div className="mt-6">
      <CategoryNav
        categories={restaurant.categories}
        activeId={activeCategoryId}
        onSelect={setActiveCategoryId}
      />
      </div>

      <main className="px-4">
        {activeCategory && (
          <section className="mt-7">
            <h2 className="text-lg font-bold uppercase tracking-wide text-caramel-dark">
              {activeCategory.name}
            </h2>
            <div className="mt-4 space-y-4">
              {activeCategory.menu_items.map((item) => (
                <MenuItemCard
                  key={item.id}
                  item={item}
                  currency={restaurant.config.currency}
                  quantity={quantityFor(item)}
                  requiresChoice={requiresPastryChoice(item)}
                  onAdd={() => handleAdd(item)}
                  onRemove={() => changeQuantity(item.id, -1)}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Barre panier fixe en bas d'écran */}
      {totalCount > 0 && (
        <button
          onClick={() => setIsCartOpen(true)}
          className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-lg items-center justify-between bg-espresso px-6 py-4 text-crema"
        >
          <span className="font-medium">
            🛒 {totalCount} article{totalCount > 1 ? "s" : ""}
          </span>
          <span className="font-bold">
            {formatPrice(totalPrice, restaurant.config.currency)} — Voir la
            commande
          </span>
        </button>
      )}

      {choiceItem && (
        <PastryModal
          pastries={pastries}
          onConfirm={handlePastryConfirm}
          onClose={() => setChoiceItem(null)}
        />
      )}

      {isCartOpen && (
        <CartPanel
          restaurant={restaurant}
          lines={lines}
          totalPrice={totalPrice}
          tableNumber={tableNumber}
          whatsappUrl={whatsappUrl}
          onChangeQuantity={(key, delta) => changeQuantity(key, delta)}
          onSelectTable={setTableNumber}
          onOrderSent={handleOrderSent}
          onClose={() => setIsCartOpen(false)}
        />
      )}

      {isConfirmationOpen && (
        <OrderConfirmation
          restaurant={restaurant}
          tableNumber={confirmedTable}
          onBackToMenu={closeConfirmation}
          onNewOrder={closeConfirmation}
        />
      )}
    </div>
  );
}
