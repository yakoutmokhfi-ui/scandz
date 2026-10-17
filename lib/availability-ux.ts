/**
 * Aides d'AFFICHAGE de la page « Mise à disposition » (issue #156).
 *
 * Ce module ne contient AUCUNE règle métier et AUCUN calcul de date : il
 * ne fait que nommer, résumer et classer ce que la page possède déjà.
 * La première date proposable et les créneaux d'exemple viennent
 * exclusivement du serveur (`getCheckoutFulfillmentSchedulePreview`) ;
 * rien ici ne réimplémente l'algorithme dans le navigateur.
 */
import type { AvailabilityDraft } from "@/lib/availability-payload";

import {
  DATE_MODE_CUSTOMER,
  DATE_MODE_DERIVED,
  SLOT_MODE_FIXED_SLOTS as SLOT_MODE_FIXED,
  SLOT_MODE_FREE_TIME as SLOT_MODE_FREE,
  WEEKDAY_DISPLAY_ORDER,
} from "@/lib/availability-editor";

/**
 * Nom humain d'un mode de remise. Un code inconnu n'est jamais inventé :
 * la fonction rend `null` et l'appelant affiche le code tel quel.
 */
export function modeLabelKeyOf(modeCode: string): string | null {
  if (modeCode === "pickup") return "avModePickup";
  if (modeCode === "delivery") return "avModeDelivery";
  return null;
}

/**
 * Phrase « ce que voit le client », depuis les SEULS réglages donnés.
 * Même table de vérité pour la lecture enregistrée et pour le brouillon :
 * la page n'a donc jamais deux phrases d'origines différentes.
 */
export function customerSentenceKeyOf(policy: {
  enabled: boolean;
  dateSelectionMode: string;
  slotSelectionMode: string;
}): string {
  if (!policy.enabled) return "avCustomerNoDate";
  if (policy.dateSelectionMode === DATE_MODE_DERIVED) return "avCustomerFirstDate";
  if (policy.dateSelectionMode !== DATE_MODE_CUSTOMER) return "avCustomerNoDate";
  if (policy.slotSelectionMode === SLOT_MODE_FIXED) return "avCustomerDateAndSlot";
  if (policy.slotSelectionMode === SLOT_MODE_FREE) return "avCustomerDateAndTime";
  return "avCustomerDateOnly";
}

export type EditorStatus =
  | "readonly"
  | "contract"
  | "loading"
  | "conflict"
  | "unverified"
  | "saving"
  | "error"
  | "saved"
  | "dirty"
  | "clean";

/**
 * L'état unique que la page annonce au commerçant. L'ordre est celui de
 * la gravité : on ne dit jamais « enregistré » à quelqu'un qui n'a pas le
 * droit d'écrire, ni « aucune modification » devant un conflit.
 */
export function editorStatusOf(input: {
  roleCanWrite: boolean;
  contractAvailable: boolean;
  hasDraft: boolean;
  conflict: boolean;
  authoritative: boolean;
  saving: boolean;
  saveFailed: boolean;
  saved: boolean;
  dirty: boolean;
}): EditorStatus {
  if (!input.roleCanWrite) return "readonly";
  if (!input.contractAvailable) return "contract";
  if (!input.hasDraft) return "loading";
  if (input.conflict) return "conflict";
  if (!input.authoritative) return "unverified";
  if (input.saving) return "saving";
  if (input.saveFailed) return "error";
  if (input.dirty) return "dirty";
  if (input.saved) return "saved";
  return "clean";
}

export const EDITOR_STATUS_KEY: Record<EditorStatus, string> = {
  readonly: "avStatusReadOnly",
  contract: "avStatusContract",
  loading: "avStatusLoading",
  conflict: "avStatusConflict",
  unverified: "avStatusUnverified",
  saving: "avSaving",
  error: "avStatusError",
  saved: "avSavedState",
  dirty: "avStatusDirty",
  clean: "avStatusClean",
};

export interface WeekdayRanges {
  weekday: number;
  /** Plages « HH:MM–HH:MM », triées ; vide = jour fermé. */
  ranges: string[];
}

function hhmm(value: string): string {
  return value.length >= 5 ? value.slice(0, 5) : value;
}

/**
 * Les jours et horaires du brouillon, tels que saisis : un jour sans
 * plage est un jour fermé (c'est la seule définition d'un jour fermé).
 * En créneaux nommés, le nom du créneau précède la plage.
 */
export function weeklyScheduleSummary(draft: AvailabilityDraft): WeekdayRanges[] {
  const useSlots = draft.slotSelectionMode === SLOT_MODE_FIXED;
  return WEEKDAY_DISPLAY_ORDER.map((weekday) => {
    const rows = useSlots
      ? draft.slots
          .filter((row) => row.weekday === weekday)
          .map((row) => ({
            start: row.startsAt,
            text: `${row.slotKey ? `${row.slotKey} ` : ""}${hhmm(row.startsAt)}–${hhmm(row.endsAt)}`,
          }))
      : draft.windows
          .filter((row) => row.weekday === weekday)
          .map((row) => ({
            start: row.startsAt,
            text: `${hhmm(row.startsAt)}–${hhmm(row.endsAt)}`,
          }));
    rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return { weekday, ranges: rows.map((row) => row.text) };
  });
}
