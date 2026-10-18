import type { CheckoutScheduleState } from "@/lib/checkout-schedule/use-checkout-schedule";
import { scheduleRequirement } from "@/lib/checkout-schedule/model";
import type { ScheduleOrderErrorClass } from "@/lib/services/order-error";

/**
 * CSDJ-2 / issue #158 -- CLÉS de texte (jamais de logique d'éligibilité)
 * du calendrier du checkout. Regroupées ici pour que le relevé des clés
 * lues par cet écran reste mesurable sur des sources identifiées
 * (voir tests/storefront-order-help-wording-customer-text-1000-v1.test.ts,
 * [SW-04]).
 */

/** Indication affichée à la place du bouton quand SEUL le calendrier manque. */
export function scheduleHintKey(state: CheckoutScheduleState): string {
  if (state.status === "loading") return "chkScheduleLoading";
  if (state.status === "ready") {
    const kind = scheduleRequirement(state.view).kind;
    if (kind === "blocked") return "chkScheduleBlocked";
    if (kind === "unreadable") return "chkScheduleUnreadable";
  }
  return "chkScheduleChooseHint";
}

/** Message d'une relecture déclenchée par un refus TYPÉ du serveur. */
export function scheduleNoticeKey(kind: ScheduleOrderErrorClass): string {
  if (kind === "choose") return "chkScheduleChoose";
  if (kind === "reselect") return "chkScheduleReselect";
  return "chkScheduleRefresh";
}
