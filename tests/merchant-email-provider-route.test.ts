import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// MERCHANT SMTP v1 R1 -- ROUTE DASHBOARD /api/dashboard/email-provider.
// Rejoue les constats de l'audit PR #196 contre le code corrigé :
//   A196-01 (P1) un gérant ne peut plus rediriger le mot de passe du propriétaire ;
//   A196-06 (P3) enregistrement non atomique : validation avant écriture + restauration ;
//   A196-09 (P3) test de connexion limité (1 / 30 s / établissement) ;
//   + isolation tenant, aucune fuite de secret ou de texte serveur.
// R2 (contre-audit de 7cb60a8, défaut 3) : un enregistrement qui ÉCHOUE ne doit jamais
// écraser un enregistrement concurrent déjà réussi -> bail d'enregistrement + écritures
// conditionnelles au jeton (voir les tests « R2-03 »).
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
  /** Appelé juste avant l'INSERT du coffre (première configuration concurrente). */
  beforeInsert: (() => void) | null;
  /** Exécuté au début du RPC profil : une AUTRE requête qui s'intercale pendant l'enregistrement. */
  duringProfileRpc: (() => Promise<void>) | null;
  failProfileRpc: boolean;
  profileRpcCalls: number;
  failProfileRpcAtCall: number | null;
  /** Compte les écritures du coffre (hors réservation du test de connexion). */
  writeCalls: number;
  failWriteAtCall: number | null;
  upsertCalls: number;
  insertCalls: number;
  transportCalls: Array<Record<string, unknown>>;
  transportResult: Record<string, unknown>;
}

function install(t: { mock: { method: (obj: object, name: string, impl: (...args: never[]) => unknown) => unknown } }): World {
  const world: World = {
    vault: new Map(), profile: new Map(), adminWrites: [], beforeConditionalUpdate: null,
    beforeInsert: null, duringProfileRpc: null,
    failProfileRpc: false, profileRpcCalls: 0, failProfileRpcAtCall: null,
    writeCalls: 0, failWriteAtCall: null, upsertCalls: 0, insertCalls: 0,
    transportCalls: [], transportResult: { ok: true },
  };

  type Filter = [column: string, op: "eq" | "is", value: unknown];
  /** Sous-ensemble PostgREST utilisé par la route : `col.is.null` et `col.lt.<valeur>` séparés par des virgules. */
  const matches = (row: Row, filters: Filter[], orClause: string | null) => {
    for (const [column, op, value] of filters) {
      if (op === "eq" && row[column] !== value) return false;
      if (op === "is" && (row[column] ?? null) !== value) return false;
    }
    if (!orClause) return true;
    return orClause.split(",").some((part) => {
      const isNull = /^([a-z_]+)\.is\.null$/.exec(part);
      if (isNull) return row[isNull[1]!] == null;
      const lessThan = /^([a-z_]+)\.lt\.(.+)$/.exec(part);
      return Boolean(lessThan && row[lessThan[1]!] != null && String(row[lessThan[1]!]) < lessThan[2]!);
    });
  };
  const writeFails = () => world.failWriteAtCall !== null && world.writeCalls === world.failWriteAtCall;

  t.mock.method(admin, "from", ((table: string) => {
    assert.equal(table, "merchant_email_provider_config", "table inattendue");
    return {
      select: () => ({
        eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: world.vault.get(id) ? { ...world.vault.get(id) } : null, error: null }) }),
      }),
      // Conservé pour pouvoir REJOUER l'ancien code (7cb60a8) ; le code corrigé ne doit plus l'appeler.
      upsert: async (row: Row) => {
        world.upsertCalls += 1;
        world.writeCalls += 1;
        world.adminWrites.push("upsert");
        if (writeFails()) return { error: new Error("write failed") };
        const id = String(row.restaurant_id);
        world.vault.set(id, { ...(world.vault.get(id) ?? {}), ...row });
        return { error: null };
      },
      insert: async (row: Row) => {
        world.insertCalls += 1;
        world.writeCalls += 1;
        world.adminWrites.push("insert");
        if (world.beforeInsert) { const hook = world.beforeInsert; world.beforeInsert = null; hook(); }
        if (writeFails()) return { error: new Error("write failed") };
        const id = String(row.restaurant_id);
        if (world.vault.has(id)) {
          return { error: Object.assign(new Error('duplicate key value violates unique constraint "merchant_email_provider_config_pkey"'), { code: "23505" }) };
        }
        world.vault.set(id, { last_error_class: null, last_error_at: null, last_test_at: null, save_token: null, save_lease_until: null, ...row });
        return { error: null };
      },
      update(patch: Row) {
        const filters: Filter[] = [];
        let orClause: string | null = null;
        const isReservation = "last_test_at" in patch;
        const run = (): { hit: Row[]; error: Error | null } => {
          world.adminWrites.push("update");
          if (!isReservation) world.writeCalls += 1;
          if (world.beforeConditionalUpdate) { const hook = world.beforeConditionalUpdate; world.beforeConditionalUpdate = null; hook(); }
          if (!isReservation && writeFails()) return { hit: [], error: new Error("write failed") };
          const hit = [...world.vault.values()].filter((row) => matches(row, filters, orClause));
          for (const row of hit) Object.assign(row, patch);
          return { hit, error: null };
        };
        const builder = {
          eq(column: string, value: unknown) { filters.push([column, "eq", value]); return builder; },
          is(column: string, value: unknown) { filters.push([column, "is", value]); return builder; },
          or(clause: string) { orClause = clause; return builder; },
          select: async () => {
            const { hit, error } = run();
            return error ? { data: null, error } : { data: hit.map((row) => ({ restaurant_id: row.restaurant_id })), error: null };
          },
          then(resolve: (value: { error: Error | null }) => void) { resolve({ error: run().error }); },
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
        world.profileRpcCalls += 1;
        const callNumber = world.profileRpcCalls;
        if (world.duringProfileRpc) { const hook = world.duringProfileRpc; world.duringProfileRpc = null; await hook(); }
        if (!role || world.failProfileRpc || world.failProfileRpcAtCall === callNumber) return { data: null, error: new Error("rpc refused") };
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
  assert.equal(w.vault.get(R1)?.save_token, null, "le bail d'enregistrement est libéré");
});

test("A196-06 : restauration impossible (écriture en échec) => 503, jamais un faux succès", async (t) => {
  const w = install(t);
  await post("tok-owner-r1", SAVE);
  w.failProfileRpc = true;
  w.writeCalls = 0;
  w.failWriteAtCall = 2; // 1 = mise en préparation (nouveau mot de passe), 2 = restauration
  const res = await post("tok-owner-r1", { ...SAVE, host: "smtp.autre-hote.fr", username: "autre@resto.fr", password: "NOUVEAU", enabled: true });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "EMAIL_PROVIDER_SAVE_FAILED");
  assert.equal(w.vault.get(R1)!.enabled, false, "restauration impossible : le coffre reste FERMÉ (désactivé), jamais ouvert sur de nouveaux identifiants");
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
// R2-03 (contre-audit de 7cb60a8, défaut 3) : enregistrements concurrents
// « une sauvegarde qui échoue peut écraser une autre configuration déjà enregistrée avec succès »
// --------------------------------------------------------------------
const configOf = (label: string, extra: Record<string, unknown> = {}) => ({
  ...SAVE, host: `smtp.${label}.fr`, username: `${label}@resto.fr`, senderEmail: `${label}@resto.fr`,
  senderName: `Resto ${label}`, password: `MOT-DE-PASSE-${label.toUpperCase()}`, ...extra,
});
const vaultPassword = (row: Row) =>
  decryptMerchantSmtpPassword({ ciphertext: String(row.secret_ciphertext), iv: String(row.secret_iv), authTag: String(row.secret_auth_tag) }, R1);
const expireLease = (w: World) => { w.vault.get(R1)!.save_lease_until = new Date(Date.now() - 1_000).toISOString(); };

test("R2-03 REPRO : B échoue (profil) pendant que A, concurrent, réussit => la restauration de B n'écrase PAS la configuration de A", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200); // état initial X
  let aStatus = 0;
  // B est en vol (coffre mis en préparation) : son bail expire (requête lente), A s'intercale et RÉUSSIT, puis le profil de B est refusé.
  w.failProfileRpcAtCall = w.profileRpcCalls + 1;
  w.duringProfileRpc = async () => {
    expireLease(w);
    aStatus = (await post("tok-owner-r1", configOf("a"))).status;
  };
  const b = await post("tok-manager-r1", configOf("b"));
  assert.equal(aStatus, 200, "A a réussi");
  assert.equal(b.status, 400);
  assert.equal((await b.json()).code, "EMAIL_PROFILE_SAVE_FAILED");
  const row = w.vault.get(R1)!;
  assert.equal(row.host, "smtp.a.fr", "la configuration de A subsiste : la restauration de B ne l'a pas écrasée");
  assert.equal(row.username, "a@resto.fr");
  assert.equal(vaultPassword(row), "MOT-DE-PASSE-A");
  assert.equal(row.enabled, true);
  assert.equal(w.profile.get(R1)!.sender_name, "Resto a");
  assert.equal(row.save_token, null, "aucun bail orphelin");
});

test("R2-03 : l'activation de B (profil réussi) est conditionnelle au jeton : si A a repris le coffre, B reçoit 409 et ne désactive/active rien chez A", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  let aStatus = 0;
  w.duringProfileRpc = async () => {
    expireLease(w);
    aStatus = (await post("tok-owner-r1", configOf("a"))).status;
  };
  const b = await post("tok-manager-r1", configOf("b", { enabled: false })); // B demande la DÉSACTIVATION
  assert.equal(aStatus, 200);
  assert.equal(b.status, 409);
  assert.equal((await b.json()).code, "EMAIL_PROVIDER_CONFLICT");
  const row = w.vault.get(R1)!;
  assert.equal(row.host, "smtp.a.fr");
  assert.equal(row.enabled, true, "l'activation de A n'est pas annulée par la désactivation tardive de B");
  assert.equal(row.save_token, null);
});

test("R2-03 : pendant qu'un enregistrement est en cours (bail valide), un second est refusé en 409 et ne modifie rien", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  let rival: { status: number; code: string } | null = null;
  let vaultSeenByRival = "";
  w.duringProfileRpc = async () => {
    vaultSeenByRival = JSON.stringify(w.vault.get(R1));
    const res = await post("tok-owner-r1", configOf("a"));
    rival = { status: res.status, code: (await res.json()).code };
    assert.equal(JSON.stringify(w.vault.get(R1)), vaultSeenByRival, "le rival n'a rien écrit");
  };
  const b = await post("tok-manager-r1", configOf("b"));
  assert.deepEqual(rival, { status: 409, code: "EMAIL_PROVIDER_CONFLICT" });
  assert.equal(b.status, 200);
  assert.equal(w.vault.get(R1)!.host, "smtp.b.fr");
  assert.equal(w.profile.get(R1)!.sender_name, "Resto b");
});

test("R2-03 : bail libéré après un succès, après une restauration réussie ; un bail EXPIRÉ (plantage) ne bloque pas ; un bail VALIDE bloque", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  assert.equal(w.vault.get(R1)!.save_token, null);
  assert.equal(w.vault.get(R1)!.save_lease_until, null);

  w.failProfileRpc = true;
  assert.equal((await post("tok-owner-r1", configOf("a"))).status, 400);
  assert.equal(w.vault.get(R1)!.save_token, null, "restauration réussie => bail libéré");
  w.failProfileRpc = false;

  // Plantage simulé : un enregistrement a laissé son bail, expiré depuis.
  Object.assign(w.vault.get(R1)!, { save_token: "00000000-0000-4000-8000-00000000dead", save_lease_until: new Date(Date.now() - 5_000).toISOString() });
  assert.equal((await post("tok-owner-r1", configOf("a"))).status, 200, "un bail expiré est repris");
  assert.equal(w.vault.get(R1)!.host, "smtp.a.fr");

  // Bail encore valide : refus 409, aucune écriture.
  Object.assign(w.vault.get(R1)!, { save_token: "00000000-0000-4000-8000-00000000beef", save_lease_until: new Date(Date.now() + 30_000).toISOString() });
  const before = JSON.stringify(w.vault.get(R1));
  const blocked = await post("tok-owner-r1", configOf("b"));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "EMAIL_PROVIDER_CONFLICT");
  assert.equal(JSON.stringify(w.vault.get(R1)), before);
  assert.equal(w.profile.get(R1)!.sender_name, "Resto a", "le profil n'a pas été touché par le refus");
});

test("R2-03 : deux PREMIÈRES configurations simultanées => un seul gagnant, l'autre 409 (contrainte d'unicité), coffre et profil cohérents", async (t) => {
  const w = install(t);
  const [a, b] = await Promise.all([post("tok-owner-r1", configOf("a")), post("tok-manager-r1", configOf("b"))]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = a.status === 200 ? "a" : "b";
  assert.equal(w.vault.get(R1)!.host, `smtp.${winner}.fr`);
  assert.equal(vaultPassword(w.vault.get(R1)!), `MOT-DE-PASSE-${winner.toUpperCase()}`);
  assert.equal(w.profile.get(R1)!.sender_name, `Resto ${winner}`);
  assert.equal(w.vault.get(R1)!.enabled, true);
  assert.equal(w.vault.get(R1)!.save_token, null);
});

test("R2-03 : 8 enregistrements simultanés sur un coffre existant => seuls des 200/409, coffre = profil = un même gagnant, aucun bail orphelin", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const results = await Promise.all(labels.map((label, index) => post(index % 2 ? "tok-manager-r1" : "tok-owner-r1", configOf(label))));
  const winners = labels.filter((_, index) => results[index]!.status === 200);
  for (const result of results) assert.ok(result.status === 200 || result.status === 409, `statut inattendu ${result.status}`);
  assert.ok(winners.length >= 1);
  const last = winners[winners.length - 1]!;
  const row = w.vault.get(R1)!;
  assert.equal(row.host, `smtp.${last}.fr`, "le coffre est celui du dernier enregistrement RÉUSSI");
  assert.equal(vaultPassword(row), `MOT-DE-PASSE-${last.toUpperCase()}`);
  assert.equal(w.profile.get(R1)!.sender_name, `Resto ${last}`, "le profil est celui du même enregistrement");
  assert.equal(row.enabled, true);
  assert.equal(row.save_token, null);
  assert.equal(row.save_lease_until, null);
});

for (const [label, change] of [
  ["hôte", (row: Row) => { row.host = "smtp.autre.fr"; }],
  ["port", (row: Row) => { row.port = 25; }],
  ["identifiant", (row: Row) => { row.username = "autre@resto.fr"; }],
  ["secret", (row: Row) => { row.secret_ciphertext = "AUTRE-CHIFFRE"; }],
  ["activation (ex. suspension par le worker)", (row: Row) => { row.enabled = false; }],
] as const) {
  test(`R2-03 : ${label} modifié entre la lecture et la mise en préparation => 409, la ligne n'est pas réécrite (pas de résurrection d'un état périmé)`, async (t) => {
    const w = install(t);
    assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
    w.beforeConditionalUpdate = () => change(w.vault.get(R1)!);
    const concurrentState = (): string => JSON.stringify(w.vault.get(R1));
    let stateAfterChange = "";
    const original = w.beforeConditionalUpdate;
    w.beforeConditionalUpdate = () => { original(); stateAfterChange = concurrentState(); };
    const res = await post("tok-manager-r1", { ...SAVE, password: "", enabled: true });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "EMAIL_PROVIDER_CONFLICT");
    assert.equal(concurrentState(), stateAfterChange, "la ligne est exactement celle laissée par le concurrent");
    assert.equal(w.profile.get(R1)!.sender_name, "Resto", "le profil n'a pas été écrit");
  });
}

test("R2-03 : le flux d'enregistrement n'utilise plus aucun upsert inconditionnel (insert pour la 1re configuration, UPDATE conditionnels ensuite)", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  w.failProfileRpc = true;
  assert.equal((await post("tok-owner-r1", configOf("a"))).status, 400);
  assert.equal(w.upsertCalls, 0);
  assert.equal(w.insertCalls, 1);
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
