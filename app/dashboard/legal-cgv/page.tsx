"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { getMerchantRestaurants } from "@/lib/services/dashboard";
import type { MerchantRestaurant, MerchantLegalProfile, MerchantCgvProfile } from "@/lib/dashboard-types";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { useRestaurantContextGuard } from "@/lib/restaurant-context-guard";
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
import CommercialTermsField, { isCustomCommercialTerms } from "@/components/dashboard/CommercialTermsField";

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
  /**
   * CONTEXT HARDENING v1.1 (§5) -- PROVENANCE explicite des données
   * légales/CGV en mémoire. `null` = rien de fiable pour le contexte
   * courant : aucune donnée dérivée du locataire n'est rendue.
   */
  const [legalLoadedRestaurantId, setLegalLoadedRestaurantId] = useState<string | null>(null);
  /** CONTEXT HARDENING v1.1 -- contrat anti-réponse-périmée partagé. */
  const guard = useRestaurantContextGuard();
  /** CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble. */
  const [unavailableContextId, setUnavailableContextId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // STANDARD COMMERCIAL TERMS UX v1 -- état PUREMENT d'interface :
  // quelles sections ont leur éditeur ouvert, et laquelle demande une
  // confirmation de rétablissement. Rien de tout cela n'est persisté :
  // la seule source de vérité reste le texte marchand lui-même.
  const [editingTerms, setEditingTerms] = useState<{ cancellation: boolean; substitution: boolean }>({
    cancellation: false,
    substitution: false,
  });
  const [confirmRestore, setConfirmRestore] = useState<"cancellation" | "substitution" | null>(null);

  const t = (k: string, p?: Record<string, string | number>) => translate(uiLang, k, p);
  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  const canEdit = isOperator || mapping?.role === "owner" || mapping?.role === "manager";

  const load = useCallback(async (id: string) => {
    if (!id) return;
    // CONTEXT HARDENING v1.1 -- ferme CTXHARD-V1-STALE-RESPONSE-01 sur
    // ce module de configuration. Le jeton devra prouver, au retour,
    // qu'il appartient toujours au restaurant actif ET à la génération
    // courante ; sinon la réponse est ABANDONNÉE.
    const token = guard.beginRequest(id);
    // §5 -- invalidation IMMÉDIATE de la provenance : les informations
    // légales précédentes cessent d'être affichables à l'instant même
    // du changement, sans attendre aucune réponse réseau.
    setLegalLoadedRestaurantId(null);
    setPageError(null);
    try {
      const [legalRow, cgvRow, templateRow] = await Promise.all([
        getMerchantLegalProfile(id),
        getMerchantCgvProfile(id),
        supabase.rpc("get_applicable_cgv_template", { p_restaurant_id: id }),
      ]);
      if (!token.isCurrent()) return;
      const tpl = templateRow.data as { id: string; controlled_sections: CgvTemplateControlledSections } | null;
      // Commit ATOMIQUE : valeurs et provenance posées dans la même
      // passe de rendu -- elles ne peuvent jamais se contredire.
      setLegal(legalRow ?? {});
      setCgv(cgvRow);
      setTemplate(tpl?.id ? { id: tpl.id, ...tpl.controlled_sections } : null);
      // STANDARD COMMERCIAL TERMS UX v1 -- rechargement (y compris
      // changement d'établissement en contexte opérateur) : on repart
      // d'un état d'interface neutre, sinon un éditeur ouvert ou une
      // confirmation en attente survivrait d'un établissement à
      // l'autre. Placé à l'intérieur du même commit atomique que les
      // données et leur provenance (§5) : gardé par le même `token`.
      setEditingTerms({ cancellation: false, substitution: false });
      setConfirmRestore(null);
      setLegalLoadedRestaurantId(id);
    } catch {
      if (!token.isCurrent()) return;
      setPageError(t("legalCgvLoadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard]);

  /**
   * CONTEXT HARDENING v1.1 (§5) -- bascule pilotée par l'utilisateur :
   * invalidation et changement de contexte dans le MÊME gestionnaire,
   * donc regroupés par React en un seul rendu.
   */
  const handleSelectRestaurant = useCallback(
    (id: string) => {
      guard.enterContext(id);
      setLegal({});
      setCgv(null);
      setTemplate(null);
      setSellerName("");
      setLegalLoadedRestaurantId(null);
      // STANDARD COMMERCIAL TERMS UX v1 -- même raison que dans load() :
      // un éditeur ouvert ou une confirmation en attente pour
      // l'établissement précédent ne doit pas survivre à la bascule.
      setEditingTerms({ cancellation: false, substitution: false });
      setConfirmRestore(null);
      setRestaurantId(id);
    },
    [guard]
  );

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
        // CONTEXT HARDENING v1 -- résolution UNIQUE et partagée. Plus
        // aucun `match ?? next[0]` : un `?r=` explicite non résoluble
        // ne bascule plus silencieusement sur un autre établissement.
        const resolution = resolveRestaurantContext({
          requestedId: wanted,
          mappings: next,
          isOperator: opFlag,
        });

        if (resolution.kind === "unavailable") {
          setUnavailableContextId(resolution.requestedId);
        } else if (resolution.kind === "none") {
          setPageError(t("legalCgvNoRestaurant"));
        } else {
          setUnavailableContextId(null);
          guard.enterContext(resolution.restaurantId);
          setRestaurantId(resolution.restaurantId);
          if (resolution.source === "operator") {
            try {
              const summary = await getEstablishmentSummary(resolution.restaurantId);
              setOperatorRestaurantName(summary.name);
              setSellerName(summary.name);
            } catch {
              // best-effort
            }
          } else {
            const chosen = next.find((m) => m.restaurant_id === resolution.restaurantId);
            setSellerName(chosen?.restaurants?.name ?? "");
          }
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
        legalEntityName: legal.legal_entity_name ?? null,
        siren: legal.siren ?? null,
        siret: legal.siret ?? null,
        vatNumber: legal.vat_number ?? null,
        consumerMediatorPhone: legal.consumer_mediator_phone ?? null,
        consumerMediatorEmail: legal.consumer_mediator_email ?? null,
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
        coldChainApplicable: cgv.cold_chain_applicable ?? false,
        weightPricingMode: cgv.weight_pricing_mode ?? null,
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
          legalEntityName: legal.legal_entity_name ?? null,
          siren: legal.siren ?? null,
          siret: legal.siret ?? null,
          vatNumber: legal.vat_number ?? null,
          mediatorPhone: legal.consumer_mediator_phone ?? null,
          mediatorEmail: legal.consumer_mediator_email ?? null,
        },
        business: {
          withdrawalRegime: cgv.withdrawal_regime,
          preparationTimeMin: cgv.preparation_time_min,
          preparationTimeMax: cgv.preparation_time_max,
          preparationTimeUnit: cgv.preparation_time_unit,
          cancellationPolicyText: cgv.cancellation_policy_text,
          substitutionPolicyText: cgv.substitution_policy_text,
          coldChainApplicable: cgv.cold_chain_applicable ?? false,
          weightPricingMode: cgv.weight_pricing_mode ?? null,
        },
        locale: "fr",
        presentationVariant: cgv.presentation_variant,
      });
    } catch {
      // Couvre à la fois le régime de rétractation non résolu (MIXED)
      // ET, depuis v2.1, ActualWeightPriceUnsupportedError
      // (weight_pricing_mode = ACTUAL_WEIGHT_PRICE) -- l'aperçu
      // affiche simplement "profil incomplet" (voir section 6 du
      // rendu), jamais une erreur brute ; la publication réelle échoue
      // fermé indépendamment côté serveur (persist_merchant_cgv_
      // version).
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

  // CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble :
  // état dédié, aucun établissement sélectionné, aucune donnée chargée.
  if (unavailableContextId) {
    return (
      <div className="p-6">
        <div
          role="alert"
          data-context-unavailable={unavailableContextId}
          className="mx-auto max-w-2xl rounded-2xl bg-white p-6 text-sm font-semibold text-red-700 shadow-sm"
        >
          {translate(uiLang, "dsContextUnavailable")}
        </div>
      </div>
    );
  }

  const restaurantName =
    mappings.find((m) => m.restaurant_id === restaurantId)?.restaurants?.name ?? operatorRestaurantName ?? "";

  const preview = buildPreview();

  return (
    <div className="min-h-screen bg-stone-50 pb-16">
      <DashboardNav
        restaurantName={restaurantName}
        restaurantId={restaurantId}
        mappings={mappings}
        onSelectRestaurant={handleSelectRestaurant}
        staffLanguage={uiLang}
      />
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <h1 className="text-xl font-bold text-stone-900">{t("legalCgvTitle")}</h1>
        {pageError && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{pageError}</p>}
        {actionMessage && <p className="rounded-xl bg-stone-100 p-3 text-sm text-stone-700">{actionMessage}</p>}
        {!canEdit && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{t("legalCgvReadOnly")}</p>}

        {/* CONTEXT HARDENING v1.1 (§5) -- PORTE DE PROVENANCE. Rien de
            dérivé du locataire n'est rendu tant que les données en
            mémoire n'ont pas été chargées pour l'établissement
            ACTUELLEMENT affiché. Sans cette porte, un rendu
            intermédiaire pourrait montrer les informations légales de
            l'établissement précédent sous l'entête du nouveau -- c'est
            exactement ce que le mandat interdit. */}
        {legalLoadedRestaurantId !== restaurantId ? (
          <p data-context-loading="1" className="rounded-xl bg-stone-100 p-3 text-sm text-stone-500">
            {t("mcLoading")}
          </p>
        ) : (
          <>
        <section className="rounded-2xl border border-stone-200 bg-white p-4">
          <h2 className="mb-1 font-bold text-stone-900">1. {t("legalCgvSectionIdentity")}</h2>
          <p className="text-sm text-stone-500">{sellerName}</p>
        </section>

        <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
          <h2 className="font-bold text-stone-900">2. {t("legalCgvSectionMandatory")}</h2>
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvLegalEntityName")}
            value={legal.legal_entity_name ?? ""} onChange={(e) => setLegal((p) => ({ ...p, legal_entity_name: e.target.value }))} />
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
          <div className="flex gap-2">
            <input disabled={!canEdit} className="w-1/2 rounded-lg border p-2 text-sm" placeholder={t("legalCgvSiren")}
              value={legal.siren ?? ""} onChange={(e) => setLegal((p) => ({ ...p, siren: e.target.value }))} />
            <input disabled={!canEdit} className="w-1/2 rounded-lg border p-2 text-sm" placeholder={t("legalCgvSiret")}
              value={legal.siret ?? ""} onChange={(e) => setLegal((p) => ({ ...p, siret: e.target.value }))} />
          </div>
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvVatNumber")}
            value={legal.vat_number ?? ""} onChange={(e) => setLegal((p) => ({ ...p, vat_number: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvCustomerServiceEmail")}
            value={legal.customer_service_email ?? ""} onChange={(e) => setLegal((p) => ({ ...p, customer_service_email: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorName")}
            value={legal.consumer_mediator_name ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_name: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorAddress")}
            value={legal.consumer_mediator_address ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_address: e.target.value }))} />
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorWebsite")}
            value={legal.consumer_mediator_website ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_website: e.target.value }))} />
          <div className="flex gap-2">
            <input disabled={!canEdit} className="w-1/2 rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorPhone")}
              value={legal.consumer_mediator_phone ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_phone: e.target.value }))} />
            <input disabled={!canEdit} className="w-1/2 rounded-lg border p-2 text-sm" placeholder={t("legalCgvMediatorEmail")}
              value={legal.consumer_mediator_email ?? ""} onChange={(e) => setLegal((p) => ({ ...p, consumer_mediator_email: e.target.value }))} />
          </div>
          <input disabled={!canEdit} className="w-full rounded-lg border p-2 text-sm" placeholder="FR"
            value={legal.governing_country ?? ""} onChange={(e) => setLegal((p) => ({ ...p, governing_country: e.target.value.toUpperCase() }))} />
          {canEdit && <button disabled={saving} onClick={saveLegal} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white">{t("legalCgvSave")}</button>}
        </section>

        {cgv && (
          <>
            <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">3. {t("legalCgvSectionBusiness")}</h2>
              <CommercialTermsField
                sectionKey="cancellation"
                label={t("legalCgvCancellationPolicy")}
                standardText={template?.cancellation_clause_fallback}
                value={cgv.cancellation_policy_text}
                onChange={(next) => setCgv({ ...cgv, cancellation_policy_text: next })}
                canEdit={canEdit}
                editing={editingTerms.cancellation}
                onEditingChange={(open) => setEditingTerms((p) => ({ ...p, cancellation: open }))}
                confirmingRestore={confirmRestore === "cancellation"}
                onRequestRestore={() => setConfirmRestore("cancellation")}
                onCancelRestore={() => setConfirmRestore(null)}
                t={t}
              />
              <CommercialTermsField
                sectionKey="substitution"
                label={t("legalCgvSubstitutionPolicy")}
                standardText={template?.substitution_clause_fallback}
                value={cgv.substitution_policy_text}
                onChange={(next) => setCgv({ ...cgv, substitution_policy_text: next })}
                canEdit={canEdit}
                editing={editingTerms.substitution}
                onEditingChange={(open) => setEditingTerms((p) => ({ ...p, substitution: open }))}
                confirmingRestore={confirmRestore === "substitution"}
                onRequestRestore={() => setConfirmRestore("substitution")}
                onCancelRestore={() => setConfirmRestore(null)}
                t={t}
              />
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
              <h2 className="font-bold text-stone-900">{t("legalCgvSectionColdChainPricing")}</h2>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={cgv.cold_chain_applicable ?? false}
                  onChange={(e) => setCgv({ ...cgv, cold_chain_applicable: e.target.checked })}
                />
                {t("legalCgvColdChainApplicable")}
              </label>
              <div>
                <label className="mb-1 block text-xs text-stone-500">{t("legalCgvWeightPricingMode")}</label>
                <select
                  disabled={!canEdit}
                  className="w-full rounded-lg border p-2 text-sm"
                  value={cgv.weight_pricing_mode ?? ""}
                  onChange={(e) =>
                    setCgv({ ...cgv, weight_pricing_mode: (e.target.value || null) as typeof cgv.weight_pricing_mode })
                  }
                >
                  <option value="">{t("legalCgvWeightPricingModeNone")}</option>
                  <option value="FIXED_PORTION_PRICE">{t("legalCgvWeightPricingModeFixedPortion")}</option>
                  <option value="ACTUAL_WEIGHT_PRICE">{t("legalCgvWeightPricingModeActualWeight")}</option>
                </select>
              </div>
              {canEdit && <button disabled={saving} onClick={saveCgvProfile} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white">{t("legalCgvSave")}</button>}
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
              {/*
               * v2.4 -- advisory-only warning banner. Derived LOCALLY
               * from cgv.withdrawal_regime (already loaded), IDENTICAL
               * to the `online_withdrawal_function_gap` boolean the
               * SQL RPC resolve_cgv_publication_context now also
               * returns (see DRAFT-lot-seller-legal-profile-cgv-
               * engine-v2-4.sql) -- computing it here avoids adding a
               * new client-side RPC call to this page (a larger
               * change than this legal-content remediation lot
               * warrants). Purely informational: never disables Save/
               * Publish/Activate below.
               */}
              {cgv.withdrawal_regime === "STANDARD_14_DAYS" && (
                <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{t("legalCgvOnlineWithdrawalFunctionGap")}</p>
              )}
              {canEdit && <button disabled={saving} onClick={saveCgvProfile} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white">{t("legalCgvSave")}</button>}
            </section>

            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">6. {t("legalCgvSectionPreview")}</h2>
              {/*
                STANDARD COMMERCIAL TERMS UX v1 -- état standard/personnalisé
                affiché À CÔTÉ de l'aperçu, jamais INJECTÉ DEDANS : le contenu
                juridique rendu par renderCgv() reste strictement inchangé par
                ce lot (c'est lui qui sera publié). Cet encadré est du chrome
                d'interface, pas du contenu de CGV.
              */}
              <div
                data-testid="commercial-terms-status"
                className="rounded-xl bg-stone-50 p-3 text-sm text-stone-700"
              >
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                  {t("legalCgvTermsStatusTitle")}
                </p>
                <p data-testid="commercial-terms-status-cancellation">
                  {t("legalCgvCancellationPolicy")} —{" "}
                  <span className="font-semibold">
                    {isCustomCommercialTerms(cgv.cancellation_policy_text)
                      ? t("legalCgvTermsCustomBadge")
                      : t("legalCgvTermsStandardBadge")}
                  </span>
                </p>
                <p data-testid="commercial-terms-status-substitution">
                  {t("legalCgvSubstitutionPolicy")} —{" "}
                  <span className="font-semibold">
                    {isCustomCommercialTerms(cgv.substitution_policy_text)
                      ? t("legalCgvTermsCustomBadge")
                      : t("legalCgvTermsStandardBadge")}
                  </span>
                </p>
              </div>
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
          </>
        )}
      </div>
    </div>
  );
}
