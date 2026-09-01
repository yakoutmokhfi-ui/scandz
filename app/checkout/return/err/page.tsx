import { resolvePaymentReturnStatus } from "@/app/checkout/return/shared";
import PaymentReturnStatusView from "@/components/PaymentReturnStatus";

/**
 * DÉLIBÉRÉMENT IDENTIQUE à app/checkout/return/ok/page.tsx dans sa
 * logique : le fait que Monetico ait redirigé le navigateur vers
 * l'URL "err" plutôt que "ok" N'EST PAS traité comme une information
 * fiable (mission v3, invariant dur : "browser return is UX-only and
 * reads server state" -- AUCUN statut n'est jamais dérivé du simple
 * chemin de redirection emprunté par le navigateur). Le statut réel
 * affiché provient EXCLUSIVEMENT de `resolvePaymentReturnStatus`, la
 * MÊME fonction que la page "ok" -- un paiement réellement accepté
 * entre-temps (callback authentique déjà traité) s'affichera donc
 * comme "paid" ICI AUSSI, même si le navigateur est arrivé sur ce
 * chemin.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CheckoutReturnErrPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const status = await resolvePaymentReturnStatus(resolved);
  return <PaymentReturnStatusView status={status} />;
}
