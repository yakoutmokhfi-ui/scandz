import type {
  MerchantFulfillmentSchedule,
  MerchantFulfillmentV12Extension,
} from "@/lib/dashboard-types";
import type { AvailabilityDraft, AvailabilityIssue } from "@/lib/availability-payload";
// Miroirs de validation SQL, sans horloge ni autorité : ce module est
// explicitement importable depuis une page ou un composant
// (contrairement à l'oracle d'éligibilité, réservé aux tests). Les
// littéraux de politique viennent donc d'ici, jamais d'une chaîne
// retapée dans l'interface.
import {
  CHECKOUT_DATE_SELECTION_MODES,
  CHECKOUT_SLOT_SELECTION_MODES,
} from "@/lib/scheduling/schedule-model";

/** « Le client choisit sa date » — seul mode où une heure est permise. */
export const DATE_MODE_CUSTOMER = CHECKOUT_DATE_SELECTION_MODES[0];
/** « J'impose la première date disponible ». */
export const DATE_MODE_DERIVED = CHECKOUT_DATE_SELECTION_MODES[1];
/** « Aucune date — seul mon message s'affiche ». */
export const DATE_MODE_INFORMATIONAL = CHECKOUT_DATE_SELECTION_MODES[2];
/** « Pas d'heure : la date seule ». */
export const SLOT_MODE_NONE = CHECKOUT_SLOT_SELECTION_MODES[0];
/** « Une heure libre dans mes horaires » — exige un pas de grille. */
export const SLOT_MODE_FREE_TIME = CHECKOUT_SLOT_SELECTION_MODES[1];
/** « Des créneaux nommés que je définis ». */
export const SLOT_MODE_FIXED_SLOTS = CHECKOUT_SLOT_SELECTION_MODES[2];

/**
 * SCANYM — CSDJ-BO-1 — MISE À DISPOSITION — HELPERS PURS.
 *
 * Aucun appel réseau, AUCUNE HORLOGE, aucune éligibilité calculée ici.
 * L'autorité d'éligibilité est le serveur et lui seul
 * (CSDJ-V1-REFERENCE-NOT-AUTHORITY-01 : l'oracle d'éligibilité
 * TypeScript est réservé aux tests, et son import depuis une page ou un
 * composant fait échouer un test structurel). Ce module ne fait que trois choses :
 *   - nommer des états lisibles à partir de données déjà rendues ;
 *   - traduire un motif serveur en clé i18n, par catalogue FERMÉ ;
 *   - dire ce qui manque à une configuration pour être publiable.
 *
 * Il est pur pour être testable sans DOM et sans serveur.
 */

/**
 * ÉTAT DU CONTRAT D'ÉCRITURE — source unique de vérité de l'interface.
 *
 * Le CTO a refusé la séquence « suspendre → écrire → réactiver » comme
 * garantie d'enregistrement (jusqu'à six RPC, chacune atomique, aucune
 * atomicité entre elles) et demande un contrat d'écriture
 * transactionnel de la configuration ENTIÈRE, coordonné avec Boulez
 * sans toucher sa PR #146 — voir
 * docs/scheduling/csdj-bo1-write-contract-request.md.
 *
 * Tant que `available` est faux :
 *   - aucun site d'appel d'écriture n'existe dans le code ;
 *   - tout contrôle d'écriture et d'activation est rendu `disabled`,
 *     avec un texte qui dit POURQUOI (jamais une couleur seule) ;
 *   - la page reste pleinement utilisable en lecture, et l'aperçu
 *     serveur fonctionne.
 *
 * Passer `available` à vrai est une décision de lot, pas un réglage :
 * un test échoue si la constante change sans que le contrat soit
 * référencé.
 */
export const CSDJ_BO1_WRITE_CONTRACT = {
  available: true,
  reason: "CSDJ_BO1_WRITE_CONTRACT_READY",
  /** Contrat demandé, pour que l'interface puisse le nommer. */
  requestedContract: "save_fulfillment_configuration",
} as const;

export type AvailabilityScopeState = "active" | "disabled" | "unconfigured";

/**
 * Clé de portée = (mode de vente, règle de livraison). La règle vaut
 * `null` pour les modes sans livraison : c'est une VALEUR, pas un vide,
 * exactement comme le `rule_key` sentinelle côté base.
 */
export function scopeKeyOf(modeCode: string, fulfillmentRuleId: string | null): string {
  return `${modeCode}::${fulfillmentRuleId ?? "mode"}`;
}

/**
 * Trois états, et ils ne se confondent pas :
 *   - `unconfigured` : aucune ligne en base pour cette portée ;
 *   - `disabled` : une ligne existe, l'activation est fausse ;
 *   - `active` : une ligne existe et est activée.
 * Pour le client, `unconfigured` et `disabled` ont le MÊME effet : le
 * parcours de commande redevient celui d'avant. Ce n'est jamais une
 * erreur (CSDJ-V1-SCHEDULE-ABSENT-01).
 */
export function scopeStateOf(
  schedule: MerchantFulfillmentSchedule | undefined
): AvailabilityScopeState {
  if (!schedule) return "unconfigured";
  return schedule.enabled ? "active" : "disabled";
}

/**
 * Le SEAU de capacité n'est pas un réglage : il se DÉDUIT de la
 * politique d'horaire. Avec des créneaux nommés, la limite vaut par
 * créneau ; sans créneau nommé, le seau est la JOURNÉE ENTIÈRE (côté
 * base, la clé de créneau vaut la chaîne vide). Une limite de 12 en
 * « heure libre » veut donc dire douze commandes ce jour-là, pas douze
 * par demi-heure — et la page doit l'écrire.
 */
export function capacityBucketKindOf(slotSelectionMode: string): "named_slot" | "whole_day" {
  return slotSelectionMode === SLOT_MODE_FIXED_SLOTS ? "named_slot" : "whole_day";
}

/**
 * Méthode de planification de la portée. Une portée sans extension
 * v1.2 lue est en méthode v1 : son délai part d'aujourd'hui et son
 * heure limite se décale en jours. Une portée v1.2 a un calendrier de
 * préparation et refuse tout décalage d'heure limite.
 */
export function scheduleMethodOf(
  extension: MerchantFulfillmentV12Extension | undefined
): "v1" | "v1.2" {
  return extension?.scheduleMethodVersion === "v1.2" ? "v1.2" : "v1";
}

/**
 * LECTURE : ouverte à tout membre de l'établissement et aux opérateurs
 * Scanym — c'est exactement ce que la RPC de lecture autorise
 * (`is_member_of() OR is_scanym_operator()`).
 */
export function canReadFulfillmentSchedules(params: {
  role: string | undefined;
  isOperator: boolean;
}): boolean {
  return params.isOperator || params.role === "owner" || params.role === "manager" || params.role === "staff";
}

/**
 * ÉCRITURE : propriétaire ou responsable UNIQUEMENT.
 *
 * ATTENTION, DIFFÉRENCE AVEC « Tarifs de livraison » : là-bas, un
 * opérateur Scanym peut écrire, parce que la RPC le prévoit. Ici, la
 * seule autorité d'écriture de planification est
 * `has_role_in(restaurant, ['owner','manager'])` — AUCUN contournement
 * opérateur n'existe côté SQL. Copier le `canEdit = isOperator || …` de
 * l'autre onglet promettrait donc une écriture que le serveur refuse.
 * L'opérateur garde la lecture complète.
 *
 * Cette porte reste une COMMODITÉ d'interface, jamais la frontière de
 * sécurité : la RPC revérifie, et de toute façon aucun chemin
 * d'écriture n'existe tant que le contrat n'est pas approuvé.
 */
export function canWriteFulfillmentSchedules(params: {
  role: string | undefined;
  isOperator: boolean;
}): boolean {
  void params.isOperator;
  return params.role === "owner" || params.role === "manager";
}

/**
 * Les contrôles d'écriture et d'activation sont-ils actionnables ?
 * Deux conditions, et les deux sont nécessaires : le rôle, et le
 * contrat d'écriture. Aujourd'hui la seconde est fausse par
 * construction, donc la réponse est toujours `false` — mais la raison
 * rendue n'est pas la même, et l'interface doit dire laquelle.
 */
export function writeControlsState(params: {
  role: string | undefined;
  isOperator: boolean;
}): { enabled: false; reason: "role" | "write-contract" } | { enabled: true } {
  if (!canWriteFulfillmentSchedules(params)) return { enabled: false, reason: "role" };
  if (!CSDJ_BO1_WRITE_CONTRACT.available) {
    return { enabled: false, reason: "write-contract" };
  }
  return { enabled: true };
}

/** Catalogue FERMÉ des statuts rendus par l'autorité serveur. */
const SCHEDULE_STATUS_KEYS: Record<string, string> = {
  absent: "avStatusAbsent",
  blocked_upstream: "avStatusBlockedUpstream",
  informational_only: "avStatusInformationalOnly",
  dates_available: "avStatusDatesAvailable",
  unfulfillable: "avStatusUnfulfillable",
};

export function scheduleStatusKey(status: string): string {
  return SCHEDULE_STATUS_KEYS[status] ?? "avStatusUnknown";
}

/**
 * Catalogue FERMÉ des motifs d'infaisabilité : cinq en méthode v1,
 * quatre de plus en v1.2. Un motif inconnu de ce lot obtient un repli
 * lisible — jamais un code brut affiché, jamais un « indisponible »
 * sans cause.
 */
const UNFULFILLABLE_REASON_KEYS: Record<string, string> = {
  no_offer_configured: "avReasonNoOfferConfigured",
  granularity_missing: "avReasonGranularityMissing",
  all_dates_closed: "avReasonAllDatesClosed",
  horizon_exhausted: "avReasonHorizonExhausted",
  no_offer_in_horizon: "avReasonNoOfferInHorizon",
  preparation_calendar_missing: "avReasonPreparationCalendarMissing",
  no_preparation_day_in_horizon: "avReasonNoPreparationDayInHorizon",
  cutoff_unresolvable: "avReasonCutoffUnresolvable",
  capacity_exhausted: "avReasonCapacityExhausted",
};

export function unfulfillableReasonKey(reason: string | null): string {
  if (!reason) return "avReasonUnknown";
  return UNFULFILLABLE_REASON_KEYS[reason] ?? "avReasonUnknown";
}

/** 0 = dimanche côté base. L'affichage commence au lundi. */
export const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const WEEKDAY_KEYS: Record<number, string> = {
  0: "avWeekday0",
  1: "avWeekday1",
  2: "avWeekday2",
  3: "avWeekday3",
  4: "avWeekday4",
  5: "avWeekday5",
  6: "avWeekday6",
};

export function weekdayLabelKey(weekday: number): string {
  return WEEKDAY_KEYS[weekday] ?? "avWeekdayUnknown";
}

/**
 * CE QUI MANQUE POUR QU'UNE PORTÉE SOIT PUBLIABLE.
 *
 * C'est l'invariant que le contrat d'écriture demandé devra faire
 * respecter DANS la transaction — ici, il ne sert qu'à EXPLIQUER, et à
 * documenter précisément ce que le serveur devra refuser. Tant qu'un
 * tel contrat n'existe pas, cette fonction n'autorise rien : elle
 * décrit.
 *
 * Les codes rendus sont stables et testés :
 *   - `offer_missing`        : politique « pas d'heure » ou « heure
 *                              libre » sans aucune plage d'ouverture,
 *                              ou « créneaux nommés » sans aucun
 *                              créneau — le client ne verrait aucune
 *                              date ;
 *   - `granularity_missing`  : « heure libre » sans pas de grille ;
 *   - `preparation_missing`  : méthode v1.2 sans aucun jour de
 *                              préparation — un calendrier vide n'est
 *                              pas « tous les jours » ;
 *   - `capacity_incomplete`  : limite active sans maximum strictement
 *                              positif ;
 *   - `capacity_needs_date`  : limite active en politique purement
 *                              informative — il n'y a aucun seau à
 *                              compter.
 */
export type AvailabilityPublishBlocker =
  | "offer_missing"
  | "granularity_missing"
  | "preparation_missing"
  | "capacity_incomplete"
  | "capacity_needs_date";

export function publishBlockersOf(
  schedule: MerchantFulfillmentSchedule | undefined,
  extension: MerchantFulfillmentV12Extension | undefined
): AvailabilityPublishBlocker[] {
  if (!schedule) return ["offer_missing"];
  const blockers: AvailabilityPublishBlocker[] = [];

  if (schedule.dateSelectionMode !== DATE_MODE_INFORMATIONAL) {
    const usesNamedSlots = schedule.slotSelectionMode === SLOT_MODE_FIXED_SLOTS;
    if (usesNamedSlots) {
      if (schedule.slots.length === 0) blockers.push("offer_missing");
    } else if (schedule.windows.length === 0) {
      blockers.push("offer_missing");
    }
  }

  if (
    schedule.slotSelectionMode === SLOT_MODE_FREE_TIME &&
    (schedule.timeGranularityMinutes === null || schedule.timeGranularityMinutes === 0)
  ) {
    blockers.push("granularity_missing");
  }

  if (scheduleMethodOf(extension) === "v1.2" && (extension?.preparationWeekdays.length ?? 0) === 0) {
    blockers.push("preparation_missing");
  }

  if (extension?.capacityEnabled) {
    if (extension.capacityMaxOrders === null || extension.capacityMaxOrders < 1) {
      blockers.push("capacity_incomplete");
    }
    if (schedule.dateSelectionMode === DATE_MODE_INFORMATIONAL) {
      blockers.push("capacity_needs_date");
    }
  }

  return blockers;
}

const BLOCKER_KEYS: Record<AvailabilityPublishBlocker, string> = {
  offer_missing: "avBlockerOfferMissing",
  granularity_missing: "avBlockerGranularityMissing",
  preparation_missing: "avBlockerPreparationMissing",
  capacity_incomplete: "avBlockerCapacityIncomplete",
  capacity_needs_date: "avBlockerCapacityNeedsDate",
};

export function publishBlockerKey(blocker: AvailabilityPublishBlocker): string {
  return BLOCKER_KEYS[blocker];
}

/**
 * Message SÛR pour un échec de lecture : jamais un message serveur
 * brut, jamais un SQLSTATE, jamais un nom de table ou de fonction, et
 * jamais un identifiant d'établissement. Deux cas seulement sont
 * distingués, parce qu'ils appellent deux gestes différents.
 */
export function readErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("CSDJ1_AUTH_REQUIRED")) return "avAuthRequired";
  if (message.includes("CSDJ1_FORBIDDEN")) return "avForbidden";
  return "avLoadFailed";
}

// ====================================================================
// #170 — PLANNING D'UNE RÈGLE DE LIVRAISON (portée sans ligne en base)
// ====================================================================

/** Code du mode de vente « livraison » (catalogue `sale_mode_catalog`). */
export const DELIVERY_MODE_CODE = "delivery";

/** Fournisseur d'une règle de livraison (même énumération que la lecture marchand). */
export type DeliveryRuleProvider = "internal" | "stuart" | "chronofresh" | "other_external";

/** Le strict nécessaire d'une règle de livraison pour nommer sa portée. */
export interface DeliveryRuleRef {
  ruleId: string;
  /** Libellé marchand de la règle (zone, transporteur…). */
  label: string;
  /**
   * Fournisseur de la règle, tel que la lecture marchand le rend. Il DOIT
   * rester attaché à la règle jusqu'au brouillon : c'est lui qui interdit
   * les créneaux horaires Chronofresh. Absent = lecture ancienne, pas un
   * fournisseur « sans contrainte » inventé par l'interface.
   */
  provider?: DeliveryRuleProvider | null;
}

/**
 * Règles de livraison qui n'ont AUCUNE portée de planification. Aujourd'hui
 * l'écran ne liste que les portées déjà en base : une règle sans ligne n'y
 * figurait jamais, donc le commerçant ne pouvait pas lui donner de créneaux.
 * Pure : ni lecture ni écriture. L'ordre des règles est conservé.
 */
export function unconfiguredDeliveryRules(
  rules: readonly DeliveryRuleRef[],
  schedules: readonly Pick<MerchantFulfillmentSchedule, "modeCode" | "fulfillmentRuleId">[]
): DeliveryRuleRef[] {
  const configured = new Set(
    schedules
      .filter((s) => s.modeCode === DELIVERY_MODE_CODE && s.fulfillmentRuleId)
      .map((s) => s.fulfillmentRuleId as string)
  );
  const seen = new Set<string>();
  return rules.filter((r) => {
    if (configured.has(r.ruleId) || seen.has(r.ruleId)) return false;
    seen.add(r.ruleId);
    return true;
  });
}

/**
 * Valeurs de DÉPART proposées à la création d'un planning de livraison
 * (réglables ensuite champ par champ, rien n'est figé) : le client choisit
 * sa date parmi des créneaux nommés, commande close à 16:00 la veille.
 * Le brouillon reste DÉSACTIVÉ : rien n'est proposé au client tant que le
 * commerçant n'a pas choisi ses jours et activé.
 */
export const DELIVERY_SCHEDULE_STARTER = {
  dateSelectionMode: DATE_MODE_CUSTOMER,
  slotSelectionMode: SLOT_MODE_FIXED_SLOTS,
  cutoffTime: "16:00",
  cutoffOffsetDays: "1",
} as const;

/** Les trois créneaux de 3 heures proposés d'un clic, jour par jour. */
export const STANDARD_DELIVERY_SLOTS = [
  { slotKey: "11h-14h", startsAt: "11:00", endsAt: "14:00" },
  { slotKey: "14h-17h", startsAt: "14:00", endsAt: "17:00" },
  { slotKey: "17h-20h", startsAt: "17:00", endsAt: "20:00" },
] as const;

/**
 * Créneaux standard à AJOUTER pour un jour : ceux dont la clé n'existe pas
 * déjà ce jour-là (jamais de doublon, jamais d'écrasement d'une saisie).
 */
export function missingStandardSlots(
  existing: readonly { weekday: number; slotKey: string }[],
  weekday: number
): typeof STANDARD_DELIVERY_SLOTS[number][] {
  const have = new Set(existing.filter((s) => s.weekday === weekday).map((s) => s.slotKey));
  return STANDARD_DELIVERY_SLOTS.filter((s) => !have.has(s.slotKey));
}

// ====================================================================
// #170 — FOURNISSEUR : AUCUN CRÉNEAU HORAIRE CHRONOFRESH
// ====================================================================
//
// Règle produit : une livraison Chronofresh n'a ni jour ni créneau choisi
// par le client ; le commerçant expédie lorsque la commande est prête. Au
// checkout, c'est le mode de date « informatif » sans créneau (le serveur
// rend `informational_only`, rien à choisir, rien à envoyer). Les autres
// modes de date exigent des horaires pour être publiés (publishBlockersOf).
// Pures : ni lecture ni écriture.

/** Le fournisseur qui n'accepte AUCUN créneau horaire. */
export const NO_HOURLY_PROVIDER = "chronofresh" as const;

export function isChronofreshRule(
  rule: Pick<DeliveryRuleRef, "provider"> | null | undefined
): boolean {
  return rule?.provider === NO_HOURLY_PROVIDER;
}

/**
 * Ce brouillon demanderait-il au client de choisir une date, un créneau ou
 * une heure ? Vrai dès que le mode de date n'est pas informatif, que le mode
 * de créneau n'est pas « aucun », ou qu'une ligne horaire existe.
 */
export function draftOffersCustomerSchedule(
  draft: Pick<AvailabilityDraft, "dateSelectionMode" | "slotSelectionMode" | "slots" | "windows">
): boolean {
  return (
    draft.dateSelectionMode !== DATE_MODE_INFORMATIONAL ||
    draft.slotSelectionMode !== SLOT_MODE_NONE ||
    draft.slots.length > 0 ||
    draft.windows.length > 0
  );
}

/**
 * Valeurs de DÉPART d'une règle sans planning, selon son fournisseur.
 * Chronofresh : informatif, aucun créneau (jamais le départ Stuart).
 */
export function scheduleStarterFor(rule: Pick<DeliveryRuleRef, "provider"> | null | undefined): {
  dateSelectionMode: string;
  slotSelectionMode: string;
  cutoffTime?: string;
  cutoffOffsetDays?: string;
} {
  if (isChronofreshRule(rule)) {
    return { dateSelectionMode: DATE_MODE_INFORMATIONAL, slotSelectionMode: SLOT_MODE_NONE };
  }
  return { ...DELIVERY_SCHEDULE_STARTER };
}

/**
 * Refus de fournisseur pour un brouillon, sur TOUS les chemins d'écriture
 * (enregistrer, enregistrer en brouillon) :
 *   - règle Chronofresh + planning horaire => `provider_no_hourly` ;
 *   - règle inconnue alors que la lecture des règles a ÉCHOUÉ + planning
 *     horaire => `provider_unverified` (on n'enregistre pas à l'aveugle) ;
 *   - portée sans règle (retrait…), ou brouillon sans horaire : aucun refus.
 * Stuart et les autres fournisseurs gardent leurs créneaux configurables.
 */
export function providerScheduleIssues(
  draft: Pick<
    AvailabilityDraft,
    "fulfillmentRuleId" | "dateSelectionMode" | "slotSelectionMode" | "slots" | "windows"
  >,
  rules: readonly DeliveryRuleRef[],
  rulesReadFailed: boolean
): AvailabilityIssue[] {
  if (draft.fulfillmentRuleId === null) return [];
  if (!draftOffersCustomerSchedule(draft)) return [];
  const rule = rules.find((r) => r.ruleId === draft.fulfillmentRuleId);
  if (isChronofreshRule(rule)) return [{ code: "provider_no_hourly", section: "offers" }];
  if (!rule && rulesReadFailed) return [{ code: "provider_unverified", section: "offers" }];
  return [];
}
