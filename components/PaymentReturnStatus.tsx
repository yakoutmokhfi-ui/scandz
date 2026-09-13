import Link from "next/link";
import type { PaymentReturnStatus } from "@/app/checkout/return/shared";
import { translate, type Lang } from "@/lib/i18n";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 — présentation pure des
 * pages de retour. Prend UNIQUEMENT le résultat déjà résolu
 * server-side (`resolvePaymentReturnStatus`) -- ce composant ne lit
 * lui-même ni requête, ni recherche de commande, ni RPC : aucune
 * décision de confiance n'est prise ici, uniquement de l'affichage.
 *
 * CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat, "payment-return
 * experience" / "FR/EN/AR i18n") — CORRECTIF : le texte était
 * auparavant 100% français codé en dur (aucun câblage i18n, gap
 * documenté par la Phase 0 de ce mandat). Ce composant reste un
 * Server Component (pas de "use client", même discipline que
 * app/track/[orderId]/page.tsx) : `lang` est résolue par l'appelant
 * (app/checkout/return/{ok,err}/page.tsx, via
 * `resolveLangFromParam`/lib/i18n.ts -- SEULE autorité, jamais un
 * second mécanisme) et transmise en prop ; ce composant appelle
 * directement `translate(lang, ...)`, exactement comme la page de
 * suivi -- jamais `useI18n()` (hook client, hors de propos ici).
 *
 * Le lien de suivi (`status.trackingPath`, présent sur toute variante
 * RÉSOLUE -- voir app/checkout/return/shared.ts) donne au client un
 * chemin de retour vers sa commande quelle que soit l'issue du
 * paiement -- jamais reconstruit ici, jamais un second jeton.
 */
export default function PaymentReturnStatusView({
  status,
  lang,
}: {
  status: PaymentReturnStatus;
  lang: Lang;
}) {
  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);

  const content = (() => {
    switch (status.kind) {
      case "paid":
        return {
          title: t("paymentReturnPaidTitle"),
          body: t("paymentReturnPaidBody"),
        };
      case "pending":
        return {
          title: t("paymentReturnPendingTitle"),
          body: t("paymentReturnPendingBody"),
        };
      case "not_required":
        return {
          title: t("paymentReturnNotRequiredTitle"),
          body: t("paymentReturnNotRequiredBody"),
        };
      case "failed_or_cancelled":
        return {
          title: t("paymentReturnFailedTitle"),
          body: t("paymentReturnFailedBody"),
        };
      case "unavailable":
      default:
        return {
          title: t("paymentReturnUnavailableTitle"),
          body: t("paymentReturnUnavailableBody"),
        };
    }
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-crema px-6 py-10">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
        <h1 className="mb-3 text-xl font-semibold">{content.title}</h1>
        <p className="mb-6 text-sm text-neutral-600">{content.body}</p>
        {status.kind !== "unavailable" && (
          <Link
            href={status.trackingPath}
            className="mb-3 block w-full rounded-full bg-caramel px-6 py-2 text-sm font-bold text-caramel-ink"
          >
            {t("trackYourOrder")}
          </Link>
        )}
        <Link
          href="/"
          className="inline-block rounded-full bg-neutral-900 px-6 py-2 text-sm font-medium text-white"
        >
          {t("paymentReturnBackHome")}
        </Link>
      </div>
    </div>
  );
}
