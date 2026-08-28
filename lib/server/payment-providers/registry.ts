import "server-only";
import * as monetico from "@/lib/server/payment-providers/monetico/index";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 *
 * Registre GÉNÉRIQUE minimal (mandat §34) : un simple objet associant
 * `provider_code` au module d'adaptateur correspondant, pour que le
 * futur code d'orchestration puisse résoudre `"monetico"` sans
 * connaître le chemin d'import exact. AUCUNE implémentation
 * substitutive (placeholder) n'est ajoutée pour Mercanet/Stripe/tout
 * autre prestataire (mandat §34, explicitement interdit) -- seule la
 * clé `"monetico"` existe, et aucune architecture de plugin n'est
 * construite au-delà de cet unique objet littéral.
 */
export const paymentProviders = {
  monetico,
} as const;

export type PaymentProviderCode = keyof typeof paymentProviders;
