"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getMerchantRestaurants,
  getMerchantDeliveryFulfillmentPricing,
  getMerchantDeliveryMethodNotices,
  updateMerchantDeliveryFulfillmentPricing,
  updateMerchantDeliveryMethodNotice,
} from "@/lib/services/dashboard";
import type {
  MerchantDeliveryFulfillmentPricingRule,
  MerchantDeliveryMethodNotice,
  MerchantRestaurant,
} from "@/lib/dashboard-types";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { useRestaurantContextGuard } from "@/lib/restaurant-context-guard";
import { translate, type Lang } from "@/lib/i18n";

/**
 * Dashboard Delivery Pricing v1 — mission "SCANYM — CIO REQUIREMENT —
 * DASHBOARD DELIVERY PRICING v1 — SAFE MERCHANT EDITING ONLY".
 *
 * PÉRIMÈTRE STRICT : permet à un owner/manager d'éditer UNIQUEMENT
 * pricing_mode/fixed_fee/free_threshold/customer_text sur des règles
 * de livraison DÉJÀ configurées par Scanym. Aucun éditeur de routage,
 * de zone, de prestataire, ni de création/suppression de règle --
 * ces champs restent structurels et ne sont ni lus ni affichés ici
 * (voir get_merchant_delivery_fulfillment_pricing, qui ne les
 * retourne jamais).
 *
 * Save PAR RÈGLE (mission : "Per-rule Save is preferred for
 * simplicity"), chaque sauvegarde est atomique côté serveur (une
 * seule règle par appel RPC). Après un succès, les valeurs sont
 * RELUES depuis le serveur (jamais l'état client seul comme preuve de
 * persistance -- mission : "Do not use client state as final proof
 * of persistance").
 */

interface RuleDraft {
  pricingMode: "fixed" | "free_above_threshold";
  fixedFee: string;
  freeThreshold: string;
  customerText: string;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

function draftFromRule(rule: MerchantDeliveryFulfillmentPricingRule): RuleDraft {
  return {
    pricingMode: rule.pricingMode,
    fixedFee: rule.fixedFee === null ? "" : String(rule.fixedFee),
    freeThreshold: rule.freeThreshold === null ? "" : String(rule.freeThreshold),
    customerText: rule.customerText ?? "",
    saving: false,
    error: null,
    saved: false,
  };
}

interface ModeNoticeDraft {
  customerText: string;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

function draftFromMode(mode: MerchantDeliveryMethodNotice): ModeNoticeDraft {
  return {
    customerText: mode.customerText ?? "",
    saving: false,
    error: null,
    saved: false,
  };
}

export default function DeliveryPricingPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  // OPERATOR DASHBOARD CONTEXT v1 -- même patron déjà audité/publié
  // que app/dashboard/settings/page.tsx (F-01) : un opérateur Scanym
  // consultant un établissement hors de ses propres rattachements
  // restaurant_users doit voir le restaurant CIBLÉ (?r=<id>), jamais
  // un repli silencieux vers son propre rattachement.
  //
  // DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 (CIO GO) : les RPC
  // sous-jacentes de ce module (get_merchant_delivery_fulfillment_pricing
  // en LECTURE, update_merchant_delivery_fulfillment_pricing en
  // ÉCRITURE) acceptent désormais aussi is_scanym_operator() à côté de
  // is_member_of()/has_role_in(['owner','manager']) (contrat marchand
  // inchangé, voir DRAFT-lot-delivery-pricing-operator-authorization-
  // v1.sql). `canEdit` ci-dessous reflète ce delta minimal : un
  // opérateur authentique, ciblant un établissement HORS de ses
  // propres rattachements restaurant_users (`!mapping`), obtient
  // désormais l'édition pour l'établissement déjà résolu par le
  // contexte opérateur (F-01, ?r=<id> fait foi) -- le comportement
  // marchand (owner/manager) reste STRICTEMENT inchangé, aucun rôle
  // staff/non-marchand n'obtient l'édition par ce delta, et un
  // opérateur qui a AUSSI un rattachement restaurant_users explicite
  // sur cet établissement (mapping non nul) continue de suivre
  // exactement la règle marchande de ce mapping (jamais de double
  // chemin, jamais de contournement du rôle marchand réel).
  const [isOperator, setIsOperator] = useState(false);
  const [operatorRestaurantName, setOperatorRestaurantName] = useState<string | null>(null);
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const [rows, setRows] = useState<MerchantDeliveryFulfillmentPricingRule[]>([]);
  const [modeNotices, setModeNotices] = useState<MerchantDeliveryMethodNotice[]>([]);
  /**
   * CONTEXT HARDENING v1.1 (§5) -- PROVENANCE explicite des tarifs en
   * mémoire. `null` = rien de fiable pour le contexte courant.
   */
  const [pricingLoadedRestaurantId, setPricingLoadedRestaurantId] = useState<string | null>(null);
  const [noticesLoadedRestaurantId, setNoticesLoadedRestaurantId] = useState<string | null>(null);
  /** CONTEXT HARDENING v1.1 -- contrat anti-réponse-périmée partagé. */
  const guard = useRestaurantContextGuard();
  /**
   * MOBILE STICKY + DELIVERY DELAY NOTICE v1.2 (OW-MSDD-STALE-ABA-01) --
   * GÉNÉRATION DE CONTEXTE, incrémentée à CHAQUE entrée de contexte
   * (sélection initiale, A -> B, B -> A). Un restaurant_id seul ne suffit
   * pas : après A -> B -> A, une opération lancée pendant la PREMIÈRE
   * visite de A voit de nouveau currentRestaurantId() === A. La
   * génération, elle, a changé deux fois : l'opération reste périmée.
   * Volontairement distincte de guard.beginRequest(), dont la séquence
   * est partagée avec les chargements (l'utiliser pour une sauvegarde
   * invaliderait un chargement légitime en vol, et inversement).
   */
  const contextGenerationRef = useRef(0);
  const enterDashboardContext = useCallback(
    (id: string) => {
      contextGenerationRef.current += 1;
      guard.enterContext(id);
    },
    [guard]
  );
  /** CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble. */
  const [unavailableContextId, setUnavailableContextId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [modeDrafts, setModeDrafts] = useState<Record<string, ModeNoticeDraft>>({});
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  // DELIVERY PRICING OPERATOR AUTHORIZATION v1.2 (audit Cat Woman —
  // remédiation ciblée). v1.1 limitait le bypass opérateur au cas
  // `isOperator && !mapping`, ce qui refusait à tort l'édition à un
  // opérateur authentique possédant AUSSI un rattachement
  // restaurant_users de rôle "staff" sur l'établissement ciblé --
  // alors que l'autorisation SQL (is_scanym_operator(), indépendante
  // de toute adhésion marchande) l'autorise déjà sans condition. La
  // logique frontend reflète maintenant exactement ce contrat SQL :
  // un opérateur Scanym authentique (isOperator) peut TOUJOURS éditer
  // l'établissement déjà résolu par le contexte opérateur ci-dessus,
  // quel que soit son éventuel rôle marchand sur cet établissement
  // (aucun mapping, ou mapping staff/manager/owner) -- owner/manager
  // non-opérateur gardent exactement le même accès qu'avant, staff
  // non-opérateur reste refusé (contrat marchand inchangé).
  const canEdit =
    isOperator ||
    mapping?.role === "owner" ||
    mapping?.role === "manager";

  const load = useCallback(async (id: string) => {
    if (!id) return;
    // CONTEXT HARDENING v1.1 -- ferme CTXHARD-V1-STALE-RESPONSE-01 sur
    // ce module de configuration (même contrat partagé que Catalogue et
    // CGV : génération + restaurant actif + composant monté).
    const token = guard.beginRequest(id);
    // §5 -- invalidation IMMÉDIATE de la provenance.
    setPricingLoadedRestaurantId(null);
    setNoticesLoadedRestaurantId(null);
    setPageError(null);
    try {
      const [next, nextNotices] = await Promise.all([
        getMerchantDeliveryFulfillmentPricing(id),
        getMerchantDeliveryMethodNotices(id),
      ]);
      // Réponse PÉRIMÉE -> ABANDONNÉE intégralement.
      if (!token.isCurrent()) return;
      // Commit ATOMIQUE : tarifs et provenance dans la même passe.
      setRows(next);
      setModeNotices(nextNotices);
      setPricingLoadedRestaurantId(id);
      setNoticesLoadedRestaurantId(id);
      setDrafts((prev) => {
        const merged: Record<string, RuleDraft> = {};
        for (const rule of next) {
          // Une sauvegarde en cours ou un message encore affiché pour
          // cette règle n'est pas écrasé par un simple rechargement --
          // seul un succès explicite (voir save()) réinitialise à
          // partir des valeurs serveur.
          merged[rule.ruleId] = prev[rule.ruleId] ?? draftFromRule(rule);
        }
        return merged;
      });
      setModeDrafts((prev) => {
        const merged: Record<string, ModeNoticeDraft> = {};
        for (const mode of nextNotices) {
          merged[mode.modeCode] = prev[mode.modeCode] ?? draftFromMode(mode);
        }
        return merged;
      });
    } catch {
      if (!token.isCurrent()) return;
      setPageError(t("dpLoadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiLang, guard]);

  /**
   * CONTEXT HARDENING v1.1 (§5) -- bascule pilotée par l'utilisateur :
   * invalidation et changement de contexte dans le MÊME gestionnaire.
   */
  const handleSelectRestaurant = useCallback(
    (id: string) => {
      enterDashboardContext(id);
      setRows([]);
      setModeNotices([]);
      setDrafts({});
      setModeDrafts({});
      setPricingLoadedRestaurantId(null);
      setNoticesLoadedRestaurantId(null);
      setRestaurantId(id);
    },
    [enterDashboardContext]
  );

  /**
   * CONTEXT HARDENING v1.1 (§5) -- SEULE source d'affichage locataire :
   * le rendu exige `provenance === contexte courant`.
   */
  const rowsInContext =
    pricingLoadedRestaurantId === restaurantId && restaurantId ? rows : [];
  const modeNoticesInContext =
    noticesLoadedRestaurantId === restaurantId && restaurantId ? modeNotices : [];

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
        // CONTEXT HARDENING v1 -- résolution UNIQUE et partagée : plus
        // aucun `match ?? next[0]`, donc plus de bascule silencieuse.
        const resolution = resolveRestaurantContext({
          requestedId: wanted,
          mappings: next,
          isOperator: opFlag,
        });

        if (resolution.kind === "unavailable") {
          setUnavailableContextId(resolution.requestedId);
        } else if (resolution.kind === "none") {
          setPageError(t("mcNoRestaurant"));
        } else {
          setUnavailableContextId(null);
          enterDashboardContext(resolution.restaurantId);
          setRestaurantId(resolution.restaurantId);
          if (resolution.source === "operator") {
            // OPERATOR DASHBOARD CONTEXT v1 : même correction F-01 que
            // settings/page.tsx et dashboard/catalogue/page.tsx. Le lien
            // ?r=<id> fait foi côté affichage uniquement -- la
            // protection réelle reste côté RPC. Depuis DELIVERY PRICING
            // OPERATOR AUTHORIZATION v1.1,
            // get_merchant_delivery_fulfillment_pricing et
            // update_merchant_delivery_fulfillment_pricing acceptent
            // aussi is_scanym_operator() à côté de la condition
            // marchande existante (préservée à l'identique).
            // JAMAIS de repli sur next[0] : c'est désormais le
            // résolveur partagé qui le garantit (fail closed).
            try {
              const summary = await getEstablishmentSummary(resolution.restaurantId);
              setOperatorRestaurantName(summary.name);
            } catch {
              // Best-effort : un nom introuvable n'empêche pas de
              // continuer (l'ID reste la source de vérité).
            }
          }
        }
      } catch {
        setPageError(t("dpLoadFailed"));
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [router]);

  useEffect(() => {
    void load(restaurantId);
  }, [restaurantId, load]);

  function updateDraft(ruleId: string, patch: Partial<RuleDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [ruleId]: { ...prev[ruleId], ...patch, error: null, saved: false },
    }));
  }

  function updateModeDraft(modeCode: string, patch: Partial<ModeNoticeDraft>) {
    setModeDrafts((prev) => ({
      ...prev,
      [modeCode]: { ...prev[modeCode], ...patch, error: null, saved: false },
    }));
  }

  async function saveModeNotice(modeCode: "pickup" | "delivery") {
    const draft = modeDrafts[modeCode];
    if (!draft) return;
    const targetRestaurantId = restaurantId;
    // v1.2 -- identité de l'opération = restaurant ET génération de
    // contexte au moment du lancement. Une continuation n'est valide que
    // si les DEUX sont encore courants ; sinon elle est un no-op
    // silencieux pour l'UI (la mutation serveur déjà envoyée n'est ni
    // annulée ni compensée -- seul le contexte UI courant est protégé).
    const operationGeneration = contextGenerationRef.current;
    const isOperationCurrent = () =>
      guard.currentRestaurantId() === targetRestaurantId &&
      contextGenerationRef.current === operationGeneration;
    const customerText = draft.customerText.trim() === "" ? null : draft.customerText.trim();
    if (customerText !== null && customerText.length > 500) {
      updateModeDraft(modeCode, { error: t("dpTextTooLong") });
      return;
    }

    setModeDrafts((prev) => ({
      ...prev,
      [modeCode]: { ...prev[modeCode], saving: true, error: null, saved: false },
    }));
    try {
      await updateMerchantDeliveryMethodNotice({
        restaurantId: targetRestaurantId,
        modeCode,
        customerText,
      });
      // Garde 1 -- après la mutation, AVANT toute relecture.
      if (!isOperationCurrent()) return;
      const next = await getMerchantDeliveryMethodNotices(targetRestaurantId);
      // Garde 2 -- après la relecture, AVANT d'appliquer l'état relu et
      // d'afficher « Enregistré » (application synchrone ci-dessous).
      if (!isOperationCurrent()) return;
      setModeNotices(next);
      const updated = next.find((mode) => mode.modeCode === modeCode);
      setModeDrafts((prev) => ({
        ...prev,
        [modeCode]: updated
          ? { ...draftFromMode(updated), saved: true }
          : { ...prev[modeCode], saving: false, saved: true },
      }));
    } catch {
      // Garde 3 -- chemin d'échec, AVANT d'afficher l'erreur.
      if (!isOperationCurrent()) return;
      setModeDrafts((prev) => ({
        ...prev,
        [modeCode]: { ...prev[modeCode], saving: false, error: t("dpSaveFailed") },
      }));
    }
  }

  async function save(ruleId: string) {
    const draft = drafts[ruleId];
    if (!draft) return;
    const targetRestaurantId = restaurantId;
    // v1.3 (QA-MSDD-PRICING-ABA-03) -- même principe que saveModeNotice
    // (v1.2), même mécanisme de génération (contextGenerationRef, aucun
    // second modèle de contexte) : l'opération est identifiée par le
    // restaurant ET la génération de contexte au lancement. Après
    // A -> B -> A, une sauvegarde lancée pendant la PREMIÈRE visite de A
    // reste périmée : sa continuation est un no-op UI silencieux (la
    // mutation serveur déjà envoyée n'est ni annulée ni compensée).
    const operationGeneration = contextGenerationRef.current;
    const isOperationCurrent = () =>
      guard.currentRestaurantId() === targetRestaurantId &&
      contextGenerationRef.current === operationGeneration;

    // Validation client -- MIROIR de la validation serveur autoritaire
    // (update_merchant_delivery_fulfillment_pricing), jamais un
    // substitut : le serveur revalide tout, y compris ce que ce
    // formulaire ne pourrait pas produire (voir mission "SERVER
    // AUTHORITY").
    const fee = Number(draft.fixedFee);
    if (draft.fixedFee.trim() === "" || Number.isNaN(fee) || fee < 0) {
      updateDraft(ruleId, { error: t("dpInvalidFee") });
      return;
    }
    let threshold: number | null = null;
    if (draft.pricingMode === "free_above_threshold") {
      const parsedThreshold = Number(draft.freeThreshold);
      if (draft.freeThreshold.trim() === "" || Number.isNaN(parsedThreshold) || parsedThreshold < 0) {
        updateDraft(ruleId, { error: t("dpInvalidThreshold") });
        return;
      }
      threshold = parsedThreshold;
    }
    const customerText = draft.customerText.trim() === "" ? null : draft.customerText;
    if (customerText !== null && customerText.length > 500) {
      updateDraft(ruleId, { error: t("dpTextTooLong") });
      return;
    }

    setDrafts((prev) => ({
      ...prev,
      [ruleId]: { ...prev[ruleId], saving: true, error: null, saved: false },
    }));
    try {
      await updateMerchantDeliveryFulfillmentPricing({
        ruleId,
        pricingMode: draft.pricingMode,
        fixedFee: fee,
        freeThreshold: threshold,
        customerText,
      });
      // Garde 1 -- après la mutation, AVANT toute relecture.
      if (!isOperationCurrent()) return;
      // Ne fait jamais confiance à l'état client comme preuve finale de
      // persistance : on relit systématiquement depuis le serveur.
      const next = await getMerchantDeliveryFulfillmentPricing(targetRestaurantId);
      // Garde 2 -- après la relecture, AVANT d'appliquer l'état relu et
      // d'afficher « Enregistré » (application synchrone ci-dessous).
      if (!isOperationCurrent()) return;
      setRows(next);
      setDrafts((prev) => {
        const merged = { ...prev };
        const updated = next.find((r) => r.ruleId === ruleId);
        merged[ruleId] = updated
          ? { ...draftFromRule(updated), saved: true }
          : { ...prev[ruleId], saving: false, saved: true };
        return merged;
      });
    } catch {
      // Garde 3 -- chemin d'échec, AVANT d'afficher l'erreur.
      if (!isOperationCurrent()) return;
      // Erreur SÛRE pour le marchand uniquement -- jamais le message
      // brut du serveur (code SQL, détail interne) affiché ici
      // (mission : "no SQL/internal security details").
      setDrafts((prev) => ({
        ...prev,
        [ruleId]: { ...prev[ruleId], saving: false, error: t("dpSaveFailed") },
      }));
    }
  }

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">{t("mcLoading")}</main>;
  }

  // CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble :
  // état dédié, aucun établissement sélectionné, aucune donnée chargée.
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
        restaurantName={mapping?.restaurants?.name ?? operatorRestaurantName ?? t("dpTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={handleSelectRestaurant}
      />

      <main className="mx-auto max-w-2xl px-4 py-6">
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          &larr; {t("dsBackToOrders")}
        </a>

        <h2 className="text-xl font-black text-stone-900">{t("dpTitle")}</h2>
        <p className="mt-1 text-sm text-stone-500">{t("dpHint")}</p>

        {!canEdit && (
          <p className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-600">
            {t("dpStaffOnly")}
          </p>
        )}

        {pageError && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {pageError}
          </p>
        )}

        {!pageError && rowsInContext.length === 0 && modeNoticesInContext.length === 0 && (
          <p className="mt-4 rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-500">
            {t("dpEmpty")}
          </p>
        )}

        {modeNoticesInContext.length > 0 && (
          <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
            <h3 className="font-bold text-stone-900">{t("dpNoticeSectionTitle")}</h3>
            <p className="mt-1 text-sm text-stone-500">{t("dpNoticeSectionHint")}</p>
            <div className="mt-4 space-y-5">
              {modeNoticesInContext.map((mode) => {
                const draft = modeDrafts[mode.modeCode] ?? draftFromMode(mode);
                return (
                  <div key={mode.modeCode} data-delivery-method-notice={mode.modeCode}>
                    <label
                      htmlFor={`delivery-method-notice-${mode.modeCode}`}
                      className="block text-sm font-bold text-stone-900"
                    >
                      {mode.modeLabel}
                    </label>
                    <textarea
                      id={`delivery-method-notice-${mode.modeCode}`}
                      value={draft.customerText}
                      disabled={!canEdit}
                      maxLength={500}
                      rows={3}
                      placeholder={t("dpNoticePlaceholder")}
                      onChange={(event) =>
                        updateModeDraft(mode.modeCode, { customerText: event.target.value })
                      }
                      className="mt-1 w-full resize-y rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
                    />
                    {canEdit && (
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          type="button"
                          disabled={draft.saving}
                          onClick={() => void saveModeNotice(mode.modeCode)}
                          className="rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                        >
                          {draft.saving ? t("dpSaving") : t("dpSave")}
                        </button>
                        {draft.saved && (
                          <span className="text-sm font-semibold text-green-700">{t("dpSaved")}</span>
                        )}
                        {draft.error && (
                          <span className="text-sm font-semibold text-amber-700">{draft.error}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {rowsInContext.map((rule) => {
          const draft = drafts[rule.ruleId] ?? draftFromRule(rule);
          return (
            <section
              key={rule.ruleId}
              className="mt-4 rounded-2xl border border-stone-200 bg-white p-4"
            >
              <h3 className="font-bold text-stone-900">{rule.fulfillmentLabel}</h3>

              <label className="mt-3 block text-xs font-semibold text-stone-600">
                {t("dpPricingMode")}
              </label>
              <select
                value={draft.pricingMode}
                disabled={!canEdit}
                onChange={(e) =>
                  updateDraft(rule.ruleId, {
                    pricingMode: e.target.value as "fixed" | "free_above_threshold",
                  })
                }
                className="mt-1 w-full rounded-xl border border-stone-300 bg-white p-2.5 text-sm disabled:bg-stone-50"
              >
                <option value="fixed">{t("dpFixed")}</option>
                <option value="free_above_threshold">{t("dpFreeAboveThreshold")}</option>
              </select>

              <label className="mt-3 block text-xs font-semibold text-stone-600">
                {t("dpFixedFee")}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={draft.fixedFee}
                disabled={!canEdit}
                onChange={(e) => updateDraft(rule.ruleId, { fixedFee: e.target.value })}
                className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
              />

              {draft.pricingMode === "free_above_threshold" && (
                <>
                  <label className="mt-3 block text-xs font-semibold text-stone-600">
                    {t("dpFreeThreshold")}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={draft.freeThreshold}
                    disabled={!canEdit}
                    onChange={(e) => updateDraft(rule.ruleId, { freeThreshold: e.target.value })}
                    className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
                  />
                </>
              )}

              <label className="mt-3 block text-xs font-semibold text-stone-600">
                {t("dpCustomerText")}
              </label>
              <textarea
                value={draft.customerText}
                disabled={!canEdit}
                maxLength={500}
                rows={3}
                onChange={(e) => updateDraft(rule.ruleId, { customerText: e.target.value })}
                className="mt-1 w-full resize-y rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
              />

              {canEdit && (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={draft.saving}
                    onClick={() => save(rule.ruleId)}
                    className="rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                  >
                    {draft.saving ? t("dpSaving") : t("dpSave")}
                  </button>
                  {draft.saved && (
                    <span className="text-sm font-semibold text-green-700">
                      {t("dpSaved")}
                    </span>
                  )}
                  {draft.error && (
                    <span className="text-sm font-semibold text-amber-700">
                      {draft.error}
                    </span>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </main>
    </>
  );
}
