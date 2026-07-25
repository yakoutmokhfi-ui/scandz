import type { RestaurantFull } from "@/lib/types";

export default function OrderConfirmation({
  restaurant,
  tableNumber,
  onBackToMenu,
  onNewOrder,
}: {
  restaurant: RestaurantFull;
  tableNumber: number | null;
  onBackToMenu: () => void;
  onNewOrder: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-crema px-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
          <span className="text-4xl text-green-600">✓</span>
        </div>

        <h1 className="mt-6 text-2xl font-bold">
          Commande envoyée avec succès !
        </h1>
        <p className="mt-2 text-sm text-espresso/70">
          Votre commande a été transmise à {restaurant.name} via WhatsApp.
        </p>

        <div className="mt-6 space-y-2 rounded-2xl bg-white p-4 text-left text-sm shadow-sm">
          {tableNumber !== null && (
            <p className="font-semibold">🪑 Table {tableNumber}</p>
          )}
          <p className="text-espresso/70">
            ⏱️ Temps de préparation estimé : 10–15 minutes
          </p>
          <p className="text-espresso/70">
            Un membre de notre équipe va confirmer votre commande.
          </p>
          <p className="text-espresso/70">
            Si vous êtes sur place, elle sera servie directement à votre
            table.
          </p>
        </div>

        <p className="mt-6 text-sm italic text-caramel-dark">
          ☕ Merci d'avoir choisi {restaurant.name} !<br />
          Nous préparons votre commande avec soin. Bonne dégustation !
        </p>

        <div className="mt-8 space-y-3">
          <button
            onClick={onBackToMenu}
            className="w-full rounded-xl bg-caramel py-3.5 font-bold text-white"
          >
            Retour au menu
          </button>
          <button
            onClick={onNewOrder}
            className="w-full rounded-xl border border-caramel py-3.5 font-bold text-caramel-dark"
          >
            Passer une autre commande
          </button>
        </div>
      </div>
    </div>
  );
}
