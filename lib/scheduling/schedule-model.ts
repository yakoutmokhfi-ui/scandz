/**
 * Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)
 * CATALOGUES FERMÉS du modèle de planification marchande.
 *
 * Logique PURE. Ce module ne lit rien, n'écrit rien, ne décide d'aucune
 * éligibilité : il NOMME les valeurs admissibles et dit, pour une valeur
 * inconnue, qu'elle est inconnue.
 *
 * ──────────────────────────────────────────────────────────────────────
 * MIROIR SQL. Chaque catalogue ci-dessous a une fonction immuable
 * homologue dans supabase/DRAFT-lot-checkout-scheduling-foundation-v1.sql
 * (`public.checkout_date_selection_modes()`, etc.). Les deux listes
 * doivent dire la même chose, dans le MÊME ORDRE, et c'est
 * tests/csdj1-sql-structural.test.ts qui le prouve caractère par
 * caractère -- pas une relecture attentive. La dérive entre un catalogue
 * SQL et son miroir TypeScript est SILENCIEUSE : rien ne casse, une
 * valeur cesse simplement d'être acceptée d'un côté.
 * ──────────────────────────────────────────────────────────────────────
 *
 * CE MODULE N'INVENTE AUCUNE DATE. Il ne contient ni calendrier de jours
 * fériés, ni délai par défaut, ni « J+2 ». Toute valeur métier vient de
 * la configuration du commerçant (mandat §C/§F, littéral : « Do NOT
 * invent J+2 or J+3 »).
 */

/**
 * ═══ POLITIQUE DE SÉLECTION DE DATE ═══
 *
 * Qui décide de la date, et avec quelle liberté.
 *
 *   - `customer_selectable`  : le client choisit parmi les dates que le
 *                              SERVEUR a déclarées éligibles ;
 *   - `derived_earliest`     : le serveur dérive UNE date -- la première
 *                              réellement éligible -- et le client ne
 *                              choisit pas. Exige que les paramètres de
 *                              dérivation soient configurés ; sans eux,
 *                              rien n'est dérivé et le lot refuse plutôt
 *                              que de deviner ;
 *   - `informational_only`   : aucune date n'est ni choisie ni dérivée.
 *                              Seule la formulation du commerçant est
 *                              montrée. C'est le cas du transporteur qui
 *                              ne sait pas s'engager (mandat §F).
 */
export const CHECKOUT_DATE_SELECTION_MODES = [
  "customer_selectable",
  "derived_earliest",
  "informational_only",
] as const;

export type CheckoutDateSelectionMode =
  (typeof CHECKOUT_DATE_SELECTION_MODES)[number];

/**
 * ═══ POLITIQUE DE SÉLECTION D'HORAIRE ═══
 *
 *   - `none`               : la date seule est sélectionnée (ou aucune) ;
 *   - `time_within_window` : le client choisit une HEURE à l'intérieur
 *                            d'une fenêtre d'ouverture, sur une grille
 *                            de granularité configurée. Les FENÊTRES
 *                            sont alors l'autorité ;
 *   - `fixed_slots`        : le client choisit un CRÉNEAU nommé parmi
 *                            ceux que le commerçant a déclarés. Les
 *                            CRÉNEAUX sont alors l'autorité.
 *
 * ═══ CSDJ-V1-SINGLE-OFFER-AUTHORITY-01 ═══
 *
 * Une seule des deux tables fait foi à la fois, et c'est la politique
 * qui dit laquelle. `time_within_window` ignore les créneaux ;
 * `fixed_slots` ignore les fenêtres. Les faire cohabiter créerait deux
 * autorités capables de se contredire sur le même jour -- exactement le
 * genre de contradiction qu'aucune relecture ne rattrape.
 */
export const CHECKOUT_SLOT_SELECTION_MODES = [
  "none",
  "time_within_window",
  "fixed_slots",
] as const;

export type CheckoutSlotSelectionMode =
  (typeof CHECKOUT_SLOT_SELECTION_MODES)[number];

/**
 * ═══ STATUT RENDU PAR L'AUTORITÉ SERVEUR ═══
 *
 *   - `absent`           : aucune planification n'est configurée pour
 *                          cette portée, OU elle est désactivée. Ce
 *                          N'EST PAS une erreur : c'est l'état de tous
 *                          les commerçants existants, et il doit rendre
 *                          le parcours EXACTEMENT tel qu'avant ce lot
 *                          (CSDJ-V1-SCHEDULE-ABSENT-01) ;
 *   - `blocked_upstream` : la demande n'a pas atteint la planification --
 *                          la livraison elle-même est refusée en amont
 *                          (hors zone, minimum d'articles, code postal
 *                          absent). Le motif appartient au moteur de
 *                          livraison existant, pas à ce lot ;
 *   - `informational_only` : politique assumée, aucune date à montrer ;
 *   - `dates_available` : au moins une date est éligible ; elles sont
 *                          toutes énumérées, le client ne peut donc pas
 *                          en proposer une autre ;
 *   - `unfulfillable`   : une planification est configurée ET activée,
 *                          sa politique EXIGE une date, et il n'en
 *                          existe aucune. Décision du CIO, littérale :
 *                          « A schedule configured but impossible to
 *                          fulfill must fail clearly. It must NEVER
 *                          silently fall back to an invented date. »
 *                          (CSDJ-V1-UNFULFILLABLE-EXPLICIT-01)
 */
export const CHECKOUT_SCHEDULE_STATUSES = [
  "absent",
  "blocked_upstream",
  "informational_only",
  "dates_available",
  "unfulfillable",
] as const;

export type CheckoutScheduleStatus =
  (typeof CHECKOUT_SCHEDULE_STATUSES)[number];

/**
 * ═══ MOTIFS D'INFAISABILITÉ ═══
 *
 * Catalogue FERMÉ. Un statut `unfulfillable` porte toujours exactement
 * un de ces motifs -- jamais `null`, jamais une chaîne libre : un refus
 * dont on ne sait pas dire la cause est un refus qu'on ne saura pas
 * corriger.
 *
 *   - `no_offer_configured`  : la politique exige une offre (fenêtre ou
 *                              créneau selon le cas) et aucune n'existe ;
 *   - `granularity_missing`  : `time_within_window` sans granularité ;
 *   - `all_dates_closed`     : des offres existent, mais chaque date de
 *                              l'horizon est fermée exceptionnellement ;
 *   - `horizon_exhausted`    : le délai, le minimum de jours ou l'heure
 *                              limite repoussent la première date
 *                              au-delà de l'horizon de réservation ;
 *   - `no_offer_in_horizon`   : des offres existent et des dates sont
 *                              ouvertes, mais AUCUNE offre n'est encore
 *                              réalisable -- toutes sont passées, ou
 *                              tombent avant l'instant minimal de
 *                              réalisation, ou leur heure murale locale
 *                              n'existe pas / est ambiguë. Distinct de
 *                              `horizon_exhausted`, qui dit que la
 *                              première date POSSIBLE est au-delà de
 *                              l'horizon : ici des dates sont dans
 *                              l'horizon, ce sont les OFFRES qui ne
 *                              tiennent pas.
 */
export const CHECKOUT_UNFULFILLABLE_REASONS = [
  "no_offer_configured",
  "granularity_missing",
  "all_dates_closed",
  "horizon_exhausted",
  "no_offer_in_horizon",
] as const;

export type CheckoutUnfulfillableReason =
  (typeof CHECKOUT_UNFULFILLABLE_REASONS)[number];

/**
 * ═══ BORNES ═══
 *
 * Miroirs exacts des CHECK de la base. Le serveur reste l'autorité : ces
 * constantes servent à écrire la même borne une seule fois côté
 * TypeScript et à la prouver identique côté SQL, jamais à dispenser le
 * serveur de valider.
 */
export const SCHEDULE_TIMEZONE_MAX_LENGTH = 64;
export const SCHEDULE_SLOT_KEY_MAX_LENGTH = 40;
export const SCHEDULE_CLOSURE_LABEL_MAX_LENGTH = 120;
export const SCHEDULE_LEAD_TIME_MINUTES_MAX = 100_000;
export const SCHEDULE_MIN_LEAD_DAYS_MAX = 365;
export const SCHEDULE_CUTOFF_OFFSET_DAYS_MAX = 30;
/** 0 = « aujourd'hui seulement ». */
export const SCHEDULE_BOOKING_HORIZON_DAYS_MIN = 0;
export const SCHEDULE_BOOKING_HORIZON_DAYS_MAX = 365;
export const SCHEDULE_TIME_GRANULARITY_MINUTES_MIN = 5;
export const SCHEDULE_TIME_GRANULARITY_MINUTES_MAX = 240;

/**
 * Forme d'une clé de créneau : minuscules, chiffres, tiret et
 * soulignement. Volontairement étroite -- une clé de créneau voyage dans
 * une URL de test, dans un instantané de commande et dans un libellé de
 * back-office ; elle ne doit jamais avoir besoin d'être échappée.
 * Miroir SQL : la contrainte `slot_key ~ '^[a-z0-9_-]+$'`.
 */
export const SCHEDULE_SLOT_KEY_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Jours de semaine : 0 = DIMANCHE, 6 = samedi.
 *
 * Même convention que `extract(dow from …)` de PostgreSQL et que
 * `Date.prototype.getUTCDay()` de JavaScript. Choisie précisément parce
 * qu'elle est commune aux deux côtés : une convention ISO (1 = lundi)
 * aurait obligé à convertir quelque part, et une conversion est un
 * endroit où se tromper.
 */
export const SCHEDULE_WEEKDAY_MIN = 0;
export const SCHEDULE_WEEKDAY_MAX = 6;

export function isCheckoutDateSelectionMode(
  value: unknown
): value is CheckoutDateSelectionMode {
  return (
    typeof value === "string" &&
    (CHECKOUT_DATE_SELECTION_MODES as readonly string[]).includes(value)
  );
}

export function isCheckoutSlotSelectionMode(
  value: unknown
): value is CheckoutSlotSelectionMode {
  return (
    typeof value === "string" &&
    (CHECKOUT_SLOT_SELECTION_MODES as readonly string[]).includes(value)
  );
}

export function isCheckoutScheduleStatus(
  value: unknown
): value is CheckoutScheduleStatus {
  return (
    typeof value === "string" &&
    (CHECKOUT_SCHEDULE_STATUSES as readonly string[]).includes(value)
  );
}

export function isCheckoutUnfulfillableReason(
  value: unknown
): value is CheckoutUnfulfillableReason {
  return (
    typeof value === "string" &&
    (CHECKOUT_UNFULFILLABLE_REASONS as readonly string[]).includes(value)
  );
}

export function isScheduleWeekday(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SCHEDULE_WEEKDAY_MIN &&
    value <= SCHEDULE_WEEKDAY_MAX
  );
}

export function isScheduleSlotKey(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SCHEDULE_SLOT_KEY_MAX_LENGTH &&
    SCHEDULE_SLOT_KEY_PATTERN.test(value)
  );
}

/**
 * ═══ COHÉRENCE POLITIQUE DE DATE × POLITIQUE D'HORAIRE ═══
 *
 * Seule `customer_selectable` autorise une sélection d'horaire : si le
 * client ne choisit pas la date, il ne peut pas davantage choisir
 * l'heure -- prétendre le contraire produirait un écran qui demande une
 * heure pour une date que le client n'a pas vue.
 *
 * Miroir SQL : la contrainte de table
 * `date_selection_mode = 'customer_selectable' or slot_selection_mode = 'none'`.
 */
export function isSchedulePolicyCoherent(
  dateMode: CheckoutDateSelectionMode,
  slotMode: CheckoutSlotSelectionMode
): boolean {
  return dateMode === "customer_selectable" || slotMode === "none";
}

/**
 * ═══ CSDJ-V1-MINUTE-PRECISION-01 ═══
 *
 * CONTRAT DE PRÉCISION : toute heure de la configuration est à la
 * MINUTE. Les secondes doivent valoir exactement `00`, et toute valeur
 * sous-minute est REFUSÉE -- jamais tronquée.
 *
 * Pourquoi un refus et non une troncature : un créneau
 * `09:00:01–09:00:59` tronqué devient `09:00–09:00`, soit un créneau de
 * durée nulle, affiché comme disponible et impossible à honorer. Le
 * défaut n'était pas la troncature elle-même mais son SILENCE : la
 * configuration disait une chose, la projection publique une autre.
 * Refuser à l'écriture est la seule correction qui ne laisse aucune
 * représentation ambiguë circuler.
 *
 * Miroirs SQL : les CHECK `… = pg_catalog.date_trunc('minute', …)` sur
 * chaque colonne `time` du lot, et la garde `CSDJ1_SUBMINUTE_TIME` de
 * la RPC d'écriture.
 *
 * ═══ CSDJ-V1-NO-24H-01 ═══
 *
 * `24:00:00` est REFUSÉ, bien que PostgreSQL sache le stocker dans un
 * `time`. Une fenêtre qui « finit à minuit » se déclare `23:59`, et une
 * offre qui franchit minuit se déclare en deux lignes. Accepter 24:00
 * obligerait chaque comparaison, chaque formatage et chaque calcul
 * d'instant à connaître ce cas particulier -- et il suffit d'un endroit
 * qui l'oublie pour produire une date décalée d'un jour.
 */
export const SCHEDULE_MAX_MINUTE_OF_DAY = 23 * 60 + 59;

/**
 * Minutes depuis minuit d'un `HH:MM` ou `HH:MM:SS` dont les SECONDES
 * valent `00`, sinon `null`.
 *
 * psql rend un `time` en `HH:MM:SS` : la forme à six chiffres doit donc
 * être lisible. Mais `09:00:30` n'est pas une heure valide de ce lot, et
 * cette fonction le dit au lieu de l'arrondir.
 */
export function parseScheduleTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  const frac = m[4];
  if (h > 23 || min > 59) return null;
  // CSDJ-V1-MINUTE-PRECISION-01 : toute précision sous la minute est
  // REFUSÉE, jamais tronquée.
  if (sec !== 0) return null;
  if (frac !== undefined && /[1-9]/.test(frac)) return null;
  return h * 60 + min;
}

/** La valeur est-elle une heure de configuration admissible ? */
export function isScheduleTime(value: unknown): boolean {
  return parseScheduleTime(value) !== null;
}

/** `HH:MM` depuis des minutes depuis minuit. */
export function formatScheduleTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
