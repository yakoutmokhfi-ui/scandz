"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getMerchantRestaurants,
  getMerchantDeliveryFulfillmentPricing,
  updateMerchantDeliveryFulfillmentPricing,
} from "@/lib/services/dashboard";
import type {
  MerchantDeliveryFulfillmentPricingRule,
  MerchantRestaurant,
} from "@/lib/dashboard-types";
import DashboardNav from "@/components/dashboard/DashboardNav";
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

export default function DeliveryPricingPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const [rows, setRows] = useState<MerchantDeliveryFulfillmentPricingRule[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEdit = mapping?.role === "owner" || mapping?.role === "manager";

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setPageError(null);
    try {
      const next = await getMerchantDeliveryFulfillmentPricing(id);
      setRows(next);
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
    } catch {
      setPageError(t("dpLoadFailed"));
    }
  }, [uiLang]);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      try {
        const next = await getMerchantRestaurants();
        setMappings(next);
        const wanted = new URLSearchParams(window.location.search).get("r");
        const match = wanted ? next.find((m) => m.restaurant_id === wanted) : undefined;
        if (next.length === 0) {
          setPageError(t("mcNoRestaurant"));
        } else {
          setRestaurantId((match ?? next[0]).restaurant_id);
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

  async function save(ruleId: string) {
    const draft = drafts[ruleId];
    if (!draft) return;

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
      // Ne fait jamais confiance à l'état client comme preuve finale de
      // persistance : on relit systématiquement depuis le serveur.
      const next = await getMerchantDeliveryFulfillmentPricing(restaurantId);
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

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? t("dpTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={setRestaurantId}
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

        {!pageError && rows.length === 0 && (
          <p className="mt-4 rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-500">
            {t("dpEmpty")}
          </p>
        )}

        {rows.map((rule) => {
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
