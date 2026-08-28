import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
// Couvre lib/server/supabase-admin.ts EN ISOLATION : validation
// d'environnement (fail-closed, jamais de secret imprimé), init
// paresseuse (mandat §36/§37 : importer le module seul ne doit rien
// valider ni échouer), options d'authentification "server-safe"
// (§24), et le comportement singleton (§37).
//
// Chaque test réimporte le module via une chaîne de requête unique
// (`?t=...`) : Node/ESM traite un spécificateur différent comme un
// module DISTINCT, ce qui donne à chaque test son propre
// `cachedClient` non pollué par un test précédent -- sans avoir besoin
// d'exporter un hook de réinitialisation réservé aux tests depuis le
// module de production lui-même (mandat §39, isolation des tests).
// ====================================================================

let importCounter = 0;
async function freshAdminModule() {
  importCounter += 1;
  return import(`../lib/server/supabase-admin.ts?t=${Date.now()}-${importCounter}`);
}

/** Sauvegarde/restaure les variables d'environnement touchées par un
 *  test (mandat §39) -- jamais de fuite d'état vers le test suivant,
 *  même en cas d'échec (assertion ou exception) à l'intérieur de fn. */
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SYNTHETIC_URL = "https://p3a1-synthetic-project.supabase.co";
// Marqueur synthétique DISTINCTIF (mandat §21/§35) -- jamais une vraie
// clé, jamais commis avec une forme plausible de secret réel.
const SYNTHETIC_KEY = "p3a1-synthetic-service-role-key-DO-NOT-USE";

test("supabase-admin: importer le module SEUL (sans appeler getServiceRoleSupabaseClient) ne lit ni ne valide rien, même env totalement absent (init paresseuse, mandat §36/§37)", async () => {
  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_URL: undefined },
    async () => {
      // Ne doit PAS lever -- seul l'IMPORT a lieu ici.
      await assert.doesNotReject(() => freshAdminModule());
    }
  );
});

test("supabase-admin: SUPABASE_SERVICE_ROLE_KEY absente -> échec fermé, message nomme UNIQUEMENT la variable, jamais une valeur", async () => {
  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_URL: SYNTHETIC_URL },
    async () => {
      const { getServiceRoleSupabaseClient } = await freshAdminModule();
      assert.throws(
        () => getServiceRoleSupabaseClient(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.name, "PaymentServerConfigError");
          assert.equal(err.message, "SUPABASE_SERVICE_ROLE_KEY is not configured");
          return true;
        }
      );
    }
  );
});

test("supabase-admin: SUPABASE_SERVICE_ROLE_KEY vide/blanche -> échec fermé identique (traitée comme absente)", async () => {
  for (const emptyLike of ["", "   ", "\t\n"]) {
    await withEnv(
      { SUPABASE_SERVICE_ROLE_KEY: emptyLike, NEXT_PUBLIC_SUPABASE_URL: SYNTHETIC_URL },
      async () => {
        const { getServiceRoleSupabaseClient } = await freshAdminModule();
        assert.throws(() => getServiceRoleSupabaseClient(), {
          name: "PaymentServerConfigError",
          message: "SUPABASE_SERVICE_ROLE_KEY is not configured",
        });
      }
    );
  }
});

test("supabase-admin: NEXT_PUBLIC_SUPABASE_URL absente (clé service_role présente) -> échec fermé nommant cette variable", async () => {
  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_KEY, NEXT_PUBLIC_SUPABASE_URL: undefined },
    async () => {
      const { getServiceRoleSupabaseClient } = await freshAdminModule();
      assert.throws(() => getServiceRoleSupabaseClient(), {
        name: "PaymentServerConfigError",
        message: "NEXT_PUBLIC_SUPABASE_URL is not configured",
      });
    }
  );
});

test("supabase-admin: les deux variables présentes -> client construit avec succès, forme attendue (rpc/from/auth)", async () => {
  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_KEY, NEXT_PUBLIC_SUPABASE_URL: SYNTHETIC_URL },
    async () => {
      const { getServiceRoleSupabaseClient } = await freshAdminModule();
      const client = getServiceRoleSupabaseClient();
      assert.equal(typeof client.rpc, "function");
      assert.equal(typeof client.from, "function");
      assert.ok(client.auth);
    }
  );
});

test("supabase-admin: options d'authentification server-safe (mandat §24) -- persistSession/autoRefreshToken à false, comportement RÉEL du client construit, pas un mock", async () => {
  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_KEY, NEXT_PUBLIC_SUPABASE_URL: SYNTHETIC_URL },
    async () => {
      const { getServiceRoleSupabaseClient } = await freshAdminModule();
      const client = getServiceRoleSupabaseClient();
      assert.equal(client.auth.persistSession, false);
      assert.equal(client.auth.autoRefreshToken, false);
    }
  );
});

test("supabase-admin: singleton paresseux -- deux appels dans la même instance de module renvoient EXACTEMENT la même référence (mandat §37)", async () => {
  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_KEY, NEXT_PUBLIC_SUPABASE_URL: SYNTHETIC_URL },
    async () => {
      const { getServiceRoleSupabaseClient } = await freshAdminModule();
      const first = getServiceRoleSupabaseClient();
      const second = getServiceRoleSupabaseClient();
      assert.equal(first, second);
    }
  );
});

test("supabase-admin: le module N'EXPORTE JAMAIS la clé, un objet d'environnement, ni la fonction de lecture interne (mandat §9)", async () => {
  const mod = await freshAdminModule();
  const exportedNames = Object.keys(mod).sort();
  assert.deepEqual(exportedNames, ["getServiceRoleSupabaseClient"]);
});

test("supabase-admin: aucune sortie console (log/error/warn) ne contient le marqueur synthétique de clé, succès comme échec", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  });
  t.mock.method(console, "error", (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  });
  t.mock.method(console, "warn", (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  });

  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_KEY, NEXT_PUBLIC_SUPABASE_URL: SYNTHETIC_URL },
    async () => {
      const { getServiceRoleSupabaseClient } = await freshAdminModule();
      getServiceRoleSupabaseClient();
    }
  );
  await withEnv(
    { SUPABASE_SERVICE_ROLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_URL: SYNTHETIC_URL },
    async () => {
      const { getServiceRoleSupabaseClient } = await freshAdminModule();
      try {
        getServiceRoleSupabaseClient();
      } catch {
        // attendu -- voir les tests dédiés ci-dessus.
      }
    }
  );

  const combined = seen.join("\n");
  assert.ok(
    !combined.includes(SYNTHETIC_KEY),
    "le marqueur synthétique de clé service_role est apparu dans une sortie console"
  );
});
