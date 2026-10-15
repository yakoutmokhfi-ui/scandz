"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { getMerchantRestaurants, getRestaurantSettings } from "@/lib/services/dashboard";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import {
  AvailabilityWriteUnavailableError,
  getCheckoutFulfillmentSchedulePreview,
  getFulfillmentConfiguration,
  getMerchantFulfillmentSchedules,
  getMerchantFulfillmentSchedulesV12,
  saveFulfillmentConfiguration,
} from "@/lib/services/availability";
import {
  type AvailabilityDraft,
  type AvailabilityIssue,
  type DivergenceField,
  type DraftDivergence,
  buildSaveFulfillmentConfigurationPayload,
  canFallBackToDraft,
  draftAsInactive,
  diffDrafts,
  draftChangeCount,
  draftFromAuthoritativeSnapshot,
  draftFromServer,
  isDraftDirty,
  issueKey,
  issuesBlockingDraft,
  newRowId,
  rebaseDraft,
  saveErrorKey,
  serverRefusalCode,
  validateDraft,
} from "@/lib/availability-payload";
import type {
  CheckoutFulfillmentPreview,
  MerchantFulfillmentSchedule,
  MerchantFulfillmentV12Extension,
  MerchantFulfillmentV12Read,
  MerchantRestaurant,
} from "@/lib/dashboard-types";
import {
  CSDJ_BO1_WRITE_CONTRACT,
  DATE_MODE_CUSTOMER,
  DATE_MODE_DERIVED,
  DATE_MODE_INFORMATIONAL,
  SLOT_MODE_NONE,
  SLOT_MODE_FIXED_SLOTS,
  SLOT_MODE_FREE_TIME,
  WEEKDAY_DISPLAY_ORDER,
  canWriteFulfillmentSchedules,
  capacityBucketKindOf,
  publishBlockerKey,
  publishBlockersOf,
  readErrorKey,
  scheduleMethodOf,
  scheduleStatusKey,
  scopeKeyOf,
  scopeStateOf,
  unfulfillableReasonKey,
  weekdayLabelKey,
  writeControlsState,
} from "@/lib/availability-editor";
import {
  EDITOR_STATUS_KEY,
  customerSentenceKeyOf,
  editorStatusOf,
  modeLabelKeyOf,
  weeklyScheduleSummary,
} from "@/lib/availability-ux";
import DashboardNav from "@/components/dashboard/DashboardNav";
import {
  CHECKOUT_DATE_SELECTION_MODES,
  CHECKOUT_SLOT_SELECTION_MODES,
} from "@/lib/scheduling/schedule-model";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { translate, type Lang } from "@/lib/i18n";

/**
 * SCANYM — CSDJ-BO-1 — « MISE À DISPOSITION » (onglet commerçant).
 *
 * CE QUE CETTE PAGE FAIT, ET CE QU'ELLE NE FAIT PAS
 * ------------------------------------------------
 * Elle LIT et MONTRE : les règles de mise à disposition réellement
 * enregistrées (socle CSDJ-1 v1.10, appliqué en PROD), les extensions
 * CSDJ v1.2 quand le serveur les connaît (PR #146 — livrée, NON
 * appliquée), et l'aperçu des disponibilités TEL QUE LE SERVEUR LE
 * CALCULE.
 *
 * Elle N'ÉCRIT RIEN. Aucun site d'appel de mutation n'existe dans ce
 * fichier ni dans lib/services/availability.ts, et tout contrôle
 * d'écriture ou d'activation est rendu `disabled` avec la RAISON
 * écrite à côté (jamais une couleur seule).
 *
 * POURQUOI — DÉCISION CTO, PHASE D'IMPLÉMENTATION
 * ----------------------------------------------
 * La séquence « suspendre → écrire les listes → réactiver » conçue en
 * R2 est explicitement REFUSÉE comme garantie d'enregistrement : une
 * portée complète demande jusqu'à six RPC, chacune atomique, aucune
 * enveloppée avec les autres. Un contrat d'écriture TRANSACTIONNEL de
 * la configuration ENTIÈRE est demandé, coordonné avec Boulez et sans
 * toucher sa PR #146 :
 *   docs/scheduling/csdj-bo1-write-contract-request.md
 *
 * Conséquence tenue par construction, pas par discipline : comme
 * aucun chemin d'écriture n'existe, cette page ne peut produire NI
 * configuration incomplète, NI activation partielle, donc aucun
 * contournement du parcours de commande.
 *
 * AUCUNE AUTORITÉ CLIENTE (CSDJ-V1-REFERENCE-NOT-AUTHORITY-01)
 * ----------------------------------------------------------
 * Aucune éligibilité n'est calculée ici. L'aperçu appelle la lecture
 * publique sûre — la même que le parcours de commande — qui n'accepte
 * aucune heure de l'appelant. L'oracle d'éligibilité TypeScript (réservé
 * aux tests) n'est pas importé ici, et un test structurel l'interdit.
 *
 * CONTEXTE LOCATAIRE : patron déjà audité, repris sans affaiblissement
 * ------------------------------------------------------------------
 * Garde de contexte (lib/restaurant-context-guard n'est pas utilisée
 * ici : la page suit le patron `requestSeqRef` + provenance
 * `loadedRestaurantId` de app/dashboard/payment/page.tsx, dont les
 * trois protections sont conservées intégralement) :
 *   - réinitialisation SYNCHRONE dans le même gestionnaire que le
 *     changement d'établissement ;
 *   - garde anti-réponse-tardive sur chaque réponse ;
 *   - garde de RENDU `loadedRestaurantId === restaurantId` : les
 *     données d'un établissement ne peuvent jamais s'afficher sous
 *     l'en-tête d'un autre, pas même l'espace d'un rendu.
 */

const STATE_BADGE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-800",
  disabled: "bg-stone-100 text-stone-700",
  unconfigured: "bg-red-50 text-red-800",
};

const STATE_KEY: Record<string, string> = {
  active: "avStateActive",
  disabled: "avStateDisabled",
  unconfigured: "avStateUnconfigured",
};

/** Ce que le client voit, dit en une phrase, depuis les seules
 *  politiques enregistrées — aucune supposition. */
function customerSentenceKey(schedule: MerchantFulfillmentSchedule | undefined): string {
  if (!schedule) return "avCustomerNoDate";
  return customerSentenceKeyOf(schedule);
}

function dateModeKey(mode: string): string {
  if (mode === DATE_MODE_CUSTOMER) return "avDateModeCustomer";
  if (mode === DATE_MODE_DERIVED) return "avDateModeDerived";
  return "avDateModeInformational";
}

function slotModeKey(mode: string): string {
  if (mode === SLOT_MODE_FIXED_SLOTS) return "avSlotModeFixedSlots";
  if (mode === SLOT_MODE_FREE_TIME) return "avSlotModeFreeTime";
  return "avSlotModeNone";
}

/** Intitulé (clé i18n) de chaque champ pouvant s'opposer dans un conflit. */
const CONFLICT_FIELD_LABEL: Record<DivergenceField, string> = {
  enabled: "avActivateLabel",
  timezone: "avTimezoneLabel",
  dateSelectionMode: "avDateModeLabel",
  slotSelectionMode: "avSlotModeLabel",
  timeGranularityMinutes: "avGranularityLabel",
  leadTimeMinutes: "avLeadMinutesLabel",
  minLeadDays: "avLeadDaysLabel",
  cutoffTime: "avCutoffLabel",
  cutoffOffsetDays: "avCutoffOffsetLabel",
  bookingHorizonDays: "avHorizonLabel",
  windows: "avConflictFieldWindows",
  slots: "avConflictFieldSlots",
  closures: "avConflictFieldClosures",
  preparationWeekdays: "avPrepDaysLabel",
  preparationClosures: "avConflictFieldPrepClosures",
  holidayCalendarId: "avHolidayCalendarLabel",
  preparationOnHolidays: "avHolidayCalendarLabel",
  availabilityOnHolidays: "avHolidayCalendarLabel",
  capacityEnabled: "avCapacityEnabledLabel",
  capacityMaxOrders: "avCapacityMaxLabel",
};

const CONFLICT_ORIGIN_KEY = {
  mine: "avConflictOriginMine",
  theirs: "avConflictOriginTheirs",
  both: "avConflictOriginBoth",
} as const;

export default function AvailabilityPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [isOperator, setIsOperator] = useState(false);
  const [operatorRestaurantName, setOperatorRestaurantName] = useState<string | null>(null);
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const [schedules, setSchedules] = useState<MerchantFulfillmentSchedule[]>([]);
  const [v12, setV12] = useState<MerchantFulfillmentV12Read>({ status: "absent" });
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadedRestaurantId, setLoadedRestaurantId] = useState<string | null>(null);
  const [unavailableContextId, setUnavailableContextId] = useState<string | null>(null);
  const [selectedScopeKey, setSelectedScopeKey] = useState<string | null>(null);

  // Aperçu serveur : paramètres de test et résultat. Jamais persistés,
  // jamais envoyés ailleurs que dans la lecture publique.
  const [previewPostalCode, setPreviewPostalCode] = useState("");
  const [previewItems, setPreviewItems] = useState("1");
  const [previewSubtotal, setPreviewSubtotal] = useState("");
  const [preview, setPreview] = useState<CheckoutFulfillmentPreview | null>(null);
  // AUD-01 : portée à laquelle l'aperçu actuellement en état appartient
  // RÉELLEMENT. Posé UNIQUEMENT au moment exact où le résultat est
  // commité, jamais de façon optimiste.
  const [previewScopeKey, setPreviewScopeKey] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /**
   * ÉDITION (issue #149) — le brouillon et sa référence.
   *
   * `draft` est ce que le commerçant manipule ; `baseline` est ce que le
   * serveur a rendu. La différence des deux donne « modifié », et c'est
   * la seule source de cet état : aucun drapeau « sale » posé à la main,
   * qu'on oublierait de baisser.
   *
   * L'enregistrement reste VERROUILLÉ par
   * CSDJ_BO1_WRITE_CONTRACT.available tant que la RPC transactionnelle
   * de Boulez n'existe pas (issue #149). L'ÉDITION, elle, est bien
   * réelle : le brouillon vit côté client, ne touche rien, et montre
   * immédiatement les refus que le serveur produirait.
   */
  const [draftRaw, setDraft] = useState<AvailabilityDraft | null>(null);
  const [baselineRaw, setBaseline] = useState<AvailabilityDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * ═══ SNAPSHOT AUTORITAIRE INDIVISIBLE ═══ (remédiation F-01)
   *
   *     { configuration, updatedAt, revision }
   *
   * `draftRaw`, `baselineRaw` ET les deux jetons de concurrence (portés
   * par le brouillon lui-même : `expectedUpdatedAt`, `expectedRevision`)
   * sortent TOUS de la même réponse `get_fulfillment_configuration`.
   * Il n'existe donc plus d'état « jetons » séparé qu'on pourrait coller
   * sur une configuration lue ailleurs : c'est précisément ce collage
   * (configuration A des listes + jetons de B) qui laissait écraser B
   * sans bruit.
   *
   * `snapshotKey` dit d'où vient ce snapshot : l'établissement, la
   * portée, et la SOURCE. `"authority"` = la lecture autoritaire a
   * répondu, l'enregistrement est possible ; `"lists"` = elle n'a pas
   * répondu (fonction absente, forme inattendue, portée sans
   * configuration) : le brouillon est montré en lecture/édition locale,
   * sans AUCUN jeton, et l'enregistrement reste fermé -- on ne signe pas
   * une version qu'on n'a pas lue.
   */
  const [snapshotKey, setSnapshotKey] = useState<{
    restaurantId: string;
    scopeKey: string;
    source: "authority" | "lists";
  } | null>(null);
  /** Rang de la lecture autoritaire : garde anti-réponse périmée. */
  const tokenSeqRef = useRef(0);
  /** Relecture demandée (après un enregistrement dont le snapshot est inexploitable). */
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * ═══ CONFLIT DE CONCURRENCE ═══ (remédiation F-01)
   *
   * Un refus `CSDJBO1_STALE_CONFIGURATION` ne remplace RIEN : le
   * brouillon local (vos modifications) reste tel quel, la version du
   * serveur est gardée À PART dans `server`, et l'enregistrement est
   * suspendu jusqu'à un choix explicite (reprendre le serveur, ou
   * rebaser ses modifications dessus). `server === null` = la relecture
   * a échoué : rien n'est résolu, on propose de la refaire.
   */
  const [conflict, setConflict] = useState<{
    restaurantId: string;
    scopeKey: string;
    server: AvailabilityDraft | null;
  } | null>(null);
  /** Un rebase confirmé vient d'avoir lieu : on le dit, rien n'est enregistré. */
  const [rebased, setRebased] = useState(false);
  /**
   * Le serveur a refusé une configuration incomplète : on propose alors
   * l'enregistrement EN BROUILLON, et il faut une confirmation
   * explicite. Tant que ce drapeau est faux, aucun brouillon n'est écrit.
   */
  const [draftOfferPending, setDraftOfferPending] = useState(false);

  const requestSeqRef = useRef(0);
  const uiLangRef = useRef<Lang>("fr");
  useEffect(() => {
    uiLangRef.current = uiLang;
  }, [uiLang]);

  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);

  /**
   * Garde de RENDU par provenance : un brouillon n'est visible que s'il
   * provient de l'établissement ET de la portée affichés. Même invariant
   * que celui de l'aperçu (AUD-01), appliqué au brouillon : un
   * changement rapide de portée ne peut jamais montrer -- ni enregistrer
   * -- le brouillon d'une autre portée, pas même l'espace d'un rendu.
   */
  const snapshotInScope =
    snapshotKey !== null &&
    snapshotKey.restaurantId === restaurantId &&
    snapshotKey.scopeKey === selectedScopeKey;
  const draft = snapshotInScope ? draftRaw : null;
  const baseline = snapshotInScope ? baselineRaw : null;
  const snapshotAuthoritative = snapshotInScope && snapshotKey?.source === "authority";
  const conflictInScope =
    conflict !== null &&
    conflict.restaurantId === restaurantId &&
    conflict.scopeKey === selectedScopeKey
      ? conflict
      : null;
  /** La version du serveur a été relue après un refus de concurrence. */
  const staleReloaded = conflictInScope?.server != null;

  /** Une valeur de réglage, dite pour un humain -- jamais un code brut. */
  const conflictValue = (version: AvailabilityDraft, field: DivergenceField): string => {
    const value = version[field];
    if (Array.isArray(value)) {
      return value.length === 0
        ? t("avConflictValueEmpty")
        : t("avConflictListCount", { count: value.length });
    }
    if (typeof value === "boolean") {
      return value ? t("avConflictValueOn") : t("avConflictValueOff");
    }
    if (value === null || value === "") return t("avConflictValueEmpty");
    if (field === "dateSelectionMode") return t(dateModeKey(String(value)));
    if (field === "slotSelectionMode") return t(slotModeKey(String(value)));
    return String(value);
  };

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const role = mapping?.role;

  // ÉCRITURE : propriétaire ou responsable UNIQUEMENT — l'autorité
  // d'écriture SQL de planification ne prévoit AUCUNE dérogation
  // opérateur, contrairement à « Tarifs de livraison ». La lecture,
  // elle, reste ouverte à l'opérateur.
  const roleCanWrite = canWriteFulfillmentSchedules({ role, isOperator });
  const writeState = writeControlsState({ role, isOperator });
  const writeDisabled = !writeState.enabled;
  const writeDisabledKey =
    writeState.enabled === false && writeState.reason === "role"
      ? "avSaveDisabledWhyRole"
      : "avSaveDisabledWhyContract";

  const load = useCallback(async (id: string) => {
    if (!id) return;
    const seq = ++requestSeqRef.current;
    setSchedules([]);
    setV12({ status: "absent" });
    setPageError(null);
    setLoadedRestaurantId(null);
    setPreview(null);
    setPreviewScopeKey(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setDataLoading(true);

    getRestaurantSettings(id)
      .then((s) => {
        if (seq === requestSeqRef.current) {
          setUiLang((s.staff_receipt_language as Lang) ?? "fr");
        }
      })
      .catch(() => {
        if (seq === requestSeqRef.current) setUiLang("fr");
      });

    try {
      // La lecture v1.2 ne jette jamais : son absence est un statut,
      // pas une erreur. Les deux lectures partent ensemble et sont
      // commitées ensemble.
      const [next, nextV12] = await Promise.all([
        getMerchantFulfillmentSchedules(id),
        getMerchantFulfillmentSchedulesV12(id),
      ]);
      if (seq !== requestSeqRef.current) return;
      setSchedules(next);
      setV12(nextV12);
      setLoadedRestaurantId(id);
      setSelectedScopeKey(
        next.length > 0 ? scopeKeyOf(next[0].modeCode, next[0].fulfillmentRuleId) : null
      );
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      // Message SÛR : jamais de SQLSTATE, de nom de fonction, de table
      // ni d'identifiant d'établissement.
      setPageError(translate(uiLangRef.current, readErrorKey(error)));
      setLoadedRestaurantId(null);
    } finally {
      if (seq === requestSeqRef.current) setDataLoading(false);
    }
  }, []);

  const handleSelectRestaurant = useCallback((id: string) => {
    requestSeqRef.current += 1;
    setSchedules([]);
    setV12({ status: "absent" });
    setPageError(null);
    setLoadedRestaurantId(null);
    setSelectedScopeKey(null);
    setPreview(null);
    setPreviewScopeKey(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setDataLoading(true);
    setRestaurantId(id);
  }, []);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      try {
        const [next, opFlag] = await Promise.all([
          getMerchantRestaurants(),
          isScanymOperator(),
        ]);
        setIsOperator(opFlag);
        setMappings(next);
        const wanted = new URLSearchParams(window.location.search).get("r");
        const resolution = resolveRestaurantContext({
          requestedId: wanted,
          mappings: next,
          isOperator: opFlag,
        });
        if (resolution.kind === "unavailable") {
          setUnavailableContextId(resolution.requestedId);
          setDataLoading(false);
        } else if (resolution.kind === "none") {
          setPageError(translate(uiLangRef.current, "mcNoRestaurant"));
          setDataLoading(false);
        } else {
          setUnavailableContextId(null);
          setRestaurantId(resolution.restaurantId);
          if (resolution.source === "operator") {
            try {
              const summary = await getEstablishmentSummary(resolution.restaurantId);
              setOperatorRestaurantName(summary.name);
            } catch {
              // Best effort : un nom introuvable n'empêche pas de lire
              // les règles, et load() gère séparément son propre échec.
            }
          }
        }
      } catch {
        setPageError(translate(uiLangRef.current, "avLoadFailed"));
        setDataLoading(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  useEffect(() => {
    void load(restaurantId);
  }, [restaurantId, load]);

  const inContext = loadedRestaurantId === restaurantId && restaurantId !== "";

  const v12ByScope = useMemo(() => {
    const map = new Map<string, MerchantFulfillmentV12Extension>();
    if (v12.status === "available") {
      for (const row of v12.rows) {
        map.set(scopeKeyOf(row.modeCode, row.fulfillmentRuleId), row);
      }
    }
    return map;
  }, [v12]);

  const selected = useMemo(
    () =>
      schedules.find(
        (s) => scopeKeyOf(s.modeCode, s.fulfillmentRuleId) === selectedScopeKey
      ),
    [schedules, selectedScopeKey]
  );
  const selectedV12 = selectedScopeKey ? v12ByScope.get(selectedScopeKey) : undefined;
  const method = draft?.method ?? scheduleMethodOf(selectedV12);
  const blockers = publishBlockersOf(selected, selectedV12);

  /**
   * AUD-01 (audit Cat Greco) — UN APERÇU N'APPARTIENT PAS SEULEMENT À
   * UN ÉTABLISSEMENT, IL APPARTIENT À UNE PORTÉE.
   *
   * La garde locataire (`requestSeqRef`) ne bougeait pas quand le
   * commerçant changeait de PORTÉE à l'intérieur du MÊME
   * établissement : un aperçu demandé pour « Retrait sur place »
   * pouvait donc s'afficher sous « Livraison — Paris », avec les dates
   * de l'autre portée. Trois protections, et les trois sont
   * nécessaires -- même structure que la garde de contexte déjà
   * auditée :
   *
   *   1. RÉINITIALISATION SYNCHRONE : changer de portée vide l'aperçu
   *      dans le MÊME gestionnaire d'événement que le changement
   *      (`selectScope`), donc il ne peut exister aucun rendu où la
   *      portée a changé mais où l'aperçu de l'ancienne est encore
   *      visible.
   *   2. GARDE ANTI-RÉPONSE-TARDIVE : chaque demande retient la
   *      génération d'aperçu ET la portée visée ; une réponse qui
   *      revient après un changement est ABANDONNÉE, sans aucun
   *      `setState`.
   *   3. GARDE DE RENDU PAR PROVENANCE : l'aperçu n'est rendu que si
   *      `previewScopeKey === selectedScopeKey`. C'est l'invariant qui
   *      fait foi, y compris si une protection de timing était
   *      contournée.
   */
  const previewSeqRef = useRef(0);

  const selectScope = useCallback((key: string) => {
    previewSeqRef.current += 1;
    setPreview(null);
    setPreviewScopeKey(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setSelectedScopeKey(key);
  }, []);

  const runPreview = useCallback(async () => {
    if (!selected || !restaurantId || !selectedScopeKey) return;
    const seq = requestSeqRef.current;
    const previewSeq = ++previewSeqRef.current;
    const scopeAtRequest = selectedScopeKey;
    const isCurrent = () =>
      seq === requestSeqRef.current && previewSeq === previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    setPreviewScopeKey(null);
    try {
      const items = Number.parseInt(previewItems, 10);
      const subtotalRaw = previewSubtotal.trim();
      const result = await getCheckoutFulfillmentSchedulePreview({
        restaurantId,
        modeCode: selected.modeCode,
        postalCode: previewPostalCode.trim() === "" ? null : previewPostalCode.trim(),
        totalCount: Number.isFinite(items) && items > 0 ? items : 0,
        subtotal: subtotalRaw === "" ? null : Number(subtotalRaw),
      });
      if (!isCurrent()) return;
      // Commit ATOMIQUE : le résultat et la portée dont il provient
      // sont posés dans le même passage synchrone, jamais l'un sans
      // l'autre.
      setPreview(result);
      setPreviewScopeKey(scopeAtRequest);
    } catch {
      if (!isCurrent()) return;
      setPreviewError(translate(uiLangRef.current, "avPreviewFailed"));
      setPreviewScopeKey(scopeAtRequest);
    } finally {
      if (isCurrent()) setPreviewLoading(false);
    }
  }, [
    restaurantId,
    selected,
    selectedScopeKey,
    previewItems,
    previewPostalCode,
    previewSubtotal,
  ]);

  /** AUD-01 — provenance : l'aperçu n'est affichable que s'il provient
   *  de la portée actuellement sélectionnée. */
  const previewInScope = previewScopeKey !== null && previewScopeKey === selectedScopeKey;

  // ====================================================================
  // ÉDITION — brouillon, validation, enregistrement (issue #149)
  // ====================================================================

  /**
   * ═══ LECTURE AUTORITAIRE DE LA PORTÉE ═══ (remédiation R1 §2, F-01)
   *
   * `get_fulfillment_configuration` est la SEULE source du brouillon, de
   * sa référence ET des deux jetons de concurrence : UN appel, UNE
   * réponse, trois usages. Les lectures de listes (`schedules`, `v12`)
   * servent à lister les portées et à l'aperçu ; elles ne fournissent
   * JAMAIS le contenu d'un brouillon enregistrable.
   *
   * Protections, les mêmes que celles de l'aperçu :
   *   - un rang (`tokenSeqRef`) : une réponse en retard est abandonnée,
   *     sans aucun `setState` ;
   *   - une provenance (`snapshotKey`) : le brouillon n'est rendu que
   *     pour l'établissement et la portée dont il vient ;
   *   - le brouillon est VIDÉ dès que la portée change, et il n'en existe
   *     pas tant que l'autorité n'a pas répondu : aucune frappe ne peut
   *     donc être écrasée par l'arrivée d'une réponse réseau.
   *
   * Si l'autorité ne répond pas (fonction non installée, forme
   * inattendue, portée sans configuration), le brouillon est construit
   * depuis les listes, SANS jeton, et l'enregistrement reste fermé : on
   * ne signe jamais une version qu'on n'a pas lue.
   *
   * Cet effet ne dépend PAS des listes : un rafraîchissement de
   * `schedules` (après un enregistrement, par exemple) ne reconstruit
   * rien et n'efface aucune saisie.
   */
  const listsRef = useRef({ schedules, v12ByScope });
  listsRef.current = { schedules, v12ByScope };
  const selectedScopeKeyRef = useRef<string | null>(null);
  selectedScopeKeyRef.current = selectedScopeKey;

  useEffect(() => {
    tokenSeqRef.current += 1;
    const seq = tokenSeqRef.current;
    setDraft(null);
    setBaseline(null);
    setSnapshotKey(null);
    setConflict(null);
    setRebased(false);
    setSaveError(null);
    setSaved(false);
    setDraftOfferPending(false);
    if (!selectedScopeKey || !inContext || !restaurantId) return;
    const schedule = listsRef.current.schedules.find(
      (row) => scopeKeyOf(row.modeCode, row.fulfillmentRuleId) === selectedScopeKey
    );
    if (!schedule) return;
    const scopeKey = selectedScopeKey;
    const id = restaurantId;
    void (async () => {
      let built: AvailabilityDraft;
      let source: "authority" | "lists" = "authority";
      try {
        const read = await getFulfillmentConfiguration(
          id,
          schedule.modeCode,
          schedule.fulfillmentRuleId
        );
        if (seq !== tokenSeqRef.current) return;
        // Une portée visible dans les listes mais sans configuration
        // autoritaire est une INCOHÉRENCE : on n'invente ni jeton ni
        // configuration, on repasse en lecture seule.
        if (read === null) throw new Error("CSDJBO1_SCOPE_WITHOUT_AUTHORITY");
        built = draftFromAuthoritativeSnapshot(read);
      } catch {
        if (seq !== tokenSeqRef.current) return;
        source = "lists";
        built = draftFromServer({
          modeCode: schedule.modeCode,
          fulfillmentRuleId: schedule.fulfillmentRuleId,
          schedule,
          extension: listsRef.current.v12ByScope.get(scopeKey),
          updatedAt: null,
          revision: null,
        });
      }
      if (seq !== tokenSeqRef.current) return;
      // Commit ATOMIQUE : brouillon, référence et provenance dans le même
      // passage synchrone.
      setDraft(built);
      setBaseline(built);
      setSnapshotKey({ restaurantId: id, scopeKey, source });
    })();
  }, [restaurantId, selectedScopeKey, inContext, reloadNonce]);

  /** ÉDITION : rôle owner/manager. Elle ne touche RIEN côté serveur. */
  const canEditDraft = roleCanWrite && !saving;
  /** ENREGISTREMENT : rôle, contrat d'écriture disponible, snapshot
   *  autoritaire de CETTE portée, et aucun conflit non résolu. */
  const canSaveDraft =
    writeState.enabled && !saving && snapshotAuthoritative && conflictInScope === null;

  const issues: AvailabilityIssue[] = useMemo(
    () => (draft ? validateDraft(draft) : []),
    [draft]
  );
  /**
   * Le repli en brouillon est-il PROPOSÉ ? Deux chemins, un seul geste :
   * le serveur a refusé une configuration incomplète, ou la page sait
   * déjà qu'il la refuserait et n'a donc rien envoyé. Dans les deux cas
   * il faut que la même configuration DÉSACTIVÉE soit, elle, acceptable —
   * « même en brouillon, une capacité activée sans maximum valide, une
   * capacité sans date ou une grille horaire incohérente doivent rester
   * refusées » (contrat §4).
   */
  const draftFallbackOffered =
    draft !== null && (draftOfferPending || canFallBackToDraft(draft));

  const dirty = draft !== null && baseline !== null && isDraftDirty(draft, baseline);
  const changeCount =
    draft !== null && baseline !== null ? draftChangeCount(draft, baseline) : 0;

  // ====================================================================
  // ÉTAT AFFICHÉ AU COMMERÇANT (issue #156)
  // ====================================================================
  /** Nom humain d'un mode ; un code inconnu est affiché tel quel. */
  const modeText = (code: string): string => {
    const key = modeLabelKeyOf(code);
    return key ? t(key) : code;
  };
  /** L'état unique annoncé : jamais « enregistré » à un rôle en lecture
   *  seule, jamais « aucune modification » devant un conflit. */
  const editorStatus = editorStatusOf({
    roleCanWrite,
    contractAvailable: CSDJ_BO1_WRITE_CONTRACT.available,
    hasDraft: draft !== null,
    conflict: conflictInScope !== null,
    authoritative: snapshotAuthoritative,
    saving,
    saveFailed: saveError !== null,
    saved,
    dirty,
  });
  /** Phrase « ce que voit le client » : la version ENREGISTRÉE (lecture
   *  autoritaire) et, s'il y en a, la version en cours d'édition. */
  const persistedSentenceKey = baseline ? customerSentenceKeyOf(baseline) : null;
  const draftSentenceKey = draft ? customerSentenceKeyOf(draft) : null;
  const listSentenceKey = selected ? customerSentenceKey(selected) : null;
  /** Les deux lectures du serveur (liste / configuration) se
   *  contredisent : on le DIT, on ne choisit pas en silence. */
  const readsDisagree =
    snapshotAuthoritative &&
    persistedSentenceKey !== null &&
    listSentenceKey !== null &&
    persistedSentenceKey !== listSentenceKey;

  const issuesOf = useCallback(
    (section: AvailabilityIssue["section"]) => issues.filter((i) => i.section === section),
    [issues]
  );
  const rowHasIssue = useCallback(
    (rowId: string) => issues.some((i) => i.rowId === rowId),
    [issues]
  );

  const patchDraft = useCallback((patch: Partial<AvailabilityDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaved(false);
    setSaveError(null);
  }, []);

  const resetDraft = useCallback(() => {
    setDraft(baseline);
    setSaved(false);
    setSaveError(null);
  }, [baseline]);

  const toggleWeekday = useCallback(
    (weekday: number) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const present = prev.preparationWeekdays.includes(weekday);
        return {
          ...prev,
          preparationWeekdays: present
            ? prev.preparationWeekdays.filter((d) => d !== weekday)
            : [...prev.preparationWeekdays, weekday].sort((a, b) => a - b),
        };
      });
      setSaved(false);
      setSaveError(null);
    },
    []
  );

  const addWindow = useCallback((weekday: number) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            windows: [
              ...prev.windows,
              { rowId: newRowId("win"), weekday, startsAt: "", endsAt: "" },
            ],
          }
        : prev
    );
    setSaved(false);
  }, []);

  const addSlot = useCallback((weekday: number) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            slots: [
              ...prev.slots,
              { rowId: newRowId("slot"), weekday, slotKey: "", startsAt: "", endsAt: "" },
            ],
          }
        : prev
    );
    setSaved(false);
  }, []);

  const patchWindow = useCallback((rowId: string, patch: Partial<{ startsAt: string; endsAt: string }>) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            windows: prev.windows.map((w) => (w.rowId === rowId ? { ...w, ...patch } : w)),
          }
        : prev
    );
    setSaved(false);
  }, []);

  const patchSlot = useCallback(
    (rowId: string, patch: Partial<{ slotKey: string; startsAt: string; endsAt: string }>) => {
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              slots: prev.slots.map((x) => (x.rowId === rowId ? { ...x, ...patch } : x)),
            }
          : prev
      );
      setSaved(false);
    },
    []
  );

  /** Retrait d'une LIGNE du brouillon. Ce n'est pas une suppression de
   *  portée : rien n'est supprimé côté serveur tant que la
   *  configuration n'est pas enregistrée, et la portée elle-même ne se
   *  supprime jamais depuis cette page. */
  const removeRow = useCallback(
    (list: "windows" | "slots" | "closures" | "preparationClosures", rowId: string) => {
      setDraft((prev) =>
        prev ? { ...prev, [list]: prev[list].filter((row) => row.rowId !== rowId) } : prev
      );
      setSaved(false);
    },
    []
  );

  const addClosure = useCallback((list: "closures" | "preparationClosures") => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            [list]: [
              ...prev[list],
              { rowId: newRowId(list === "closures" ? "clo" : "pclo"), closedOn: "", label: "" },
            ],
          }
        : prev
    );
    setSaved(false);
  }, []);

  const patchClosure = useCallback(
    (
      list: "closures" | "preparationClosures",
      rowId: string,
      patch: Partial<{ closedOn: string; label: string }>
    ) => {
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              [list]: prev[list].map((row) =>
                row.rowId === rowId ? { ...row, ...patch } : row
              ),
            }
          : prev
      );
      setSaved(false);
    },
    []
  );

  /**
   * ENREGISTREMENT — un seul appel, une seule transaction côté serveur.
   *
   * Trois refus AVANT tout réseau : pas de brouillon, refus local de
   * validation, ou contrat d'écriture indisponible. Le troisième est
   * levé par le service lui-même
   * (AvailabilityWriteUnavailableError) : c'est volontaire, pour que le
   * verrou tienne même si une interface future oubliait de le tester.
   */
  /**
   * Relit la version du serveur après un refus de concurrence et la garde
   * À PART : le brouillon local n'est pas touché, et aucun jeton n'est
   * installé sur lui. Rien n'est enregistré ici, jamais.
   */
  const loadServerVersion = useCallback(
    async (target: { modeCode: string; fulfillmentRuleId: string | null }) => {
      if (!restaurantId) return;
      tokenSeqRef.current += 1;
      const tokenSeq = tokenSeqRef.current;
      const scopeKey = scopeKeyOf(target.modeCode, target.fulfillmentRuleId);
      const id = restaurantId;
      let server: AvailabilityDraft | null = null;
      try {
        const reread = await getFulfillmentConfiguration(
          id,
          target.modeCode,
          target.fulfillmentRuleId
        );
        if (reread !== null) server = draftFromAuthoritativeSnapshot(reread);
      } catch {
        // L'autorité ne répond pas, ou répond de travers : on ne
        // prétend pas avoir rechargé.
        server = null;
      }
      if (tokenSeq !== tokenSeqRef.current) return;
      setConflict({ restaurantId: id, scopeKey, server });
    },
    [restaurantId]
  );

  /**
   * ENREGISTREMENT — un seul appel, une seule transaction côté serveur.
   *
   * Trois refus AVANT tout réseau : pas de brouillon, refus local de
   * validation, ou contrat d'écriture indisponible. Le troisième est
   * levé par le service lui-même
   * (AvailabilityWriteUnavailableError) : c'est volontaire, pour que le
   * verrou tienne même si une interface future oubliait de le tester.
   *
   * Les deux jetons voyagent AVEC le brouillon : ils ont été posés au
   * moment où le snapshot autoritaire a été lu, avec la configuration
   * dont ce brouillon est issu. Rien n'est injecté ici.
   */
  const saveConfiguration = useCallback(async (options: { asDraft?: boolean } = {}) => {
    if (!draft || !restaurantId || !canSaveDraft) return;
    // « Enregistrer en brouillon » = la MÊME configuration, désactivée.
    // Jamais un second chemin d'écriture, jamais une charge partielle.
    const intended = options.asDraft ? draftAsInactive(draft) : draft;
    if (validateDraft(intended).length > 0) return;
    const seq = requestSeqRef.current;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    setRebased(false);
    setDraftOfferPending(false);
    try {
      const payload = buildSaveFulfillmentConfigurationPayload(intended);
      const next = await saveFulfillmentConfiguration(restaurantId, payload);
      if (seq !== requestSeqRef.current) return;
      const savedScope = scopeKeyOf(intended.modeCode, intended.fulfillmentRuleId);
      setSchedules(next.schedules);
      setV12(next.v12);
      // La réponse du serveur est le NOUVEAU snapshot indivisible :
      // brouillon, référence et jetons en sortent ensemble. Après un
      // enregistrement, « modifié » retombe parce que la base et
      // l'écran disent la même chose, pas parce qu'on a baissé un drapeau.
      let fresh: AvailabilityDraft | null = null;
      try {
        fresh = draftFromAuthoritativeSnapshot(next.authoritative);
      } catch {
        fresh = null;
      }
      if (fresh !== null && selectedScopeKeyRef.current === savedScope) {
        tokenSeqRef.current += 1;
        setDraft(fresh);
        setBaseline(fresh);
        setSnapshotKey({ restaurantId, scopeKey: savedScope, source: "authority" });
        setConflict(null);
        setSaved(true);
      } else {
        // Snapshot inexploitable, ou portée changée pendant l'écriture :
        // on repart d'une lecture autoritaire, jamais d'un mélange.
        setReloadNonce((n) => n + 1);
      }
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      if (error instanceof AvailabilityWriteUnavailableError) {
        setSaveError(translate(uiLangRef.current, "avSaveDisabledWhyContract"));
      } else {
        // Jamais le message serveur brut : seul le CODE du préfixe est
        // lu, et il devient une phrase. Le détail du serveur n'est pas
        // nettoyé — il n'est pas lu du tout.
        const code = serverRefusalCode(error);
        setSaveError(translate(uiLangRef.current, saveErrorKey(error)));

        // ── CONCURRENCE : garder deux versions SÉPARÉES ────────────────
        //    Le brouillon local reste ce qu'il est ; la version du
        //    serveur est relue et gardée à part ; l'enregistrement est
        //    SUSPENDU jusqu'à un choix explicite du commerçant. Aucun
        //    jeton neuf n'est jamais attaché à ce brouillon ancien.
        if (code === "CSDJBO1_STALE_CONFIGURATION") {
          await loadServerVersion(intended);
        }

        // ── INCOMPLÈTE : proposer le BROUILLON, après confirmation ─────
        //    Ici on ne peut PAS s'appuyer sur la validation locale : si
        //    elle avait vu le manque, la charge ne serait jamais partie.
        //    Le serveur sait quelque chose de plus, et c'est son droit.
        //    La seule condition qui reste à vérifier est celle que le
        //    contrat nomme : la même configuration DÉSACTIVÉE doit être
        //    acceptable — une capacité ou une grille absurde ne devient
        //    pas acceptable parce qu'on retire l'activation.
        if (
          code === "CSDJBO1_INCOMPLETE_CONFIGURATION" &&
          intended.enabled &&
          issuesBlockingDraft(intended).length === 0
        ) {
          setDraftOfferPending(true);
        }
      }
    } finally {
      if (seq === requestSeqRef.current) setSaving(false);
    }
  }, [draft, restaurantId, canSaveDraft, loadServerVersion]);

  /** Résolution 1 — abandonner SES modifications, reprendre le serveur. */
  const takeServerVersion = useCallback(() => {
    if (!conflictInScope?.server || !restaurantId || !selectedScopeKey) return;
    const server = conflictInScope.server;
    tokenSeqRef.current += 1;
    setDraft(server);
    setBaseline(server);
    setSnapshotKey({ restaurantId, scopeKey: selectedScopeKey, source: "authority" });
    setConflict(null);
    setSaveError(null);
    setSaved(false);
    setRebased(false);
  }, [conflictInScope, restaurantId, selectedScopeKey]);

  /**
   * Résolution 2 — REBASE CONFIRMÉ : ses modifications, appliquées sur la
   * version du serveur. Le brouillon rebasé repart avec les jetons de
   * CETTE version du serveur, la seule qu'il prolonge ; il n'est pas
   * enregistré pour autant.
   */
  const rebaseOnServer = useCallback(() => {
    if (!conflictInScope?.server || !draft || !baseline) return;
    if (!restaurantId || !selectedScopeKey) return;
    const server = conflictInScope.server;
    const next = rebaseDraft(baseline, draft, server);
    tokenSeqRef.current += 1;
    setDraft(next);
    setBaseline(server);
    setSnapshotKey({ restaurantId, scopeKey: selectedScopeKey, source: "authority" });
    setConflict(null);
    setSaveError(null);
    setSaved(false);
    setRebased(true);
  }, [conflictInScope, draft, baseline, restaurantId, selectedScopeKey]);

  /** Résolution 0 — la relecture a échoué : la refaire, sans rien résoudre. */
  const retryServerRead = useCallback(() => {
    if (!draft) return;
    void loadServerVersion(draft);
  }, [draft, loadServerVersion]);

  /**
   * Relire les DEUX lectures du serveur (liste + configuration) sans
   * changer de portée. Refusé quand il y a des modifications non
   * enregistrées : une relecture les effacerait, et rien ne s'efface en
   * silence.
   */
  const refreshFromServer = useCallback(async () => {
    if (!restaurantId || dirty) return;
    const seq = requestSeqRef.current;
    try {
      const [next, nextV12] = await Promise.all([
        getMerchantFulfillmentSchedules(restaurantId),
        getMerchantFulfillmentSchedulesV12(restaurantId),
      ]);
      if (seq !== requestSeqRef.current) return;
      setSchedules(next);
      setV12(nextV12);
      setReloadNonce((n) => n + 1);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setSaveError(translate(uiLangRef.current, readErrorKey(error)));
    }
  }, [restaurantId, dirty]);

  /** Divergences entre vos modifications et la version du serveur. */
  const divergences: DraftDivergence[] = useMemo(
    () =>
      conflictInScope?.server && draft && baseline
        ? diffDrafts(baseline, draft, conflictInScope.server)
        : [],
    [conflictInScope, draft, baseline]
  );

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">{t("mcLoading")}</main>;
  }

  if (unavailableContextId) {
    return (
      <main className="p-6">
        <div
          role="alert"
          data-context-unavailable={unavailableContextId}
          className="mx-auto max-w-2xl rounded-2xl bg-white p-6 text-sm font-semibold text-red-700 shadow-sm"
        >
          {t("dsContextUnavailable")}
        </div>
      </main>
    );
  }

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? operatorRestaurantName ?? t("avTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={handleSelectRestaurant}
      />

      <main
        className="mx-auto max-w-5xl px-4 py-6 pb-28"
        dir={uiLang === "ar" ? "rtl" : "ltr"}
        data-availability-page="csdj-bo1"
      >
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          &larr; {t("dsBackToOrders")}
        </a>

        <h2 className="text-xl font-black text-stone-900 sm:text-2xl">{t("avTitle")}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-stone-600">{t("avHint")}</p>

        {/* ÉTAT DU CONTRAT D'ÉCRITURE — en tête, parce qu'il gouverne
            toute la page. `role="status"` et non `alert` : ce n'est pas
            une avarie, c'est l'état voulu du lot. Le texte dit la
            raison ; la couleur ne porte aucune information seule. */}
        {!CSDJ_BO1_WRITE_CONTRACT.available && (
          <div
            role="status"
            data-write-contract={CSDJ_BO1_WRITE_CONTRACT.reason}
            className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4"
          >
            <p className="text-sm font-bold text-amber-900">{t("avWriteContractPending")}</p>
            <p className="mt-2 text-sm leading-relaxed text-amber-900">
              {t("avWriteContractPendingDetail")}
            </p>
          </div>
        )}

        {!roleCanWrite && (
          <p className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-700">
            {isOperator ? t("avOperatorReadOnly") : t("avReadOnly")}
          </p>
        )}

        {v12.status === "absent" && (
          <p className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            {t("avV12NotDeployed")}
          </p>
        )}
        {/* AUD-04 (audit Cat Greco) — L'ÉTAT « REFUSÉ » NE DOIT PAS ÊTRE
            MUET. La lecture v1.2 rend trois statuts d'échec ; seuls deux
            étaient affichés, et un refus de rôle laissait donc la section
            v1.2 silencieusement vide, sans que le commerçant sache
            pourquoi. Le message est traduit, NON TECHNIQUE, et ne révèle
            rien : ni code serveur, ni nom de fonction, ni identifiant
            d'établissement. Le comportement d'autorisation lui-même est
            inchangé -- c'est le serveur qui refuse, et la page ne tente
            aucun contournement. */}
        {v12.status === "forbidden" && (
          <p
            role="status"
            data-v12-status="forbidden"
            className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-700"
          >
            {t("avV12Forbidden")}
          </p>
        )}
        {v12.status === "error" && (
          <p data-v12-status="error" className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-700">
            {t("avV12ReadFailed")}
          </p>
        )}

        {dataLoading && <p className="mt-4 text-sm text-stone-500">{t("mcLoading")}</p>}

        {!dataLoading && pageError && (
          <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {pageError}
          </p>
        )}

        {!dataLoading && !pageError && inContext && schedules.length === 0 && (
          <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-600">
            <p>{t("avScopeEmpty")}</p>
          </div>
        )}

        {!dataLoading && !pageError && inContext && schedules.length > 0 && (
          <>
            {/* ===== §1 — PORTÉES ===== */}
            <section className="mt-6 overflow-hidden rounded-2xl border border-stone-200 bg-white">
              <div className="border-b border-stone-100 p-4">
                <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                  1
                </p>
                <h3 className="mt-1 text-base font-extrabold text-stone-900">
                  {t("avScopeTitle")}
                </h3>
                <p className="mt-2 text-sm text-stone-600">{t("avScopeHint")}</p>
              </div>

              {/* Mobile : un sélecteur, pas un tableau. */}
              <div className="p-4 sm:hidden">
                <label
                  className="mb-1.5 block text-xs font-bold text-stone-700"
                  htmlFor="av-scope-select"
                >
                  {t("avScopeSelectLabel")}
                </label>
                <select
                  id="av-scope-select"
                  value={selectedScopeKey ?? ""}
                  onChange={(e) => selectScope(e.target.value)}
                  className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm"
                >
                  {schedules.map((s) => {
                    const key = scopeKeyOf(s.modeCode, s.fulfillmentRuleId);
                    return (
                      <option key={key} value={key}>
                        {modeText(s.modeCode)}
                        {s.fulfillmentRuleId ? ` (${t("avScopeDeliveryRule")})` : ""} —{" "}
                        {t(STATE_KEY[scopeStateOf(s)])}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Bureau : le tableau des portées. */}
              <table className="hidden w-full border-collapse text-sm sm:table">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-stone-500">
                    <th scope="col" className="px-4 py-3 font-extrabold">
                      {t("avScopeColMode")}
                    </th>
                    <th scope="col" className="px-2 py-3 font-extrabold">
                      {t("avScopeColCustomer")}
                    </th>
                    <th scope="col" className="px-2 py-3 font-extrabold">
                      {t("avScopeColState")}
                    </th>
                    <th scope="col" className="px-4 py-3 font-extrabold">
                      <span className="sr-only">{t("avScopeSelectLabel")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => {
                    const key = scopeKeyOf(s.modeCode, s.fulfillmentRuleId);
                    const state = scopeStateOf(s);
                    const isSelected = key === selectedScopeKey;
                    return (
                      <tr
                        key={key}
                        className={
                          "border-t border-stone-100 " + (isSelected ? "bg-amber-50" : "")
                        }
                      >
                        <td className="px-4 py-3">
                          <strong className="text-stone-900">{modeText(s.modeCode)}</strong>
                          <span className="mt-0.5 block text-xs text-stone-500">
                            {s.fulfillmentRuleId
                              ? t("avScopeDeliveryRule")
                              : t("avScopeModeOnly")}
                          </span>
                        </td>
                        <td className="px-2 py-3 text-stone-700">
                          {t(
                            isSelected && persistedSentenceKey
                              ? persistedSentenceKey
                              : customerSentenceKey(s)
                          )}
                        </td>
                        <td className="px-2 py-3">
                          <span
                            data-scope-state={state}
                            className={
                              "inline-block rounded-full px-2.5 py-1 text-xs font-extrabold " +
                              STATE_BADGE[state]
                            }
                          >
                            {t(STATE_KEY[state])}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => selectScope(key)}
                            aria-pressed={isSelected}
                            className="min-h-11 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-800"
                          >
                            {t("avScopeReview")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <p className="px-4 pb-2 text-xs leading-relaxed text-stone-600">
                {t("avScopeWhy")}
              </p>
              <p className="px-4 pb-3 text-xs leading-relaxed text-stone-500">
                {t("avStateSameEffect")}
              </p>
              {/* Point R2 n° 7 : désactivation plutôt que suppression.
                  Aucun bouton de suppression n'est rendu nulle part. */}
              <p className="mx-4 mb-4 rounded-xl border-l-4 border-emerald-700 bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900">
                {t("avNoDeletion")}
              </p>
            </section>

            {selected && (
              <>
                {/* ===== BANDEAU DE PORTÉE ===== */}
                <div className="mt-4 rounded-2xl border border-stone-300 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-full bg-stone-900 px-2.5 py-1 text-xs font-extrabold text-white">
                      {t("avScopeBannerCurrent")}
                    </span>
                    <strong className="text-base text-stone-900">
                      {modeText(selected.modeCode)}
                      {selected.fulfillmentRuleId ? ` — ${t("avScopeDeliveryRule")}` : ""}
                    </strong>
                    <span className="flex-1" />
                    <label
                      className="flex items-center gap-2 text-sm font-bold text-stone-700"
                      htmlFor="av-activate"
                    >
                      {t("avActivateLabel")}
                    </label>
                    {/* ACTIVATION — un réglage du BROUILLON, pas un
                        interrupteur immédiat : « proposer des dates »
                        part au serveur dans la même transaction que le
                        reste (issue #149). Cocher sans offre ne prend
                        donc jamais effet : la validation rend
                        `offer_missing` et l'enregistrement reste bloqué,
                        avec le manque nommé juste en dessous.

                        Tant que le serveur n'a pas rendu la
                        configuration de cette portée (`draft === null`),
                        la case est inactive : on n'affiche pas une
                        valeur par défaut comme si elle était la vraie. */}
                    <input
                      id="av-activate"
                      type="checkbox"
                      checked={draft?.enabled ?? selected.enabled}
                      onChange={(e) => patchDraft({ enabled: e.target.checked })}
                      disabled={writeDisabled || !canEditDraft || draft === null}
                      aria-describedby={
                        writeDisabled ? "av-write-disabled-reason" : "av-activate-help"
                      }
                      className="h-5 w-5 accent-amber-700"
                    />
                  </div>

                  {/* La raison d'un contrôle inactif n'est écrite que
                      lorsqu'il est réellement inactif : une phrase
                      « inactif » à côté d'un contrôle actif est un
                      mensonge (issue #156, constat 1). */}
                  {writeDisabled ? (
                    <p
                      id="av-write-disabled-reason"
                      className="mt-2 text-xs leading-relaxed text-stone-600"
                    >
                      {t(writeDisabledKey)}
                    </p>
                  ) : (
                    <p
                      id="av-activate-help"
                      className="mt-2 text-xs leading-relaxed text-stone-600"
                    >
                      {t("avActivateHelp")}
                    </p>
                  )}

                  <p
                    role="status"
                    data-editor-status={editorStatus}
                    className={
                      "mt-2 inline-block rounded-full px-3 py-1 text-xs font-extrabold " +
                      (editorStatus === "clean" || editorStatus === "saved"
                        ? "bg-emerald-50 text-emerald-900"
                        : editorStatus === "conflict" || editorStatus === "error"
                          ? "bg-red-50 text-red-900"
                          : "bg-amber-50 text-amber-900")
                    }
                  >
                    <span className="sr-only">{t("avStatusLabel")} : </span>
                    {t(EDITOR_STATUS_KEY[editorStatus])}
                  </p>

                  <details data-tech-details="true" className="mt-3">
                    <summary className="cursor-pointer text-xs font-extrabold text-amber-700">
                      {t("avTechTitle")}
                    </summary>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-stone-600">
                      <code className="rounded bg-stone-100 px-1.5 py-0.5">
                        {selected.modeCode}
                      </code>
                      <span>
                        {t("avScopeTimezone")} <strong>{selected.timezone}</strong>
                      </span>
                      <span
                        data-schedule-method={method}
                        className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-extrabold text-blue-900"
                      >
                        {method === "v1.2" ? t("avMethodV12") : t("avMethodV1")}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-stone-600">
                      {method === "v1.2" ? t("avMethodV12Hint") : t("avMethodV1Hint")}
                    </p>
                  </details>
                </div>

                {/* ===== CE QUE VERRONT LES CLIENTS =====
                    La phrase vient du MÊME objet que le formulaire (le
                    brouillon de la portée), et la version enregistrée
                    est nommée à part : un réglage modifié mais non
                    enregistré est dit « modifié, non enregistré » au
                    lieu de contredire silencieusement le résumé. */}
                <section
                  data-customer-summary={
                    draft === null ? "loading" : dirty ? "unsaved" : "saved"
                  }
                  className="mt-4 rounded-2xl border border-stone-200 bg-white p-4"
                >
                  <h3 className="text-sm font-extrabold text-stone-900">
                    {t("avSummaryTitle")}
                  </h3>
                  {draft === null || draftSentenceKey === null ? (
                    <p className="mt-2 text-sm text-stone-600">{t("avStatusLoading")}</p>
                  ) : (
                    <>
                      {persistedSentenceKey && (
                        <p data-summary-saved={persistedSentenceKey} className="mt-2 text-sm text-stone-800">
                          <strong>{t("avSummarySaved")}</strong> — {t(persistedSentenceKey)}
                        </p>
                      )}
                      {dirty && (
                        <div
                          data-summary-unsaved={draftSentenceKey}
                          className="mt-2 rounded-xl border-l-4 border-amber-600 bg-amber-50 p-3 text-sm text-amber-950"
                        >
                          <p>
                            <strong>{t("avStatusDirty")}</strong> — {t(draftSentenceKey)}
                          </p>
                          <p className="mt-1 text-xs">{t("avSummaryUnsaved")}</p>
                        </div>
                      )}
                      {!draft.enabled && (
                        <p className="mt-2 text-xs text-stone-600">{t("avSummaryInactive")}</p>
                      )}
                      <h4 className="mt-3 text-xs font-extrabold uppercase tracking-wider text-stone-500">
                        {t("avSummaryDaysTitle")}
                      </h4>
                      <ul
                        data-weekly-summary="true"
                        className="mt-2 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 lg:grid-cols-4"
                      >
                        {weeklyScheduleSummary(draft).map((day) => (
                          <li
                            key={day.weekday}
                            data-summary-weekday={day.weekday}
                            data-summary-closed={day.ranges.length === 0 ? "true" : "false"}
                            className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-sm"
                          >
                            <strong className="text-stone-900">
                              {t(weekdayLabelKey(day.weekday))}
                            </strong>
                            <span className="block text-stone-700">
                              {day.ranges.length === 0 ? t("avDayClosed") : day.ranges.join(" · ")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {readsDisagree && persistedSentenceKey && listSentenceKey && (
                    <div
                      role="alert"
                      data-reads-disagree="true"
                      className="mt-3 rounded-xl border-l-4 border-red-700 bg-red-50 p-3 text-sm text-red-900"
                    >
                      <p>
                        {t("avSummaryMismatch", {
                          list: t(listSentenceKey),
                          config: t(persistedSentenceKey),
                        })}
                      </p>
                      <button
                        type="button"
                        id="av-reload-server"
                        onClick={() => void refreshFromServer()}
                        disabled={dirty}
                        className="mt-2 min-h-11 rounded-xl border border-stone-900 bg-white px-4 py-2 text-sm font-extrabold text-stone-900 disabled:text-stone-400"
                      >
                        {t("avSummaryReload")}
                      </button>
                    </div>
                  )}
                </section>

                {/* Lecture complète indisponible : valeurs issues de la
                    liste, enregistrement fermé -- dit en tête, pas
                    seulement dans la barre du bas. */}
                {draft !== null && !snapshotAuthoritative && (
                  <div
                    role="alert"
                    data-unverified="true"
                    className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4"
                  >
                    <p className="text-sm text-amber-950">{t("avUnverifiedNote")}</p>
                    <button
                      type="button"
                      id="av-unverified-retry"
                      onClick={() => void refreshFromServer()}
                      disabled={dirty}
                      className="mt-2 min-h-11 rounded-xl border border-stone-900 bg-white px-4 py-2 text-sm font-extrabold text-stone-900 disabled:text-stone-400"
                    >
                      {t("avSummaryReload")}
                    </button>
                  </div>
                )}

                {/* ===== CONFLIT DE CONCURRENCE (F-01) =====
                    Deux versions SÉPARÉES : la vôtre (le brouillon) et
                    celle du serveur. Rien n'est enregistré, et aucun
                    jeton neuf n'est attaché à votre brouillon, tant que
                    vous n'avez pas choisi. */}
                {conflictInScope && (
                  <section
                    role="alert"
                    data-conflict="true"
                    data-conflict-readable={conflictInScope.server ? "true" : "false"}
                    className="mt-4 rounded-2xl border-2 border-amber-700 bg-amber-50 p-4"
                  >
                    <h3 className="text-sm font-extrabold text-amber-950">
                      {t("avConflictTitle")}
                    </h3>
                    {conflictInScope.server === null ? (
                      <>
                        <p className="mt-2 text-sm leading-relaxed text-amber-950">
                          {t("avConflictUnreadable")}
                        </p>
                        <button
                          type="button"
                          id="av-conflict-retry"
                          onClick={retryServerRead}
                          className="mt-3 min-h-11 rounded-xl border border-stone-900 bg-white px-4 py-2.5 text-sm font-extrabold text-stone-900"
                        >
                          {t("avConflictRetry")}
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="mt-2 text-sm leading-relaxed text-amber-950">
                          {t("avConflictIntro")}
                        </p>
                        <div className="mt-3 overflow-x-auto">
                          <table className="w-full text-start text-sm">
                            <thead>
                              <tr className="text-xs font-extrabold text-stone-700">
                                <th className="py-1 pe-3 text-start" scope="col" />
                                <th className="py-1 pe-3 text-start" scope="col">
                                  {t("avConflictColMine")}
                                </th>
                                <th className="py-1 pe-3 text-start" scope="col">
                                  {t("avConflictColServer")}
                                </th>
                                <th className="py-1 text-start" scope="col" />
                              </tr>
                            </thead>
                            <tbody>
                              {divergences.map((item) => (
                                <tr
                                  key={item.field}
                                  data-conflict-field={item.field}
                                  data-conflict-origin={item.origin}
                                  className="border-t border-amber-200 align-top"
                                >
                                  <th scope="row" className="py-1.5 pe-3 text-start font-bold text-stone-900">
                                    {t(CONFLICT_FIELD_LABEL[item.field])}
                                  </th>
                                  <td className="py-1.5 pe-3 text-stone-900">
                                    {draft ? conflictValue(draft, item.field) : ""}
                                  </td>
                                  <td className="py-1.5 pe-3 text-stone-900">
                                    {conflictValue(conflictInScope.server as AvailabilityDraft, item.field)}
                                  </td>
                                  <td className="py-1.5 text-xs font-bold text-amber-950">
                                    {t(CONFLICT_ORIGIN_KEY[item.origin])}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {divergences.length === 0 && (
                            <p className="mt-2 text-sm text-stone-800" data-conflict-identical="true">
                              {t("avConflictNoDifference")}
                            </p>
                          )}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-3">
                          <button
                            type="button"
                            id="av-conflict-rebase"
                            onClick={rebaseOnServer}
                            className="min-h-11 rounded-xl border border-stone-900 bg-stone-900 px-4 py-2.5 text-sm font-extrabold text-white"
                          >
                            {t("avConflictKeepMine")}
                          </button>
                          <button
                            type="button"
                            id="av-conflict-take-server"
                            onClick={takeServerVersion}
                            className="min-h-11 rounded-xl border border-stone-900 bg-white px-4 py-2.5 text-sm font-extrabold text-stone-900"
                          >
                            {t("avConflictTakeServer")}
                          </button>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-stone-700">
                          {t("avConflictKeepMineHint")}
                        </p>
                      </>
                    )}
                  </section>
                )}
                {rebased && !conflictInScope && (
                  <p
                    role="status"
                    data-conflict-rebased="true"
                    className="mt-4 rounded-2xl border border-stone-300 bg-white p-3 text-sm text-stone-900"
                  >
                    {t("avConflictRebasedNote")}
                  </p>
                )}

                {draft === null ? (
                  <p
                    role="status"
                    data-draft-loading="true"
                    className="mt-4 rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-600"
                  >
                    {t("avStatusLoading")}
                  </p>
                ) : (
                <>
                {/* ===== §2 — JOURS ET HORAIRES ===== */}
                <section className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
                  <div className="border-b border-stone-100 p-4">
                    <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                      2
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-stone-900">
                      {t("avOffersTitle")}
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 gap-5 p-4 sm:grid-cols-2">
                    <div>
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-date-mode"
                      >
                        {t("avDateModeLabel")}
                      </label>
                      <select
                        id="av-date-mode"
                        value={draft?.dateSelectionMode ?? DATE_MODE_INFORMATIONAL}
                        onChange={(e) => patchDraft({ dateSelectionMode: e.target.value })}
                        disabled={!canEditDraft}
                        className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                      >
                        {CHECKOUT_DATE_SELECTION_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {t(dateModeKey(mode))}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-slot-mode"
                      >
                        {t("avSlotModeLabel")}
                      </label>
                      <select
                        id="av-slot-mode"
                        value={draft?.slotSelectionMode ?? SLOT_MODE_NONE}
                        onChange={(e) => patchDraft({ slotSelectionMode: e.target.value })}
                        disabled={!canEditDraft}
                        className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                      >
                        {CHECKOUT_SLOT_SELECTION_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {t(slotModeKey(mode))}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avSlotModeHint")}
                      </p>
                    </div>

                    {draft?.slotSelectionMode === SLOT_MODE_FREE_TIME && (
                      <div>
                        <label
                          className="mb-1.5 block text-xs font-bold text-stone-700"
                          htmlFor="av-granularity"
                        >
                          {t("avGranularityLabel")}
                        </label>
                        <input
                          id="av-granularity"
                          type="number"
                          min={5}
                          max={240}
                          value={draft?.timeGranularityMinutes ?? ""}
                          onChange={(e) => patchDraft({ timeGranularityMinutes: e.target.value })}
                          disabled={!canEditDraft}
                          className="min-h-11 w-28 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                        />
                        <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                          {t("avGranularityHint")}
                        </p>
                      </div>
                    )}

                    <div>
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-horizon"
                      >
                        {t("avHorizonLabel")}
                      </label>
                      <input
                        id="av-horizon"
                        type="number"
                        min={0}
                        max={365}
                        value={draft?.bookingHorizonDays ?? ""}
                        onChange={(e) => patchDraft({ bookingHorizonDays: e.target.value })}
                        disabled={!canEditDraft}
                        className="min-h-11 w-28 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                      />
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avHorizonHint")}
                      </p>
                    </div>
                  </div>

                  <p className="mx-4 rounded-xl border-l-4 border-amber-600 bg-amber-50 p-3 text-sm leading-relaxed text-stone-800">
                    {draft?.slotSelectionMode === SLOT_MODE_FIXED_SLOTS
                      ? t("avAuthorityNoteFixedSlots")
                      : t("avAuthorityNoteWindows")}
                  </p>

                  <div className="p-4">
                    <h4 className="text-sm font-extrabold text-stone-900">
                      {draft?.slotSelectionMode === SLOT_MODE_FIXED_SLOTS
                        ? t("avSlotsTitle")
                        : t("avWindowsTitle")}
                    </h4>
                    <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                      {t("avDayClosedHint")}
                    </p>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {WEEKDAY_DISPLAY_ORDER.map((weekday) => {
                        const useSlots = draft?.slotSelectionMode === SLOT_MODE_FIXED_SLOTS;
                        const daySlots = (draft?.slots ?? []).filter((x) => x.weekday === weekday);
                        const dayWindows = (draft?.windows ?? []).filter(
                          (w) => w.weekday === weekday
                        );
                        const count = useSlots ? daySlots.length : dayWindows.length;
                        const dayLabel = t(weekdayLabelKey(weekday));
                        return (
                          <div
                            key={weekday}
                            data-weekday={weekday}
                            className={
                              "rounded-xl border p-3 " +
                              (count === 0
                                ? "border-dashed border-stone-300 bg-stone-50"
                                : "border-stone-200")
                            }
                          >
                            <div className="flex items-center justify-between gap-2">
                              <strong className="text-sm text-stone-900">{dayLabel}</strong>
                              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-extrabold text-stone-700">
                                {count === 0
                                  ? t("avDayClosed")
                                  : useSlots
                                    ? t("avSlotCount", { count })
                                    : t("avWindowCount", { count })}
                              </span>
                            </div>

                            {/* ÉDITEUR DE LIGNES. Chaque champ porte son
                                propre libellé accessible : le jour n'est
                                pas devinable depuis un lecteur d'écran si
                                on ne le répète pas ici. */}
                            {count > 0 && (
                              <ul className="mt-2 list-none space-y-2 p-0">
                                {useSlots
                                  ? daySlots.map((row) => (
                                      <li
                                        key={row.rowId}
                                        className={
                                          "flex flex-wrap items-center gap-2 rounded-lg border p-2 " +
                                          (rowHasIssue(row.rowId)
                                            ? "border-red-400 bg-red-50"
                                            : "border-stone-200")
                                        }
                                      >
                                        <input
                                          type="text"
                                          value={row.slotKey}
                                          onChange={(e) =>
                                            patchSlot(row.rowId, { slotKey: e.target.value })
                                          }
                                          disabled={!canEditDraft}
                                          aria-label={t("avSlotKeyAria", { day: dayLabel })}
                                          placeholder={t("avSlotKeyPlaceholder")}
                                          className="min-h-11 flex-1 basis-28 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                                        />
                                        <input
                                          type="time"
                                          step={60}
                                          value={row.startsAt}
                                          onChange={(e) =>
                                            patchSlot(row.rowId, { startsAt: e.target.value })
                                          }
                                          disabled={!canEditDraft}
                                          aria-label={t("avStartAria", { day: dayLabel })}
                                          className="min-h-11 w-28 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                                        />
                                        <input
                                          type="time"
                                          step={60}
                                          value={row.endsAt}
                                          onChange={(e) =>
                                            patchSlot(row.rowId, { endsAt: e.target.value })
                                          }
                                          disabled={!canEditDraft}
                                          aria-label={t("avEndAria", { day: dayLabel })}
                                          className="min-h-11 w-28 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => removeRow("slots", row.rowId)}
                                          disabled={!canEditDraft}
                                          aria-label={t("avRowRemoveSlotAria", { day: dayLabel })}
                                          className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-700"
                                        >
                                          {t("avRowRemove")}
                                        </button>
                                      </li>
                                    ))
                                  : dayWindows.map((row) => (
                                      <li
                                        key={row.rowId}
                                        className={
                                          "flex flex-wrap items-center gap-2 rounded-lg border p-2 " +
                                          (rowHasIssue(row.rowId)
                                            ? "border-red-400 bg-red-50"
                                            : "border-stone-200")
                                        }
                                      >
                                        <input
                                          type="time"
                                          step={60}
                                          value={row.startsAt}
                                          onChange={(e) =>
                                            patchWindow(row.rowId, { startsAt: e.target.value })
                                          }
                                          disabled={!canEditDraft}
                                          aria-label={t("avStartAria", { day: dayLabel })}
                                          className="min-h-11 w-28 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                                        />
                                        <span aria-hidden="true" className="text-stone-500">
                                          &rarr;
                                        </span>
                                        <input
                                          type="time"
                                          step={60}
                                          value={row.endsAt}
                                          onChange={(e) =>
                                            patchWindow(row.rowId, { endsAt: e.target.value })
                                          }
                                          disabled={!canEditDraft}
                                          aria-label={t("avEndAria", { day: dayLabel })}
                                          className="min-h-11 w-28 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => removeRow("windows", row.rowId)}
                                          disabled={!canEditDraft}
                                          aria-label={t("avRowRemoveWindowAria", { day: dayLabel })}
                                          className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-700"
                                        >
                                          {t("avRowRemove")}
                                        </button>
                                      </li>
                                    ))}
                              </ul>
                            )}

                            <button
                              type="button"
                              onClick={() => (useSlots ? addSlot(weekday) : addWindow(weekday))}
                              disabled={!canEditDraft}
                              data-add-row={useSlots ? "slot" : "window"}
                              data-add-weekday={weekday}
                              className="mt-2 min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-extrabold text-amber-700 disabled:text-stone-400"
                            >
                              {useSlots
                                ? t("avAddSlot", { day: dayLabel })
                                : t("avAddWindow", { day: dayLabel })}
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {/* Refus de la section, nommés et placés ici : le
                        commerçant lit le motif à côté du réglage fautif,
                        pas dans une bannière lointaine. */}
                    {issuesOf("offers").length > 0 && (
                      <ul
                        data-section-issues="offers"
                        className="mt-3 list-disc space-y-1 rounded-xl bg-red-50 p-3 pl-8 text-sm text-red-900"
                      >
                        {issuesOf("offers").map((issue, index) => (
                          <li key={`${issue.code}-${issue.rowId ?? index}`}>
                            {t(issueKey(issue.code))}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>

                {/* ===== §3 — PRÉPARATION ET DÉLAI ===== */}
                <section className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
                  <div className="border-b border-stone-100 p-4">
                    <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                      3
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-stone-900">
                      {t("avPrepTitle")}
                    </h3>
                    <p className="mt-2 max-w-3xl text-sm text-stone-600">{t("avPrepHint")}</p>
                  </div>

                  {/* EN CLAIR : des phrases tirées des réglages saisis.
                      Aucune date n'est calculée ici -- l'exemple daté
                      vient du serveur, juste en dessous. */}
                  <div className="p-4" data-plain-example="true">
                    <h4 className="text-sm font-extrabold text-stone-900">
                      {t("avExampleTitle")}
                    </h4>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-stone-800">
                      <li>
                        {(Number.parseInt(draft.minLeadDays, 10) || 0) === 0
                          ? t("avExampleLeadZero")
                          : t("avExampleLeadN", {
                              days: String(Number.parseInt(draft.minLeadDays, 10)),
                            })}
                      </li>
                      <li>
                        {draft.cutoffTime
                          ? method === "v1.2"
                            ? t("avExampleCutoffV12", { time: draft.cutoffTime })
                            : t("avExampleCutoffV1", {
                                time: draft.cutoffTime,
                                offset: String(Number.parseInt(draft.cutoffOffsetDays, 10) || 0),
                              })
                          : t("avExampleCutoffNone")}
                      </li>
                      {draft.bookingHorizonDays !== "" && (
                        <li>
                          {t("avExampleHorizon", {
                            days: String(Number.parseInt(draft.bookingHorizonDays, 10) || 0),
                          })}
                        </li>
                      )}
                    </ul>
                    <p className="mt-2 text-xs leading-relaxed text-stone-600">
                      {t("avExampleIndicative")}
                    </p>

                    {/* EXEMPLE DU SERVEUR : première date et créneaux tels
                        que `get_checkout_fulfillment_schedule` les rend
                        pour la configuration ENREGISTRÉE. */}
                    <div
                      data-server-example={
                        previewLoading ? "loading" : previewInScope && preview ? "ready" : "idle"
                      }
                      className="mt-3 rounded-xl border border-stone-300 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <h5 className="text-sm font-extrabold text-stone-900">
                          {t("avServerExampleTitle")}
                        </h5>
                        <button
                          type="button"
                          id="av-server-example"
                          onClick={() => void runPreview()}
                          disabled={previewLoading}
                          className="min-h-11 rounded-xl border border-stone-900 bg-white px-4 py-2 text-sm font-extrabold text-stone-900"
                        >
                          {t("avServerExampleButton")}
                        </button>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avServerExampleSaved")}
                      </p>
                      {previewLoading && (
                        <p className="mt-2 text-sm text-stone-500">{t("avPreviewLoading")}</p>
                      )}
                      {!previewLoading && previewError && previewInScope && (
                        <p role="alert" className="mt-2 text-sm text-amber-900">
                          {previewError}
                        </p>
                      )}
                      {!previewLoading && !previewError && preview && previewInScope && (
                        <div className="mt-2 text-sm text-stone-800">
                          {preview.firstEligibleDate ? (
                            <>
                              <p>
                                {t("avServerExampleFirst")} :{" "}
                                <strong data-server-example-first={preview.firstEligibleDate}>
                                  {preview.firstEligibleDate}
                                </strong>
                              </p>
                              {(preview.offers?.[preview.firstEligibleDate] ?? []).length > 0 && (
                                <p className="mt-1">
                                  {t("avServerExampleSlots")} :{" "}
                                  {(preview.offers?.[preview.firstEligibleDate] ?? [])
                                    .map(
                                      (offer) =>
                                        `${offer.slot_key ? `${offer.slot_key} ` : ""}${offer.starts_at}–${offer.ends_at}`
                                    )
                                    .join(" · ")}
                                </p>
                              )}
                            </>
                          ) : (
                            <p>{t("avServerExampleNone")}</p>
                          )}
                        </div>
                      )}
                    </div>

                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-extrabold text-amber-700">
                        {t("avHowSummary")}
                      </summary>
                      <h4 className="mt-3 text-sm font-extrabold text-stone-900">
                        {t("avHowTitle")}
                      </h4>
                      <ol className="mt-3 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
                        {[
                          ["avStep1Title", "avStep1Text"],
                          ["avStep2Title", "avStep2Text"],
                          ["avStep3Title", "avStep3Text"],
                          ["avStep4Title", "avStep4Text"],
                        ].map(([titleKey, textKey]) => (
                          <li key={titleKey} className="rounded-xl border border-stone-200 p-3">
                            <p className="text-xs font-extrabold uppercase tracking-wider text-amber-700">
                              {t(titleKey)}
                            </p>
                            <p className="mt-2 text-sm leading-relaxed text-stone-700">
                              {t(textKey)}
                            </p>
                          </li>
                        ))}
                      </ol>
                      <p className="mt-3 rounded-xl border-l-4 border-amber-600 bg-amber-50 p-3 text-sm leading-relaxed text-stone-800">
                        {t("avCutoffReachedNote")}
                      </p>
                    </details>
                  </div>

                  <div className="grid grid-cols-1 gap-5 p-4 sm:grid-cols-2">
                    <div>
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-lead-days"
                      >
                        {t("avLeadDaysLabel")}
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-extrabold text-stone-700">J +</span>
                        <input
                          id="av-lead-days"
                          type="number"
                          min={0}
                          max={365}
                          value={draft?.minLeadDays ?? ""}
                          onChange={(e) => patchDraft({ minLeadDays: e.target.value })}
                          disabled={!canEditDraft}
                          className="min-h-11 w-24 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                        />
                        <span className="text-sm text-stone-700">{t("avLeadDaysUnit")}</span>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {method === "v1.2" ? t("avLeadDaysHintV12") : t("avLeadDaysHintV1")}
                      </p>
                    </div>

                    <div>
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-timezone"
                      >
                        {t("avTimezoneLabel")}
                      </label>
                      <input
                        id="av-timezone"
                        type="text"
                        value={draft?.timezone ?? ""}
                        onChange={(e) => patchDraft({ timezone: e.target.value })}
                        disabled={!canEditDraft}
                        className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                      />
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avTimezoneHint")}
                      </p>
                    </div>

                    <div>
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-cutoff"
                      >
                        {t("avCutoffLabel")}
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          id="av-cutoff"
                          type="time"
                          step={60}
                          value={draft?.cutoffTime ?? ""}
                          onChange={(e) => patchDraft({ cutoffTime: e.target.value })}
                          placeholder={t("avCutoffNone")}
                          disabled={!canEditDraft}
                          className="min-h-11 w-36 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                        />
                        {/* Retirer l'heure limite est un RÉGLAGE, pas une
                            suppression : sans heure limite, aucune coupure
                            n'est appliquée -- et ce n'est pas « minuit ». */}
                        <button
                          type="button"
                          onClick={() => patchDraft({ cutoffTime: "" })}
                          disabled={!canEditDraft || (draft?.cutoffTime ?? "") === ""}
                          className="min-h-11 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-amber-700 disabled:text-stone-400"
                        >
                          {t("avCutoffClear")}
                        </button>
                      </div>
                      {!draft?.cutoffTime && (
                        <p className="mt-1.5 text-xs font-bold text-stone-700">
                          {t("avCutoffNone")}
                        </p>
                      )}
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {method === "v1.2" ? t("avCutoffHintV12") : t("avCutoffHintV1")}
                      </p>
                    </div>

                  </div>

                  {issuesOf("policy").length > 0 && (
                    <ul
                      data-section-issues="policy"
                      className="mx-4 list-disc space-y-1 rounded-xl bg-red-50 p-3 pl-8 text-sm text-red-900"
                    >
                      {issuesOf("policy").map((issue, index) => (
                        <li key={`${issue.code}-${index}`}>{t(issueKey(issue.code))}</li>
                      ))}
                    </ul>
                  )}

                  {/* Jours de préparation — éditables en méthode v1.2. */}
                  {method === "v1.2" ? (
                  <div className="p-4">
                    <fieldset
                      disabled={!canEditDraft || draft?.method !== "v1.2"}
                      className="rounded-2xl border border-blue-200 bg-blue-50 p-4"
                    >
                      <legend className="px-2 text-xs font-extrabold text-blue-900">
                        {t("avPrepDaysLabel")}
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAY_DISPLAY_ORDER.map((weekday) => {
                          const checked = draft?.preparationWeekdays.includes(weekday) ?? false;
                          return (
                            <label
                              key={weekday}
                              className={
                                "inline-flex min-h-11 items-center gap-2 rounded-full border bg-white px-3.5 py-2 text-sm font-bold text-stone-800 " +
                                (checked ? "border-blue-700" : "border-stone-300")
                              }
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleWeekday(weekday)}
                                disabled={!canEditDraft || draft?.method !== "v1.2"}
                                data-prep-weekday={weekday}
                                className="h-4 w-4 accent-blue-700"
                              />
                              {t(weekdayLabelKey(weekday))}
                            </label>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-blue-900">
                        {t("avPrepDaysHint")}
                      </p>
                      {(draft?.preparationWeekdays.length ?? 0) === 0 && (
                        <p className="mt-1.5 text-xs font-bold text-blue-900">
                          {t("avPrepDaysEmpty")}
                        </p>
                      )}
                    </fieldset>
                  </div>
                  ) : (
                    <div className="p-4">
                      <p
                        data-v12-only="true"
                        className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm leading-relaxed text-stone-700"
                      >
                        <strong>{t("avV12OnlyTitle")}</strong> — {t("avV12OnlyText")}
                      </p>
                    </div>
                  )}

                  <details className="border-t border-stone-100">
                    <summary className="cursor-pointer p-4 text-sm font-extrabold text-amber-700">
                      {t("avAdvanced")}
                    </summary>
                    <div className="px-4 pb-4">
                      {/* Le décalage n'existe QU'en méthode v1 : en v1.2 il
                          est refusé par la fonction ET par une contrainte,
                          donc il n'est pas affiché du tout. Réglage
                          technique : rangé ici, pas dans le parcours. */}
                      {method === "v1" && (
                        <div className="mb-4">
                          <label
                            className="mb-1.5 block text-xs font-bold text-stone-700"
                            htmlFor="av-cutoff-offset"
                          >
                            {t("avCutoffOffsetLabel")}
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              id="av-cutoff-offset"
                              type="number"
                              min={0}
                              max={30}
                              value={draft?.cutoffOffsetDays ?? ""}
                              onChange={(e) => patchDraft({ cutoffOffsetDays: e.target.value })}
                              disabled={!canEditDraft}
                              className="min-h-11 w-24 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                            />
                            <span className="text-sm text-stone-700">
                              {t("avCutoffOffsetUnit")}
                            </span>
                          </div>
                        </div>
                      )}
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-lead-minutes"
                      >
                        {t("avLeadMinutesLabel")}
                      </label>
                      <input
                        id="av-lead-minutes"
                        type="number"
                        min={0}
                        max={100000}
                        value={draft?.leadTimeMinutes ?? ""}
                        onChange={(e) => patchDraft({ leadTimeMinutes: e.target.value })}
                        disabled={!canEditDraft}
                        className="min-h-11 w-32 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                      />
                      <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-stone-600">
                        {t("avLeadMinutesHint")}
                      </p>
                    </div>
                  </details>
                </section>

                {/* ===== §4 — FERMETURES ET FÉRIÉS ===== */}
                <section className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
                  <div className="border-b border-stone-100 p-4">
                    <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                      4
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-stone-900">
                      {t("avClosuresTitle")}
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-2">
                    <div>
                      <h4 className="text-sm font-extrabold text-stone-900">
                        {t("avClosuresCustomerTitle")}
                      </h4>
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avClosuresCustomerHint")}
                      </p>
                      {(draft?.closures.length ?? 0) === 0 ? (
                        <p className="mt-2 text-sm text-stone-600">{t("avClosuresEmpty")}</p>
                      ) : (
                        <ul className="mt-2 list-none space-y-2 p-0">
                          {(draft?.closures ?? []).map((row) => (
                            <li
                              key={row.rowId}
                              className={
                                "flex flex-wrap items-center gap-2 rounded-lg border p-2 " +
                                (rowHasIssue(row.rowId)
                                  ? "border-red-400 bg-red-50"
                                  : "border-stone-200")
                              }
                            >
                              <input
                                type="date"
                                value={row.closedOn}
                                onChange={(e) =>
                                  patchClosure("closures", row.rowId, { closedOn: e.target.value })
                                }
                                disabled={!canEditDraft}
                                aria-label={t("avClosureDateAria")}
                                className="min-h-11 w-40 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                              />
                              <input
                                type="text"
                                value={row.label}
                                onChange={(e) =>
                                  patchClosure("closures", row.rowId, { label: e.target.value })
                                }
                                disabled={!canEditDraft}
                                aria-label={t("avClosureLabelAria")}
                                placeholder={t("avClosureNoLabel")}
                                className="min-h-11 flex-1 basis-32 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                              />
                              <button
                                type="button"
                                onClick={() => removeRow("closures", row.rowId)}
                                disabled={!canEditDraft}
                                aria-label={t("avRowRemoveClosureAria")}
                                className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-700"
                              >
                                {t("avRowRemove")}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <button
                        type="button"
                        onClick={() => addClosure("closures")}
                        disabled={!canEditDraft}
                        data-add-row="closure"
                        className="mt-2 min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-extrabold text-amber-700 disabled:text-stone-400"
                      >
                        {t("avAddClosure")}
                      </button>
                      {issuesOf("closures").length > 0 && (
                        <ul
                          data-section-issues="closures"
                          className="mt-2 list-disc space-y-1 rounded-xl bg-red-50 p-3 pl-8 text-sm text-red-900"
                        >
                          {issuesOf("closures").map((issue, index) => (
                            <li key={`${issue.code}-${issue.rowId ?? index}`}>
                              {t(issueKey(issue.code))}
                            </li>
                          ))}
                        </ul>
                      )}

                      {method === "v1.2" ? (
                        <>
                      <h4 className="mt-5 text-sm font-extrabold text-blue-900">
                        {t("avClosuresPrepTitle")}
                      </h4>
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avClosuresPrepHint")}
                      </p>
                      {(draft?.preparationClosures.length ?? 0) === 0 ? (
                        <p className="mt-2 text-sm text-stone-600">{t("avClosuresEmpty")}</p>
                      ) : (
                        <ul className="mt-2 list-none space-y-2 p-0">
                          {(draft?.preparationClosures ?? []).map((row) => (
                            <li
                              key={row.rowId}
                              className={
                                "flex flex-wrap items-center gap-2 rounded-lg border p-2 " +
                                (rowHasIssue(row.rowId)
                                  ? "border-red-400 bg-red-50"
                                  : "border-blue-200 bg-blue-50")
                              }
                            >
                              <input
                                type="date"
                                value={row.closedOn}
                                onChange={(e) =>
                                  patchClosure("preparationClosures", row.rowId, {
                                    closedOn: e.target.value,
                                  })
                                }
                                disabled={!canEditDraft || draft?.method !== "v1.2"}
                                aria-label={t("avPrepClosureDateAria")}
                                className="min-h-11 w-40 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                              />
                              <input
                                type="text"
                                value={row.label}
                                onChange={(e) =>
                                  patchClosure("preparationClosures", row.rowId, {
                                    label: e.target.value,
                                  })
                                }
                                disabled={!canEditDraft || draft?.method !== "v1.2"}
                                aria-label={t("avPrepClosureLabelAria")}
                                placeholder={t("avClosureNoLabel")}
                                className="min-h-11 flex-1 basis-32 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm"
                              />
                              <button
                                type="button"
                                onClick={() => removeRow("preparationClosures", row.rowId)}
                                disabled={!canEditDraft || draft?.method !== "v1.2"}
                                aria-label={t("avRowRemovePrepClosureAria")}
                                className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-700"
                              >
                                {t("avRowRemove")}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Une fermeture d'atelier n'existe qu'en méthode
                          v1.2 : en v1 le serveur n'a pas de table pour
                          elle, donc le bouton reste inactif et la raison
                          est écrite. */}
                      <button
                        type="button"
                        onClick={() => addClosure("preparationClosures")}
                        disabled={!canEditDraft || draft?.method !== "v1.2"}
                        data-add-row="prep-closure"
                        className="mt-2 min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-extrabold text-amber-700 disabled:text-stone-400"
                      >
                        {t("avAddPrepClosure")}
                      </button>
                      {issuesOf("preparation").length > 0 && (
                        <ul
                          data-section-issues="preparation"
                          className="mt-2 list-disc space-y-1 rounded-xl bg-red-50 p-3 pl-8 text-sm text-red-900"
                        >
                          {issuesOf("preparation").map((issue, index) => (
                            <li key={`${issue.code}-${issue.rowId ?? index}`}>
                              {t(issueKey(issue.code))}
                            </li>
                          ))}
                        </ul>
                      )}
                        </>
                      ) : (
                        <p
                          data-v12-only="closures"
                          className="mt-5 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs leading-relaxed text-stone-700"
                        >
                          <strong>{t("avV12OnlyTitle")}</strong> — {t("avV12OnlyText")}
                        </p>
                      )}
                    </div>

                    {method === "v1.2" && (
                    <div>
                      <h4 className="text-sm font-extrabold text-stone-900">
                        {t("avHolidayTitle")}
                      </h4>
                      <div className="mt-2 rounded-2xl border border-blue-200 bg-blue-50 p-4">
                        {/* AUD-02 (audit Cat Greco) — NE JAMAIS AFFIRMER
                            « Aucun calendrier » QUAND LE SERVEUR EN REND UN.
                            L'ancienne version rendait un sélecteur figé sur
                            « Aucun calendrier », donc FAUX dès qu'une portée
                            portait un calendrier férié rattaché.

                            Ce que le serveur donne est l'IDENTITÉ du
                            calendrier, et rien de plus : la lecture v1.2 rend
                            `holiday_calendar_id`, et AUCUNE lecture de
                            catalogue n'est accordée à cette page. La page
                            affiche donc l'identité telle quelle, en disant
                            explicitement que le libellé n'est pas consultable
                            d'ici -- elle n'invente ni catalogue, ni nom, ni
                            possibilité d'édition. */}
                        <p className="mb-1.5 text-xs font-bold text-blue-900">
                          {t("avHolidayCalendarLabel")}
                        </p>
                        {draft?.holidayCalendarId ?? selectedV12?.holidayCalendarId ? (
                          <>
                            <p
                              data-holiday-calendar="attached"
                              className="rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm font-bold text-blue-900"
                            >
                              {t("avHolidayCalendarAttached")}
                            </p>
                            <p className="mt-1.5 break-all font-mono text-xs text-blue-900">
                              {draft?.holidayCalendarId ?? selectedV12?.holidayCalendarId}
                            </p>
                            <p className="mt-2 text-xs leading-relaxed text-blue-900">
                              {t("avHolidayCatalogueUnavailable")}
                            </p>
                          </>
                        ) : (
                          <>
                            <p
                              data-holiday-calendar="none"
                              className="rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm font-bold text-blue-900"
                            >
                              {t("avHolidayNoCalendar")}
                            </p>
                            <p className="mt-2 text-xs leading-relaxed text-blue-900">
                              {t("avHolidayEmptyNote")}
                            </p>
                          </>
                        )}

                        {/* Les deux politiques ne sont actionnables
                            qu'avec un calendrier rattaché : sans lui, le
                            serveur REFUSE « fermé » (contrainte), et
                            proposer le choix serait mentir. */}
                        <fieldset
                          disabled={
                            !canEditDraft ||
                            draft?.method !== "v1.2" ||
                            (draft?.holidayCalendarId ?? null) === null
                          }
                          className="mt-3 rounded-xl border border-dashed border-blue-300 bg-white p-3"
                        >
                          <legend className="px-1.5 text-xs font-extrabold text-blue-900">
                            {t("avHolidayPrepPolicy")}
                          </legend>
                          <div className="flex flex-wrap gap-2">
                            {(["open", "closed"] as const).map((value) => (
                              <label
                                key={value}
                                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm font-bold text-stone-700"
                              >
                                <input
                                  type="radio"
                                  name="av-prep-holidays"
                                  value={value}
                                  checked={(draft?.preparationOnHolidays ?? "open") === value}
                                  onChange={() => patchDraft({ preparationOnHolidays: value })}
                                  className="h-4 w-4 accent-blue-700"
                                />
                                {value === "open" ? t("avHolidayOpen") : t("avHolidayClosed")}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <fieldset
                          disabled={
                            !canEditDraft ||
                            draft?.method !== "v1.2" ||
                            (draft?.holidayCalendarId ?? null) === null
                          }
                          className="mt-2 rounded-xl border border-dashed border-blue-300 bg-white p-3"
                        >
                          <legend className="px-1.5 text-xs font-extrabold text-blue-900">
                            {t("avHolidayAvailPolicy")}
                          </legend>
                          <div className="flex flex-wrap gap-2">
                            {(["open", "closed"] as const).map((value) => (
                              <label
                                key={value}
                                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm font-bold text-stone-700"
                              >
                                <input
                                  type="radio"
                                  name="av-avail-holidays"
                                  value={value}
                                  checked={(draft?.availabilityOnHolidays ?? "open") === value}
                                  onChange={() => patchDraft({ availabilityOnHolidays: value })}
                                  className="h-4 w-4 accent-blue-700"
                                />
                                {value === "open" ? t("avHolidayOpen") : t("avHolidayClosed")}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        {issuesOf("holidays").length > 0 && (
                          <ul
                            data-section-issues="holidays"
                            className="mt-2 list-disc space-y-1 rounded-xl bg-red-50 p-3 pl-8 text-sm text-red-900"
                          >
                            {issuesOf("holidays").map((issue, index) => (
                              <li key={`${issue.code}-${index}`}>{t(issueKey(issue.code))}</li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-2 text-xs leading-relaxed text-blue-900">
                          {t("avHolidayNeedsCalendar")}
                        </p>
                      </div>
                    </div>
                    )}
                  </div>
                </section>

                {/* ===== §5 — CAPACITÉS ===== */}
                {method === "v1.2" ? (
                <section className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
                  <div className="border-b border-stone-100 p-4">
                    <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                      5
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-stone-900">
                      {t("avCapacityTitle")}
                    </h3>
                  </div>

                  <div className="p-4">
                    <fieldset
                      disabled={!canEditDraft || draft?.method !== "v1.2"}
                      className="rounded-2xl border border-blue-200 bg-blue-50 p-4"
                    >
                      <legend className="px-2 text-xs font-extrabold text-blue-900">
                        {t("avCapacityEnabledLabel")}
                      </legend>
                      <label className="flex items-center gap-3 text-sm font-bold text-blue-900">
                        <input
                          type="checkbox"
                          checked={draft?.capacityEnabled ?? false}
                          onChange={(e) => patchDraft({ capacityEnabled: e.target.checked })}
                          disabled={!canEditDraft || draft?.method !== "v1.2"}
                          data-capacity-enabled={String(draft?.capacityEnabled ?? false)}
                          className="h-5 w-5 accent-blue-700"
                        />
                        {t("avCapacityEnabledLabel")}
                      </label>

                      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <label
                            className="mb-1.5 block text-xs font-bold text-blue-900"
                            htmlFor="av-capacity-max"
                          >
                            {t("avCapacityMaxLabel")}
                          </label>
                          <input
                            id="av-capacity-max"
                            type="number"
                            min={1}
                            value={draft?.capacityMaxOrders ?? ""}
                            onChange={(e) => patchDraft({ capacityMaxOrders: e.target.value })}
                            disabled={!canEditDraft || draft?.method !== "v1.2"}
                            className="min-h-11 w-28 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                          />
                          <p className="mt-1.5 text-xs leading-relaxed text-blue-900">
                            {t("avCapacityMaxHint")}
                          </p>
                        </div>
                        <div>
                          <p className="mb-1.5 text-xs font-bold text-blue-900">
                            {t("avCapacityBucketLabel")}
                          </p>
                          <p
                            data-capacity-bucket={capacityBucketKindOf(
                              draft?.slotSelectionMode ?? selected.slotSelectionMode
                            )}
                            className="rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm font-bold text-blue-900"
                          >
                            {capacityBucketKindOf(
                              draft?.slotSelectionMode ?? selected.slotSelectionMode
                            ) === "named_slot"
                              ? t("avCapacityBucketNamedSlot")
                              : t("avCapacityBucketWholeDay")}
                          </p>
                          <p className="mt-1.5 text-xs leading-relaxed text-blue-900">
                            {t("avCapacityBucketHint")}
                          </p>
                        </div>
                      </div>
                    </fieldset>

                    {capacityBucketKindOf(
                      draft?.slotSelectionMode ?? selected.slotSelectionMode
                    ) === "whole_day" && (
                      <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">
                        {t("avCapacityWholeDayWarning")}
                      </p>
                    )}

                    <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                      <p className="rounded-xl border-l-4 border-blue-700 bg-blue-50 p-3 text-sm leading-relaxed text-blue-900">
                        {t("avCapacityOneOrder")}
                      </p>
                      <p className="rounded-xl border-l-4 border-stone-700 bg-stone-100 p-3 text-sm leading-relaxed text-stone-800">
                        {t("avCapacityNoCounts")}
                      </p>
                      <p className="rounded-xl border-l-4 border-red-800 bg-red-50 p-3 text-sm leading-relaxed text-red-900">
                        {t("avCapacityNoMerchantCounts")}
                      </p>
                    </div>

                    {issuesOf("capacity").length > 0 && (
                      <ul
                        data-section-issues="capacity"
                        className="mt-3 list-disc space-y-1 rounded-xl bg-red-50 p-3 pl-8 text-sm text-red-900"
                      >
                        {issuesOf("capacity").map((issue, index) => (
                          <li key={`${issue.code}-${index}`}>{t(issueKey(issue.code))}</li>
                        ))}
                      </ul>
                    )}

                    <div className="mt-3 rounded-xl border border-stone-200 p-3">
                      <h4 className="text-sm font-extrabold text-stone-900">
                        {t("avCapacityHoldingTitle")}
                      </h4>
                      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-stone-800">
                        <li>{t("avCapacityHolding1")}</li>
                        <li>{t("avCapacityHolding2")}</li>
                        <li>{t("avCapacityHolding3")}</li>
                        <li>{t("avCapacityHolding4")}</li>
                      </ul>
                    </div>
                  </div>
                </section>
                ) : (
                  <details
                    data-v12-only-section="capacity"
                    className="mt-4 rounded-2xl border border-stone-200 bg-stone-50 p-4"
                  >
                    <summary className="cursor-pointer text-sm font-extrabold text-stone-700">
                      {t("avCapacityTitle")}
                    </summary>
                    <p className="mt-2 text-sm leading-relaxed text-stone-700">
                      {t("avV12OnlyText")}
                    </p>
                  </details>
                )}

                {/* ===== §6 — APERÇU SERVEUR ===== */}
                <section className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
                  <div className="border-b border-stone-100 p-4">
                    <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                      6
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-stone-900">
                      {t("avPreviewTitle")}
                    </h3>
                    <p className="mt-2 max-w-3xl text-sm leading-relaxed text-stone-600">
                      {t("avPreviewHint")}
                    </p>
                    <p
                      data-preview-disclaimer="true"
                      className="mt-2 max-w-3xl rounded-xl border-l-4 border-amber-600 bg-amber-50 p-3 text-sm leading-relaxed text-stone-800"
                    >
                      {t("avPreviewNoOrder")}
                    </p>
                  </div>

                  <div className="p-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="basis-full sm:basis-48">
                        <label
                          className="mb-1.5 block text-xs font-bold text-stone-700"
                          htmlFor="av-preview-postal"
                        >
                          {t("avPreviewPostalLabel")}
                        </label>
                        <input
                          id="av-preview-postal"
                          type="text"
                          inputMode="numeric"
                          value={previewPostalCode}
                          onChange={(e) => setPreviewPostalCode(e.target.value)}
                          className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                        />
                      </div>
                      <div className="basis-[45%] sm:basis-40">
                        <label
                          className="mb-1.5 block text-xs font-bold text-stone-700"
                          htmlFor="av-preview-items"
                        >
                          {t("avPreviewItemsLabel")}
                        </label>
                        <input
                          id="av-preview-items"
                          type="number"
                          min={0}
                          value={previewItems}
                          onChange={(e) => setPreviewItems(e.target.value)}
                          className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                        />
                      </div>
                      <div className="basis-[45%] sm:basis-40">
                        <label
                          className="mb-1.5 block text-xs font-bold text-stone-700"
                          htmlFor="av-preview-subtotal"
                        >
                          {t("avPreviewSubtotalLabel")}
                        </label>
                        <input
                          id="av-preview-subtotal"
                          type="number"
                          min={0}
                          step="0.01"
                          value={previewSubtotal}
                          onChange={(e) => setPreviewSubtotal(e.target.value)}
                          className="min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => void runPreview()}
                        className="min-h-11 basis-full rounded-xl border border-stone-900 bg-stone-900 px-5 py-2.5 text-sm font-extrabold text-white sm:basis-auto"
                      >
                        {t("avPreviewRefresh")}
                      </button>
                    </div>
                    <p className="mt-2 max-w-3xl text-xs leading-relaxed text-stone-600">
                      {t("avPreviewPostalHint")}
                    </p>

                    {previewLoading && (
                      <p className="mt-3 text-sm text-stone-500">{t("avPreviewLoading")}</p>
                    )}
                    {!previewLoading && previewError && previewInScope && (
                      <p
                        role="alert"
                        className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
                      >
                        {previewError}
                      </p>
                    )}

                    {!previewLoading && !previewError && preview && previewInScope && (
                      <div
                        data-preview-status={preview.scheduleStatus}
                        className="mt-3 rounded-2xl border border-stone-300 p-4"
                      >
                        <p className="text-xs font-bold uppercase tracking-wider text-stone-500">
                          {t("avPreviewServerStatus")}
                        </p>
                        <p className="mt-1 text-sm font-bold text-stone-900">
                          {t(scheduleStatusKey(preview.scheduleStatus))}
                        </p>
                        {preview.scheduleStatus === "unfulfillable" && (
                          <p
                            data-preview-reason={preview.unfulfillableReason ?? "none"}
                            className="mt-2 text-sm leading-relaxed text-stone-700"
                          >
                            {t(unfulfillableReasonKey(preview.unfulfillableReason))}
                          </p>
                        )}
                        {preview.deliveryApplicable && !preview.deliveryEligible && (
                          <p className="mt-2 text-sm leading-relaxed text-stone-700">
                            {t("avPreviewNoDelivery")}
                          </p>
                        )}
                        {preview.firstEligibleDate && (
                          <p className="mt-2 text-sm text-stone-700">
                            {t("avPreviewFirstDate")} :{" "}
                            <strong className="text-stone-900">
                              {preview.firstEligibleDate}
                            </strong>
                          </p>
                        )}
                        {preview.eligibleDates.length > 0 && (
                          <>
                            <p className="mt-3 text-xs font-bold uppercase tracking-wider text-stone-500">
                              {t("avPreviewDates")}
                            </p>
                            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                              {preview.eligibleDates.map((date) => {
                                const dayOffers = preview.offers?.[date] ?? [];
                                return (
                                  <div
                                    key={date}
                                    className="rounded-xl border border-stone-200 p-3"
                                  >
                                    <p className="text-xs font-extrabold uppercase tracking-wider text-amber-700">
                                      {date}
                                    </p>
                                    {dayOffers.length === 0 ? (
                                      <p className="mt-2 text-sm text-stone-600">
                                        {t("avPreviewNoOffer")}
                                      </p>
                                    ) : (
                                      <ul className="mt-2 list-none space-y-1.5 p-0 text-sm text-stone-700">
                                        {dayOffers.map((offer, index) => (
                                          <li
                                            key={`${offer.slot_key ?? "free"}-${offer.starts_at}-${index}`}
                                            className="rounded-lg border border-stone-200 px-2.5 py-1.5"
                                          >
                                            {offer.slot_key ? (
                                              <>
                                                <strong>{offer.slot_key}</strong> ·{" "}
                                              </>
                                            ) : null}
                                            {offer.starts_at}–{offer.ends_at}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </section>

                {/* ===== CE QUI MANQUERAIT POUR PUBLIER ===== */}
                {blockers.length > 0 && (
                  <section className="mt-4 rounded-2xl border border-stone-300 bg-stone-50 p-4">
                    <h3 className="text-sm font-extrabold text-stone-900">
                      {t("avBlockersTitle")}
                    </h3>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-stone-800">
                      {blockers.map((blocker) => (
                        <li key={blocker} data-publish-blocker={blocker}>
                          {t(publishBlockerKey(blocker))}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                </>
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* ===== BARRE D'ENREGISTREMENT =====
          Un seul geste, un seul appel. Le bouton reste inactif tant que
          le contrat d'écriture n'est pas disponible (issue #149 : « Ne
          jamais simplement basculer le flag avant qu'une RPC
          transactionnelle Boulez existe et que les tests soient
          passés »), et il l'est aussi quand rien n'a changé ou qu'un
          refus local est affiché. La raison est TOUJOURS écrite à côté,
          jamais portée par la seule couleur du bouton. */}
      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-stone-300 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <span
            data-draft-state={
              saving ? "saving" : saved ? "saved" : dirty ? "dirty" : "clean"
            }
            className={
              "rounded-full px-2.5 py-1 text-xs font-extrabold " +
              (dirty ? "bg-amber-50 text-amber-900" : "bg-stone-100 text-stone-700")
            }
          >
            {saving
              ? t("avSaving")
              : saved
                ? t("avSavedState")
                : dirty
                  ? t("avDirtyState", { count: changeCount })
                  : t("avCleanState")}
          </span>

          <p className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600">
            {canSaveDraft
              ? issues.length > 0
                ? t("avSaveBlockedByIssues", { count: issues.length })
                : t("avSaveAtomicNote")
              : writeState.enabled && conflictInScope
                ? t("avConflictBlocksSave")
                : writeState.enabled && !snapshotAuthoritative
                  ? t("avSaveNeedsAuthority")
                  : `${t(writeDisabledKey)} ${t("avSaveNoPartialPromise")}`}
          </p>

          {saveError && (
            <p
              role="alert"
              data-save-error="true"
              className="basis-full rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
            >
              {saveError}
              {/* Concurrence : on DIT que la version du serveur a été
                  relue, et que le prochain enregistrement partira de
                  celle-là. Rien n'a été réenregistré tout seul. */}
              {staleReloaded && (
                <span data-stale-reloaded="true" className="mt-2 block font-bold">
                  {" "}
                  {t("avSaveStaleReloaded")}
                </span>
              )}
            </p>
          )}

          {/* ═══ REPLI EN BROUILLON, SUR CONFIRMATION ═══
              Proposé quand l'activation est refusée mais que la MÊME
              configuration, désactivée, serait acceptée : soit parce que
              le serveur l'a dit (`CSDJBO1_INCOMPLETE_CONFIGURATION`),
              soit parce que la page le sait déjà et n'a pas envoyé.
              Un bouton distinct, libellé, que le commerçant clique
              lui-même — jamais un enregistrement silencieux à sa place. */}
          {canSaveDraft && draftFallbackOffered && (
            <div className="basis-full rounded-xl border border-stone-300 bg-white p-3">
              <p className="text-sm text-stone-800">{t("avDraftOffer")}</p>
              <button
                type="button"
                id="av-save-as-draft"
                onClick={() => void saveConfiguration({ asDraft: true })}
                disabled={saving}
                className="mt-2 min-h-11 rounded-xl border border-stone-900 bg-white px-4 py-2.5 text-sm font-extrabold text-stone-900"
              >
                {t("avDraftOfferConfirm")}
              </button>
            </div>
          )}

          <button
            type="button"
            id="av-cancel"
            onClick={resetDraft}
            disabled={!dirty || saving}
            className="min-h-11 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800 disabled:text-stone-400"
          >
            {t("avCancelChanges")}
          </button>
          <button
            type="button"
            id="av-save"
            onClick={() => void saveConfiguration()}
            disabled={!canSaveDraft || !dirty || issues.length > 0}
            aria-disabled={!canSaveDraft || !dirty || issues.length > 0}
            data-write-disabled-reason={
              canSaveDraft
                ? issues.length > 0
                  ? "issues"
                  : dirty
                    ? "none"
                    : "clean"
                : writeState.enabled
                  ? conflictInScope
                    ? "conflict"
                    : !snapshotAuthoritative
                      ? "authority"
                      : "none"
                  : writeState.reason
            }
            className="min-h-11 rounded-xl border border-stone-300 bg-stone-200 px-5 py-2.5 text-sm font-extrabold text-stone-500 enabled:border-stone-900 enabled:bg-stone-900 enabled:text-white"
          >
            {t("avSaveLabel")}
          </button>
        </div>
      </div>
    </>
  );
}
