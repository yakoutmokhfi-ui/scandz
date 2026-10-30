"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RestaurantFull } from "@/lib/types";
import { formatPrice, type CartLine } from "@/lib/whatsapp";
import type { DeliveryStatus } from "@/lib/delivery";
import type { CustomerInfo } from "@/lib/customer";
import type { InvoiceRequestInfo, InvoiceRequestErrors } from "@/lib/invoice-request";
import InvoiceRequestFields from "@/components/InvoiceRequestFields";
import type { FieldRequirementDisplayItem } from "@/lib/sale-modes-public";
import type { PublicSaleModesState } from "@/lib/use-public-sale-modes";
import QuantityControl from "@/components/QuantityControl";
import TableSelector from "@/components/TableSelector";
import { useI18n } from "@/lib/i18n-context";
import { isWhatsappEnabled } from "@/lib/customer-contact";
import Ltr from "@/components/Bidi";
import { tName } from "@/lib/menu-i18n";
import FulfillmentSelector from "@/components/FulfillmentSelector";
import type { DeliveryCountryOption } from "@/lib/delivery-country";
import FulfillmentChoiceModal from "@/components/FulfillmentChoiceModal";
import type { CommunicationTextOverrides } from "@/lib/communications/text-keys";
import { DeliveryPostcodeResult } from "@/components/DeliveryConditions";
import { focusFirstInvalidField } from "@/lib/focus-first-invalid";
import { isValidPostalCodeFor } from "@/lib/delivery-country";
import type { ServiceMode } from "@/lib/restaurants-config";
import type { DeliveryCustomerNotice } from "@/lib/delivery-customer-notice";
import { normalizeOrderNote, ORDER_NOTE_MAX_LENGTH } from "@/lib/order-note";
import { blockingItemsByMode, serviceModeNameKey } from "@/lib/service-mode-restrictions";

interface CartEntry extends CartLine {
  key: string;
}

function formatCheckoutReviewDate(value: string, lang: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  const locale = lang === "en" ? "en-GB" : lang === "ar" ? "ar" : lang === "nl" ? "nl-NL" : "fr-FR";
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(date);
}

export default function CartPanel({
  restaurant,
  lines,
  totalCount,
  totalPrice,
  tableNumber,
  serviceMode,
  fulfillmentSelectionSeq,
  deliveryStatus,
  deliveryPricingReady = true,
  displayItems,
  fieldRequirementsReady,
  availableServiceModes,
  saleModesState,
  customer,
  customerErrors,
  showErrors,
  invoiceRequest,
  invoiceRequestErrors,
  onChangeInvoiceRequest,
  note,
  canSubmit,
  scheduleHint,
  scheduleSection,
  scheduleSummary = null,
  isSubmitting,
  submitError,
  invoiceRequestError,
  isRetryingInvoice,
  onRetryInvoiceRequest,
  paymentError = null,
  isRetryingPayment = false,
  onRetryPayment,
  onChangeQuantity,
  onSelectTable,
  onSelectFulfillment,
  onChangeCustomer,
  deliveryCountry = null,
  deliveryCountryOptions = [],
  deliveryCountryScope = [],
  cityOptions = null,
  onSelectDeliveryCountry,
  communicationTexts = null,
  onChangeNote,
  cgvEnforced,
  cgvAccepted,
  onChangeCgvAccepted,
  cgvLegalHref,
  onSendOrder,
  onRevealErrors,
  onClose,
}: {
  restaurant: RestaurantFull;
  lines: CartEntry[];
  totalCount: number;
  totalPrice: number;
  tableNumber: number | null;
  serviceMode: ServiceMode | null;
  /** FULFILLMENT CHOICE v1.1 : compteur incrémenté UNIQUEMENT par une
   *  sélection explicite du client (voir MenuView.tsx) -- signal
   *  d'événement, jamais un second état de navigation ; déclenche le
   *  défilement/focus post-sélection ci-dessous, jamais un rendu
   *  générique. */
  fulfillmentSelectionSeq: number;
  deliveryStatus: DeliveryStatus;
  deliveryPricingReady?: boolean;
  /** Message public du mode/routage sélectionné, déjà limité au tenant
   * courant par les RPC publiques. null conserve le parcours historique. */
  deliveryCustomerNotice: DeliveryCustomerNotice | null;
  /** LOT 2B.4a.2 : exigences génériques dynamiques (plus un
   *  (keyof CustomerInfo)[] figé lu depuis settings.requiredCustomerFields). */
  displayItems: FieldRequirementDisplayItem[];
  /** AU LAIT CRU (sale modes) : liste RÉELLE des modes de vente
   *  activés pour cet établissement (get_restaurant_public_sale_modes,
   *  via usePublicSaleModes) -- remplace settings.allowedServiceModes
   *  (legacy, statique) comme source de vérité pour le sélecteur de
   *  mode et son message d'absence. */
  availableServiceModes: ServiceMode[];
  /**
   * Corrige ALC-SM-02 (audit Work, MEDIUM, CASE 1) : l'état ASYNC
   * COMPLET (pas seulement un booléen "prêt") est désormais transmis,
   * pour pouvoir distinguer explicitement trois situations dans le
   * message affiché ci-dessous -- "loading" (chargement en cours),
   * "error" (échec de chargement, jamais un chargement infini), et
   * "loaded" avec `availableServiceModes` vide (réponse métier valide
   * -- aucun mode configuré pour cet établissement -- distincte d'une
   * erreur). Un simple booléen `saleModesReady` ne permettait pas de
   * distinguer "error" de "loading" (les deux affichaient à tort le
   * même message de chargement), ni de proposer un message dédié au
   * cas "loaded([])" (qui affichait à tort "Choisissez le retrait ou
   * la livraison" alors qu'aucun choix n'existe réellement).
   */
  saleModesState: PublicSaleModesState;
  /** Fail-closed (section 11) : false tant que les exigences ne sont
   *  pas réellement résolues (loading/error) -- transmis tel quel à
   *  FulfillmentSelector, jamais réinterprété ici. */
  fieldRequirementsReady: boolean;
  customer: CustomerInfo;
  customerErrors: Partial<Record<keyof CustomerInfo, string>>;
  showErrors: boolean;
  /** CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1. */
  invoiceRequest: InvoiceRequestInfo;
  invoiceRequestErrors: InvoiceRequestErrors;
  onChangeInvoiceRequest: (next: InvoiceRequestInfo) => void;
  /** Note générale de commande (V65), unique, facultative — pas de note par ligne. */
  note: string;
  canSubmit: boolean;
  /** CSDJ-2 / #158 -- non nul quand SEUL le calendrier empêche l'envoi. */
  scheduleHint?: string | null;
  /** CSDJ-2 / #158 -- sélecteur de date/créneau (rendu par MenuView). */
  scheduleSection?: React.ReactNode;
  /** Server-authoritative date/slot selected for this checkout. */
  scheduleSummary?: { date: string; slot_key: string | null; starts_at: string | null; ends_at: string | null } | null;
  isSubmitting: boolean;
  submitError: string | null;
  /** CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.2
   *  (FERME "SILENT INVOICE LOSS"). Non-null UNIQUEMENT lorsqu'une
   *  commande a été créée avec succès mais que la demande de facture
   *  a échoué -- remplace le bouton d'envoi normal par une reprise
   *  CIBLÉE, jamais une nouvelle soumission complète du panier. */
  invoiceRequestError: string | null;
  isRetryingInvoice: boolean;
  onRetryInvoiceRequest: () => void;
  /** PAYMENT P4-A -- non nul UNIQUEMENT quand la commande a été créée
   *  mais que le paiement en ligne n'a pas pu démarrer : le bouton
   *  d'envoi normal est remplacé par une reprise CIBLÉE du paiement
   *  (même commande, jamais une nouvelle soumission du panier). */
  paymentError?: string | null;
  isRetryingPayment?: boolean;
  onRetryPayment?: () => void;
  onChangeQuantity: (key: string, delta: number) => void;
  onSelectTable: (table: number) => void;
  onSelectFulfillment: (t: ServiceMode) => void;
  onChangeCustomer: (patch: Partial<CustomerInfo>) => void;
  /** DELIVERY COUNTRY SCOPE v1 -- passe-plat vers FulfillmentSelector.
   *  AUCUNE décision n'est prise ici : ce composant ne connaît ni pays
   *  ni établissement. */
  deliveryCountry?: DeliveryCountryOption | null;
  deliveryCountryOptions?: DeliveryCountryOption[];
  /** ADDRESS UX v1 -- CIO ADDENDUM : liste COMPLETE (non filtrée par
   *  cardinalité) des pays de livraison configurés, passe-plat vers
   *  FulfillmentSelector pour le message proéminent de périmètre pays
   *  -- jamais utilisée pour le sélecteur (deliveryCountryOptions
   *  reste la seule source pour ça). */
  deliveryCountryScope?: DeliveryCountryOption[];
  /** ADDRESS UX v1 -- communes valides pour le code postal courant,
   *  UNIQUEMENT quand il y en a PLUSIEURS (choix restreint) -- `null`
   *  sinon (aucune résolution, une seule ville -- auto-remplie -- ou
   *  zéro ville connue). Passe-plat, aucune décision prise ici. */
  cityOptions?: { code: string; name: string }[] | null;
  onSelectDeliveryCountry?: (countryCode: string) => void;
  /** MERCHANT CUSTOMER COMMUNICATIONS v1 -- passe-plat vers
   *  FulfillmentSelector (la fenêtre de délai n'est plus ouverte depuis #183), jamais
   *  réinterprété ici (même discipline que `deliveryCountry`).
   *  `null`/absent : toutes les formulations restent celles d'avant. */
  communicationTexts?: CommunicationTextOverrides | null;
  onChangeNote: (value: string) => void;
  /**
   * SELLER LEGAL PROFILE + CGV ENGINE v1 -- Phase 1 (referme le
   * "FUTURE LEGAL TODO" laissé par SADFP-02 CORRECTION v2 ci-dessous,
   * maintenant qu'une page légale réelle existe -- app/legal/[slug]).
   * `cgvEnforced` reflète EXACTEMENT le statut serveur du marchand
   * (CGV_ACTIVE, via get_restaurant_public_cgv().enforced) -- jamais
   * une supposition côté client. Quand false (marchand non configuré
   * ou pas encore activé), aucune case n'est affichée : comportement
   * strictement identique à avant ce lot pour tout marchand existant.
   */
  cgvEnforced: boolean;
  cgvAccepted: boolean;
  onChangeCgvAccepted: (accepted: boolean) => void;
  /** Lien vers la page légale publique du marchand (app/legal/[slug]),
   *  non-null uniquement quand `cgvEnforced` l'est aussi. */
  cgvLegalHref: string | null;
  onSendOrder: () => Promise<void>;
  /** Issue #191 : demande au parent d'afficher les erreurs de champ. */
  onRevealErrors?: () => void;
  onClose: () => void;
}) {
  const { t, lang, sourceLanguage } = useI18n();
  // CUSTOMER CONTACT + LIVE TRACKING v1 -- même autorité que MenuView.
  const whatsappEnabled = isWhatsappEnabled(restaurant.config);
  const { currency, max_tables } = restaurant.config;
  // UX LOT 2026-10 -- champ « Note pour le restaurant » désactivable
  // PAR ÉTABLISSEMENT (restaurant_configs.order_note_enabled = false).
  // Absent/NULL/true : rendu historique inchangé.
  const orderNoteEnabled = restaurant.config.order_note_enabled !== false;
  const [reviewingOrder, setReviewingOrder] = useState(false);
  // ISSUE #183 -- la fenêtre du code postal est-elle ouverte ? (masque le doublon inline)
  const [postcodeResultOpen, setPostcodeResultOpen] = useState(false);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const reviewOpenButtonRef = useRef<HTMLButtonElement>(null);
  // ISSUE #191 -- « Voir les champs à corriger » : le parent affiche les
  // erreurs (showErrors), puis, APRÈS ce rendu, on amène le client au
  // premier champ invalide (ordre du document). Le compteur évite tout
  // déplacement du focus hors d'une demande explicite du client.
  const panelRootRef = useRef<HTMLDivElement>(null);
  const [revealSeq, setRevealSeq] = useState(0);
  useEffect(() => {
    if (revealSeq === 0) return;
    focusFirstInvalidField(panelRootRef.current);
  }, [revealSeq]);
  function revealFieldErrors() {
    onRevealErrors?.();
    setRevealSeq((n) => n + 1);
  }
  const hasFieldErrors =
    Object.keys(customerErrors).length > 0 || Object.keys(invoiceRequestErrors).length > 0;
  // Le geste n'a de sens que si un champ est réellement à corriger dans un
  // mode qui en affiche (pas « mode non choisi », ni table).
  const canRevealFieldErrors = hasFieldErrors && Boolean(serviceMode) && serviceMode !== "table";
  const wasReviewingRef = useRef(false);

  useEffect(() => {
    if (reviewingOrder) {
      reviewHeadingRef.current?.focus();
    } else if (wasReviewingRef.current && !isSubmitting) {
      reviewOpenButtonRef.current?.focus();
    }
    wasReviewingRef.current = reviewingOrder;
  }, [reviewingOrder, isSubmitting]);

  function requestOrderSubmission() {
    if (serviceMode === "delivery" && deliveryStatus.pricingUnavailable) return;
    // ISSUE #183 -- DÉCISION PRODUIT : la fenêtre « Délai et informations de
    // livraison » ne s'ouvre PLUS après le choix du créneau. Le texte de délai
    // configuré reste présenté à la saisie du code postal
    // (DeliveryPostcodeResult), là où il aide à choisir la livraison, et n'est
    // pas répété dans le récapitulatif avant paiement.
    openReviewOrSend();
  }

  /**
   * Table (QR) : ni adresse, ni créneau, ni paiement -- le parcours
   * historique est conservé tel quel (envoi direct). Retrait et
   * livraison passent par le récapitulatif.
   */
  function openReviewOrSend() {
    if (serviceMode === "table") {
      void onSendOrder();
      return;
    }
    setReviewingOrder(true);
  }

  const reviewCgvBlocked = cgvEnforced && !cgvAccepted;

  async function confirmOrderReview() {
    if (isSubmitting || !canSubmit || !noteState.isValid || pricingUnavailable) return;
    // CGV exigées et non acceptées : on RESTE dans le récapitulatif (le
    // message explicite est affiché) -- jamais de retour silencieux à la
    // saisie, jamais d'envoi.
    if (reviewCgvBlocked) return;
    setReviewingOrder(false);
    await onSendOrder();
  }

  /**
   * SCANYM — CUSTOMER ORDERING UX — FULFILLMENT CHOICE v1.1 (POST-
   * SELECTION AUTO-SCROLL / FOCUS).
   *
   * `fulfillmentSectionRef` cible le conteneur de FulfillmentSelector
   * (structure EXISTANTE, aucun changement de FulfillmentSelector lui-
   * même) -- c'est "la prochaine section actionnable du checkout" pour
   * le retrait, et le repli pour la livraison si la sous-section
   * d'adresse n'est pas encore montée (voir plus bas).
   *
   * `lastSeenSelectionSeqRef` est initialisé à la valeur COURANTE de
   * `fulfillmentSelectionSeq` au montage -- donc, y compris quand le
   * panier est rouvert avec un mode déjà choisi précédemment (compteur
   * déjà > 0), le montage lui-même n'arme jamais `pendingSelectionSeqRef`
   * : seul un NOUVEL incrément survenu PENDANT que ce CartPanel est
   * monté (une sélection explicite réelle) déclenche une tentative de
   * défilement/focus.
   *
   * `pendingSelectionSeqRef` porte la sélection explicite EN ATTENTE
   * d'exécution. Pour le retrait, le conteneur `fulfillmentSectionRef`
   * existe dès le rendu qui suit la sélection (aucune dépendance
   * asynchrone) -- l'effet agit donc immédiatement. Pour la livraison,
   * `#delivery-address-section` ne peut apparaître qu'une fois
   * `fieldRequirementsReady` devenu vrai (résolution ASYNCHRONE des
   * exigences via usePublicFieldRequirements, MenuView.tsx) : tant que
   * ni la section n'existe NI les exigences ne sont résolues, l'effet
   * NE FAIT RIEN et laisse la sélection en attente -- elle sera
   * ré-évaluée au prochain rendu déclenché par `fieldRequirementsReady`/
   * `displayItems` (déjà des props légitimement pilotées par l'état de
   * chargement réel de l'application, jamais un minuteur arbitraire).
   * Dès que les exigences sont résolues (que la section adresse existe
   * réellement, ou -- cas limite -- qu'elle soit absente malgré un mode
   * livraison actif), l'effet agit une seule fois et efface l'attente.
   */
  const fulfillmentSectionRef = useRef<HTMLDivElement>(null);
  const lastSeenSelectionSeqRef = useRef(fulfillmentSelectionSeq);
  const pendingSelectionSeqRef = useRef<number | null>(null);

  useEffect(() => {
    if (fulfillmentSelectionSeq !== lastSeenSelectionSeqRef.current) {
      lastSeenSelectionSeqRef.current = fulfillmentSelectionSeq;
      pendingSelectionSeqRef.current = fulfillmentSelectionSeq;
    }

    if (pendingSelectionSeqRef.current === null) {
      // Aucune sélection explicite en attente -- ce passage de l'effet
      // est un simple re-rendu (fieldRequirementsReady/displayItems
      // ayant changé pour une autre raison), rien à faire.
      return;
    }

    if (serviceMode !== "pickup" && serviceMode !== "delivery") {
      // Sélection "table" (ou état inattendu) : aucune section
      // pickup/livraison à amener en vue -- rien à faire ici, la
      // rangée "howToReceive" reste de toute façon déjà visible.
      pendingSelectionSeqRef.current = null;
      return;
    }

    const deliveryAddressSection =
      serviceMode === "delivery"
        ? document.getElementById("delivery-address-section")
        : null;

    if (serviceMode === "delivery" && !deliveryAddressSection && !fieldRequirementsReady) {
      // La section adresse n'existe pas encore ET les exigences ne
      // sont pas encore résolues -- pas assez d'information pour agir
      // sans risquer de défiler/focaliser une cible qui n'existe pas
      // encore. On laisse `pendingSelectionSeqRef` armé : ce même
      // effet se redéclenchera dès que `fieldRequirementsReady`
      // (dépendance ci-dessous) passera à vrai.
      return;
    }

    const scrollTarget = deliveryAddressSection ?? fulfillmentSectionRef.current;
    // Détection de fonctionnalité explicite : jsdom (environnement des
    // tests DOM de ce dépôt) n'implémente PAS `scrollIntoView` (absent,
    // jamais un no-op) -- un appel non gardé y lèverait une exception
    // et casserait le rendu. Un navigateur réel l'implémente toujours ;
    // ce garde-fou ne change donc jamais le comportement en production,
    // il évite seulement un crash dans un moteur DOM qui ne l'implémente
    // pas encore (même principe que le repli try/catch déjà utilisé par
    // FulfillmentChoiceModal.tsx pour showModal()/close()).
    if (scrollTarget && typeof scrollTarget.scrollIntoView === "function") {
      scrollTarget.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    if (serviceMode === "delivery") {
      // Premier champ significatif de l'adresse de livraison
      // (code postal -- voir FulfillmentSelector.tsx,
      // renderDeliveryAddress) : jamais un champ client générique
      // (nom/téléphone/email), jamais un champ masqué/désactivé/
      // absent du DOM. (`offsetParent` n'est délibérément PAS utilisé
      // ici : jsdom -- environnement des tests DOM de ce dépôt -- ne
      // calcule aucune mise en page réelle et renvoie toujours `null`
      // pour `offsetParent`, y compris pour un élément parfaitement
      // visible ; `isConnected` + `hidden` + `disabled` restent
      // fiables aussi bien en navigateur réel qu'en jsdom, et ce champ
      // n'est de toute façon jamais masqué par CSS par ce composant --
      // il est simplement absent du DOM tant qu'il ne doit pas être
      // rendu, cas déjà couvert par `getElementById` retournant `null`.)
      const firstAddressField = document.getElementById("postalCode");
      if (
        firstAddressField instanceof HTMLElement &&
        firstAddressField.isConnected &&
        !firstAddressField.hidden &&
        !(firstAddressField as HTMLInputElement).disabled
      ) {
        firstAddressField.focus();
      }
    }

    pendingSelectionSeqRef.current = null;
    // serviceMode est lu depuis la fermeture de ce rendu (mis à jour
    // dans le MÊME commit React que fulfillmentSelectionSeq pour une
    // sélection explicite, voir MenuView.tsx) -- toujours à jour au
    // moment où cet effet s'exécute. `fieldRequirementsReady` et
    // `displayItems` sont inclus pour permettre la ré-évaluation
    // déterministe décrite ci-dessus (jamais pour redéclencher un
    // défilement sur un changement PUREMENT programmatique de
    // serviceMode seul -- celui-ci n'arme jamais `pendingSelectionSeqRef`,
    // seul un nouvel incrément de `fulfillmentSelectionSeq` le fait).
  }, [fulfillmentSelectionSeq, serviceMode, fieldRequirementsReady, displayItems]);

  // Compteur et validation alignés sur le comptage serveur (voir
  // lib/order-note.ts) : ni note.length ni maxLength natif seuls, pour
  // rester cohérent avec des emojis / caractères arabes.
  // UX LOT 2026-10 / audit Maxwell P2 (commit 34cc977) : champ note
  // DÉSACTIVÉ par l'établissement -> sa validation est IGNORÉE. Une
  // ancienne valeur en état (saisie avant la désactivation, ou trop
  // longue) ne peut plus bloquer l'envoi, et MenuView ne la transmet de
  // toute façon jamais (frozenNote = "" quand order_note_enabled =
  // false). Champ actif : validation inchangée.
  const noteState = normalizeOrderNote(orderNoteEnabled ? note : "");

  /**
   * PRODUCT SERVICE MODES v1 -- panier mixte (issue #11, décision CIO) :
   * quels modes de service l'établissement propose sont désormais
   * bloqués PAR LE CONTENU ACTUEL DU PANIER, et par quels produits.
   * Purement présentation -- `create_order` (serveur) reste la seule
   * autorité qui compte (voir lib/service-mode-restrictions.ts) : aucun
   * article n'est jamais retiré ni scindé ici, seul le CHOIX DE MODE
   * peut devenir indisponible.
   */
  const blockedModes = useMemo(
    () => blockingItemsByMode(lines.map((l) => l.item)),
    [lines]
  );

  /**
   * Issue #155 -- VISIBILITÉ du message « {mode} indisponible avec ce
   * panier : … ». La RÈGLE (quels modes sont bloqués, par quels produits,
   * `blockedModes` ci-dessus) ne change pas ; seule la visibilité de son
   * explication est ciblée sur le mode concerné :
   *   - aucun mode encore choisi (`serviceMode === null`, y compris après
   *     la désélection automatique d'un mode devenu bloqué) : tous les
   *     messages de blocage restent visibles -- le client doit comprendre
   *     ce qu'il peut choisir ;
   *   - un mode choisi : seul le message de CE mode (s'il est bloqué)
   *     reste visible ; le message d'un autre mode bloqué (ex. Livraison
   *     quand le client a choisi À emporter) disparaît ;
   *   - tentative explicite de sélection d'un mode bloqué (clic sur son
   *     bouton) : son message réapparaît, jusqu'à ce qu'un mode soit
   *     choisi ou que le panier ne le bloque plus.
   * Le bouton d'un mode bloqué n'est plus `disabled` (un bouton désactivé
   * ne reçoit aucun clic, donc aucune « tentative » ne pourrait être
   * expliquée) mais `aria-disabled` : focusable, cliquable, jamais
   * sélectionnable -- `onSelectFulfillment` n'est jamais appelé pour lui.
   */
  const [attemptedBlockedMode, setAttemptedBlockedMode] = useState<ServiceMode | null>(null);
  useEffect(() => {
    if (attemptedBlockedMode !== null && !blockedModes[attemptedBlockedMode]) {
      setAttemptedBlockedMode(null);
    }
  }, [attemptedBlockedMode, blockedModes]);
  useEffect(() => {
    if (serviceMode !== null) setAttemptedBlockedMode(null);
  }, [serviceMode]);
  const blockedMessageVisible = (mode: ServiceMode): boolean =>
    Boolean(blockedModes[mode]) &&
    (serviceMode === null || serviceMode === mode || attemptedBlockedMode === mode);

  /**
   * SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION —
   * frais de livraison ESTIMÉ (voir lib/delivery.ts,
   * computeDeliveryFee) : jamais appliqué au retrait/sur place (§16 :
   * "Pickup must not incur delivery fee"), jamais transmis au serveur
   * (create_order recalcule indépendamment, ne fait jamais confiance à
   * une valeur fournie par le client).
   */
  const deliveryFee =
    serviceMode === "delivery" ? deliveryStatus.deliveryFee ?? 0 : 0;
  const pricingUnavailable = serviceMode === "delivery" && deliveryStatus.pricingUnavailable;
  const grandTotal = (Math.round(totalPrice * 100) + Math.round(deliveryFee * 100)) / 100;

  /**
   * PRODUCT SERVICE MODES v1 -- modes de l'établissement qu'aucun
   * produit du panier actuel ne bloque. Le popup de choix (ci-dessous)
   * ne propose jamais un mode bloqué -- rien d'utile à choisir tant
   * que le panier lui-même n'a pas changé (message dédié, rangée
   * "howToReceive" plus bas, qui reste seule à afficher TOUS les
   * modes -- y compris bloqués -- pour que le client comprenne la
   * situation).
   */
  const unblockedServiceModes = availableServiceModes.filter((m) => !blockedModes[m]);

  /**
   * SCANYM — CUSTOMER ORDERING UX — FULFILLMENT CHOICE POPUP v1 :
   * n'apparaît QUE quand un choix explicite est réellement requis --
   * mêmes conditions, EXACTEMENT, que la rangée "howToReceive"
   * déjà existante plus bas (availableServiceModes.length > 1) --
   * plus `serviceMode === null` (aucun choix encore fait ; dès qu'un
   * choix existe, le popup ne doit plus jamais réapparaître par-
   * dessus une sélection déjà faite, y compris si le client rouvre le
   * panier ensuite). Jamais affiché pendant "loading"/"error" -- dans
   * ces deux états, availableServiceModes (dérivé de saleModesData
   * côté MenuView) est de toute façon vide, donc length > 1 est déjà
   * fail-closed.
   *
   * PRODUCT SERVICE MODES v1 -- utilise désormais
   * `unblockedServiceModes` (jamais `availableServiceModes` seul) :
   * un panier déjà mixte au moment où ce choix devient nécessaire ne
   * doit jamais proposer, dans ce popup, un mode que ce même panier
   * bloque de toute façon.
   */
  const requiresFulfillmentChoice =
    serviceMode === null && unblockedServiceModes.length > 1;

  /**
   * Corrige ALC-SM-02 (audit Work, MEDIUM, CASE 1) : trois états
   * distincts, jamais confondus --
   *   - "loading"            -> message de chargement (existant,
   *                              partagé avec fieldRequirements) ;
   *   - "error"               -> message neutre dédié, jamais un
   *                              chargement infini, aucun repli legacy ;
   *   - "loaded", liste VIDE  -> message dédié "aucun mode disponible",
   *                              JAMAIS "Choisissez le retrait ou la
   *                              livraison" (qui suppose un choix réel) ;
   *   - "loaded", liste non vide, aucun choix fait -> message existant
   *     missingFulfillment (un choix existe réellement, au client de
   *     le faire) ;
   *   - table/pickup/delivery choisi mais incomplet -> messages
   *     existants, inchangés.
   */
  const missing =
    saleModesState.status === "loading"
      ? t("mcLoading")
      : saleModesState.status === "error"
        ? t("saleModesError")
        : availableServiceModes.length === 0
          ? t("saleModesEmpty")
          : !serviceMode
            ? t("missingFulfillment")
            : serviceMode === "table"
              ? t("missingTable")
              : scheduleHint
                ? scheduleHint
                : t("missingCustomer");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden bg-espresso/50">
      <div ref={panelRootRef} className="flex h-[100dvh] w-full min-w-0 max-w-full flex-col overflow-x-hidden bg-crema sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-t-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-espresso/10 px-4 py-3">
          <h2 className="text-lg font-bold">{reviewingOrder ? t("checkoutReviewTitle") : t("cartTitle")}</h2>
          <button
            onClick={onClose}
            aria-label={t("ariaCloseCart")}
            className="rounded-full px-3 py-1 text-sm font-medium text-ink-on-bg-muted"
          >
            {t("close")} ✕
          </button>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3 pb-6">
          {reviewingOrder && lines.length > 0 ? (
            <section data-checkout-review="" aria-labelledby="checkout-review-heading" className="space-y-4">
              <div>
                <h3 id="checkout-review-heading" ref={reviewHeadingRef} tabIndex={-1} className="text-base font-bold">{t("checkoutReviewTitle")}</h3>
                <p className="mt-1 text-sm text-ink-on-bg-muted">{t("checkoutReviewIntro")}</p>
              </div>
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-on-bg-muted">{t("checkoutReviewItems")}</h4>
                <ul className="space-y-2">
                  {lines.map(({ key, item, quantity, option, optionKind }) => (
                    <li key={key} className="flex justify-between gap-3 rounded-xl p-3 bg-crema text-sm">
                      <span className="min-w-0">
                        <span className="font-semibold">{quantity} × {tName(item, lang, sourceLanguage)}</span>
                        {option && <span className="block text-xs text-ink-on-bg-muted">{t(optionKind === "flavor" ? "optFlavor" : "optPastry")}: {tName(option, lang, sourceLanguage)}</span>}
                      </span>
                      <Ltr>{formatPrice(item.price * quantity, currency)}</Ltr>
                    </li>
                  ))}
                </ul>
              </div>
              <dl className="space-y-2 rounded-xl border border-espresso/10 p-3 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-on-bg-muted">{t("checkoutReviewMode")}</dt>
                  <dd className="text-right font-medium">{serviceMode ? t(serviceModeNameKey(serviceMode)) : "—"}</dd>
                </div>
                {serviceMode === "delivery" && (
                  <div>
                    <dt className="text-ink-on-bg-muted">{t("checkoutReviewAddress")}</dt>
                    <dd className="mt-0.5 font-medium">{[customer.street, customer.postalCode, customer.city].filter((part) => part.trim()).join(", ") || "—"}</dd>
                  </div>
                )}
                {serviceMode === "pickup" && typeof restaurant.config.address === "string" && restaurant.config.address.trim() && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-on-bg-muted">{t("checkoutReviewPickupLocation")}</dt>
                    <dd className="text-right font-medium">{restaurant.config.address}</dd>
                  </div>
                )}
                {serviceMode === "table" && tableNumber !== null && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-on-bg-muted">{t("checkoutReviewTable")}</dt>
                    <dd className="font-medium">{tableNumber}</dd>
                  </div>
                )}
                {scheduleSummary && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-on-bg-muted">{t("checkoutReviewSchedule")}</dt>
                    <dd data-checkout-review-schedule="" className="text-right font-medium">
                      {formatCheckoutReviewDate(scheduleSummary.date, lang)}
                      {scheduleSummary.slot_key !== null && scheduleSummary.starts_at && scheduleSummary.ends_at
                        ? ` · ${scheduleSummary.starts_at}–${scheduleSummary.ends_at}`
                        : scheduleSummary.starts_at
                          ? ` · ${scheduleSummary.starts_at}`
                          : ""}
                    </dd>
                  </div>
                )}
                {orderNoteEnabled && note.trim() && (
                  <div>
                    <dt className="text-ink-on-bg-muted">{t("noteLabel")}</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap font-medium">{note}</dd>
                  </div>
                )}
              </dl>
            </section>
          ) : lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-on-bg-muted">
              {t("cartEmpty")}
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map(({ key, item, quantity, option, optionKind }) => (
                <li
                  key={key}
                  // Corrige UIFIX-V2-01 (contre-audit Work, 3e tour) :
                  // ce conteneur englobe des DESCENDANTS dont le texte
                  // (text-ink-on-bg-muted, text-accent-dark-on-bg) est
                  // calculé contre --sc-bg, alors que le conteneur
                  // lui-même restait sur un fond littéral figé --
                  // exactement le même défaut structurel que
                  // UIFIX-01, mais en relation parent/descendant
                  // plutôt que sur un seul élément. bg-crema
                  // (= var(--sc-bg)) réaligne le fond réellement
                  // affiché sur la même source que ces textes.
                  className="flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded-xl bg-crema p-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug">
                      {tName(item, lang, sourceLanguage)}
                    </p>
                    {option && (
                      <p className="text-xs text-ink-on-bg-muted">
                        {t(optionKind === "flavor" ? "optFlavor" : "optPastry")} :{" "}
                        {tName(option, lang, sourceLanguage)}
                      </p>
                    )}
                    <p className="mt-0.5 text-sm text-accent-dark-on-bg">
                      <Ltr>{formatPrice(item.price * quantity, currency)}</Ltr>
                    </p>
                  </div>
                  <div className="shrink-0">
                    <QuantityControl
                      quantity={quantity}
                      onChange={(delta) => onChangeQuantity(key, delta)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            // #181 -- masqué, JAMAIS démonté, pendant le récapitulatif : le retour
            // sur « Modifier ma commande » retrouve la saisie, les fenêtres déjà
            // fermées (résultat du code postal) et le sélecteur de créneau tels
            // quels. `hidden` retire aussi ces contrôles de l'ordre de tabulation.
            <div hidden={reviewingOrder} aria-hidden={reviewingOrder || undefined} data-checkout-edit="">
              <FulfillmentChoiceModal
                open={requiresFulfillmentChoice}
                modes={unblockedServiceModes}
                onSelect={onSelectFulfillment}
              />
              <DeliveryPostcodeResult key={restaurant.id}
                active={serviceMode === "delivery" && deliveryPricingReady && isValidPostalCodeFor(deliveryCountry, customer.postalCode) && !reviewingOrder}
                contextKey={`${restaurant.id}:${deliveryCountry?.countryCode ?? ""}`}
                postcode={customer.postalCode} status={deliveryStatus} subtotal={totalPrice} currency={currency}
                onOpenChange={setPostcodeResultOpen} />

              {serviceMode === "table" && (
                <TableSelector
                  maxTables={max_tables}
                  selected={tableNumber}
                  onSelect={onSelectTable}
                />
              )}

              {(serviceMode === "pickup" || serviceMode === "delivery") && (
                // ref="fulfillmentSectionRef" : cible de défilement
                // FULFILLMENT CHOICE v1.1 -- "la prochaine section
                // actionnable du checkout" après une sélection à
                // emporter, et repli pour la livraison si le sous-bloc
                // adresse dédié (#delivery-address-section) n'est pas
                // encore monté. FulfillmentSelector lui-même n'est pas
                // modifié -- seul ce conteneur, déjà existant, gagne un
                // ref.
                <div ref={fulfillmentSectionRef}>
                  <FulfillmentSelector
                    status={deliveryStatus}
                    ruleTextShownInDialog={postcodeResultOpen}
                    type={serviceMode}
                    customer={customer}
                    errors={customerErrors}
                    showErrors={showErrors}
                    displayItems={displayItems}
                    fieldRequirementsReady={fieldRequirementsReady}
                    deliveryModeAvailable={availableServiceModes.includes("delivery")}
                    onChangeCustomer={onChangeCustomer}
                    onSelectFulfillment={onSelectFulfillment}
                    whatsappEnabled={whatsappEnabled}
                    deliveryCountry={deliveryCountry}
                    deliveryCountryOptions={deliveryCountryOptions}
                    deliveryCountryScope={deliveryCountryScope}
                    cityOptions={cityOptions}
                    onSelectDeliveryCountry={onSelectDeliveryCountry}
                    communicationTexts={communicationTexts}
                  />
                </div>
              )}

              {/* CSDJ-2 / #158 -- date et créneau proposés par le SERVEUR
                  (retrait ; livraison si un calendrier est configuré).
                  Rien n'est rendu sans calendrier. */}
              {scheduleSection}

              <div className="mt-4">
                <InvoiceRequestFields
                  info={invoiceRequest}
                  errors={invoiceRequestErrors}
                  onChange={onChangeInvoiceRequest}
                  serviceMode={serviceMode}
                  customer={customer}
                  // CUSTOMER BILLING PROFILE v2 -- MÊME source de
                  // textes marchands que FulfillmentSelector juste
                  // au-dessus : aucune seconde lecture, aucun second
                  // chargement.
                  communicationTexts={communicationTexts}
                />
              </div>

              {orderNoteEnabled && (
              <div className="mt-4" data-order-note-block="">
                <label
                  htmlFor="order-note"
                  className="text-xs font-semibold uppercase tracking-wide text-ink-on-bg-muted"
                >
                  {t("noteLabel")}
                </label>
                <textarea
                  id="order-note"
                  rows={2}
                  value={note}
                  onChange={(e) => onChangeNote(e.target.value)}
                  placeholder={t("notePlaceholder")}
                  aria-invalid={!noteState.isValid || undefined}
                  className={
                    "mt-1.5 w-full resize-none rounded-xl border bg-white p-3 text-sm text-stone-900 placeholder:text-stone-500 " +
                    // CHECKOUT UX/A11Y MICRO-LOT (issue #11) -- pastille
                    // OPAQUE auto-suffisante (bg-red-50 + border-red-500,
                    // couple fixe, contraste interne 3,44:1 vérifié) :
                    // remplace intégralement bg-white, donc jamais
                    // dépendante de --sc-bg -- pas var(--sc-error) ici
                    // (qui répondrait au mauvais fond).
                    (noteState.isValid
                      ? "border-espresso/10"
                      : "border-red-500 bg-red-50")
                  }
                />
                <p
                  className={
                    "mt-1 text-right text-xs " +
                    // Ce texte, contrairement à la pastille ci-dessus,
                    // reste rendu à même le fond de PAGE ambiant
                    // (--sc-bg) -- text-error (adaptatif) est donc le
                    // bon choix ici, pas un rouge fixe.
                    (noteState.isValid ? "text-ink-on-bg-muted" : "font-semibold text-error")
                  }
                >
                  {t("noteCounter", {
                    count: noteState.length,
                    max: ORDER_NOTE_MAX_LENGTH,
                  })}
                </p>
              </div>
              )}
            </div>
          )}
        </div>

        {lines.length > 0 && (
          <div className="min-w-0 max-w-full shrink-0 overflow-x-hidden border-t border-espresso/10 bg-crema px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.06)]">
            {/* CORRECTIF (audit CHATEAUBRIAND round 2, issue #11) --
                cette rangée entière était masquée dès que
                l'établissement ne propose qu'UN SEUL mode
                (`availableServiceModes.length > 1`), y compris le
                message nommant le(s) produit(s) bloquant(s) -- un
                établissement mono-mode dont l'unique mode devenait
                bloqué par le panier (ex. produit restreint à
                room_service seul) n'affichait alors STRICTEMENT AUCUNE
                explication au client (le bouton "Commander" restait
                simplement désactivé, canSubmit, sans aucun message).
                Le sélecteur de mode (boutons) reste inutile quand il
                n'y a qu'un seul mode -- rien à choisir -- mais le
                message de blocage, lui, DOIT rester visible dès qu'un
                mode (seul ou parmi plusieurs) est bloqué par le
                panier. */}
            {!reviewingOrder && (availableServiceModes.length > 1 ||
              (availableServiceModes.length === 1 &&
                Boolean(blockedModes[availableServiceModes[0]]))) && (
              <div className="mb-3">
                {availableServiceModes.length > 1 && (
                  <>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-on-bg-muted">
                      {t("howToReceive")}
                    </p>
                    <div className="mt-2 flex gap-2">
                  {availableServiceModes.map((mode) => {
                    const selected = serviceMode === mode;
                    const deliveryIncomplete =
                      mode === "delivery" && selected && !deliveryStatus.eligible;
                    // PRODUCT SERVICE MODES v1 -- ce mode, par ailleurs
                    // activé pour l'établissement, est rendu
                    // indisponible par au moins un produit du panier
                    // actuel. Prime sur `deliveryIncomplete` (raison
                    // distincte, jamais cumulée dans le même bouton) --
                    // le message dédié ci-dessous, sous la rangée, nomme
                    // le(s) produit(s) en cause.
                    const blockedByCart = blockedModes[mode];
                    const hint =
                      deliveryStatus.block === "out-of-zone"
                        ? t("deliveryOutOfZoneShort")
                        : deliveryStatus.block === "below-min"
                          ? t("deliveryMinimumShort")
                          : t("deliveryCompleteAddressShort");

                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          // Un mode bloqué par le panier n'est jamais
                          // sélectionnable -- aucun scindage automatique,
                          // aucun retrait d'article : le client doit
                          // d'abord ajuster son panier (message dédié
                          // ci-dessous) ou choisir un autre mode.
                          // Issue #155 : la TENTATIVE est retenue pour
                          // (ré)afficher l'explication du refus.
                          if (blockedByCart) {
                            setAttemptedBlockedMode(mode);
                            return;
                          }
                          // Tout choix EXPLICITE d'un mode utilisable
                          // (même déjà sélectionné) clôt la tentative :
                          // l'effet sur `serviceMode` ne suffirait pas
                          // quand le mode ne change pas.
                          setAttemptedBlockedMode(null);
                          onSelectFulfillment(mode);
                        }}
                        aria-disabled={blockedByCart ? true : undefined}
                        data-mode-blocked={blockedByCart ? "true" : undefined}
                        aria-pressed={selected}
                        aria-invalid={deliveryIncomplete || Boolean(blockedByCart) || undefined}
                        aria-describedby={blockedMessageVisible(mode) ? `mode-blocked-${mode}` : undefined}
                        className={
                          "min-w-0 flex-1 rounded-xl border px-2 py-2.5 text-sm font-semibold " +
                          (blockedByCart
                            ? "cursor-not-allowed border-amber-200 bg-amber-50/60 text-amber-900/70"
                            : deliveryIncomplete
                              ? "border-amber-500 bg-amber-50 text-amber-900"
                              : selected
                                ? "border-caramel bg-caramel text-caramel-ink"
                                // Corrige UIFIX-01 : même défaut que
                                // CategoryNav -- bg-crema (= var(--sc-bg))
                                // réaligne fond et texte sur la même
                                // source de contraste.
                                : "border-transparent bg-crema text-ink-on-bg shadow-sm")
                        }
                      >
                        <span className="block">
                          {t(mode === "table" ? "modeTable" : mode)}
                        </span>
                        {deliveryIncomplete && !blockedByCart && (
                          <span className="mt-0.5 block truncate text-[0.65rem] font-medium">
                            {hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                    </div>
                  </>
                )}
                {/* PRODUCT SERVICE MODES v1 -- un message par mode
                    BLOQUÉ (jamais fusionnés en un seul texte ambigu),
                    nommant explicitement le(s) produit(s) en cause --
                    high-contrast (amber-50/amber-900, même paire que
                    les autres avertissements de ce panier), jamais une
                    couleur seule sur le bouton ci-dessus qui le
                    suffirait pas seule à en expliquer la raison.
                    CORRECTIF round 2 : reste rendu même quand
                    `availableServiceModes.length === 1` (pas de
                    rangée de boutons au-dessus dans ce cas -- voir
                    commentaire plus haut) car c'est la condition
                    englobante qui garantit déjà qu'au moins un mode
                    de `availableServiceModes` est bloqué ici. */}
                {availableServiceModes.map((mode) => {
                  const blockers = blockedModes[mode];
                  // Issue #155 : visibilité ciblée (voir blockedMessageVisible).
                  if (!blockers || !blockedMessageVisible(mode)) return null;
                  return (
                    <p
                      key={`blocked-${mode}`}
                      id={`mode-blocked-${mode}`}
                      role="status"
                      className="mt-2 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-900"
                    >
                      {t("serviceModeBlockedByCart", {
                        mode: t(serviceModeNameKey(mode)),
                        items: blockers.map((i) => tName(i, lang, sourceLanguage)).join(", "),
                      })}
                    </p>
                  );
                })}
              </div>
            )}

            {/* SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING
                FOUNDATION (mission §12) : décomposition Produits /
                Livraison / Total, affichée UNIQUEMENT quand un frais
                de livraison réel s'applique (jamais pour
                pickup/table/mode gratuit -- une seule ligne "Total"
                alors, comportement INCHANGÉ) -- jamais de double
                affichage du frais. */}
            {deliveryFee > 0 && (
              <div className="mb-1 flex items-center justify-between text-sm text-ink-on-bg-muted">
                <span>{t("subtotalLabel")}</span>
                <span>
                  <Ltr>{formatPrice(totalPrice, currency)}</Ltr>
                </span>
              </div>
            )}
            {deliveryFee > 0 && (
              <div className="mb-1 flex items-center justify-between text-sm text-ink-on-bg-muted">
                <span>{t("deliveryFeeLabel")}</span>
                <span>
                  <Ltr>{formatPrice(deliveryFee, currency)}</Ltr>
                </span>
              </div>
            )}
            <div className="mb-3 flex items-center justify-between font-bold">
              <span>{t("total")}</span>
              <span>
                <Ltr>{pricingUnavailable ? "—" : formatPrice(grandTotal, currency)}</Ltr>
              </span>
            </div>
            {pricingUnavailable && <p role="status" className="mb-3 text-sm">{t("deliveryPriceUnavailable")}</p>}
            {submitError && (
              // CHECKOUT UX/A11Y MICRO-LOT (issue #11) -- pastille
              // opaque fixe (bg-red-50/text-red-800, 7,60:1 vérifié),
              // vraie couleur d'erreur (remplace amber-50/amber-900) ;
              // fond auto-suffisant, pas var(--sc-error) ici.
              <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">
                {submitError}
              </p>
            )}

            {paymentError ? (
              // PAYMENT P4-A : la commande existe déjà et attend son
              // paiement -- reprise CIBLÉE (POST checkout sur la MÊME
              // commande, reprise idempotente côté serveur), jamais une
              // nouvelle soumission du panier.
              <>
                <p className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-800" data-payment-error="">
                  {paymentError}
                </p>
                <button
                  type="button"
                  data-payment-action="retry"
                  onClick={onRetryPayment}
                  disabled={isRetryingPayment}
                  aria-busy={isRetryingPayment}
                  className={
                    "block w-full rounded-xl py-3.5 text-center font-bold text-white " +
                    (isRetryingPayment ? "cursor-wait bg-espresso/60" : "bg-espresso")
                  }
                >
                  {isRetryingPayment ? t("paymentRedirecting") : t("paymentRetry")}
                </button>
              </>
            ) : invoiceRequestError ? (
              // CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST
              // v1.2 (FERME "SILENT INVOICE LOSS") : la commande
              // existe déjà -- le bouton d'envoi NORMAL est remplacé
              // par une reprise CIBLÉE de la demande de facture
              // SEULE, jamais une nouvelle soumission complète du
              // panier (qui recréerait une commande).
              <>
                {/* CHECKOUT UX/A11Y MICRO-LOT (issue #11) -- même
                    pastille opaque fixe que submitError ci-dessus. */}
                <p className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">
                  {invoiceRequestError}
                </p>
                <button
                  onClick={onRetryInvoiceRequest}
                  disabled={isRetryingInvoice}
                  aria-busy={isRetryingInvoice}
                  className={
                    "block w-full rounded-xl py-3.5 text-center font-bold text-white " +
                    (whatsappEnabled
                      ? isRetryingInvoice
                        ? "cursor-wait bg-[#25D366]/60"
                        : "bg-[#25D366]"
                      : isRetryingInvoice
                        ? "cursor-wait bg-espresso/60"
                        : "bg-espresso")
                  }
                >
                  {isRetryingInvoice ? t("sending") : t("invoiceRetry")}
                </button>
              </>
            ) : (
              <>

            {/* SADFP-02 (CORRECTION v2), maintenant REFERMÉ par SELLER
                LEGAL PROFILE + CGV ENGINE v1 : l'acquittement avait été
                retiré ici car les liens pointaient vers des pages
                légales inexistantes (/legal/privacy, /legal/terms) --
                le checkout ne doit jamais exiger l'acceptation de
                documents inaccessibles. `cgvLegalHref`/`cgvEnforced`
                proviennent désormais d'une page légale RÉELLE
                (app/legal/[slug]) et du statut serveur authentique du
                marchand (CGV_ACTIVE) -- jamais un lien ou un contenu
                inventé ici. Pour tout marchand `cgvEnforced === false`
                (non configuré ou pas encore activé), le comportement
                reste EXACTEMENT celui d'avant ce lot : aucune case,
                aucun lien, aucun blocage supplémentaire. */}

            {canSubmit && noteState.isValid && !pricingUnavailable ? (
              <>
                {cgvEnforced && (
                  <label className="mb-3 flex items-start gap-2 text-sm text-ink-on-bg-muted">
                    <input
                      type="checkbox"
                      checked={cgvAccepted}
                      onChange={(e) => onChangeCgvAccepted(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span>
                      {t("cgvAcceptancePrefix")}{" "}
                      {cgvLegalHref ? (
                        <a
                          href={cgvLegalHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {t("cgvAcceptanceLinkLabel")}
                        </a>
                      ) : (
                        t("cgvAcceptanceLinkLabel")
                      )}
                      . {t("cgvAcceptanceObligation")}
                    </span>
                  </label>
                )}
                {/* CUSTOMER CONTACT v1 -- WhatsApp optionnel : désactivé,
                    AUCUNE mention WhatsApp (texte, couleur, libellé). */}
                {reviewingOrder ? (
                  <>
                    <p className="mb-3 text-center text-sm text-ink-on-bg-muted">{t("checkoutReviewPaymentHint")}</p>
                    {reviewCgvBlocked && (
                      <p id="checkout-review-cgv-required" data-checkout-review-cgv-required="" role="status" className="mb-3 rounded-xl bg-red-50 p-3 text-center text-sm text-red-800">{t("checkoutReviewCgvRequired")}</p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => setReviewingOrder(false)} className="rounded-xl border border-espresso/20 py-3 font-semibold">{t("checkoutReviewBack")}</button>
                      <button type="button" data-checkout-review-confirm="" onClick={() => void confirmOrderReview()} disabled={isSubmitting || !canSubmit || !noteState.isValid || pricingUnavailable || reviewCgvBlocked} aria-describedby={reviewCgvBlocked ? "checkout-review-cgv-required" : undefined} aria-busy={isSubmitting} className="rounded-xl bg-green-700 py-3 font-bold text-white disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-700">{isSubmitting ? t("sending") : t("checkoutReviewConfirm")}</button>
                    </div>
                  </>
                ) : (
                  <>
                <p className="mb-2 text-center text-sm text-ink-on-bg-muted">
                  {whatsappEnabled ? t("whatsappNotice") : t("orderNoticeNoWhatsapp")}
                </p>
                {serviceMode !== "table" && (
                  <p className="mb-2 text-center text-xs text-ink-on-bg-muted">
                    {t("checkoutReviewBeforeConfirmHint")}
                  </p>
                )}
                <button
                  ref={reviewOpenButtonRef}
                  onClick={requestOrderSubmission}
                  disabled={isSubmitting || (cgvEnforced && !cgvAccepted)}
                  aria-busy={isSubmitting}
                  className={
                    "block w-full rounded-xl py-3.5 text-center font-bold " +
                    // CHECKOUT UX/A11Y MICRO-LOT (issue #11) -- signal
                    // de validité, PAS un signal de marque : cette
                    // condition (isSubmitting || CGV manquantes) est
                    // exactement "toutes les conditions ne sont pas
                    // encore remplies" (champs+mode déjà garantis par
                    // le rendu de cette branche, voir plus bas --
                    // seules CGV/soumission restent à couvrir ici).
                    // Vert UNIQUEMENT quand tout est effectivement
                    // validable -- jamais la couleur de marque
                    // WhatsApp (#25D366) : le mandat CUSTOMER CONTACT
                    // v1 ci-dessus ("AUCUNE mention WhatsApp -- texte,
                    // couleur, libellé" quand désactivé) interdit déjà
                    // de réserver cette teinte à ce canal -- green-700
                    // est une couleur sémantique générique, jamais un
                    // rappel de marque, appliquée identiquement que
                    // WhatsApp soit actif ou non. Gris net (pas une
                    // simple opacité réduite de la couleur active) pour
                    // un état "clairement inactif" sans ambiguïté --
                    // les deux paires vérifiées WCAG (5,02:1 et 6,90:1).
                    (isSubmitting || (cgvEnforced && !cgvAccepted)
                      ? "cursor-not-allowed bg-stone-300 text-stone-700"
                      : "bg-green-700 text-white")
                  }
                >
                  {isSubmitting
                    ? t("sending")
                    : whatsappEnabled
                      ? t("sendOrder")
                      : t("sendOrderNoWhatsapp")}
                </button>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="break-words rounded-xl bg-espresso/5 px-3 py-3.5 text-center text-sm font-medium text-ink-on-bg-muted">
                  {!noteState.isValid ? t("noteTooLong") : missing}
                </p>
                {/* ISSUE #191 -- aucun bouton ajouté : le bouton d'envoi
                    HABITUEL reste visible, grisé (aria-disabled, jamais
                    `disabled` : il doit rester atteignable au clavier).
                    Au clic il n'envoie rien : il affiche les erreurs puis
                    amène le client au premier champ invalide. */}
                {noteState.isValid && canRevealFieldErrors && (
                  <button
                    type="button"
                    data-checkout-send-blocked=""
                    aria-disabled="true"
                    onClick={revealFieldErrors}
                    className="mt-2 block w-full cursor-not-allowed rounded-xl bg-stone-300 py-3.5 text-center font-bold text-stone-700"
                  >
                    {whatsappEnabled ? t("sendOrder") : t("sendOrderNoWhatsapp")}
                  </button>
                )}
              </>
            )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
