"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getEstablishmentSummary,
  isScanymOperator,
  type EstablishmentSummary,
} from "@/lib/services/establishments";
import { getMerchantCatalogue, getReceiptSettings, type CatalogueCategory } from "@/lib/services/dashboard";
import type { ReceiptSettings } from "@/lib/dashboard-types";
import {
  deriveCatalogueStatus,
  deriveLegalTaxStatus,
  derivePhotosStatus,
  deriveReadyToPublishStatus,
  summarizeCatalogue,
  type CatalogueSummary,
} from "@/lib/operator-cockpit";
import { tAdmin } from "@/lib/admin-i18n";
import CockpitSectionCard from "@/components/admin/CockpitSectionCard";

/**
 * OB-1 — OPERATOR COCKPIT.
 *
 * Fiche opérateur d'UN établissement sélectionné (`?r=<restaurant_id>`
 * dans l'URL — même convention que /dashboard, /dashboard/settings,
 * etc., PAS une nouvelle route dynamique : lu côté client depuis
 * `window.location.search`, jamais depuis un segment de route, pour
 * rester cohérent avec le reste du tableau de bord existant).
 *
 * UI + ORCHESTRATION EN LECTURE SEULE UNIQUEMENT : cette page n'appelle
 * AUCUNE RPC de mutation, ne modifie AUCUN statut, n'implémente AUCUNE
 * capacité métier manquante. Chaque section :
 *   - affiche un statut dérivé d'une lecture existante et déjà
 *     autorisée pour un opérateur Scanym, OU
 *   - affiche un état neutre "indisponible" quand la RPC/lecture
 *     correspondante n'autorise aujourd'hui QUE les membres
 *     restaurant_users (jamais contourné en UI — voir le commentaire
 *     sur chaque section ci-dessous pour la RPC exacte inspectée).
 *
 * v1.1 (refresh après publication d'OB-2 v1.1, baseline
 * e4740942f1bb3d47a4418c52b6353f5239597065) : CATALOGUE et PHOTOS ont
 * été RE-INSPECTÉS contre le SQL publié
 * (supabase/DRAFT-lot-catalogue-operator-authorization-v1.sql) --
 * get_merchant_catalogue autorise désormais explicitement
 * is_scanym_operator() en plus de restaurant_users -- ces deux
 * sections ne sont donc plus "unavailable" par défaut. PAYMENT et
 * DELIVERY ont aussi été re-vérifiés : aucun fichier payment/delivery
 * n'a changé dans cette publication (get_merchant_payment_provider_config
 * et get_merchant_delivery_fulfillment_pricing restent is_member_of
 * uniquement) -- inchangés dans ce lot. Chaque lien vers un écran
 * marchand existant (settings/catalogue/payment/delivery-pricing)
 * porte désormais un rappel explicite : ces écrans résolvent encore
 * l'établissement courant via restaurant_users
 * (getMerchantRestaurants, lib/services/dashboard.ts — INCHANGÉ), donc
 * un opérateur sans rattachement peut y voir "non lié à un
 * restaurant" malgré une autorisation backend déjà valide. Ce gap est
 * documenté, jamais contourné (aucune fausse ligne restaurant_users
 * n'est créée) -- voir OB1-V1.1-SETTINGS-CONTEXT-GAP.md du paquet
 * livré pour l'analyse complète et ce qu'un futur lot devrait changer.
 *
 * Isolation multi-tenant : `restaurantId` est lu UNE fois depuis l'URL
 * et employé identiquement pour tous les appels de cette page — aucun
 * état partagé entre deux établissements, aucune donnée mise en cache
 * d'un établissement précédemment consulté (les deux `useEffect`
 * ci-dessous dépendent explicitement de `restaurantId` et réinitialisent
 * l'état local à chaque changement).
 */
export default function OperatorCockpitPage() {
  const router = useRouter();

  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  const [restaurantId, setRestaurantId] = useState<string | null>(null);

  const [summary, setSummary] = useState<EstablishmentSummary | null>(null);
  const [receipt, setReceipt] = useState<ReceiptSettings | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueCategory[] | null>(null);
  const [catalogueUnavailable, setCatalogueUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      const ok = await isScanymOperator();
      setAuthorized(ok);
      setAuthChecked(true);
      if (!ok) {
        router.replace("/dashboard");
        return;
      }
      // Lu côté client uniquement, une fois l'autorisation confirmée
      // -- évite d'imposer une frontière Suspense au prérendu (même
      // convention que app/dashboard/page.tsx).
      const wanted = new URLSearchParams(window.location.search).get("r");
      setRestaurantId(wanted && wanted.trim() ? wanted.trim() : null);
    })();
  }, [router]);

  useEffect(() => {
    if (!authChecked || !authorized) return;
    if (!restaurantId) {
      setLoading(false);
      return;
    }
    // Réinitialisation explicite avant chaque chargement : aucune
    // donnée d'un établissement précédemment consulté ne doit
    // survivre à un changement de `restaurantId` (non-fuite entre
    // établissements).
    setSummary(null);
    setReceipt(null);
    setCatalogue(null);
    setCatalogueUnavailable(false);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const [s, r] = await Promise.all([
          getEstablishmentSummary(restaurantId),
          getReceiptSettings(restaurantId),
        ]);
        setSummary(s);
        setReceipt(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : tAdmin("cockpitLoadError"));
        setLoading(false);
        return;
      }
      // Chargement CATALOGUE séparé, en défense en profondeur : un
      // échec ici (ex. régression future d'autorisation, incident
      // réseau) dégrade UNIQUEMENT la section CATALOGUE/PHOTOS vers
      // l'état neutre "indisponible" -- il ne fait jamais échouer tout
      // le cockpit (MERCHANT/LEGAL-TAX restent utilisables), et
      // ne contourne jamais rien : une erreur reste une erreur,
      // jamais réinterprétée comme un catalogue vide.
      try {
        setCatalogue(await getMerchantCatalogue(restaurantId));
      } catch {
        setCatalogueUnavailable(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [authChecked, authorized, restaurantId]);

  if (!authChecked) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminLoading")}</main>;
  }
  if (!authorized) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminNotOperator")}</main>;
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <a href="/admin/establishments" className="text-sm font-semibold text-stone-500">
        {tAdmin("cockpitBack")}
      </a>

      {!restaurantId ? (
        <p className="rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          {tAdmin("cockpitMissingId")}
        </p>
      ) : loading ? (
        <p className="text-sm text-stone-500">{tAdmin("cockpitLoading")}</p>
      ) : error ? (
        <p className="rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          {error}
        </p>
      ) : (
        <CockpitBody
          restaurantId={restaurantId}
          summary={summary}
          receipt={receipt}
          catalogue={catalogue}
          catalogueUnavailable={catalogueUnavailable}
        />
      )}
    </main>
  );
}

function CockpitBody({
  restaurantId,
  summary,
  receipt,
  catalogue,
  catalogueUnavailable,
}: {
  restaurantId: string;
  summary: EstablishmentSummary | null;
  receipt: ReceiptSettings | null;
  catalogue: CatalogueCategory[] | null;
  catalogueUnavailable: boolean;
}) {
  const settingsHref = `/dashboard/settings?r=${restaurantId}`;
  const legalTaxStatus = deriveLegalTaxStatus(receipt);
  const publishStatus = summary ? deriveReadyToPublishStatus(summary.status) : "unavailable";

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const publicUrl = summary?.slug ? `${origin}/r/${summary.slug}` : null;

  // v1.1 — CATALOGUE/PHOTOS : résumé PUREMENT dérivé du résultat déjà
  // chargé par getMerchantCatalogue (aucune logique catalogue
  // dupliquée ici, voir lib/operator-cockpit.ts::summarizeCatalogue).
  const catalogueSummary: CatalogueSummary | null = catalogue ? summarizeCatalogue(catalogue) : null;
  const catalogueStatus = catalogueUnavailable
    ? "unavailable"
    : catalogueSummary
      ? deriveCatalogueStatus(catalogueSummary)
      : "unavailable";
  const photosStatus = catalogueUnavailable
    ? "unavailable"
    : catalogueSummary
      ? derivePhotosStatus(catalogueSummary)
      : "unavailable";

  return (
    <>
      <div>
        <h1 className="text-xl font-bold text-stone-900">{summary?.name ?? tAdmin("dirTitle")}</h1>
        <p className="font-mono text-xs text-stone-400">
          {tAdmin("cockpitEstablishmentIdLabel")} {restaurantId}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* 1. MERCHANT — réutilise get_establishment_summary (RPC déjà
            opérateur-autorisée, migration-lotd-establishment-creation.sql,
            déjà utilisée par app/admin/establishments/new/page.tsx). */}
        <CockpitSectionCard
          title={tAdmin("secMerchantTitle")}
          status={summary ? "ready" : "unavailable"}
          actionHref={settingsHref}
          actionLabel={tAdmin("secMerchantLink")}
        >
          <p>{tAdmin("dirColSlug")}: {summary?.slug ?? "—"}</p>
          <p>
            {summary?.ownerStatus === "linked" && summary.ownerEmail
              ? tAdmin("secMerchantOwnerLinked", { email: summary.ownerEmail })
              : summary?.ownerStatus && summary.ownerEmail
                ? tAdmin("secMerchantOwnerPending", { email: summary.ownerEmail })
                : tAdmin("secMerchantOwnerNone")}
          </p>
          <p className="mt-2 text-xs text-stone-400">{tAdmin("secExistingScreenCaveat")}</p>
        </CockpitSectionCard>

        {/* 2. LEGAL / TAX — réutilise get_receipt_settings (MERCHANT
            LEGAL & TAX PROFILE v1.2, assert_receipt_settings_read_access
            autorise explicitement restaurant_users OU
            is_scanym_operator() — voir
            supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql).
            Re-vérifié contre la baseline OB-1 v1.1 : fichier non
            modifié par OB-2 v1.1, toujours opérateur-autorisé. */}
        <CockpitSectionCard
          title={tAdmin("secLegalTitle")}
          status={legalTaxStatus}
          actionHref={settingsHref}
          actionLabel={tAdmin("secLegalLink")}
        >
          <p>{legalTaxStatus === "ready" ? tAdmin("secLegalReady") : tAdmin("secLegalIncomplete")}</p>
          <p className="mt-2 text-xs text-stone-400">{tAdmin("secExistingScreenCaveat")}</p>
        </CockpitSectionCard>

        {/* 3. CATALOGUE — v1.1 : get_merchant_catalogue autorise
            désormais is_scanym_operator() (OB-2 v1.1, section 6 de
            supabase/DRAFT-lot-catalogue-operator-authorization-v1.sql,
            corps SQL inspecté directement, jamais supposé). La lecture
            est donc appelée ici (aucune duplication de logique
            catalogue -- même fonction que app/dashboard/catalogue/page.tsx
            utilise déjà). Le lien vers l'écran marchand existant reste
            fourni pour l'ÉDITION complète (create/update/archive, elles
            aussi désormais opérateur-autorisées côté SQL), avec le
            rappel honnête ci-dessous : cet écran résout encore
            l'établissement via restaurant_users en UI (page non
            modifiée par OB-2 v1.1, hors périmètre SQL de ce lot -- et
            hors périmètre UI partagée de OB-1, voir
            OB1-V1.1-SETTINGS-CONTEXT-GAP.md). */}
        <CockpitSectionCard
          title={tAdmin("secCatalogueTitle")}
          status={catalogueStatus}
          actionHref={`/dashboard/catalogue?r=${restaurantId}`}
          actionLabel={tAdmin("secCatalogueLink")}
        >
          {catalogueUnavailable ? (
            <p>{tAdmin("cockpitLoadError")}</p>
          ) : catalogueSummary ? (
            catalogueSummary.productCount > 0 || catalogueSummary.categoryCount > 0 ? (
              <p>
                {tAdmin("secCatalogueSummary", {
                  categories: catalogueSummary.categoryCount,
                  products: catalogueSummary.productCount,
                })}
              </p>
            ) : (
              <p>{tAdmin("secCatalogueEmpty")}</p>
            )
          ) : (
            <p>{tAdmin("secCatalogueEmpty")}</p>
          )}
          <p className="mt-2 text-xs text-stone-400">{tAdmin("secExistingScreenCaveat")}</p>
        </CockpitSectionCard>

        {/* 4. PHOTOS — v1.1 : dérivé du MÊME résultat get_merchant_catalogue
            déjà chargé pour la section 3 (aucun second appel, aucune
            lecture Storage). L'upload/remplacement de photo reste hors
            périmètre : la policy Storage opérateur du bucket
            product-photos n'est PAS publiée par OB-2 v1.1 (confirmé
            explicitement dans le commentaire d'en-tête du SQL publié :
            "Aucune modification des policies storage.objects du bucket
            product-photos ... BLOCKED, nécessite un lot séparé") --
            re-vérifié, pas supposé inchangé. */}
        <CockpitSectionCard title={tAdmin("secPhotosTitle")} status={photosStatus}>
          {catalogueUnavailable ? (
            <p>{tAdmin("cockpitLoadError")}</p>
          ) : catalogueSummary && catalogueSummary.productCount > 0 ? (
            <p>
              {tAdmin("secPhotosSummary", {
                withPhoto: catalogueSummary.productsWithPhotoCount,
                total: catalogueSummary.productCount,
              })}
            </p>
          ) : (
            <p>{tAdmin("secPhotosNoProducts")}</p>
          )}
          <p className="mt-2 text-xs text-stone-400">{tAdmin("secPhotosUploadNote")}</p>
        </CockpitSectionCard>

        {/* 5. PAYMENT — re-vérifié contre la baseline OB-1 v1.1 :
            aucun fichier payment n'a changé dans la publication OB-2
            v1.1 (git diff --stat entre les deux baselines).
            get_merchant_payment_provider_config (PAYMENT P2B-A)
            n'autorise toujours que is_member_of(restaurant_id), aucune
            branche opérateur. Aucun credential/secret n'est lu ni
            affiché par cette carte (aucun appel n'est fait). */}
        <CockpitSectionCard
          title={tAdmin("secPaymentTitle")}
          status="unavailable"
          actionHref={`/dashboard/payment?r=${restaurantId}`}
          actionLabel={tAdmin("secPaymentLink")}
        >
          <p>{tAdmin("secPaymentUnavailable")}</p>
          <p className="mt-2 text-xs text-stone-400">{tAdmin("secExistingScreenCaveat")}</p>
        </CockpitSectionCard>

        {/* 6. DELIVERY — re-vérifié contre la baseline OB-1 v1.1 :
            informational only. get_merchant_delivery_fulfillment_pricing
            n'autorise toujours que is_member_of(restaurant_id),
            inchangé par OB-2 v1.1. Périmètre Stuart de Claude Monnet
            non touché : aucun fichier Stuart n'est lu ni référencé par
            cette section. */}
        <CockpitSectionCard
          title={tAdmin("secDeliveryTitle")}
          status="unavailable"
          actionHref={`/dashboard/delivery-pricing?r=${restaurantId}`}
          actionLabel={tAdmin("secDeliveryLink")}
        >
          <p>{tAdmin("secDeliveryUnavailable")}</p>
          <p className="mt-2 text-xs text-stone-400">{tAdmin("secExistingScreenCaveat")}</p>
        </CockpitSectionCard>

        {/* 7. QR / DOMAIN — dérivé du slug déjà chargé (aucune RPC
            supplémentaire). Aucune génération d'image QR (hors
            périmètre OB-1), aucun domaine personnalisé. */}
        <CockpitSectionCard
          title={tAdmin("secQrTitle")}
          status={publicUrl ? "ready" : "unavailable"}
          actionHref={publicUrl ?? undefined}
          actionLabel={publicUrl ? tAdmin("secQrLink") : undefined}
        >
          <p>{tAdmin("secQrDesc")}</p>
          <p className="mt-1 break-all font-mono text-xs">{publicUrl ?? tAdmin("secQrNoSlug")}</p>
        </CockpitSectionCard>

        {/* 8. HEALTH CHECKS — coquille de statut uniquement, comme
            demandé : l'agrégation réelle de préparation est le
            périmètre d'OB-9, jamais implémentée ici. */}
        <CockpitSectionCard title={tAdmin("secHealthTitle")} status="not_yet_implemented">
          <p>{tAdmin("secHealthDesc")}</p>
        </CockpitSectionCard>

        {/* 9. READY TO PUBLISH — affichage SEUL de restaurants.status
            (déjà inclus dans get_establishment_summary). Aucune RPC de
            publication n'est appelée ni implémentée (OB-11). */}
        <CockpitSectionCard title={tAdmin("secPublishTitle")} status={publishStatus}>
          <p>{tAdmin("secPublishDesc")}</p>
          <p className="mt-1">
            {tAdmin("secPublishStatusLabel", { status: summary?.status ?? "—" })}
          </p>
          <p className="mt-1">
            {publishStatus === "ready" ? tAdmin("secPublishReady") : tAdmin("secPublishIncomplete")}
          </p>
        </CockpitSectionCard>
      </div>
    </>
  );
}
