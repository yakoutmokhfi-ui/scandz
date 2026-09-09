import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "invoice-request-v1-1-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { POST } = await import("../app/api/checkout/invoice-request/route.ts");

function req(body: unknown) {
  return new NextRequest("https://internal.example.test/api/checkout/invoice-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockRpcOk(t: { mock: { method: Function } }) {
  t.mock.method(client, "rpc", async () => ({
    data: [{ order_id: "o1", invoice_type: "individual", updated_at: "2026-01-01T00:00:00Z" }],
    error: null,
  }));
}

const VALID_BODY = {
  orderId: "o1",
  publicToken: "tok1",
  invoiceType: "individual",
  addressLine1: "12 rue Test",
  city: "Paris",
  postalCode: "75001",
  country: "FR",
};

test("1. requête valide -- 200, outcome ok", async (t) => {
  mockRpcOk(t);
  const response = await POST(req(VALID_BODY));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.outcome, "ok");
});

test("2. orderId manquant -- réponse générique, jamais distinguable (posture possession)", async () => {
  const response = await POST(req({ ...VALID_BODY, orderId: undefined }));
  assert.equal(response.status, 502);
  const data = await response.json();
  assert.equal(data.outcome, "unavailable");
});

test("3. invoiceType invalide -- 400, champ précisément identifié", async () => {
  const response = await POST(req({ ...VALID_BODY, invoiceType: "bogus" }));
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.outcome, "invalid_field");
  assert.equal(data.field, "invoiceType");
});

test("4. company sans companyLegalName -- 400, précocement rejeté avant tout appel réseau", async (t) => {
  let called = false;
  t.mock.method(client, "rpc", async () => { called = true; throw new Error("jamais appelé"); });
  const response = await POST(req({ ...VALID_BODY, invoiceType: "company", companyLegalName: undefined }));
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("5. addressLine1 manquant -- 400, champ précisément identifié", async () => {
  const response = await POST(req({ ...VALID_BODY, addressLine1: undefined }));
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.field, "addressLine1");
});

test("6. JSON malformé -- réponse générique, jamais une exception non gérée", async () => {
  const request = new NextRequest("https://internal.example.test/api/checkout/invoice-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const response = await POST(request);
  assert.equal(response.status, 502);
});

test("7. erreur SQL P0002 (preuve de possession invalide) -- réponse générique, jamais distinguable", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: null, error: { code: "P0002", message: "commande introuvable" } }));
  const response = await POST(req(VALID_BODY));
  assert.equal(response.status, 502);
  const data = await response.json();
  assert.equal(data.outcome, "unavailable");
});

test("8. erreur SQL 22004 (validation) -- réponse de validation distinguable, 400", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: null, error: { code: "22004", message: "champ requis manquant" } }));
  const response = await POST(req(VALID_BODY));
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.outcome, "invalid_request");
});

test("9. réponse OK ne contient jamais de champ de paiement/Stuart", async (t) => {
  mockRpcOk(t);
  const response = await POST(req(VALID_BODY));
  const data = await response.json();
  const keys = Object.keys(data);
  for (const forbidden of ["payment", "stuart", "monetico", "pdf"]) {
    assert.ok(!keys.some((k) => k.toLowerCase().includes(forbidden)), `aucune clé liée à ${forbidden} ne doit jamais apparaître`);
  }
});
