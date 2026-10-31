import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// MERCHANT SMTP v1 R1 -- ROUTE DASHBOARD /api/dashboard/email-provider.
// Rejoue les constats de l'audit PR #196 contre le code corrigé :
//   A196-01 (P1) un gérant ne peut plus rediriger le mot de passe du propriétaire ;
//   A196-06 (P3) enregistrement non atomique : validation avant écriture + restauration ;
//   A196-09 (P3) test de connexion limité (1 / 30 s / établissement) ;
//   + isolation tenant, aucune fuite de secret ou de texte serveur.
// Aucun mock de module : `asUserSupabaseClientFactory.create` et le singleton
// service_role sont mockés par instance (patron du dépôt) ; le transport SMTP est
// mocké sur l'objet exporté `realSmtpTransport`. Données synthétiques, aucun réseau.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "r1-synthetic-service-role-key-DO-NOT-USE";
process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const { NextRequest } = await import("next/server");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const { asUserSupabaseClientFactory } = await import("../lib/server/supabase-as-user.ts");
const { realSmtpTransport } = await import("../lib/server/ack-mailer.ts");
const { decryptMerchantSmtpPassword } = await import("../lib/server/merchant-email-provider.ts");
const route = await import("../app/api/dashboard/email-provider/route.ts");
const admin = getServiceRoleSupabaseClient();

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const TOKENS: Record<string, Record<string, string>> = {
  "tok-owner-r1": { [R1]: "owner" },
  "tok-manager-r1": { [R1]: "manager" },
  "tok-staff-r1": { [R1]: "staff" },
  "tok-owner-r2": { [R2]: "owner" },
};
const OWNER_PASSWORD = "OWNER-MAILBOX-PASSWORD-Zq7!";

type Row = Record<string, unknown>;

interface World {
  vault: Map<string, Row>;
  profile: Map<string, Row>;
  adminWrites: string[];
  /** Appelé juste avant chaque UPDATE conditionnel du coffre (simule une modification concurrente). */
  beforeConditionalUpdate: (() => void) | null;
  failProfileRpc: boolean;
  failUpsertAtCall: number | null;
  upsertCalls: number;
  transportCalls: Array<Record<string, unknown>>;
  transportResult: Record<string, unknown>;
}

function install(t: { mock: { method: (obj: object, name: string, impl: (...args: never[]) => unknown) => unknown } }): World {
  const world: World = {
    vault: new Map(), profile: new Map(), adminWrites: [], beforeConditionalUpdate: null,
    failProfileRpc: false, failUpsertAtCall: null, upsertCalls: 0, transportCalls: [], transportResult: { ok: true },
  };

  const matches = (row: Row, filters: Array<[string, unknown]>, orClause: string | null) => {
    if (!filters.every(([c, v]) => row[c] === v)) return false;
    if (!orClause) return true;
    return orClause.split(",").some((part) => {
      if (part === "last_test_at.is.null") return row.last_test_at == null;
      const m = /^last_test_at\.lt\.(.+)$/.exec(part);
      return Boolean(m && row.last_test_at != null && String(row.last_test_at) < m[1]!);
    });
  };

  t.mock.method(admin, "from", ((table: string) => {
    assert.equal(table, "merchant_email_provider_config", "table inattendue");
    return {
      select: () => ({
        eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: world.vault.get(id) ? { ...world.vault.get(id) } : null, error: null }) }),
      }),
      upsert: async (row: Row) => {
        world.upsertCalls += 1;
        world.adminWrites.push("upsert");
        if (world.failUpsertAtCall === world.upsertCalls) return { error: new Error("upsert failed") };
        const id = String(row.restaurant_id);
        world.vault.set(id, { ...(world.vault.get(id) ?? {}), ...row });
        return { error: null };
      },
      update(patch: Row) {
        const filters: Array<[string, unknown]> = [];
        let orClause: string | null = null;
        const run = () => {
          world.adminWrites.push("update");
          if (world.beforeConditionalUpdate) { const hook = world.beforeConditionalUpdate; world.beforeConditionalUpdate = null; hook(); }
          const hit = [...world.vault.values()].filter((row) => matches(row, filters, orClause));
          for (const row of hit) Object.assign(row, patch);
          return hit;
        };
        const builder = {
          eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
          or(clause: string) { orClause = clause; return builder; },
          select: async () => ({ data: run().map((row) => ({ restaurant_id: row.restaurant_id })), error: null }),
          then(resolve: (value: { error: null }) => void) { run(); resolve({ error: null }); },
        };
        return builder;
      },
    };
  }) as never);

  t.mock.method(asUserSupabaseClientFactory, "create", ((token: string) => ({
    auth: { getUser: async () => (TOKENS[token] ? { data: { user: { id: token } }, error: null } : { data: { user: null }, error: new Error("bad token") }) },
    rpc: async (name: string, args: Row) => {
      const role = TOKENS[token]?.[String(args.p_restaurant_id)];
      if (name === "has_role_in") return { data: Boolean(role && (args.p_roles as string[]).includes(role)), error: null };
      if (name === "set_merchant_notification_profile") {
        if (!role || world.failProfileRpc) return { data: null, error: new Error("rpc refused") };
        world.profile.set(String(args.p_restaurant_id), {
          email_enabled: args.p_email_enabled, sender_name: args.p_sender_name, sender_email: args.p_sender_email,
          reply_to: args.p_reply_to, default_locale: args.p_default_locale,
        });
        return { data: null, error: null };
      }
      throw new Error(`rpc inattendue ${name}`);
    },
    from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: world.profile.get(id) ?? null, error: null }) }) }) }),
  })) as never);

  t.mock.method(realSmtpTransport, "checkConnectivity", (async (config: Record<string, unknown>) => {
    world.transportCalls.push({ ...config });
    return world.transportResult;
  }) as never);
  return world;
}

const post = (token: string, body: unknown) => route.POST(new NextRequest("http://localhost/api/dashboard/email-provider", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
}));
const get = (token: string, r: string) => route.GET(new NextRequest(`http://localhost/api/dashboard/email-provider?r=${r}`, { headers: { authorization: `Bearer ${token}` } }));

const SAVE = {
  action: "save", restaurantId: R1, enabled: true, host: "smtp.ionos.fr", port: 465, username: "contact@resto.fr",
  password: OWNER_PASSWORD, senderName: "Resto", senderEmail: "contact@resto.fr", replyTo: "", locale: "fr",
};

// --------------------------------------------------------------------
// Isolation et non-fuite
// --------------------------------------------------------------------
test("isolation tenant et rôles : propriétaire d'un autre restaurant, personnel et jeton inconnu => 403, aucune écriture", async (t) => {
  const w = install(t);
  for (const token of ["tok-owner-r2", "tok-staff-r1", "tok-inconnu"]) {
    assert.equal((await get(token, R1)).status, 403, token);
    assert.equal((await post(token, SAVE)).status, 403, token);
    assert.equal((await post(token, { action: "test", restaurantId: R1 })).status, 403, token);
  }
  assert.equal(w.vault.size, 0);
  assert.equal(w.profile.size, 0);
  assert.equal(w.transportCalls.length, 0);
});

test("GET : ni mot de passe, ni chiffré, ni IV, ni tag ; état d'erreur normalisé exposé", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  w.vault.get(R1)!.last_error_class = "PROVIDER_AUTHENTICATION_FAILED";
  w.vault.get(R1)!.last_error_at = "2026-10-31T10:00:00.000Z";
  const res = await get("tok-owner-r1", R1);
  const body = await res.json();
  const text = JSON.stringify(body);
  for (const needle of [OWNER_PASSWORD, "secret_ciphertext", "secret_iv", "secret_auth_tag", String(w.vault.get(R1)!.secret_ciphertext), String(w.vault.get(R1)!.secret_iv)]) {
    assert.equal(text.includes(needle), false, `fuite : ${needle}`);
  }
  assert.equal(body.configured, true);
  assert.deepEqual(body.lastError, { errorClass: "PROVIDER_AUTHENTICATION_FAILED", at: "2026-10-31T10:00:00.000Z" });
});

test("le mot de passe est chiffré au repos, lié au restaurant, et jamais stocké en clair", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  const row = w.vault.get(R1)!;
  assert.equal(JSON.stringify(row).includes(OWNER_PASSWORD), false);
  const secret = { ciphertext: String(row.secret_ciphertext), iv: String(row.secret_iv), authTag: String(row.secret_auth_tag) };
  assert.equal(decryptMerchantSmtpPassword(secret, R1), OWNER_PASSWORD);
  assert.throws(() => decryptMerchantSmtpPassword(secret, R2));
  assert.equal(row.enabled, true);
});

// --------------------------------------------------------------------
// A196-01 (P1)
// --------------------------------------------------------------------
test("A196-01 : un GÉRANT qui change l'hôte sans ressaisir le mot de passe est refusé (400 SMTP_PASSWORD_REQUIRED), coffre inchangé", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  const before = JSON.stringify(w.vault.get(R1));
  const redirect = await post("tok-manager-r1", { ...SAVE, host: "attacker.example.com", password: "", enabled: false });
  assert.equal(redirect.status, 400);
  assert.equal((await redirect.json()).code, "SMTP_PASSWORD_REQUIRED");
  assert.equal(JSON.stringify(w.vault.get(R1)), before, "le coffre ne doit pas avoir bougé");
});

test("A196-01 : changer l'IDENTIFIANT sans ressaisir le mot de passe est refusé de la même façon", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  const before = JSON.stringify(w.vault.get(R1));
  const res = await post("tok-manager-r1", { ...SAVE, username: "boite-du-proprietaire@resto.fr", password: undefined, enabled: false });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "SMTP_PASSWORD_REQUIRED");
  assert.equal(JSON.stringify(w.vault.get(R1)), before);
});

test("A196-01 : le test de connexion ne présente JAMAIS le mot de passe du propriétaire à un hôte choisi par le gérant", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  await post("tok-manager-r1", { ...SAVE, host: "attacker.example.com", password: "", enabled: false }); // refusé
  const res = await post("tok-manager-r1", { action: "test", restaurantId: R1 });
  assert.equal(res.status, 200);
  assert.equal(w.transportCalls.length, 1);
  assert.equal(w.transportCalls[0]!.host, "smtp.ionos.fr", "l'hôte du coffre est resté celui du propriétaire");
  for (const call of w.transportCalls) assert.notEqual(call.host, "attacker.example.com");
});

test("A196-01 : changer l'hôte AVEC un nouveau mot de passe est accepté (le secret suit la cible)", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  const res = await post("tok-manager-r1", { ...SAVE, host: "smtp.autre-hote.fr", username: "autre@resto.fr", senderEmail: "autre@resto.fr", password: "NOUVEAU-MOT-DE-PASSE", enabled: true });
  assert.equal(res.status, 200);
  const row = w.vault.get(R1)!;
  assert.equal(row.host, "smtp.autre-hote.fr");
  const secret = { ciphertext: String(row.secret_ciphertext), iv: String(row.secret_iv), authTag: String(row.secret_auth_tag) };
  assert.equal(decryptMerchantSmtpPassword(secret, R1), "NOUVEAU-MOT-DE-PASSE");
});

test("A196-01 : même cible, mot de passe vide => le secret est conservé (changement de port/activation/identité seulement)", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  const secretBefore = w.vault.get(R1)!.secret_ciphertext;
  const res = await post("tok-manager-r1", { ...SAVE, password: "", enabled: false, senderName: "Resto (modifié)" });
  assert.equal(res.status, 200);
  assert.equal(w.vault.get(R1)!.secret_ciphertext, secretBefore);
  assert.equal(w.vault.get(R1)!.enabled, false);
  assert.equal(w.profile.get(R1)!.sender_name, "Resto (modifié)");
});

test("A196-01 : modification concurrente de la cible entre lecture et écriture => 409, le secret n'est pas réaffecté", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  // Entre la lecture du coffre et l'UPDATE conditionnel, le propriétaire change d'hôte.
  w.beforeConditionalUpdate = () => { w.vault.get(R1)!.host = "smtp.nouveau-du-proprietaire.fr"; };
  const res = await post("tok-manager-r1", { ...SAVE, password: "", enabled: true });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "EMAIL_PROVIDER_CONFLICT");
  assert.equal(w.vault.get(R1)!.host, "smtp.nouveau-du-proprietaire.fr");
});

test("activation sans aucun secret enregistré ni saisi => 400 SMTP_PASSWORD_REQUIRED", async (t) => {
  const w = install(t);
  const res = await post("tok-owner-r1", { ...SAVE, password: "" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "SMTP_PASSWORD_REQUIRED");
  assert.equal(w.vault.size, 0);
});

// --------------------------------------------------------------------
// A196-06 (P3)
// --------------------------------------------------------------------
test("A196-06 : identité d'expéditeur invalide (nom vide, activé) => 400 AVANT toute écriture du coffre", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  const before = JSON.stringify([...w.vault.entries()]);
  w.adminWrites.length = 0;
  const res = await post("tok-owner-r1", { ...SAVE, host: "smtp.autre-hote.fr", username: "autre@resto.fr", password: "NOUVEAU", senderName: "", enabled: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "SMTP_SENDER_NAME_REQUIRED");
  assert.deepEqual(w.adminWrites, [], "aucune écriture du coffre");
  assert.equal(JSON.stringify([...w.vault.entries()]), before);
  assert.equal(w.profile.get(R1)!.email_enabled, true, "profil inchangé");
});

test("A196-06 : mot de passe trop long / non textuel, port 587, hôte IP, adresse invalide => 400 sans écriture", async (t) => {
  const w = install(t);
  for (const patch of [
    { password: "x".repeat(513) }, { password: 12345 }, { port: 587 }, { host: "127.0.0.1" }, { username: "pas-un-mail" }, { senderEmail: "pas-un-mail" },
  ]) {
    const res = await post("tok-owner-r1", { ...SAVE, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
  }
  assert.deepEqual(w.adminWrites, []);
  assert.equal(w.vault.size, 0);
});

test("A196-06 : rejet du RPC profil => l'ANCIENNE configuration fonctionnelle est restaurée à l'identique", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  const before = JSON.stringify(w.vault.get(R1));
  w.failProfileRpc = true;
  const res = await post("tok-owner-r1", { ...SAVE, host: "smtp.autre-hote.fr", username: "autre@resto.fr", password: "NOUVEAU", enabled: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "EMAIL_PROFILE_SAVE_FAILED");
  assert.equal(JSON.stringify(w.vault.get(R1)), before, "coffre restauré (hôte, identifiant, secret, activation)");
  assert.equal(w.vault.get(R1)!.enabled, true);
});

test("A196-06 : première configuration + rejet du RPC => le coffre reste DÉSACTIVÉ (jamais un envoi sans profil)", async (t) => {
  const w = install(t);
  w.failProfileRpc = true;
  const res = await post("tok-owner-r1", SAVE);
  assert.equal(res.status, 400);
  assert.equal(w.vault.get(R1)?.enabled, false);
});

test("A196-06 : restauration impossible (écriture en échec) => 503, jamais un faux succès", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  w.failProfileRpc = true;
  w.upsertCalls = 0;
  w.failUpsertAtCall = 2; // 1 = mise en préparation (nouveau mot de passe), 2 = restauration
  const res = await post("tok-owner-r1", { ...SAVE, host: "smtp.autre-hote.fr", username: "autre@resto.fr", password: "NOUVEAU", enabled: true });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "EMAIL_PROVIDER_SAVE_FAILED");
});

test("A196-06 : l'activation n'intervient qu'APRÈS le profil (ordre fermé : désactivé -> profil -> activé)", async (t) => {
  const w = install(t);
  let enabledWhenProfileWritten: unknown = "non appelé";
  const original = asUserSupabaseClientFactory.create;
  void original;
  // On observe l'état du coffre au moment où le RPC profil est appelé.
  t.mock.method(asUserSupabaseClientFactory, "create", ((token: string) => ({
    auth: { getUser: async () => ({ data: { user: { id: token } }, error: null }) },
    rpc: async (name: string) => {
      if (name === "has_role_in") return { data: true, error: null };
      enabledWhenProfileWritten = w.vault.get(R1)?.enabled;
      return { data: null, error: null };
    },
    from: () => ({}),
  })) as never);
  const res = await post("tok-owner-r1", SAVE);
  assert.equal(res.status, 200);
  assert.equal(enabledWhenProfileWritten, false, "le coffre est désactivé pendant l'écriture du profil");
  assert.equal(w.vault.get(R1)!.enabled, true, "puis activé");
});

// --------------------------------------------------------------------
// A196-09 (P3) + test de connexion
// --------------------------------------------------------------------
test("A196-09 : deux tests de connexion rapprochés => le second est refusé (429), un seul appel sortant", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  const first = await post("tok-owner-r1", { action: "test", restaurantId: R1 });
  assert.equal(first.status, 200);
  const second = await post("tok-manager-r1", { action: "test", restaurantId: R1 });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).code, "EMAIL_PROVIDER_TEST_RATE_LIMITED");
  assert.equal(w.transportCalls.length, 1);
});

test("A196-09 : après l'intervalle, un nouveau test est autorisé ; la limite est PAR établissement", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  assert.equal((await post("tok-owner-r1", { action: "test", restaurantId: R1 })).status, 200);
  // Recule la dernière réservation de 31 s.
  w.vault.get(R1)!.last_test_at = new Date(Date.now() - 31_000).toISOString();
  assert.equal((await post("tok-owner-r1", { action: "test", restaurantId: R1 })).status, 200);
  assert.equal(w.transportCalls.length, 2);
  // Autre établissement : sa propre fenêtre.
  w.vault.set(R2, { ...w.vault.get(R1)!, restaurant_id: R2, last_test_at: null });
  const r2Secret = w.vault.get(R2)!;
  void r2Secret; // le chiffré est lié à R1 : le test R2 échoue au déchiffrement mais consomme SA réservation
  const res = await post("tok-owner-r2", { action: "test", restaurantId: R2 });
  assert.notEqual(res.status, 429);
});

test("A196-09 : 20 tests simultanés => une seule connexion sortante (réservation atomique)", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  const results = await Promise.all(Array.from({ length: 20 }, () => post("tok-owner-r1", { action: "test", restaurantId: R1 })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 429).length, 19);
  assert.equal(w.transportCalls.length, 1);
});

test("test de connexion : échec => classe normalisée seulement (jamais le texte du serveur), état d'erreur enregistré ; succès l'efface", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  w.transportResult = { ok: false, error: "SMTP_UNEXPECTED_RESPONSE: attendu 235, reçu: 535 5.7.8 Authentication credentials invalid for user contact@resto.fr", stage: "auth", status: 535 };
  const failed = await post("tok-owner-r1", { action: "test", restaurantId: R1 });
  const failedBody = await failed.json();
  assert.equal(failed.status, 200);
  assert.deepEqual({ checkOk: failedBody.checkOk, code: failedBody.code, reason: failedBody.reason }, { checkOk: false, code: "SMTP_CONNECTION_FAILED", reason: "PROVIDER_AUTHENTICATION_FAILED" });
  assert.equal(JSON.stringify(failedBody).includes("535 5.7.8"), false);
  assert.equal(JSON.stringify(failedBody).includes("contact@resto.fr"), false);
  assert.equal(w.vault.get(R1)!.last_error_class, "PROVIDER_AUTHENTICATION_FAILED");

  w.vault.get(R1)!.last_test_at = new Date(Date.now() - 60_000).toISOString();
  w.transportResult = { ok: true };
  const ok = await post("tok-owner-r1", { action: "test", restaurantId: R1 });
  assert.deepEqual({ checkOk: (await ok.json()).checkOk }, { checkOk: true });
  assert.equal(w.vault.get(R1)!.last_error_class, null);
});

test("test de connexion sans configuration => 409, aucune réservation consommée, aucun appel sortant", async (t) => {
  const w = install(t);
  const res = await post("tok-owner-r1", { action: "test", restaurantId: R1 });
  assert.equal(res.status, 409);
  assert.equal(w.transportCalls.length, 0);
});

test("test de connexion : le chiffré d'un autre établissement ne se déchiffre pas => aucun appel sortant, classe de configuration", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  // Copie malveillante/accidentelle du coffre de R1 vers R2.
  w.vault.set(R2, { ...w.vault.get(R1)!, restaurant_id: R2, last_test_at: null });
  const res = await post("tok-owner-r2", { action: "test", restaurantId: R2 });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, "PROVIDER_CONFIGURATION_ERROR");
  assert.equal(w.transportCalls.length, 0);
});
