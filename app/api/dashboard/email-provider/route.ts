import { randomUUID } from "node:crypto";
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
/**
 * Bail d'enregistrement (R2, défaut 3 du contre-audit de 7cb60a8). Un enregistrement est une suite de
 * trois écritures (coffre désactivé -> profil -> coffre activé). Il prend un bail (jeton + échéance) sur
 * la ligne du coffre ; chacune de ses écritures suivantes (restauration comprise) est CONDITIONNELLE à ce
 * jeton. Un enregistrement concurrent ne peut donc ni s'intercaler, ni être écrasé par la restauration
 * d'un enregistrement qui échoue. Le bail expire seul (jamais de verrou orphelin après un plantage) ;
 * il est très supérieur à la durée normale d'un enregistrement (quelques allers-retours).
 */
const SAVE_LEASE_MS = 60_000;
/** Violation de contrainte d'unicité PostgreSQL : une première configuration concurrente a gagné. */
const UNIQUE_VIOLATION = "23505";
/**
 * R3 (P2, « profil ancien ») : le profil n'est plus écrit par `set_merchant_notification_profile` seul. La
 * fonction SQL ci-dessous verrouille la ligne du coffre (`for update`), vérifie que le jeton est TOUJOURS le nôtre
 * et écrit le profil dans la MÊME transaction : un enregistrement dont le bail a été repris ne peut plus
 * remplacer le profil d'un enregistrement plus récent. Elle lève SAVE_LEASE_LOST_MARKER dans ce cas.
 */
const PROFILE_RPC = "set_merchant_notification_profile_under_save_lease";
const SAVE_LEASE_LOST_MARKER = "SCANYM_SAVE_LEASE_LOST";

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

/**
 * État d'erreur du coffre : champs dont le Cron (suspension, effacement) et le test de connexion sont
 * propriétaires. Toute écriture de l'enregistrement qui pourrait RÉACTIVER le fournisseur est conditionnelle à
 * cet état tel qu'il était à la mise en préparation (R3, P2 « suspension annulée »).
 */
type ErrorState = { errorClass: string | null; errorAt: string | null };
function pinErrorState<Q extends { eq: (column: string, value: string) => Q; is: (column: string, value: null) => Q }>(query: Q, state: ErrorState): Q {
  const byClass = state.errorClass === null ? query.is("last_error_class", null) : query.eq("last_error_class", state.errorClass);
  return state.errorAt === null ? byClass.is("last_error_at", null) : byClass.eq("last_error_at", state.errorAt);
}
function isSaveLeaseLost(error: unknown): boolean {
  return String((error as { message?: unknown } | null)?.message ?? "").includes(SAVE_LEASE_LOST_MARKER);
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

  // 3. Écriture par étapes, toujours FERMÉE : le coffre est d'abord enregistré désactivé, SOUS BAIL ;
  //    l'activation n'intervient qu'après le profil. Toute écriture ultérieure (activation ou
  //    restauration) n'a d'effet que si le bail est toujours le nôtre (R2, défaut 3).
  const now = new Date();
  const lease = { save_token: randomUUID(), save_lease_until: new Date(now.getTime() + SAVE_LEASE_MS).toISOString() };
  const stagedClosed = {
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
  };

  // État d'erreur de la ligne TELLE QUE LA MISE EN PRÉPARATION LA LAISSE (R3) : le même qu'à la lecture si le secret
  // est conservé, effacé si de nouveaux identifiants sont posés. Toute différence ultérieure est une écriture du Cron
  // (suspension) ou d'un test de connexion, qui fait foi.
  const secretKept = hadSecret && newPassword === null;
  const stagedErrorState: ErrorState = secretKept && previous
    ? { errorClass: previous.last_error_class, errorAt: previous.last_error_at }
    : { errorClass: null, errorAt: null };

  if (!previous) {
    // Première configuration : la clé primaire arbitre. Le perdant reçoit 409 ; rien n'est écrasé.
    const { error: insertError } = await admin.from(TABLE).insert({ restaurant_id: restaurantId, ...stagedClosed, ...lease });
    if (insertError) {
      return (insertError as { code?: string }).code === UNIQUE_VIOLATION
        ? response(409, "EMAIL_PROVIDER_CONFLICT")
        : response(503, "EMAIL_PROVIDER_SAVE_FAILED");
    }
  } else {
    // Mise en préparation = acquisition du bail, en UNE écriture atomique conditionnelle : la ligne doit
    // être exactement dans l'état lu (cible, port, activation, secret) ET sans bail valide.
    const patch = secretKept
      ? { port: valid.port, enabled: false, ...lease } // même cible, même secret : seuls port/activation changent
      : { ...stagedClosed, ...lease };
    const unchanged = admin.from(TABLE).update(patch)
      .eq("restaurant_id", restaurantId)
      .eq("host", previous.host)
      .eq("port", previous.port)
      .eq("username", previous.username)
      .eq("enabled", previous.enabled);
    const pinnedSecret = previous.secret_ciphertext === null
      ? unchanged.is("secret_ciphertext", null)
      : unchanged.eq("secret_ciphertext", previous.secret_ciphertext);
    // R3 : l'état d'erreur lu fait partie de l'état attendu (sinon la restauration comparerait à un état déjà périmé).
    const { data: staged, error: stagedError } = await pinErrorState(pinnedSecret, { errorClass: previous.last_error_class, errorAt: previous.last_error_at })
      .or(`save_token.is.null,save_lease_until.lt.${now.toISOString()}`)
      .select("restaurant_id");
    if (stagedError) return response(503, "EMAIL_PROVIDER_SAVE_FAILED");
    if (!staged || staged.length === 0) return response(409, "EMAIL_PROVIDER_CONFLICT");
  }

  /**
   * Restauration conditionnelle au bail ET à l'état d'erreur. Elle n'écrit QUE si la ligne porte encore notre jeton
   * (sinon un autre enregistrement a repris le coffre : son état fait foi) et, pour rétablir l'activation et l'état
   * d'erreur d'origine, que l'état d'erreur n'a pas changé depuis la mise en préparation. S'il a changé, le Cron a
   * suspendu le fournisseur (ou un test de connexion a conclu) PENDANT l'enregistrement : cet événement est plus récent
   * que l'état qu'on voudrait rétablir. On rend alors seulement ce que l'enregistrement possède (cible et secret),
   * on laisse le coffre FERMÉ, on ne touche pas à l'état d'erreur, et on libère le bail (R3, P2 « suspension annulée »).
   *   restored    : état d'origine rétabli (ou première configuration : coffre fermé, bail libéré) ;
   *   kept-closed : le Cron/le test a écrit entre-temps ; fournisseur laissé désactivé, erreur conservée ;
   *   superseded  : le bail n'est plus le nôtre, aucune écriture ;
   *   failed      : l'écriture a échoué (le coffre reste fermé).
   */
  type Restoration = "restored" | "kept-closed" | "superseded" | "failed";
  const restorePrevious = async (): Promise<Restoration> => {
    const release = { save_token: null, save_lease_until: null };
    if (!previous) {
      const { data, error } = await admin.from(TABLE)
        .update({ enabled: false, ...release })
        .eq("restaurant_id", restaurantId)
        .eq("save_token", lease.save_token)
        .select("restaurant_id");
      if (error) return "failed";
      return data && data.length > 0 ? "restored" : "superseded";
    }
    const full = admin.from(TABLE)
      .update({
        host: previous.host, port: previous.port, username: previous.username, enabled: previous.enabled,
        secret_ciphertext: previous.secret_ciphertext, secret_iv: previous.secret_iv, secret_auth_tag: previous.secret_auth_tag,
        last_error_class: previous.last_error_class, last_error_at: previous.last_error_at, ...release,
      })
      .eq("restaurant_id", restaurantId)
      .eq("save_token", lease.save_token);
    const { data: restored, error: restoreError } = await pinErrorState(full, stagedErrorState).select("restaurant_id");
    if (restoreError) return "failed";
    if (restored && restored.length > 0) return "restored";
    const { data: closed, error: closeError } = await admin.from(TABLE)
      .update({
        host: previous.host, port: previous.port, username: previous.username, enabled: false,
        secret_ciphertext: previous.secret_ciphertext, secret_iv: previous.secret_iv, secret_auth_tag: previous.secret_auth_tag, ...release,
      })
      .eq("restaurant_id", restaurantId)
      .eq("save_token", lease.save_token)
      .select("restaurant_id");
    if (closeError) return "failed";
    return closed && closed.length > 0 ? "kept-closed" : "superseded";
  };

  const { error: profileError } = await auth.client.rpc(PROFILE_RPC, { ...profileInput, p_save_token: lease.save_token });
  if (profileError) {
    // Le bail a été repris pendant l'enregistrement : le profil N'A PAS été écrit (même transaction que la
    // vérification du jeton) et l'état de l'enregistrement qui a repris le coffre fait foi -- rien à restaurer.
    if (isSaveLeaseLost(profileError)) return response(409, "EMAIL_PROVIDER_CONFLICT");
    const outcome = await restorePrevious();
    if (outcome === "failed") return response(503, "EMAIL_PROVIDER_SAVE_FAILED");
    return outcome === "kept-closed"
      ? response(400, "EMAIL_PROFILE_SAVE_FAILED", { providerEnabled: false, providerKeptClosed: true })
      : response(400, "EMAIL_PROFILE_SAVE_FAILED");
  }

  // Activation conditionnelle au bail : si un autre enregistrement a repris le coffre entre-temps, on ne touche à rien
  // (409) plutôt que d'activer ou de désactiver SA configuration. Une ACTIVATION l'est aussi à l'état d'erreur de la mise
  // en préparation : si le Cron a suspendu le fournisseur (ou un test a échoué) pendant l'enregistrement, on ne le
  // réactive pas -- le marchand voit l'erreur et relance (R3). Désactiver n'a rien à protéger.
  const activation = admin.from(TABLE)
    .update({ enabled, save_token: null, save_lease_until: null })
    .eq("restaurant_id", restaurantId)
    .eq("save_token", lease.save_token);
  const { data: activated, error: activateError } = await (enabled ? pinErrorState(activation, stagedErrorState) : activation).select("restaurant_id");
  if (activateError) return response(503, "EMAIL_PROVIDER_SAVE_FAILED");
  if (!activated || activated.length === 0) {
    // Bail repris (no-op ci-dessous) OU état d'erreur modifié sous notre bail : dans ce second cas la configuration
    // enregistrée reste FERMÉE et le bail est libéré, sans toucher à l'erreur écrite par le Cron/le test.
    await admin.from(TABLE)
      .update({ enabled: false, save_token: null, save_lease_until: null })
      .eq("restaurant_id", restaurantId)
      .eq("save_token", lease.save_token)
      .select("restaurant_id");
    return response(409, "EMAIL_PROVIDER_CONFLICT");
  }
  return NextResponse.json({ ok: true, code: "EMAIL_PROVIDER_SAVED", configured: Boolean(secret), enabled });
}
