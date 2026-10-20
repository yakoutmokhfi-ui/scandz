import type { CheckoutScheduleState } from "@/lib/checkout-schedule/use-checkout-schedule";
import { scheduleRequirement, type UnreadableReason } from "@/lib/checkout-schedule/model";
import type { ScheduleOrderErrorClass } from "@/lib/services/order-error";

/**
 * CSDJ-2 / issue #158 -- CLÉS de texte (jamais de logique d'éligibilité)
 * du calendrier du checkout. Regroupées ici pour que le relevé des clés
 * lues par cet écran reste mesurable sur des sources identifiées
 * (voir tests/storefront-order-help-wording-customer-text-1000-v1.test.ts,
 * [SW-04]).
 */

/** Explication d'une réponse inexploitable : le client sait POURQUOI rien ne part. */
export function unreadableMessageKey(reason: UnreadableReason): string {
  switch (reason) {
    case "ambiguous":
      return "chkScheduleUnreadableAmbiguous";
    case "date":
      return "chkScheduleUnreadableDate";
    case "interval":
      return "chkScheduleUnreadableInterval";
    case "policy":
      return "chkScheduleUnreadablePolicy";
    default:
      return "chkScheduleUnreadable";
  }
}

/** Indication affichée à la place du bouton quand SEUL le calendrier manque. */
export function scheduleHintKey(state: CheckoutScheduleState): string {
  if (state.status === "loading") return "chkScheduleLoading";
  if (state.status === "error") return "chkScheduleError";
  if (state.status === "ready") {
    const requirement = scheduleRequirement(state.view);
    if (requirement.kind === "blocked") return "chkScheduleBlocked";
    if (requirement.kind === "unreadable") return unreadableMessageKey(requirement.reason);
  }
  return "chkScheduleChooseHint";
}

/** Message d'une relecture déclenchée par un refus TYPÉ du serveur. */
export function scheduleNoticeKey(kind: ScheduleOrderErrorClass): string {
  if (kind === "choose") return "chkScheduleChoose";
  if (kind === "reselect") return "chkScheduleReselect";
  return "chkScheduleRefresh";
}
