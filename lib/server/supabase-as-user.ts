import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PaymentServerConfigError } from "@/lib/server/payment-errors";

/**
 * BULK PRODUCT PHOTOS v1.4 — CLIENT SUPABASE "AS-USER" (CÔTÉ SERVEUR).
 *
 * Distinct des deux clients déjà existants :
 *   - `lib/supabase.ts`         : anon key, navigateur, session gérée
 *     par le SDK (cookies/localStorage du navigateur) ;
 *   - `lib/server/supabase-admin.ts` : service_role key, aucune notion
 *     d'utilisateur, contourne RLS entièrement.
 * Ce module-ci construit un troisième type de client, nécessaire au
 * flux de remplacement de confiance v1.4 et à lui seul : anon key
 * (PUBLIQUE, aucun nouveau secret) + l'en-tête `Authorization: Bearer
 * <access_token>` du DEMANDEUR HTTP, transmis explicitement, requête
 * par requête. PostgREST résout `auth.uid()`/`current_setting
 * ('request.jwt.claims', true)` à partir de CET en-tête quelle que
 * soit la clé API utilisée pour se connecter — c'est ce mécanisme
 * (documenté et vérifié par lecture du comportement PostgREST/
 * supabase-js, jamais supposé) qui permet à `begin_product_photo_
 * replacement`/`apply_product_photo_replacement` (SECURITY DEFINER,
 * `auth.uid()`-dépendantes via `assert_product_role`) de continuer à
 * authentifier et autoriser correctement l'appelant réel, même
 * lorsque c'est ce module serveur — et non le navigateur — qui émet
 * l'appel RPC.
 *
 * AUCUN nouveau secret : `NEXT_PUBLIC_SUPABASE_URL`/
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` sont déjà publiques (déjà envoyées à
 * chaque navigateur, `lib/supabase.ts`). Le jeton `access_token` n'est
 * JAMAIS un secret serveur : c'est le jeton de session du NAVIGATEUR
 * DE L'APPELANT lui-même, transmis par lui dans l'en-tête HTTP de sa
 * propre requête — jamais lu depuis une variable d'environnement,
 * jamais mis en cache entre requêtes (nouveau client à chaque appel,
 * `persistSession: false` — un client par requête, jamais partagé
 * entre deux utilisateurs).
 *
 * `service_role` reste EXCLUSIVEMENT dans `supabase-admin.ts` — ce
 * fichier ne le lit ni ne l'importe jamais (voir grep exhaustif,
 * `NON-MODIFICATION-PROOF.md`/`TENANT-SECURITY-EVIDENCE.md`).
 */

function readSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new PaymentServerConfigError("NEXT_PUBLIC_SUPABASE_URL is not configured");
  }
  return url;
}

function readAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key || key.trim().length === 0) {
    throw new PaymentServerConfigError("NEXT_PUBLIC_SUPABASE_ANON_KEY is not configured");
  }
  return key;
}

/**
 * Construit un client Supabase scoping "as-user" à partir du jeton
 * d'accès brut porté par la requête entrante de l'appelant (extrait
 * de son propre en-tête `Authorization: Bearer <token>` par la route
 * HTTP appelante — jamais deviné, jamais réutilisé d'une requête à
 * l'autre). `persistSession`/`autoRefreshToken`/`detectSessionInUrl`
 * tous à `false` : ce client n'a et ne doit jamais avoir de notion de
 * session propre — l'authentification vient exclusivement de l'en-tête
 * transmis explicitement ci-dessous, jamais d'un état interne au SDK.
 */
export function getAsUserSupabaseClient(accessToken: string): SupabaseClient {
  const url = readSupabaseUrl();
  const anonKey = readAnonKey();

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

/**
 * Indirection MINIMALE, testabilité uniquement : un export de FONCTION
 * nommée ne peut pas être intercepté par `t.mock.method` sur un objet
 * d'espace de nommage ESM (liaison en lecture seule -- vérifié
 * empiriquement pour ce dépôt/cette version de Node avant d'introduire
 * ce patron). `getAsUserSupabaseClient` construit un client NEUF à
 * CHAQUE appel (jamais un singleton, contrairement à
 * getServiceRoleSupabaseClient) -- il n'existe donc aucune instance
 * partagée à récupérer puis mocker comme le fait déjà ce dépôt pour
 * `supabase`/`getServiceRoleSupabaseClient()` (voir tests/v112-
 * payment-p3b0-service.test.ts). Un objet littéral EXPOSE une méthode
 * mockable de la même façon (vérifié empiriquement) -- c'est
 * l'unique rôle de cet objet, jamais une AUTRE logique. Consommé
 * exclusivement par lib/server/product-photo-service.ts.
 */
export const asUserSupabaseClientFactory = {
  create: getAsUserSupabaseClient,
};
