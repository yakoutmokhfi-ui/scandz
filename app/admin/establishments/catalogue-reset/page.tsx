"use client";

/**
 * Scanym — CLAUDE NOUGARO
 * OPERATOR BACKOFFICE — SAFE CATALOGUE RESET v1.1.
 *
 * Flux : sélection du marchand (via `?r=<restaurant_id>`, même
 * convention que /admin/establishments/cockpit et /dashboard/
 * catalogue-import) -> Aperçu (LECTURE SEULE, répétable) -> saisie de
 * la phrase de confirmation exacte -> Confirmer -> résultat détaillé.
 * Le bouton de réinitialisation reste désactivé côté UI tant que la
 * phrase saisie ne correspond pas EXACTEMENT au marchand actuellement
 * affiché (mandat §7) -- MAIS la garantie de sécurité RÉELLE est la
 * revalidation SERVEUR (v1.1) : la phrase saisie est transmise telle
 * quelle à `reset_merchant_catalogue`, qui la compare à une valeur
 * qu'il dérive lui-même depuis `restaurants.name` ; un appel RPC
 * direct contournant entièrement cette page échoue donc toujours de
 * la même façon (zéro mutation, voir catalogue-reset.ts).
 *
 * AUTORISATION -- même patron strict que app/dashboard/catalogue-
 * import/page.tsx et app/admin/establishments/cockpit/page.tsx :
 * authChecked/authorized + `isScanymOperator()` + redirection
 * `router.replace("/dashboard")` pour tout compte authentifié mais
 * non opérateur -- AVANT toute résolution de restaurant, tout aperçu,
 * tout commit. Rappel honnête (voir lib/services/establishments.ts) :
 * ce contrôle est un contrôle d'APPLICATION (UI), pas une garantie
 * PostgreSQL -- la garantie réelle est `is_scanym_operator()`,
 * re-vérifiée À L'INTÉRIEUR de `preview_catalogue_reset`/
 * `reset_merchant_catalogue` (supabase/DRAFT-lot-operator-catalogue-
 * reset-v1.sql), SANS repli owner/manager (contrairement aux RPC
 * d'édition catalogue unitaire) -- un marchand authentifié, même
 * propriétaire de SON PROPRE restaurant, ne peut jamais déclencher ce
 * reset lui-même : action Operator Backoffice uniquement.
 *
 * TENANT ISOLATION -- `restaurantId` est lu UNE fois depuis l'URL et
 * employé identiquement pour l'aperçu ET le commit -- changer
 * d'établissement invalide immédiatement tout aperçu/résultat déjà
 * affiché (mêmes handlers que catalogue-import/page.tsx).
 *
 * NO AUTOMATIC REIMPORT (mandat §19) : ce lot ne déclenche JAMAIS
 * `commitCatalogueImport`/`analyzeCatalogueImportFile` -- après un
 * reset réussi, un lien EXISTANT (déjà audité, jamais réimplémenté
 * ici) renvoie vers /dashboard/catalogue-import?r=<id>, sans aucune
 * pré-sélection de fichier ni déclenchement automatique.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { getEstablishmentSummary, isScanymOperator } from "@/lib/services/establishments";
import {
  previewCatalogueReset,
  resetMerchantCatalogue,
  buildCatalogueResetConfirmationPhrase,
  isCatalogueResetConfirmationPhraseValid,
  CatalogueResetConfirmationMismatchError,
  type CatalogueResetPreview,
  type CatalogueResetResult,
} from "@/lib/services/catalogue-reset";
import { tAdmin } from "@/lib/admin-i18n";

export default function CatalogueResetPage() {
  const router = useRouter();

  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const [merchantName, setMerchantName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [preview, setPreview] = useState<CatalogueResetPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogueResetResult | null>(null);

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
    // Changement d'établissement -- réinitialisation explicite de
    // tout état dérivé d'un établissement précédent (jamais de
    // Preview/résultat affiché pour le mauvais marchand).
    setMerchantName(null);
    setLoadError(null);
    setPreview(null);
    setPreviewError(null);
    setConfirmText("");
    setCommitError(null);
    setResult(null);
    setLoading(true);
    (async () => {
      try {
        const summary = await getEstablishmentSummary(restaurantId);
        setMerchantName(summary.name);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : tAdmin("catResetPreviewError"));
      } finally {
        setLoading(false);
      }
    })();
  }, [authChecked, authorized, restaurantId]);

  async function handlePreview() {
    if (!restaurantId) return;
    setPreviewing(true);
    setPreviewError(null);
    // Un nouvel aperçu invalide tout résultat/texte de confirmation
    // déjà saisi pour un état antérieur du catalogue (jamais de
    // confirmation sur un aperçu périmé).
    setResult(null);
    setConfirmText("");
    try {
      const p = await previewCatalogueReset(restaurantId);
      setPreview(p);
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : tAdmin("catResetPreviewError"));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirmReset() {
    if (!restaurantId || !merchantName) return;
    // Garde-fou UI (anti-clic-accidentel) -- la garantie réelle est la
    // revalidation serveur ci-dessous, qui reçoit `confirmText` TEL
    // QUEL (mandat v1.1 §1, "Server must independently derive the
    // expected phrase").
    if (!isCatalogueResetConfirmationPhraseValid(confirmText, merchantName)) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const r = await resetMerchantCatalogue(restaurantId, confirmText);
      setResult(r);
      // Le commit revalide/recalcule tout côté serveur -- l'aperçu
      // affiché avant confirmation est désormais périmé par
      // construction (mandat §10) : il est effacé pour ne jamais
      // laisser croire qu'il reflète encore l'état courant.
      setPreview(null);
      setConfirmText("");
    } catch (e) {
      if (e instanceof CatalogueResetConfirmationMismatchError) {
        setCommitError(tAdmin("catResetCommitConfirmRejected"));
      } else {
        setCommitError(e instanceof Error ? e.message : tAdmin("catResetCommitError"));
      }
    } finally {
      setCommitting(false);
    }
  }

  if (!authChecked) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminLoading")}</main>;
  }
  if (!authorized) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminNotOperator")}</main>;
  }

  const confirmationPhrase = merchantName ? buildCatalogueResetConfirmationPhrase(merchantName) : null;
  const confirmValid =
    confirmationPhrase !== null && isCatalogueResetConfirmationPhraseValid(confirmText, merchantName ?? "");

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <a href="/admin/establishments" className="text-sm font-semibold text-stone-500">
        {tAdmin("catResetBack")}
      </a>

      <h1 className="text-xl font-bold text-stone-900">{tAdmin("catResetTitle")}</h1>

      {!restaurantId ? (
        <p className="rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          {tAdmin("catResetMissingId")}
        </p>
      ) : loading ? (
        <p className="text-sm text-stone-500">{tAdmin("catResetLoading")}</p>
      ) : loadError ? (
        <p className="rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          {loadError}
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <p className="text-sm text-stone-500">{tAdmin("catResetMerchantLabel")}</p>
            <p className="text-lg font-bold text-stone-900">{merchantName}</p>
            <p className="mt-1 font-mono text-xs text-stone-400">
              {tAdmin("catResetMerchantIdLabel")} {restaurantId}
            </p>
          </div>

          <p className="text-sm text-stone-600">{tAdmin("catResetIntro")}</p>

          <button
            type="button"
            onClick={handlePreview}
            disabled={previewing}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {previewing ? tAdmin("catResetPreviewing") : tAdmin("catResetPreviewButton")}
          </button>

          {previewError && (
            <p className="rounded-xl border border-red-400 bg-red-50 p-4 text-sm font-semibold text-red-800">
              {previewError}
            </p>
          )}

          {preview && (
            <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm">
              <p className="font-bold text-stone-900">{tAdmin("catResetPreviewTitle")}</p>
              <p>{tAdmin("catResetPreviewActiveProducts", { count: preview.activeProductsCount })}</p>
              <p>{tAdmin("catResetPreviewArchivedProducts", { count: preview.archivedProductsCount })}</p>
              <p>{tAdmin("catResetPreviewSubRemovable", { count: preview.subcategoriesRemovable })}</p>
              <p>{tAdmin("catResetPreviewSubRetained", { count: preview.subcategoriesRetained })}</p>
              <p>{tAdmin("catResetPreviewCatRemovable", { count: preview.categoriesRemovable })}</p>
              <p>{tAdmin("catResetPreviewCatRetained", { count: preview.categoriesRetained })}</p>
              <p>{tAdmin("catResetPreviewOrderHistory", { count: preview.productsWithOrderHistory })}</p>
              <p>{tAdmin("catResetPreviewCatActiveAfter", { count: preview.categoriesActiveAfterReset })}</p>
              <p>{tAdmin("catResetPreviewSubActiveAfter", { count: preview.subcategoriesActiveAfterReset })}</p>
              <p className="font-semibold text-emerald-700">{tAdmin("catResetPreviewHistoryNote")}</p>
            </div>
          )}

          {preview && merchantName && confirmationPhrase && (
            <div className="space-y-3 rounded-xl border border-amber-400 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">{tAdmin("catResetConfirmWarning")}</p>
              <p className="text-sm text-stone-700">{tAdmin("catResetConfirmLabel")}</p>
              <p className="select-all rounded bg-white px-3 py-2 font-mono text-sm font-bold text-stone-900">
                {confirmationPhrase}
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={tAdmin("catResetConfirmPlaceholder")}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
              />
              {confirmText.length > 0 && !confirmValid && (
                <p className="text-xs font-semibold text-red-700">{tAdmin("catResetConfirmMismatch")}</p>
              )}
              <button
                type="button"
                onClick={handleConfirmReset}
                disabled={!confirmValid || committing}
                className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {committing ? tAdmin("catResetCommitting") : tAdmin("catResetConfirmButton")}
              </button>
            </div>
          )}

          {commitError && (
            <p className="rounded-xl border border-red-400 bg-red-50 p-4 text-sm font-semibold text-red-800">
              {commitError}
            </p>
          )}

          {result && (
            <div className="space-y-2 rounded-xl border border-emerald-400 bg-emerald-50 p-4 text-sm">
              <p className="font-bold text-emerald-900">{tAdmin("catResetResultTitle")}</p>
              {result.result === "no_op" && (
                <p className="font-semibold text-emerald-800">{tAdmin("catResetResultNoOp")}</p>
              )}
              <p>{tAdmin("catResetResultProductsArchived", { count: result.productsArchived })}</p>
              <p>{tAdmin("catResetResultSubRemoved", { count: result.subcategoriesRemoved })}</p>
              <p>{tAdmin("catResetResultSubRetained", { count: result.subcategoriesRetained })}</p>
              <p>{tAdmin("catResetResultCatRemoved", { count: result.categoriesRemoved })}</p>
              <p>{tAdmin("catResetResultCatRetained", { count: result.categoriesRetained })}</p>
              <p>{tAdmin("catResetResultCatActiveAfter", { count: result.categoriesActiveAfterReset })}</p>
              <p>{tAdmin("catResetResultSubActiveAfter", { count: result.subcategoriesActiveAfterReset })}</p>
              <p className="font-semibold">{tAdmin("catResetResultHistoryPreserved")}</p>
              <a
                href={`/dashboard/catalogue-import?r=${restaurantId}`}
                className="mt-2 block font-semibold text-emerald-700 underline"
              >
                {tAdmin("catResetResultBackToImport")}
              </a>
            </div>
          )}
        </>
      )}
    </main>
  );
}
