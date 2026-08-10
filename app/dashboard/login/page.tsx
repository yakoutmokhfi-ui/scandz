"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, signIn } from "@/lib/services/auth";
import { translate, type Lang } from "@/lib/i18n";

// Pas de sélecteur de langue sur cette page : le choix de langue du
// dashboard dépend aujourd'hui du restaurant du commerçant, connu
// seulement après connexion. Ajouter un sélecteur ici sortirait du
// périmètre de la V64 ; les textes sont néanmoins tirés des
// dictionnaires FR/EN/AR pour rester cohérents avec le reste de
// l'application et prêts pour un futur sélecteur.
const lang: Lang = "fr";
const t = (k: string, p?: Record<string, string | number>) =>
  translate(lang, k, p);

export default function DashboardLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void getSession().then((session) => {
      if (session) router.replace("/dashboard");
    });
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: authError } = await signIn(email, password);
    setLoading(false);
    if (authError) {
      setError(authError);
      return;
    }
    router.replace("/dashboard");
  }

  return (
    <main className="min-h-screen bg-stone-100 px-4 py-12">
      <form onSubmit={submit} className="mx-auto max-w-sm rounded-3xl bg-white p-7 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-widest text-amber-700">Scanym</p>
        <h1 className="mt-2 text-2xl font-bold text-stone-900">{t("authTitle")}</h1>
        <p className="mt-2 text-sm text-stone-600">{t("authSubtitle")}</p>

        <label className="mt-7 block text-sm font-semibold text-stone-700">
          {t("authEmail")}
        </label>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-600"
        />

        <label className="mt-4 block text-sm font-semibold text-stone-700">
          {t("authPassword")}
        </label>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-600"
        />

        {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full rounded-xl bg-stone-900 px-4 py-3 font-bold text-white disabled:opacity-50"
        >
          {loading ? t("authSubmitting") : t("authSubmit")}
        </button>

        <a
          href="/dashboard/forgot-password"
          className="mt-4 block text-center text-sm font-semibold text-stone-600 underline-offset-2 hover:underline"
        >
          {t("authForgotLink")}
        </a>
      </form>
    </main>
  );
}
