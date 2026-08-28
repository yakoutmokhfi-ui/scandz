import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PaymentServerConfigError } from "@/lib/server/payment-errors";

/**
 * PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
 *
 * Premier client Supabase `service_role` du projet. Distinct et
 * séparé de `lib/supabase.ts` (mission §18) : ce module-là reste le
 * client anon/authenticated destiné au navigateur et au code partagé
 * client/serveur ; celui-ci n'est JAMAIS importé par un composant
 * `"use client"`, jamais par le code du panier/checkout/WhatsApp, et
 * jamais par `lib/supabase.ts` lui-même (voir le test structurel
 * v110c-payment-p3a1-structural, qui scanne l'arborescence source pour
 * le confirmer).
 *
 * `import "server-only"` (mission §7) : ce paquet, s'il est jamais
 * atteint par un bundle client, lève à l'assemblage plutôt que de
 * laisser une clé service_role fuiter silencieusement dans le
 * JavaScript envoyé au navigateur. Aucun mécanisme équivalent
 * n'existait déjà dans ce dépôt (confirmé par inspection : ni
 * `server-only` ni un garde maison ne sont présents avant ce lot) ni
 * fourni nativement par Next.js/React en dehors de ce paquet officiel
 * (~0 dépendance, taille triviale) -- son ajout est donc justifié
 * plutôt qu'un garde ad hoc réinventé ici.
 *
 * LAZY PAR CONSTRUCTION (mission §36/§37) : rien n'est lu depuis
 * `process.env`, validé, ni instancié tant que
 * `getServiceRoleSupabaseClient()` n'est pas explicitement appelée.
 * Importer ce module (même transitivement, via
 * `lib/server/payment-service.ts`) ne lit et ne valide donc RIEN au
 * niveau module -- `npm run build` (compilation Next.js, y compris la
 * génération statique) ne peut donc jamais échouer à cause d'une clé
 * absente simplement parce que ce fichier a été importé quelque part.
 * Le client, une fois construit avec succès, est mis en cache dans
 * `cachedClient` pour le reste du cycle de vie du process serveur --
 * un seul appel réseau de configuration Supabase, pas un par requête.
 */

let cachedClient: SupabaseClient | null = null;

function readSupabaseUrl(): string {
  // Réutilise la variable PUBLIQUE existante (mission §5) : l'URL du
  // projet Supabase n'est pas sensible -- elle est déjà expédiée à
  // chaque navigateur via NEXT_PUBLIC_SUPABASE_URL (lib/supabase.ts).
  // Seule la clé service_role exige une variable dédiée, non publique.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new PaymentServerConfigError("NEXT_PUBLIC_SUPABASE_URL is not configured");
  }
  return url;
}

function readServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.trim().length === 0) {
    // JAMAIS la valeur, jamais une longueur, jamais un fragment
    // (mission §8/§9) -- uniquement le NOM de la variable manquante.
    throw new PaymentServerConfigError("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
  return key;
}

/**
 * Renvoie un client Supabase authentifié `service_role`, réservé au
 * code serveur de confiance. N'expose jamais la clé elle-même : seule
 * une capacité fonctionnelle (le client déjà construit) est renvoyée
 * (mission §9).
 *
 * Options d'authentification "server-safe" (mission §24) :
 * `persistSession`/`autoRefreshToken`/`detectSessionInUrl` tous à
 * `false` -- ce client n'a et ne doit jamais avoir de notion de
 * session navigateur ; chaque appel est authentifié uniquement par la
 * clé service_role elle-même, jamais par un cookie/localStorage.
 */
export function getServiceRoleSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = readSupabaseUrl();
  const key = readServiceRoleKey();

  cachedClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return cachedClient;
}
