/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — CATALOGUE FERMÉ des
 * textes customer-facing configurables par le commerçant.
 *
 * Logique PURE (aucun réseau, aucun React, aucune dépendance Supabase)
 * -- prolongement STRICT de lib/tracking/status-text.ts, dont ce module
 * reprend la discipline mot pour mot :
 *
 *   - un CATALOGUE FERMÉ de clés (ici `COMMUNICATION_TEXT_KEYS`, là les
 *     7 statuts canoniques) : le commerçant choisit un EMPLACEMENT
 *     existant, il n'en déclare jamais un nouveau ;
 *   - la surcharge marchande ne porte que du TEXTE BRUT, jamais du
 *     balisage (voir lib/communications/template-variables.ts pour le
 *     seul mécanisme d'insertion autorisé) ;
 *   - absence / vide / blancs / trop long = « pas de surcharge », JAMAIS
 *     « afficher un texte vide » et JAMAIS une troncature silencieuse ;
 *   - AUCUN texte littéral ici : ce module nomme des clés i18n et ne
 *     contient pas une seule phrase customer-facing.
 *
 * POURQUOI UN SECOND CATALOGUE ET NON UNE EXTENSION DE
 * `merchant_tracking_status_text` : cette table-là est indexée par les 7
 * STATUTS canoniques de commande -- sa clé primaire PORTE UN SENS
 * d'état. Les emplacements ci-dessous ne sont pas des statuts (un
 * « avertissement sanitaire » n'est pas un état de commande) ; les
 * mélanger forcerait soit à inventer de faux statuts, soit à relâcher la
 * contrainte CHECK qui garantit aujourd'hui qu'un commerçant ne peut pas
 * fabriquer un 8e statut. Le MODÈLE est repris à l'identique (même DDL,
 * même RPC, même repli, même sanitisation), le DOMAINE est distinct.
 *
 * AUCUN TEXTE SPÉCIFIQUE À UN COMMERÇANT (mandat, littéral : « NO
 * HARDCODED AU LAIT CRU TEXT ») : les valeurs par défaut sont des clés
 * i18n PLATEFORME génériques, identiques pour tous les tenants.
 */

/**
 * Les 17 emplacements configurables. Ordre = ordre d'apparition dans le
 * parcours client (checkout -> confirmation -> e-mail), qui est aussi
 * l'ordre du formulaire back-office : une seule source pour les deux.
 *
 * `as const` + tuple : le type `CommunicationTextKey` est dérivé de
 * cette liste, jamais écrit à la main deux fois.
 */
export const COMMUNICATION_TEXT_KEYS = [
  // THEME & CONTENT SETTINGS v1 -- aide « comment commander » de la
  // vitrine (bouton + popup). Placées EN TÊTE : elles précèdent le
  // checkout dans le parcours client.
  "order_help_button_label",
  "order_help_title",
  "order_help_body",
  "checkout_info",
  "pickup_explanation",
  "delivery_local_explanation",
  "delivery_carrier_explanation",
  "slot_warning",
  "sanitary_warning",
  "order_success_title",
  "order_success_body",
  "confirmation_pickup",
  "confirmation_delivery_local",
  "confirmation_delivery_carrier",
  "email_confirmation_subject",
  "email_confirmation_body",
  "confirmation_withdrawal_request",
] as const;

export type CommunicationTextKey = (typeof COMMUNICATION_TEXT_KEYS)[number];

/**
 * Longueur maximale GÉNÉRALE d'une surcharge -- MIROIR EXACT de la
 * contrainte SQL `merchant_communication_text_body_length` (voir
 * supabase/DRAFT-lot-merchant-customer-communications-v1.sql). Alignée
 * sur les 500 caractères déjà retenus pour
 * `restaurant_sale_modes.customer_text` plutôt que sur les 400 de
 * `merchant_tracking_status_text` : ces emplacements-ci remplacent des
 * paragraphes de checkout, pas une ligne de badge.
 */
export const COMMUNICATION_TEXT_MAX_LENGTH = 500;

/**
 * Longueur maximale d'un SUJET d'e-mail. Volontairement plus courte :
 * au-delà, les clients de messagerie tronquent eux-mêmes, et un sujet
 * tronqué par le destinataire est pire qu'un sujet refusé à la saisie.
 */
export const COMMUNICATION_SUBJECT_MAX_LENGTH = 160;

/**
 * THEME & CONTENT SETTINGS v1 -- bornes dédiées à l'aide « comment
 * commander ». Le libellé d'un bouton et le titre d'un popup sont des
 * LIGNES, pas des paragraphes : au-delà, ils casseraient la mise en page
 * (bouton qui déborde, titre sur cinq lignes) -- c'est le garde-fou
 * « layout-breaking » du mandat. MIROIR EXACT de
 * `communication_text_max_length` (DRAFT-lot-theme-content-settings-v1.sql).
 * Le corps reste à la borne générale de 500 (contrainte de table inchangée).
 */
export const COMMUNICATION_ORDER_HELP_LABEL_MAX_LENGTH = 60;
export const COMMUNICATION_ORDER_HELP_TITLE_MAX_LENGTH = 120;

export interface CommunicationTextSpec {
  /** Longueur maximale propre à cet emplacement (<= MAX_LENGTH). */
  readonly maxLength: number;
  /**
   * `true` lorsque l'emplacement est exposé à la projection PUBLIQUE
   * anonyme (`get_restaurant_public_communication_texts`), parce que le
   * client doit le voir AVANT/PENDANT la commande. `false` = lecture
   * serveur uniquement (gabarits d'e-mail) : jamais sérialisé vers le
   * navigateur, même non affiché -- même discipline de frontière que le
   * retrait de `withdrawal_eligible` dans lib/services/restaurant.ts.
   */
  readonly publicProjection: boolean;
  /**
   * Clé i18n du texte de base, ou `null` lorsque l'emplacement est
   * ADDITIF (voir MCC-V1-DEFAULT-ABSENT-01 ci-dessous).
   */
  readonly defaultI18nKey: string | null;
}

/**
 * MCC-V1-DEFAULT-ABSENT-01 -- pourquoi certains emplacements ont
 * `defaultI18nKey: null` :
 *
 *   a) `checkout_info` / `sanitary_warning` : la plateforme n'affiche
 *      AUCUN texte équivalent aujourd'hui. Inventer un défaut
 *      reviendrait à faire tenir à Scanym un propos sanitaire ou
 *      commercial au nom du commerçant. Défaut = ABSENCE : rien n'est
 *      rendu, et la compatibilité arrière est exacte (mandat §G).
 *   b) `order_success_body` / `email_confirmation_subject` /
 *      `email_confirmation_body` / `confirmation_withdrawal_request` :
 *      un texte de base EXISTE déjà mais il est CONDITIONNEL (WhatsApp
 *      activé ou non) ou assemblé par un gabarit (sujet e-mail avec
 *      `{merchant}`/`{n}`). Le remplacer par une clé unique ici
 *      effacerait silencieusement cette condition -- notamment la
 *      mention de transmission des données. L'appelant fournit donc le
 *      texte de base EXPLICITEMENT (`resolveCommunicationText(...,
 *      explicitBase)`), ce qui préserve exactement le comportement
 *      actuel quand aucune surcharge n'existe.
 *
 * Dans les deux cas l'absence de configuration ne vaut JAMAIS
 * permission d'afficher autre chose : elle vaut « comportement actuel ».
 */
export const COMMUNICATION_TEXT_SPEC: Record<
  CommunicationTextKey,
  CommunicationTextSpec
> = {
  // THEME & CONTENT SETTINGS v1 -- ADDITIFS (défaut = absence) : la
  // plateforme n'affiche aujourd'hui AUCUNE aide « comment commander ».
  // Inventer un texte par défaut reviendrait à faire tenir à Scanym un
  // propos de parcours au nom du commerçant -- et Scanym ne code pas en
  // dur le texte d'un commerçant (« NO HARDCODED AU LAIT CRU TEXT »).
  // Bouton ABSENT tant que son libellé ET son contenu ne sont pas saisis.
  order_help_button_label: {
    maxLength: COMMUNICATION_ORDER_HELP_LABEL_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: null,
  },
  order_help_title: {
    maxLength: COMMUNICATION_ORDER_HELP_TITLE_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: null,
  },
  order_help_body: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: null,
  },
  checkout_info: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: null,
  },
  pickup_explanation: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    // Existant : « Nous vous confirmons l'heure et le lieu de retrait
    // par message. » (lib/i18n.ts::pickupNote)
    defaultI18nKey: "pickupNote",
  },
  delivery_local_explanation: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    // Existant : « Nous vous confirmons le créneau de livraison par
    // message. » (lib/i18n.ts::deliveryNote)
    defaultI18nKey: "deliveryNote",
  },
  delivery_carrier_explanation: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    // Existant, neutre : « Livraison possible. »
    defaultI18nKey: "deliveryEligibleDefault",
  },
  slot_warning: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    // Existant : l'avertissement « c'est une demande, pas un créneau
    // garanti » (lib/i18n.ts::deliveryTimingNoticeNotesHint).
    defaultI18nKey: "deliveryTimingNoticeNotesHint",
  },
  sanitary_warning: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: null,
  },
  order_success_title: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    // Existant : « Commande envoyée avec succès ! »
    defaultI18nKey: "confirmTitle",
  },
  order_success_body: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: null,
  },
  confirmation_pickup: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: "confirmPickupTime",
  },
  confirmation_delivery_local: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: "confirmDeliveryTime",
  },
  confirmation_delivery_carrier: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: true,
    defaultI18nKey: "commCarrierPreparedDefault",
  },
  email_confirmation_subject: {
    maxLength: COMMUNICATION_SUBJECT_MAX_LENGTH,
    publicProjection: false,
    defaultI18nKey: null,
  },
  email_confirmation_body: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: false,
    defaultI18nKey: null,
  },
  confirmation_withdrawal_request: {
    maxLength: COMMUNICATION_TEXT_MAX_LENGTH,
    publicProjection: false,
    defaultI18nKey: null,
  },
};

/** Sous-ensemble exposé à la projection publique anonyme. Dérivé, jamais
 *  réécrit : ajouter une clé au spec suffit. */
export const PUBLIC_COMMUNICATION_TEXT_KEYS: readonly CommunicationTextKey[] =
  COMMUNICATION_TEXT_KEYS.filter(
    (key) => COMMUNICATION_TEXT_SPEC[key].publicProjection
  );

/** Garde de type -- une chaîne quelconque n'est un emplacement que si
 *  elle figure dans le catalogue fermé. */
export function isCommunicationTextKey(
  value: unknown
): value is CommunicationTextKey {
  return (
    typeof value === "string" &&
    (COMMUNICATION_TEXT_KEYS as readonly string[]).includes(value)
  );
}

/** Longueur maximale applicable à un emplacement donné. */
export function communicationTextMaxLength(key: CommunicationTextKey): number {
  return COMMUNICATION_TEXT_SPEC[key].maxLength;
}

export type CommunicationTextOverrides = Partial<
  Record<CommunicationTextKey, string | null | undefined>
>;

/**
 * Normalise UNE surcharge pour UN emplacement : `undefined` quand elle
 * est absente, vide, uniquement composée de blancs, ou plus longue que
 * la limite propre à cet emplacement.
 *
 * Ne tronque JAMAIS : une surcharge trop longue est traitée comme
 * ABSENTE (repli sur le comportement actuel, toujours correct) plutôt
 * que coupée au milieu d'une phrase -- décision identique à
 * `normalizeMerchantStatusText`. L'écriture est de toute façon refusée
 * en amont par la contrainte SQL et par le RPC : ce cas ne peut provenir
 * que d'une donnée antérieure à la contrainte.
 */
export function normalizeCommunicationText(
  key: CommunicationTextKey,
  raw: string | null | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > communicationTextMaxLength(key)) return undefined;
  return trimmed;
}

/**
 * Filtre une configuration marchande BRUTE (telle que lue en base ou
 * reçue d'un formulaire) vers des surcharges sûres :
 *
 *   - toute clé hors catalogue est IGNORÉE (un commerçant ne peut pas
 *     introduire un nouvel emplacement par ce chemin) ;
 *   - toute valeur vide/blanche/trop longue est ignorée ;
 *   - seules les propriétés PROPRES sont lues (jamais la chaîne de
 *     prototypes) ;
 *   - l'entrée n'est jamais modifiée.
 */
export function sanitizeCommunicationTextOverrides(
  raw: Readonly<Record<string, unknown>> | null | undefined
): CommunicationTextOverrides {
  const safe: CommunicationTextOverrides = {};
  if (!raw || typeof raw !== "object") return safe;
  for (const key of COMMUNICATION_TEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const normalized = normalizeCommunicationText(
      key,
      raw[key] as string | null | undefined
    );
    if (normalized !== undefined) safe[key] = normalized;
  }
  return safe;
}

/**
 * Lit une projection publique `[{ text_key, body }]` (sortie du RPC
 * anonyme) vers des surcharges sûres. Les lignes dont la clé n'est pas
 * exposée publiquement sont ignorées MÊME si le serveur en renvoyait une
 * -- défense en profondeur sur la frontière, pas seulement en SQL.
 */
export function overridesFromPublicProjection(
  rows: ReadonlyArray<{ text_key?: unknown; body?: unknown }> | null | undefined
): CommunicationTextOverrides {
  const safe: CommunicationTextOverrides = {};
  if (!Array.isArray(rows)) return safe;
  for (const row of rows) {
    const key = row?.text_key;
    if (!isCommunicationTextKey(key)) continue;
    if (!COMMUNICATION_TEXT_SPEC[key].publicProjection) continue;
    const normalized = normalizeCommunicationText(
      key,
      row?.body as string | null | undefined
    );
    if (normalized !== undefined) safe[key] = normalized;
  }
  return safe;
}
