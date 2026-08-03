"use client";

import { useEffect, useMemo, useState } from "react";
import type { RestaurantFull, MenuItem } from "@/lib/types";
import {
  buildWhatsAppUrl,
  formatPrice,
  type CartLine,
  type OrderContext,
} from "@/lib/whatsapp";
import {
  getSettings,
  getOptionGroup,
  getChoices,
  type OptionGroup,
} from "@/lib/restaurants-config";
import { getDeliveryStatus } from "@/lib/delivery";
import {
  EMPTY_CUSTOMER,
  getCustomerErrors,
  type CustomerInfo,
} from "@/lib/customer";
import RestaurantHeader from "@/components/RestaurantHeader";
import RestaurantInfoCard from "@/components/RestaurantInfoCard";
import CategoryNav from "@/components/CategoryNav";
import MenuItemCard from "@/components/MenuItemCard";
import CartPanel from "@/components/CartPanel";
import OptionModal from "@/components/OptionModal";
import OrderConfirmation from "@/components/OrderConfirmation";
import type { FulfillmentType } from "@/components/FulfillmentSelector";
import { I18nProvider } from "@/lib/i18n-context";
import { dirOf, translate, type Lang } from "@/lib/i18n";
import { tName } from "@/lib/menu-i18n";
import Ltr from "@/components/Bidi";

interface CartEntry extends CartLine {
  key: string;
}

/**
 * Composant client racine : détient l'état du panier, de la catégorie
 * active, du mode de récupération, de la fenêtre de choix et de l'écran
 * de confirmation. Le panier est une liste de lignes identifiées par
 * item.id (+ note éventuelle), ce qui permet deux fois le même produit
 * avec des options différentes.
 */
export default function MenuView({
  restaurant,
}: {
  restaurant: RestaurantFull;
}) {
  const settings = useMemo(() => getSettings(restaurant.slug), [restaurant.slug]);

  const [lang, setLang] = useState<Lang>("fr");
  const [cart, setCart] = useState<Record<string, CartEntry>>({});
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState<string>(
    restaurant.categories[0]?.id ?? ""
  );

  // Récupération de la commande
  const [tableNumber, setTableNumber] = useState<number | null>(null);
  const [fulfillmentType, setFulfillmentType] = useState<FulfillmentType | null>(
    null
  );
  const [customer, setCustomer] = useState<CustomerInfo>(EMPTY_CUSTOMER);
  const [showErrors, setShowErrors] = useState(false);

  // Fenêtre de choix (goût, pâtisserie…)
  const [choiceItem, setChoiceItem] = useState<MenuItem | null>(null);
  const [choiceGroup, setChoiceGroup] = useState<OptionGroup | null>(null);
  const [choiceQuantity, setChoiceQuantity] = useState(1);

  // Écran de confirmation
  const [confirmedContext, setConfirmedContext] = useState<OrderContext | null>(
    null
  );
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);

  const activeCategory = restaurant.categories.find(
    (c) => c.id === activeCategoryId
  );

  const isInlineOptions = settings.optionsDisplay === "inline";

  /** Quantités par goût pour un produit donné (affichage sur la carte). */
  function countsFor(item: MenuItem): Record<string, number> {
    const out: Record<string, number> = {};
    for (const line of lines) {
      if (line.item.id !== item.id || !line.note) continue;
      const name = line.note.split(" : ")[1];
      if (name) out[name] = line.quantity;
    }
    return out;
  }

  /** Ajout/retrait direct d'un goût depuis la carte produit. */
  function handleInlineChange(item: MenuItem, choice: MenuItem, delta: number) {
    const group = getOptionGroup(restaurant.slug, item);
    const label = group?.title.includes("goût") ? "Goût" : "Pâtisserie";
    changeQuantity(
      `${item.id}::${choice.name}`,
      delta,
      item,
      `${label} : ${choice.name}`
    );
  }

  const lines: CartEntry[] = useMemo(
    () => Object.values(cart).filter((l) => l.quantity > 0),
    [cart]
  );

  const totalCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const totalPrice = lines.reduce(
    (sum, l) => sum + l.item.price * l.quantity,
    0
  );

  function changeQuantity(
    key: string,
    delta: number,
    item?: MenuItem,
    note?: string
  ) {
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
  function handleAdd(item: MenuItem, quantity = 1) {
    const group = getOptionGroup(restaurant.slug, item);
    if (group) {
      setChoiceItem(item);
      setChoiceGroup(group);
      setChoiceQuantity(quantity);
    } else {
      changeQuantity(item.id, quantity, item);
    }
  }

  /**
   * Confirmation de la répartition : une ligne de panier par goût
   * retenu, ce qui laisse le client ajuster chaque goût séparément.
   */
  function handleChoiceConfirm(
    distribution: { choice: MenuItem; quantity: number }[]
  ) {
    if (!choiceItem || !choiceGroup) return;
    const label = choiceGroup.title.includes("goût") ? "Goût" : "Pâtisserie";
    for (const { choice, quantity } of distribution) {
      changeQuantity(
        `${choiceItem.id}::${choice.name}`,
        quantity,
        choiceItem,
        `${label} : ${choice.name}`
      );
    }
    setChoiceItem(null);
    setChoiceGroup(null);
  }

  function closeChoice() {
    setChoiceItem(null);
    setChoiceGroup(null);
  }

  /** Quantité affichée sur une carte (toutes variantes confondues). */
  function quantityFor(item: MenuItem): number {
    return lines
      .filter((l) => l.item.id === item.id)
      .reduce((sum, l) => sum + l.quantity, 0);
  }

  /** Éligibilité à la livraison : code postal saisi + montant du panier. */
  const deliveryStatus = useMemo(
    () => getDeliveryStatus(settings, customer.postalCode, totalCount),
    [settings, customer.postalCode, totalCount]
  );

  /**
   * Hors zone de livraison, on bascule d'office en retrait sur place :
   * c'est la seule option réellement possible pour ce client.
   */
  useEffect(() => {
    if (settings.serviceMode !== "fulfillment") return;
    if (!settings.pickup) return;
    if (deliveryStatus.block === "out-of-zone") {
      setFulfillmentType("pickup");
    }
  }, [settings, deliveryStatus.block]);

  /**
   * Si la livraison retenue cesse d'être possible (panier réduit,
   * code postal corrigé), on ne laisse pas un mode invalide sélectionné.
   */
  useEffect(() => {
    if (fulfillmentType === "delivery" && !deliveryStatus.eligible) {
      setFulfillmentType(settings.pickup ? "pickup" : null);
    }
  }, [fulfillmentType, deliveryStatus.eligible, settings.pickup]);

  /** Champs manquants ou invalides (l'adresse n'est exigée qu'en livraison). */
  const customerErrors = useMemo(
    () => getCustomerErrors(customer, fulfillmentType === "delivery"),
    [customer, fulfillmentType]
  );
  const customerValid = Object.keys(customerErrors).length === 0;

  /** Contexte de commande complet, ou null si le client n'a pas fini. */
  const orderContext: OrderContext | null = useMemo(() => {
    if (settings.serviceMode === "table") {
      return tableNumber !== null ? { mode: "table", tableNumber } : null;
    }
    if (!customerValid) return null;
    if (fulfillmentType === "pickup") return { mode: "pickup", customer };
    if (fulfillmentType === "delivery" && deliveryStatus.eligible) {
      return {
        mode: "delivery",
        zoneLabel: deliveryStatus.zone!.label,
        customer,
      };
    }
    return null;
  }, [settings, tableNumber, fulfillmentType, deliveryStatus, customer, customerValid]);

  const whatsappUrl =
    lines.length > 0 && orderContext
      ? buildWhatsAppUrl(restaurant, lines, orderContext)
      : null;

  /**
   * Appelé au clic sur "Envoyer la commande" : WhatsApp s'ouvre dans un
   * nouvel onglet, on affiche la confirmation et on vide le panier.
   */
  function handleOrderSent() {
    setConfirmedContext(orderContext);
    setIsCartOpen(false);
    setIsConfirmationOpen(true);
    setCart({});
    setTableNumber(null);
    setFulfillmentType(null);
    setCustomer(EMPTY_CUSTOMER);
    setShowErrors(false);
  }

  function closeConfirmation() {
    setIsConfirmationOpen(false);
    setActiveCategoryId(restaurant.categories[0]?.id ?? "");
  }

  const t = (key: string, params?: Record<string, string | number>) =>
    translate(lang, key, params);

  return (
    <I18nProvider lang={lang}>
    <div className="mx-auto min-h-screen max-w-lg pb-28" dir={dirOf(lang)}>
      <RestaurantHeader
        restaurant={restaurant}
        lang={lang}
        onChangeLang={setLang}
      />

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
              {tName(activeCategory, lang)}
            </h2>
            <div className="mt-4 space-y-4">
              {activeCategory.menu_items.map((item) => {
                const group = getOptionGroup(restaurant.slug, item);
                const inline = isInlineOptions && group !== null;
                return (
                  <MenuItemCard
                    key={item.id}
                    item={item}
                    currency={restaurant.config.currency}
                    quantity={quantityFor(item)}
                    requiresChoice={group !== null}
                    inlineChoices={
                      inline ? getChoices(restaurant, group!) : undefined
                    }
                    inlineCounts={inline ? countsFor(item) : undefined}
                    onAdd={(qty) => handleAdd(item, qty)}
                    onRemove={() => changeQuantity(item.id, -1)}
                    onChangeChoice={
                      inline
                        ? (choice, delta) =>
                            handleInlineChange(item, choice, delta)
                        : undefined
                    }
                  />
                );
              })}
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
            🛒{" "}
            {t(totalCount > 1 ? "cartBarItemsPlural" : "cartBarItems", {
              n: totalCount,
            })}
          </span>
          <span className="font-bold">
            <Ltr>{formatPrice(totalPrice, restaurant.config.currency)}</Ltr> —{" "}
            {t("cartBarAction")}
          </span>
        </button>
      )}

      {choiceItem && choiceGroup && (
        <OptionModal
          title={choiceGroup.title}
          choices={getChoices(restaurant, choiceGroup)}
          item={choiceItem}
          currency={restaurant.config.currency}
          presets={choiceGroup.quantityPresets}
          initialQuantity={choiceQuantity}
          onConfirm={handleChoiceConfirm}
          onClose={closeChoice}
        />
      )}

      {isCartOpen && (
        <CartPanel
          restaurant={restaurant}
          settings={settings}
          lines={lines}
          totalCount={totalCount}
          totalPrice={totalPrice}
          tableNumber={tableNumber}
          fulfillmentType={fulfillmentType}
          deliveryStatus={deliveryStatus}
          customer={customer}
          customerErrors={customerErrors}
          showErrors={showErrors}
          whatsappUrl={whatsappUrl}
          onChangeQuantity={(key, delta) => changeQuantity(key, delta)}
          onSelectTable={setTableNumber}
          onSelectFulfillment={(t) => {
            setFulfillmentType(t);
            setShowErrors(true);
          }}
          onChangeCustomer={(patch) =>
            setCustomer((prev) => ({ ...prev, ...patch }))
          }
          onOrderSent={handleOrderSent}
          onClose={() => setIsCartOpen(false)}
        />
      )}

      {isConfirmationOpen && (
        <OrderConfirmation
          restaurant={restaurant}
          context={confirmedContext}
          onBackToMenu={closeConfirmation}
          onNewOrder={closeConfirmation}
        />
      )}
    </div>
    </I18nProvider>
  );
}
