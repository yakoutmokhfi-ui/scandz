import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_PROJECT_REF,
  EXPECTED_RESTAURANT_ID,
  EXPECTED_SLUG,
  provisionTestCredential,
  validateSupabaseSecretKey,
  validateCredential,
  validateSupabaseUrl,
} from "./monetico-test-setup.mjs";

const valid = { tpe: "35VV71I", societe: "aulaitcru", securityKey: "0123456789abcdef0123456789abcdef01234567" };
const secretKey = "sb_secret_test_only_key_value_1234567890";
const legacyServiceRoleKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature";
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

test("accepts only the known HTTPS Supabase project", () => {
  assert.equal(validateSupabaseUrl(`https://${EXPECTED_PROJECT_REF}.supabase.co`), `https://${EXPECTED_PROJECT_REF}.supabase.co`);
  assert.throws(() => validateSupabaseUrl("http://ctqfpszwunfomrbxgigu.supabase.co"), /WRONG_SUPABASE_PROJECT/);
  assert.throws(() => validateSupabaseUrl("https://attacker.example"), /WRONG_SUPABASE_PROJECT/);
  assert.throws(() => validateSupabaseUrl(`https://${EXPECTED_PROJECT_REF}.supabase.co.evil.example`), /WRONG_SUPABASE_PROJECT/);
});

test("validates the TPE, society code, and exact 40-hex Monetico key", () => {
  assert.deepEqual(validateCredential(valid), valid);
  assert.throws(() => validateCredential({ ...valid, tpe: "123456" }), /INVALID_TPE/);
  assert.throws(() => validateCredential({ ...valid, societe: "a\n" }), /INVALID_SOCIETE/);
  assert.throws(() => validateCredential({ ...valid, securityKey: "not-a-key" }), /INVALID_SECURITY_KEY/);
});

test("accepts current Supabase secret keys and legacy service_role JWTs only", () => {
  assert.equal(validateSupabaseSecretKey(secretKey), "secret");
  assert.equal(validateSupabaseSecretKey(legacyServiceRoleKey), "legacy-jwt");
  assert.throws(() => validateSupabaseSecretKey("sb_publishable_public_key"), /INVALID_SUPABASE_KEY/);
  assert.throws(() => validateSupabaseSecretKey("not-a-key"), /INVALID_SUPABASE_KEY/);
});

test("writes a new test-only config and confirms it remains disabled", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (seen.length === 1) return json([{ id: EXPECTED_RESTAURANT_ID, slug: EXPECTED_SLUG }]);
    if (seen.length === 2) return json([]);
    if (seen.length === 3) {
      const body = JSON.parse(init.body);
      assert.equal(body.p_restaurant_id, EXPECTED_RESTAURANT_ID);
      assert.equal(body.p_provider_code, "monetico");
      assert.equal(body.p_mode, "test");
      assert.deepEqual(JSON.parse(body.p_secret), valid);
      return json([{ provider_code: "monetico", mode: "test", configuration_status: "configured" }]);
    }
    return json([{ provider_code: "monetico", mode: "test", configuration_status: "configured", is_enabled: false }]);
  };

  const result = await provisionTestCredential({
    supabaseUrl: `https://${EXPECTED_PROJECT_REF}.supabase.co`,
    serviceRoleKey: secretKey,
    credential: valid,
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(result, { provider: "monetico", mode: "test", configurationStatus: "configured", enabled: false });
  assert.equal(seen.length, 4);
  assert.equal(seen[0].init.headers.apikey, secretKey);
  assert.equal(seen[0].init.headers.Authorization, undefined);
  assert.equal(seen[2].init.method, "POST");
  assert.ok(seen.every((entry) => entry.init.signal instanceof AbortSignal));
});

test("uses Authorization Bearer only for the legacy JWT service_role key", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (seen.length === 1) return json([{ id: EXPECTED_RESTAURANT_ID, slug: EXPECTED_SLUG }]);
    if (seen.length === 2) return json([]);
    if (seen.length === 3) return json([{ provider_code: "monetico", mode: "test", configuration_status: "configured" }]);
    return json([{ provider_code: "monetico", mode: "test", configuration_status: "configured", is_enabled: false }]);
  };
  await provisionTestCredential({
    supabaseUrl: `https://${EXPECTED_PROJECT_REF}.supabase.co`,
    serviceRoleKey: legacyServiceRoleKey,
    credential: valid,
    fetchImpl: fakeFetch,
  });
  assert.ok(seen.every(({ init }) => init.headers.Authorization === `Bearer ${legacyServiceRoleKey}`));
});

test("refuses to overwrite an existing Monetico config before any write", async () => {
  const calls = [];
  const fakeFetch = async (_url, _init) => {
    calls.push(1);
    return calls.length === 1
      ? json([{ id: EXPECTED_RESTAURANT_ID, slug: EXPECTED_SLUG }])
      : json([{ provider_code: "monetico", mode: "test", configuration_status: "configured", is_enabled: false }]);
  };
  await assert.rejects(
    provisionTestCredential({
      supabaseUrl: `https://${EXPECTED_PROJECT_REF}.supabase.co`,
      serviceRoleKey: secretKey,
      credential: valid,
      fetchImpl: fakeFetch,
    }),
    /MONETICO_CONFIG_ALREADY_EXISTS/,
  );
  assert.equal(calls.length, 2);
});

test("fails closed if the config is unexpectedly enabled after the test write", async () => {
  let calls = 0;
  const fakeFetch = async (_url, _init) => {
    calls++;
    if (calls === 1) return json([{ id: EXPECTED_RESTAURANT_ID, slug: EXPECTED_SLUG }]);
    if (calls === 2) return json([]);
    if (calls === 3) return json([{ provider_code: "monetico", mode: "test", configuration_status: "configured" }]);
    return json([{ provider_code: "monetico", mode: "test", configuration_status: "configured", is_enabled: true }]);
  };
  await assert.rejects(
    provisionTestCredential({
      supabaseUrl: `https://${EXPECTED_PROJECT_REF}.supabase.co`,
      serviceRoleKey: secretKey,
      credential: valid,
      fetchImpl: fakeFetch,
    }),
    /CONFIG_VERIFY_UNEXPECTED_RESULT/,
  );
});
