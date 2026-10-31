import { NextRequest, NextResponse } from "next/server";
import { asUserSupabaseClientFactory } from "@/lib/server/supabase-as-user";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  decryptMerchantSmtpPassword,
  encryptMerchantSmtpPassword,
  validateMerchantSenderProfile,
  validateMerchantSmtpConfig,
  validateMerchantSmtpPassword,
} from "@/lib/server/merchant-email-provider";
import { realSmtpTransport } from "@/lib/server/ack-mailer";
import { classifySmtpFailure } from "@/lib/server/notifications/smtp-failure-classification";
import { recordMerchantSmtpVaultState } from "@/lib/server/notifications/merchant-smtp-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "merchant_email_provider_config";
/** Intervalle minimal entre deux tests de connexion d'un même établissement (A196-09). */
const TEST_MIN_INTERVAL_MS = 30_000;

type VaultRow = {
  host: string;
  port: number;
  username: string;
  enabled: boolean;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_auth_tag: string | null;
  last_error_class: string | null;
  last_error_at: string | null;
};

function response(status: number, code: string, details: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: status < 400, code, ...details }, { status });
}

async function authorize(request: NextRequest, restaurantId: string) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !/^[0-9a-f-]{36}$/i.test(restaurantId)) return null;
  let client;
  try {
    client = asUserSupabaseClientFactory.create(token);
  } catch {
    return null;
  }
  const { data: user, error: userError } = await client.auth.getUser(token);
  if (userError || !user.user) return null;
  const { data: allowed, error } = await client.rpc("has_role_in", {
    p_restaurant_id: restaurantId,
    p_roles: ["owner", "manager"],
  });
  if (error || allowed !== true) return null;
  return { client, restaurantId };
}

export async function GET(request: NextRequest) {
  const restaurantId = request.nextUrl.searchParams.get("r") ?? "";
  const auth = await authorize(request, restaurantId);
  if (!auth) return response(403, "EMAIL_PROVIDER_FORBIDDEN");

  const admin = getServiceRoleSupabaseClient();
  const [{ data: provider, error: providerError }, { data: profile, error: profileError }] = await Promise.all([
    admin.from(TABLE)
      .select("host,port,username,enabled,secret_ciphertext,last_error_class,last_error_at")
      .eq("restaurant_id", restaurantId).maybeSingle(),
    auth.client.from("merchant_notification_profile")
      .select("email_enabled,sender_name,sender_email,reply_to,default_locale")
      .eq("restaurant_id", restaurantId).maybeSingle(),
  ]);
  if (providerError || profileError) return response(503, "EMAIL_PROVIDER_LOAD_FAILED");
  return NextResponse.json({
    ok: true,
    configured: Boolean(provider?.secret_ciphertext),
    provider: provider ? {
      host: provider.host,
      port: provider.port,
      username: provider.username,
      enabled: provider.enabled,
    } : null,
    // Classe normalisée uniquement (jamais un message du serveur SMTP).
    lastError: provider?.last_error_class ? { errorClass: provider.last_error_class, at: provider.last_error_at } : null,
    profile: profile ?? null,
  });
}

async function runConnectionTest(restaurantId: string) {
  const admin = getServiceRoleSupabaseClient();
  const { data, error } = await admin.from(TABLE)
    .select("host,port,username,secret_ciphertext,secret_iv,secret_auth_tag,enabled")
    .eq("restaurant_id", restaurantId).maybeSingle();
  // Allow the merchant to validate credentials before enabling sends.
  // This branch performs AUTH only and never submits a message.
  if (error || !data?.secret_ciphertext || !data.secret_iv || !data.secret_auth_tag) {
    return response(409, "EMAIL_PROVIDER_NOT_CONFIGURED");
  }

  // Un test à la fois par établissement et par fenêtre (A196-09) : réservation
  // atomique côté base, avant toute connexion sortante.
  const now = new Date();
  const cutoff = new Date(now.getTime() - TEST_MIN_INTERVAL_MS).toISOString();
  const { data: slot, error: slotError } = await admin.from(TABLE)
    .update({ last_test_at: now.toISOString() })
    .eq("restaurant_id", restaurantId)
    .or(`last_test_at.is.null,last_test_at.lt.${cutoff}`)
    .select("restaurant_id");
  if (slotError) return response(503, "EMAIL_PROVIDER_LOAD_FAILED");
  if (!slot || slot.length === 0) return response(429, "EMAIL_PROVIDER_TEST_RATE_LIMITED");

  const used = { host: data.host as string, username: data.username as string, secret_ciphertext: data.secret_ciphertext as string };
  let password: string;
  try {
    password = decryptMerchantSmtpPassword(
      { ciphertext: data.secret_ciphertext, iv: data.secret_iv, authTag: data.secret_auth_tag },
      restaurantId
    );
  } catch {
    await recordMerchantSmtpVaultState(admin, restaurantId, used, "PROVIDER_CONFIGURATION_ERROR", false, now);
    return response(503, "SMTP_CONNECTION_FAILED", { reason: "PROVIDER_CONFIGURATION_ERROR" });
  }

  const result = await realSmtpTransport.checkConnectivity({
    host: data.host, port: data.port, user: data.username, password, from: data.username,
  });
  if (result.ok) {
    await recordMerchantSmtpVaultState(admin, restaurantId, used, null, false, now);
    return NextResponse.json({ ok: true, checkOk: true, code: "SMTP_CONNECTION_OK" });
  }
  // Classe normalisée uniquement : jamais le texte renvoyé par le serveur SMTP.
  const verdict = classifySmtpFailure(result);
  await recordMerchantSmtpVaultState(admin, restaurantId, used, verdict.errorClass, false, now);
  return NextResponse.json({ ok: true, checkOk: false, code: "SMTP_CONNECTION_FAILED", reason: verdict.errorClass });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return response(400, "INVALID_JSON"); }
  const restaurantId = typeof body.restaurantId === "string" ? body.restaurantId : "";
  const auth = await authorize(request, restaurantId);
  if (!auth) return response(403, "EMAIL_PROVIDER_FORBIDDEN");

  if (body.action === "test") return runConnectionTest(restaurantId);
  if (body.action !== "save") return response(400, "EMAIL_PROVIDER_ACTION_INVALID");

  // 1. Tout valider AVANT la moindre écriture (A196-06).
  const enabled = body.enabled === true;
  let valid: ReturnType<typeof validateMerchantSmtpConfig>;
  let newPassword: string | null;
  let sender: ReturnType<typeof validateMerchantSenderProfile>;
  try {
    valid = validateMerchantSmtpConfig({ host: body.host, port: body.port, username: body.username, fromEmail: body.senderEmail });
    newPassword = validateMerchantSmtpPassword(body.password);
    sender = validateMerchantSenderProfile({ senderName: body.senderName, senderEmail: body.senderEmail, replyTo: body.replyTo, enabled });
  } catch (error) {
    return response(400, error instanceof Error ? error.message : "EMAIL_PROVIDER_INVALID");
  }

  const admin = getServiceRoleSupabaseClient();
  const { data: previousData, error: previousError } = await admin.from(TABLE)
    .select("host,port,username,enabled,secret_ciphertext,secret_iv,secret_auth_tag,last_error_class,last_error_at")
    .eq("restaurant_id", restaurantId).maybeSingle();
  if (previousError) return response(503, "EMAIL_PROVIDER_LOAD_FAILED");
  const previous = previousData as VaultRow | null;
  const hadSecret = Boolean(previous?.secret_ciphertext);

  // 2. Un secret déjà enregistré n'est réutilisable QUE pour la même cible (A196-01) :
  //    changer l'hôte ou l'identifiant exige de ressaisir le mot de passe, sinon un
  //    rôle autorisé à modifier la cible pourrait y faire présenter le mot de passe d'un autre.
  const targetChanged = previous !== null && (previous.host !== valid.host || previous.username !== valid.username);
  if (hadSecret && newPassword === null && targetChanged) return response(400, "SMTP_PASSWORD_REQUIRED");

  let secret: { ciphertext: string; iv: string; authTag: string } | null = hadSecret && newPassword === null
    ? { ciphertext: previous!.secret_ciphertext!, iv: previous!.secret_iv!, authTag: previous!.secret_auth_tag! }
    : null;
  if (newPassword !== null) {
    try { secret = encryptMerchantSmtpPassword(newPassword, restaurantId); }
    catch { return response(503, "EMAIL_SECRET_ENCRYPTION_UNAVAILABLE"); }
  }
  if (enabled && !secret) return response(400, "SMTP_PASSWORD_REQUIRED");

  const profileInput = {
    p_restaurant_id: restaurantId,
    p_email_enabled: enabled,
    p_sender_name: sender.senderName,
    p_sender_email: sender.senderEmail,
    p_reply_to: sender.replyTo,
    p_default_locale: ["fr", "en", "ar"].includes(String(body.locale)) ? body.locale : "fr",
  };

  // 3. Écriture par étapes, toujours FERMÉE : le coffre est d'abord enregistré
  //    désactivé ; l'activation n'intervient qu'après le profil. En cas d'échec
  //    ultérieur, l'état précédent du coffre est RESTAURÉ (A196-06).
  if (previous && hadSecret && newPassword === null) {
    // Même cible, même secret : mise à jour conditionnelle à l'état lu (pas de course).
    const { data: staged, error: stagedError } = await admin.from(TABLE)
      .update({ port: valid.port, enabled: false })
      .eq("restaurant_id", restaurantId)
      .eq("host", previous.host)
      .eq("username", previous.username)
      .eq("secret_ciphertext", previous.secret_ciphertext)
      .select("restaurant_id");
    if (stagedError) return response(503, "EMAIL_PROVIDER_SAVE_FAILED");
    if (!staged || staged.length === 0) return response(409, "EMAIL_PROVIDER_CONFLICT");
  } else {
    const { error: stagedError } = await admin.from(TABLE).upsert({
      restaurant_id: restaurantId,
      host: valid.host,
      port: valid.port,
      username: valid.username,
      enabled: false,
      secret_ciphertext: secret?.ciphertext ?? null,
      secret_iv: secret?.iv ?? null,
      secret_auth_tag: secret?.authTag ?? null,
      // Nouveaux identifiants : l'ancien état d'erreur ne s'applique plus.
      last_error_class: null,
      last_error_at: null,
    }, { onConflict: "restaurant_id" });
    if (stagedError) return response(503, "EMAIL_PROVIDER_SAVE_FAILED");
  }

  const restorePrevious = async (): Promise<boolean> => {
    if (!previous) return true; // première configuration : l'état « désactivé » est déjà fermé
    const { error } = await admin.from(TABLE).upsert({ restaurant_id: restaurantId, ...previous }, { onConflict: "restaurant_id" });
    return !error;
  };

  const { error: profileError } = await auth.client.rpc("set_merchant_notification_profile", profileInput);
  if (profileError) {
    const restored = await restorePrevious();
    return restored ? response(400, "EMAIL_PROFILE_SAVE_FAILED") : response(503, "EMAIL_PROVIDER_SAVE_FAILED");
  }

  const { error: activateError } = await admin.from(TABLE)
    .update({ enabled }).eq("restaurant_id", restaurantId);
  if (activateError) return response(503, "EMAIL_PROVIDER_SAVE_FAILED");
  return NextResponse.json({ ok: true, code: "EMAIL_PROVIDER_SAVED", configured: Boolean(secret), enabled });
}
