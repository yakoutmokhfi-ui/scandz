import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import { buildCreateOrderPayload } from "../lib/services/order-payload.ts";
import type { CartLine, OrderContext } from "../lib/whatsapp.ts";
import { EMPTY_CUSTOMER, type CustomerInfo } from "../lib/customer.ts";

// ====================================================================
// Scanym — PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1.
//
// Prouve, côté FRONTEND (buildCreateOrderPayload), que `p_customer.
// street`/`p_customer.city` sont désormais transmis tels quels en mode
// `delivery` (écart confirmé par ré-audit direct du baseline, mandat
// §13 : "stop discarding genuine structured values"), jamais
// dérivés/re-découpés de `address`/formatAddress (mandat §11 : "no
// heuristic address splitting"), et jamais transmis pour un mode sans
// adresse (mandat §6). Même patron déjà établi par
// tests/v104-sadfp01-structured-postal.test.ts pour `postalCode`.
// ====================================================================

const menuItem = { id: "item-1", name: "Tiramisu", price: 450 } as never;
const lines: CartLine[] = [{ item: menuItem, quantity: 2 }];

function deliveryContext(customer: Partial<CustomerInfo>): OrderContext {
  return {
    mode: "delivery",
    zoneLabel: "Paris",
    customer: { ...EMPTY_CUSTOMER, ...customer },
  };
}

function tableContext(): OrderContext {
  return { mode: "table", tableNumber: 7 };
}

test("PAYMENT P3-B6 (delivery): p_customer.street/city transmis tels quels, indépendamment d'`address`", () => {
  const ctx = deliveryContext({
    street: "12 rue de Paris",
    postalCode: "75001",
    city: "Paris",
    phone: "0600000000",
    email: "a@example.com",
    name: "A",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  const customer = payload.p_customer as { street?: string | null; city?: string | null; address?: string | null };
  assert.equal(customer.street, "12 rue de Paris");
  assert.equal(customer.city, "Paris");
  // `address` (texte combiné, formatAddress) reste INCHANGÉ à côté --
  // aucune régression du champ pré-existant.
  assert.equal(customer.address, "12 rue de Paris, 75001 Paris");
});

test("PAYMENT P3-B6 (delivery): street/city ne sont JAMAIS dérivés/re-découpés d'une valeur d'adresse trompeuse -- transmis EXACTEMENT ce que le client a structuré", () => {
  const ctx = deliveryContext({
    street: "Bâtiment principal (voir 75008 sur la boîte aux lettres)",
    postalCode: "13001",
    city: "Marseille",
    phone: "0600000001",
    email: "b@example.com",
    name: "B",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  const customer = payload.p_customer as { street?: string | null; city?: string | null };
  assert.equal(customer.street, "Bâtiment principal (voir 75008 sur la boîte aux lettres)");
  assert.equal(customer.city, "Marseille");
});

test("PAYMENT P3-B6 (delivery): street vide/blanc -> null, jamais une chaîne vide", () => {
  const ctx = deliveryContext({
    street: "   ",
    postalCode: "75001",
    city: "Paris",
    phone: "0600000002",
    email: "c@example.com",
    name: "C",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  const customer = payload.p_customer as { street?: string | null };
  assert.equal(customer.street, null);
});

test("PAYMENT P3-B6 (delivery): city vide/blanc -> null, jamais une chaîne vide", () => {
  const ctx = deliveryContext({
    street: "12 rue de Paris",
    postalCode: "75001",
    city: "   ",
    phone: "0600000003",
    email: "d@example.com",
    name: "D",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  const customer = payload.p_customer as { city?: string | null };
  assert.equal(customer.city, null);
});

test("PAYMENT P3-B6: mode table -> p_customer reste {} (aucune régression, aucune donnée d'adresse pour un mode addressless, mandat §6)", () => {
  const ctx = tableContext();
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  assert.deepEqual(payload.p_customer, {});
});

test("PAYMENT P3-B6: mode pickup -> street/city toujours null (jamais fabriqués pour un mode sans adresse)", () => {
  const ctx: OrderContext = {
    mode: "pickup",
    customer: { ...EMPTY_CUSTOMER, name: "E", phone: "0600000004" },
  } as OrderContext;
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  const customer = payload.p_customer as { street?: string | null; city?: string | null };
  assert.equal(customer.street ?? null, null);
  assert.equal(customer.city ?? null, null);
});
