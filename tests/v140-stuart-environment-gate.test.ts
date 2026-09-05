import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { resolveStuartEnvironment, StuartEnvironmentError } = await import(
  "../lib/server/delivery-providers/stuart/environment.ts"
);

// ====================================================================
// DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.1 (ferme
// STUART-V1-ENVIRONMENT-GATE-01). Preuve directe : aucune URL
// arbitraire n'est jamais possible, l'URL de base est TOUJOURS
// DÉRIVÉE de STUART_ENV, jamais lue depuis une autre variable.
// ====================================================================

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.STUART_ENV;
  if (value === undefined) delete process.env.STUART_ENV;
  else process.env.STUART_ENV = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.STUART_ENV;
    else process.env.STUART_ENV = prev;
  }
}

test("STUART-V1-ENVIRONMENT-GATE-01 : STUART_ENV absente -- StuartEnvironmentError, jamais un défaut permissif", () => {
  withEnv(undefined, () => {
    assert.throws(() => resolveStuartEnvironment(), StuartEnvironmentError);
  });
});

test("STUART-V1-ENVIRONMENT-GATE-01 : valeur inconnue -- StuartEnvironmentError", () => {
  for (const bad of ["Sandbox", "SANDBOX", "prod", "production ", " sandbox", "staging", "", "sandbox;production"]) {
    withEnv(bad, () => {
      assert.throws(() => resolveStuartEnvironment(), StuartEnvironmentError, `valeur rejetée attendue pour ${JSON.stringify(bad)}`);
    });
  }
});

test("STUART-V1-ENVIRONMENT-GATE-01 : \"sandbox\" -- URL de base Sandbox OFFICIELLE exacte dérivée", () => {
  withEnv("sandbox", () => {
    const { environment, baseUrl } = resolveStuartEnvironment();
    assert.equal(environment, "sandbox");
    assert.equal(baseUrl, "https://api.sandbox.stuart.com");
  });
});

test("STUART-V1-ENVIRONMENT-GATE-01 : \"production\" -- URL de base Production OFFICIELLE exacte dérivée", () => {
  withEnv("production", () => {
    const { environment, baseUrl } = resolveStuartEnvironment();
    assert.equal(environment, "production");
    assert.equal(baseUrl, "https://api.stuart.com");
  });
});

test("STUART-V1-ENVIRONMENT-GATE-01 : les deux URLs sont structurellement DISTINCTES -- aucune confusion possible entre les deux environnements", () => {
  const sandbox = withEnv("sandbox", () => resolveStuartEnvironment().baseUrl);
  const production = withEnv("production", () => resolveStuartEnvironment().baseUrl);
  assert.notEqual(sandbox, production);
});

test("STUART-V1-ENVIRONMENT-GATE-01 : aucune variable STUART_API_BASE_URL n'est JAMAIS lue -- confirmé structurellement (une URL arbitraire positionnée dans cette variable n'a AUCUN effet)", () => {
  const prevArbitrary = process.env.STUART_API_BASE_URL;
  process.env.STUART_API_BASE_URL = "https://attacker.example.test";
  try {
    withEnv("sandbox", () => {
      const { baseUrl } = resolveStuartEnvironment();
      assert.equal(baseUrl, "https://api.sandbox.stuart.com", "STUART_API_BASE_URL arbitraire ignoré -- seule STUART_ENV détermine l'URL");
    });
  } finally {
    if (prevArbitrary === undefined) delete process.env.STUART_API_BASE_URL;
    else process.env.STUART_API_BASE_URL = prevArbitrary;
  }
});
