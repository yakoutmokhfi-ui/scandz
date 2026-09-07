"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { isScanymOperator } from "@/lib/services/establishments";
import { listOperatorEstablishments } from "@/lib/services/operator-directory";
import { filterEstablishments, type OperatorEstablishmentListItem } from "@/lib/operator-cockpit";
import { tAdmin } from "@/lib/admin-i18n";

/**
 * OB-1 — OPERATOR MERCHANT DIRECTORY.
 *
 * Point d'entrée réservé aux opérateurs Scanym pour trouver/ouvrir un
 * établissement existant sans construire une URL `?r=` à la main.
 * Lecture SEULE (aucune mutation) — voir
 * lib/services/operator-directory.ts pour le détail exact de la
 * lecture réutilisée (policy RLS "lecture operateur restaurants",
 * déjà publiée, non modifiée par ce lot).
 *
 * Autorisation : même patron EXACT que
 * app/admin/establishments/new/page.tsx (authChecked/authorized +
 * redirection) — vérifiée ici UNIQUEMENT pour l'affichage (masquer la
 * page à un utilisateur légitime mais non-opérateur) ; la vraie
 * protection vit dans la policy RLS elle-même, revérifiée
 * indépendamment de ce que montre cette page, jamais contournée.
 */
export default function OperatorEstablishmentDirectoryPage() {
  const router = useRouter();

  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  const [establishments, setEstablishments] = useState<OperatorEstablishmentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState("");

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
        // Ne laisse jamais le répertoire affiché à un utilisateur
        // légitime mais non-opérateur : redirection vers son propre
        // tableau de bord, jamais un simple masquage de lien.
        router.replace("/dashboard");
      }
    })();
  }, [router]);

  useEffect(() => {
    if (!authChecked || !authorized) return;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        setEstablishments(await listOperatorEstablishments());
      } catch (e) {
        setError(e instanceof Error ? e.message : tAdmin("dirLoadError"));
      } finally {
        setLoading(false);
      }
    })();
  }, [authChecked, authorized]);

  const countries = useMemo(
    () =>
      Array.from(new Set(establishments.map((e) => e.country).filter((c): c is string => !!c))).sort(),
    [establishments]
  );
  const statuses = useMemo(
    () => Array.from(new Set(establishments.map((e) => e.status))).sort(),
    [establishments]
  );

  const filtered = useMemo(
    () => filterEstablishments(establishments, { query, country, status }),
    [establishments, query, country, status]
  );

  if (!authChecked) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminLoading")}</main>;
  }
  if (!authorized) {
    return <main className="p-6 text-sm text-stone-500">{tAdmin("adminNotOperator")}</main>;
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-900">{tAdmin("dirTitle")}</h1>
          <p className="text-sm text-stone-500">{tAdmin("dirSubtitle")}</p>
        </div>
        <a
          href="/admin/establishments/new"
          className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white"
        >
          {tAdmin("newEstablishmentLink")}
        </a>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tAdmin("dirSearchPlaceholder")}
          className="min-w-[220px] flex-1 rounded-xl border border-stone-300 p-2.5 text-sm"
        />
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="rounded-xl border border-stone-300 bg-white p-2.5 text-sm"
        >
          <option value="">{tAdmin("dirFilterAllCountries")}</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-xl border border-stone-300 bg-white p-2.5 text-sm"
        >
          <option value="">{tAdmin("dirFilterAllStatuses")}</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-stone-500">{tAdmin("dirLoading")}</p>
      ) : (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
            {tAdmin("dirCount", { count: filtered.length })}
          </p>

          {filtered.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center text-sm text-stone-500 shadow-sm">
              {tAdmin("dirEmpty")}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-stone-200 bg-stone-50 text-xs font-bold uppercase text-stone-500">
                  <tr>
                    <th className="p-3">{tAdmin("dirColName")}</th>
                    <th className="p-3">{tAdmin("dirColSlug")}</th>
                    <th className="p-3">{tAdmin("dirColCountry")}</th>
                    <th className="p-3">{tAdmin("dirColStatus")}</th>
                    <th className="p-3">{tAdmin("dirColId")}</th>
                    <th className="p-3">{tAdmin("dirColAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr key={item.restaurantId} className="border-b border-stone-100 last:border-0">
                      <td className="p-3 font-semibold text-stone-900">{item.name}</td>
                      <td className="p-3 text-stone-600">{item.slug}</td>
                      <td className="p-3 text-stone-600">{item.country ?? "—"}</td>
                      <td className="p-3 text-stone-600">{item.status}</td>
                      <td
                        className="max-w-[140px] truncate p-3 font-mono text-xs text-stone-400"
                        title={item.restaurantId}
                      >
                        {item.restaurantId}
                      </td>
                      <td className="p-3">
                        <a
                          href={`/admin/establishments/cockpit?r=${item.restaurantId}`}
                          className="font-semibold text-emerald-700 underline"
                        >
                          {tAdmin("dirOpenCockpit")}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
