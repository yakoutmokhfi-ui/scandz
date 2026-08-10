"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  onPasswordRecovery,
  signOut,
  updatePassword,
} from "@/lib/services/auth";
import { MIN_PASSWORD_LENGTH, extractAuthLinkError } from "@/lib/auth-validation";
import { translate, type Lang } from "@/lib/i18n";

// Voir la note dans login/page.tsx : pas de sélecteur de langue ici,
// mais les textes viennent des dictionnaires FR/EN/AR.
const lang: Lang = "fr";
const t = (k: string, p?: Record<string, string | number>) =>
  translate(lang, k, p);

// Si aucun événement PASSWORD_RECOVERY n'arrive dans ce délai (lien
// absent, déjà consommé, ou page ouverte sans lien du tout), on
// considère l'accès invalide. Ce n'est pas un délai arbitraire avant
// de vérifier une session : c'est une limite haute pour arrêter
// d'attendre un événement qui, dans ce cas, ne viendra jamais.
const RECOVERY_EVENT_TIMEOUT_MS = 6000;

type Status = "checking" | "invalid" | "ready" | "done";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // 1. Supabase encode une erreur explicite dans l'URL si le lien
    //    est expiré ou a déjà été utilisé : on le détecte avant même
    //    d'attendre un événement d'auth.
    const linkError = extractAuthLinkError(window.location.href);
    if (linkError) {
      setStatus("invalid");
      return;
    }

    // 2. Sinon, on n'accepte l'accès que si Supabase confirme une
    //    vraie session de récupération (événement PASSWORD_RECOVERY),
    //    jamais une session ordinaire déjà connectée.
    const unsubscribe = onPasswordRecovery(() => {
      setStatus("ready");
    });

    const timeout = setTimeout(() => {
      setStatus((current) => (current === "checking" ? "invalid" : current));
    }, RECOVERY_EVENT_TIMEOUT_MS);

    return () => {
      unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("rpTooShort", { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirm) {
      setError(t("rpMismatch"));
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await updatePassword(password);

    if (updateError) {
      setSubmitting(false);
      setError(updateError);
      return;
    }

    // La session de récupération ne doit pas rester active de façon
    // implicite : on force une reconnexion explicite avec le nouveau
    // mot de passe plutôt que d'entrer directement dans le dashboard.
    await signOut();
    setSubmitting(false);
    setStatus("done");
    setTimeout(() => router.replace("/dashboard/login"), 1500);
  }

  return (
    <main className="min-h-screen bg-stone-100 px-4 py-12">
      <div className="mx-auto max-w-sm rounded-3xl bg-white p-7 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-widest text-amber-700">
          Scanym
        </p>
        <h1 className="mt-2 text-2xl font-bold text-stone-900">{t("rpTitle")}</h1>

        {status === "checking" && (
          <p className="mt-4 text-sm text-stone-500">{t("rpChecking")}</p>
        )}

        {status === "invalid" && (
          <>
            <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">
              {t("rpInvalidMessage")}
            </p>
            <a
              href="/dashboard/forgot-password"
              className="mt-6 block text-center text-sm font-semibold text-stone-600 underline-offset-2 hover:underline"
            >
              &larr; {t("rpRequestNewLink")}
            </a>
          </>
        )}

        {status === "done" && (
          <>
            <p className="mt-4 rounded-xl bg-green-50 p-3 text-sm text-green-800">
              {t("rpSuccessMessage")}
            </p>
            <a
              href="/dashboard/login"
              className="mt-6 block text-center text-sm font-semibold text-stone-600 underline-offset-2 hover:underline"
            >
              &larr; {t("rpBackToLogin")}
            </a>
          </>
        )}

        {status === "ready" && (
          <form onSubmit={submit}>
            <p className="mt-2 text-sm text-stone-600">{t("rpSubtitle")}</p>

            <label className="mt-6 block text-sm font-semibold text-stone-700">
              {t("rpNewPassword")}
            </label>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-600"
            />

            <label className="mt-4 block text-sm font-semibold text-stone-700">
              {t("rpConfirmPassword")}
            </label>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-600"
            />

            {error && (
              <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-6 w-full rounded-xl bg-stone-900 px-4 py-3 font-bold text-white disabled:opacity-50"
            >
              {submitting ? t("rpSubmitting") : t("rpSubmit")}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
