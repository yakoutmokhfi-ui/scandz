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
  type ServiceMode,
} from "@/lib/restaurants-config";
import { getDeliveryStatus } from "@/lib/delivery";
import {
  EMPTY_CUSTOMER,
  getCustomerErrors,
  type CustomerInfo,
} from "@/lib/customer";
import RestaurantHeader from "@/components/RestaurantHeader";
import CategoryNav from "@/components/CategoryNav";
import MenuItemCard from "@/components/MenuItemCard";
import CartPanel from "@/components/CartPanel";
import OptionModal from "@/components/OptionModal";
import OrderConfirmation from "@/components/OrderConfirmation";

import { I18nProvider } from "@/lib/i18n-context";
import { getTheme, themeStyle } from "@/lib/themes";
import { patternUrl } from "@/lib/pattern";
import { createOrder, markWhatsappOpened } from "@/lib/services/orders";
import {
  addToCart,
  cartLines,
  changeLineQuantity,
  decrementItem,
  optionCountsForItem,
  quantityForItem,
  type Cart,
} from "@/lib/cart";
import { dirOf, translate, type Lang } from "@/lib/i18n";
import { tName } from "@/lib/menu-i18n";
import Ltr from "@/components/Bidi";

/** Seul établissement où les variantes d'URL sont acceptées. */
const DEMO_SLUG = "le-sirocco";

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
  const baseSettings = useMemo(
    () => getSettings(restaurant.slug),
    [restaurant.slug]
  );

  /**
   * Variante visuelle de démonstration : ?theme=terrasse applique
   * une autre identité sur le même établissement et le même
   * catalogue. Rien n'est dupliqué en base — c'est uniquement
   * l'apparence qui change.
   *
   * Réservée au Sirocco, l'établissement de démonstration : un
   * paramètre d'URL ne doit pas pouvoir modifier l'apparence d'un
   * menu réellement en service.
   */
  const [variant, setVariant] = useState<{ theme: string; banner: string } | null>(
    null
  );
  useEffect(() => {
    if (restaurant.slug !== DEMO_SLUG) return;
    const asked = new URLSearchParams(window.location.search).get("theme");
    const known: Record<string, { theme: string; banner: string }> = {
      nuit: { theme: "nuit", banner: "sirocco-nuit" },
      terrasse: { theme: "terrasse", banner: "sirocco-terrasse" },
    };
    setVariant(asked ? (known[asked] ?? null) : null);
  }, [restaurant.slug]);

  const settings = useMemo(
    () => (variant ? { ...baseSettings, theme: variant.theme } : baseSettings),
    [baseSettings, variant]
  );
  const menuVariant = restaurant.slug === DEMO_SLUG ? "editorial" : "classic";

  const [lang, setLang] = useState<Lang>("fr");
  const [cart, setCart] = useState<Cart>({});
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState<string>(
    restaurant.categories[0]?.id ?? ""
  );

  // Récupération de la commande
  const [tableNumber, setTableNumber] = useState<number | null>(null);
  // Mode retenu par le client ; pré-sélectionné si l'établissement
  // n'en propose qu'un seul.
  const [serviceMode, setServiceMode] = useState<ServiceMode | null>(
    settings.allowedServiceModes.length === 1
      ? settings.allowedServiceModes[0]
      : null
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

  // Envoi de la commande
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmedNumber, setConfirmedNumber] = useState<number | null>(null);

  const activeCategory = restaurant.categories.find(
    (c) => c.id === activeCategoryId
  );

  const isInlineOptions = settings.optionsDisplay === "inline";

  /** Quantités par goût pour un produit donné (affichage sur la carte). */
  function countsFor(item: MenuItem): Record<string, number> {
    return optionCountsForItem(cart, item.id);
  }

  /** Ajout/retrait direct d'un goût depuis la carte produit. */
  function handleInlineChange(item: MenuItem, choice: MenuItem, delta: number) {
    const group = getOptionGroup(restaurant.slug, item);
    setCart((c) =>
      addToCart(c, {
        item,
        quantity: delta,
        option: choice,
        optionKind: group?.title.includes("goût") ? "flavor" : "pastry",
      })
    );
  }

  const lines = useMemo(() => cartLines(cart), [cart]);

  const totalCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const totalPrice = lines.reduce(
    (sum, l) => sum + l.item.price * l.quantity,
    0
  );


  /**
   * Clic "Ajouter" ou "+" sur une carte du menu.
   * Produit à options : ouvre la fenêtre de choix, sans rien ajouter
   * au panier avant confirmation.
   */
  function handleAdd(item: MenuItem) {
    const group = getOptionGroup(restaurant.slug, item);
    if (group) {
      setChoiceItem(item);
      setChoiceGroup(group);
      setChoiceQuantity(1);
    } else {
      setCart((c) => addToCart(c, { item, quantity: 1 }));
    }
  }

  /** Clic "−" : retire une unité, et le produit s'il n'en reste plus. */
  function handleRemove(item: MenuItem) {
    setCart((c) => decrementItem(c, item.id));
  }

  /**
   * Confirmation de la répartition : une ligne de panier par goût
   * retenu, ce qui laisse le client ajuster chaque goût séparément.
   */
  function handleChoiceConfirm(
    distribution: { choice: MenuItem; quantity: number }[]
  ) {
    if (!choiceItem || !choiceGroup) return;
    const kind = choiceGroup.title.includes("goût") ? "flavor" : "pastry";
    setCart((c) => {
      let next = c;
      for (const { choice, quantity } of distribution) {
        next = addToCart(next, {
          item: choiceItem,
          quantity,
          option: choice,
          optionKind: kind,
        });
      }
      return next;
    });
    setChoiceItem(null);
    setChoiceGroup(null);
  }

  function closeChoice() {
    setChoiceItem(null);
    setChoiceGroup(null);
  }

  /** Quantité affichée sur une carte (toutes variantes confondues). */
  function quantityFor(item: MenuItem): number {
    return quantityForItem(cart, item.id);
  }

  /** Éligibilité à la livraison : code postal saisi + montant du panier. */
  const deliveryStatus = useMemo(
    () => getDeliveryStatus(settings, customer.postalCode, totalCount),
    [settings, customer.postalCode, totalCount]
  );

  /*
   * Le mode livraison reste sélectionné pendant la saisie, même si
   * l'adresse est encore incomplète, hors zone ou sous le minimum.
   * `orderContext` bloque déjà l'envoi tant que `deliveryStatus`
   * n'est pas éligible. Revenir automatiquement au retrait ferait
   * disparaître les champs nécessaires pour corriger la situation.
   */

  /** Champs manquants ou invalides (l'adresse n'est exigée qu'en livraison). */
  const requiredFields = useMemo(
    () =>
      (serviceMode && settings.requiredCustomerFields?.[serviceMode]) ?? [],
    [settings, serviceMode]
  );

  const customerErrors = useMemo(
    () => getCustomerErrors(customer, requiredFields),
    [customer, requiredFields]
  );
  const customerValid = Object.keys(customerErrors).length === 0;

  /** Contexte de commande complet, ou null si le client n'a pas fini. */
  const orderContext: OrderContext | null = useMemo(() => {
    if (serviceMode === "table") {
      return tableNumber !== null ? { mode: "table", tableNumber } : null;
    }
    if (!customerValid) return null;
    if (serviceMode === "pickup") return { mode: "pickup", customer };
    if (serviceMode === "delivery" && deliveryStatus.eligible) {
      return {
        mode: "delivery",
        zoneLabel: deliveryStatus.zone!.label,
        customer,
      };
    }
    return null;
  }, [settings, tableNumber, serviceMode, deliveryStatus, customer, customerValid]);

  /** La commande est prête à partir (le lien est construit après coup). */
  const canSubmit = lines.length > 0 && orderContext !== null;

  /**
   * Clic sur "Envoyer la commande".
   *
   * Ordre volontaire : la commande est d'abord enregistrée en base,
   * puis seulement WhatsApp est ouvert avec le numéro obtenu. En cas
   * d'échec, le panier est conservé intact et aucune confirmation
   * n'est affichée.
   */
  async function handleSendOrder() {
    if (isSubmitting) return;          // double-clic
    if (!orderContext || lines.length === 0) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const order = await createOrder({
        slug: restaurant.slug,
        context: orderContext,
        lines,
        lang,
      });

      const url = buildWhatsAppUrl(
        restaurant,
        lines,
        orderContext,
        // La base fait autorité : le gérant règle cette langue depuis
        // ses paramètres. Le fichier de configuration sert de repli.
        (restaurant.config.staff_receipt_language as Lang | undefined) ??
          settings.staffLanguage ??
          "fr",
        order.orderNumber
      );

      // Ouverture en onglet si possible ; si le navigateur la bloque,
      // on bascule sur une navigation directe (fiable sur mobile).
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        window.location.href = url;
      }
      void markWhatsappOpened(order.orderId, order.publicToken);

      setConfirmedContext(orderContext);
      setConfirmedNumber(order.orderNumber);
      setIsCartOpen(false);
      setIsConfirmationOpen(true);

      // Le panier n'est vidé qu'après un enregistrement réussi.
      setCart({});
      setTableNumber(null);
      setServiceMode(
        settings.allowedServiceModes.length === 1
          ? settings.allowedServiceModes[0]
          : null
      );
      setCustomer(EMPTY_CUSTOMER);
      setShowErrors(false);
    } catch {
      setSubmitError(t("orderFailed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  function closeConfirmation() {
    setIsConfirmationOpen(false);
    setActiveCategoryId(restaurant.categories[0]?.id ?? "");
  }

  const t = (key: string, params?: Record<string, string | number>) =>
    translate(lang, key, params);

  /**
   * Les variables sont aussi posées sur <html> : sans cela, le fond
   * du body resterait celui du thème par défaut au-delà du
   * conteneur, ce qui laissait apparaître du crème sous une carte
   * bleue.
   */
  useEffect(() => {
    const root = document.documentElement;
    const vars = themeStyle(settings.theme);
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    return () => {
      for (const key of Object.keys(vars)) root.style.removeProperty(key);
    };
  }, [settings.theme]);

  return (
    <I18nProvider lang={lang}>
    <div
      className={`mx-auto min-h-screen max-w-lg pb-28 ${
        menuVariant === "editorial" ? "sc-template-editorial" : ""
      }`}
      dir={dirOf(lang)}
      style={
        {
          ...themeStyle(settings.theme),
          // Motif sous les cartes, jamais derrière du texte.
          backgroundImage: patternUrl(
            settings.pattern,
            getTheme(settings.theme).ink,
            0.05
          ),
        } as React.CSSProperties
      }
    >
      <RestaurantHeader
        restaurant={restaurant}
        lang={lang}
        onChangeLang={setLang}
        theme={settings.theme}
        banner={variant?.banner ?? settings.banner}
      />

      <div className="mt-6">
        <CategoryNav
          categories={restaurant.categories}
          activeId={activeCategoryId}
          onSelect={setActiveCategoryId}
          variant={menuVariant}
        />
      </div>

      <main className="px-4">
        {activeCategory && (
          <section className="mt-7">
            <h2 className="text-lg font-bold uppercase tracking-wide text-caramel-dark">
              {tName(activeCategory, lang)}
            </h2>
            {/* Filet laiton : marque la section sans aplat doré */}
            <div className="mt-1.5 h-px w-12 bg-gold" />
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
                    onAdd={() => handleAdd(item)}
                    onRemove={() => handleRemove(item)}
                    variant={menuVariant}
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
          className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-lg items-center justify-between border-t-2 border-gold bg-espresso px-6 py-4 text-crema"
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
          serviceMode={serviceMode}
          requiredFields={requiredFields}
          deliveryStatus={deliveryStatus}
          customer={customer}
          customerErrors={customerErrors}
          showErrors={showErrors}
          canSubmit={canSubmit}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onChangeQuantity={(key, delta) =>
            setCart((c) => changeLineQuantity(c, key, delta))
          }
          onSelectTable={setTableNumber}
          onSelectFulfillment={(t) => {
            setServiceMode(t);
            setShowErrors(true);
          }}
          onChangeCustomer={(patch) =>
            setCustomer((prev) => ({ ...prev, ...patch }))
          }
          onSendOrder={handleSendOrder}
          onClose={() => setIsCartOpen(false)}
        />
      )}

      {isConfirmationOpen && (
        <OrderConfirmation
          restaurant={restaurant}
          context={confirmedContext}
          orderNumber={confirmedNumber}
          onBackToMenu={closeConfirmation}
          onNewOrder={closeConfirmation}
        />
      )}
    </div>
    </I18nProvider>
  );
}
