"use client";

/**
 * Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
 * Upload -> Analyse -> Preview -> Errors/Warnings -> éligibilité.
 * AUCUNE action de commit/import active dans cette page (mandat :
 * "There must be NO active import/commit action" -- le bouton
 * "Importer" reste TOUJOURS désactivé, placeholder "Import will be
 * enabled in OB-4").
 *
 * TENANT ISOLATION : le restaurant cible est TOUJOURS explicite,
 * jamais implicite -- via le paramètre d'URL `?r=<restaurant_id>`
 * (même convention que app/dashboard/catalogue, seul point d'entrée
 * déjà utilisé par un opérateur Scanym aujourd'hui -- voir
 * FINDINGS.md, "Constat UI role gating"), ou via le sélecteur
 * ci-dessous quand le compte courant a au moins un restaurant en
 * propre (`getMerchantRestaurants`, qui ne liste QUE les restaurants
 * où l'utilisateur a une ligne restaurant_users -- un opérateur sans
 * ligne restaurant_users, cas normal, doit donc obligatoirement
 * arriver via `?r=`). Tant qu'aucun restaurant n'est résolu,
 * l'analyse reste bloquée : "Preview must operate only on the
 * explicitly selected restaurant."
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { getMerchantRestaurants } from "@/lib/services/dashboard";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import {
  analyzeCatalogueImportFile,
  type CatalogueImportAnalysisResult,
} from "@/lib/services/catalogue-import";
import type { PreviewRow } from "@/lib/catalogue-import/types";

const STATUS_LABEL: Record<PreviewRow["status"], string> = {
  OK: "OK",
  WARNING: "Avertissement",
  BLOCKED: "Bloqué",
};

const ACTION_LABEL: Record<PreviewRow["plannedAction"], string> = {
  CREATE: "Créera",
  UPDATE: "Mettra à jour",
  SKIP: "Sans changement",
  BLOCKED: "Bloqué",
};

const RESOLUTION_LABEL: Record<string, string> = {
  EXISTING: "Existante",
  WOULD_CREATE: "Sera créée",
  AMBIGUOUS: "Ambiguë",
  ERROR: "Erreur",
};

function formatResolution(res: { state: string; displayName: string } | null): string {
  if (!res) return "—";
  const label = RESOLUTION_LABEL[res.state] ?? res.state;
  return res.displayName ? `${label} (${res.displayName})` : label;
}

export default function CatalogueImportPage() {
  const router = useRouter();
  const [restaurantId, setRestaurantId] = useState("");
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<CatalogueImportAnalysisResult | null>(null);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      const wanted = new URLSearchParams(window.location.search).get("r");
      if (wanted) setRestaurantId(wanted);
      try {
        const next = await getMerchantRestaurants();
        setMappings(next);
        if (!wanted && next.length > 0) setRestaurantId(next[0].restaurant_id);
      } catch {
        // Un opérateur sans aucune ligne restaurant_users obtient une
        // liste vide ici (comportement attendu, pas une erreur) --
        // seul `?r=` lui permet de continuer, voir en-tête de fichier.
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function handleAnalyze() {
    if (!file || !restaurantId) return;
    setAnalyzing(true);
    setResult(null);
    try {
      const analysis = await analyzeCatalogueImportFile(file, restaurantId);
      setResult(analysis);
    } catch (e) {
      setResult({
        kind: "STRUCTURAL_ERROR",
        code: "MALFORMED_WORKBOOK",
        message: e instanceof Error ? e.message : "Erreur inattendue pendant l'analyse.",
      });
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Chargement…</div>;
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Import de catalogue (aperçu)</h1>
        <a
          href={restaurantId ? `/dashboard/catalogue?r=${restaurantId}` : "/dashboard/catalogue"}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Retour au catalogue
        </a>
      </div>

      <p className="mb-4 text-sm text-gray-600">
        Cette page analyse un fichier <code>catalogue.xlsx</code> (ou <code>.csv</code>) et affiche un aperçu
        détaillé, ligne par ligne — <strong>aucune modification n&rsquo;est appliquée au catalogue</strong>. La
        confirmation d&rsquo;import est un lot séparé (OB-4), pas encore disponible.
      </p>

      <div className="mb-6 rounded-lg border border-gray-200 p-4">
        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium text-gray-700">Restaurant</label>
          {mappings.length > 0 ? (
            <select
              className="w-full rounded border border-gray-300 p-2 text-sm"
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
            >
              {mappings.map((m) => (
                <option key={m.restaurant_id} value={m.restaurant_id}>
                  {m.restaurants?.name ?? m.restaurant_id}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="w-full rounded border border-gray-300 p-2 text-sm"
              placeholder="Identifiant du restaurant (paramètre ?r= de l'URL)"
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
            />
          )}
          {mappings.length === 0 && (
            <p className="mt-1 text-xs text-gray-500">
              Aucun restaurant en propre trouvé pour ce compte — accès opérateur : indiquez l&rsquo;identifiant du
              restaurant explicitement, ou ouvrez cette page avec <code>?r=&lt;restaurant_id&gt;</code>.
            </p>
          )}
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium text-gray-700">Fichier (.xlsx prioritaire, .csv accepté)</label>
          <input
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
        </div>

        <button
          type="button"
          disabled={!file || !restaurantId || analyzing}
          onClick={handleAnalyze}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {analyzing ? "Analyse en cours…" : "Analyser"}
        </button>

        <button
          type="button"
          disabled
          title="Import will be enabled in OB-4"
          className="ml-3 rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-400 cursor-not-allowed"
        >
          Importer (activé dans OB-4)
        </button>
      </div>

      {result?.kind === "STRUCTURAL_ERROR" && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Fichier non analysable ({result.code})</p>
          <p>{result.message}</p>
          {result.missingHeaders && result.missingHeaders.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {result.missingHeaders.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result?.kind === "OK" && (
        <>
          <div className="mb-4 rounded-lg border border-gray-200 p-4">
            <p className="mb-2 text-sm">
              <strong>{result.fileName}</strong> ({result.sourceFormat.toUpperCase()}) —{" "}
              {result.report.totalRows} ligne(s) analysée(s).
            </p>
            <p className="mb-2 text-sm">
              Éligibilité :{" "}
              <span
                className={
                  result.report.eligibility === "ELIGIBLE"
                    ? "font-semibold text-green-700"
                    : result.report.eligibility === "ELIGIBLE_WITH_WARNINGS"
                      ? "font-semibold text-amber-700"
                      : "font-semibold text-red-700"
                }
              >
                {result.report.eligibility === "ELIGIBLE" && "Éligible pour un futur import"}
                {result.report.eligibility === "ELIGIBLE_WITH_WARNINGS" && "Éligible avec avertissements"}
                {result.report.eligibility === "NOT_ELIGIBLE" && "Non éligible — erreurs bloquantes présentes"}
              </span>
            </p>
            <p className="text-xs text-gray-500">
              {result.report.okRows} OK · {result.report.warningRows} avertissement(s) · {result.report.blockedRows} bloquée(s)
            </p>
            {result.report.columnMapWarnings.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-gray-500">
                {result.report.columnMapWarnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="p-2">Ligne</th>
                  <th className="p-2">Statut</th>
                  <th className="p-2">Nom</th>
                  <th className="p-2">Catégorie</th>
                  <th className="p-2">Sous-catégorie</th>
                  <th className="p-2">Photo</th>
                  <th className="p-2">Action prévue</th>
                  <th className="p-2">Détails</th>
                </tr>
              </thead>
              <tbody>
                {result.report.rows.map((row) => (
                  <tr key={row.row} className="border-t border-gray-100 align-top">
                    <td className="p-2">{row.row}</td>
                    <td className="p-2">
                      <span
                        className={
                          row.status === "OK"
                            ? "text-green-700"
                            : row.status === "WARNING"
                              ? "text-amber-700"
                              : "text-red-700"
                        }
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td className="p-2">{row.normalizedValues.name || "—"}</td>
                    <td className="p-2">{formatResolution(row.resolvedCategory)}</td>
                    <td className="p-2">{formatResolution(row.resolvedSubcategory)}</td>
                    <td className="p-2">{row.photoFilename ?? "—"}</td>
                    <td className="p-2">{ACTION_LABEL[row.plannedAction]}</td>
                    <td className="p-2">
                      {[...row.errors, ...row.warnings, ...row.infos].map((issue, i) => (
                        <div
                          key={i}
                          className={
                            issue.severity === "BLOCKING_ERROR"
                              ? "text-red-700"
                              : issue.severity === "WARNING"
                                ? "text-amber-700"
                                : "text-gray-500"
                          }
                        >
                          {issue.message}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
