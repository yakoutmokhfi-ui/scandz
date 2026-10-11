"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  ActivateCgvError,
} from "@/lib/services/legal-cgv";
import { supabase } from "@/lib/supabase";
import {
  renderCgv,
  type CgvTemplateControlledSections,
  MixedRegimeClauseMissingError,
  ActualWeightPriceUnsupportedError,
} from "@/lib/legal/render";
import CommercialTermsField, { isCustomCommercialTerms } from "@/components/dashboard/CommercialTermsField";
import { parseCgvDocumentModel } from "@/lib/legal/cgv-document-model";
import { buildCgvDocx } from "@/lib/docx/docx-writer";
import { readDocxDocument, DocxReadError } from "@/lib/docx/docx-reader";
import { diffCgvDocxImport, CgvDocxDiffError, type CgvDocxDiffResult } from "@/lib/legal/cgv-docx-diff";

/**
 * CGV W1 — DOCX EXPORT / IMPORT ROUND-TRIP.
 *
 * Entirely CLIENT-SIDE, deliberately: this page ALREADY builds a
 * `RenderCgvInput` and calls `renderCgv()` directly in the browser
 * for the advisory preview (section 6, `buildPreviewResult()` above),
 * from browser-accessible sources only (`getMerchantLegalProfile`,
 * `getMerchantCgvProfile`, the read-only RPC
 * `get_applicable_cgv_template`) — never the service-role-gated
 * `resolve_cgv_publication_context` used only at actual publish time
 * (lib/server/legal-cgv-publish-service.ts). W1 reuses EXACTLY that
 * same already-rendered HTML (`previewResult.html`) as its one and
 * only content source: no new API route, no new SQL, no new
 * persistence. This trivially satisfies several of the mandate's
 * hardest constraints at once — "NOT automatic publication" (nothing
 * here calls publishMerchantCgvVersion/activateMerchantCgv), "never
 * mutate an existing published legal document" (nothing here reads or
 * writes a published version row), and "avoid schema changes" (SQL
 * REQUIRED: NO). The mandate's "merchant isolation if persisted data
 * involved" test is consequently N/A: nothing produced by this
 * feature is ever persisted anywhere.
 */


/**
 * CGV W2 — PUBLICATION BOUNDARY FIXES (Noether, scanym-orchestrator#23).
 * Raison distincte d'échec d'aperçu/publication — W2-3 exige de
 * distinguer MixedRegimeClauseMissingError et
 * ActualWeightPriceUnsupportedError (toutes deux levées par
 * renderCgv()/lib/legal/render.ts, jamais modifié par ce lot) du
 * simple "profil incomplet" (champs obligatoires absents, vérifiés
 * AVANT même d'appeler renderCgv()).
 *
 * REMÉDIATION B1 (Chateaubriand, audit candidat d6ad249) — `no_template`
 * est désormais SA PROPRE raison, distincte de `incomplete_fields` :
 * "aucun modèle résolu pour ce pays" n'est PAS "le profil CGV du
 * marchand est incomplet" -- deux causes, deux explications, jamais la
 * même étiquette générique. Contrat utilisateur attendu après
 * remédiation : erreur de transport du modèle -> pageError dédiée
 * (W2-1, legalCgvTemplateLoadFailed) ; template === null -> CETTE
 * raison (legalCgvNoTemplate) ; profil incomplet -> incomplete_fields
 * (legalCgvIncomplete) ; erreurs de rendu structurelles -> leurs
 * propres raisons (ci-dessous).
 */
type PreviewFailureReason =
  | "no_template"
  | "incomplete_fields"
  | "mixed_regime_clause_missing"
  | "actual_weight_price_unsupported"
  | "render_error";

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
  /**
   * CGV W2 (W2-4) -- GÉNÉRATION DE CONTEXTE dédiée aux MUTATIONS
   * (saveLegal/saveCgvProfile/publish/activate), transposée telle
   * quelle depuis app/dashboard/delivery-pricing/page.tsx
   * (contextGenerationRef/enterDashboardContext) -- RÉFÉRENCE LECTURE
   * SEULE, jamais modifiée par ce lot. Volontairement DISTINCTE de la
   * séquence de `guard.beginRequest()` (partagée avec les
   * CHARGEMENTS, via `load()`) : réutiliser cette séquence pour une
   * sauvegarde invaliderait à tort un chargement légitime encore en
   * vol, et inversement -- voir le commentaire original dans
   * delivery-pricing/page.tsx pour le raisonnement complet.
   */
  const contextGenerationRef = useRef(0);
  const enterLegalCgvContext = useCallback(
    (id: string) => {
      contextGenerationRef.current += 1;
      // W2-4 -- une sauvegarde/publication/activation restée en vol
      // pour le contexte précédent ne doit jamais laisser le nouveau
      // contexte bloqué (bouton désactivé indéfiniment) : la bascule
      // elle-même lève le verrou, exactement comme
      // enterDashboardContext réinitialise `creating`/`structureBusy`.
      setSaving(false);
      guard.enterContext(id);
    },
    [guard]
  );
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

  // CGV W1 -- DOCX EXPORT / IMPORT ROUND-TRIP. Purely client-side,
  // purely in-memory review state -- nothing here is ever persisted
  // (see the file-header comment above this component for why). A
  // fresh import attempt always replaces the previous result/error in
  // one go, so the panel never shows a stale diff next to a new error
  // or vice versa.
  const [docxImportBusy, setDocxImportBusy] = useState(false);
  const [docxImportErrorMessage, setDocxImportErrorMessage] = useState<string | null>(null);
  const [docxDiffResult, setDocxDiffResult] = useState<CgvDocxDiffResult | null>(null);
  /**
   * W1 REMEDIATION (W1-04) -- RESTAURANT CONTEXT ISOLATION.
   * `docxDiffResult` on its own carries no restaurant identity, so a
   * stray render between a context switch and that switch's own
   * cleanup (or a future refactor that forgets to clear
   * `docxDiffResult` on switch) could otherwise show one
   * restaurant's review under another's header. This is a SECOND,
   * render-time line of defense on top of the guard checkpoints in
   * `importCgvDocxFile` and the explicit reset in
   * `handleSelectRestaurant` below -- the diff is only ever rendered
   * when `docxReviewRestaurantId === restaurantId` (see the JSX). */
  const [docxReviewRestaurantId, setDocxReviewRestaurantId] = useState<string | null>(null);
  const docxFileInputRef = useRef<HTMLInputElement | null>(null);

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

      // W2-7 -- getMerchantCgvProfile() déclare renvoyer
      // `Promise<MerchantCgvProfile>` (jamais undefined), mais son
      // implémentation (lib/services/legal-cgv.ts) transtype
      // silencieusement une ligne RPC absente (`data[0]` sur un
      // tableau vide) en `MerchantCgvProfile` -- le type ment. Avant
      // ce lot, `setCgv(cgvRow)` propageait ce `undefined` sans
      // contrôle : les sections 3 à 7 (gardées sur `cgv &&`) se
      // contentaient alors de disparaître silencieusement, sans la
      // moindre explication pour le marchand (W2-T-08). On traite
      // maintenant ce cas explicitement, jamais un transtype silencieux.
      if (!cgvRow) {
        setLegal(legalRow ?? {});
        setCgv(null);
        setTemplate(null);
        setEditingTerms({ cancellation: false, substitution: false });
        setConfirmRestore(null);
        setLegalLoadedRestaurantId(id);
        setPageError(t("legalCgvProfileMissing"));
        return;
      }

      // W2-1 -- `templateRow.error` n'était jusqu'ici jamais inspecté :
      // un échec de la RPC get_applicable_cgv_template se comportait
      // alors EXACTEMENT comme "aucun modèle résolu pour ce pays"
      // (tpl reste null) -- un échec de transport et une absence de
      // modèle normale sont pourtant deux situations distinctes. Cette
      // dernière reste un état normal, actionnable (W2-2 ci-dessous :
      // bouton Publier désactivé, message explicite) ; la première est
      // une panne de chargement, qui mérite son propre pageError,
      // distinct de legalCgvLoadFailed (échec du Promise.all lui-même)
      // ET de legalCgvNoTemplate (clic sur Publier sans modèle résolu).
      const tpl = !templateRow.error
        ? (templateRow.data as { id: string; controlled_sections: CgvTemplateControlledSections } | null)
        : null;

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
      if (templateRow.error) {
        setPageError(t("legalCgvTemplateLoadFailed"));
      }
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
      enterLegalCgvContext(id);
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
      // W1 REMEDIATION (W1-04) -- RESTAURANT CONTEXT ISOLATION. A DOCX
      // review/import in flight for the PREVIOUS restaurant must never
      // survive the switch, or later commit, under the new one:
      // cleared in the SAME handler as the context switch itself
      // (grouped into one React render, exactly like
      // `enterLegalCgvContext`'s own `setSaving(false)` already does
      // for mutations) -- "when restaurant changes: clear current
      // DOCX review, clear imported file state, invalidate any
      // in-flight import generation" (mandate). The generation
      // invalidation itself is `enterLegalCgvContext` bumping
      // `contextGenerationRef` above; `importCgvDocxFile`'s own guard
      // checkpoints are what make an ALREADY in-flight import's
      // eventual completion unable to commit anything here, even
      // without this reset -- this reset's job is only to make the
      // CURRENTLY DISPLAYED state disappear immediately, synchronously,
      // never waiting for that in-flight promise to resolve.
      setDocxImportBusy(false);
      setDocxImportErrorMessage(null);
      setDocxDiffResult(null);
      setDocxReviewRestaurantId(null);
      if (docxFileInputRef.current) docxFileInputRef.current.value = "";
      setRestaurantId(id);
    },
    [enterLegalCgvContext]
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
          enterLegalCgvContext(resolution.restaurantId);
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

  /**
   * CGV W2 (W2-4) -- transposé TEL QUEL depuis le patron de
   * save()/saveModeNotice() d'app/dashboard/delivery-pricing/page.tsx
   * (référence lecture seule, jamais modifiée par ce lot) : une
   * mutation CGV est identifiée par le restaurant ET la génération de
   * contexte AU MOMENT DU LANCEMENT. Trois points de garde -- avant
   * toute relecture, après la relecture, et sur le chemin d'échec --
   * jamais une continuation issue d'un contexte quitté entre-temps.
   * `enterLegalCgvContext` (bascule d'établissement) lève déjà le
   * verrou `saving` pour le nouveau contexte : une continuation
   * périmée ici n'a donc PAS besoin de le refaire elle-même -- un
   * `setSaving(false)` dans une continuation périmée écraserait à tort
   * l'état `saving` du NOUVEAU contexte si celui-ci avait, entre
   * temps, lancé sa propre mutation.
   */
  function beginLegalCgvOperation(): { targetRestaurantId: string; isOperationCurrent: () => boolean } {
    const targetRestaurantId = restaurantId;
    const operationGeneration = contextGenerationRef.current;
    return {
      targetRestaurantId,
      isOperationCurrent: () =>
        guard.currentRestaurantId() === targetRestaurantId && contextGenerationRef.current === operationGeneration,
    };
  }

  async function saveLegal() {
    const { targetRestaurantId, isOperationCurrent } = beginLegalCgvOperation();
    setSaving(true);
    setActionMessage(null);
    try {
      await updateMerchantLegalProfile({
        restaurantId: targetRestaurantId,
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
      // Garde 1 -- après la mutation, AVANT toute relecture.
      if (!isOperationCurrent()) return;
      await load(targetRestaurantId);
      // Garde 2 -- après la relecture, AVANT d'afficher « Enregistré ».
      if (!isOperationCurrent()) return;
      setActionMessage(t("legalCgvSaved"));
      setSaving(false);
    } catch {
      // Garde 3 -- chemin d'échec, AVANT d'afficher l'erreur. W2-5 :
      // jamais e.message brut (code SQL/détail interne) -- message
      // stable et traduit uniquement.
      if (!isOperationCurrent()) return;
      setActionMessage(t("legalCgvSaveFailed"));
      setSaving(false);
    }
  }

  async function saveCgvProfile() {
    if (!cgv) return;
    const { targetRestaurantId, isOperationCurrent } = beginLegalCgvOperation();
    setSaving(true);
    setActionMessage(null);
    try {
      await updateMerchantCgvProfile({
        restaurantId: targetRestaurantId,
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
      // Garde 1 -- après la mutation, AVANT toute relecture.
      if (!isOperationCurrent()) return;
      await load(targetRestaurantId);
      // Garde 2 -- après la relecture, AVANT d'afficher « Enregistré ».
      if (!isOperationCurrent()) return;
      setActionMessage(t("legalCgvSaved"));
      setSaving(false);
    } catch {
      // Garde 3 -- chemin d'échec. W2-5 : jamais e.message brut.
      if (!isOperationCurrent()) return;
      setActionMessage(t("legalCgvSaveFailed"));
      setSaving(false);
    }
  }

  /**
   * CGV W2 (W2-3) -- remplace l'ancien `buildPreview(): string | null`,
   * qui réduisait TOUTE cause d'échec (champs manquants,
   * MixedRegimeClauseMissingError, ActualWeightPriceUnsupportedError)
   * au même `null` indifférencié. `renderCgv()` elle-même
   * (lib/legal/render.ts) n'est JAMAIS modifiée par ce lot -- seule la
   * classification de ce qu'elle lève, ici, change.
   */
  function buildPreviewResult(): { html: string; reason: null } | { html: null; reason: PreviewFailureReason } {
    // REMÉDIATION B1 -- `!template` est désormais vérifiée EN PREMIER et
    // séparément : "aucun modèle résolu pour ce pays" n'est jamais
    // confondue avec "le profil CGV du marchand est incomplet" (les deux
    // étaient jusqu'ici fusionnées dans la même branche `incomplete_fields`
    // ci-dessous, donc le même message générique `legalCgvIncomplete`).
    if (!template) {
      return { html: null, reason: "no_template" };
    }
    if (!cgv || !cgv.withdrawal_regime || cgv.preparation_time_min == null || cgv.preparation_time_max == null || !cgv.preparation_time_unit) {
      return { html: null, reason: "incomplete_fields" };
    }
    try {
      const html = renderCgv({
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
      return { html, reason: null };
    } catch (e) {
      // W2-3 -- MixedRegimeClauseMissingError (régime MIXED sans
      // clause de commandes mixtes dans le modèle) et
      // ActualWeightPriceUnsupportedError (weight_pricing_mode =
      // ACTUAL_WEIGHT_PRICE, non pris en charge) sont désormais
      // distinguées du simple "profil incomplet" -- jamais le même
      // message indifférencié. La publication réelle échoue fermé
      // indépendamment côté serveur (persist_merchant_cgv_version) :
      // ce garde local reste un confort UX, jamais l'autorité.
      if (e instanceof MixedRegimeClauseMissingError) return { html: null, reason: "mixed_regime_clause_missing" };
      if (e instanceof ActualWeightPriceUnsupportedError) {
        return { html: null, reason: "actual_weight_price_unsupported" };
      }
      return { html: null, reason: "render_error" };
    }
  }

  /** Conservé pour l'aperçu à l'écran (section 6) -- ne porte que le
   *  HTML rendu, jamais la raison d'échec (voir buildPreviewResult). */
  function buildPreview(): string | null {
    return buildPreviewResult().html;
  }

  function previewFailureMessage(reason: PreviewFailureReason): string {
    switch (reason) {
      // REMÉDIATION B1 -- sa propre explication, jamais le générique
      // "profil incomplet" (legalCgvIncomplete) ci-dessous.
      case "no_template":
        return t("legalCgvNoTemplate");
      case "mixed_regime_clause_missing":
        return t("legalCgvMixedRegimeClauseMissing");
      case "actual_weight_price_unsupported":
        return t("legalCgvActualWeightPriceUnsupported");
      case "incomplete_fields":
      case "render_error":
      default:
        return t("legalCgvIncomplete");
    }
  }

  /**
   * CGV W1 -- builds a .docx from the CURRENTLY PREVIEWED CGV
   * (`previewResult.html`, the same already-rendered content section
   * 6 displays) and triggers a browser download. Disabled from the
   * JSX whenever `previewResult.reason !== null` (nothing coherent to
   * export). Purely client-side: `Blob` + a transient object URL,
   * revoked immediately after the synthetic click -- no network call,
   * no Storage upload, no server involvement whatsoever.
   */
  function exportCgvDocx(html: string) {
    const model = parseCgvDocumentModel(html);
    const bytes = buildCgvDocx(model);
    // Même conversion que app/dashboard/translations/page.tsx
    // (downloadXlsx) -- un `Uint8Array<ArrayBufferLike>` n'est pas
    // directement assignable à `BlobPart` sous ce lib/TS ; `.slice()`
    // produit un `ArrayBuffer` concret, sans copie de données utile
    // au-delà de la vue déjà matérialisée par `buildCgvDocx`.
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cgv-${restaurantId || "export"}.docx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * CGV W1 -- reads a merchant-edited .docx chosen via the file input
   * below, entirely in the browser (`File.arrayBuffer()`), and builds
   * the structured review diff against the CURRENT CGV content. Every
   * failure mode of `readDocxDocument`/`diffCgvDocxImport` (malformed
   * file, foreign/unsupported format, unsafe ZIP shape, unrecognized
   * or duplicated bookmark) ends up here as a plain, translated
   * message -- NEVER a raw `e.message` (same discipline as
   * `saveCgvProfile`'s W2-5 comment above). No publication side
   * effect: this function never calls publishMerchantCgvVersion /
   * activateMerchantCgv, and never writes anywhere.
   *
   * W1 REMEDIATION (W1-04) -- RESTAURANT CONTEXT ISOLATION. Bound to
   * the restaurant AND context generation active the moment the
   * import was launched, via `beginLegalCgvOperation()` -- REUSING
   * the EXISTING stale-response protection pattern already used by
   * saveLegal/saveCgvProfile/publish/activate above (mandate: "Reuse
   * the existing stale-response protection pattern already present in
   * the Legal CGV page if possible"), never `guard.beginRequest()`,
   * which is reserved for `load()`'s data RELOADS -- see that
   * function's own W2-4 comment for why the two sequences must stay
   * independent (reusing it here for a mutation-shaped operation like
   * this one would risk a data reload wrongly invalidating an import,
   * or vice versa). Checked AFTER every `await`, before any
   * `setState`, exactly like the three mutations above: an import
   * started for restaurant A that only resolves after the user has
   * switched to B must never flip `docxImportBusy` back to false, let
   * alone commit A's review, under B's context. No new global state
   * is introduced -- `targetRestaurantId`/`isOperationCurrent` are
   * local to this one call, exactly as `beginLegalCgvOperation()`
   * already works for the other three mutations.
   */
  async function importCgvDocxFile(file: File) {
    const { targetRestaurantId, isOperationCurrent } = beginLegalCgvOperation();
    setDocxImportBusy(true);
    setDocxImportErrorMessage(null);
    setDocxDiffResult(null);
    setDocxReviewRestaurantId(null);
    try {
      const previewForDiff = buildPreviewResult();
      if (previewForDiff.reason !== null) {
        if (!isOperationCurrent()) return;
        setDocxImportErrorMessage(previewFailureMessage(previewForDiff.reason));
        return;
      }
      const buffer = await file.arrayBuffer();
      // Garde 1 -- après la lecture du fichier (I/O asynchrone), AVANT
      // toute analyse structurelle du contenu.
      if (!isOperationCurrent()) return;
      const imported = readDocxDocument(buffer);
      const currentModel = parseCgvDocumentModel(previewForDiff.html);
      const diff = diffCgvDocxImport(currentModel, imported);
      // Garde 2 -- après le pipeline complet lecture+diff, AVANT tout
      // affichage du résultat.
      if (!isOperationCurrent()) return;
      setDocxDiffResult(diff);
      setDocxReviewRestaurantId(targetRestaurantId);
    } catch (e) {
      // Garde 3 -- chemin d'échec. DocxReadError (fichier malformé /
      // format étranger / ZIP non sûr / repère invalide) et
      // CgvDocxDiffError (repère non reconnu ou dupliqué) sont toutes
      // deux des échecs FERMÉS attendus -- jamais une exception brute
      // affichée au marchand (et jamais affichée du tout si le
      // contexte a changé entre-temps).
      if (!isOperationCurrent()) return;
      if (e instanceof DocxReadError || e instanceof CgvDocxDiffError) {
        setDocxImportErrorMessage(`${t("legalCgvDocxImportFailed")} (${e.code})`);
      } else {
        setDocxImportErrorMessage(t("legalCgvDocxImportFailed"));
      }
    } finally {
      // Garde 4 -- ne JAMAIS désarmer `docxImportBusy` ni vider le
      // champ de fichier pour un contexte qui n'est plus courant : cela
      // écraserait à tort l'état du NOUVEAU contexte (déjà remis à
      // zéro, le cas échéant, par `handleSelectRestaurant` lui-même au
      // moment de la bascule).
      if (isOperationCurrent()) {
        setDocxImportBusy(false);
        if (docxFileInputRef.current) docxFileInputRef.current.value = "";
      }
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
   *
   * CGV W2 (W2-2) -- `!template` ne renvoie plus JAMAIS silencieusement
   * (le bouton lui-même est désormais aussi désactivé dans ce cas,
   * voir la section 7 du rendu) : un clic malgré tout -- un double-clic
   * pendant la désactivation, par exemple -- affiche un message
   * explicite. W2-3 -- l'échec d'aperçu affiche désormais la raison
   * précise (buildPreviewResult) plutôt que le seul "profil incomplet".
   */
  async function publish() {
    if (!template) {
      setActionMessage(t("legalCgvNoTemplate"));
      return;
    }
    const previewResult = buildPreviewResult();
    if (previewResult.reason !== null) {
      setActionMessage(previewFailureMessage(previewResult.reason));
      return;
    }
    const { targetRestaurantId, isOperationCurrent } = beginLegalCgvOperation();
    setSaving(true);
    setActionMessage(null);
    try {
      await publishMerchantCgvVersion({ restaurantId: targetRestaurantId });
      // Garde 1 -- après la mutation, AVANT toute relecture.
      if (!isOperationCurrent()) return;
      await load(targetRestaurantId);
      // Garde 2 -- après la relecture, AVANT d'afficher le succès.
      if (!isOperationCurrent()) return;
      setActionMessage(t("legalCgvPublished"));
      setSaving(false);
    } catch (e) {
      // Garde 3 -- chemin d'échec.
      if (!isOperationCurrent()) return;
      // v1.2 (CGV-V11-PUBLISH-CONTEXT-RACE-01) -- a stale-context
      // rejection is retriable (the profile changed server-side
      // between resolve and persist): tell the merchant to retry
      // rather than showing the generic failure message, which reads
      // as a permanent error. W2-5 : jamais e.message brut.
      setActionMessage(
        e instanceof PublishCgvError && e.reason === "stale_context"
          ? t("legalCgvPublishStale")
          : t("legalCgvPublishFailed")
      );
      setSaving(false);
    }
  }

  /**
   * CGV W2 (W2-4/W2-5/W2-6) -- même garde à trois points que les trois
   * autres mutations ci-dessus ; `activateMerchantCgv` passe désormais
   * par la frontière serveur additive (lib/server/legal-cgv-activate-
   * service.ts), qui déclenche l'invalidation de /legal/<slug> -- rien
   * de plus à faire ici pour W2-6, uniquement consommer le résultat.
   */
  async function activate() {
    const { targetRestaurantId, isOperationCurrent } = beginLegalCgvOperation();
    setSaving(true);
    setActionMessage(null);
    try {
      await activateMerchantCgv(targetRestaurantId);
      // Garde 1 -- après la mutation, AVANT toute relecture.
      if (!isOperationCurrent()) return;
      await load(targetRestaurantId);
      // Garde 2 -- après la relecture, AVANT d'afficher le succès.
      if (!isOperationCurrent()) return;
      setActionMessage(t("legalCgvActivated"));
      setSaving(false);
    } catch (e) {
      // Garde 3 -- chemin d'échec. W2-5 : jamais e.message brut --
      // message stable/traduit uniquement, avec deux raisons
      // spécifiques quand elles sont connues.
      if (!isOperationCurrent()) return;
      let message = t("legalCgvActivateFailed");
      if (e instanceof ActivateCgvError) {
        if (e.reason === "incomplete") message = t("legalCgvActivateIncomplete");
        else if (e.reason === "not_published") message = t("legalCgvActivateNotPublished");
      }
      setActionMessage(message);
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

  // W2-3 -- la raison d'échec d'aperçu, pas seulement le HTML, doit
  // atteindre la section 6 ci-dessous pour afficher un message distinct.
  const previewResult = buildPreviewResult();

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
        {pageError && <p data-testid="legal-cgv-page-error" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{pageError}</p>}
        {actionMessage && <p data-testid="legal-cgv-action-message" className="rounded-xl bg-stone-100 p-3 text-sm text-stone-700">{actionMessage}</p>}
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
          {canEdit && <button data-testid="legal-cgv-save-legal" disabled={saving} onClick={saveLegal} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white">{t("legalCgvSave")}</button>}
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
              {canEdit && <button data-testid="legal-cgv-save-cgv" disabled={saving} onClick={saveCgvProfile} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white">{t("legalCgvSave")}</button>}
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
              {/*
                ONLINE WITHDRAWAL v1.1 -- le régime MIXTE est lui aussi
                concerné : il comporte, par définition, des produits
                ouvrant droit à rétractation. La bannière suit donc
                EXACTEMENT la condition que les deux gardes SQL
                appliquent désormais (regime in STANDARD_14_DAYS,
                MIXED), jamais une condition plus étroite qui
                laisserait croire à un marchand MIXTE qu'il peut
                publier.
              */}
              {(cgv.withdrawal_regime === "STANDARD_14_DAYS" || cgv.withdrawal_regime === "MIXED") && (
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
              {previewResult.reason === "no_template" ? (
                // REMÉDIATION B1 (RE-AUDIT, Noether comment 5951442732,
                // scanym-orchestrator#23) -- ÉTAT COMBINÉ : quand
                // `template === null` ET `cgv.completeness_errors` est
                // également non vide, la branche ci-dessous (complétude)
                // masquait silencieusement l'explication no-template --
                // le JSX ne testait JAMAIS `previewResult.reason` avant
                // d'avoir déjà écarté le cas "complétude". `no_template`
                // est désormais vérifiée EN PREMIER, inconditionnellement
                // : l'explication explicite "aucun modèle applicable"
                // reste visible que `completeness_errors` soit vide ou
                // non -- jamais remplacée par le "profil incomplet"
                // générique, jamais masquée par lui.
                <p data-testid="legal-cgv-preview-message" className="text-sm text-stone-500">
                  {previewFailureMessage(previewResult.reason)}
                </p>
              ) : cgv.completeness_errors.length > 0 ? (
                <ul className="list-inside list-disc text-sm text-amber-800">
                  {cgv.completeness_errors.map((code) => (
                    <li key={code}>{t(`legalCgvError_${code}`) !== `legalCgvError_${code}` ? t(`legalCgvError_${code}`) : code}</li>
                  ))}
                </ul>
              ) : previewResult.reason === null ? (
                // CGV DOCUMENT PRESENTATION v1 -- l'aperçu marchand
                // utilise EXACTEMENT la même mise en page que la page
                // publique (classe `cgv-document`), pour que ce que le
                // marchand relit avant publication soit ce que le
                // client verra. Aucun contenu n'est modifié ici.
                <div
                  className="cgv-document max-h-96 overflow-y-auto rounded-lg border p-3 text-sm"
                  dangerouslySetInnerHTML={{ __html: previewResult.html }}
                />
              ) : (
                // W2-3 -- message distinct selon la raison réelle de
                // l'échec, jamais systématiquement "profil incomplet".
                // REMÉDIATION B1 (Chateaubriand, audit d6ad249) --
                // `data-testid` dédié : ce paragraphe est rendu de façon
                // persistante à CHAQUE rendu dès que `cgv` existe (calcul
                // non conditionné par un clic, voir `previewResult` plus
                // haut dans le composant) -- le test W2-T-02 réécrit doit
                // pouvoir affirmer sa présence/son contenu SANS jamais
                // simuler de clic sur le bouton Publier désactivé.
                <p data-testid="legal-cgv-preview-message" className="text-sm text-stone-500">
                  {previewFailureMessage(previewResult.reason)}
                </p>
              )}
            </section>

            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4" data-testid="legal-cgv-docx-roundtrip">
              {/*
                CGV W1 -- DOCX EXPORT / IMPORT ROUND-TRIP. Deliberately
                placed AFTER the preview (section 6, whose rendered
                content this feeds on) and BEFORE publish/activate
                (section 7): this is a review aid for what WILL be
                published, never a publication path of its own. See
                the file-header comment near the top of this component
                for the full client-side-only architecture rationale.
              */}
              <h2 className="font-bold text-stone-900">{t("legalCgvSectionDocxRoundtrip")}</h2>
              <p className="text-xs text-stone-500">{t("legalCgvDocxImportHint")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="legal-cgv-docx-export"
                  disabled={previewResult.reason !== null}
                  onClick={() => previewResult.reason === null && exportCgvDocx(previewResult.html)}
                  className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  {t("legalCgvDocxExport")}
                </button>
                {canEdit && (
                  <label className="cursor-pointer rounded-xl border border-stone-300 px-4 py-2 text-sm font-bold text-stone-700">
                    {t("legalCgvDocxImport")}
                    <input
                      ref={docxFileInputRef}
                      type="file"
                      accept=".docx"
                      data-testid="legal-cgv-docx-import-input"
                      className="hidden"
                      disabled={docxImportBusy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void importCgvDocxFile(file);
                      }}
                    />
                  </label>
                )}
              </div>
              {previewResult.reason !== null && (
                <p className="text-xs text-stone-500">{t("legalCgvDocxExportUnavailable")}</p>
              )}
              {docxImportBusy && (
                <p data-testid="legal-cgv-docx-import-busy" className="text-sm text-stone-500">
                  {t("legalCgvDocxImportReading")}
                </p>
              )}
              {docxImportErrorMessage && (
                <p data-testid="legal-cgv-docx-import-error" className="text-sm text-red-700">
                  {docxImportErrorMessage}
                </p>
              )}
              {/*
                W1 REMEDIATION (W1-04) -- the diff is only ever
                rendered when it was produced FOR the restaurant
                currently displayed (second line of defense on top of
                the guard checkpoints in `importCgvDocxFile` and the
                explicit reset in `handleSelectRestaurant` -- see
                `docxReviewRestaurantId`'s own declaration comment).
              */}
              {docxDiffResult && docxReviewRestaurantId === restaurantId && (
                <div data-testid="legal-cgv-docx-diff" className="space-y-3 text-sm">
                  {docxDiffResult.hasNoMeaningfulChanges ? (
                    <p data-testid="legal-cgv-docx-diff-no-changes" className="text-stone-600">
                      {t("legalCgvDocxDiffNoChanges")}
                    </p>
                  ) : (
                    <>
                      {/* W1 REMEDIATION (W1-01) -- a pure chapter
                          reorder (bookmark identity preserved, never
                          surfaced as a false added/removed) gets its
                          own clear signal, distinct from per-chapter
                          edits and from removed chapters below. */}
                      {docxDiffResult.orderChanged && (
                        <div data-testid="legal-cgv-docx-diff-order-changed" className="rounded-lg bg-amber-50 p-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                            {t("legalCgvDocxDiffOrderChanged")}
                          </p>
                          <p className="text-stone-700">{docxDiffResult.importedOrder.join(" → ")}</p>
                        </div>
                      )}
                      {docxDiffResult.removedChapters.map((removed) => (
                        <div key={removed.bookmarkName} className="rounded-lg bg-red-50 p-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
                            {t("legalCgvDocxDiffRemovedChapter")}
                          </p>
                          <p className="font-semibold text-stone-900">{removed.heading}</p>
                        </div>
                      ))}
                      {docxDiffResult.chapters
                        .filter((chapter) => chapter.entries.some((entry) => entry.kind !== "unchanged"))
                        .map((chapter) => (
                          <div key={chapter.bookmarkName} className="rounded-lg border border-stone-200 p-2">
                            <p className="font-semibold text-stone-900">{chapter.heading}</p>
                            <ul className="space-y-1">
                              {chapter.entries
                                .filter((entry) => entry.kind !== "unchanged")
                                .map((entry, idx) => (
                                  <li key={idx}>
                                    {entry.kind === "modified" ? (
                                      <>
                                        <span className="block text-red-700 line-through">{entry.before}</span>
                                        <span className="block text-green-700">{entry.after}</span>
                                      </>
                                    ) : entry.kind === "added" ? (
                                      <span className="block text-green-700">{entry.text}</span>
                                    ) : (
                                      <span className="block text-red-700 line-through">{entry.text}</span>
                                    )}
                                  </li>
                                ))}
                            </ul>
                          </div>
                        ))}
                    </>
                  )}
                  {/*
                    W1 REMEDIATION (W1-02) -- front matter (title /
                    seller name / preamble) is now DIFFED, not merely
                    displayed: non-unchanged entries render exactly
                    like a chapter's own entries above. Unlike a
                    chapter, front matter has no removal/add-chapter
                    concept of its own -- it is always present on both
                    sides (the current model always has a title), so
                    only line-level entries ever appear here.
                  */}
                  {docxDiffResult.frontMatter.entries.some((e) => e.kind !== "unchanged") && (
                    <div className="rounded-lg border border-stone-200 p-2" data-testid="legal-cgv-docx-diff-leading">
                      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                        {t("legalCgvDocxDiffFrontMatterChanged")}
                      </p>
                      <ul className="space-y-1">
                        {docxDiffResult.frontMatter.entries
                          .filter((entry) => entry.kind !== "unchanged")
                          .map((entry, idx) => (
                            <li key={idx}>
                              {entry.kind === "modified" ? (
                                <>
                                  <span className="block text-red-700 line-through">{entry.before}</span>
                                  <span className="block text-green-700">{entry.after}</span>
                                </>
                              ) : entry.kind === "added" ? (
                                <span className="block text-green-700">{entry.text}</span>
                              ) : (
                                <span className="block text-red-700 line-through">{entry.text}</span>
                              )}
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="font-bold text-stone-900">7. {t("legalCgvSectionPublish")}</h2>
              <p className="text-sm text-stone-500">{t("legalCgvStatus")}: <strong>{cgv.status}</strong></p>
              {canEdit && (
                <div className="flex gap-2">
                  {/* W2-1/W2-2 -- `!template` couvre à la fois "aucun
                      modèle résolu pour ce pays" et "échec de
                      get_applicable_cgv_template" (templateRow.error,
                      voir load()) : dans les deux cas, publier n'a pas
                      de sens tant qu'aucun modèle n'est en mémoire. */}
                  <button data-testid="legal-cgv-publish" disabled={saving || cgv.completeness_errors.length > 0 || !template} onClick={publish} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                    {t("legalCgvPublish")}
                  </button>
                  {cgv.status !== "CGV_ACTIVE" && (
                    <button data-testid="legal-cgv-activate" disabled={saving || cgv.status !== "CGV_READY"} onClick={activate} className="rounded-xl bg-[#25D366] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
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
