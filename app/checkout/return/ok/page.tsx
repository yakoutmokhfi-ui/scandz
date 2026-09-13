import { resolvePaymentReturnStatus } from "@/app/checkout/return/shared";
import PaymentReturnStatusView from "@/components/PaymentReturnStatus";
import { resolveLangFromParam } from "@/lib/i18n";

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
  // CUSTOMER CONFIRMATION + TRACKING FINAL v1 : `?lang=` n'est pas
  // encore émis par `payment-checkout-runtime.ts` lors de la
  // construction de `url_retour_ok` (hors périmètre SQL/paiement de ce
  // lot -- voir le rapport livré) -- repli français inchangé jusqu'à
  // ce qu'un futur lot fasse circuler la langue jusqu'ici. Le
  // mécanisme lui-même est prêt et réutilise `resolveLangFromParam`,
  // SEULE autorité (lib/i18n.ts), pour rester immédiatement actif dès
  // que ce paramètre existera.
  const lang = resolveLangFromParam(resolved.lang);
  return <PaymentReturnStatusView status={status} lang={lang} />;
}
