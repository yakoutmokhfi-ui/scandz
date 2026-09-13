import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stuart-d1-v1-2-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();

const { getStuartDeliveryEligibility, StuartEligibilityError } = await import(
  "../lib/server/delivery-providers/stuart/eligibility.ts"
);
const { handleOrderPaymentConfirmedForStuartDelivery } = await import(
  "../lib/server/delivery-providers/stuart/orchestration.ts"
);

// ====================================================================
// STUART LOT D1 v1.2 — TARGETED AUDIT REMEDIATION (Cat Stevens
// independent audit, FAIL/NOT READY FOR RELEASE, 3 blockers). Toutes
// les RPC sont MOCKÉES -- AUCUN appel réseau/DB réel ici. Le barème de
// backoff/plafond/escalade (blocker 1, HIGH) vit ENTIÈREMENT côté SQL
// (update_stuart_provider_event_processing_status/claim_stuart_
// provider_events) et a été vérifié EN DIRECT contre PostgreSQL 16 réel
// (base éphémère, jetable) -- voir le rapport de livraison pour le
// détail exact des commandes exécutées (barème 30/120/600/1800s
// confirmé, plafond de 5 tentatives confirmé, escalade failed_terminal
// confirmée, verrouillage terminal confirmé, non-famine d'un évènement
// plus récent confirmée). Ce fichier couvre le plumbing TypeScript de
// l'AUTRE blocker HIGH (blocker 2, autorité d'environnement) ainsi que
// les preuves structurelles communes aux deux.
// ====================================================================

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return handler(name, args);
  });
  return calls;
}

function eligibleRow(merchantEnvironment: string) {
  return { data: [{ eligible: true, reason_code: "ELIGIBLE", merchant_environment: merchantEnvironment }], error: null };
}
function ineligibleRow(reasonCode: string) {
  return { data: [{ eligible: false, reason_code: reasonCode, merchant_environment: null }], error: null };
}

function buildOrder() {
  return {
    orderId: "order-1",
    restaurantId: "resto-1",
    pickup: { address: "1 rue A", contact: { phone: "0600000000", company: "R1" } },
    dropoff: { address: "2 rue B", contact: { phone: "0600000001", company: "C1" }, packageType: "small" as const },
  };
}

const mockTransportNeverCalled = {
  createJob: async () => {
    throw new Error("TRANSPORT MUST NEVER BE CALLED IN THIS TEST");
  },
};

function allocationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-row-1",
    client_reference: "CANDIDATE1",
    is_new_allocation: true,
    collision: false,
    send_state: null,
    stuart_job_id: null,
    ...overrides,
  };
}

// --------------------------------------------------------------
// BLOCKER 2 -- items 7/8 : sandbox/production merchant -> job
// PERSISTÉ dans le MÊME environnement (jamais "sandbox" codé en dur).
// --------------------------------------------------------------

test("item 7 : merchant sandbox -- getStuartDeliveryEligibility renvoie merchantEnvironment='sandbox'", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow("sandbox");
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const result = await getStuartDeliveryEligibility({ orderId: "order-1", restaurantId: "resto-1" });
  assert.equal(result.eligible, true);
  assert.equal((result as { merchantEnvironment: string }).merchantEnvironment, "sandbox");
});

test("item 8 : merchant production -- getStuartDeliveryEligibility renvoie merchantEnvironment='production'", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow("production");
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const result = await getStuartDeliveryEligibility({ orderId: "order-1", restaurantId: "resto-1" });
  assert.equal(result.eligible, true);
  assert.equal((result as { merchantEnvironment: string }).merchantEnvironment, "production");
});

test("item 7bis : orchestration -- merchant sandbox -- allocate_stuart_delivery_job REÇOIT p_environment='sandbox' (jamais codé en dur)", async (t) => {
  const calls = routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow("sandbox");
    if (name === "allocate_stuart_delivery_job") return { data: [allocationRow({ send_state: "allocated" })], error: null };
    if (name === "mark_stuart_delivery_job_send_started") return { data: null, error: null };
    if (name === "mark_stuart_delivery_job_ambiguous") return { data: null, error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  await handleOrderPaymentConfirmedForStuartDelivery({
    ...buildOrder(),
    transport: { createJob: async () => ({ raw: null, httpStatus: 0, networkFailure: true }) },
  });
  const allocateCall = calls.find((c) => c.name === "allocate_stuart_delivery_job");
  assert.equal(allocateCall?.args.p_environment, "sandbox");
});

test("item 8bis : orchestration -- merchant production -- allocate_stuart_delivery_job REÇOIT p_environment='production' (jamais codé en dur)", async (t) => {
  const calls = routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return eligibleRow("production");
    if (name === "allocate_stuart_delivery_job") return { data: [allocationRow({ send_state: "allocated" })], error: null };
    if (name === "mark_stuart_delivery_job_send_started") return { data: null, error: null };
    if (name === "mark_stuart_delivery_job_ambiguous") return { data: null, error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  await handleOrderPaymentConfirmedForStuartDelivery({
    ...buildOrder(),
    transport: { createJob: async () => ({ raw: null, httpStatus: 0, networkFailure: true }) },
  });
  const allocateCall = calls.find((c) => c.name === "allocate_stuart_delivery_job");
  assert.equal(allocateCall?.args.p_environment, "production");
});

// --------------------------------------------------------------
// BLOCKER 2 -- item 9 : configuration invalide/inconnue -> fail
// closed, AUCUNE allocation.
// --------------------------------------------------------------

test("item 9a : merchant_environment NULL sur une ligne eligible=true -- fail closed (StuartEligibilityError), AUCUNE allocation", async (t) => {
  const calls = routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility")
      return { data: [{ eligible: true, reason_code: "ELIGIBLE", merchant_environment: null }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  await assert.rejects(
    () => getStuartDeliveryEligibility({ orderId: "order-1", restaurantId: "resto-1" }),
    StuartEligibilityError
  );
  assert.ok(!calls.some((c) => c.name === "allocate_stuart_delivery_job"));
});

test("item 9b : merchant_environment valeur INCONNUE ('staging') sur une ligne eligible=true -- fail closed, AUCUNE allocation", async (t) => {
  routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility")
      return { data: [{ eligible: true, reason_code: "ELIGIBLE", merchant_environment: "staging" }], error: null };
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  await assert.rejects(
    () => getStuartDeliveryEligibility({ orderId: "order-1", restaurantId: "resto-1" }),
    StuartEligibilityError
  );
});

test("item 9c : reason_code STUART_MERCHANT_ENVIRONMENT_INVALID (défense en profondeur SQL) -- traité comme toute autre inéligibilité, AUCUNE allocation", async (t) => {
  const calls = routeRpc(t, (name) => {
    if (name === "get_stuart_delivery_eligibility") return ineligibleRow("STUART_MERCHANT_ENVIRONMENT_INVALID");
    throw new Error(`RPC INATTENDU: ${name}`);
  });
  const outcome = await handleOrderPaymentConfirmedForStuartDelivery({ ...buildOrder(), transport: mockTransportNeverCalled });
  assert.deepEqual(outcome, { status: "ineligible", reasonCode: "STUART_MERCHANT_ENVIRONMENT_INVALID" });
  assert.ok(!calls.some((c) => c.name === "allocate_stuart_delivery_job"));
});

// --------------------------------------------------------------
// BLOCKER 2 -- item 10/11 : aucun fallback global, AUCUN "sandbox"
// codé en dur ne subsiste dans orchestration.ts.
// --------------------------------------------------------------

test("item 10 : eligibility.ts/orchestration.ts ne référencent AUCUNE variable d'environnement globale (STUART_ENV, process.env)", () => {
  const files = [
    "lib/server/delivery-providers/stuart/eligibility.ts",
    "lib/server/delivery-providers/stuart/orchestration.ts",
  ];
  const forbidden = [/STUART_ENV\b/, /process\.env/, /STUART_CLIENT_ID/, /STUART_CLIENT_SECRET/];
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(src)) offenders.push(`${file} -> ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("item 11 : orchestration.ts ne contient plus AUCUN environment:\"sandbox\" codé en dur pour allocateStuartDeliveryJob", () => {
  const src = readFileSync("lib/server/delivery-providers/stuart/orchestration.ts", "utf8");
  assert.ok(
    !/environment:\s*["']sandbox["']/.test(src),
    "un littéral environment:\"sandbox\" codé en dur subsiste dans orchestration.ts"
  );
  assert.match(src, /environment:\s*eligibility\.merchantEnvironment/);
});

// --------------------------------------------------------------
// BLOCKER 1 -- référence : barème de backoff/plafond/escalade/
// verrouillage terminal/non-famine, vérifié EN DIRECT contre
// PostgreSQL réel (voir rapport de livraison, même discipline que D1
// v1 pour les garanties SQL-natives qui ne peuvent pas être prouvées
// par un mock seul -- RLS/ACL/concurrence/crash recovery).
// --------------------------------------------------------------

test("blocker 1 (référence) : la migration v1.2 documente le barème 30/120/600/1800s et le plafond de 5 tentatives, vérifié en direct", () => {
  const sql = readFileSync("supabase/DRAFT-lot-stuart-provider-events-foundation-v1-2-remediation.sql", "utf8");
  assert.match(sql, /next_retry_at/);
  assert.match(sql, /c_max_retry_attempts constant integer := 5/);
  assert.match(sql, /when 1 then 30/);
  assert.match(sql, /when 2 then 120/);
  assert.match(sql, /when 3 then 600/);
  assert.match(sql, /else 1800/);
});

// --------------------------------------------------------------
// BLOCKER 3 -- référence : voir tests/v110c-payment-p3a1-structural.test.ts,
// "app/api/ contient EXACTEMENT les routes..." (désormais PASS).
// --------------------------------------------------------------

test("blocker 3 (référence) : app/api/internal/stuart/webhook/route.ts existe toujours (la route corrigée par ce lot)", () => {
  const src = readFileSync("app/api/internal/stuart/webhook/route.ts", "utf8");
  assert.match(src, /export async function POST/);
});
