/**
 * Scanym — CSDJ-2 / issue #158 — SÉLECTION DE DATE ET DE CRÉNEAU AU
 * CHECKOUT (modèle PUR).
 *
 * Ce module ne lit rien, n'écrit rien, ne calcule AUCUNE éligibilité.
 * Il fait trois choses, et seulement trois :
 *
 *   1. dire, à partir de ce que le SERVEUR a rendu
 *      (`get_checkout_fulfillment_schedule`), ce que le parcours doit
 *      demander au client (`scheduleRequirement`) ;
 *   2. dire si la sélection du client est une sélection que le serveur
 *      a PROPOSÉE (`isSelectionOffered`) -- le client ne peut jamais
 *      saisir une date ou un créneau libre ;
 *   3. fabriquer la valeur de `p_customer.schedule`
 *      (`toSchedulePayload`), dans le format documenté par le contrat
 *      CSDJ v1.2 (§5.1) :
 *
 *        { "date": "YYYY-MM-DD", "slot_key": null|"…",
 *          "starts_at": null|"HH:MM", "ends_at": null|"HH:MM" }
 *
 * LE SERVEUR RESTE L'AUTORITÉ. `create_order` revalide tout (date,
 * créneau, heure, coupure, fermetures, capacité) ; ce que ce module
 * valide n'est qu'un confort d'interface, jamais une autorisation.
 * Les dates ne sont JAMAIS recalculées ici : elles viennent du serveur,
 * dans le fuseau du commerçant, depuis l'horloge du serveur.
 */
import {
  formatScheduleTime,
  parseScheduleTime,
} from "@/lib/scheduling/schedule-model";

/** Une offre rendue par le serveur pour UNE date. */
export interface CheckoutScheduleOffer {
  slotKey: string | null;
  /** HH:MM, heure murale du commerçant. */
  startsAt: string;
  /** HH:MM, heure murale du commerçant. */
  endsAt: string;
}

/** Ce que le serveur a rendu pour une portée (mode, ou règle de livraison). */
export interface CheckoutScheduleView {
  status: string;
  unfulfillableReason: string | null;
  timezone: string | null;
  dateSelectionMode: string | null;
  slotSelectionMode: string | null;
  timeGranularityMinutes: number | null;
  firstEligibleDate: string | null;
  eligibleDates: string[];
  offers: Record<string, CheckoutScheduleOffer[]>;
}

/** La sélection du client : toujours piochée dans ce que le serveur propose. */
export interface ScheduleSelection {
  date: string | null;
  slotKey: string | null;
  /** HH:MM, uniquement pour `time_within_window`. */
  time: string | null;
}

export const EMPTY_SCHEDULE_SELECTION: ScheduleSelection = {
  date: null,
  slotKey: null,
  time: null,
};

/** Format exact de `p_customer.schedule` (contrat CSDJ v1.2, §5.1). */
export interface SchedulePayload {
  date: string;
  slot_key: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

export type SlotMode = "none" | "fixed_slots" | "time_within_window";

/**
 * Ce que le parcours doit faire pour cette portée.
 *
 *  - `none`      : rien à demander, rien à envoyer (planification
 *                  absente/désactivée, ou information seule). C'est
 *                  l'état de tous les commerçants sans calendrier : le
 *                  parcours reste EXACTEMENT ce qu'il était.
 *  - `blocked`   : un calendrier est configuré ET sa politique exige une
 *                  date, mais le serveur n'en propose aucune
 *                  (« unfulfillable »). Décision du CIO : échec CLAIR,
 *                  jamais une date inventée.
 *  - `derived`   : le serveur dérive la date (`derived_earliest`) ; le
 *                  client ne choisit pas, il rappelle la date affichée.
 *  - `choose`    : le client choisit parmi les offres du serveur.
 *  - `unreadable`: statut ou politique inconnus (version future, réponse
 *                  incohérente) : on ne devine pas, fail-closed.
 */
export type ScheduleRequirement =
  | { kind: "none" }
  | { kind: "blocked"; reason: string | null }
  | { kind: "derived"; date: string }
  | { kind: "choose"; slotMode: SlotMode }
  | { kind: "unreadable" };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value);
}

export function isStrictTime(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

function offersOf(view: CheckoutScheduleView, date: string): CheckoutScheduleOffer[] {
  const list = view.offers[date];
  return Array.isArray(list) ? list : [];
}

export function scheduleRequirement(view: CheckoutScheduleView): ScheduleRequirement {
  switch (view.status) {
    // Aucune planification (ou désactivée, ou mode désactivé : le serveur
    // rend la même réponse, volontairement), ou politique d'information
    // seule : rien à choisir, rien à envoyer.
    case "absent":
    case "informational_only":
      return { kind: "none" };
    // Livraison refusée EN AMONT (hors zone, minimum d'articles, code
    // postal absent) : le motif appartient au moteur de livraison, qui a
    // déjà son propre affichage. La planification n'ajoute aucun blocage.
    case "blocked_upstream":
      return { kind: "none" };
    case "unfulfillable":
      return { kind: "blocked", reason: view.unfulfillableReason };
    case "dates_available":
      break;
    default:
      return { kind: "unreadable" };
  }

  if (view.eligibleDates.length === 0 || !view.eligibleDates.every(isIsoDate)) {
    return { kind: "unreadable" };
  }

  if (view.dateSelectionMode === "derived_earliest") {
    const date = view.firstEligibleDate;
    if (!isIsoDate(date) || !view.eligibleDates.includes(date)) {
      return { kind: "unreadable" };
    }
    return { kind: "derived", date };
  }

  if (view.dateSelectionMode === "customer_selectable") {
    const slotMode = view.slotSelectionMode;
    if (
      slotMode === "none" ||
      slotMode === "fixed_slots" ||
      slotMode === "time_within_window"
    ) {
      // Chaque date proposée doit porter au moins une offre bien formée :
      // une date sans heure ne se propose pas.
      const coherent = view.eligibleDates.every((d) => {
        const offers = offersOf(view, d);
        if (offers.length === 0) return false;
        return offers.every(
          (o) =>
            isStrictTime(o.startsAt) &&
            isStrictTime(o.endsAt) &&
            (slotMode === "fixed_slots"
              ? typeof o.slotKey === "string" && o.slotKey.length > 0
              : o.slotKey === null)
        );
      });
      if (!coherent) return { kind: "unreadable" };
      if (slotMode === "time_within_window") {
        const g = view.timeGranularityMinutes;
        if (typeof g !== "number" || !Number.isInteger(g) || g <= 0) {
          return { kind: "unreadable" };
        }
      }
      return { kind: "choose", slotMode };
    }
    return { kind: "unreadable" };
  }

  // `informational_only` en date mais statut `dates_available`, ou valeur
  // inconnue : on ne devine pas.
  return { kind: "unreadable" };
}

/**
 * Heures proposées pour une fenêtre (`time_within_window`) : de
 * `starts_at` (première heure RÉALISABLE rendue par le serveur) jusqu'à
 * `ends_at` exclu, au pas de granularité du commerçant. Seule dérivation
 * d'affichage de ce module ; le serveur revalide l'heure choisie.
 */
export function windowTimes(
  offer: CheckoutScheduleOffer,
  granularityMinutes: number
): string[] {
  const start = parseScheduleTime(offer.startsAt);
  const end = parseScheduleTime(offer.endsAt);
  if (start === null || end === null || granularityMinutes <= 0) return [];
  const times: string[] = [];
  for (let t = start; t < end; t += granularityMinutes) {
    times.push(formatScheduleTime(t));
  }
  return times;
}

/** Dates que le client peut choisir (jamais d'autres que celles du serveur). */
export function selectableDates(
  view: CheckoutScheduleView,
  requirement: ScheduleRequirement
): string[] {
  return requirement.kind === "choose" ? view.eligibleDates : [];
}

/** Les offres du serveur pour la date choisie. */
export function offersForDate(
  view: CheckoutScheduleView,
  date: string | null
): CheckoutScheduleOffer[] {
  return date === null ? [] : offersOf(view, date);
}

/**
 * La sélection est-elle une sélection COMPLÈTE que le serveur a
 * proposée ? Pour `derived`/`none`, il n'y a rien à choisir.
 */
export function isSelectionOffered(
  view: CheckoutScheduleView,
  requirement: ScheduleRequirement,
  selection: ScheduleSelection
): boolean {
  if (requirement.kind === "none" || requirement.kind === "derived") return true;
  if (requirement.kind !== "choose") return false;
  const { date, slotKey, time } = selection;
  if (date === null || !view.eligibleDates.includes(date)) return false;
  const offers = offersOf(view, date);
  switch (requirement.slotMode) {
    case "none":
      return slotKey === null && time === null;
    case "fixed_slots":
      return (
        time === null &&
        slotKey !== null &&
        offers.some((o) => o.slotKey === slotKey)
      );
    case "time_within_window": {
      if (slotKey !== null || time === null) return false;
      const g = view.timeGranularityMinutes;
      if (g === null) return false;
      return offers.some((o) => windowTimes(o, g).includes(time));
    }
  }
}

/**
 * Valeur de `p_customer.schedule`, ou `null` quand il ne faut RIEN
 * envoyer (`none`) ou quand la sélection n'est pas valide (l'appelant ne
 * doit alors pas soumettre).
 */
export function toSchedulePayload(
  view: CheckoutScheduleView,
  requirement: ScheduleRequirement,
  selection: ScheduleSelection
): SchedulePayload | null {
  if (requirement.kind === "none") return null;
  if (requirement.kind === "derived") {
    return { date: requirement.date, slot_key: null, starts_at: null, ends_at: null };
  }
  if (requirement.kind !== "choose") return null;
  if (!isSelectionOffered(view, requirement, selection)) return null;
  const date = selection.date as string;
  const offers = offersOf(view, date);
  switch (requirement.slotMode) {
    case "none":
      return { date, slot_key: null, starts_at: null, ends_at: null };
    case "fixed_slots": {
      const offer = offers.find((o) => o.slotKey === selection.slotKey);
      if (!offer) return null;
      return {
        date,
        slot_key: offer.slotKey,
        starts_at: offer.startsAt,
        ends_at: offer.endsAt,
      };
    }
    case "time_within_window": {
      const g = view.timeGranularityMinutes as number;
      const offer = offers.find((o) => windowTimes(o, g).includes(selection.time as string));
      if (!offer) return null;
      return {
        date,
        slot_key: null,
        starts_at: selection.time as string,
        ends_at: offer.endsAt,
      };
    }
  }
}

/**
 * Garde la sélection si le serveur la propose encore, sinon la vide
 * (relecture des disponibilités après une date expirée, un changement de
 * mode, un changement de panier...). Jamais de sélection fantôme.
 */
export function reconcileSelection(
  view: CheckoutScheduleView | null,
  selection: ScheduleSelection
): ScheduleSelection {
  if (view === null) return EMPTY_SCHEDULE_SELECTION;
  const requirement = scheduleRequirement(view);
  if (requirement.kind !== "choose") return EMPTY_SCHEDULE_SELECTION;
  if (isSelectionOffered(view, requirement, selection)) return selection;
  // La date peut rester valable alors que le créneau a disparu.
  if (selection.date !== null && view.eligibleDates.includes(selection.date)) {
    return { date: selection.date, slotKey: null, time: null };
  }
  return EMPTY_SCHEDULE_SELECTION;
}

/**
 * Le client peut-il envoyer la commande, du point de vue du calendrier ?
 * (`unreadable` et `blocked` ferment l'envoi ; `choose` exige une
 * sélection complète ; le reste ne demande rien.)
 */
export function scheduleAllowsSubmit(
  view: CheckoutScheduleView | null,
  selection: ScheduleSelection
): boolean {
  if (view === null) return true;
  const requirement = scheduleRequirement(view);
  switch (requirement.kind) {
    case "none":
    case "derived":
      return true;
    case "blocked":
    case "unreadable":
      return false;
    case "choose":
      return isSelectionOffered(view, requirement, selection);
  }
}
