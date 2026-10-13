"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { getMerchantRestaurants, getRestaurantSettings } from "@/lib/services/dashboard";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import {
  getCheckoutFulfillmentSchedulePreview,
  getMerchantFulfillmentSchedules,
  getMerchantFulfillmentSchedulesV12,
} from "@/lib/services/availability";
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
import DashboardNav from "@/components/dashboard/DashboardNav";
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
  if (!schedule || !schedule.enabled) return "avCustomerNoDate";
  if (schedule.dateSelectionMode === DATE_MODE_DERIVED) return "avCustomerFirstDate";
  if (schedule.dateSelectionMode !== DATE_MODE_CUSTOMER) return "avCustomerNoDate";
  if (schedule.slotSelectionMode === SLOT_MODE_FIXED_SLOTS) return "avCustomerDateAndSlot";
  if (schedule.slotSelectionMode === SLOT_MODE_FREE_TIME) return "avCustomerDateAndTime";
  return "avCustomerDateOnly";
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

  const requestSeqRef = useRef(0);
  const uiLangRef = useRef<Lang>("fr");
  useEffect(() => {
    uiLangRef.current = uiLang;
  }, [uiLang]);

  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);

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
  const method = scheduleMethodOf(selectedV12);
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
                        {s.modeCode} — {t(STATE_KEY[scopeStateOf(s)])}
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
                          <strong className="text-stone-900">{s.modeCode}</strong>
                          <span className="mt-0.5 block text-xs text-stone-500">
                            {s.fulfillmentRuleId
                              ? t("avScopeDeliveryRule")
                              : t("avScopeModeOnly")}
                          </span>
                        </td>
                        <td className="px-2 py-3 text-stone-700">
                          {t(customerSentenceKey(s))}
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
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-stone-300 bg-white p-4">
                  <span className="rounded-full bg-stone-900 px-2.5 py-1 text-xs font-extrabold text-white">
                    {t("avScopeBannerCurrent")}
                  </span>
                  <strong className="text-base text-stone-900">{selected.modeCode}</strong>
                  <span className="text-sm text-stone-600">
                    {t("avScopeTimezone")} <strong>{selected.timezone}</strong>
                  </span>
                  <span
                    data-schedule-method={method}
                    className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-extrabold text-blue-900"
                  >
                    {method === "v1.2" ? t("avMethodV12") : t("avMethodV1")}
                  </span>
                  <span className="flex-1" />
                  <label
                    className="flex items-center gap-2 text-sm font-bold text-stone-700"
                    htmlFor="av-activate"
                  >
                    {t("avActivateLabel")}
                  </label>
                  <input
                    id="av-activate"
                    type="checkbox"
                    checked={selected.enabled}
                    disabled={writeDisabled}
                    readOnly
                    aria-describedby="av-write-disabled-reason"
                    className="h-5 w-5 accent-amber-700"
                  />
                  <p
                    id="av-write-disabled-reason"
                    className="basis-full text-xs leading-relaxed text-stone-600"
                  >
                    {t(writeDisabledKey)}
                  </p>
                  <p className="basis-full text-xs leading-relaxed text-stone-600">
                    {method === "v1.2" ? t("avMethodV12Hint") : t("avMethodV1Hint")}
                  </p>
                </div>

                {/* ===== §2 — PRÉPARATION ET DÉLAIS ===== */}
                <section className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
                  <div className="border-b border-stone-100 p-4">
                    <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                      2
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-stone-900">
                      {t("avPrepTitle")}
                    </h3>
                    <p className="mt-2 max-w-3xl text-sm text-stone-600">{t("avPrepHint")}</p>
                  </div>

                  <div className="p-4">
                    <h4 className="text-sm font-extrabold text-stone-900">{t("avHowTitle")}</h4>
                    <ol className="mt-3 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
                      {[
                        ["avStep1Title", "avStep1Text"],
                        ["avStep2Title", "avStep2Text"],
                        ["avStep3Title", "avStep3Text"],
                        ["avStep4Title", "avStep4Text"],
                      ].map(([titleKey, textKey]) => (
                        <li
                          key={titleKey}
                          className="rounded-xl border border-stone-200 p-3"
                        >
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
                          value={selected.minLeadDays}
                          disabled={writeDisabled}
                          readOnly
                          className="min-h-11 w-24 rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
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
                        value={selected.timezone}
                        disabled={writeDisabled}
                        readOnly
                        className="min-h-11 w-full rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
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
                      <input
                        id="av-cutoff"
                        type="time"
                        step={60}
                        value={selected.cutoffTime ? selected.cutoffTime.slice(0, 5) : ""}
                        placeholder={t("avCutoffNone")}
                        disabled={writeDisabled}
                        readOnly
                        className="min-h-11 w-36 rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
                      />
                      {!selected.cutoffTime && (
                        <p className="mt-1.5 text-xs font-bold text-stone-700">
                          {t("avCutoffNone")}
                        </p>
                      )}
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {method === "v1.2" ? t("avCutoffHintV12") : t("avCutoffHintV1")}
                      </p>
                    </div>

                    {/* Le décalage n'existe QUE en méthode v1 : en v1.2 il
                        est refusé par la fonction ET par une contrainte,
                        donc il n'est pas affiché du tout. */}
                    {method === "v1" && (
                      <div>
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
                            value={selected.cutoffOffsetDays}
                            disabled={writeDisabled}
                            readOnly
                            className="min-h-11 w-24 rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
                          />
                          <span className="text-sm text-stone-700">
                            {t("avCutoffOffsetUnit")}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Jours de préparation — v1.2, livré non appliqué. */}
                  <div className="p-4">
                    <fieldset
                      disabled
                      className="rounded-2xl border border-blue-200 bg-blue-50 p-4"
                    >
                      <legend className="px-2 text-xs font-extrabold text-blue-900">
                        {t("avPrepDaysLabel")}
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAY_DISPLAY_ORDER.map((weekday) => {
                          const checked =
                            selectedV12?.preparationWeekdays.includes(weekday) ?? false;
                          return (
                            <label
                              key={weekday}
                              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-stone-300 bg-white px-3.5 py-2 text-sm font-bold text-stone-800"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled
                                readOnly
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
                      {(selectedV12?.preparationWeekdays.length ?? 0) === 0 && (
                        <p className="mt-1.5 text-xs font-bold text-blue-900">
                          {t("avPrepDaysEmpty")}
                        </p>
                      )}
                    </fieldset>
                  </div>

                  <details className="border-t border-stone-100">
                    <summary className="cursor-pointer p-4 text-sm font-extrabold text-amber-700">
                      {t("avAdvanced")}
                    </summary>
                    <div className="px-4 pb-4">
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
                        value={selected.leadTimeMinutes}
                        disabled={writeDisabled}
                        readOnly
                        className="min-h-11 w-32 rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
                      />
                      <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-stone-600">
                        {t("avLeadMinutesHint")}
                      </p>
                    </div>
                  </details>
                </section>

                {/* ===== §3 — DATES ET CRÉNEAUX ===== */}
                <section className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white">
                  <div className="border-b border-stone-100 p-4">
                    <p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">
                      3
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
                      <input
                        id="av-date-mode"
                        type="text"
                        value={t(dateModeKey(selected.dateSelectionMode))}
                        disabled={writeDisabled}
                        readOnly
                        className="min-h-11 w-full rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label
                        className="mb-1.5 block text-xs font-bold text-stone-700"
                        htmlFor="av-slot-mode"
                      >
                        {t("avSlotModeLabel")}
                      </label>
                      <input
                        id="av-slot-mode"
                        type="text"
                        value={t(slotModeKey(selected.slotSelectionMode))}
                        disabled={writeDisabled}
                        readOnly
                        className="min-h-11 w-full rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
                      />
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avSlotModeHint")}
                      </p>
                    </div>

                    {selected.slotSelectionMode === SLOT_MODE_FREE_TIME && (
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
                          value={selected.timeGranularityMinutes ?? ""}
                          disabled={writeDisabled}
                          readOnly
                          className="min-h-11 w-28 rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
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
                        value={selected.bookingHorizonDays}
                        disabled={writeDisabled}
                        readOnly
                        className="min-h-11 w-28 rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm"
                      />
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avHorizonHint")}
                      </p>
                    </div>
                  </div>

                  <p className="mx-4 rounded-xl border-l-4 border-amber-600 bg-amber-50 p-3 text-sm leading-relaxed text-stone-800">
                    {selected.slotSelectionMode === SLOT_MODE_FIXED_SLOTS
                      ? t("avAuthorityNoteFixedSlots")
                      : t("avAuthorityNoteWindows")}
                  </p>

                  <div className="p-4">
                    <h4 className="text-sm font-extrabold text-stone-900">
                      {selected.slotSelectionMode === SLOT_MODE_FIXED_SLOTS
                        ? t("avSlotsTitle")
                        : t("avWindowsTitle")}
                    </h4>
                    <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                      {t("avDayClosedHint")}
                    </p>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {WEEKDAY_DISPLAY_ORDER.map((weekday) => {
                        const useSlots = selected.slotSelectionMode === SLOT_MODE_FIXED_SLOTS;
                        const daySlots = selected.slots.filter((s) => s.weekday === weekday);
                        const dayWindows = selected.windows.filter(
                          (w) => w.weekday === weekday
                        );
                        const count = useSlots ? daySlots.length : dayWindows.length;
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
                              <strong className="text-sm text-stone-900">
                                {t(weekdayLabelKey(weekday))}
                              </strong>
                              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-extrabold text-stone-700">
                                {count === 0
                                  ? t("avDayClosed")
                                  : useSlots
                                    ? t("avSlotCount", { count })
                                    : t("avWindowCount", { count })}
                              </span>
                            </div>
                            {count > 0 && (
                              <ul className="mt-2 list-none space-y-1.5 p-0 text-sm text-stone-700">
                                {useSlots
                                  ? daySlots.map((s) => (
                                      <li
                                        key={`${s.slotKey}-${s.startsAt}`}
                                        className="rounded-lg border border-stone-200 px-2.5 py-1.5"
                                      >
                                        <strong>{s.slotKey}</strong> · {s.startsAt}–{s.endsAt}
                                      </li>
                                    ))
                                  : dayWindows.map((w) => (
                                      <li
                                        key={`${w.startsAt}-${w.endsAt}`}
                                        className="rounded-lg border border-stone-200 px-2.5 py-1.5"
                                      >
                                        {w.startsAt}–{w.endsAt}
                                      </li>
                                    ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
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
                      {selected.closures.length === 0 ? (
                        <p className="mt-2 text-sm text-stone-600">{t("avClosuresEmpty")}</p>
                      ) : (
                        <ul className="mt-2 list-none space-y-1.5 p-0 text-sm text-stone-700">
                          {selected.closures.map((c) => (
                            <li
                              key={c.closedOn}
                              className="rounded-lg border border-stone-200 px-2.5 py-1.5"
                            >
                              <strong>{c.closedOn}</strong> ·{" "}
                              {c.label ?? t("avClosureNoLabel")}
                            </li>
                          ))}
                        </ul>
                      )}

                      <h4 className="mt-5 text-sm font-extrabold text-blue-900">
                        {t("avClosuresPrepTitle")}
                      </h4>
                      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">
                        {t("avClosuresPrepHint")}
                      </p>
                      {(selectedV12?.preparationClosures.length ?? 0) === 0 ? (
                        <p className="mt-2 text-sm text-stone-600">{t("avClosuresEmpty")}</p>
                      ) : (
                        <ul className="mt-2 list-none space-y-1.5 p-0 text-sm text-stone-700">
                          {selectedV12!.preparationClosures.map((c) => (
                            <li
                              key={c.closedOn}
                              className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5"
                            >
                              <strong>{c.closedOn}</strong> ·{" "}
                              {c.label ?? t("avClosureNoLabel")}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

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
                        {selectedV12?.holidayCalendarId ? (
                          <>
                            <p
                              data-holiday-calendar="attached"
                              className="rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm font-bold text-blue-900"
                            >
                              {t("avHolidayCalendarAttached")}
                            </p>
                            <p className="mt-1.5 break-all font-mono text-xs text-blue-900">
                              {selectedV12.holidayCalendarId}
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

                        <fieldset
                          disabled
                          className="mt-3 rounded-xl border border-dashed border-blue-300 bg-white p-3"
                        >
                          <legend className="px-1.5 text-xs font-extrabold text-blue-900">
                            {t("avHolidayPrepPolicy")}
                          </legend>
                          <p className="text-sm text-stone-700">
                            {(selectedV12?.preparationOnHolidays ?? "open") === "closed"
                              ? t("avHolidayClosed")
                              : t("avHolidayOpen")}
                          </p>
                        </fieldset>
                        <fieldset
                          disabled
                          className="mt-2 rounded-xl border border-dashed border-blue-300 bg-white p-3"
                        >
                          <legend className="px-1.5 text-xs font-extrabold text-blue-900">
                            {t("avHolidayAvailPolicy")}
                          </legend>
                          <p className="text-sm text-stone-700">
                            {(selectedV12?.availabilityOnHolidays ?? "open") === "closed"
                              ? t("avHolidayClosed")
                              : t("avHolidayOpen")}
                          </p>
                        </fieldset>
                        <p className="mt-2 text-xs leading-relaxed text-blue-900">
                          {t("avHolidayNeedsCalendar")}
                        </p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* ===== §5 — CAPACITÉS ===== */}
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
                    <fieldset disabled className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                      <legend className="px-2 text-xs font-extrabold text-blue-900">
                        {t("avCapacityEnabledLabel")}
                      </legend>
                      <label className="flex items-center gap-3 text-sm font-bold text-blue-900">
                        <input
                          type="checkbox"
                          checked={selectedV12?.capacityEnabled ?? false}
                          disabled
                          readOnly
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
                            value={selectedV12?.capacityMaxOrders ?? ""}
                            disabled
                            readOnly
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
                              selected.slotSelectionMode
                            )}
                            className="rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm font-bold text-blue-900"
                          >
                            {capacityBucketKindOf(selected.slotSelectionMode) === "named_slot"
                              ? t("avCapacityBucketNamedSlot")
                              : t("avCapacityBucketWholeDay")}
                          </p>
                          <p className="mt-1.5 text-xs leading-relaxed text-blue-900">
                            {t("avCapacityBucketHint")}
                          </p>
                        </div>
                      </div>
                    </fieldset>

                    {capacityBucketKindOf(selected.slotSelectionMode) === "whole_day" && (
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
      </main>

      {/* ===== BARRE D'ENREGISTREMENT — INACTIVE, ET ELLE DIT POURQUOI =====
          Aucune promesse d'atomicité n'est faite, et aucune écriture
          n'est câblée : le bouton n'a pas de gestionnaire du tout. */}
      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-stone-300 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600">
            {t(writeDisabledKey)} {t("avSaveNoPartialPromise")}
          </p>
          <button
            type="button"
            disabled
            aria-disabled="true"
            data-write-disabled-reason={writeState.enabled ? "none" : writeState.reason}
            className="min-h-11 rounded-xl border border-stone-300 bg-stone-200 px-5 py-2.5 text-sm font-extrabold text-stone-500"
          >
            {t("avSaveLabel")}
          </button>
        </div>
      </div>
    </>
  );
}
