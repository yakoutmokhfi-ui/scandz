"use client";

import { FormEvent, useState } from "react";
import { requestPasswordReset } from "@/lib/services/auth";
import { translate, type Lang } from "@/lib/i18n";

// Voir la note dans login/page.tsx : pas de sélecteur de langue ici,
// mais les textes viennent des dictionnaires FR/EN/AR.
const lang: Lang = "fr";
const t = (k: string, p?: Record<string, string | number>) =>
  translate(lang, k, p);

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  // Toujours vrai après envoi, quel que soit le résultat réel côté
  // Supabase : on ne révèle jamais si l'adresse existe ou non.
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    await requestPasswordReset(email.trim());
    setLoading(false);
    setSent(true);
  }

  return (
    <main className="min-h-screen bg-stone-100 px-4 py-12">
      <div className="mx-auto max-w-sm rounded-3xl bg-white p-7 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-widest text-amber-700">
          Scanym
        </p>
        <h1 className="mt-2 text-2xl font-bold text-stone-900">{t("fpTitle")}</h1>

        {sent ? (
          <>
            <p className="mt-4 rounded-xl bg-green-50 p-3 text-sm text-green-800">
              {t("fpSentMessage")}
            </p>
            <a
              href="/dashboard/login"
              className="mt-6 block text-center text-sm font-semibold text-stone-600 underline-offset-2 hover:underline"
            >
              &larr; {t("fpBackToLogin")}
            </a>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="mt-2 text-sm text-stone-600">{t("fpSubtitle")}</p>

            <label className="mt-6 block text-sm font-semibold text-stone-700">
              {t("fpEmail")}
            </label>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-600"
            />

            <button
              type="submit"
              disabled={loading}
              className="mt-6 w-full rounded-xl bg-stone-900 px-4 py-3 font-bold text-white disabled:opacity-50"
            >
              {loading ? t("fpSending") : t("fpSend")}
            </button>

            <a
              href="/dashboard/login"
              className="mt-4 block text-center text-sm font-semibold text-stone-600 underline-offset-2 hover:underline"
            >
              &larr; {t("fpBackToLogin")}
            </a>
          </form>
        )}
      </div>
    </main>
  );
}
