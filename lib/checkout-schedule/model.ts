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
  | { kind: "unreadable"; reason: UnreadableReason };

/**
 * POURQUOI une réponse du serveur est inexploitable (le client l'explique,
 * il ne devine jamais) :
 *  - `response`  : statut ou structure inconnus / incomplets ;
 *  - `ambiguous` : deux créneaux (ou dates) de même clé, ou deux fenêtres qui
 *                  se chevauchent -- le choix du client ne désignerait pas
 *                  UN créneau précis ;
 *  - `date`      : date impossible dans le calendrier (ex. 2026-02-31) ;
 *  - `interval`  : fin d'un intervalle antérieure ou égale à son début ;
 *  - `policy`    : politique de date ou de créneau inconnue, absente ou
 *                  incompatible avec la dérivation de la date.
 */
export type UnreadableReason = "response" | "ambiguous" | "date" | "interval" | "policy";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Date de calendrier RÉELLE au format strict `YYYY-MM-DD`. Une date
 * impossible (2026-02-31, 2026-04-31, 2025-02-29, mois 13, jour 00) est
 * REFUSÉE, jamais normalisée en une autre date.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

function timeToMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * Le choix du client doit désigner UNE offre :
 *  - `fixed_slots` : deux offres de même `slot_key` le même jour = ambigu
 *    (le client verrait deux créneaux, le payload n'en porterait qu'un) ;
 *  - `time_within_window` : deux fenêtres qui se chevauchent le même jour
 *    = une heure pourrait appartenir à deux fins de fenêtre différentes.
 */
function hasAmbiguousOffers(offers: CheckoutScheduleOffer[], slotMode: SlotMode): boolean {
  if (slotMode === "fixed_slots") {
    const keys = offers.map((o) => o.slotKey);
    return new Set(keys).size !== keys.length;
  }
  if (slotMode === "time_within_window") {
    const sorted = offers
      .map((o) => [timeToMinutes(o.startsAt), timeToMinutes(o.endsAt)] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i][0] < sorted[i - 1][1]) return true;
    }
  }
  return false;
}

export function isStrictTime(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

/**
 * Offre « date seule » (politique de créneau `none`) bien formée : heures
 * strictes HH:MM, fin strictement après le début, pas de clé de créneau.
 */
function isWellFormedDateOnlyOffer(o: CheckoutScheduleOffer): boolean {
  return (
    o !== null &&
    typeof o === "object" &&
    o.slotKey === null &&
    isStrictTime(o.startsAt) &&
    isStrictTime(o.endsAt) &&
    timeToMinutes(o.startsAt) < timeToMinutes(o.endsAt)
  );
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
      return { kind: "unreadable", reason: "response" };
  }

  // ── Cohérence de la réponse, AVANT toute politique : une réponse qui se
  // contredit n'est pas une disponibilité (aucune normalisation, aucune
  // correction, aucune date inventée).
  if (view.eligibleDates.length === 0) {
    return { kind: "unreadable", reason: "response" };
  }
  // Dates : calendrier réel, y compris les clés d'offres et la première date.
  if (
    !view.eligibleDates.every(isIsoDate) ||
    !Object.keys(view.offers).every(isIsoDate) ||
    (view.firstEligibleDate !== null && !isIsoDate(view.firstEligibleDate))
  ) {
    return { kind: "unreadable", reason: "date" };
  }
  // Intervalles : toute offre fournie doit avoir une fin STRICTEMENT après son début.
  for (const list of Object.values(view.offers)) {
    for (const o of Array.isArray(list) ? list : []) {
      if (isStrictTime(o.startsAt) && isStrictTime(o.endsAt) && !(timeToMinutes(o.startsAt) < timeToMinutes(o.endsAt))) {
        return { kind: "unreadable", reason: "interval" };
      }
    }
  }
  // Ambiguïté : une date ne figure qu'une fois.
  if (new Set(view.eligibleDates).size !== view.eligibleDates.length) {
    return { kind: "unreadable", reason: "ambiguous" };
  }

  if (view.dateSelectionMode === "derived_earliest") {
    const date = view.firstEligibleDate;
    if (!isIsoDate(date) || !view.eligibleDates.includes(date)) {
      return { kind: "unreadable", reason: "response" };
    }
    // Le serveur dérive la date ET aucun créneau n'est à choisir (contrat
    // v1.2 §5.1 : date seule). Une politique de créneau inconnue, absente ou
    // qui demanderait un choix n'a aucun comportement défini : on ne devine pas.
    if (view.slotSelectionMode !== "none") {
      return { kind: "unreadable", reason: "policy" };
    }
    // CSDJ2-R3-01 : une date dérivée n'est une DISPONIBILITÉ que si le serveur
    // a rendu, pour CETTE date, au moins une offre bien formée (le lecteur
    // exclut une journée sans offre et émet des heures HH:MM). Réponse sans
    // offre, offre mal formée (heure hors format, secondes, vide, clé de
    // créneau alors que la politique est « none ») : on n'envoie PAS une
    // commande date seule sur une réponse qui se contredit. Les bornes strictes
    // inversées sont déjà refusées plus haut (`interval`).
    const derivedOffers = offersOf(view, date);
    if (derivedOffers.length === 0) {
      return { kind: "unreadable", reason: "response" };
    }
    // Toute offre fournie, pour n'importe quelle date, doit être bien formée.
    for (const list of Object.values(view.offers)) {
      if (!Array.isArray(list) || !list.every(isWellFormedDateOnlyOffer)) {
        return { kind: "unreadable", reason: "response" };
      }
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
      if (!coherent) return { kind: "unreadable", reason: "response" };
      if (slotMode === "time_within_window") {
        const g = view.timeGranularityMinutes;
        if (typeof g !== "number" || !Number.isInteger(g) || g <= 0) {
          return { kind: "unreadable", reason: "policy" };
        }
      }
      // Ambiguïté : le choix du client doit désigner UNE offre.
      if (view.eligibleDates.some((d) => hasAmbiguousOffers(offersOf(view, d), slotMode))) {
        return { kind: "unreadable", reason: "ambiguous" };
      }
      return { kind: "choose", slotMode };
    }
    return { kind: "unreadable", reason: "policy" };
  }

  // `informational_only` en date mais statut `dates_available`, ou valeur
  // inconnue / absente : on ne devine pas.
  return { kind: "unreadable", reason: "policy" };
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
        offers.filter((o) => o.slotKey === slotKey).length === 1
      );
    case "time_within_window": {
      if (slotKey !== null || time === null) return false;
      const g = view.timeGranularityMinutes;
      if (g === null) return false;
      return offers.filter((o) => windowTimes(o, g).includes(time)).length === 1;
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
      // Exactement UNE offre : jamais « la première » d'un doublon.
      const matches = offers.filter((o) => o.slotKey === selection.slotKey);
      if (matches.length !== 1) return null;
      const offer = matches[0];
      return {
        date,
        slot_key: offer.slotKey,
        starts_at: offer.startsAt,
        ends_at: offer.endsAt,
      };
    }
    case "time_within_window": {
      const g = view.timeGranularityMinutes as number;
      const matches = offers.filter((o) => windowTimes(o, g).includes(selection.time as string));
      if (matches.length !== 1) return null;
      const offer = matches[0];
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
  // Pas de vue = état du calendrier INCONNU : on ne laisse rien partir
  // (fail-closed, audit de la PR #160).
  if (view === null) return false;
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
