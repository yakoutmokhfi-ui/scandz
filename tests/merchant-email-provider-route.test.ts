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
const { recordMerchantSmtpVaultState } = await import("../lib/server/notifications/merchant-smtp-provider.ts");
const route = await import("../app/api/dashboard/email-provider/route.ts");
const admin = getServiceRoleSupabaseClient();

const PROFILE_LEASE_RPC = "set_merchant_notification_profile_under_save_lease";
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
  /** Exécuté APRÈS l'écriture réussie du profil, avant le retour du RPC (R3) : fenêtre entre le RPC et l'activation. */
  afterProfileRpc: (() => Promise<void>) | null;
  failProfileRpc: boolean;
  profileRpcCalls: number;
  profileRpcNames: string[];
  profileRpcArgs: Row[];
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
    beforeInsert: null, duringProfileRpc: null, afterProfileRpc: null,
    failProfileRpc: false, profileRpcCalls: 0, profileRpcNames: [], profileRpcArgs: [], failProfileRpcAtCall: null,
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
      // `set_merchant_notification_profile` : ancienne écriture, conservée pour REJOUER le code de 9e38c88.
      // `..._under_save_lease` (R3) : même écriture, dans la MÊME transaction qu'une vérification du jeton de bail
      // (verrou de la ligne du coffre) -- modélisée ici exactement comme le SQL : jeton différent => rien d'écrit.
      if (name === "set_merchant_notification_profile" || name === PROFILE_LEASE_RPC) {
        world.profileRpcCalls += 1;
        world.profileRpcNames.push(name);
        world.profileRpcArgs.push({ ...args });
        const callNumber = world.profileRpcCalls;
        if (world.duringProfileRpc) { const hook = world.duringProfileRpc; world.duringProfileRpc = null; await hook(); }
        if (!role || world.failProfileRpc || world.failProfileRpcAtCall === callNumber) return { data: null, error: new Error("rpc refused") };
        if (name === PROFILE_LEASE_RPC) {
          const holder = world.vault.get(String(args.p_restaurant_id));
          if (!holder || holder.save_token == null || holder.save_token !== args.p_save_token) {
            return { data: null, error: new Error("SCANYM_SAVE_LEASE_LOST: le bail d'enregistrement n'est plus le nôtre") };
          }
        }
        world.profile.set(String(args.p_restaurant_id), {
          email_enabled: args.p_email_enabled, sender_name: args.p_sender_name, sender_email: args.p_sender_email,
          reply_to: args.p_reply_to, default_locale: args.p_default_locale,
        });
        if (world.afterProfileRpc) { const hook = world.afterProfileRpc; world.afterProfileRpc = null; await hook(); }
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

// --------------------------------------------------------------------
// R3-02 (contre-audit de 9e38c88, P2) : « Sauvegarde concurrente : un profil ancien peut remplacer celui d'une
// configuration récemment enregistrée » -- le profil est écrit SOUS BAIL (même transaction que la vérification du jeton).
// --------------------------------------------------------------------
test("R3-02 REPRO : B, dont le bail a été repris par A (qui a réussi), n'écrase PAS le profil de A quand son propre RPC aboutit ; B reçoit 409", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  let aStatus = 0;
  // B est lent : son bail expire, A s'intercale et réussit (coffre ET profil), puis le RPC de B arrive -- et aurait ABOUTI.
  w.duringProfileRpc = async () => {
    expireLease(w);
    aStatus = (await post("tok-owner-r1", configOf("a"))).status;
  };
  const b = await post("tok-manager-r1", configOf("b"));
  assert.equal(aStatus, 200, "A a réussi");
  assert.equal(b.status, 409, "B n'a plus le bail : conflit, pas de succès ni d'échec de profil");
  assert.equal((await b.json()).code, "EMAIL_PROVIDER_CONFLICT");
  assert.equal(w.profile.get(R1)!.sender_name, "Resto a", "le profil de A (le plus récent) n'est PAS remplacé par celui de B");
  assert.equal(w.profile.get(R1)!.sender_email, "a@resto.fr");
  const row = w.vault.get(R1)!;
  assert.equal(row.host, "smtp.a.fr");
  assert.equal(vaultPassword(row), "MOT-DE-PASSE-A");
  assert.equal(row.enabled, true);
  assert.equal(row.save_token, null, "aucun bail orphelin");
});

test("R3-02 : le profil n'est JAMAIS écrit hors bail -- RPC sous bail uniquement, avec le jeton posé sur la ligne du coffre à ce moment-là", async (t) => {
  const w = install(t);
  let tokenInVaultWhenCalled: unknown = null;
  w.duringProfileRpc = async () => { tokenInVaultWhenCalled = w.vault.get(R1)?.save_token; };
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  assert.deepEqual(w.profileRpcNames, [PROFILE_LEASE_RPC], "un seul RPC de profil, et c'est celui sous bail");
  assert.equal(w.profileRpcArgs[0]!.p_save_token, tokenInVaultWhenCalled, "le RPC reçoit le jeton du bail posé à la mise en préparation");
  assert.ok(typeof tokenInVaultWhenCalled === "string" && tokenInVaultWhenCalled.length === 36);
  // Aucune trace de l'ancien appel non conditionnel dans la route.
  const src = (await import("node:fs")).readFileSync("app/api/dashboard/email-provider/route.ts", "utf8");
  assert.equal(/\.rpc\(\s*["']set_merchant_notification_profile["']/.test(src), false, "la route n'appelle plus set_merchant_notification_profile directement");
  assert.ok(src.includes('"set_merchant_notification_profile_under_save_lease"'));
});

test("R3-02 : bail perdu pendant le RPC => 409 SANS aucune écriture supplémentaire du coffre (l'état de celui qui a repris fait foi)", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  let rowAfterA = "";
  w.duringProfileRpc = async () => {
    expireLease(w);
    assert.equal((await post("tok-owner-r1", configOf("a"))).status, 200);
    rowAfterA = JSON.stringify(w.vault.get(R1));
    w.adminWrites.length = 0;
  };
  const b = await post("tok-manager-r1", configOf("b"));
  assert.equal(b.status, 409);
  assert.deepEqual(w.adminWrites, [], "ni restauration, ni activation, ni libération : B n'écrit plus rien");
  assert.equal(JSON.stringify(w.vault.get(R1)), rowAfterA);
});

test("R3-02 : bail repris ENTRE le RPC de profil (réussi) et l'activation => l'activation reste conditionnelle au jeton : 409 et rien n'est modifié chez celui qui a repris le coffre", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  let aStatus = 0;
  // Le RPC de B a ABOUTI (profil de B écrit sous bail) ; avant que B n'active, son bail expire et A prend le coffre.
  w.afterProfileRpc = async () => {
    expireLease(w);
    aStatus = (await post("tok-owner-r1", configOf("a"))).status;
  };
  const b = await post("tok-manager-r1", configOf("b", { enabled: false })); // B demande la DÉSACTIVATION
  assert.equal(aStatus, 200, "A a réussi (coffre actif)");
  assert.equal(b.status, 409, "l'activation tardive de B ne trouve plus son jeton");
  assert.equal((await b.json()).code, "EMAIL_PROVIDER_CONFLICT");
  const row = w.vault.get(R1)!;
  assert.equal(row.host, "smtp.a.fr");
  assert.equal(row.enabled, true, "la désactivation de B n'est pas appliquée à la configuration de A");
  assert.equal(row.save_token, null);
});

// --------------------------------------------------------------------
// R3-03 (contre-audit de 9e38c88, P2) : « Suspension annulée : une sauvegarde refusée peut réactiver le fournisseur
// suspendu par le worker » -- la restauration et l'activation sont conditionnelles à l'état d'erreur.
// --------------------------------------------------------------------
const cronSuspends = (w: World, errorClass = "PROVIDER_AUTHENTICATION_FAILED") => {
  const row = w.vault.get(R1)!;
  return recordMerchantSmtpVaultState(admin, R1, { host: String(row.host), username: String(row.username), secret_ciphertext: String(row.secret_ciphertext) }, errorClass as never, true, new Date("2026-10-31T12:00:00.000Z"));
};
const SAME_SECRET = { ...SAVE, password: "", senderName: "Resto (modifié)" };

test("R3-03 REPRO : le Cron suspend le fournisseur (authentification) PENDANT un enregistrement qui est ensuite refusé => la suspension subsiste (désactivé + erreur conservée)", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  assert.equal(w.vault.get(R1)!.enabled, true);
  w.failProfileRpc = true;
  w.duringProfileRpc = async () => { await cronSuspends(w); };
  const res = await post("tok-owner-r1", SAME_SECRET);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "EMAIL_PROFILE_SAVE_FAILED");
  assert.equal(body.providerKeptClosed, true, "la réponse dit que le fournisseur est resté fermé");
  const row = w.vault.get(R1)!;
  assert.equal(row.enabled, false, "le fournisseur suspendu par le Cron N'EST PAS réactivé par la restauration");
  assert.equal(row.last_error_class, "PROVIDER_AUTHENTICATION_FAILED", "l'erreur écrite par le Cron n'est pas effacée");
  assert.equal(row.last_error_at, "2026-10-31T12:00:00.000Z");
  assert.equal(row.save_token, null, "le bail est libéré");
  assert.equal(row.save_lease_until, null);
  assert.equal(row.host, "smtp.ionos.fr");
  assert.equal(vaultPassword(row), OWNER_PASSWORD, "cible et secret d'origine rendus");
});

test("R3-03 : un TEST DE CONNEXION qui conclut (échec) pendant l'enregistrement refusé a le même effet -- fournisseur laissé fermé, erreur conservée", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  w.failProfileRpc = true;
  w.duringProfileRpc = async () => {
    const row = w.vault.get(R1)!;
    await recordMerchantSmtpVaultState(admin, R1, { host: String(row.host), username: String(row.username), secret_ciphertext: String(row.secret_ciphertext) }, "PROVIDER_CONNECTION_FAILED" as never, false, new Date("2026-10-31T12:30:00.000Z"));
  };
  const res = await post("tok-owner-r1", SAME_SECRET);
  assert.equal(res.status, 400);
  assert.equal(w.vault.get(R1)!.enabled, false);
  assert.equal(w.vault.get(R1)!.last_error_class, "PROVIDER_CONNECTION_FAILED");
  assert.equal(w.vault.get(R1)!.save_token, null);
});

test("R3-03 : sans événement concurrent, la restauration rétablit l'état d'origine À L'IDENTIQUE, état d'erreur compris (aucune régression)", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  // Fournisseur déjà en erreur AVANT l'enregistrement (suspendu plus tôt) : l'état d'erreur d'origine doit revenir tel quel.
  Object.assign(w.vault.get(R1)!, { enabled: false, last_error_class: "PROVIDER_AUTHENTICATION_FAILED", last_error_at: "2026-10-31T09:00:00.000Z" });
  const before = JSON.stringify(w.vault.get(R1));
  w.failProfileRpc = true;
  for (const attempt of [SAME_SECRET, { ...SAVE, host: "smtp.autre-hote.fr", username: "autre@resto.fr", password: "NOUVEAU" }]) {
    const res = await post("tok-owner-r1", attempt);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).providerKeptClosed, undefined, "restauration complète : pas de mention « resté fermé »");
    assert.equal(JSON.stringify(w.vault.get(R1)), before, "restauration à l'identique");
  }
  // Et avec un fournisseur ACTIVÉ en bonne santé.
  const w2 = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  const healthy = JSON.stringify(w2.vault.get(R1));
  w2.failProfileRpc = true;
  assert.equal((await post("tok-owner-r1", SAME_SECRET)).status, 400);
  assert.equal(JSON.stringify(w2.vault.get(R1)), healthy);
  assert.equal(w2.vault.get(R1)!.enabled, true);
});

test("R3-03 : nouveaux identifiants => la suspension du Cron (qui vise l'ANCIEN secret) ne peut pas toucher la ligne en préparation ; la restauration rend l'ancien état", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  const before = JSON.stringify(w.vault.get(R1));
  const oldRow = { ...w.vault.get(R1)! };
  w.failProfileRpc = true;
  w.duringProfileRpc = async () => {
    // Le Cron avait chargé l'ancienne ligne : son écriture est épinglée sur hôte/identifiant/secret d'origine.
    await recordMerchantSmtpVaultState(admin, R1, { host: String(oldRow.host), username: String(oldRow.username), secret_ciphertext: String(oldRow.secret_ciphertext) }, "PROVIDER_AUTHENTICATION_FAILED" as never, true, new Date("2026-10-31T12:00:00.000Z"));
  };
  const res = await post("tok-owner-r1", { ...SAVE, host: "smtp.autre-hote.fr", username: "autre@resto.fr", password: "NOUVEAU" });
  assert.equal(res.status, 400);
  assert.equal(JSON.stringify(w.vault.get(R1)), before, "l'écriture du Cron n'a rien trouvé à modifier : état d'origine intact");
});

test("R3-03 : ACTIVATION -- le Cron suspend entre la mise en préparation et l'activation => le fournisseur n'est PAS réactivé (409), erreur conservée, bail libéré", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  w.duringProfileRpc = async () => { await cronSuspends(w); }; // le profil, lui, est écrit normalement
  const res = await post("tok-owner-r1", SAME_SECRET);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "EMAIL_PROVIDER_CONFLICT");
  const row = w.vault.get(R1)!;
  assert.equal(row.enabled, false, "pas de réactivation d'un fournisseur suspendu pendant l'enregistrement");
  assert.equal(row.last_error_class, "PROVIDER_AUTHENTICATION_FAILED");
  assert.equal(row.save_token, null, "bail libéré");
  assert.equal(w.profile.get(R1)!.sender_name, "Resto (modifié)", "le profil, écrit sous bail, est enregistré");
});

test("R3-03 : une DÉSACTIVATION demandée n'est jamais bloquée par un événement du Cron (rien à protéger)", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  w.duringProfileRpc = async () => { await cronSuspends(w); };
  const res = await post("tok-owner-r1", { ...SAME_SECRET, enabled: false });
  assert.equal(res.status, 200);
  assert.equal(w.vault.get(R1)!.enabled, false);
  assert.equal(w.vault.get(R1)!.last_error_class, "PROVIDER_AUTHENTICATION_FAILED", "l'erreur du Cron reste visible");
  assert.equal(w.vault.get(R1)!.save_token, null);
});

test("R3-03 : une erreur enregistrée ENTRE la lecture et la mise en préparation => 409, la ligne n'est pas modifiée (l'état d'erreur lu fait partie de l'état attendu)", async (t) => {
  const w = install(t);
  assert.equal((await post("tok-owner-r1", SAVE)).status, 200);
  w.beforeConditionalUpdate = () => { Object.assign(w.vault.get(R1)!, { last_error_class: "PROVIDER_CONNECTION_FAILED", last_error_at: "2026-10-31T11:00:00.000Z" }); };
  const res = await post("tok-owner-r1", SAME_SECRET);
  assert.equal(res.status, 409);
  const row = w.vault.get(R1)!;
  assert.equal(row.enabled, true, "rien n'a été écrit");
  assert.equal(row.save_token, null);
  assert.equal(row.last_error_class, "PROVIDER_CONNECTION_FAILED");
});

test("R3-03 : première configuration refusée => coffre fermé et bail libéré (comportement conservé)", async (t) => {
  const w = install(t);
  w.failProfileRpc = true;
  const res = await post("tok-owner-r1", SAVE);
  assert.equal(res.status, 400);
  assert.equal(w.vault.get(R1)!.enabled, false);
  assert.equal(w.vault.get(R1)!.save_token, null);
});
