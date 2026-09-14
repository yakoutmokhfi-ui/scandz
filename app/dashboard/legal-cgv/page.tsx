"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { getMerchantRestaurants } from "@/lib/services/dashboard";
import type { MerchantRestaurant, MerchantLegalProfile, MerchantCgvProfile } from "@/lib/dashboard-types";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { translate, type Lang } from "@/lib/i18n";
import {
  getMerchantLegalProfile,
  updateMerchantLegalProfile,
  getMerchantCgvProfile,
  updateMerchantCgvProfile,
  publishMerchantCgvVersion,
  activateMerchantCgv,
  PublishCgvError,
} from "@/lib/services/legal-cgv";
import { supabase } from "@/lib/supabase";
import { renderCgv, type CgvTemplateControlledSections } from "@/lib/legal/render";

/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1 -- Phase 1, Section M.
 *
 * Mêmes conventions que app/dashboard/delivery-pricing/page.tsx :
 * contexte opérateur (?r=<id>, F-01), rôle canEdit = owner/manager +
 * opérateur (assert_legal_cgv_role, section H du mandat -- écriture
 * réservée). Sept sections VISUELLEMENT séparées, dans l'ordre du
 * mandat : 1. identité vendeur, 2. informations légales obligatoires,
 * 3. conditions commerciales (annulation/substitution), 4. délai de
 * préparation, 5. régime de rétractation, 6. aperçu CGV, 7. publier /
 * activer. Aucune zone de texte libre pour le gabarit légal -- le
 * marchand ne configure jamais le texte-cœur, seulement les
 * paramètres (mandat section M : "No unrestricted legal-template
 * textarea").
 */
export default function LegalCgvPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [isOperator, setIsOperator] = useState(false);
  const [operatorRestaurantName, setOperatorRestaurantName] = useState<string | null>(null);
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [legal, setLegal] = useState<Partial<MerchantLegalProfile>>({});
  const [cgv, setCgv] = useState<MerchantCgvProfile | null>(null);
  const [template, setTemplate] = useState<CgvTemplateControlledSections & { id: string } | null>(null);
  const [sellerName, setSellerName] = useState("");
  const [saving, setSaving] = useState(false);

  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);
  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEdit = isOperator || mapping?.role === "owner" || mapping?.role === "manager";

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setPageError(null);
    try {
      const [legalRow, cgvRow, templateRow] = await Promise.all([
        getMerchantLegalProfile(id),
        getMerchantCgvProfile(id),
        supabase.rpc("get_applicable_cgv_template", { p_restaurant_id: id }),
      ]);
      setLegal(legalRow ?? {});
      setCgv(cgvRow);
      const tpl = templateRow.data as { id: string; controlled_sections: CgvTemplateControlledSections } | null;
      setTemplate(tpl?.id ? { id: tpl.id, ...tpl.controlled_sections } : null);
    } catch {
      setPageError(t("legalCgvLoadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      try {
        const [next, opFlag] = await Promise.all([getMerchantRestaurants(), isScanymOperator()]);
        setIsOperator(opFlag);
        setMappings(next);

        const wanted = new URLSearchParams(window.location.search).get("r");
        const match = wanted ? next.find((m) => m.restaurant_id === wanted) : undefined;

        if (wanted && !match && opFlag) {
          setRestaurantId(wanted);
          try {
            const summary = await getEstablishmentSummary(wanted);
            setOperatorRestaurantName(summary.name);
            setSellerName(summary.name);
          } catch {
            // best-effort
          }
        } else if (next.length === 0) {
          setPageError(t("legalCgvNoRestaurant"));
        } else {
          const chosen = match ?? next[0];
          setRestaurantId(chosen.restaurant_id);
          setSellerName(chosen.restaurants?.name ?? "");
        }
      } catch {
        setPageError(t("legalCgvLoadFailed"));
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [router]);

  useEffect(() => {
    void load(restaurantId);
  }, [restaurantId, load]);

  async function saveLegal() {
    setSaving(true);
    setActionMessage(null);
    try {
      await updateMerchantLegalProfile({
        restaurantId,
        legalForm: legal.legal_form ?? null,
        addressLine1: legal.address_line1 ?? null,
        addressLine2: legal.address_line2 ?? null,
        postalCode: legal.postal_code ?? null,
        city: legal.city ?? null,
        governingCountry: legal.governing_country ?? null,
        customerServiceEmail: legal.customer_service_email ?? null,
        customerServicePhone: legal.customer_service_phone ?? null,
        consumerMediatorName: legal.consumer_mediator_name ?? null,
        consumerMediatorAddress: legal.consumer_mediator_address ?? null,
        consumerMediatorWebsite: legal.consumer_mediator_website ?? null,
      });
      await load(restaurantId);
      setActionMessage(t("legalCgvSaved"));
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : t("legalCgvSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function saveCgvProfile() {
    if (!cgv) return;
    setSaving(true);
    setActionMessage(null);
    try {
      await updateMerchantCgvProfile({
        restaurantId,
        withdrawalRegime: cgv.withdrawal_regime,
        preparationTimeMin: cgv.preparation_time_min,
        preparationTimeMax: cgv.preparation_time_max,
        preparationTimeUnit: cgv.preparation_time_unit,
        cancellationPolicyText: cgv.cancellation_policy_text,
        substitutionPolicyText: cgv.substitution_policy_text,
        presentationVariant: cgv.presentation_variant,
      });
      await load(restaurantId);
      setActionMessage(t("legalCgvSaved"));
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : t("legalCgvSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function buildPreview(): string | null {
    if (!template || !cgv || !cgv.withdrawal_regime || cgv.preparation_time_min == null || cgv.preparation_time_max == null || !cgv.preparation_time_unit) {
      return null;
    }
    try {
      return renderCgv({
        sellerName: sellerName || "—",
        template,
        legal: {
          legalForm: legal.legal_form ?? "",
          addressLine1: legal.address_line1 ?? "",
          addressLine2: legal.address_line2 ?? null,
          postalCode: legal.postal_code ?? "",
          city: legal.city ?? "",
          governingCountry: legal.governing_country ?? "",
          customerServiceEmail: legal.customer_service_email ?? null,
          customerServicePhone: legal.customer_service_phone ?? null,
          mediatorName: legal.consumer_mediator_name ?? "",
          mediatorAddress: legal.consumer_mediator_address ?? "",
          mediatorWebsite: legal.consumer_mediator_website ?? "",
        },
        business: {
          withdrawalRegime: cgv.withdrawal_regime,
          preparationTimeMin: cgv.preparation_time_min,
          preparationTimeMax: cgv.preparation_time_max,
          preparationTimeUnit: cgv.preparation_time_unit,
          cancellationPolicyText: cgv.cancellation_policy_text,
          substitutionPolicyText: cgv.substitution_policy_text,
        },
        locale: "fr",
        presentationVariant: cgv.presentation_variant,
      });
    } catch {
      return null;
    }
  }

  /**
   * v1.1 (Catimini, Blocker 1, CGV-V1-PUBLISH-AUTHORITY-01) — la
   * publication n'envoie plus JAMAIS `rendered`/`template.id`/
   * `cgv.presentation_variant` au serveur : `publishMerchantCgvVersion`
   * ne prend plus qu'un `restaurantId` (voir lib/services/legal-cgv.ts
   * et lib/server/legal-cgv-publish-service.ts). `buildPreview()`
   * ci-dessus reste utilisé UNIQUEMENT pour l'aperçu à l'écran (section
   * 6) — un aperçu purement indicatif du dernier état SAUVEGARDÉ ; le
   * serveur re-résout et re-rend indépendamment, à partir de l'état
   * réellement stocké, au moment de la publication elle-même. Ce
   * garde local (`!buildPreview()` -> message d'incomplétude) reste un
   * confort UX qui évite un aller-retour réseau pour le cas le plus
   * fréquent -- jamais l'autorité : le serveur revérifie la
   * complétude de toute façon (resolve_cgv_publication_context).
   */
  async function publish() {
    if (!template) return;
    if (!buildPreview()) {
      setActionMessage(t("legalCgvIncomplete"));
      return;
    }
    setSaving(true);
    setActionMessage(null);
    try {
      await publishMerchantCgvVersion({ restaurantId });
      await load(restaurantId);
      setActionMessage(t("legalCgvPublished"));
    } catch (e) {
      // v1.2 (CGV-V11-PUBLISH-CONTEXT-RACE-01) -- a stale-context
      // rejection is retriable (the profile changed server-side
      // between resolve and persist): tell the merchant to retry
      // rather than showing the generic failure message, which reads
      // as a permanent error.
      setActionMessage(
        e instanceof PublishCgvError && e.reason === "stale_context"
          ? t("legalCgvPublishStale")
          : t("legalCgvPublishFailed")
      );
    } finally {
      setSaving(false);
    }
  }

  async function activate() {
    setSaving(true);
    setActionMessage(null);
    try {
      await activateMerchantCgv(restaurantId);
      await load(restaurantId);
      setActionMessage(t("legalCgvActivated"));
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : t("legalCgvActivateFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-6 text-center text-sm text-stone-500">…</div>;

  const restaurantName =
    mappings.find((m) => m.restaurant_id === restaurantId)?.restaurants?.name ?? operatorRestaurantName ?? "";

  const preview = buildPreview();

  return (
    <div className="min-h-screen bg-stone-50 pb-16">
      <DashboardNav
        restaurantName={restaurantName}
        restaurantId={restaurantId}
        mappings={mappings}
        onSelectRestaurant={setRestaurantId}
        staffLanguage={uiLang}
      />
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <h1 className="text-xl font-bold text-stone-900">{t("legalCgvTitle")}</h1>
        {pageError && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{pageError}</p>}
        {actionMessage && <p className="rounded-xl bg-stone-100 p-3 text-sm text-stone-700">{actionMessage}</p>}
        {!canEdit && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{t("legalCgvReadOnly")}</p>}

        <section className="rounded-2xl border border-stone-200 bg-white p-4">
          <h2 className="mb-1 font-bold text-stone-900">1. {t("legalCgvSectionIdentity")}</h2>
          <p className="text-sm text-stone-500">{sellerName}</p>
        </section>

        <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
          <h2 className="font-bold text-stone-900">2. {t("legalCgvSectionMandatory")}</h2>
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvLegalForm")}
            value={legal.legal_form ?? ""} onChange={(e) => setLegal((p) => ({ ...p, legal_form: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvAddressLine1")}
            value={legal.address_line1 ?? ""} onChange={(e) => setLegal((p) => ({ ...p, address_line1: e.target.value }))} />
          <div className="flex gap-2">
            <input disabled={!canEdit} className="w-1/3 rounded-lg border p-2 text-sm" placeholder={t("legalCgvPostalCode")}
              value={legal.postal_code ?? ""} onChange={(e) => setLegal((p) => ({ ...p, postal_code: e.target.value }))} />
            <input disabled={!canEdit} className="w-2/3 rounded-lg border p-2 text-sm" placeholder={t("legalCgvCity")}
              value={legal.city ?? ""} onChange={(e) => setLegal((p) => ({ ...p, city: e.target.value }))} />
          </div>
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvCustomerServiceEmail")}
            value={legal.customer_service_email ?? ""} onChange={(e) => setLegal((p) => ({ ...p, customer_service_email: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorName")}
            value={legal.consumer_mediator_name ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_name: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorAddress")}
            value={legal.consumer_mediator_address ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_address: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorWebsite")}
            value={legal.consumer_mediator_website ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_website: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder="FR"
            value={legal.governing_country ?? ""} onChange={(e) => setLegal((p) => ({ ...p, governing_country: e.target.value.toUpperCase() }))} />
          {canEdit && <button disabled={saving} onClick={saveLegal} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white">{t("legalCgvSave")}</button>}
        </section>

        {cgv && (
          <>
            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">3. {t("legalCgvSectionBusiness")}</h2>
              <textarea disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvCancellationPolicy")}
                value={cgv.cancellation_policy_text ?? ""} onChange={(e) => setCgv({ ...cgv, cancellation_policy_text: e.target.value })} />
              <textarea disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvSubstitutionPolicy")}
                value={cgv.substitution_policy_text ?? ""} onChange={(e) => setCgv({ ...cgv, substitution_policy_text: e.target.value })} />
            </section>

            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">4. {t("legalCgvSectionPreparation")}</h2>
              <div className="flex gap-2">
                <input disabled={!canEdit} type="number" className="w-1/3 rounded-lg border p-2 text-sm" placeholder={t("legalCgvMin")}
                  value={cgv.preparation_time_min ?? ""} onChange={(e) => setCgv({ ...cgv, preparation_time_min: e.target.value ? Number(e.target.value) : null })} />
                <input disabled={!canEdit} type="number" className="w-1/3 rounded-lg border p-2 text-sm" placeholder={t("legalCgvMax")}
                  value={cgv.preparation_time_max ?? ""} onChange={(e) => setCgv({ ...cgv, preparation_time_max: e.target.value ? Number(e.target.value) : null })} />
                <select disabled={!canEdit} className="w-1/3 rounded-lg border p-2 text-sm"
                  value={cgv.preparation_time_unit ?? ""} onChange={(e) => setCgv({ ...cgv, preparation_time_unit: (e.target.value || null) as typeof cgv.preparation_time_unit })}>
                  <option value="">—</option>
                  <option value="MINUTES">{t("legalCgvMinutes")}</option>
                  <option value="HOURS">{t("legalCgvHours")}</option>
                </select>
              </div>
            </section>

            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">5. {t("legalCgvSectionWithdrawal")}</h2>
              <select disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm"
                value={cgv.withdrawal_regime ?? ""} onChange={(e) => setCgv({ ...cgv, withdrawal_regime: (e.target.value || null) as typeof cgv.withdrawal_regime })}>
                <option value="">—</option>
                <option value="EXEMPT_PERISHABLE">{t("legalCgvExemptPerishable")}</option>
                <option value="STANDARD_14_DAYS">{t("legalCgvStandard14Days")}</option>
                <option value="MIXED">{t("legalCgvMixed")}</option>
              </select>
              {canEdit && <button disabled={saving} onClick={saveCgvProfile} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white">{t("legalCgvSave")}</button>}
            </section>

            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">6. {t("legalCgvSectionPreview")}</h2>
              {cgv.completeness_errors.length > 0 ? (
                <ul className="list-inside list-disc text-sm text-amber-800">
                  {cgv.completeness_errors.map((code) => (
                    <li key={code}>{t(`legalCgvError_${code}`) !== `legalCgvError_${code}` ? t(`legalCgvError_${code}`) : code}</li>
                  ))}
                </ul>
              ) : preview ? (
                <div className="prose prose-sm max-h-96 overflow-y-auto rounded-lg border p-3" dangerouslySetInnerHTML={{ __html: preview }} />
              ) : (
                <p className="text-sm text-stone-500">{t("legalCgvIncomplete")}</p>
              )}
            </section>

            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">7. {t("legalCgvSectionPublish")}</h2>
              <p className="text-sm text-stone-500">{t("legalCgvStatus")}: <strong>{cgv.status}</strong></p>
              {canEdit && (
                <div className="flex gap-2">
                  <button disabled={saving || cgv.completeness_errors.length > 0} onClick={publish} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                    {t("legalCgvPublish")}
                  </button>
                  {cgv.status !== "CGV_ACTIVE" && (
                    <button disabled={saving || cgv.status !== "CGV_READY"} onClick={activate} className="rounded-xl bg-[#25D366] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                      {t("legalCgvActivate")}
                    </button>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
