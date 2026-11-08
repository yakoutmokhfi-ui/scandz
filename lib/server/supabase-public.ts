import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PaymentServerConfigError } from "@/lib/server/payment-errors";

let cachedClient: SupabaseClient | null = null;

/** Lecture publique côté serveur : clé anon, aucune session utilisateur,
 * aucun cookie ni jeton de paiement transmis. Les règles RLS restent actives. */
export function getPublicSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url?.trim() || !key?.trim()) {
    throw new PaymentServerConfigError("Public Supabase configuration is unavailable");
  }
  cachedClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cachedClient;
}
