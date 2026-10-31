import { NextRequest, NextResponse } from "next/server";
import { getAsUserSupabaseClient } from "@/lib/server/supabase-as-user";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import {
  decryptMerchantSmtpPassword,
  encryptMerchantSmtpPassword,
  validateMerchantSmtpConfig,
} from "@/lib/server/merchant-email-provider";
import { realSmtpTransport } from "@/lib/server/ack-mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(status: number, code: string, details: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: status < 400, code, ...details }, { status });
}

async function authorize(request: NextRequest, restaurantId: string) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !/^[0-9a-f-]{36}$/i.test(restaurantId)) return null;
  let client;
  try {
    client = getAsUserSupabaseClient(token);
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
    admin.from("merchant_email_provider_config")
      .select("host,port,username,enabled,secret_ciphertext")
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
    profile: profile ?? null,
  });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return response(400, "INVALID_JSON"); }
  const restaurantId = typeof body.restaurantId === "string" ? body.restaurantId : "";
  const auth = await authorize(request, restaurantId);
  if (!auth) return response(403, "EMAIL_PROVIDER_FORBIDDEN");

  const admin = getServiceRoleSupabaseClient();
  if (body.action === "test") {
    const { data, error } = await admin.from("merchant_email_provider_config")
      .select("host,port,username,secret_ciphertext,secret_iv,secret_auth_tag,enabled")
      .eq("restaurant_id", restaurantId).maybeSingle();
    // Allow the merchant to validate credentials before enabling sends.
    // This branch performs AUTH only and never submits a message.
    if (error || !data?.secret_ciphertext) return response(409, "EMAIL_PROVIDER_NOT_CONFIGURED");
    try {
      const password = decryptMerchantSmtpPassword({ ciphertext: data.secret_ciphertext, iv: data.secret_iv, authTag: data.secret_auth_tag });
      const result = await realSmtpTransport.checkConnectivity({
        host: data.host, port: data.port, user: data.username, password, from: data.username,
      });
      return NextResponse.json({ ok: true, checkOk: result.ok, code: result.ok ? "SMTP_CONNECTION_OK" : "SMTP_CONNECTION_FAILED" });
    } catch {
      return response(503, "SMTP_CONNECTION_FAILED");
    }
  }

  if (body.action !== "save") return response(400, "EMAIL_PROVIDER_ACTION_INVALID");
  let valid: ReturnType<typeof validateMerchantSmtpConfig>;
  try {
    valid = validateMerchantSmtpConfig({ host: body.host, port: body.port, username: body.username, fromEmail: body.senderEmail });
  } catch (error) {
    return response(400, error instanceof Error ? error.message : "EMAIL_PROVIDER_INVALID");
  }

  const enabled = body.enabled === true;
  const { data: previous, error: previousError } = await admin.from("merchant_email_provider_config")
    .select("secret_ciphertext,secret_iv,secret_auth_tag")
    .eq("restaurant_id", restaurantId).maybeSingle();
  if (previousError) return response(503, "EMAIL_PROVIDER_LOAD_FAILED");

  let secret = previous?.secret_ciphertext
    ? { ciphertext: previous.secret_ciphertext, iv: previous.secret_iv, authTag: previous.secret_auth_tag }
    : null;
  if (typeof body.password === "string" && body.password.length > 0) {
    try { secret = encryptMerchantSmtpPassword(body.password); }
    catch { return response(503, "EMAIL_SECRET_ENCRYPTION_UNAVAILABLE"); }
  }
  if (enabled && !secret) return response(400, "SMTP_PASSWORD_REQUIRED");

  const profileInput = {
    p_restaurant_id: restaurantId,
    p_email_enabled: enabled,
    p_sender_name: typeof body.senderName === "string" ? body.senderName.trim() : "",
    p_sender_email: valid.fromEmail,
    p_reply_to: typeof body.replyTo === "string" ? body.replyTo.trim() || null : null,
    p_default_locale: ["fr", "en", "ar"].includes(String(body.locale)) ? body.locale : "fr",
  };
  // Save the provider disabled first. If either later write fails, the
  // worker remains fail-closed and cannot send with a partial update.
  const { error: stagedError } = await admin.from("merchant_email_provider_config").upsert({
    restaurant_id: restaurantId,
    host: valid.host,
    port: valid.port,
    username: valid.username,
    enabled: false,
    secret_ciphertext: secret?.ciphertext ?? null,
    secret_iv: secret?.iv ?? null,
    secret_auth_tag: secret?.authTag ?? null,
  }, { onConflict: "restaurant_id" });
  if (stagedError) return response(503, "EMAIL_PROVIDER_SAVE_FAILED");

  const { error: profileError } = await auth.client.rpc("set_merchant_notification_profile", profileInput);
  if (profileError) return response(400, "EMAIL_PROFILE_SAVE_FAILED");

  const { error: activateError } = await admin.from("merchant_email_provider_config")
    .update({ enabled }).eq("restaurant_id", restaurantId);
  if (activateError) return response(503, "EMAIL_PROVIDER_SAVE_FAILED");
  return NextResponse.json({ ok: true, code: "EMAIL_PROVIDER_SAVED", configured: true, enabled });
}
