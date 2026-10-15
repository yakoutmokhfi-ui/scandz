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
 * SCANYM — CSDJ-BO-1 — MISE À DISPOSITION — SERVICE.
 *
 * TROIS LECTURES, ET UNE SEULE ÉCRITURE — ENCORE INDISPONIBLE
 * ---------------------------------------------------------------
 * Le CTO a refusé la séquence « suspendre → écrire → réactiver » comme
 * garantie d'enregistrement : enregistrer une portée complète
 * demanderait jusqu'à six appels RPC, chacun atomique mais aucun
 * enveloppé avec les autres, et aucune atomicité n'existe donc ENTRE
 * deux appels. Un contrat d'écriture transactionnel de la
 * configuration ENTIÈRE est demandé à Boulez (voir
 * docs/scheduling/csdj-bo1-write-contract-request.md).
 *
 * Ce module expose donc UNE SEULE écriture,
 * `saveFulfillmentConfiguration`, qui appelle UNE SEULE RPC :
 * `save_fulfillment_configuration`. « Sauvegarde atomique via
 * save_fulfillment_configuration seulement, no multi-RPC save »
 * (issue #149). Les six actions existantes
 * (`mutate_merchant_fulfillment_schedule`, et sa variante v1.2) ne
 * sont appelées NULLE PART : la séquence multi-RPC est refusée comme
 * garantie d'enregistrement, et elle n'est pas réintroduite en
 * cachette.
 *
 * Cette écriture est VERROUILLÉE par
 * `CSDJ_BO1_WRITE_CONTRACT.available`, qui vaut `false` tant que la
 * RPC de Boulez n'existe pas et que ses tests ne sont pas passés
 * (issue #149 : « Ne jamais simplement basculer le flag avant qu'une
 * RPC transactionnelle Boulez existe et que les tests soient
 * passés »). Tant que le drapeau est faux, la fonction REFUSE
 * localement, sans réseau : aucune configuration incomplète ne peut
 * être produite, et aucun contournement du parcours de commande n'est
 * possible, puisque rien ne peut être activé d'ici.
 *
 * Des tests structurels (tests/csdj-bo1-availability-contract.test.ts)
 * échouent si une deuxième écriture, ou l'une des six actions,
 * réapparaît dans ce module ou dans la page.
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
import { CSDJ_BO1_WRITE_CONTRACT } from "@/lib/availability-editor";
export { CSDJ_BO1_WRITE_CONTRACT };

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
    updated_at?: string | null;
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
    // Absent de la lecture appliquée : voir MerchantFulfillmentSchedule.
    updatedAt: row.updated_at ?? null,
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

// ====================================================================
// LECTURE AUTORITAIRE DE LA CONFIGURATION — remédiation R1, §2
//
// `get_fulfillment_configuration(p_restaurant_id, p_mode_code,
// p_fulfillment_rule_id)` rend la configuration d'UNE portée, ou `null`
// si elle n'existe pas encore, avec les DEUX jetons de concurrence.
//
// Pourquoi une lecture de plus, alors que les listes sont déjà lues :
// les lectures de listes servent l'affichage et l'aperçu, et elles ne
// portent pas d'empreinte de contenu. La concurrence, elle, exige les
// deux jetons de CETTE lecture — c'est elle qui fait autorité pour
// décider si une écriture est à jour. Les deux lectures coexistent
// donc, avec des rôles qui ne se recouvrent pas (contrat : « les
// lectures existantes peuvent rester pour les listes et aperçus, mais
// ne remplacent pas cette lecture autoritaire »).
// ====================================================================

/**
 * Les deux jetons, tels que le serveur les a rendus. Des CHAÎNES, et
 * elles le restent : `updatedAt` porte une précision à la microseconde
 * que `Date` tronquerait à la milliseconde, ce qui ferait refuser chaque
 * écriture pour un conflit inexistant.
 */
export interface FulfillmentConfigurationTokens {
  readonly updatedAt: string;
  readonly revision: string;
}

export interface FulfillmentConfigurationRead {
  readonly tokens: FulfillmentConfigurationTokens;
  /**
   * La configuration rendue par le serveur, NON réinterprétée ici. La
   * page affiche les listes projetées par les lectures publiées ; cet
   * objet est conservé tel quel pour que le contrat puisse évoluer sans
   * qu'un second mapping divergent soit écrit dans ce lot.
   */
  readonly configuration: Record<string, unknown>;
}

/**
 * Levée quand la réponse serveur n'a pas la forme du contrat — jetons
 * absents, empreinte mal formée, ou horodatage rendu autrement qu'en
 * chaîne. Le message porte un code, jamais un détail serveur : l'appelant
 * le traduit en phrase générique.
 *
 * Elle est volontairement bruyante plutôt que tolérante : une
 * configuration lue sans jeton valide ne protège plus contre l'écrasement
 * concurrent, et continuer silencieusement serait pire que s'arrêter.
 */
export class FulfillmentConfigurationShapeError extends Error {
  constructor(detail: string) {
    super(`CSDJBO1_UNEXPECTED_CONFIGURATION_SHAPE: ${detail}`);
    this.name = "FulfillmentConfigurationShapeError";
  }
}

const REVISION_SHAPE = /^[0-9a-f]{32}$/;

/**
 * Extrait les deux jetons SANS les transformer. Un `updatedAt` qui
 * n'arriverait pas en chaîne (un `Date` fabriqué par un pilote, par
 * exemple) est REFUSÉ au lieu d'être converti : la conversion est
 * précisément ce que le contrat interdit.
 */
function readTokens(source: Record<string, unknown>): FulfillmentConfigurationTokens {
  const updatedAt = source.updatedAt;
  const revision = source.revision;
  if (typeof updatedAt !== "string" || updatedAt.trim() === "") {
    throw new FulfillmentConfigurationShapeError("updatedAt absent ou non textuel");
  }
  if (typeof revision !== "string" || !REVISION_SHAPE.test(revision)) {
    throw new FulfillmentConfigurationShapeError("revision absente ou mal formée");
  }
  // Rendus VERBATIM : aucune normalisation, aucun reparse.
  return { updatedAt, revision };
}

export async function getFulfillmentConfiguration(
  restaurantId: string,
  modeCode: string,
  fulfillmentRuleId: string | null
): Promise<FulfillmentConfigurationRead | null> {
  const { data, error } = await supabase.rpc("get_fulfillment_configuration", {
    p_restaurant_id: restaurantId,
    p_mode_code: modeCode,
    p_fulfillment_rule_id: fulfillmentRuleId,
  });
  if (error) throw new Error(error.message);
  // `null` est une réponse LÉGITIME : la portée n'a pas encore de
  // configuration. Ce n'est jamais une erreur, et jamais une
  // configuration vide inventée ici.
  if (data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FulfillmentConfigurationShapeError("objet JSON attendu");
  }
  const configuration = data as Record<string, unknown>;
  return { tokens: readTokens(configuration), configuration };
}

/**
 * Erreur locale, levée SANS réseau quand l'écriture est demandée alors
 * que le contrat n'est pas disponible. Elle existe pour que le refus
 * soit un fait observable et testable, pas un commentaire.
 */
export class AvailabilityWriteUnavailableError extends Error {
  readonly reason: string;
  constructor() {
    super("CSDJ_BO1_WRITE_CONTRACT_PENDING");
    this.name = "AvailabilityWriteUnavailableError";
    this.reason = CSDJ_BO1_WRITE_CONTRACT.reason;
  }
}

/**
 * L'UNIQUE écriture : toute la configuration d'une portée, en un appel,
 * dans une seule transaction côté serveur.
 *
 * Rend la configuration RELUE par le serveur dans la même transaction
 * (contrat §2.1-5), pour que l'interface n'ait pas besoin d'une seconde
 * lecture qui pourrait déjà être périmée. Les refus traversent tels
 * quels : c'est `saveErrorKey` (lib/availability-payload.ts) qui les
 * traduit en phrase sûre, et la page n'affiche jamais un message brut.
 *
 * Verrou : si `CSDJ_BO1_WRITE_CONTRACT.available` est faux, la fonction
 * lève AvailabilityWriteUnavailableError AVANT tout appel réseau. Le
 * jour où la RPC de Boulez est déployée et ses tests passés, basculer ce
 * seul drapeau suffit — aucun autre code ne change.
 */
export async function saveFulfillmentConfiguration(
  restaurantId: string,
  payload: Record<string, unknown>
): Promise<{
  schedules: MerchantFulfillmentSchedule[];
  v12: MerchantFulfillmentV12Read;
  /** Les DEUX jetons de la version qui vient d'être écrite. */
  tokens: FulfillmentConfigurationTokens;
  /** Le snapshot entier (configuration + jetons) de cette même version. */
  authoritative: FulfillmentConfigurationRead;
}> {
  if (!CSDJ_BO1_WRITE_CONTRACT.available) {
    throw new AvailabilityWriteUnavailableError();
  }
  const { data, error } = await supabase.rpc("save_fulfillment_configuration", {
    p_restaurant_id: restaurantId,
    p_payload: payload,
  });
  if (error) throw new Error(error.message);
  // La réponse porte la configuration écrite ET ses deux nouveaux
  // jetons : ce sont EUX qui remplacent les jetons locaux (contrat §3,
  // « remplacer la configuration locale et les deux jetons par la
  // réponse serveur »). Sans cela, la sauvegarde suivante renverrait les
  // jetons périmés de la version précédente et serait refusée pour un
  // conflit que le commerçant a lui-même créé.
  // ═══ SNAPSHOT AUTORITAIRE INDIVISIBLE ═══ (remédiation F-01)
  // La réponse du serveur est UN snapshot { configuration, jetons }. Si
  // elle a la forme d'une configuration complète, c'est elle -- et elle
  // seule -- qui devient le brouillon, la référence et les jetons. Sinon
  // on relit l'autorité en UN appel et on prend sa réponse entière :
  // jamais les jetons d'une réponse et la configuration d'une autre.
  const authoritative: FulfillmentConfigurationRead =
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof (data as Record<string, unknown>).policy === "object" &&
    (data as Record<string, unknown>).policy !== null
      ? {
          tokens: readTokens(data as Record<string, unknown>),
          configuration: data as Record<string, unknown>,
        }
      : await (async () => {
          const reread = await getFulfillmentConfiguration(
            restaurantId,
            String(payload.modeCode ?? ""),
            (payload.fulfillmentRuleId ?? null) as string | null
          );
          if (reread === null) {
            throw new FulfillmentConfigurationShapeError(
              "écriture acceptée mais configuration introuvable à la relecture"
            );
          }
          return reread;
        })();
  const tokens = authoritative.tokens;
  // Les listes affichées sont relues par les lectures PUBLIÉES plutôt
  // que reprojetées depuis la réponse : il n'existe ainsi qu'une seule
  // façon de projeter ces colonnes dans tout le lot.
  const [schedules, v12] = await Promise.all([
    getMerchantFulfillmentSchedules(restaurantId),
    getMerchantFulfillmentSchedulesV12(restaurantId),
  ]);
  return { schedules, v12, tokens, authoritative };
}
