/**
 * Scanym — CHECKOUT SCHEDULING v1.2 (CSDJ v1.2) — MODÈLE (constantes pures).
 *
 * Catalogues FERMÉS partagés entre la base (miroirs SQL), le résolveur de
 * référence et tout client qui doit PARSER une réponse (CSDJ-2). Ce module
 * ne contient aucune logique d'éligibilité : il peut être importé par
 * `app/` et `components/`, contrairement à `eligibility-v12.ts`.
 *
 *   CHECKOUT_UNFULFILLABLE_REASONS_V12   ≡ checkout_unfulfillable_reasons_v12()
 *   FULFILLMENT_SELECTION_REASONS_V12    ≡ fulfillment_selection_reasons_v12()
 *
 * La dérive entre un catalogue SQL et son miroir est SILENCIEUSE : elle est
 * gardée par tests/csdj12-sql-structural.test.ts.
 */

import {
  type CheckoutUnfulfillableReason,
  CHECKOUT_UNFULFILLABLE_REASONS,
} from "@/lib/scheduling/schedule-model";

/**
 * Catalogue FERMÉ des motifs v1.2 : les cinq motifs CSDJ-1, DANS LE MÊME
 * ORDRE, puis les quatre nouveaux. Miroir caractère par caractère de
 * `public.checkout_unfulfillable_reasons_v12()`.
 */
export const CHECKOUT_UNFULFILLABLE_REASONS_V12 = [
  ...CHECKOUT_UNFULFILLABLE_REASONS,
  "preparation_calendar_missing",
  "no_preparation_day_in_horizon",
  "cutoff_unresolvable",
  "capacity_exhausted",
] as const;

export type CheckoutUnfulfillableReasonV12 =
  | CheckoutUnfulfillableReason
  | "preparation_calendar_missing"
  | "no_preparation_day_in_horizon"
  | "cutoff_unresolvable"
  | "capacity_exhausted";

/**
 * Catalogue FERMÉ des motifs de `validate_fulfillment_selection` et de
 * `reserve_fulfillment_capacity` (refus d'une SÉLECTION, par opposition
 * aux motifs d'indisponibilité de la LECTURE). Miroir caractère par
 * caractère de `public.fulfillment_selection_reasons_v12()`.
 */
export const FULFILLMENT_SELECTION_REASONS_V12 = [
  "schedule_not_fulfillable",
  "selection_required",
  "selection_not_expected",
  "selection_invalid",
  "date_not_offered",
  "slot_not_offered",
  "time_not_offered",
  "capacity_full",
] as const;

export type FulfillmentSelectionReasonV12 =
  (typeof FULFILLMENT_SELECTION_REASONS_V12)[number];

export type HolidayPolicy = "open" | "closed";
