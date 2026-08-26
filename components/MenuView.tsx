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
import { resolveActiveDeliveryStatus } from "@/lib/delivery";
import { usePublicDeliveryInfo } from "@/lib/use-public-delivery-info";
import { usePublicDeliveryFulfillments } from "@/lib/use-public-delivery-fulfillments";
import {
  usePublicSaleModes,
  canAttemptToSelectSaleMode,
} from "@/lib/use-public-sale-modes";
import {
  usePublicFieldRequirements,
  canAttemptSubmit,
} from "@/lib/use-public-field-requirements";
import {
  validateCustomerData,
  buildFieldRequirementDisplayItems,
  type FieldRequirementDisplayItem,
} from "@/lib/sale-modes-public";
import type { PublicDeliveryInfo, CustomerData } from "@/lib/sale-modes-types";
import {
  EMPTY_CUSTOMER,
  getCustomerErrors,
  formatAddress,
  genericFieldFormatError,
  type CustomerInfo,
} from "@/lib/customer";
import RestaurantHeader from "@/components/RestaurantHeader";
import CategoryNav from "@/components/CategoryNav";
import MenuItemCard from "@/components/MenuItemCard";
import CartPanel from "@/components/CartPanel";
import OptionModal from "@/components/OptionModal";
import OrderConfirmation from "@/components/OrderConfirmation";
import ProductInfoButton from "@/components/ProductInfoButton";

import { I18nProvider } from "@/lib/i18n-context";
import { getTheme, themeStyle } from "@/lib/themes";
import { patternUrl } from "@/lib/pattern";
import {
  createOrder,
  markWhatsappOpened,
  OrderNoteTooLongError,
} from "@/lib/services/orders";
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
import { tName, tCategoryDescription } from "@/lib/menu-i18n";
import Ltr from "@/components/Bidi";

/** Seul établissement où les variantes d'URL sont acceptées. */
const DEMO_SLUG = "le-sirocco";

/**
 * LOT 2B.4a.2 — erreurs de format par clé CustomerInfo, dérivées des
 * exigences génériques dynamiques (`displayItems`, construites par
 * buildFieldRequirementDisplayItems() à partir de
 * usePublicFieldRequirements()) -- remplace l'ancien calcul figé sur
 * un (keyof CustomerInfo)[] issu de settings.requiredCustomerFields
 * (legacy, restaurants-config.ts), désormais abandonné par le
 * formulaire actif.
 *
 * Règles appliquées PAR TYPE D'EXIGENCE du champ générique -- jamais
 * par mode de vente ni par établissement, aucune branche spécifique :
 *   - "required" : erreur de format toujours vérifiée (vide inclus,
 *     comme le faisait déjà getCustomerErrors() pour un champ requis) ;
 *   - "optional" : erreur de format vérifiée UNIQUEMENT si une valeur
 *     a été saisie -- jamais d'erreur sur un champ optionnel resté
 *     vide ;
 *   - "one_of"   : erreur de format vérifiée si la valeur est saisie
 *     (garde-fou : une saisie invalide reste signalée même si un
 *     autre champ du groupe suffirait déjà), OU si vide ET qu'AUCUN
 *     champ du même groupe n'est rempli (le groupe entier est alors
 *     non satisfait). Un "one_of" isolé sans groupe résolu (donnée
 *     backend incohérente, oneOfGroup null malgré requirement
 *     "one_of" -- ne devrait jamais se produire avec le catalogue
 *     actuel) est traité prudemment comme "optional", jamais
 *     bloquant.
 *
 * "delivery_address" (backend) n'est JAMAIS traité ici : ses 3
 * sous-champs UI (street/postalCode/city) restent validés séparément
 * par getCustomerErrors() (inchangée), cas spécial documenté dans
 * lib/sale-modes-types.ts -- voir addressFieldsToCheck, plus bas dans
 * ce composant. Un champ générique inconnu (ni un champ mappé, ni
 * "delivery_address") est également ignoré ici : sa présence reste de
 * toute façon validée génériquement par validateCustomerData()
 * (lib/sale-modes-public.ts), jamais par cette fonction de format.
 */
export function fieldRequirementFormatErrors(
  displayItems: FieldRequirementDisplayItem[],
  customer: CustomerInfo
): Partial<Record<keyof CustomerInfo, string>> {
  const errors: Partial<Record<keyof CustomerInfo, string>> = {};

  const infoKey = (field: string): keyof CustomerInfo | null => {
    switch (field) {
      case "customer_name":
        return "name";
      case "phone":
        return "phone";
      case "email":
        return "email";
      default:
        return null;
    }
  };
  const rawValue = (field: string): string => {
    const key = infoKey(field);
    return key ? customer[key] : "";
  };

  for (const item of displayItems) {
    if (item.kind === "field") {
      const field = item.requirement.field;
      const key = infoKey(field);
      if (!key) continue; // delivery_address ou champ inconnu : hors périmètre
      const value = rawValue(field);
      const shouldCheck =
        item.requirement.requirement === "required" || value.trim() !== "";
      if (shouldCheck) {
        const err = genericFieldFormatError(field, value);
        if (err) errors[key] = err;
      }
    } else {
      const groupSatisfied = item.fields.some((f) => rawValue(f.field).trim() !== "");
      for (const member of item.fields) {
        const key = infoKey(member.field);
        if (!key) continue;
        const value = rawValue(member.field);
        if (value.trim() !== "" || !groupSatisfied) {
          const err = genericFieldFormatError(member.field, value);
          if (err) errors[key] = err;
        }
      }
    }
  }

  return errors;
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

  /**
   * LOT 2B.3 — NEW PUBLIC DELIVERY RESOLVER ACTIVE IN RUNTIME.
   * Chargement de PublicDeliveryInfo via un hook dédié (voir
   * lib/use-public-delivery-info.ts pour l'état loading/loaded/error
   * complet et la justification de sécurité).
   */
  /**
   * LOT 2B.3 — NEW PUBLIC DELIVERY RESOLVER ACTIVE IN RUNTIME.
   * Chargement de PublicDeliveryInfo via un hook dédié (voir
   * lib/use-public-delivery-info.ts pour l'état loading/loaded/error
   * complet et la justification de sécurité).
   *
   * Corrige L2B3-01 (contre-audit Work) : les 4 états sont désormais
   * explicitement distingués ici, un par un, jamais confondus sous un
   * simple `data: null`. "loading" et "error" restent traités de
   * façon IDENTIQUE en aval (null -- aucune éligibilité présentée,
   * aucun repli legacy) puisque c'est le comportement sûr requis pour
   * les deux, mais chacun reste un cas NOMMÉ et observable dans le
   * code, jamais une valeur anonyme confondue avec "loaded with
   * null". Aucun nouveau comportement utilisateur inventé : cette
   * distinction sert la clarté et la testabilité du code, pas un
   * nouveau rendu visuel par état (hors périmètre de ce lot).
   */
  const { state: deliveryInfoState } = usePublicDeliveryInfo(restaurant.id);
  const publicDeliveryInfo: PublicDeliveryInfo | null = (() => {
    if (deliveryInfoState.status === "loading") {
      // Comportement sûr : jamais d'éligibilité positive, jamais de
      // zone (legacy ou publique) affichée comme si elle était déjà
      // chargée.
      return null;
    }
    if (deliveryInfoState.status === "error") {
      // Comportement sûr : aucun repli legacy, aucun détail
      // technique de l'erreur exposé, jamais d'éligibilité positive
      // -- traité comme "aucune information disponible".
      return null;
    }
    // deliveryInfoState.status === "loaded" à partir d'ici.
    if (deliveryInfoState.data === null) {
      // "loaded with null" : distinct de "loading"/"error" dans le
      // code (la récupération a bien réussi, mais aucun mode
      // delivery n'est configuré/activé pour cet établissement) --
      // même traitement sûr en aval (aucune éligibilité), jamais un
      // repli legacy, mais un cas explicitement nommé, jamais
      // confondu avec les deux précédents.
      return null;
    }
    // "loaded with data" : donnée publique réelle.
    return deliveryInfoState.data;
  })();

  /**
   * FULFILLMENT ROUTING LOT C — ACTIVE FRONTEND RUNTIME ROUTING.
   *
   * Règles publiques de fulfillment (get_restaurant_public_delivery_fulfillments,
   * LOT B/2B.1, jusqu'ici jamais consommées par aucun hook -- voir
   * tests/v96-fulfillment-routing-lot-b.test.ts, mis à jour par ce lot
   * pour documenter cette activation). Appelée SANS CONDITION (règle
   * des hooks React), comme usePublicDeliveryInfo/usePublicSaleModes
   * ci-dessus -- son résultat n'est consulté que par
   * resolveActiveDeliveryStatus ci-dessous, jamais par le mode
   * "pickup"/"table" (voir orderContext plus bas : ces deux modes ne
   * lisent jamais `deliveryStatus`).
   */
  const { state: fulfillmentRulesState } = usePublicDeliveryFulfillments(restaurant.id);


  // Corrige L1A-02 (contre-audit Work, tour 1A.1) : la langue
  // publique initiale suit désormais RÉELLEMENT la configuration de
  // CET établissement -- plus jamais un "fr" figé indépendamment de
  // source_language/langues actives. Priorité : (1) source_language,
  // si elle appartient bien aux langues actives ; (2) sinon la
  // première langue active selon display_order (déjà l'ordre de
  // restaurant.activeLanguages, voir lib/services/restaurant.ts).
  // Aucun repli global "fr" tant qu'une configuration établissement
  // valide existe -- le "fr" ci-dessous n'est qu'un filet de sécurité
  // TypeScript, jamais atteint en pratique (activeLanguages contient
  // toujours au moins une langue, voir getRestaurantBySlug). Un
  // établissement V79 migré (source_language='fr' par défaut) garde
  // donc exactement son comportement historique.
  const [lang, setLang] = useState<Lang>(() => {
    const activeLanguages = restaurant.activeLanguages;
    const source = restaurant.config.source_language;
    if (source && activeLanguages.some((l) => l.code === source)) {
      return source;
    }
    return activeLanguages[0]?.code ?? "fr";
  });
  const [cart, setCart] = useState<Cart>({});
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState<string>(
    restaurant.categories[0]?.id ?? ""
  );

  // Récupération de la commande
  const [tableNumber, setTableNumber] = useState<number | null>(null);

  /**
   * AU LAIT CRU — SALE MODES / FULFILLMENT PREPARATION — BASCULE
   * RUNTIME RÉELLE : les modes de vente PROPOSÉS AU CLIENT sont
   * désormais chargés via usePublicSaleModes (get_restaurant_public_sale_modes,
   * LOT 2B.1), plus jamais lus depuis settings.allowedServiceModes
   * (legacy, restaurants-config.ts) -- cause racine identifiée du
   * problème Au Lait Cru (voir RAPPORT.md, audit point 5) : cet
   * établissement n'a aucune entrée dans la table statique legacy,
   * retombait donc systématiquement sur DEFAULT_SETTINGS
   * (mode "table" uniquement), quelle que soit la configuration réelle
   * en base -- exactement la même situation que
   * usePublicFieldRequirements avant sa propre activation (LOT 2B.4a.2).
   *
   * `availableServiceModes` ne retient QUE les codes que le frontend
   * sait structurellement rendre aujourd'hui ("table"/"pickup"/
   * "delivery" -- le seul domaine que ServiceMode/OrderContext
   * connaissent, lib/whatsapp.ts/lib/services/order-payload.ts inclus).
   * Un code retourné par le catalogue mais non encore supporté
   * frontend (ex. "click_collect", "room_service" -- catalogue déjà
   * plus large que ce que l'UI sait afficher, voir RAPPORT.md audit
   * point 1) est silencieusement IGNORÉ ici, jamais un crash ni un
   * mode mal rendu -- comportement fail-closed délibéré, cohérent
   * avec le reste de ce lot (un mode non reconnu ne peut simplement
   * jamais être choisi).
   */
  const { state: saleModesState, data: saleModesData } = usePublicSaleModes(restaurant.id);
  const saleModesReady = canAttemptToSelectSaleMode(saleModesState);
  const FRONTEND_SUPPORTED_MODES: ServiceMode[] = ["table", "pickup", "delivery"];
  const availableServiceModes: ServiceMode[] = useMemo(
    () =>
      (saleModesData ?? [])
        .map((m) => m.code)
        .filter((code): code is ServiceMode =>
          (FRONTEND_SUPPORTED_MODES as string[]).includes(code)
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saleModesData]
  );

  // Mode retenu par le client ; pré-sélectionné si l'établissement
  // n'en propose qu'un seul. `availableServiceModes` n'est connu
  // qu'après résolution asynchrone (saleModesReady) -- ne peut donc
  // plus être décidé à l'initialisation synchrone de l'état comme
  // avant ce lot (settings.allowedServiceModes était statique,
  // disponible immédiatement) : la présélection a lieu dans l'effet
  // ci-dessous, une fois la liste réelle connue.
  const [serviceMode, setServiceMode] = useState<ServiceMode | null>(null);

  useEffect(() => {
    if (!saleModesReady) return;

    // Corrige ALC-SM-01 (audit Work, HIGH, CASE 1) -- volet MenuView :
    // si le mode actuellement sélectionné n'existe plus dans la liste
    // RÉELLEMENT résolue (ex. réponse RPC désormais différente pour la
    // même clé restaurant -- reconfiguration serveur --, ou, en amont,
    // le hook usePublicSaleModes lui-même vient de basculer vers un
    // nouveau restaurantId -- voir lib/use-public-sale-modes.ts),
    // réinitialise TOUT le parcours dépendant de ce mode plutôt que de
    // laisser un `serviceMode` fantôme piloter encore l'UI (numéro de
    // table d'un autre parcours, coordonnées déjà saisies pour un mode
    // qui n'a plus cours, erreurs de validation obsolètes). Générique
    // -- aucune branche `if restaurant === "au-lait-cru"` : ce garde-fou
    // s'applique à TOUT établissement, pour toute cause de changement
    // de la liste résolue.
    //
    // Si un seul mode subsiste, il est immédiatement re-sélectionné
    // dans le MÊME passage d'effet (pas d'attente d'un second cycle) --
    // sans quoi le client verrait transitoirement "aucun mode
    // sélectionné" alors qu'un seul choix existe déjà, sans raison de
    // le lui faire re-choisir.
    if (serviceMode !== null && !availableServiceModes.includes(serviceMode)) {
      setServiceMode(availableServiceModes.length === 1 ? availableServiceModes[0] : null);
      setTableNumber(null);
      setCustomer(EMPTY_CUSTOMER);
      setShowErrors(false);
      // La note générale n'est pas structurellement "dépendante du
      // mode", mais reste rattachée à CETTE tentative de commande --
      // la conserver à travers une invalidation de mode (ex. bascule
      // de tenant) risquerait de rattacher par erreur un texte saisi
      // pour un établissement/parcours à la commande d'un autre.
      setNote("");
      return;
    }

    // Ne présélectionne QUE si aucun choix n'a encore été fait (ni par
    // ce même effet lors d'un rendu précédent, ni par le client) --
    // ce garde-fou (jamais un simple appel inconditionnel) empêche
    // d'écraser une sélection déjà faite par le client si cet effet
    // devait se redéclencher (ex. re-rendu avec une nouvelle référence
    // de tableau memoized, même contenu).
    if (serviceMode === null && availableServiceModes.length === 1) {
      setServiceMode(availableServiceModes[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleModesReady, availableServiceModes]);

  const [customer, setCustomer] = useState<CustomerInfo>(EMPTY_CUSTOMER);

  /**
   * LOT 2B.4a.2 — BASCULE RUNTIME RÉELLE : les exigences client sont
   * désormais chargées via usePublicFieldRequirements (LOT 2B.4a.1),
   * plus jamais lues depuis settings.requiredCustomerFields (legacy,
   * restaurants-config.ts) -- ce chemin legacy n'est plus consulté du
   * tout par le formulaire actif à partir de ce lot.
   *
   * Appelé SANS CONDITION (règle des hooks React), comme
   * usePublicDeliveryInfo ci-dessus : quand serviceMode vaut "table"
   * (ou est encore null, avant tout choix), le modeCode transmis vaut
   * "table" par convention -- sans conséquence, puisque
   * CartPanel/FulfillmentSelector ne rendent JAMAIS le formulaire
   * client pour le mode "table" (aucun consommateur de `displayItems`
   * dans ce cas, voir plus bas). "table" est un code de mode réel du
   * catalogue backend (sale_mode_catalog), jamais une valeur inventée.
   */
  const { state: fieldRequirementsState, data: fieldRequirementsData } =
    usePublicFieldRequirements(restaurant.id, serviceMode ?? "table");
  /** Fail-closed (section 11, LOT 2B.4a.1) : jamais de soumission
   *  tentée tant que les exigences ne sont pas RÉELLEMENT résolues. */
  const fieldRequirementsReady = canAttemptSubmit(fieldRequirementsState);
  const fieldRequirements = fieldRequirementsData ?? [];

  const [showErrors, setShowErrors] = useState(false);
  // Note générale de commande (V65) : une seule note, aucune par ligne.
  const [note, setNote] = useState("");

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

  /**
   * Éligibilité à la livraison : code postal saisi + montant du
   * panier (totalCount -- QUANTITÉ TOTALE d'articles, somme des
   * quantités de chaque ligne de panier, voir la définition de
   * `totalCount` ci-dessus ; PAS le nombre de lignes/produits
   * distincts -- même grandeur déjà transmise à getDeliveryStatus/
   * getDeliveryStatusFromPublicInfo avant ce lot, donc déjà le bon
   * contrat pour le résolveur fulfillment interne/resolveActiveDeliveryStatus,
   * aucune redéfinition nécessaire ici, mission §11).
   *
   * FULFILLMENT ROUTING LOT C — ACTIVE FRONTEND RUNTIME ROUTING :
   * resolveActiveDeliveryStatus (lib/delivery.ts) est le PONT DE
   * MIGRATION unique (mission §3/§10) -- selon l'état RÉEL des règles
   * publiques de fulfillment (fulfillmentRulesState ci-dessus) :
   *   - règles positivement vides -> chemin legacy
   *     (getDeliveryStatusFromPublicInfo), comportement IDENTIQUE à
   *     celui déjà en production avant ce lot (Sanaa non-régression,
   *     mission §2/§18/§29) ;
   *   - règles positivement non vides -> nouveau moteur
   *     (le résolveur fulfillment interne, lib/delivery.ts), EXCLUSIVEMENT ;
   *   - loading/error -> état sûr non éligible, jamais confondu avec
   *     l'un ou l'autre cas ci-dessus (mission §7/§28).
   * `deliveryStatus` reste du type DeliveryStatus (INCHANGÉ) : ni
   * FulfillmentSelector.tsx ni CartPanel.tsx n'ont besoin d'être
   * modifiés par ce lot (mission §32), les deux moteurs produisent la
   * MÊME forme de résultat via deliveryStatusFromFulfillmentResult
   * (lib/delivery.ts). */
  const deliveryStatus = useMemo(
    () =>
      resolveActiveDeliveryStatus(
        fulfillmentRulesState,
        publicDeliveryInfo,
        customer.postalCode,
        totalCount,
        totalPrice
      ).status,
    [fulfillmentRulesState, publicDeliveryInfo, customer.postalCode, totalCount, totalPrice]
  );

  /*
   * Le mode livraison reste sélectionné pendant la saisie, même si
   * l'adresse est encore incomplète, hors zone ou sous le minimum.
   * `orderContext` bloque déjà l'envoi tant que `deliveryStatus`
   * n'est pas éligible. Revenir automatiquement au retrait ferait
   * disparaître les champs nécessaires pour corriger la situation.
   */

  /**
   * LOT 2B.4a.2 — rendu dynamique : liste ordonnée d'éléments
   * d'affichage (champs isolés + groupes one_of fusionnés), dérivée
   * des exigences génériques réellement résolues pour ce
   * restaurant/mode -- transmise telle quelle à FulfillmentSelector
   * (via CartPanel), qui ne connaît plus aucun nom de champ codé en
   * dur par mode de vente.
   */
  const displayItems = useMemo(
    () => buildFieldRequirementDisplayItems(fieldRequirements),
    [fieldRequirements]
  );

  /**
   * Données client au format générique (CustomerData, LOT 2B.1),
   * dérivées de l'état CustomerInfo existant -- traduction locale à
   * ce composant, jamais un second état parallèle. "delivery_address"
   * (contrat documenté dans lib/sale-modes-types.ts) n'est composé
   * que si les 3 sous-champs UI sont TOUS non vides : une adresse
   * partiellement saisie doit rester "manquante" pour
   * validateCustomerData() ci-dessous, jamais considérée comme
   * présente sur la seule foi d'un fragment (ex. la rue seule) --
   * formatAddress() seule ne garantirait pas cette garantie (elle
   * produirait ", " même à vide, une chaîne non vide après trim).
   */
  const customerData: CustomerData = useMemo(
    () => ({
      customer_name: customer.name,
      phone: customer.phone,
      email: customer.email,
      delivery_address:
        customer.street.trim() !== "" &&
        customer.postalCode.trim() !== "" &&
        customer.city.trim() !== ""
          ? formatAddress(customer)
          : "",
    }),
    [customer]
  );

  /** Validation générique de présence (required/one_of), LOT 2B.1 --
   *  jamais de logique de validation dupliquée ici. */
  const { missingRequired, unsatisfiedGroups } = useMemo(
    () => validateCustomerData(fieldRequirements, customerData),
    [fieldRequirements, customerData]
  );

  /** Cas spécial "delivery_address" (voir commentaire dédié dans
   *  lib/sale-modes-types.ts) : ses 3 sous-champs UI restent validés
   *  par getCustomerErrors() (inchangée) -- jamais par
   *  fieldRequirementFormatErrors() (qui l'ignore explicitement).
   *  Vérifiés uniquement si "delivery_address" apparaît réellement
   *  dans les exigences résolues pour ce mode, et seulement si requis
   *  (ou si un sous-champ a déjà été saisi pour un champ optionnel --
   *  jamais d'erreur sur une adresse optionnelle restée entièrement
   *  vide, même règle que pour tout autre champ optionnel). */
  const addressRequirement = fieldRequirements.find(
    (r) => r.field === "delivery_address"
  );
  const addressAnySubfieldFilled =
    customer.street.trim() !== "" ||
    customer.postalCode.trim() !== "" ||
    customer.city.trim() !== "";
  const addressFieldsToCheck: (keyof CustomerInfo)[] =
    !addressRequirement ||
    (addressRequirement.requirement === "optional" && !addressAnySubfieldFilled)
      ? []
      : ["street", "postalCode", "city"];

  const customerErrors = useMemo(
    () => ({
      ...fieldRequirementFormatErrors(displayItems, customer),
      ...getCustomerErrors(customer, addressFieldsToCheck),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayItems, customer, addressRequirement, addressAnySubfieldFilled]
  );
  const customerFormatValid = Object.keys(customerErrors).length === 0;

  /** Contrat fail-closed (section 11, LOT 2B.4a.1) appliqué ICI pour
   *  la première fois par un formulaire actif : tant que
   *  fieldRequirementsReady est false (loading/error), customerValid
   *  reste false, quel que soit l'état de saisie -- jamais de
   *  soumission tentée sur des exigences non résolues. Le mode
   *  "table" n'est jamais concerné par ce booléen (voir orderContext
   *  ci-dessous, chemin "table" totalement indépendant). */
  const customerValid =
    fieldRequirementsReady &&
    missingRequired.length === 0 &&
    unsatisfiedGroups.length === 0 &&
    customerFormatValid;

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
        // Ajustement type-safe (LOT 2B.2 -- L2B2-01, mis à jour LOT
        // 2B.3) : DeliveryZone.label est string | null. Depuis la
        // bascule runtime LOT 2B.3, ce chemin est désormais alimenté
        // par le NOUVEAU résolveur public (getDeliveryStatusFromPublicInfo),
        // où label PEUT réellement être null (delivery_area_label de
        // la RPC) -- ce repli n'est donc plus seulement défensif,
        // il couvre un cas réel. Le WhatsApp reçoit alors une zone
        // vide plutôt que "null" littéral, jamais un texte inventé.
        zoneLabel: deliveryStatus.zone!.label ?? "",
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
        note,
      });

      const url = buildWhatsAppUrl(
        restaurant,
        lines,
        orderContext,
        // SADFP-V2-01 : résumé monétaire AUTORITATIF -- ces 3 champs
        // proviennent de la réponse serveur de create_order (jamais
        // recalculés depuis `lines`, jamais une estimation client).
        {
          subtotal: order.subtotal,
          deliveryFee: order.deliveryFee,
          total: order.total,
        },
        // La base fait autorité : le gérant règle cette langue depuis
        // ses paramètres. Le fichier de configuration sert de repli.
        (restaurant.config.staff_receipt_language as Lang | undefined) ??
          settings.staffLanguage ??
          "fr",
        order.orderNumber,
        note
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
      // Même règle qu'à l'initialisation (voir l'effet de
      // présélection ci-dessus) : `availableServiceModes` est déjà
      // connu de façon synchrone ici (résolu depuis longtemps à ce
      // stade du cycle de vie), donc appliqué directement -- pas
      // besoin de repasser par l'effet pour ce cas.
      setServiceMode(
        availableServiceModes.length === 1 ? availableServiceModes[0] : null
      );
      setCustomer(EMPTY_CUSTOMER);
      setShowErrors(false);
      setNote("");
    } catch (err) {
      // Le rejet serveur de note trop longue (V65) a un message dédié ;
      // toute autre erreur (réseau, règle métier, etc.) reste générique.
      // Le message Postgres brut n'est jamais affiché tel quel.
      setSubmitError(
        err instanceof OrderNoteTooLongError ? t("noteTooLong") : t("orderFailed")
      );
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

  // Surcharges de couleur établissement (V69) — voir
  // restaurant_configs.primary_color/secondary_color/accent_color et
  // lib/themes.ts (ThemeColorOverrides). Absentes/null pour tout
  // établissement n'ayant jamais renseigné de couleur : themeStyle()
  // retombe alors intégralement sur le thème statique existant, rendu
  // strictement inchangé.
  const colorOverrides = {
    primary: restaurant.config.primary_color ?? null,
    secondary: restaurant.config.secondary_color ?? null,
    accent: restaurant.config.accent_color ?? null,
    // LOT 1A — couleur de fond personnalisable, réutilise
    // intégralement le mécanisme de contraste existant (aucune
    // nouvelle logique). NULL = fond du thème par défaut, rendu V79
    // strictement inchangé.
    bg: restaurant.config.bg_color ?? null,
  };

  /**
   * Les variables sont aussi posées sur <html> : sans cela, le fond
   * du body resterait celui du thème par défaut au-delà du
   * conteneur, ce qui laissait apparaître du crème sous une carte
   * bleue.
   */
  useEffect(() => {
    const root = document.documentElement;
    const vars = themeStyle(settings.theme, colorOverrides);
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    return () => {
      for (const key of Object.keys(vars)) root.style.removeProperty(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.theme, colorOverrides.primary, colorOverrides.secondary, colorOverrides.accent, colorOverrides.bg]);

  return (
    <I18nProvider lang={lang} sourceLanguage={restaurant.config.source_language ?? "fr"} activeLanguages={restaurant.activeLanguages}>
    <div
      className={`mx-auto min-h-screen max-w-lg pb-28 ${
        menuVariant === "editorial" ? "sc-template-editorial" : ""
      }`}
      dir={dirOf(lang, restaurant.activeLanguages)}
      style={
        {
          ...themeStyle(settings.theme, colorOverrides),
          // Motif sous les cartes, jamais derrière du texte.
          backgroundImage: patternUrl(
            settings.pattern,
            colorOverrides.secondary ?? getTheme(settings.theme).ink,
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
            <div className="flex items-start gap-1.5">
              <h2 className="min-w-0 text-lg font-bold uppercase tracking-wide leading-snug text-accent-dark-on-bg">
                {tName(activeCategory, lang, restaurant.config.source_language ?? "fr")}
              </h2>
              {tCategoryDescription(activeCategory, lang, restaurant.config.source_language ?? "fr") && (
                <ProductInfoButton
                  description={tCategoryDescription(activeCategory, lang, restaurant.config.source_language ?? "fr")!}
                  triggerLabel={t("moreInfoAbout", { name: tName(activeCategory, lang, restaurant.config.source_language ?? "fr") })}
                  closeLabel={t("close")}
                />
              )}
            </div>
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
          className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-lg items-center justify-between border-t-2 border-gold bg-espresso px-6 py-4 text-ink-text"
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
          lines={lines}
          totalCount={totalCount}
          totalPrice={totalPrice}
          tableNumber={tableNumber}
          serviceMode={serviceMode}
          availableServiceModes={availableServiceModes}
          saleModesState={saleModesState}
          displayItems={displayItems}
          fieldRequirementsReady={fieldRequirementsReady}
          deliveryStatus={deliveryStatus}
          customer={customer}
          customerErrors={customerErrors}
          showErrors={showErrors}
          note={note}
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
          onChangeNote={setNote}
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
