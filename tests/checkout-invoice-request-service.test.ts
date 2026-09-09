import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "invoice-request-v1-1-synthetic-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const {
  setOrderInvoiceRequest,
  getOrderInvoiceRequest,
  InvoiceRequestServerError,
} = await import("../lib/server/invoice-request-service.ts");

// ====================================================================
// SCANYM CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.1.
// RPC entièrement mockée -- AUCUN appel réseau/DB réel (preuve contre
// PostgreSQL réel séparée, harnais SQL 77/77 PASS).
// ====================================================================

function routeRpc(t: { mock: { method: Function } }, handler: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return handler(name, args);
  });
  return calls;
}

test("1. set_order_invoice_request -- appel avec les bons paramètres exacts", async (t) => {
  const calls = routeRpc(t, () => ({
    data: [{ order_id: "o1", invoice_type: "individual", updated_at: "2026-01-01T00:00:00Z" }],
    error: null,
  }));

  const result = await setOrderInvoiceRequest({
    orderId: "o1",
    publicToken: "tok1",
    invoiceType: "individual",
    addressLine1: "12 rue Test",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  });

  assert.equal(result.orderId, "o1");
  assert.equal(result.invoiceType, "individual");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "set_order_invoice_request");
  assert.equal(calls[0].args.p_order_id, "o1");
  assert.equal(calls[0].args.p_public_token, "tok1");
  assert.equal(calls[0].args.p_invoice_type, "individual");
  assert.equal(calls[0].args.p_company_legal_name, null, "champ optionnel non fourni -- transmis explicitement comme null, jamais omis silencieusement");
});

test("2. set_order_invoice_request -- erreur SQL propagée en InvoiceRequestServerError, jamais le message brut", async (t) => {
  routeRpc(t, () => ({ data: null, error: { code: "22004", message: "champ requis manquant (détail interne)" } }));

  await assert.rejects(
    () => setOrderInvoiceRequest({
      orderId: "o1", publicToken: "tok1", invoiceType: "company",
      addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR",
    }),
    (err: unknown) => {
      assert.ok(err instanceof InvoiceRequestServerError);
      assert.equal((err as InstanceType<typeof InvoiceRequestServerError>).sqlState, "22004");
      assert.ok(!(err as Error).message.includes("détail interne"), "le message SQL brut ne doit jamais fuiter");
      return true;
    }
  );
});

test("3. get_order_invoice_request -- absence de ligne retourne null, jamais une erreur", async (t) => {
  routeRpc(t, () => ({ data: [], error: null }));
  const result = await getOrderInvoiceRequest("o1", "tok1");
  assert.equal(result, null);
});

test("4. get_order_invoice_request -- mapping complet des champs société", async (t) => {
  routeRpc(t, () => ({
    data: [{
      invoice_type: "company",
      company_legal_name: "ACME SARL",
      vat_number: "FR12345678901",
      contact_name: "Jean Contact",
      contact_email: "contact@acme.test",
      address_line_1: "1 avenue Société",
      address_line_2: null,
      city: "Lyon",
      postal_code: "69001",
      country: "FR",
      updated_at: "2026-01-01T00:00:00Z",
    }],
    error: null,
  }));

  const result = await getOrderInvoiceRequest("o1", "tok1");
  assert.ok(result);
  assert.equal(result!.companyLegalName, "ACME SARL");
  assert.equal(result!.vatNumber, "FR12345678901");
  assert.equal(result!.invoiceType, "company");
});

test("5. get_order_invoice_request -- erreur SQL propagée correctement", async (t) => {
  routeRpc(t, () => ({ data: null, error: { code: "P0002", message: "commande introuvable" } }));
  await assert.rejects(
    () => getOrderInvoiceRequest("bad", "bad"),
    (err: unknown) => err instanceof InvoiceRequestServerError
  );
});

test("6. set_order_invoice_request -- AUCUN paramètre de paiement/Stuart n'est jamais transmis (preuve structurelle de portée)", async (t) => {
  const calls = routeRpc(t, () => ({
    data: [{ order_id: "o1", invoice_type: "individual", updated_at: "2026-01-01T00:00:00Z" }],
    error: null,
  }));
  await setOrderInvoiceRequest({
    orderId: "o1", publicToken: "tok1", invoiceType: "individual",
    addressLine1: "1 rue X", city: "Paris", postalCode: "75001", country: "FR",
  });
  const paramNames = Object.keys(calls[0].args);
  for (const forbidden of ["p_payment", "p_stuart", "p_monetico", "p_pdf"]) {
    assert.ok(!paramNames.some((n) => n.toLowerCase().includes(forbidden.replace("p_", ""))), `aucun paramètre lié à ${forbidden} ne doit jamais être transmis`);
  }
});
