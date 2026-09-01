import Link from "next/link";
import type { PaymentReturnStatus } from "@/app/checkout/return/shared";

/**
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 — présentation pure des
 * pages de retour. Prend UNIQUEMENT le résultat déjà résolu
 * server-side (`resolvePaymentReturnStatus`) -- ce composant ne lit
 * lui-même ni requête, ni recherche de commande, ni RPC : aucune
 * décision de confiance n'est prise ici, uniquement de l'affichage.
 *
 * Texte statique en français uniquement dans ce lot (le système i18n
 * existant, `lib/i18n-context`, n'est pas câblé ici -- hors périmètre
 * de ce lot, qui est une orchestration serveur, pas une refonte UX ;
 * suivi documenté dans le rapport livré, PAS un OPEN GAP de sécurité).
 */
export default function PaymentReturnStatusView({ status }: { status: PaymentReturnStatus }) {
  const content = (() => {
    switch (status.kind) {
      case "paid":
        return {
          title: "Paiement confirmé",
          body: "Votre paiement a bien été reçu et confirmé. Merci pour votre commande.",
          tone: "success" as const,
        };
      case "pending":
        return {
          title: "Paiement en cours de traitement",
          body: "Votre paiement est en cours de validation par votre banque ou par le prestataire de paiement. Cette page se met à jour automatiquement dès que la confirmation est reçue -- vous pouvez aussi la recharger dans quelques instants.",
          tone: "pending" as const,
        };
      case "not_required":
        return {
          title: "Aucun paiement requis",
          body: "Cette commande ne nécessite pas de paiement en ligne.",
          tone: "pending" as const,
        };
      case "failed_or_cancelled":
        return {
          title: "Paiement non abouti",
          body: "Ce paiement n'a pas pu être finalisé. Vous pouvez retourner à votre commande pour réessayer.",
          tone: "error" as const,
        };
      case "unavailable":
      default:
        return {
          title: "Statut indisponible",
          body: "Nous ne parvenons pas à afficher le statut de ce paiement pour le moment. Si le débit a bien eu lieu sur votre moyen de paiement, votre commande sera automatiquement mise à jour dès réception de la confirmation -- aucune action n'est requise de votre part.",
          tone: "error" as const,
        };
    }
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-crema px-6 py-10">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
        <h1 className="mb-3 text-xl font-semibold">{content.title}</h1>
        <p className="mb-6 text-sm text-neutral-600">{content.body}</p>
        <Link
          href="/"
          className="inline-block rounded-full bg-neutral-900 px-6 py-2 text-sm font-medium text-white"
        >
          Retour à l&apos;accueil
        </Link>
      </div>
    </div>
  );
}
