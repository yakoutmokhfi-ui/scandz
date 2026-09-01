import { resolvePaymentReturnStatus } from "@/app/checkout/return/shared";
import PaymentReturnStatusView from "@/components/PaymentReturnStatus";

// Jamais mise en cache -- le statut affiché DOIT toujours refléter
// l'état serveur au moment de la visite (mission v3 : "browser return
// is UX-only and reads server state").
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CheckoutReturnOkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const status = await resolvePaymentReturnStatus(resolved);
  return <PaymentReturnStatusView status={status} />;
}
