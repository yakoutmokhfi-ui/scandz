import { supabase } from "@/lib/supabase";
import type {
  CheckoutFulfillmentPreview,
  CheckoutFulfillmentPreviewOffer,
  MerchantFulfillmentClosure,
  MerchantFulfillmentSchedule,
  MerchantFulfillmentSlot,
  MerchantFulfillmentV12Extension,
  MerchantFulfillmentV12Read,
  MerchantFulfillmentWindow,
} from "@/lib/dashboard-types";

/**
 * SCANYM — CSDJ-BO-1 — MISE À DISPOSITION — SERVICE DE LECTURE SEULE.
 *
 * CE MODULE N'ÉCRIT RIEN, ET C'EST UNE EXIGENCE, PAS UN OUBLI
 * ---------------------------------------------------------------
 * Le CTO a refusé la séquence « suspendre → écrire → réactiver » comme
 * garantie d'enregistrement : enregistrer une portée complète
 * demanderait jusqu'à six appels RPC, chacun atomique mais aucun
 * enveloppé avec les autres, et aucune atomicité n'existe donc ENTRE
 * deux appels. Un contrat d'écriture transactionnel de la
 * configuration ENTIÈRE est demandé à Boulez (voir
 * docs/scheduling/csdj-bo1-write-contract-request.md).
 *
 * Tant que ce contrat n'est pas approuvé ET disponible, ce module
 * n'expose AUCUNE fonction d'écriture et le code ne contient AUCUN
 * site d'appel vers une mutation de planification. Ce n'est pas une
 * désactivation d'interface — c'est l'absence du chemin lui-même :
 * aucune configuration incomplète ne peut être produite, et aucun
 * contournement du parcours de commande n'est possible, puisque rien
 * ne peut être activé d'ici.
 *
 * Un test structurel (tests/csdj-bo1-availability-contract.test.ts)
 * échoue si une écriture réapparaît dans ce module ou dans la page.
 *
 * TROIS LECTURES, TROIS STATUTS DE LIVRAISON DISTINCTS
 * ---------------------------------------------------
 *  1. get_merchant_fulfillment_schedules       — APPLIQUÉ (PR #145, PROD)
 *  2. get_merchant_fulfillment_schedules_v12   — LIVRÉ, NON APPLIQUÉ (PR #146)
 *  3. get_checkout_fulfillment_schedule        — APPLIQUÉ (PR #145, PROD)
 *
 * La deuxième peut donc être ABSENTE du serveur. Son absence est un
 * état modélisé et silencieux pour le commerçant, jamais une erreur
 * technique affichée : la page reste entièrement utilisable sur le
 * socle appliqué.
 *
 * AUCUNE AUTORITÉ CLIENTE : ce module ne calcule aucune éligibilité.
 * L'aperçu des disponibilités est RENDU PAR LE SERVEUR, par la même
 * lecture publique que le parcours de commande (l'appelant ne peut pas
 * choisir « maintenant » : la fonction n'accepte aucune heure).
 * Importer l'oracle d'éligibilité TypeScript depuis une page ou un
 * composant est interdit et testé ailleurs
 * (CSDJ-V1-REFERENCE-NOT-AUTHORITY-01).
 */

/**
 * Nom de la RPC d'ÉCRITURE qui n'est volontairement PAS appelée, posé
 * ici comme documentation exécutable : le test structurel vérifie que
 * ce littéral n'apparaît que dans ce commentaire-constante et jamais
 * dans un appel.
 *
 *   mutate_merchant_fulfillment_schedule      (socle v1, 5 actions)
 *   mutate_merchant_fulfillment_schedule_v12  (v1.2, 3 actions)
 *
 * Raison du refus : voir l'en-tête. Contrat demandé : voir
 * docs/scheduling/csdj-bo1-write-contract-request.md.
 */
export { CSDJ_BO1_WRITE_CONTRACT } from "@/lib/availability-editor";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mapWindows(value: unknown): MerchantFulfillmentWindow[] {
  return asArray(value).map((raw) => {
    const row = raw as { weekday?: unknown; startsAt?: unknown; endsAt?: unknown };
    return {
      weekday: Number(row.weekday),
      startsAt: String(row.startsAt ?? ""),
      endsAt: String(row.endsAt ?? ""),
    };
  });
}

function mapSlots(value: unknown): MerchantFulfillmentSlot[] {
  return asArray(value).map((raw) => {
    const row = raw as {
      weekday?: unknown;
      slotKey?: unknown;
      startsAt?: unknown;
      endsAt?: unknown;
    };
    return {
      weekday: Number(row.weekday),
      slotKey: String(row.slotKey ?? ""),
      startsAt: String(row.startsAt ?? ""),
      endsAt: String(row.endsAt ?? ""),
    };
  });
}

function mapClosures(value: unknown): MerchantFulfillmentClosure[] {
  return asArray(value).map((raw) => {
    const row = raw as { closedOn?: unknown; label?: unknown };
    return {
      closedOn: String(row.closedOn ?? ""),
      label: row.label === null || row.label === undefined ? null : String(row.label),
    };
  });
}

/**
 * Lecture marchande du socle APPLIQUÉ. Un seul appel rend toutes les
 * portées de l'établissement, horaires, créneaux et fermetures déjà
 * agrégés. Ouverte aux membres et aux opérateurs Scanym.
 */
export async function getMerchantFulfillmentSchedules(
  restaurantId: string
): Promise<MerchantFulfillmentSchedule[]> {
  const { data, error } = await supabase.rpc("get_merchant_fulfillment_schedules", {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{
    mode_code: string;
    fulfillment_rule_id: string | null;
    timezone: string;
    enabled: boolean;
    date_selection_mode: string;
    slot_selection_mode: string;
    time_granularity_minutes: number | null;
    lead_time_minutes: number | null;
    min_lead_days: number | null;
    cutoff_time: string | null;
    cutoff_offset_days: number | null;
    booking_horizon_days: number | null;
    windows: unknown;
    slots: unknown;
    closures: unknown;
  }>).map((row) => ({
    modeCode: row.mode_code,
    fulfillmentRuleId: row.fulfillment_rule_id ?? null,
    timezone: row.timezone,
    enabled: row.enabled === true,
    dateSelectionMode: row.date_selection_mode,
    slotSelectionMode: row.slot_selection_mode,
    timeGranularityMinutes:
      row.time_granularity_minutes === null || row.time_granularity_minutes === undefined
        ? null
        : Number(row.time_granularity_minutes),
    leadTimeMinutes: Number(row.lead_time_minutes ?? 0),
    minLeadDays: Number(row.min_lead_days ?? 0),
    cutoffTime: row.cutoff_time ?? null,
    cutoffOffsetDays: Number(row.cutoff_offset_days ?? 0),
    bookingHorizonDays: Number(row.booking_horizon_days ?? 0),
    windows: mapWindows(row.windows),
    slots: mapSlots(row.slots),
    closures: mapClosures(row.closures),
  }));
}

/**
 * Codes par lesquels PostgREST signale qu'une fonction n'existe pas sur
 * ce serveur. `PGRST202` est le code du cache de schéma (fonction
 * introuvable), `42883` le SQLSTATE PostgreSQL « undefined_function ».
 * Les deux veulent dire la même chose ici : la PR #146 n'est pas
 * appliquée.
 */
const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883", "404"]);

function isMissingFunction(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code && MISSING_FUNCTION_CODES.has(String(error.code))) return true;
  const message = String(error.message ?? "").toLowerCase();
  return (
    message.includes("could not find the function") ||
    message.includes("does not exist") ||
    message.includes("undefined function")
  );
}

/**
 * Lecture marchande des extensions CSDJ v1.2 — LIVRÉE, NON APPLIQUÉE.
 *
 * Ne JETTE JAMAIS : l'absence de la fonction, un refus de rôle et un
 * échec technique sont trois statuts rendus. La page affiche alors les
 * contrôles v1.2 en lecture, explicitement marqués non opérationnels,
 * plutôt que de les annoncer comme fonctionnels ou de casser la page.
 */
export async function getMerchantFulfillmentSchedulesV12(
  restaurantId: string
): Promise<MerchantFulfillmentV12Read> {
  const { data, error } = await supabase.rpc("get_merchant_fulfillment_schedules_v12", {
    p_restaurant_id: restaurantId,
  });
  if (error) {
    if (isMissingFunction(error)) return { status: "absent" };
    if (String(error.message ?? "").includes("CSDJ12_FORBIDDEN")) return { status: "forbidden" };
    return { status: "error" };
  }
  const rows = ((data ?? []) as Array<{
    mode_code: string;
    fulfillment_rule_id: string | null;
    schedule_method_version: string;
    holiday_calendar_id: string | null;
    preparation_on_holidays: string;
    availability_on_holidays: string;
    capacity_enabled: boolean;
    capacity_max_orders: number | null;
    preparation_weekdays: unknown;
    preparation_closures: unknown;
  }>).map<MerchantFulfillmentV12Extension>((row) => ({
    modeCode: row.mode_code,
    fulfillmentRuleId: row.fulfillment_rule_id ?? null,
    scheduleMethodVersion: row.schedule_method_version,
    holidayCalendarId: row.holiday_calendar_id ?? null,
    preparationOnHolidays: row.preparation_on_holidays,
    availabilityOnHolidays: row.availability_on_holidays,
    capacityEnabled: row.capacity_enabled === true,
    capacityMaxOrders:
      row.capacity_max_orders === null || row.capacity_max_orders === undefined
        ? null
        : Number(row.capacity_max_orders),
    preparationWeekdays: asArray(row.preparation_weekdays)
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    preparationClosures: asArray(row.preparation_closures).map((raw) => {
      const closure = raw as { closedOn?: unknown; label?: unknown };
      return {
        closedOn: String(closure.closedOn ?? ""),
        label:
          closure.label === null || closure.label === undefined
            ? null
            : String(closure.label),
      };
    }),
  }));
  return { status: "available", rows };
}

/**
 * Aperçu serveur des disponibilités : la lecture PUBLIQUE SÛRE, c'est
 * à dire exactement la réponse que recevrait un client. Pour une zone
 * de livraison, c'est le CODE POSTAL qui désigne la règle appliquée —
 * la fonction n'accepte aucun identifiant de règle, par conception, et
 * aucune lecture marchande ciblant une règle n'existe.
 *
 * La capacité, quand elle existera côté serveur, est déjà appliquée
 * DANS cette réponse : un créneau complet n'y figure pas. Aucun compte
 * ni « place restante » ne traverse, jamais.
 */
export async function getCheckoutFulfillmentSchedulePreview(params: {
  restaurantId: string;
  modeCode: string;
  postalCode?: string | null;
  totalCount?: number;
  subtotal?: number | null;
}): Promise<CheckoutFulfillmentPreview> {
  const { data, error } = await supabase.rpc("get_checkout_fulfillment_schedule", {
    p_restaurant_id: params.restaurantId,
    p_mode_code: params.modeCode,
    p_postal_code: params.postalCode ?? null,
    p_total_count: params.totalCount ?? 0,
    p_subtotal: params.subtotal ?? null,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        delivery_applicable?: boolean;
        delivery_eligible?: boolean;
        delivery_block?: string | null;
        delivery_customer_text?: string | null;
        schedule_status?: string;
        unfulfillable_reason?: string | null;
        schedule_timezone?: string | null;
        date_selection_mode?: string | null;
        slot_selection_mode?: string | null;
        time_granularity_minutes?: number | null;
        first_eligible_date?: string | null;
        eligible_dates?: string[] | null;
        offers?: Record<string, CheckoutFulfillmentPreviewOffer[]> | null;
      }
    | null
    | undefined;
  return {
    deliveryApplicable: row?.delivery_applicable === true,
    deliveryEligible: row?.delivery_eligible === true,
    deliveryBlock: row?.delivery_block ?? null,
    deliveryCustomerText: row?.delivery_customer_text ?? null,
    // Repli sûr : un statut absent est traité comme « absent », le
    // statut qui signifie « cette portée ne propose pas de dates » —
    // jamais comme une disponibilité.
    scheduleStatus: row?.schedule_status ?? "absent",
    unfulfillableReason: row?.unfulfillable_reason ?? null,
    scheduleTimezone: row?.schedule_timezone ?? null,
    dateSelectionMode: row?.date_selection_mode ?? null,
    slotSelectionMode: row?.slot_selection_mode ?? null,
    timeGranularityMinutes:
      row?.time_granularity_minutes === null || row?.time_granularity_minutes === undefined
        ? null
        : Number(row.time_granularity_minutes),
    firstEligibleDate: row?.first_eligible_date ?? null,
    eligibleDates: Array.isArray(row?.eligible_dates) ? row!.eligible_dates! : [],
    offers: row?.offers ?? null,
  };
}
