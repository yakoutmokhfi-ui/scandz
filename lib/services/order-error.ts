/**
 * Classification de l'erreur "note trop longue" (V65) — fonction pure,
 * sans dépendance Supabase, pour rester testable par `npm test` sans
 * variables d'environnement.
 *
 * Extraite de lib/services/orders.ts après audit : la version
 * précédente acceptait `error.code === "22001"` seule (avec un `||`),
 * ce qui aurait requalifié en "note trop longue" n'importe quelle
 * erreur PostgreSQL 22001 sans rapport avec la note (toute autre
 * colonne trop longue pour son domaine partage ce même SQLSTATE).
 * La classification exige maintenant le COUPLE code ET message.
 */

/** Code d'erreur stable renvoyé par create_order (V65) quand la note dépasse la limite. */
export const ORDER_NOTE_TOO_LONG_CODE = "SCANYM_ORDER_NOTE_TOO_LONG";

/** Erreur reconnaissable levée quand le serveur rejette la note (>500 caractères). */
export class OrderNoteTooLongError extends Error {
  constructor() {
    super(ORDER_NOTE_TOO_LONG_CODE);
    this.name = "OrderNoteTooLongError";
  }
}

/** Sous-ensemble de PostgrestError utile ici, pour rester testable sans importer @supabase/supabase-js. */
export interface RpcErrorLike {
  message?: string | null;
  code?: string | null;
}

/**
 * true seulement si le SQLSTATE ET le message correspondent tous les
 * deux à l'erreur "note trop longue" de create_order. Un message
 * SCANYM_ORDER_NOTE_TOO_LONG avec un autre SQLSTATE, ou un SQLSTATE
 * 22001 avec un autre message, ne sont PAS classés comme "note trop
 * longue" — ils restent des erreurs génériques (orderFailed).
 */
export function isOrderNoteTooLongError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "22001" && error.message === ORDER_NOTE_TOO_LONG_CODE;
}

/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1 -- classification des deux
 * erreurs déterministes levées par create_order quand le marchand est
 * CGV_ACTIVE (voir DRAFT-lot-seller-legal-profile-cgv-engine-v1.sql,
 * section M). Même discipline que ci-dessus : code ET message exigés
 * ensemble, jamais le code seul (P0001 est le SQLSTATE générique de
 * `raise exception`, partagé par de nombreuses erreurs applicatives
 * sans rapport avec la CGV).
 */
export const CGV_ACCEPTANCE_REQUIRED_CODE = "CGV_ACCEPTANCE_REQUIRED";
export const CGV_NOT_PUBLISHED_CODE = "CGV_REQUIRED_BUT_NOT_PUBLISHED";

export class CgvAcceptanceRequiredError extends Error {
  constructor() {
    super(CGV_ACCEPTANCE_REQUIRED_CODE);
    this.name = "CgvAcceptanceRequiredError";
  }
}

export function isCgvAcceptanceRequiredError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "P0001" && error.message === CGV_ACCEPTANCE_REQUIRED_CODE;
}

export function isCgvNotPublishedError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error) return false;
  return error.code === "P0001" && error.message === CGV_NOT_PUBLISHED_CODE;
}

/**
 * CSDJ-2 / issue #158 -- erreurs TYPÉES de sélection de date/créneau
 * levées par `create_order` (contrat CSDJ v1.2, §10).
 *
 * Porteur : `RAISE EXCEPTION` SQLSTATE `P0001` dont le message est EXACTEMENT
 * le code typé. Même discipline que ci-dessus : le COUPLE code ET message
 * est exigé, jamais le message seul (P0001 est le SQLSTATE générique de
 * `raise exception`).
 *
 * Classes (ce que le parcours doit faire) :
 *  - `choose`   : le client n'a rien choisi -> demander de choisir ;
 *  - `reselect` : la sélection envoyée est mal formée -> redemander ;
 *  - `refresh`  : ce que le client a vu n'est plus offert (date expirée,
 *                 créneau retiré ou plein, politique changée) -> RELIRE les
 *                 disponibilités, vider la sélection, redemander. Le texte
 *                 client est générique : aucune raison ni capacité n'est
 *                 divulguée.
 */
export const SCHEDULE_ORDER_ERROR_CLASSES = {
  SCANYM_SCHEDULE_REQUIRED: "choose",
  SCANYM_SCHEDULE_MALFORMED: "reselect",
  SCANYM_SCHEDULE_UNFULFILLABLE: "refresh",
  SCANYM_SCHEDULE_NOT_SELECTABLE: "refresh",
  SCANYM_SCHEDULE_NOT_OFFERED: "refresh",
  SCANYM_SCHEDULE_DATE_NOT_ELIGIBLE: "refresh",
  SCANYM_SCHEDULE_SLOT_INVALID: "refresh",
  SCANYM_SCHEDULE_TIME_INVALID: "refresh",
  SCANYM_SCHEDULE_SLOT_FULL: "refresh",
} as const;

export type ScheduleOrderErrorCode = keyof typeof SCHEDULE_ORDER_ERROR_CLASSES;
export type ScheduleOrderErrorClass =
  (typeof SCHEDULE_ORDER_ERROR_CLASSES)[ScheduleOrderErrorCode];

/** Le code typé de sélection, ou `null` si l'erreur n'en est pas une. */
export function scheduleOrderErrorCode(
  error: RpcErrorLike | null | undefined
): ScheduleOrderErrorCode | null {
  if (!error || error.code !== "P0001") return null;
  const message = error.message;
  if (typeof message !== "string") return null;
  return Object.prototype.hasOwnProperty.call(SCHEDULE_ORDER_ERROR_CLASSES, message)
    ? (message as ScheduleOrderErrorCode)
    : null;
}

/** Erreur reconnaissable levée quand le serveur refuse la sélection de date/créneau. */
export class ScheduleSelectionError extends Error {
  readonly code: ScheduleOrderErrorCode;
  readonly kind: ScheduleOrderErrorClass;
  constructor(code: ScheduleOrderErrorCode) {
    super(code);
    this.name = "ScheduleSelectionError";
    this.code = code;
    this.kind = SCHEDULE_ORDER_ERROR_CLASSES[code];
  }
}

/**
 * Issue #200 -- article (ou option) devenu indisponible entre le chargement
 * de la vitrine et l'envoi de la commande. `create_order` lève
 * `RAISE EXCEPTION 'Article indisponible ou étranger à ce restaurant …'`
 * (SQLSTATE P0001) ou `'Option invalide pour …'`. Même discipline : code ET
 * début de message exigés ensemble. Le texte client est générique : aucun
 * identifiant interne n'est jamais affiché.
 */
export const ITEM_UNAVAILABLE_MESSAGE_PREFIXES = [
  "Article indisponible ou étranger à ce restaurant",
  "Option invalide pour",
] as const;

export class ItemUnavailableError extends Error {
  constructor() {
    super("SCANYM_ITEM_UNAVAILABLE");
    this.name = "ItemUnavailableError";
  }
}

export function isItemUnavailableError(
  error: RpcErrorLike | null | undefined
): boolean {
  if (!error || error.code !== "P0001") return false;
  const message = error.message;
  if (typeof message !== "string") return false;
  return ITEM_UNAVAILABLE_MESSAGE_PREFIXES.some((p) => message.startsWith(p));
}
