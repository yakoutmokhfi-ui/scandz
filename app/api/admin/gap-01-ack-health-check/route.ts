import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import { readSmtpConfig, realSmtpTransport } from "@/lib/server/ack-mailer";

/**
 * SCANYM — GAP-01 — test de connectivité SMTP RÉEL, opérateur
 * uniquement.
 *
 * N'ENVOIE JAMAIS de message (AUTH LOGIN seulement, jamais MAIL
 * FROM/DATA) -- "aucun envoi réel sans audit + GO CIO explicite".
 * Écrit le résultat RÉEL (succès ou échec, jamais un `true` de
 * confort) dans scanym_ack_transport_health, seule source que lit
 * `_scanym_has_operational_durable_ack_channel()`.
 *
 * AUTORISATION : même patron que les pages /admin (mission
 * app/admin/establishments/catalogue-reset/page.tsx) -- contrôle
 * d'APPLICATION côté page (masquer/rediriger, non implémenté ici, ce
 * fichier est la route appelée PAR cette page), et contrôle RÉEL
 * ici : le jeton d'accès Supabase transmis par le navigateur (jamais
 * un cookie de session serveur, ce projet n'en a pas) authentifie un
 * client Supabase `authenticated`, dont on appelle `is_scanym_
 * operator()` -- exactement la même fonction que celle que la RPC
 * SECURITY DEFINER revérifierait côté SQL. Un appelant non-opérateur,
 * ou sans jeton valide, n'obtient jamais l'exécution du test.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, code: string) {
  return NextResponse.json({ ok: false, code }, { status });
}

async function isRequestFromOperator(request: NextRequest): Promise<string | null> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!token) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  const { data: isOperator, error: opErr } = await asCaller.rpc("is_scanym_operator");
  if (opErr || isOperator !== true) return null;

  return userData.user.id;
}

export async function POST(request: NextRequest) {
  const operatorUserId = await isRequestFromOperator(request);
  if (!operatorUserId) {
    return jsonError(403, "GAP01_HEALTH_CHECK_NOT_OPERATOR");
  }

  const config = readSmtpConfig();
  const serviceClient = getServiceRoleSupabaseClient();

  if (!config) {
    await serviceClient.rpc("record_ack_transport_health_check", {
      p_configured: false,
      p_ok: false,
      p_error: "SMTP_CONFIG_MISSING",
      p_checked_by: operatorUserId,
    });
    return NextResponse.json({ ok: true, configured: false, checkOk: false, error: "SMTP_CONFIG_MISSING" });
  }

  const result = await realSmtpTransport.checkConnectivity(config);

  await serviceClient.rpc("record_ack_transport_health_check", {
    p_configured: true,
    p_ok: result.ok,
    p_error: result.ok ? null : result.error,
    p_checked_by: operatorUserId,
  });

  return NextResponse.json({
    ok: true,
    configured: true,
    checkOk: result.ok,
    error: result.ok ? null : result.error,
  });
}
